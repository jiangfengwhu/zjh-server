package config

import (
	"errors"
	"net/url"
	"os"
)

type Config struct {
	OfficialToken                                                                          string
	Listen, DatabaseURL, PublicURL, CDNURL, R2Endpoint, R2Bucket, R2AccessKey, R2SecretKey string
	ResendKey, MailFrom                                                                    string
	JulesKey, JulesBaseURL, JulesRelayToken                                                string
}

func Load() (Config, error) {
	c := Config{Listen: value("LISTEN_ADDR", "127.0.0.1:8080"), DatabaseURL: os.Getenv("DATABASE_URL"), PublicURL: value("PUBLIC_URL", "https://zijinhua.297782.xyz"), CDNURL: value("CDN_URL", "https://zjh-cdn.297782.xyz"), R2Endpoint: os.Getenv("R2_ENDPOINT"), R2Bucket: value("R2_BUCKET", "zijinhua"), R2AccessKey: os.Getenv("R2_ACCESS_KEY_ID"), R2SecretKey: os.Getenv("R2_SECRET_ACCESS_KEY")}
	c.ResendKey = os.Getenv("RESEND_API_KEY")
	c.MailFrom = os.Getenv("MAIL_FROM")
	c.JulesKey = os.Getenv("JULES_API_KEY")
	c.JulesBaseURL = value("JULES_BASE_URL", "https://jules.googleapis.com")
	c.JulesRelayToken = os.Getenv("JULES_RELAY_TOKEN")
	c.OfficialToken = os.Getenv("OFFICIAL_PUBLISH_TOKEN")
	u, err := url.Parse(c.JulesBaseURL)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return c, errors.New("invalid Jules origin")
	}
	if u.Host != "jules.googleapis.com" && c.JulesRelayToken == "" {
		return c, errors.New("Jules relay token is required")
	}
	if c.DatabaseURL == "" {
		return c, errors.New("DATABASE_URL is required")
	}
	for _, raw := range []string{c.PublicURL, c.CDNURL} {
		u, e := url.Parse(raw)
		if e != nil || u.Scheme != "https" || u.Host == "" || u.User != nil {
			return c, errors.New("public and CDN origins must be HTTPS")
		}
	}
	if c.R2Endpoint != "" {
		u, e := url.Parse(c.R2Endpoint)
		if e != nil || u.Scheme != "https" || u.Host == "" || u.User != nil {
			return c, errors.New("invalid R2 endpoint")
		}
		if c.R2AccessKey == "" || c.R2SecretKey == "" {
			return c, errors.New("R2 credentials are incomplete")
		}
	}
	return c, nil
}
func value(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
