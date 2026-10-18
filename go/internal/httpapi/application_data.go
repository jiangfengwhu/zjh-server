package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"io"
	"math"
	"net/http"
	"regexp"
	"strings"
	"time"
)

var appIDPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`)
var identifierPattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_-]{0,63}$`)
var fieldPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_-]{0,63}$`)
var recordIDPattern = regexp.MustCompile(`^[a-f0-9-]{36}$`)
var requestIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{8,100}$`)

type dataError struct {
	Code, Message string
	Status        int
}

func (e *dataError) Error() string     { return e.Message }
func invalidData(message string) error { return &dataError{"INVALID_ARGUMENT", message, 400} }
func dataFailure(w http.ResponseWriter, err error) {
	var failure *dataError
	if errors.As(err, &failure) {
		send(w, failure.Status, map[string]string{"code": failure.Code, "message": failure.Message})
		return
	}
	send(w, 503, map[string]string{"code": "UNAVAILABLE", "message": "云数据操作暂不可用"})
}
func uuid() string {
	t := randomToken()[:32]
	return t[:8] + "-" + t[8:12] + "-4" + t[13:16] + "-a" + t[17:20] + "-" + t[20:]
}

type cloudDocument struct {
	ID        string         `json:"id"`
	Data      map[string]any `json:"data"`
	CreatedBy string         `json:"createdBy"`
	CreatedAt int64          `json:"createdAt"`
	UpdatedAt int64          `json:"updatedAt"`
	Version   int64          `json:"version"`
	bytes     int64
}
type dataEnvelope struct {
	App, Scope, Collection, Tenant, User string
	Input                                map[string]any
}

func (s *Server) canUseCloud(ctx context.Context, app, user string) (bool, error) {
	var allowed bool
	err := s.DB.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM object_records WHERE namespace='WORKSHOP' AND object_id='dynamic' AND (key=$1 OR (key=$2 AND value->>'ownerId'=$3)))`, "shared:"+app, "task:"+app, user).Scan(&allowed)
	return allowed, err
}
func (s *Server) applicationData(w http.ResponseWriter, r *http.Request) {
	app, scope, collection := r.PathValue("app"), r.PathValue("scope"), r.PathValue("collection")
	if !appIDPattern.MatchString(app) || !identifierPattern.MatchString(collection) || (scope != "private" && scope != "public") {
		dataFailure(w, invalidData("云数据请求无效"))
		return
	}
	user, _ := s.requireUser(w, r)
	if user == nil {
		return
	}
	allowed, err := s.canUseCloud(r.Context(), app, user.ID)
	if err != nil {
		dataFailure(w, err)
		return
	}
	if !allowed {
		dataFailure(w, &dataError{"FORBIDDEN", "应用不存在或尚未开放", 403})
		return
	}
	var input map[string]any
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 98304))
	if d.Decode(&input) != nil || input == nil || d.Decode(new(any)) != io.EOF {
		dataFailure(w, invalidData("云数据参数无效"))
		return
	}
	tenant := "app:" + app
	if scope == "private" {
		tenant = "user:" + user.ID
	}
	e := dataEnvelope{app, scope, collection, tenant, user.ID, input}
	result, err := s.executeData(r.Context(), e)
	if err != nil {
		dataFailure(w, err)
		return
	}
	send(w, 200, map[string]any{"result": result})
}
func dataJSON(value any) ([]byte, error) {
	object, ok := value.(map[string]any)
	if !ok || object == nil {
		return nil, invalidData("数据必须为 JSON 对象")
	}
	var walk func(any, int) bool
	walk = func(v any, depth int) bool {
		if depth > 16 {
			return false
		}
		switch x := v.(type) {
		case nil, string, bool:
			return true
		case float64:
			return !math.IsInf(x, 0) && !math.IsNaN(x)
		case map[string]any:
			for _, c := range x {
				if !walk(c, depth+1) {
					return false
				}
			}
			return true
		case []any:
			for _, c := range x {
				if !walk(c, depth+1) {
					return false
				}
			}
			return true
		}
		return false
	}
	if !walk(value, 0) {
		return nil, invalidData("数据嵌套层级过深或包含非 JSON 值")
	}
	b, err := json.Marshal(value)
	if err != nil {
		return nil, invalidData("数据包含非 JSON 值")
	}
	if len(b) > 32768 {
		return nil, invalidData("单条数据不能超过 32 KB")
	}
	return b, nil
}
func stringValue(v any) string { s, _ := v.(string); return s }
func scanDocument(row pgx.Row) (*cloudDocument, error) {
	var doc cloudDocument
	var raw []byte
	err := row.Scan(&doc.ID, &raw, &doc.CreatedBy, &doc.CreatedAt, &doc.UpdatedAt, &doc.Version, &doc.bytes)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if err = json.Unmarshal(raw, &doc.Data); err != nil {
		return nil, err
	}
	return &doc, nil
}

const documentColumns = "id,data,created_by,created_at,updated_at,version,bytes"

func (s *Server) executeData(ctx context.Context, e dataEnvelope) (any, error) {
	// Rate admission commits independently, including invalid operations.
	tx, err := s.DB.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	now := time.Now().UnixMilli()
	hit, err := limited(ctx, tx, "cloud:"+e.Tenant+":"+e.User, 120, 60000, now)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	if hit {
		return nil, &dataError{"RATE_LIMITED", "请求过于频繁，请稍后再试", 429}
	}
	tx, err = s.DB.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,1))", e.Tenant); err != nil {
		return nil, err
	}
	op := stringValue(e.Input["operation"])
	var result any
	if op == "list" {
		result, err = s.listData(ctx, tx, e)
	} else {
		result, err = s.mutateData(ctx, tx, e, op, now)
	}
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return result, nil
}
func (s *Server) mutateData(ctx context.Context, tx pgx.Tx, e dataEnvelope, op string, now int64) (any, error) {
	if op != "get" && op != "create" && op != "update" && op != "increment" && op != "remove" {
		return nil, invalidData("操作类型无效")
	}
	id := stringValue(e.Input["id"])
	if op != "create" && !recordIDPattern.MatchString(id) {
		return nil, invalidData("记录 ID 无效")
	}
	var row *cloudDocument
	var err error
	if op != "create" {
		row, err = scanDocument(tx.QueryRow(ctx, "SELECT "+documentColumns+" FROM application_records WHERE tenant=$1 AND app_id=$2 AND collection=$3 AND id=$4", e.Tenant, e.App, e.Collection, id))
		if err != nil {
			return nil, err
		}
	}
	if op == "get" {
		if row == nil {
			return nil, nil
		}
		return row, nil
	}
	request := stringValue(e.Input["requestId"])
	if !requestIDPattern.MatchString(request) {
		return nil, invalidData("写入请求 ID 无效")
	}
	expected, hasExpected := e.Input["expectedVersion"]
	if hasExpected {
		n, ok := expected.(float64)
		if !ok || n < 1 || n > 9007199254740991 || math.Trunc(n) != n {
			return nil, invalidData("记录版本无效")
		}
	}
	signatureBytes, _ := json.Marshal([]any{e.App, e.Collection, op, e.Input["id"], e.Input["data"], expected})
	signature := string(signatureBytes)
	var previousSignature string
	var previous json.RawMessage
	err = tx.QueryRow(ctx, "SELECT signature,result FROM idempotency_requests WHERE tenant=$1 AND user_id=$2 AND request_id=$3 AND expires_at>now()", e.Tenant, e.User, request).Scan(&previousSignature, &previous)
	if err == nil {
		if previousSignature != signature {
			return nil, &dataError{"CONFLICT", "同一请求 ID 不能用于不同操作", 409}
		}
		return previous, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	if _, err = tx.Exec(ctx, "DELETE FROM idempotency_requests WHERE tenant=$1 AND expires_at<=now()", e.Tenant); err != nil {
		return nil, err
	}
	var count int
	if err = tx.QueryRow(ctx, "SELECT count(*) FROM idempotency_requests WHERE tenant=$1", e.Tenant).Scan(&count); err != nil {
		return nil, err
	}
	if count >= 2000 {
		return nil, &dataError{"RATE_LIMITED", "写入过于频繁，请稍后再试", 429}
	}
	if row != nil && e.Scope != "room" && row.CreatedBy != e.User {
		return nil, &dataError{"FORBIDDEN", "只能修改自己创建的记录", 403}
	}
	if row == nil && (op == "update" || op == "increment") {
		return nil, &dataError{"NOT_FOUND", "记录不存在", 404}
	}
	if hasExpected && (row == nil || float64(row.Version) != expected.(float64)) {
		return nil, &dataError{"CONFLICT", "记录已发生变化，请重新加载", 409}
	}
	var result *cloudDocument
	if op == "remove" {
		if row != nil {
			if _, err = tx.Exec(ctx, "DELETE FROM application_records WHERE tenant=$1 AND app_id=$2 AND collection=$3 AND id=$4", e.Tenant, e.App, e.Collection, id); err != nil {
				return nil, err
			}
			if _, err = tx.Exec(ctx, "UPDATE application_usage SET bytes=bytes-$2,records=records-1 WHERE tenant=$1", e.Tenant, row.bytes); err != nil {
				return nil, err
			}
		}
	} else {
		if _, err = dataJSON(e.Input["data"]); err != nil {
			return nil, err
		}
		patch := e.Input["data"].(map[string]any)
		data := map[string]any{}
		if row != nil {
			for k, v := range row.Data {
				data[k] = v
			}
		}
		if op == "increment" {
			if len(patch) == 0 || len(patch) > 32 {
				return nil, invalidData("计数字段数量无效")
			}
			for field, amount := range patch {
				current, exists := data[field]
				if !exists {
					current = float64(0)
				}
				a, ok := amount.(float64)
				c, okc := current.(float64)
				if !fieldPattern.MatchString(field) || !ok || !okc || math.IsInf(a+c, 0) || math.IsNaN(a+c) {
					return nil, invalidData("只能累加有限数值字段")
				}
				data[field] = a + c
			}
		} else {
			for k, v := range patch {
				data[k] = v
			}
		}
		raw, err := dataJSON(data)
		if err != nil {
			return nil, err
		}
		size := int64(len(raw))
		oldSize := int64(0)
		if row != nil {
			oldSize = row.bytes
		}
		if _, err = tx.Exec(ctx, "INSERT INTO application_usage(tenant) VALUES($1) ON CONFLICT DO NOTHING", e.Tenant); err != nil {
			return nil, err
		}
		var used, records int64
		if err = tx.QueryRow(ctx, "SELECT bytes,records FROM application_usage WHERE tenant=$1", e.Tenant).Scan(&used, &records); err != nil {
			return nil, err
		}
		if used+size-oldSize > 50*1024*1024 || (row == nil && records >= 100000) {
			return nil, &dataError{"QUOTA_EXCEEDED", "云存储空间已满", 413}
		}
		var collectionExists bool
		if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM application_collections WHERE tenant=$1 AND app_id=$2 AND name=$3)", e.Tenant, e.App, e.Collection).Scan(&collectionExists); err != nil {
			return nil, err
		}
		if !collectionExists {
			if err = tx.QueryRow(ctx, "SELECT count(*) FROM application_collections WHERE tenant=$1 AND app_id=$2", e.Tenant, e.App).Scan(&count); err != nil {
				return nil, err
			}
			if count >= 100 {
				return nil, &dataError{"QUOTA_EXCEEDED", "应用集合数量已达上限", 413}
			}
			if _, err = tx.Exec(ctx, "INSERT INTO application_collections VALUES($1,$2,$3)", e.Tenant, e.App, e.Collection); err != nil {
				return nil, err
			}
		}
		result = &cloudDocument{ID: uuid(), Data: data, CreatedBy: e.User, CreatedAt: now, UpdatedAt: now, Version: 1}
		added := 1
		if row != nil {
			result.ID = row.ID
			result.CreatedBy = row.CreatedBy
			result.CreatedAt = row.CreatedAt
			result.Version = row.Version + 1
			added = 0
		}
		if _, err = tx.Exec(ctx, `INSERT INTO application_records VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(tenant,app_id,collection,id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at,version=excluded.version,bytes=excluded.bytes`, e.Tenant, e.App, e.Collection, result.ID, raw, result.CreatedBy, result.CreatedAt, now, result.Version, size); err != nil {
			return nil, err
		}
		if _, err = tx.Exec(ctx, "UPDATE application_usage SET bytes=bytes+$2,records=records+$3 WHERE tenant=$1", e.Tenant, size-oldSize, added); err != nil {
			return nil, err
		}
	}
	raw, err := json.Marshal(result)
	if err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, "INSERT INTO idempotency_requests VALUES($1,$2,$3,$4,$5,now()+interval '1 hour')", e.Tenant, e.User, request, signature, raw); err != nil {
		return nil, err
	}
	return result, nil
}
func scalar(v any) bool {
	switch v.(type) {
	case nil, string, float64, bool:
		return true
	}
	return false
}
func sqliteSort(v any) any {
	if b, ok := v.(bool); ok {
		if b {
			return float64(1)
		}
		return float64(0)
	}
	return v
}
func sortRank(v any) int {
	switch v.(type) {
	case float64, bool:
		return 1
	}
	return 2
}
func (s *Server) listData(ctx context.Context, tx pgx.Tx, e dataEnvelope) (any, error) {
	query := map[string]any{}
	if v, exists := e.Input["query"]; exists {
		var ok bool
		query, ok = v.(map[string]any)
		if !ok || query == nil {
			return nil, invalidData("查询参数无效")
		}
	}
	limit := 20
	if n, exists := query["limit"]; exists {
		v, ok := n.(float64)
		if !ok || v < 1 || v > 100 || math.Trunc(v) != v {
			return nil, invalidData("分页数量必须在 1–100 之间")
		}
		limit = int(v)
	}
	where := []any{}
	if v, exists := query["where"]; exists {
		var ok bool
		where, ok = v.([]any)
		if !ok || len(where) > 8 {
			return nil, invalidData("筛选条件过多")
		}
	}
	order := map[string]any{"field": "createdAt", "direction": "desc"}
	if v, exists := query["orderBy"]; exists {
		var ok bool
		order, ok = v.(map[string]any)
		if !ok {
			return nil, invalidData("排序参数无效")
		}
	}
	field, dir := stringValue(order["field"]), stringValue(order["direction"])
	if !fieldPattern.MatchString(field) || (dir != "asc" && dir != "desc") {
		return nil, invalidData("排序参数无效")
	}
	raw, _ := json.Marshal([]any{where, order})
	if len(raw) > 4096 {
		return nil, invalidData("查询条件过大")
	}
	args := []any{e.Tenant, e.App, e.Collection}
	bind := func(v any) string { args = append(args, v); return fmt.Sprintf("$%d", len(args)) }
	clauses := []string{"tenant=$1", "app_id=$2", "collection=$3"}
	operators := map[string]string{"eq": "=", "ne": "<>", "gt": ">", "gte": ">=", "lt": "<", "lte": "<="}
	for _, v := range where {
		c, ok := v.(map[string]any)
		if !ok {
			return nil, invalidData("筛选条件无效")
		}
		f, op := stringValue(c["field"]), stringValue(c["op"])
		value, exists := c["value"]
		if !exists || !fieldPattern.MatchString(f) || operators[op] == "" || !scalar(value) {
			return nil, invalidData("筛选条件无效")
		}
		expr := "(data -> '" + f + "')"
		if value == nil {
			if op != "eq" && op != "ne" {
				return nil, invalidData("null 只支持 eq/ne")
			}
			clauses = append(clauses, expr+" "+operators[op]+" 'null'::jsonb")
		} else {
			typ := "string"
			switch value.(type) {
			case float64:
				typ = "number"
			case bool:
				typ = "boolean"
			}
			b, _ := json.Marshal(value)
			clauses = append(clauses, "(jsonb_typeof("+expr+")='"+typ+"' AND "+expr+" "+operators[op]+" "+bind(string(b))+"::jsonb)")
		}
	}
	expression := ""
	if field == "createdAt" || field == "updatedAt" {
		column := "created_at"
		if field == "updatedAt" {
			column = "updated_at"
		}
		expression = "jsonb_build_array(1," + column + ")"
	} else {
		v := "(data -> '" + field + "')"
		expression = "CASE jsonb_typeof(" + v + ") WHEN 'number' THEN jsonb_build_array(1," + v + ") WHEN 'boolean' THEN jsonb_build_array(1,CASE WHEN " + v + "='true'::jsonb THEN 1 ELSE 0 END) WHEN 'string' THEN jsonb_build_array(2," + v + ") WHEN 'null' THEN NULL ELSE CASE WHEN " + v + " IS NULL THEN NULL ELSE jsonb_build_array(2," + v + "::text) END END"
	}
	sig, _ := json.Marshal([]any{e.App, e.Scope, e.User, e.Collection, where, order})
	signature := string(sig)
	if cursor, exists := query["cursor"]; exists {
		token, ok := cursor.(string)
		if !ok || len(token) > 65536 {
			return nil, invalidData("分页游标无效")
		}
		b, err := base64.RawURLEncoding.DecodeString(token)
		var c struct {
			Signature string `json:"signature"`
			ID        string `json:"id"`
			Value     any    `json:"value"`
		}
		if err != nil || json.Unmarshal(b, &c) != nil || c.Signature != signature || !recordIDPattern.MatchString(c.ID) || !scalar(c.Value) {
			return nil, invalidData("分页游标与查询不匹配")
		}
		compare := "<"
		if dir == "asc" {
			compare = ">"
		}
		idBind := bind(c.ID)
		if c.Value == nil {
			clause := "(" + expression + " IS NULL AND id" + compare + idBind + ")"
			if dir == "asc" {
				clause = "(" + expression + " IS NOT NULL OR " + clause + ")"
			}
			clauses = append(clauses, clause)
		} else {
			b, _ := json.Marshal([]any{sortRank(c.Value), sqliteSort(c.Value)})
			valueBind := bind(string(b)) + "::jsonb"
			clause := "(" + expression + compare + valueBind + " OR (" + expression + "=" + valueBind + " AND id" + compare + idBind + ")"
			if dir == "desc" {
				clause += " OR " + expression + " IS NULL"
			}
			clauses = append(clauses, clause+")")
		}
	}
	nulls := "NULLS LAST"
	if dir == "asc" {
		nulls = "NULLS FIRST"
	}
	rows, err := tx.Query(ctx, "SELECT "+documentColumns+",("+expression+")->1 AS sort_value FROM application_records WHERE "+strings.Join(clauses, " AND ")+" ORDER BY "+expression+" "+dir+" "+nulls+",id "+dir+" LIMIT "+bind(limit+1), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []cloudDocument{}
	var lastSort any
	more := false
	for rows.Next() {
		var doc cloudDocument
		var data, sort []byte
		if err = rows.Scan(&doc.ID, &data, &doc.CreatedBy, &doc.CreatedAt, &doc.UpdatedAt, &doc.Version, &doc.bytes, &sort); err != nil {
			return nil, err
		}
		if len(items) == limit {
			more = true
			break
		}
		if err = json.Unmarshal(data, &doc.Data); err != nil {
			return nil, err
		}
		lastSort = nil
		if len(sort) > 0 {
			if err = json.Unmarshal(sort, &lastSort); err != nil {
				return nil, err
			}
		}
		items = append(items, doc)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	var cursor any
	if more && len(items) > 0 {
		b, _ := json.Marshal(map[string]any{"signature": signature, "id": items[len(items)-1].ID, "value": lastSort})
		cursor = base64.RawURLEncoding.EncodeToString(b)
	}
	return map[string]any{"items": items, "nextCursor": cursor}, nil
}
