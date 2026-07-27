package workflow

import (
	"context"
	"errors"
	"time"

	"github.com/BackwardLabs/daejang-db/pkg/sourcejobstore"
	enginev1 "github.com/BackwardLabs/daejang/services/engine/gen/go/giwa/engine/v1"
	"github.com/BackwardLabs/daejang/services/engine/internal/source"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"
)

type Store interface {
	Enqueue(context.Context, sourcejobstore.EnqueueParams) (sourcejobstore.SyncJob, error)
	GetJob(context.Context, string, string) (sourcejobstore.SyncJob, error)
	ListJobs(context.Context, string, int32) ([]sourcejobstore.SyncJob, error)
}

type Service struct {
	enginev1.UnimplementedWorkflowServiceServer
	Store Store
}

func (s *Service) EnqueueSync(ctx context.Context, request *enginev1.EnqueueSyncRequest) (*enginev1.EnqueueSyncResponse, error) {
	subjectID, err := source.ValidateRequestContext(request.GetContext(), true)
	if err != nil {
		return nil, err
	}
	value, err := s.Store.Enqueue(ctx, sourcejobstore.EnqueueParams{
		SubjectID: subjectID, SourceKind: request.GetSourceKind(), SourceID: request.GetSourceId(),
		IdempotencyKey: request.GetContext().GetIdempotencyKey(),
	})
	if err != nil {
		return nil, mapError(err)
	}
	return &enginev1.EnqueueSyncResponse{Job: toProto(value)}, nil
}

func (s *Service) GetSyncJob(ctx context.Context, request *enginev1.GetSyncJobRequest) (*enginev1.GetSyncJobResponse, error) {
	subjectID, err := source.ValidateRequestContext(request.GetContext(), false)
	if err != nil {
		return nil, err
	}
	value, err := s.Store.GetJob(ctx, subjectID, request.GetJobId())
	if err != nil {
		return nil, mapError(err)
	}
	return &enginev1.GetSyncJobResponse{Job: toProto(value)}, nil
}

func (s *Service) ListSyncJobs(ctx context.Context, request *enginev1.ListSyncJobsRequest) (*enginev1.ListSyncJobsResponse, error) {
	subjectID, err := source.ValidateRequestContext(request.GetContext(), false)
	if err != nil {
		return nil, err
	}
	limit := request.GetLimit()
	if limit == 0 {
		limit = 20
	}
	values, err := s.Store.ListJobs(ctx, subjectID, limit)
	if err != nil {
		return nil, mapError(err)
	}
	items := make([]*enginev1.SyncJob, 0, len(values))
	for _, value := range values {
		items = append(items, toProto(value))
	}
	return &enginev1.ListSyncJobsResponse{Items: items}, nil
}

func mapError(err error) error {
	if errors.Is(err, sourcejobstore.ErrSourceNotFound) {
		return status.Error(codes.NotFound, "sync source not found")
	}
	if errors.Is(err, sourcejobstore.ErrJobNotFound) {
		return status.Error(codes.NotFound, "sync job not found")
	}
	return status.Error(codes.Internal, "sync job operation failed")
}

func toProto(value sourcejobstore.SyncJob) *enginev1.SyncJob {
	result := &enginev1.SyncJob{Id: value.ID, SourceKind: value.SourceKind, SourceId: value.SourceID, State: value.State,
		Phase: value.Phase, Attempts: value.Attempts, ProcessedRecords: value.ProcessedRecords,
		FailureCode: value.FailureCode, FailureMessage: value.FailureMessage, OutputFragmentId: value.OutputFragmentID,
		CreatedAt: timestamppb.New(value.CreatedAt), UpdatedAt: timestamppb.New(value.UpdatedAt)}
	if value.TotalRecords != nil {
		result.TotalRecords = *value.TotalRecords
		result.HasTotalRecords = true
	}
	setTime := func(value *time.Time) *timestamppb.Timestamp {
		if value == nil {
			return nil
		}
		return timestamppb.New(*value)
	}
	result.StartedAt = setTime(value.StartedAt)
	result.CompletedAt = setTime(value.CompletedAt)
	return result
}
