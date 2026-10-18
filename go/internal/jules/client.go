package jules

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// Internal client only. Public handlers must authorize account, app and round
// before invoking it; relay authentication is not application authorization.
type Client struct {
	origin, key, relayToken string
	http                    *http.Client
}

func New(origin, key, relayToken string) *Client {
	return &Client{strings.TrimSuffix(origin, "/"), key, relayToken, &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(r *http.Request, via []*http.Request) error { return http.ErrUseLastResponse }}}
}

var sessionPath = regexp.MustCompile(`^/v1alpha/sessions/[A-Za-z0-9_-]{1,128}(?:/activities|:(?:approvePlan|sendMessage))?$`)

func (c *Client) Request(ctx context.Context, method, path, mask string, body []byte) (int, []byte, error) {
	u, err := url.Parse(path)
	if err != nil || u.IsAbs() || u.Host != "" || u.Fragment != "" || strings.ContainsAny(path, "\\\r\n") || (!sessionPath.MatchString(u.Path) && u.Path != "/v1alpha/sources" && u.Path != "/v1alpha/sessions") {
		return 0, nil, errors.New("invalid Jules operation")
	}
	if method != "GET" && method != "POST" {
		return 0, nil, errors.New("invalid Jules method")
	}
	if len(body) > 262144 {
		return 0, nil, errors.New("Jules request too large")
	}
	req, err := http.NewRequestWithContext(ctx, method, c.origin+path, bytes.NewReader(body))
	if err != nil {
		return 0, nil, errors.New("invalid Jules request")
	}
	req.Header.Set("Content-Type", "application/json")
	if c.relayToken != "" {
		req.Header.Set("Authorization", "Bearer "+c.relayToken)
	} else {
		req.Header.Set("X-Goog-Api-Key", c.key)
	}
	if mask != "" {
		req.Header.Set("X-Goog-FieldMask", mask)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return 0, nil, errors.New("Jules connection unavailable")
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 8*1024*1024+1))
	if err != nil || len(data) > 8*1024*1024 {
		return 0, nil, errors.New("Jules response unavailable")
	}
	return resp.StatusCode, data, nil
}
