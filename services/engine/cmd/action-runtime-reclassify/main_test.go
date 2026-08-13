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
	jobs    []sourcejobstore.SyncJob
}

func (s *recordingReclassificationStore) ListActionRuntimeReclassificationTargets(context.Context) ([]sourcejobstore.ActionRuntimeReclassificationTarget, error) {
	return s.targets, nil
}

func (s *recordingReclassificationStore) Enqueue(_ context.Context, params sourcejobstore.EnqueueParams) (sourcejobstore.SyncJob, error) {
	s.params = append(s.params, params)
	if len(s.jobs) > 0 {
		job := s.jobs[0]
		s.jobs = s.jobs[1:]
		return job, nil
	}
	return sourcejobstore.SyncJob{}, nil
}

func TestEnqueueActionRuntimeReclassificationPreservesCoverageAndIsRuntimeIdempotent(t *testing.T) {
	store := &recordingReclassificationStore{targets: []sourcejobstore.ActionRuntimeReclassificationTarget{{
		SubjectID:             "00000000-0000-4000-8000-000000000001",
		SourceID:              "00000000-0000-4000-8000-000000000002",
		LatestSuccessfulJobID: "00000000-0000-4000-8000-000000000009",
		CoverageStart:         time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		CoverageEnd:           time.Date(2026, 7, 30, 0, 0, 0, 0, time.UTC),
	}}}
	runtimeID := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	count, err := enqueueActionRuntimeReclassification(context.Background(), store, runtimeID)
	if err != nil || count != 1 || len(store.params) != 1 {
		t.Fatalf("unexpected enqueue result: count=%d params=%#v error=%v", count, store.params, err)
	}
	value := store.params[0]
	if value.Trigger != "BACKFILL" || value.RequestedCoverageStart != store.targets[0].CoverageStart ||
		value.RequestedCoverageEnd != store.targets[0].CoverageEnd ||
		value.IdempotencyKey != "action-runtime:"+runtimeID+":"+store.targets[0].SourceID+":"+store.targets[0].LatestSuccessfulJobID {
		t.Fatalf("reclassification changed the target contract: %#v", value)
	}
}

func TestEnqueueActionRuntimeReclassificationRetriesAnExistingFailedJob(t *testing.T) {
	runtimeID := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	store := &recordingReclassificationStore{
		targets: []sourcejobstore.ActionRuntimeReclassificationTarget{{
			SubjectID:             "00000000-0000-4000-8000-000000000001",
			SourceID:              "00000000-0000-4000-8000-000000000002",
			LatestSuccessfulJobID: "00000000-0000-4000-8000-000000000009",
		}},
		jobs: []sourcejobstore.SyncJob{{
			ID: "00000000-0000-4000-8000-000000000003", State: "FAILED",
		}},
	}
	count, err := enqueueActionRuntimeReclassification(context.Background(), store, runtimeID)
	if err != nil || count != 1 || len(store.params) != 2 {
		t.Fatalf("unexpected retry result: count=%d params=%#v error=%v", count, store.params, err)
	}
	want := "action-runtime-retry:" + runtimeID + ":00000000-0000-4000-8000-000000000003"
	if store.params[1].IdempotencyKey != want || store.params[1].Trigger != "BACKFILL" {
		t.Fatalf("failed runtime job was not retried deterministically: %#v", store.params[1])
	}
}

func TestEnqueueActionRuntimeReclassificationAdvancesPastFailedRetryChain(t *testing.T) {
	runtimeID := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	store := &recordingReclassificationStore{
		targets: []sourcejobstore.ActionRuntimeReclassificationTarget{{
			SubjectID:             "00000000-0000-4000-8000-000000000001",
			SourceID:              "00000000-0000-4000-8000-000000000002",
			LatestSuccessfulJobID: "00000000-0000-4000-8000-000000000009",
		}},
		jobs: []sourcejobstore.SyncJob{
			{ID: "00000000-0000-4000-8000-000000000003", State: "FAILED"},
			{ID: "00000000-0000-4000-8000-000000000004", State: "FAILED"},
			{ID: "00000000-0000-4000-8000-000000000005", State: "QUEUED"},
		},
	}
	count, err := enqueueActionRuntimeReclassification(context.Background(), store, runtimeID)
	if err != nil || count != 1 || len(store.params) != 3 {
		t.Fatalf("unexpected retry-chain result: count=%d params=%#v error=%v", count, store.params, err)
	}
	want := []string{
		"action-runtime:" + runtimeID + ":00000000-0000-4000-8000-000000000002:00000000-0000-4000-8000-000000000009",
		"action-runtime-retry:" + runtimeID + ":00000000-0000-4000-8000-000000000003",
		"action-runtime-retry:" + runtimeID + ":00000000-0000-4000-8000-000000000004",
	}
	for index, params := range store.params {
		if params.IdempotencyKey != want[index] {
			t.Fatalf("retry chain stopped at the wrong job: got=%q want=%q", params.IdempotencyKey, want[index])
		}
	}
}

func TestEnqueueActionRuntimeReclassificationRequiresSuccessfulSnapshot(t *testing.T) {
	runtimeID := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	store := &recordingReclassificationStore{targets: []sourcejobstore.ActionRuntimeReclassificationTarget{{
		SubjectID: "00000000-0000-4000-8000-000000000001",
		SourceID:  "00000000-0000-4000-8000-000000000002",
	}}}
	if _, err := enqueueActionRuntimeReclassification(context.Background(), store, runtimeID); err == nil {
		t.Fatal("reclassification without a successful source snapshot was accepted")
	}
}

func TestEnqueueActionRuntimeReclassificationRejectsUnpinnedRuntime(t *testing.T) {
	if _, err := enqueueActionRuntimeReclassification(context.Background(), &recordingReclassificationStore{}, "latest"); err == nil {
		t.Fatal("unpinned action runtime was accepted")
	}
}
