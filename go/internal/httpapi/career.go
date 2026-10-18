package httpapi

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

var careerKinds = map[string]bool{"resume": true, "question": true, "followup": true, "risk": true, "timeline": true}

type careerCatalog struct {
	Revision  int64            `json:"revision"`
	UpdatedAt string           `json:"updatedAt"`
	Items     []map[string]any `json:"items"`
}

func (s *Server) maintainer(r *http.Request) bool {
	if s.OfficialToken == "" {
		return false
	}
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	return ok && subtle.ConstantTimeCompare([]byte(digest(token)), []byte(digest(s.OfficialToken))) == 1
}
func careerText(v any, max int) (string, error) {
	s, ok := v.(string)
	if !ok || strings.TrimSpace(s) == "" || utf8.RuneCountInString(s) > max {
		return "", errors.New("资料文字为空或超出长度限制")
	}
	return strings.TrimSpace(s), nil
}
func careerList(v any, max, length int) ([]string, error) {
	result := []string{}
	if v == nil {
		return result, nil
	}
	items, ok := v.([]any)
	if !ok || len(items) > max {
		return nil, errors.New("资料列表数量无效")
	}
	seen := map[string]bool{}
	for _, v := range items {
		s, err := careerText(v, length)
		if err != nil {
			return nil, err
		}
		if !seen[s] {
			result = append(result, s)
			seen[s] = true
		}
	}
	return result, nil
}
func careerURL(v any) (string, error) {
	s, err := careerText(v, 1000)
	if err != nil {
		return "", err
	}
	u, err := url.Parse(s)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil {
		return "", errors.New("资料来源须为无凭据 HTTPS 链接")
	}
	return s, nil
}
func careerDate(v any) (string, error) {
	s, err := careerText(v, 10)
	if err != nil {
		return "", err
	}
	d, err := time.Parse("2006-01-02", s)
	if err != nil || d.Format("2006-01-02") != s {
		return "", errors.New("日期须为有效 YYYY-MM-DD")
	}
	return s, nil
}
func careerTime(v any) (string, error) {
	s, err := careerText(v, 40)
	if err != nil {
		return "", err
	}
	if _, err = time.Parse(time.RFC3339Nano, s); err != nil {
		return "", errors.New("时间须为带时区的 ISO 时间")
	}
	return s, nil
}
func normalizeCareer(value any) (map[string]any, error) {
	v, ok := value.(map[string]any)
	if !ok {
		return nil, errors.New("资料必须是 JSON 对象")
	}
	result := map[string]any{}
	var err error
	for field, max := range map[string]int{"id": 64, "kind": 20, "title": 160, "body": 12000, "provenance": 10} {
		result[field], err = careerText(v[field], max)
		if err != nil {
			return nil, err
		}
	}
	id, kind, provenance := result["id"].(string), result["kind"].(string), result["provenance"].(string)
	if !appIDPattern.MatchString(id) || !careerKinds[kind] {
		return nil, errors.New("资料 id 或 kind 无效")
	}
	if provenance != "官方资料" && provenance != "公开面经" && provenance != "示例" {
		return nil, errors.New("资料 provenance 无效")
	}
	for _, field := range []string{"roles", "tags"} {
		max := 40
		if field == "tags" {
			max = 30
		}
		result[field], err = careerList(v[field], 12, max)
		if err != nil {
			return nil, err
		}
	}
	result["updatedAt"], err = careerDate(v["updatedAt"])
	if err != nil {
		return nil, err
	}
	company := ""
	if val, exists := v["company"]; exists {
		company, err = careerText(val, 100)
		if err != nil {
			return nil, err
		}
		result["company"] = company
	}
	if source, exists := v["source"]; exists {
		src, ok := source.(map[string]any)
		if !ok {
			return nil, errors.New("资料 source 无效")
		}
		label, err := careerText(src["label"], 100)
		if err != nil {
			return nil, err
		}
		link, err := careerURL(src["url"])
		if err != nil {
			return nil, err
		}
		result["source"] = map[string]string{"label": label, "url": link}
	}
	if provenance != "示例" && result["source"] == nil {
		return nil, errors.New("非示例资料必须附 source")
	}
	if kind == "resume" {
		for _, field := range []string{"before", "after"} {
			result[field], err = careerText(v[field], 6000)
			if err != nil {
				return nil, err
			}
		}
	}
	if kind == "question" {
		result["question"], err = careerText(v["question"], 1000)
		if err != nil {
			return nil, err
		}
		result["followups"], err = careerList(v["followups"], 12, 1000)
		if err != nil {
			return nil, err
		}
		if provenance == "公开面经" {
			if company == "" {
				return nil, errors.New("公开面经须填写公司")
			}
			result["interviewDate"], err = careerDate(v["interviewDate"])
			if err != nil {
				return nil, err
			}
		}
	}
	if kind == "risk" {
		if company == "" || result["source"] == nil || provenance == "示例" {
			return nil, errors.New("避雷反馈须填写公司和真实来源，不能发布示例指控")
		}
		severity := stringValue(v["severity"])
		if severity != "高" && severity != "中" && severity != "低" {
			return nil, errors.New("severity须为高、中或低")
		}
		count, ok := v["reportCount"].(float64)
		if !ok || count < 1 || count > 100000 || float64(int64(count)) != count {
			return nil, errors.New("reportCount须为1–100000")
		}
		result["severity"], result["reportCount"] = severity, count
	}
	if kind == "timeline" {
		if company == "" || result["source"] == nil || provenance == "示例" {
			return nil, errors.New("招聘时间线须填写公司和真实来源")
		}
		start, err := careerTime(v["startAt"])
		if err != nil {
			return nil, err
		}
		result["startAt"] = start
		if end, exists := v["endAt"]; exists {
			s, err := careerTime(end)
			if err != nil {
				return nil, err
			}
			a, _ := time.Parse(time.RFC3339Nano, start)
			b, _ := time.Parse(time.RFC3339Nano, s)
			if b.Before(a) {
				return nil, errors.New("endAt不能早于startAt")
			}
			result["endAt"] = s
		}
		typ := stringValue(v["eventType"])
		if typ != "网申" && typ != "笔试" && typ != "面试" && typ != "截止" && typ != "宣讲" {
			return nil, errors.New("eventType无效")
		}
		result["eventType"] = typ
		if val, exists := v["applicationUrl"]; exists {
			result["applicationUrl"], err = careerURL(val)
			if err != nil {
				return nil, err
			}
		}
	}
	raw, _ := json.Marshal(result)
	if len(raw) > 32768 {
		return nil, errors.New("单份资料最多32 KiB")
	}
	return result, nil
}

var revisionTag = regexp.MustCompile(`^"[0-9]+"$`)

func (s *Server) careerContent(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-cache")
	if r.Method == "GET" || r.Method == "HEAD" {
		data, err := s.DB.Catalog(r.Context(), "career/content")
		if errors.Is(err, pgx.ErrNoRows) {
			data = []byte(`{"revision":0,"updatedAt":"","items":[]}`)
		} else if err != nil {
			send(w, 503, map[string]string{"message": "资料暂不可用"})
			return
		}
		var meta struct {
			Revision int64 `json:"revision"`
		}
		if json.Unmarshal(data, &meta) != nil {
			send(w, 503, map[string]string{"message": "资料暂不可用"})
			return
		}
		tag := `"` + strconv.FormatInt(meta.Revision, 10) + `"`
		w.Header().Set("ETag", tag)
		for _, v := range strings.Split(r.Header.Get("If-None-Match"), ",") {
			v = strings.TrimSpace(v)
			if v == "*" || strings.TrimPrefix(v, "W/") == tag {
				w.WriteHeader(304)
				return
			}
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		if r.Method == "HEAD" {
			return
		}
		send(w, 200, json.RawMessage(data))
		return
	}
	if r.Method != "PUT" && r.Method != "PATCH" {
		w.Header().Set("Allow", "GET, HEAD, PUT, PATCH")
		send(w, 405, map[string]string{"message": "不支持此方法"})
		return
	}
	if !s.maintainer(r) {
		send(w, 403, map[string]string{"message": "资料维护需要维护者授权"})
		return
	}
	match := r.Header.Get("If-Match")
	if !revisionTag.MatchString(match) {
		send(w, 428, map[string]string{"message": "先GET读取revision，再传If-Match: \"版本整数\""})
		return
	}
	var input map[string]any
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024*1024))
	if err := decoder.Decode(&input); err != nil {
		status := 400
		var limit *http.MaxBytesError
		if errors.As(err, &limit) {
			status = 413
		}
		send(w, status, map[string]string{"message": "正文须为有效JSON，且最多1 MiB"})
		return
	}
	if input == nil || decoder.Decode(new(any)) != io.EOF {
		send(w, 400, map[string]string{"message": "正文不是有效JSON"})
		return
	}
	values, ok := input["items"].([]any)
	if !ok {
		send(w, 400, map[string]string{"message": "items须为数组"})
		return
	}
	updates := []map[string]any{}
	seen := map[string]bool{}
	removed := map[string]bool{}
	for _, v := range values {
		item, err := normalizeCareer(v)
		if err != nil {
			send(w, 400, map[string]string{"message": err.Error()})
			return
		}
		id := item["id"].(string)
		if seen[id] {
			send(w, 400, map[string]string{"message": "批次id不能重复"})
			return
		}
		seen[id] = true
		updates = append(updates, item)
	}
	if v, exists := input["removeIds"]; exists {
		ids, ok := v.([]any)
		if !ok {
			send(w, 400, map[string]string{"message": "removeIds须为数组"})
			return
		}
		for _, id := range ids {
			s, ok := id.(string)
			if !ok || !appIDPattern.MatchString(s) || seen[s] {
				send(w, 400, map[string]string{"message": "removeIds无效或与更新项重复"})
				return
			}
			removed[s] = true
		}
	}
	if r.Method == "PUT" && len(removed) > 0 {
		send(w, 400, map[string]string{"message": "全量替换不传removeIds"})
		return
	}
	tx, err := s.DB.Pool.Begin(r.Context())
	if err != nil {
		s.accountUnavailable(w)
		return
	}
	defer tx.Rollback(r.Context())
	if _, err = tx.Exec(r.Context(), "SELECT pg_advisory_xact_lock(97141018)"); err != nil {
		s.accountUnavailable(w)
		return
	}
	current := careerCatalog{Items: []map[string]any{}}
	var raw []byte
	err = tx.QueryRow(r.Context(), "SELECT value FROM catalog WHERE key='career/content' FOR UPDATE").Scan(&raw)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		s.accountUnavailable(w)
		return
	}
	if err == nil && json.Unmarshal(raw, &current) != nil {
		s.accountUnavailable(w)
		return
	}
	if match != `"`+strconv.FormatInt(current.Revision, 10)+`"` {
		send(w, 409, map[string]any{"message": "资料已更新，请重新读取后提交", "revision": current.Revision})
		return
	}
	positions := map[string]int{}
	items := []map[string]any{}
	if r.Method == "PATCH" {
		for _, item := range current.Items {
			if !removed[stringValue(item["id"])] {
				positions[stringValue(item["id"])] = len(items)
				items = append(items, item)
			}
		}
	}
	for _, item := range updates {
		id := item["id"].(string)
		if index, exists := positions[id]; exists {
			items[index] = item
		} else {
			positions[id] = len(items)
			items = append(items, item)
		}
	}
	next := careerCatalog{current.Revision + 1, time.Now().UTC().Format(time.RFC3339Nano), items}
	raw, err = json.Marshal(next)
	if err != nil {
		s.accountUnavailable(w)
		return
	}
	if _, err = tx.Exec(r.Context(), "INSERT INTO catalog(key,value) VALUES('career/content',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value,revision=catalog.revision+1,updated_at=now()", raw); err != nil {
		s.accountUnavailable(w)
		return
	}
	if tx.Commit(r.Context()) != nil {
		s.accountUnavailable(w)
		return
	}
	counts := map[string]int{}
	for kind := range careerKinds {
		counts[kind] = 0
	}
	for _, item := range items {
		counts[stringValue(item["kind"])]++
	}
	w.Header().Set("ETag", `"`+strconv.FormatInt(next.Revision, 10)+`"`)
	send(w, 200, map[string]any{"published": true, "revision": next.Revision, "count": len(items), "counts": counts, "updatedAt": next.UpdatedAt})
}
