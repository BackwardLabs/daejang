package query

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"time"

	"github.com/BackwardLabs/daejang-db/pkg/readmodelstore"
	"github.com/BackwardLabs/daejang-db/pkg/reportstore"
	enginev1 "github.com/BackwardLabs/daejang/services/engine/gen/go/giwa/engine/v1"
	"github.com/BackwardLabs/daejang/services/engine/internal/source"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"
)

type ReadStore interface {
	Dashboard(context.Context, string, int32) (readmodelstore.Dashboard, error)
	ListLedgerEvents(context.Context, string, int32, int32) ([]readmodelstore.LedgerEvent, error)
	ListOpenReviews(context.Context, string, int32) ([]readmodelstore.Review, error)
}
type ReportStore interface {
	Commit(context.Context, reportstore.CommitParams) (reportstore.Snapshot, error)
	List(context.Context, string, int32, int32) ([]reportstore.Snapshot, error)
}
type Service struct {
	enginev1.UnimplementedQueryServiceServer
	Reads   ReadStore
	Reports ReportStore
	Now     func() time.Time
}

func (s *Service) GetDashboard(ctx context.Context, req *enginev1.GetDashboardRequest) (*enginev1.GetDashboardResponse, error) {
	subject, err := source.ValidateRequestContext(req.GetContext(), false)
	if err != nil {
		return nil, err
	}
	value, err := s.Reads.Dashboard(ctx, subject, req.GetTaxYear())
	if err != nil {
		return nil, status.Error(codes.Internal, "dashboard query failed")
	}
	result := &enginev1.Dashboard{SourceCount: value.SourceCount, TransactionCount: value.TransactionCount, OpenReviewCount: value.OpenReviewCount, CompletedCount: value.CompletedCount, ExceptionCount: value.ExceptionCount, LastSyncState: value.LastSyncState}
	if value.LastSyncUpdatedAt != nil {
		result.LastSyncUpdatedAt = timestamppb.New(*value.LastSyncUpdatedAt)
	}
	return &enginev1.GetDashboardResponse{Dashboard: result}, nil
}

func (s *Service) ListLedgerEvents(ctx context.Context, req *enginev1.ListLedgerEventsRequest) (*enginev1.ListLedgerEventsResponse, error) {
	subject, err := source.ValidateRequestContext(req.GetContext(), false)
	if err != nil {
		return nil, err
	}
	limit := req.GetLimit()
	if limit == 0 {
		limit = 100
	}
	values, err := s.Reads.ListLedgerEvents(ctx, subject, req.GetTaxYear(), limit)
	if err != nil {
		return nil, status.Error(codes.Internal, "ledger query failed")
	}
	items := make([]*enginev1.LedgerEvent, 0, len(values))
	for _, v := range values {
		event := &enginev1.LedgerEvent{EventId: v.EventID, RevisionId: v.RevisionID, RevisionNumber: v.RevisionNumber, EventType: v.EventType, FlowShape: v.FlowShape, Resolution: v.Resolution, InterpretationSupport: v.InterpretationSupport, EffectiveAt: timestamppb.New(v.EffectiveAt)}
		for _, p := range v.Postings {
			event.Postings = append(event.Postings, &enginev1.LedgerPosting{LegId: p.LegID, AccountId: p.AccountID, AssetId: p.AssetID, OccurredAt: timestamppb.New(p.OccurredAt), Direction: p.Direction, Quantity: p.Quantity, Role: p.Role, FairValue: p.FairValue, CostBasis: p.CostBasis, Denomination: p.Denomination})
		}
		items = append(items, event)
	}
	return &enginev1.ListLedgerEventsResponse{Items: items}, nil
}

func (s *Service) ListReviews(ctx context.Context, req *enginev1.ListReviewsRequest) (*enginev1.ListReviewsResponse, error) {
	subject, err := source.ValidateRequestContext(req.GetContext(), false)
	if err != nil {
		return nil, err
	}
	limit := req.GetLimit()
	if limit == 0 {
		limit = 100
	}
	values, err := s.Reads.ListOpenReviews(ctx, subject, limit)
	if err != nil {
		return nil, status.Error(codes.Internal, "review query failed")
	}
	items := make([]*enginev1.ReviewItem, 0, len(values))
	for _, v := range values {
		items = append(items, &enginev1.ReviewItem{Id: v.ID, ExecutionId: v.ExecutionID, RevisionId: v.RevisionID, PointerVersion: v.PointerVersion, Status: v.Status, ReasonCodes: v.ReasonCodes, CreatedAt: timestamppb.New(v.CreatedAt)})
	}
	return &enginev1.ListReviewsResponse{Items: items}, nil
}

func (s *Service) CreateReport(ctx context.Context, req *enginev1.CreateReportRequest) (*enginev1.CreateReportResponse, error) {
	subject, err := source.ValidateRequestContext(req.GetContext(), true)
	if err != nil {
		return nil, err
	}
	dashboard, err := s.Reads.Dashboard(ctx, subject, req.GetTaxYear())
	if err != nil {
		return nil, status.Error(codes.Internal, "report input query failed")
	}
	issuedAt := time.Now().UTC()
	if s.Now != nil {
		issuedAt = s.Now().UTC()
	}
	input := digest(fmt.Sprintf("%s|%d|%d|%d|%d", subject, req.GetTaxYear(), dashboard.TransactionCount, dashboard.CompletedCount, dashboard.ExceptionCount))
	// Until the tax-lot engine publishes a gain/loss artifact, any non-empty
	// ledger is explicitly partial instead of presenting a fabricated amount.
	statusValue := "FINAL"
	complete, exceptions := int64(0), int64(0)
	if dashboard.TransactionCount > 0 {
		statusValue = "PARTIAL"
		exceptions = dashboard.TransactionCount
	}
	result := digest(input + "|" + statusValue + "|0|KRW")
	manifest := digest("giwa-report-v1|" + input + "|" + result)
	row := digest(subject + "|" + fmt.Sprint(req.GetTaxYear()) + "|" + manifest)
	value, err := s.Reports.Commit(ctx, reportstore.CommitParams{ID: stableUUID(subject, input), SubjectID: subject, TaxYear: req.GetTaxYear(), Status: statusValue, InputDigest: input, ResultDigest: result, SchemaDigest: digest("giwa-report-schema-v1"), TransactionCount: dashboard.TransactionCount, CompleteCount: complete, ExceptionCount: exceptions, ProfitAmount: "0", Denomination: "KRW", ProducerName: "daejang-engine", ProducerVersion: "0.1.0", ManifestDigest: manifest, RowDigest: row, IssuedAt: issuedAt})
	if err != nil {
		return nil, status.Error(codes.Internal, "report snapshot commit failed")
	}
	return &enginev1.CreateReportResponse{Report: reportToProto(value)}, nil
}

func (s *Service) ListReports(ctx context.Context, req *enginev1.ListReportsRequest) (*enginev1.ListReportsResponse, error) {
	subject, err := source.ValidateRequestContext(req.GetContext(), false)
	if err != nil {
		return nil, err
	}
	limit := req.GetLimit()
	if limit == 0 {
		limit = 20
	}
	values, err := s.Reports.List(ctx, subject, req.GetTaxYear(), limit)
	if err != nil {
		return nil, status.Error(codes.Internal, "report query failed")
	}
	items := make([]*enginev1.ReportSnapshot, 0, len(values))
	for _, v := range values {
		items = append(items, reportToProto(v))
	}
	return &enginev1.ListReportsResponse{Items: items}, nil
}

func reportToProto(v reportstore.Snapshot) *enginev1.ReportSnapshot {
	return &enginev1.ReportSnapshot{Id: v.ID, TaxYear: v.TaxYear, Status: v.Status, InputDigest: v.InputDigest, ResultDigest: v.ResultDigest, SchemaDigest: v.SchemaDigest, TransactionCount: v.TransactionCount, CompleteCount: v.CompleteCount, ExceptionCount: v.ExceptionCount, ProfitAmount: v.ProfitAmount, Denomination: v.Denomination, ManifestDigest: v.ManifestDigest, RowDigest: v.RowDigest, IssuedAt: timestamppb.New(v.IssuedAt)}
}
func digest(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}
func stableUUID(subject, key string) string {
	sum := sha256.Sum256([]byte(subject + "\x00" + key))
	v := sum[:16]
	v[6] = (v[6] & 0x0f) | 0x50
	v[8] = (v[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", v[0:4], v[4:6], v[6:8], v[8:10], v[10:16])
}
