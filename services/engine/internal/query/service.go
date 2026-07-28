package query

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/BackwardLabs/daejang-db/pkg/readmodelstore"
	"github.com/BackwardLabs/daejang-db/pkg/reportstore"
	"github.com/BackwardLabs/daejang-db/pkg/taxreportstore"
	enginev1 "github.com/BackwardLabs/daejang/services/engine/gen/go/giwa/engine/v1"
	"github.com/BackwardLabs/daejang/services/engine/internal/source"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"
)

type ReadStore interface {
	Dashboard(context.Context, string, int32) (readmodelstore.Dashboard, error)
	ListLedgerEvents(context.Context, string, int32, int32) ([]readmodelstore.LedgerEvent, error)
	ListOpenReviewsPage(context.Context, string, *readmodelstore.OpenReviewCursor, int32) (readmodelstore.OpenReviewPage, error)
}
type ReportStore interface {
	List(context.Context, string, int32, int32) ([]reportstore.Snapshot, error)
}
type TaxReportStore interface {
	GetCurrentReportForYear(context.Context, string, int) (taxreportstore.CurrentReportDetail, bool, error)
	ListReportHistory(context.Context, string, int, int32) ([]taxreportstore.StoredReport, error)
}
type Service struct {
	enginev1.UnimplementedQueryServiceServer
	Reads      ReadStore
	Reports    ReportStore
	TaxReports TaxReportStore
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
	if limit < 1 || limit > 200 {
		return nil, status.Error(codes.InvalidArgument, "review page limit must be between 1 and 200")
	}
	cursor, err := decodeReviewPageToken(req.GetPageToken())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "review page token is invalid")
	}
	page, err := s.Reads.ListOpenReviewsPage(ctx, subject, cursor, limit)
	if err != nil {
		return nil, status.Error(codes.Internal, "review query failed")
	}
	items := make([]*enginev1.ReviewItem, 0, len(page.Reviews))
	for _, v := range page.Reviews {
		items = append(items, &enginev1.ReviewItem{Id: v.ID, ExecutionId: v.ExecutionID, RevisionId: v.RevisionID, PointerVersion: v.PointerVersion, Status: v.Status, ReasonCodes: v.ReasonCodes, CreatedAt: timestamppb.New(v.CreatedAt)})
	}
	nextPageToken := ""
	if page.HasMore {
		if page.Next == nil {
			return nil, status.Error(codes.Internal, "review query returned an incomplete page cursor")
		}
		nextPageToken, err = encodeReviewPageToken(*page.Next)
		if err != nil {
			return nil, status.Error(codes.Internal, "review page token encoding failed")
		}
	}
	return &enginev1.ListReviewsResponse{Items: items, NextPageToken: nextPageToken}, nil
}

type reviewPageToken struct {
	Version   int    `json:"v"`
	CreatedAt string `json:"createdAt"`
	ReviewID  string `json:"reviewId"`
}

func encodeReviewPageToken(cursor readmodelstore.OpenReviewCursor) (string, error) {
	if cursor.CreatedAt.IsZero() || !validReviewPageID(cursor.ReviewID) {
		return "", fmt.Errorf("review page cursor is incomplete")
	}
	value, err := json.Marshal(reviewPageToken{
		Version:   1,
		CreatedAt: cursor.CreatedAt.UTC().Format(time.RFC3339Nano),
		ReviewID:  cursor.ReviewID,
	})
	if err != nil {
		return "", fmt.Errorf("marshal review page cursor: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

func decodeReviewPageToken(token string) (*readmodelstore.OpenReviewCursor, error) {
	if token == "" {
		return nil, nil
	}
	if strings.TrimSpace(token) != token || len(token) > 2048 {
		return nil, fmt.Errorf("review page token has an invalid shape")
	}
	value, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil {
		return nil, fmt.Errorf("decode review page token: %w", err)
	}
	var parsed reviewPageToken
	decoder := json.NewDecoder(bytes.NewReader(value))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&parsed); err != nil {
		return nil, fmt.Errorf("unmarshal review page token: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return nil, fmt.Errorf("review page token contains trailing data")
	}
	if parsed.Version != 1 {
		return nil, fmt.Errorf("review page token version is unsupported")
	}
	if !validReviewPageID(parsed.ReviewID) {
		return nil, fmt.Errorf("review page token has an invalid review ID")
	}
	createdAt, err := time.Parse(time.RFC3339Nano, parsed.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("parse review page token time: %w", err)
	}
	if createdAt.IsZero() {
		return nil, fmt.Errorf("review page token has a zero creation time")
	}
	return &readmodelstore.OpenReviewCursor{
		CreatedAt: createdAt.UTC(),
		ReviewID:  parsed.ReviewID,
	}, nil
}

func validReviewPageID(value string) bool {
	if strings.TrimSpace(value) == "" ||
		value != strings.TrimSpace(value) ||
		!utf8.ValidString(value) ||
		len(utf16.Encode([]rune(value))) > 256 {
		return false
	}
	return strings.IndexFunc(value, func(r rune) bool {
		return r < 0x20 || r == 0x7f
	}) == -1
}

func (s *Service) CreateReport(ctx context.Context, req *enginev1.CreateReportRequest) (*enginev1.CreateReportResponse, error) {
	if _, err := source.ValidateRequestContext(req.GetContext(), true); err != nil {
		return nil, err
	}
	return nil, status.Error(codes.FailedPrecondition, "LEGACY_REPORT_CREATION_DISABLED")
}

func (s *Service) GetCurrentTaxReport(ctx context.Context, req *enginev1.GetCurrentTaxReportRequest) (*enginev1.GetCurrentTaxReportResponse, error) {
	subject, err := source.ValidateRequestContext(req.GetContext(), false)
	if err != nil {
		return nil, err
	}
	if req.GetTaxYear() < 2027 {
		return nil, status.Error(codes.InvalidArgument, "tax year must be 2027 or later")
	}
	if s.TaxReports == nil {
		return nil, status.Error(codes.Unavailable, "tax report query is unavailable")
	}
	value, found, err := s.TaxReports.GetCurrentReportForYear(ctx, subject, int(req.GetTaxYear()))
	if errors.Is(err, taxreportstore.ErrAmbiguousResident) {
		return nil, status.Error(codes.FailedPrecondition, "AMBIGUOUS_TAX_RESIDENCY")
	}
	if err != nil {
		return nil, status.Error(codes.Internal, "tax report query failed")
	}
	if !found {
		return nil, status.Error(codes.NotFound, "tax report not found")
	}
	return &enginev1.GetCurrentTaxReportResponse{Report: currentTaxReportToProto(value)}, nil
}

func (s *Service) ListTaxReportHistory(ctx context.Context, req *enginev1.ListTaxReportHistoryRequest) (*enginev1.ListTaxReportHistoryResponse, error) {
	subject, err := source.ValidateRequestContext(req.GetContext(), false)
	if err != nil {
		return nil, err
	}
	if req.GetTaxYear() < 2027 {
		return nil, status.Error(codes.InvalidArgument, "tax year must be 2027 or later")
	}
	limit := req.GetLimit()
	if limit == 0 {
		limit = 20
	}
	if limit < 1 || limit > 100 {
		return nil, status.Error(codes.InvalidArgument, "tax report history limit must be between 1 and 100")
	}
	if s.TaxReports == nil {
		return nil, status.Error(codes.Unavailable, "tax report query is unavailable")
	}
	values, err := s.TaxReports.ListReportHistory(ctx, subject, int(req.GetTaxYear()), limit)
	if errors.Is(err, taxreportstore.ErrAmbiguousResident) {
		return nil, status.Error(codes.FailedPrecondition, "AMBIGUOUS_TAX_RESIDENCY")
	}
	if err != nil {
		return nil, status.Error(codes.Internal, "tax report history query failed")
	}
	items := make([]*enginev1.TaxReport, 0, len(values))
	for _, value := range values {
		items = append(items, taxReportToProto(value, 0, time.Time{}))
	}
	return &enginev1.ListTaxReportHistoryResponse{Items: items}, nil
}

func currentTaxReportToProto(value taxreportstore.CurrentReportDetail) *enginev1.TaxReport {
	return taxReportToProto(value.StoredReport, value.PointerVersion, value.UpdatedAt)
}

func taxReportToProto(value taxreportstore.StoredReport, pointerVersion int64, updatedAt time.Time) *enginev1.TaxReport {
	result := &enginev1.TaxReport{
		ReportId: value.ID, ResidentId: value.ResidentID, TaxYear: int32(value.TaxYear),
		Finality: value.Finality, Status: value.Status, FilingStatus: value.FilingStatus,
		TaxInventoryRunId: value.TaxInventoryRunID, TaxEstimateId: value.TaxEstimateID,
		LotRunId: value.LotRunID, InputDigest: value.InputDigest, SchemaDigest: value.SchemaDigest,
		DenominationAssetId: value.DenominationAssetID, ReportArtifactDigest: value.ReportArtifactDigest,
		EvidencePackDigest: value.EvidencePackDigest, PointerVersion: pointerVersion,
		IssuedAt: timestamppb.New(value.IssuedAt),
		Counts: &enginev1.TaxReportCounts{
			Disposals: int32(value.Counts.Disposals), Transfers: int32(value.Counts.Transfers),
			ExcludedConversions: int32(value.Counts.ExcludedConversions), Limitations: int32(value.Counts.Limitations),
		},
		GainLoss: taxAmountToProto(value.GainLoss), TaxableBase: taxAmountToProto(value.TaxableBase),
		NationalTax: taxAmountToProto(value.NationalTax), LocalTax: taxAmountToProto(value.LocalTax),
		TotalTax: taxAmountToProto(value.TotalTax),
	}
	if !updatedAt.IsZero() {
		result.UpdatedAt = timestamppb.New(updatedAt)
	}
	return result
}

func taxAmountToProto(value taxreportstore.Amount) *enginev1.TaxAmount {
	result := &enginev1.TaxAmount{Status: value.Status}
	if value.Status == "KNOWN" {
		result.Amount = value.Amount
		result.HasAmount = true
	}
	return result
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
