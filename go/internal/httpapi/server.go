package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/jiangfengwhu/zjh-server/go/internal/blob"
	"github.com/jiangfengwhu/zjh-server/go/internal/database"
	"log/slog"
	"net/http"
	"strconv"
	"time"
)

type Server struct {
	OfficialToken       string
	DB                  *database.Store
	CDN                 string
	Log                 *slog.Logger
	ResendKey, MailFrom string
	MailClient          *http.Client
	Blobs               *blob.R2
	PublicURL           string
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/auth/code", s.sendCode)
	mux.HandleFunc("POST /v1/auth/verify", s.verifyCode)
	mux.HandleFunc("POST /v1/auth/logout", s.logout)
	mux.HandleFunc("GET /v1/account", s.readAccount)
	mux.HandleFunc("PATCH /v1/account", s.patchAccount)
	mux.HandleFunc("PUT /v1/account/avatar", s.putAvatar)
	mux.HandleFunc("DELETE /v1/account/avatar", s.deleteAvatar)
	mux.HandleFunc("GET /v1/avatars/{user}/{hash}", s.readBlob)
	mux.HandleFunc("GET /v1/app/{hash}", s.readBlob)
	mux.HandleFunc("GET /v1/vendor/{hash}", s.readBlob)
	mux.HandleFunc("GET /v1/apk/{hash}", s.readBlob)
	mux.HandleFunc("POST /v1/app-data/{app}/{scope}/{collection}", s.applicationData)
	mux.HandleFunc("/v1/career-rescue/content", s.careerContent)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		send(w, 200, map[string]any{"ok": true, "service": "shenghua-go"})
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if s.DB.Pool.Ping(ctx) != nil {
			send(w, 503, map[string]any{"ok": false})
			return
		}
		send(w, 200, map[string]any{"ok": true, "mode": "shadow", "migrationComplete": false})
	})
	for _, name := range []string{"release", "runtime", "apk", "maps/vendor.json"} {
		key := "v1/" + name
		mux.HandleFunc("GET /"+key, func(w http.ResponseWriter, r *http.Request) { s.catalog(w, r, key) })
	}
	mux.HandleFunc("GET /v1/updates", s.updates)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		send(w, 404, map[string]string{"message": "route not implemented in Go yet"})
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-store")
		defer func() {
			if recover() != nil {
				s.Log.Error("request panicked")
				send(w, 500, map[string]string{"message": "internal error"})
			}
		}()
		r.Body = http.MaxBytesReader(w, r.Body, 52<<20)
		mux.ServeHTTP(w, r)
	})
}
func (s *Server) catalog(w http.ResponseWriter, r *http.Request, key string) {
	value, err := s.DB.Catalog(r.Context(), key)
	if errors.Is(err, pgx.ErrNoRows) {
		send(w, 404, map[string]string{"message": "not found"})
		return
	}
	if err != nil {
		send(w, 503, map[string]string{"message": "catalog unavailable"})
		return
	}
	send(w, 200, value)
}
func (s *Server) updates(w http.ResponseWriter, r *http.Request) {
	raw := r.URL.Query().Get("apkVersionCode")
	if raw == "" {
		raw = "0"
	}
	code, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || code < 0 || code > 9007199254740991 {
		send(w, 400, map[string]string{"message": "APK 版本无效"})
		return
	}
	release, err := s.DB.Catalog(r.Context(), "v1/release")
	if errors.Is(err, pgx.ErrNoRows) {
		send(w, 404, map[string]string{"message": "还没有线上版本"})
		return
	}
	if err != nil {
		send(w, 503, map[string]string{"message": "catalog unavailable"})
		return
	}
	apkData, err := s.DB.Catalog(r.Context(), "v1/apk")
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		send(w, 503, map[string]string{"message": "catalog unavailable"})
		return
	}
	var apk map[string]any
	update := false
	if len(apkData) > 0 {
		if json.Unmarshal(apkData, &apk) != nil {
			send(w, 503, map[string]string{"message": "invalid APK manifest"})
			return
		}
		version, ok := apk["versionCode"].(float64)
		if !ok {
			send(w, 503, map[string]string{"message": "invalid APK manifest"})
			return
		}
		apk["url"] = fmt.Sprintf("%s/v1/apk/%s.apk", s.CDN, apk["sha256"])
		update = version > float64(code)
	}
	send(w, 200, map[string]any{"release": release, "apk": apk, "apkUpdate": update})
}
func send(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
