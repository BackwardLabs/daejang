package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"regexp"
	"time"

	"github.com/BackwardLabs/daejang-db/pkg/sourcejobstore"
)

var runtimeIDPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

type reclassificationStore interface {
	ListActionRuntimeReclassificationTargets(context.Context) ([]sourcejobstore.ActionRuntimeReclassificationTarget, error)
	Enqueue(context.Context, sourcejobstore.EnqueueParams) (sourcejobstore.SyncJob, error)
}

func main() {
	databaseURL := os.Getenv("DAEJANG_SOURCE_DATABASE_URL")
	runtimeID := os.Getenv("DAEJANG_ACTION_RUNTIME_ID")
	if databaseURL == "" || !runtimeIDPattern.MatchString(runtimeID) {
		log.Fatal("DAEJANG_SOURCE_DATABASE_URL and a lowercase SHA-256 DAEJANG_ACTION_RUNTIME_ID are required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	runtime, err := sourcejobstore.Open(ctx, sourcejobstore.Options{
		DatabaseURL: databaseURL, ApplicationName: "daejang-action-runtime-reclassify",
	})
	if err != nil {
		log.Fatal(err)
	}
	defer runtime.Close()
	count, err := enqueueActionRuntimeReclassification(ctx, runtime.Store, runtimeID)
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("Action runtime reclassification ensured: runtime=%s wallets=%d", runtimeID, count)
}

func enqueueActionRuntimeReclassification(ctx context.Context, store reclassificationStore, runtimeID string) (int, error) {
	if store == nil || !runtimeIDPattern.MatchString(runtimeID) {
		return 0, errors.New("reclassification store and lowercase SHA-256 runtime ID are required")
	}
	targets, err := store.ListActionRuntimeReclassificationTargets(ctx)
	if err != nil {
		return 0, err
	}
	for index, target := range targets {
		_, err := store.Enqueue(ctx, sourcejobstore.EnqueueParams{
			SubjectID: target.SubjectID, SourceKind: "EVM_WALLET", SourceID: target.SourceID,
			RequestedCoverageStart: target.CoverageStart, RequestedCoverageEnd: target.CoverageEnd,
			Trigger: "BACKFILL", IdempotencyKey: "action-runtime:" + runtimeID + ":" + target.SourceID,
		})
		if err != nil {
			return index, fmt.Errorf("enqueue action runtime reclassification for source %s: %w", target.SourceID, err)
		}
	}
	return len(targets), nil
}
