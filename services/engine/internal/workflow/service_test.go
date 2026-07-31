package workflow

import (
	"context"
	"testing"
	"time"

	"github.com/BackwardLabs/daejang-db/pkg/sourcejobstore"
	enginev1 "github.com/BackwardLabs/daejang/services/engine/gen/go/giwa/engine/v1"
	"github.com/BackwardLabs/daejang/services/engine/internal/materializationread"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const workflowSubject = "11111111-1111-4111-8111-111111111111"

type fakeStore struct {
	params     []sourcejobstore.EnqueueParams
	getSubject string
	err        error
}

type fakeMaterializationReader struct {
	snapshot materializationread.Snapshot
	err      error
}

func (r fakeMaterializationReader) Get(context.Context, string, string, string) (materializationread.Snapshot, error) {
	return r.snapshot, r.err
}

func (s *fakeStore) Enqueue(_ context.Context, params sourcejobstore.EnqueueParams) (sourcejobstore.SyncJob, error) {
	if s.err != nil {
		return sourcejobstore.SyncJob{}, s.err
	}
	s.params = append(s.params, params)
	coverageStart, coverageEnd := params.RequestedCoverageStart, params.RequestedCoverageEnd
	return sourcejobstore.SyncJob{
		ID: "22222222-2222-4222-8222-222222222222", SubjectID: params.SubjectID,
		SourceKind: params.SourceKind, SourceID: params.SourceID, State: "QUEUED", Phase: "QUEUED",
		RequestedCoverageStart: &coverageStart, RequestedCoverageEnd: &coverageEnd,
		Trigger: params.Trigger, CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}, nil
}

func TestEnqueueSyncMapsImmutableIdempotencyConflict(t *testing.T) {
	service := &Service{Store: &fakeStore{err: sourcejobstore.ErrImmutableIdentityMismatch}}
	_, err := service.EnqueueSync(context.Background(), &enginev1.EnqueueSyncRequest{
		Context: workflowContext("reused-intent"), SourceKind: "EVM_WALLET",
		SourceId:               "33333333-3333-4333-8333-333333333333",
		RequestedCoverageStart: "2027-01-01", RequestedCoverageEnd: "2027-12-31", Trigger: "USER_REQUEST",
	})
	if status.Code(err) != codes.AlreadyExists || status.Convert(err).Message() != "SYNC_IDEMPOTENCY_CONFLICT" {
		t.Fatalf("immutable conflict was not mapped: %v", err)
	}
}

func (s *fakeStore) GetJob(_ context.Context, subject, _ string) (sourcejobstore.SyncJob, error) {
	s.getSubject = subject
	return sourcejobstore.SyncJob{ID: "22222222-2222-4222-8222-222222222222", CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC()}, nil
}

func (s *fakeStore) ListJobs(context.Context, string, int32) ([]sourcejobstore.SyncJob, error) {
	return nil, nil
}

func workflowContext(idempotencyKey string) *enginev1.RequestContext {
	return &enginev1.RequestContext{
		RequestId: "request-1", IdempotencyKey: idempotencyKey,
		Actor: &enginev1.ActorContext{UserId: workflowSubject, SessionId: "session-1"},
	}
}

func TestEnqueueSyncForwardsInclusiveDateCoverageTriggerAndIdempotency(t *testing.T) {
	store := &fakeStore{}
	service := &Service{Store: store}
	request := &enginev1.EnqueueSyncRequest{
		Context: workflowContext("wallet-2027"), SourceKind: "EVM_WALLET",
		SourceId:               "33333333-3333-4333-8333-333333333333",
		RequestedCoverageStart: "2027-01-01", RequestedCoverageEnd: "2027-12-31", Trigger: "USER_REQUEST",
	}
	first, err := service.EnqueueSync(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	second, err := service.EnqueueSync(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if first.GetJob().GetId() != second.GetJob().GetId() || len(store.params) != 2 {
		t.Fatalf("stable enqueue result was not preserved: first=%#v second=%#v", first, second)
	}
	params := store.params[0]
	if params.SubjectID != workflowSubject || params.IdempotencyKey != "wallet-2027" || params.Trigger != "USER_REQUEST" {
		t.Fatalf("enqueue scope or intent was lost: %#v", params)
	}
	if params.RequestedCoverageStart.Format("2006-01-02") != "2027-01-01" || params.RequestedCoverageEnd.Format("2006-01-02") != "2027-12-31" {
		t.Fatalf("inclusive DATE coverage was not preserved: %#v", params)
	}
}

func TestGetSyncJobAlwaysUsesActorSubject(t *testing.T) {
	store := &fakeStore{}
	service := &Service{Store: store}
	_, err := service.GetSyncJob(context.Background(), &enginev1.GetSyncJobRequest{
		Context: workflowContext(""), JobId: "44444444-4444-4444-8444-444444444444",
	})
	if err != nil {
		t.Fatal(err)
	}
	if store.getSubject != workflowSubject {
		t.Fatalf("job read was not actor scoped: %q", store.getSubject)
	}
}

func TestToProtoReportsCanonicalPostingMaterializationForCompletedEVMJob(t *testing.T) {
	now := time.Now().UTC()
	service := &Service{Materializations: fakeMaterializationReader{snapshot: materializationread.Snapshot{
		State: materializationread.StatePosted, PostingCount: 4,
	}}}
	job := service.toProto(context.Background(), workflowSubject, sourcejobstore.SyncJob{
		ID: "22222222-2222-4222-8222-222222222222", SourceKind: "EVM_WALLET", State: "SUCCEEDED",
		UpstreamJITRunID: "jit-run:1", OutputFragmentID: "fragment:1", CreatedAt: now, UpdatedAt: now,
	})
	if job.GetLedgerMaterializationState() != materializationread.StatePosted || job.GetLedgerPostingCount() != 4 {
		t.Fatalf("canonical materialization was not exposed: %#v", job)
	}
}

func TestToProtoDoesNotClaimLedgerSuccessWhenMaterializationReadFails(t *testing.T) {
	now := time.Now().UTC()
	service := &Service{Materializations: fakeMaterializationReader{err: context.DeadlineExceeded}}
	job := service.toProto(context.Background(), workflowSubject, sourcejobstore.SyncJob{
		ID: "22222222-2222-4222-8222-222222222222", SourceKind: "EVM_WALLET", State: "SUCCEEDED",
		UpstreamJITRunID: "jit-run:1", OutputFragmentID: "fragment:1", CreatedAt: now, UpdatedAt: now,
	})
	if job.GetLedgerMaterializationState() != materializationread.StateUnavailable || job.GetLedgerPostingCount() != 0 {
		t.Fatalf("failed read was presented as ledger success: %#v", job)
	}
}
