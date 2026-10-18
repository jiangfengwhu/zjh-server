package main

import (
	"context"
	"errors"
	"github.com/jiangfengwhu/zjh-server/go/internal/blob"
	"github.com/jiangfengwhu/zjh-server/go/internal/config"
	"github.com/jiangfengwhu/zjh-server/go/internal/database"
	"github.com/jiangfengwhu/zjh-server/go/internal/httpapi"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	cfg, err := config.Load()
	if err != nil {
		logger.Error("invalid configuration")
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	startup, cancel := context.WithTimeout(ctx, 30*time.Second)
	db, err := database.Open(startup, cfg.DatabaseURL)
	if err != nil {
		cancel()
		logger.Error("database connection failed")
		os.Exit(1)
	}
	defer db.Pool.Close()
	if db.Migrate(startup) != nil {
		cancel()
		logger.Error("database migration failed")
		os.Exit(1)
	}
	cancel()
	go db.Maintenance(ctx)
	app := &httpapi.Server{DB: db, CDN: cfg.CDNURL, Log: logger, ResendKey: cfg.ResendKey, MailFrom: cfg.MailFrom, MailClient: &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error { return http.ErrUseLastResponse }}}
	app.PublicURL = cfg.PublicURL
	app.OfficialToken = cfg.OfficialToken
	if cfg.R2Endpoint != "" {
		app.Blobs = blob.New(cfg.R2Endpoint, cfg.R2Bucket, cfg.R2AccessKey, cfg.R2SecretKey)
	}
	srv := &http.Server{Addr: cfg.Listen, Handler: app.Handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 2 * time.Minute, IdleTimeout: 75 * time.Second, MaxHeaderBytes: 32 << 10}
	failure := make(chan error, 1)
	go func() { failure <- srv.ListenAndServe() }()
	logger.Info("server started", "mode", "shadow", "listen", cfg.Listen)
	select {
	case <-ctx.Done():
	case err = <-failure:
		if !errors.Is(err, http.ErrServerClosed) {
			logger.Error("HTTP listener failed")
			os.Exit(1)
		}
	}
	shutdown, done := context.WithTimeout(context.Background(), 15*time.Second)
	defer done()
	if srv.Shutdown(shutdown) != nil {
		_ = srv.Close()
	}
}
