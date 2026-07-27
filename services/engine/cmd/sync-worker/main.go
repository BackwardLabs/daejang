package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/BackwardLabs/daejang-db/pkg/sourcejobstore"
	"github.com/BackwardLabs/daejang/services/engine/internal/worker"
)

func main() {
	dsn := os.Getenv("DAEJANG_SOURCE_DATABASE_URL")
	root := os.Getenv("DAEJANG_PRIVATE_OBJECT_ROOT")
	if dsn == "" || root == "" {
		log.Fatal("DAEJANG_SOURCE_DATABASE_URL and DAEJANG_PRIVATE_OBJECT_ROOT are required")
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	runtime, err := sourcejobstore.Open(ctx, sourcejobstore.Options{DatabaseURL: dsn, ApplicationName: "daejang-sync-worker"})
	if err != nil {
		log.Fatal(err)
	}
	defer runtime.Close()
	if err := (worker.Runner{Store: runtime.Store, ObjectRoot: root}).Run(ctx); err != nil {
		log.Fatal(err)
	}
}
