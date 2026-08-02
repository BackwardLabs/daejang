package query

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"sort"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/BackwardLabs/daejang-db/pkg/artifactstore"
	"github.com/BackwardLabs/daejang-db/pkg/readmodelstore"
	"github.com/BackwardLabs/daejang-db/pkg/reportstore"
	"github.com/BackwardLabs/daejang-db/pkg/taxreportstore"
	enginev1 "github.com/BackwardLabs/daejang/services/engine/gen/go/giwa/engine/v1"
	"github.com/BackwardLabs/daejang/services/engine/internal/lotread"
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
type LotStore interface {
	EventLineage(context.Context, string, string, string, int32) (lotread.Lineage, error)
}
type ReportStore interface {
	List(context.Context, string, int32, int32) ([]reportstore.Snapshot, error)
}
type ObservationReadStore interface {
	CountUnmaterialized(context.Context, string, int32) (int64, error)
	ListUnmaterialized(context.Context, string, int32, int32) ([]readmodelstore.LedgerEvent, error)
}
type TaxReportStore interface {
	GetCurrentReportForYear(context.Context, string, int) (taxreportstore.CurrentReportDetail, bool, error)
	ListReportHistory(context.Context, string, int, int32) ([]taxreportstore.StoredReport, error)
	GetReport(context.Context, string, string) (taxreportstore.StoredReport, bool, error)
}
type TaxReportArtifactStore interface {
	GetTaxReportArtifact(context.Context, string, string, string) (artifactstore.Object, bool, error)
}
type Service struct {
	enginev1.UnimplementedQueryServiceServer
	Reads              ReadStore
	Reports            ReportStore
	TaxReports         TaxReportStore
	TaxReportArtifacts TaxReportArtifactStore
	Observations       ObservationReadStore
	Lots               LotStore
}

const (
	taxReportModelMediaType = "application/vnd.giwa.tax-report-model.v1+json"
	taxReportModelSchemaV1  = "giwa.tax-report-model.v1"
	maxTaxReportModelBytes  = 16 << 20
)

func (s *Service) GetDashboard(ctx context.Context, req *enginev1.GetDashboardRequest) (*enginev1.GetDashboardResponse, error) {
	subject, err := source.ValidateRequestContext(req.GetContext(), false)
	if err != nil {
		return nil, err
	}
	value, err := s.Reads.Dashboard(ctx, subject, req.GetTaxYear())
	if err != nil {
		return nil, status.Error(codes.Internal, "dashboard query failed")
	}
	if s.Observations != nil {
		pending, observationErr := s.Observations.CountUnmaterialized(ctx, subject, req.GetTaxYear())
		if observationErr != nil {
			log.Printf("observation dashboard projection failed: %v", observationErr)
			return nil, status.Error(codes.Internal, "observation dashboard query failed")
		}
		value.TransactionCount += pending
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
	if s.Observations != nil {
		fallback, observationErr := s.Observations.ListUnmaterialized(ctx, subject, req.GetTaxYear(), limit)
		if observationErr != nil {
			log.Printf("observation ledger projection failed: %v", observationErr)
			return nil, status.Error(codes.Internal, "observation ledger query failed")
		}
		values = append(values, fallback...)
		sort.SliceStable(values, func(i, j int) bool { return values[i].EffectiveAt.After(values[j].EffectiveAt) })
		if len(values) > int(limit) {
			values = values[:limit]
		}
	}
	items := make([]*enginev1.LedgerEvent, 0, len(values))
	for _, v := range values {
		event := &enginev1.LedgerEvent{
			EventId:               v.EventID,
			RevisionId:            v.RevisionID,
			RevisionNumber:        v.RevisionNumber,
			EventType:             v.EventType,
			FlowShape:             v.FlowShape,
			Subtype:               v.Subtype,
			Resolution:            v.Resolution,
			InterpretationSupport: v.InterpretationSupport,
			EffectiveAt:           timestamppb.New(v.EffectiveAt),
			ChainId:               v.ChainID,
			TransactionHash:       v.TransactionHash,
			TransactionCoordinate: v.TransactionCoordinate,
			ActionProofId:         v.ActionProofID,
			ActionProfileId:       v.ActionProfileID,
			ActionProfileVersion:  v.ActionProfileVersion,
			ActionBindingId:       v.ActionBindingID,
		}
		if v.TransferEndpoint != nil {
			event.TransferEndpoint = &enginev1.LedgerTransferEndpoint{
				Resolution:       v.TransferEndpoint.Resolution,
				Kind:             v.TransferEndpoint.Kind,
				Display:          v.TransferEndpoint.Display,
				AddressFamily:    v.TransferEndpoint.AddressFamily,
				WalletSourceId:   v.TransferEndpoint.WalletSourceID,
				ChainCandidates:  append([]string(nil), v.TransferEndpoint.ChainCandidates...),
				ConnectionStatus: v.TransferEndpoint.ConnectionStatus,
				ReviewRequired:   v.TransferEndpoint.ReviewRequired,
			}
		}
		for _, p := range v.Postings {
			posting := &enginev1.LedgerPosting{LegId: p.LegID, AccountId: p.AccountID, AssetId: p.AssetID, OccurredAt: timestamppb.New(p.OccurredAt), Direction: p.Direction, Quantity: p.Quantity, Role: p.Role, FairValue: p.FairValue, CostBasis: p.CostBasis, Denomination: p.Denomination, AssetSymbol: p.AssetSymbol, AssetVenue: p.AssetVenue}
			if p.AssetDecimals != nil {
				posting.AssetDecimals = uint32(*p.AssetDecimals)
				posting.HasAssetDecimals = true
			}
			event.Postings = append(event.Postings, posting)
		}
		items = append(items, event)
	}
	return &enginev1.ListLedgerEventsResponse{Items: items}, nil
}

func (s *Service) GetLedgerEventLots(ctx context.Context, req *enginev1.GetLedgerEventLotsRequest) (*enginev1.GetLedgerEventLotsResponse, error) {
	subject, err := source.ValidateRequestContext(req.GetContext(), false)
	if err != nil {
		return nil, err
	}
	if req.GetEventId() == "" || req.GetRevisionId() == "" {
		return nil, status.Error(codes.InvalidArgument, "Event and revision identifiers are required")
	}
	if s.Lots == nil {
		return nil, status.Error(codes.Unavailable, "lot lineage is not configured")
	}
	lineage, err := s.Lots.EventLineage(ctx, subject, req.GetEventId(), req.GetRevisionId(), 500)
	if err != nil {
		return nil, status.Error(codes.Internal, "lot lineage query failed")
	}
	links := make([]*enginev1.LedgerLotLink, 0, len(lineage.Links))
	for _, v := range lineage.Links {
		link := &enginev1.LedgerLotLink{
			Kind: v.Kind, LegId: v.LegID, LotId: v.LotID, Quantity: v.Quantity,
			BasisStatus: v.BasisStatus, BasisAmount: v.BasisAmount, BasisDenomination: v.BasisDenomination,
			SourceEventId: v.SourceEventID, SourceLegId: v.SourceLegID, SourceQuantity: v.SourceQuantity,
			RemainingQuantity: v.RemainingQuantity,
		}
		if v.SourceOccurredAt != nil {
			link.SourceOccurredAt = timestamppb.New(*v.SourceOccurredAt)
		}
		links = append(links, link)
	}
	return &enginev1.GetLedgerEventLotsResponse{RunId: lineage.RunID, Coverage: lineage.Coverage, Links: links}, nil
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
	if req.GetTaxYear() < 2025 {
		return nil, status.Error(codes.InvalidArgument, "tax year must be 2025 or later")
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
	if req.GetTaxYear() < 2025 {
		return nil, status.Error(codes.InvalidArgument, "tax year must be 2025 or later")
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

func (s *Service) GetTaxReportModel(ctx context.Context, req *enginev1.GetTaxReportModelRequest) (*enginev1.GetTaxReportModelResponse, error) {
	subject, err := source.ValidateRequestContext(req.GetContext(), false)
	if err != nil {
		return nil, err
	}
	if !validTaxReportID(req.GetReportId()) {
		return nil, status.Error(codes.InvalidArgument, "tax report ID is invalid")
	}
	if s.TaxReports == nil || s.TaxReportArtifacts == nil {
		return nil, status.Error(codes.Unavailable, "tax report model query is unavailable")
	}
	value, found, err := s.TaxReports.GetReport(ctx, subject, req.GetReportId())
	if err != nil {
		return nil, status.Error(codes.Internal, "tax report query failed")
	}
	if !found {
		return nil, status.Error(codes.NotFound, "tax report model not found")
	}
	if value.SubjectID != subject || value.ID != req.GetReportId() {
		log.Printf("tax report model row identity verification failed: report=%q", req.GetReportId())
		return nil, status.Error(codes.DataLoss, "tax report model integrity verification failed")
	}
	object, found, err := s.TaxReportArtifacts.GetTaxReportArtifact(
		ctx,
		subject,
		value.ID,
		value.ReportArtifactDigest,
	)
	if err != nil {
		return nil, status.Error(codes.Internal, "tax report model query failed")
	}
	if !found {
		return nil, status.Error(codes.NotFound, "tax report model not found")
	}
	if len(object.Bytes) > maxTaxReportModelBytes {
		return nil, status.Error(codes.ResourceExhausted, "tax report model exceeds the response limit")
	}
	if err := validateTaxReportModelArtifact(subject, value, object); err != nil {
		log.Printf("tax report model integrity verification failed: report=%q err=%v", value.ID, err)
		return nil, status.Error(codes.DataLoss, "tax report model integrity verification failed")
	}
	return &enginev1.GetTaxReportModelResponse{
		ReportId:       value.ID,
		ArtifactDigest: value.ReportArtifactDigest,
		MediaType:      object.MediaType,
		CanonicalJson:  append([]byte(nil), object.Bytes...),
	}, nil
}

func validTaxReportID(value string) bool {
	const prefix = "tax-report:"
	if len(value) != len(prefix)+64 || !strings.HasPrefix(value, prefix) {
		return false
	}
	for _, character := range value[len(prefix):] {
		if (character < '0' || character > '9') &&
			(character < 'a' || character > 'f') {
			return false
		}
	}
	return true
}

type taxReportModelIdentity struct {
	SchemaVersion      string `json:"schemaVersion"`
	ReportID           string `json:"reportId"`
	InputDigest        string `json:"inputDigest"`
	SubjectID          string `json:"subjectId"`
	ResidentID         string `json:"residentId"`
	TaxYear            int    `json:"taxYear"`
	SchemaDigest       string `json:"schemaDigest"`
	EvidencePackDigest string `json:"evidencePackDigest"`
}

func validateTaxReportModelArtifact(
	subject string,
	report taxreportstore.StoredReport,
	object artifactstore.Object,
) error {
	if len(object.Bytes) == 0 {
		return errors.New("artifact bytes are empty")
	}
	if object.MediaType != taxReportModelMediaType {
		return fmt.Errorf("unexpected media type %q", object.MediaType)
	}
	if object.PrivacyClass != artifactstore.PrivacySubjectPrivate {
		return fmt.Errorf("unexpected privacy class %q", object.PrivacyClass)
	}
	if object.Ref.Algorithm != "sha256" || object.Ref.Digest != report.ReportArtifactDigest {
		return errors.New("artifact reference does not match the report digest")
	}
	actualDigest := fmt.Sprintf("%x", sha256.Sum256(object.Bytes))
	if actualDigest != report.ReportArtifactDigest {
		return errors.New("artifact bytes do not match the report digest")
	}
	var identity taxReportModelIdentity
	if err := json.Unmarshal(object.Bytes, &identity); err != nil {
		return fmt.Errorf("decode report model identity: %w", err)
	}
	if identity.SchemaVersion != taxReportModelSchemaV1 ||
		identity.ReportID != report.ID ||
		identity.InputDigest != report.InputDigest ||
		identity.SubjectID != subject ||
		identity.ResidentID != report.ResidentID ||
		identity.TaxYear != report.TaxYear ||
		identity.SchemaDigest != report.SchemaDigest ||
		identity.EvidencePackDigest != report.EvidencePackDigest {
		return errors.New("artifact model identity does not match the stored report")
	}
	return nil
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
