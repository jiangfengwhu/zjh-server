package main

import (
	"context"
	"encoding/json"
	"github.com/jiangfengwhu/zjh-server/go/internal/blob"
	"github.com/jiangfengwhu/zjh-server/go/internal/config"
	"github.com/jiangfengwhu/zjh-server/go/internal/database"
	"github.com/jiangfengwhu/zjh-server/go/internal/jules"
	"os"
	"time"
)

func main() {
	result := map[string]bool{"configuration": false, "database": false, "r2": false, "jules": false}
	defer func() { _ = json.NewEncoder(os.Stdout).Encode(result) }()
	cfg, err := config.Load()
	if err != nil {
		return
	}
	result["configuration"] = true
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	db, err := database.Open(ctx, cfg.DatabaseURL)
	if err == nil {
		result["database"] = true
		db.Pool.Close()
	}
	if cfg.R2Endpoint != "" {
		result["r2"] = blob.New(cfg.R2Endpoint, cfg.R2Bucket, cfg.R2AccessKey, cfg.R2SecretKey).Check(ctx) == nil
	}
	status, _, err := jules.New(cfg.JulesBaseURL, cfg.JulesKey, cfg.JulesRelayToken).Request(ctx, "GET", "/v1alpha/sources?pageSize=1", "", nil)
	result["jules"] = err == nil && status == 200
}
