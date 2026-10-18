package httpapi

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"golang.org/x/text/unicode/norm"
	"io"
	"math/big"
	"net"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const officialID = "00000000-0000-4000-8000-000000000001"

type User struct {
	ID        string  `json:"id"`
	Email     *string `json:"email"`
	Name      string  `json:"name"`
	AvatarURL *string `json:"avatarUrl"`
	CreatedAt int64   `json:"createdAt"`
}

var emailPattern = regexp.MustCompile(`^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$`)
var codePattern = regexp.MustCompile(`^[0-9]{6}$`)
var tokenPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

func digest(v string) string { sum := sha256.Sum256([]byte(v)); return hex.EncodeToString(sum[:]) }
func randomToken() string {
	var b [32]byte
	if _, e := rand.Read(b[:]); e != nil {
		panic("random source unavailable")
	}
	return hex.EncodeToString(b[:])
}
func accountBody(w http.ResponseWriter, r *http.Request, out any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	decoder := json.NewDecoder(r.Body)
	if decoder.Decode(out) != nil || decoder.Decode(new(any)) != io.EOF {
		send(w, 400, map[string]string{"message": "请求格式不正确"})
		return false
	}
	return true
}
func (s *Server) session(r *http.Request) (*User, string, error) {
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok || !tokenPattern.MatchString(token) {
		return nil, "", nil
	}
	key := digest(token)
	var u User
	err := s.DB.Pool.QueryRow(r.Context(), `SELECT u.id::text,u.email,u.name,u.avatar_url,u.created_at FROM account_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>$2 AND u.id<>$3::uuid`, key, time.Now().UnixMilli(), officialID).Scan(&u.ID, &u.Email, &u.Name, &u.AvatarURL, &u.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, "", nil
	}
	if err != nil {
		return nil, "", err
	}
	return &u, key, nil
}
func (s *Server) requireUser(w http.ResponseWriter, r *http.Request) (*User, string) {
	u, key, err := s.session(r)
	if err != nil {
		send(w, 503, map[string]string{"message": "账户暂不可用"})
		return nil, ""
	}
	if u == nil {
		send(w, 401, map[string]string{"message": "登录已过期，请重新登录"})
	}
	return u, key
}
func limited(ctx context.Context, tx pgx.Tx, key string, maximum int, duration int64, now int64) (bool, error) {
	var count int
	err := tx.QueryRow(ctx, `INSERT INTO rate_limits VALUES($1,$2,1) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN rate_limits.expires_at<=$3 THEN 1 ELSE rate_limits.count+1 END,expires_at=CASE WHEN rate_limits.expires_at<=$3 THEN $2 ELSE rate_limits.expires_at END RETURNING count`, key, now+duration, now).Scan(&count)
	return count > maximum, err
}
func (s *Server) sendCode(w http.ResponseWriter, r *http.Request) {
	if s.ResendKey == "" || s.MailFrom == "" {
		send(w, 503, map[string]string{"message": "登录邮件暂未开通，请稍后再试"})
		return
	}
	var input struct {
		Email string `json:"email"`
	}
	if !accountBody(w, r, &input) {
		return
	}
	email := strings.ToLower(strings.TrimSpace(input.Email))
	if len(email) > 254 || !emailPattern.MatchString(email) {
		send(w, 400, map[string]string{"message": "请输入有效的邮箱地址"})
		return
	}
	now := time.Now().UnixMilli()
	hash := digest(email)
	tx, err := s.DB.Pool.Begin(r.Context())
	if err != nil {
		s.accountUnavailable(w)
		return
	}
	defer tx.Rollback(r.Context())
	if _, err = tx.Exec(r.Context(), "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", hash); err != nil {
		s.accountUnavailable(w)
		return
	}
	var sentAt int64
	err = tx.QueryRow(r.Context(), "SELECT sent_at FROM login_challenges WHERE email_hash=$1", hash).Scan(&sentAt)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		s.accountUnavailable(w)
		return
	}
	if sentAt > now-60000 {
		send(w, 429, map[string]any{"message": "请稍后再发送验证码", "retryAfter": (60000 - now + sentAt + 999) / 1000})
		return
	}
	ip, _, _ := net.SplitHostPort(r.RemoteAddr)
	if parsed := net.ParseIP(r.Header.Get("X-Real-IP")); parsed != nil {
		peer := net.ParseIP(ip)
		if peer != nil && peer.IsLoopback() {
			ip = parsed.String()
		}
	}
	limits := []struct {
		key      string
		max      int
		duration int64
	}{{"email-hour:" + hash, 5, 3600000}, {"email-day:" + hash, 10, 86400000}, {"ip-hour:" + digest(ip), 20, 3600000}, {"all-hour", 200, 3600000}}
	for _, v := range limits {
		hit, e := limited(r.Context(), tx, v.key, v.max, v.duration, now)
		if e != nil {
			s.accountUnavailable(w)
			return
		}
		if hit {
			if tx.Commit(r.Context()) != nil {
				s.accountUnavailable(w)
				return
			}
			send(w, 429, map[string]any{"message": "发送次数较多，请稍后再试"})
			return
		}
	}
	number, err := rand.Int(rand.Reader, big.NewInt(1000000))
	if err != nil {
		s.accountUnavailable(w)
		return
	}
	code := fmt.Sprintf("%06d", number.Int64())
	salt := randomToken()
	signature := digest(salt + ":" + code)
	_, err = tx.Exec(r.Context(), `INSERT INTO login_challenges VALUES($1,$2,$3,$4,0,$5,true) ON CONFLICT(email_hash) DO UPDATE SET salt=excluded.salt,digest=excluded.digest,expires_at=excluded.expires_at,attempts=0,sent_at=excluded.sent_at,pending=true`, hash, salt, signature, now+600000, now)
	if err != nil || tx.Commit(r.Context()) != nil {
		s.accountUnavailable(w)
		return
	}
	body, _ := json.Marshal(map[string]any{"from": s.MailFrom, "to": []string{email}, "subject": "你的生花登录验证码", "text": "你的登录验证码是 " + code + "，10 分钟内有效。请勿向他人提供验证码。如果不是你发起的登录，请忽略这封邮件。"})
	ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
	defer cancel()
	request, _ := http.NewRequestWithContext(ctx, "POST", "https://api.resend.com/emails", bytes.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+s.ResendKey)
	request.Header.Set("Content-Type", "application/json")
	response, e := s.MailClient.Do(request)
	success := e == nil && response.StatusCode >= 200 && response.StatusCode < 300
	if response != nil {
		io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		response.Body.Close()
	}
	cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
	defer done()
	if !success {
		_, _ = s.DB.Pool.Exec(cleanup, "DELETE FROM login_challenges WHERE email_hash=$1 AND digest=$2", hash, signature)
		send(w, 502, map[string]string{"message": "邮件暂时未能发送，请稍后重试"})
		return
	}
	_, err = s.DB.Pool.Exec(cleanup, "UPDATE login_challenges SET pending=false WHERE email_hash=$1 AND digest=$2", hash, signature)
	if err != nil {
		s.accountUnavailable(w)
		return
	}
	send(w, 200, map[string]any{"sent": true, "retryAfter": 60, "expiresIn": 600})
}
func (s *Server) verifyCode(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Email string `json:"email"`
		Code  string `json:"code"`
	}
	if !accountBody(w, r, &in) {
		return
	}
	email := strings.ToLower(strings.TrimSpace(in.Email))
	in.Code = strings.TrimSpace(in.Code)
	if len(email) > 254 || !emailPattern.MatchString(email) || !codePattern.MatchString(in.Code) {
		send(w, 400, map[string]string{"message": "请输入邮箱和六位验证码"})
		return
	}
	tx, err := s.DB.Pool.Begin(r.Context())
	if err != nil {
		s.accountUnavailable(w)
		return
	}
	defer tx.Rollback(r.Context())
	now := time.Now().UnixMilli()
	hash := digest(email)
	var salt, expected string
	var expiry int64
	var attempts int
	var pending bool
	err = tx.QueryRow(r.Context(), "SELECT salt,digest,expires_at,attempts,pending FROM login_challenges WHERE email_hash=$1 FOR UPDATE", hash).Scan(&salt, &expected, &expiry, &attempts, &pending)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && (expiry <= now || pending) {
		send(w, 400, map[string]string{"message": "验证码已失效，请重新发送"})
		return
	}
	if err != nil {
		s.accountUnavailable(w)
		return
	}
	if attempts >= 5 {
		send(w, 429, map[string]string{"message": "尝试次数过多，请重新发送验证码"})
		return
	}
	if _, err = tx.Exec(r.Context(), "UPDATE login_challenges SET attempts=attempts+1 WHERE email_hash=$1", hash); err != nil {
		s.accountUnavailable(w)
		return
	}
	actual := digest(salt + ":" + in.Code)
	if subtle.ConstantTimeCompare([]byte(expected), []byte(actual)) != 1 {
		if tx.Commit(r.Context()) != nil {
			s.accountUnavailable(w)
			return
		}
		send(w, 400, map[string]string{"message": "验证码不正确，请重新输入"})
		return
	}
	var u User
	err = tx.QueryRow(r.Context(), "SELECT id::text,email,name,avatar_url,created_at FROM users WHERE email=$1 AND id<>$2::uuid", email, officialID).Scan(&u.ID, &u.Email, &u.Name, &u.AvatarURL, &u.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		var id string
		token := randomToken()[:32]
		id = token[:8] + "-" + token[8:12] + "-4" + token[13:16] + "-a" + token[17:20] + "-" + token[20:]
		u = User{ID: id, Email: &email, Name: "新来的旅人", CreatedAt: now}
		_, err = tx.Exec(r.Context(), "INSERT INTO users(id,email,name,created_at) VALUES($1,$2,$3,$4)", u.ID, email, u.Name, now)
	}
	if err != nil {
		s.accountUnavailable(w)
		return
	}
	token := randomToken()
	expires := now + 90*86400000
	if _, err = tx.Exec(r.Context(), "INSERT INTO account_sessions VALUES($1,$2,$3)", digest(token), u.ID, expires); err != nil {
		s.accountUnavailable(w)
		return
	}
	if _, err = tx.Exec(r.Context(), "DELETE FROM login_challenges WHERE email_hash=$1", hash); err != nil {
		s.accountUnavailable(w)
		return
	}
	if tx.Commit(r.Context()) != nil {
		s.accountUnavailable(w)
		return
	}
	send(w, 200, map[string]any{"user": u, "token": token, "expiresAt": expires})
}
func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	u, key := s.requireUser(w, r)
	if u == nil {
		return
	}
	if _, err := s.DB.Pool.Exec(r.Context(), "DELETE FROM account_sessions WHERE token_hash=$1", key); err != nil {
		s.accountUnavailable(w)
		return
	}
	send(w, 200, map[string]any{"loggedOut": true})
}
func (s *Server) readAccount(w http.ResponseWriter, r *http.Request) {
	u, _ := s.requireUser(w, r)
	if u != nil {
		send(w, 200, map[string]any{"user": u})
	}
}
func (s *Server) patchAccount(w http.ResponseWriter, r *http.Request) {
	u, _ := s.requireUser(w, r)
	if u == nil {
		return
	}
	var in struct {
		Name string `json:"name"`
	}
	if !accountBody(w, r, &in) {
		return
	}
	name := norm.NFC.String(strings.TrimSpace(in.Name))
	valid := utf8.ValidString(name) && utf8.RuneCountInString(name) > 0 && utf8.RuneCountInString(name) <= 24
	for _, r := range name {
		if unicode.Is(unicode.Cc, r) || unicode.Is(unicode.Cf, r) {
			valid = false
		}
	}
	if !valid {
		send(w, 400, map[string]string{"message": "昵称需为 1 到 24 个字符，不能包含控制字符"})
		return
	}
	if _, err := s.DB.Pool.Exec(r.Context(), "UPDATE users SET name=$1 WHERE id=$2", name, u.ID); err != nil {
		s.accountUnavailable(w)
		return
	}
	u.Name = name
	send(w, 200, map[string]any{"user": u})
}
func (s *Server) accountUnavailable(w http.ResponseWriter) {
	send(w, 503, map[string]string{"message": "账户操作暂未完成，请稍后重试"})
}
