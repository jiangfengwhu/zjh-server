package httpapi

import (
	"bytes"
	"errors"
	"github.com/aws/smithy-go"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
)

var publicBlobPath = regexp.MustCompile(`^/v1/(?:avatars/[a-f0-9-]{36}/[a-f0-9]{64}|(?:app|vendor)/[a-f0-9]{64}|apk/[a-f0-9]{64}\.apk)$`)

func (s *Server) readBlob(w http.ResponseWriter, r *http.Request) {
	if !publicBlobPath.MatchString(r.URL.Path) {
		send(w, 404, map[string]string{"message": "文件不存在"})
		return
	}
	if s.Blobs == nil {
		send(w, 503, map[string]string{"message": "文件服务暂不可用"})
		return
	}
	object, err := s.Blobs.Get(r.Context(), strings.TrimPrefix(r.URL.Path, "/"))
	if err != nil {
		var api smithy.APIError
		if errors.As(err, &api) && (api.ErrorCode() == "NoSuchKey" || api.ErrorCode() == "NotFound") {
			send(w, 404, map[string]string{"message": "文件不存在"})
		} else {
			send(w, 503, map[string]string{"message": "文件服务暂不可用"})
		}
		return
	}
	defer object.Body.Close()
	if object.ContentType != nil {
		w.Header().Set("Content-Type", *object.ContentType)
	}
	if object.ContentLength != nil {
		w.Header().Set("Content-Length", strconv.FormatInt(*object.ContentLength, 10))
	}
	if object.ETag != nil {
		w.Header().Set("ETag", *object.ETag)
	}
	w.Header().Set("Cache-Control", "public,max-age=31536000,immutable")
	if r.Method != "HEAD" {
		_, _ = io.Copy(w, object.Body)
	}
}
func (s *Server) putAvatar(w http.ResponseWriter, r *http.Request) {
	user, _ := s.requireUser(w, r)
	if user == nil {
		return
	}
	if s.Blobs == nil {
		s.accountUnavailable(w)
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1048576))
	if err != nil {
		send(w, 413, map[string]string{"message": "头像需小于 1 MB"})
		return
	}
	if len(data) < 32 {
		send(w, 400, map[string]string{"message": "头像需为小于 1 MB 的图片"})
		return
	}
	mime := ""
	switch {
	case bytes.HasPrefix(data, []byte{255, 216, 255}):
		mime = "image/jpeg"
	case bytes.HasPrefix(data, []byte{137, 80, 78, 71, 13, 10, 26, 10}):
		mime = "image/png"
	case string(data[:4]) == "RIFF" && string(data[8:12]) == "WEBP":
		mime = "image/webp"
	}
	if mime == "" {
		send(w, 400, map[string]string{"message": "头像仅支持 JPEG、PNG 或 WebP 图片"})
		return
	}
	// Immutable random name; no file integrity verification or second pass.
	key := "v1/avatars/" + user.ID + "/" + randomToken()
	if s.Blobs.Put(r.Context(), key, mime, int64(len(data)), bytes.NewReader(data)) != nil {
		s.accountUnavailable(w)
		return
	}
	url := strings.TrimSuffix(s.PublicURL, "/") + "/" + key
	if _, err = s.DB.Pool.Exec(r.Context(), "UPDATE users SET avatar_url=$1 WHERE id=$2", url, user.ID); err != nil {
		s.accountUnavailable(w)
		return
	}
	user.AvatarURL = &url
	send(w, 200, map[string]any{"user": user})
}
func (s *Server) deleteAvatar(w http.ResponseWriter, r *http.Request) {
	user, _ := s.requireUser(w, r)
	if user == nil {
		return
	}
	if _, err := s.DB.Pool.Exec(r.Context(), "UPDATE users SET avatar_url=NULL WHERE id=$1", user.ID); err != nil {
		s.accountUnavailable(w)
		return
	}
	user.AvatarURL = nil
	send(w, 200, map[string]any{"user": user})
}
