package main

import (
	"context"
	"testing"
	"time"

	"github.com/BackwardLabs/daejang-db/pkg/sourcejobstore"
)

type recordingReclassificationStore struct {
	targets []sourcejobstore.ActionRuntimeReclassificationTarget
	params  []sourcejobstore.EnqueueParams
}

func (s *recordingReclassificationStore) ListActionRuntimeReclassificationTargets(context.Context) ([]sourcejobstore.ActionRuntimeReclassificationTarget, error) {
	return s.targets, nil
}

func (s *recordingReclassificationStore) Enqueue(_ context.Context, params sourcejobstore.EnqueueParams) (sourcejobstore.SyncJob, error) {
	s.params = append(s.params, params)
	return sourcejobstore.SyncJob{}, nil
}

func TestEnqueueActionRuntimeReclassificationPreservesCoverageAndIsRuntimeIdempotent(t *testing.T) {
	store := &recordingReclassificationStore{targets: []sourcejobstore.ActionRuntimeReclassificationTarget{{
		SubjectID:     "00000000-0000-4000-8000-000000000001",
		SourceID:      "00000000-0000-4000-8000-000000000002",
		CoverageStart: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		CoverageEnd:   time.Date(2026, 7, 30, 0, 0, 0, 0, time.UTC),
	}}}
	runtimeID := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	count, err := enqueueActionRuntimeReclassification(context.Background(), store, runtimeID)
	if err != nil || count != 1 || len(store.params) != 1 {
		t.Fatalf("unexpected enqueue result: count=%d params=%#v error=%v", count, store.params, err)
	}
	value := store.params[0]
	if value.Trigger != "BACKFILL" || value.RequestedCoverageStart != store.targets[0].CoverageStart ||
		value.RequestedCoverageEnd != store.targets[0].CoverageEnd ||
		value.IdempotencyKey != "action-runtime:"+runtimeID+":"+store.targets[0].SourceID {
		t.Fatalf("reclassification changed the target contract: %#v", value)
	}
}

func TestEnqueueActionRuntimeReclassificationRejectsUnpinnedRuntime(t *testing.T) {
	if _, err := enqueueActionRuntimeReclassification(context.Background(), &recordingReclassificationStore{}, "latest"); err == nil {
		t.Fatal("unpinned action runtime was accepted")
	}
}
