package query

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"

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
	ListOpenReviewsPage(context.Context, string, *readmodelstore.OpenReviewCursor, int32) (readmodelstore.OpenReviewPage, error)
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
