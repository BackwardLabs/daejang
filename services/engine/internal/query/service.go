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
	ListLedgerEventsPage(context.Context, string, int32, *readmodelstore.LedgerEventCursor, int32) (readmodelstore.LedgerEventPage, error)
	ListOpenReviewsPage(context.Context, string, *readmodelstore.OpenReviewCursor, int32) (readmodelstore.OpenReviewPage, error)
	GetReviewEvidence(context.Context, string, string) ([]readmodelstore.ReviewEvidence, error)
}
type LotStore interface {
	EventLineage(context.Context, string, string, string, int32) (lotread.Lineage, error)
}
type ReportStore interface {
	List(context.Context, string, int32, int32) ([]reportstore.Snapshot, error)
}
type ObservationReadStore interface {
	CountUnmaterialized(context.Context, string, int32) (int64, error)
	ListUnmaterializedPage(context.Context, string, int32, *readmodelstore.LedgerEventCursor, int32) (readmodelstore.LedgerEventPage, error)
}
type TaxReportStore interface {
	GetCurrentReportForYear(context.Context, string, int) (taxreportstore.CurrentReportDetail, bool, error)
	GetCurrentReportV2ForSubject(context.Context, string, int, string) (taxreportstore.CurrentReportDetailV2, bool, error)
	ListReportHistory(context.Context, string, int, int32) ([]taxreportstore.StoredReport, error)
	ListActivatedReportHistoryV2(context.Context, string, int, string, int32) ([]taxreportstore.ActivatedReportDetailV2, error)
	GetReport(context.Context, string, string) (taxreportstore.StoredReport, bool, error)
	GetActivatedReportV2(context.Context, string, string) (taxreportstore.ActivatedReportDetailV2, bool, error)
}

func (s *Service) getActivatedTaxReport(ctx context.Context, subject, reportID string) (taxreportstore.StoredReport, bool, error) {
	if strings.HasPrefix(reportID, "tax-report-v2:") {
		value, found, err := s.TaxReports.GetActivatedReportV2(ctx, subject, reportID)
		return value.StoredReport, found, err
	}
	return s.TaxReports.GetReport(ctx, subject, reportID)
}

func (s *Service) getCurrentTaxReport(ctx context.Context, subject string, taxYear int) (taxreportstore.CurrentReportDetail, bool, error) {
	v2Candidates := make([]taxreportstore.CurrentReportDetail, 0, 2)
	for _, finality := range []string{"FINAL", "PROVISIONAL"} {
		value, found, err := s.TaxReports.GetCurrentReportV2ForSubject(ctx, subject, taxYear, finality)
		if err != nil {
			return taxreportstore.CurrentReportDetail{}, false, err
		}
		if found {
			v2Candidates = append(v2Candidates, taxreportstore.CurrentReportDetail{
				StoredReport: value.StoredReport, PointerVersion: value.PointerVersion, UpdatedAt: value.UpdatedAt,
			})
		}
	}
	if len(v2Candidates) > 0 {
		sort.Slice(v2Candidates, func(i, j int) bool {
			if !v2Candidates[i].UpdatedAt.Equal(v2Candidates[j].UpdatedAt) {
				return v2Candidates[i].UpdatedAt.After(v2Candidates[j].UpdatedAt)
			}
			if !v2Candidates[i].IssuedAt.Equal(v2Candidates[j].IssuedAt) {
				return v2Candidates[i].IssuedAt.After(v2Candidates[j].IssuedAt)
			}
			return v2Candidates[i].Finality == "FINAL" && v2Candidates[j].Finality != "FINAL"
		})
		return v2Candidates[0], true, nil
	}
	return s.TaxReports.GetCurrentReportForYear(ctx, subject, taxYear)
}

func (s *Service) listTaxReportHistory(ctx context.Context, subject string, taxYear int, limit int32) ([]taxreportstore.StoredReport, error) {
	legacy, err := s.TaxReports.ListReportHistory(ctx, subject, taxYear, limit)
	if err != nil {
		return nil, err
	}
	byID := make(map[string]taxreportstore.StoredReport, len(legacy))
	for _, value := range legacy {
		byID[value.ID] = value
	}
	for _, finality := range []string{"FINAL", "PROVISIONAL"} {
		values, err := s.TaxReports.ListActivatedReportHistoryV2(ctx, subject, taxYear, finality, limit)
		if err != nil {
			return nil, err
		}
		for _, value := range values {
			byID[value.ID] = value.StoredReport
		}
	}
	result := make([]taxreportstore.StoredReport, 0, len(byID))
	for _, value := range byID {
		result = append(result, value)
	}
	sort.Slice(result, func(i, j int) bool {
		return result[i].IssuedAt.After(result[j].IssuedAt) || result[i].IssuedAt.Equal(result[j].IssuedAt) && result[i].ID > result[j].ID
	})
	if len(result) > int(limit) {
		result = result[:limit]
	}
	return result, nil
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
	taxReportModelMediaTypeV1  = "application/vnd.giwa.tax-report-model.v1+json"
	taxReportModelMediaTypeV2  = "application/vnd.giwa.tax-report-model.v2+json"
	taxReportModelSchemaV1     = "giwa.tax-report-model.v1"
	taxReportModelSchemaV2     = "giwa.tax-report-model.v2"
	taxEvidencePackMediaTypeV1 = "application/vnd.giwa.tax-evidence-pack.v1+json"
	taxEvidencePackMediaTypeV2 = "application/vnd.giwa.tax-evidence-pack.v2+json"
	taxEvidencePackSchemaV1    = "giwa.tax-evidence-pack.v1"
	taxEvidencePackSchemaV2    = "giwa.tax-evidence-pack.v2"
	maxTaxReportArtifactBytes  = 16 << 20
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
	if limit < 1 || limit > 200 {
		return nil, status.Error(codes.InvalidArgument, "ledger page limit must be between 1 and 200")
	}
	state, err := decodeLedgerPageToken(req.GetPageToken(), subject, req.GetTaxYear())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "ledger page token is invalid")
	}
	canonicalPage := readmodelstore.LedgerEventPage{}
	if !state.Canonical.Exhausted {
		canonicalPage, err = s.Reads.ListLedgerEventsPage(ctx, subject, req.GetTaxYear(), state.Canonical.Cursor, limit)
	}
	if err != nil {
		return nil, status.Error(codes.Internal, "ledger query failed")
	}
	observationPage := readmodelstore.LedgerEventPage{}
	if s.Observations != nil {
		if !state.Observation.Exhausted {
			observationPage, err = s.Observations.ListUnmaterializedPage(ctx, subject, req.GetTaxYear(), state.Observation.Cursor, limit)
			if err != nil {
				log.Printf("observation ledger projection failed: %v", err)
				return nil, status.Error(codes.Internal, "observation ledger query failed")
			}
		}
	} else {
		state.Observation.Exhausted = true
	}
	values, nextState := mergeLedgerPages(state, canonicalPage, observationPage, int(limit))
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
			ReviewState:           v.ReviewState,
			ReviewResolutionCode:  v.ReviewResolutionCode,
			ReviewResolutionLabel: v.ReviewResolutionLabel,
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
			posting := &enginev1.LedgerPosting{
				LegId:          p.LegID,
				AccountId:      p.AccountID,
				AssetId:        p.AssetID,
				OccurredAt:     timestamppb.New(p.OccurredAt),
				Direction:      p.Direction,
				Quantity:       p.Quantity,
				Role:           p.Role,
				FairValue:      p.FairValue,
				CostBasis:      p.CostBasis,
				Denomination:   p.Denomination,
				AssetSymbol:    p.AssetSymbol,
				AssetVenue:     p.AssetVenue,
				AccountKind:    p.AccountKind,
				AccountLocator: p.AccountLocator,
				AccountLabel:   p.AccountLabel,
				AccountChainId: p.AccountChainID,
				AccountVenue:   p.AccountVenue,
			}
			if p.AssetDecimals != nil {
				posting.AssetDecimals = uint32(*p.AssetDecimals)
				posting.HasAssetDecimals = true
			}
			event.Postings = append(event.Postings, posting)
		}
		items = append(items, event)
	}
	nextPageToken := ""
	if !nextState.Canonical.Exhausted || !nextState.Observation.Exhausted {
		nextPageToken, err = encodeLedgerPageToken(nextState, subject, req.GetTaxYear())
		if err != nil {
			return nil, status.Error(codes.Internal, "ledger page token encoding failed")
		}
	}
	return &enginev1.ListLedgerEventsResponse{Items: items, NextPageToken: nextPageToken}, nil
}

type ledgerStreamState struct {
	Cursor    *readmodelstore.LedgerEventCursor
	Exhausted bool
}

type ledgerMergeState struct {
	Canonical   ledgerStreamState
	Observation ledgerStreamState
}

type ledgerCandidate struct {
	event     readmodelstore.LedgerEvent
	canonical bool
}

func mergeLedgerPages(
	state ledgerMergeState,
	canonicalPage readmodelstore.LedgerEventPage,
	observationPage readmodelstore.LedgerEventPage,
	limit int,
) ([]readmodelstore.LedgerEvent, ledgerMergeState) {
	candidates := make([]ledgerCandidate, 0, len(canonicalPage.Events)+len(observationPage.Events))
	for _, event := range canonicalPage.Events {
		candidates = append(candidates, ledgerCandidate{event: event, canonical: true})
	}
	for _, event := range observationPage.Events {
		candidates = append(candidates, ledgerCandidate{event: event})
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		left, right := candidates[i], candidates[j]
		if !left.event.EffectiveAt.Equal(right.event.EffectiveAt) {
			return left.event.EffectiveAt.After(right.event.EffectiveAt)
		}
		if left.canonical != right.canonical {
			return left.canonical
		}
		return false
	})
	if len(candidates) > limit {
		candidates = candidates[:limit]
	}

	result := make([]readmodelstore.LedgerEvent, 0, len(candidates))
	canonicalConsumed, observationConsumed := 0, 0
	for _, candidate := range candidates {
		result = append(result, candidate.event)
		cursor := &readmodelstore.LedgerEventCursor{
			EffectiveAt: candidate.event.EffectiveAt,
			OrderKey:    candidate.event.PageOrderKey,
		}
		if cursor.OrderKey == "" {
			cursor.OrderKey = candidate.event.EventID
		}
		if candidate.canonical {
			state.Canonical.Cursor = cursor
			canonicalConsumed++
		} else {
			state.Observation.Cursor = cursor
			observationConsumed++
		}
	}
	if !state.Canonical.Exhausted {
		state.Canonical.Exhausted = canonicalConsumed == len(canonicalPage.Events) && !canonicalPage.HasMore
	}
	if !state.Observation.Exhausted {
		state.Observation.Exhausted = observationConsumed == len(observationPage.Events) && !observationPage.HasMore
	}
	return result, state
}

type ledgerCursorToken struct {
	EffectiveAt string `json:"effectiveAt,omitempty"`
	OrderKey    string `json:"orderKey,omitempty"`
	Exhausted   bool   `json:"exhausted,omitempty"`
}

type ledgerPageToken struct {
	Version     int               `json:"v"`
	Scope       string            `json:"scope"`
	TaxYear     int32             `json:"taxYear"`
	Canonical   ledgerCursorToken `json:"canonical"`
	Observation ledgerCursorToken `json:"observation"`
}

func encodeLedgerPageToken(state ledgerMergeState, subject string, taxYear int32) (string, error) {
	canonical, err := encodeLedgerCursorToken(state.Canonical)
	if err != nil {
		return "", err
	}
	observation, err := encodeLedgerCursorToken(state.Observation)
	if err != nil {
		return "", err
	}
	value, err := json.Marshal(ledgerPageToken{
		Version: 1, Scope: ledgerPageScope(subject), TaxYear: taxYear,
		Canonical: canonical, Observation: observation,
	})
	if err != nil {
		return "", fmt.Errorf("marshal ledger page cursor: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

func encodeLedgerCursorToken(state ledgerStreamState) (ledgerCursorToken, error) {
	result := ledgerCursorToken{Exhausted: state.Exhausted}
	if state.Cursor == nil {
		return result, nil
	}
	if state.Cursor.EffectiveAt.IsZero() || !validLedgerOrderKey(state.Cursor.OrderKey) {
		return ledgerCursorToken{}, fmt.Errorf("ledger stream cursor is incomplete")
	}
	result.EffectiveAt = state.Cursor.EffectiveAt.UTC().Format(time.RFC3339Nano)
	result.OrderKey = state.Cursor.OrderKey
	return result, nil
}

func decodeLedgerPageToken(token, subject string, taxYear int32) (ledgerMergeState, error) {
	if token == "" {
		return ledgerMergeState{}, nil
	}
	if strings.TrimSpace(token) != token || len(token) > 4096 {
		return ledgerMergeState{}, fmt.Errorf("ledger page token has an invalid shape")
	}
	value, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil {
		return ledgerMergeState{}, fmt.Errorf("decode ledger page token: %w", err)
	}
	var parsed ledgerPageToken
	decoder := json.NewDecoder(bytes.NewReader(value))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&parsed); err != nil {
		return ledgerMergeState{}, fmt.Errorf("unmarshal ledger page token: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return ledgerMergeState{}, fmt.Errorf("ledger page token contains trailing data")
	}
	if parsed.Version != 1 {
		return ledgerMergeState{}, fmt.Errorf("ledger page token version is unsupported")
	}
	if parsed.Scope != ledgerPageScope(subject) || parsed.TaxYear != taxYear {
		return ledgerMergeState{}, fmt.Errorf("ledger page token scope does not match the request")
	}
	canonical, err := decodeLedgerCursorToken(parsed.Canonical)
	if err != nil {
		return ledgerMergeState{}, err
	}
	observation, err := decodeLedgerCursorToken(parsed.Observation)
	if err != nil {
		return ledgerMergeState{}, err
	}
	return ledgerMergeState{Canonical: canonical, Observation: observation}, nil
}

func ledgerPageScope(subject string) string {
	digest := sha256.Sum256([]byte(subject))
	return base64.RawURLEncoding.EncodeToString(digest[:16])
}

func decodeLedgerCursorToken(token ledgerCursorToken) (ledgerStreamState, error) {
	result := ledgerStreamState{Exhausted: token.Exhausted}
	if token.EffectiveAt == "" && token.OrderKey == "" {
		return result, nil
	}
	if token.EffectiveAt == "" || !validLedgerOrderKey(token.OrderKey) {
		return ledgerStreamState{}, fmt.Errorf("ledger stream cursor is incomplete")
	}
	effectiveAt, err := time.Parse(time.RFC3339Nano, token.EffectiveAt)
	if err != nil || effectiveAt.IsZero() {
		return ledgerStreamState{}, fmt.Errorf("ledger stream cursor time is invalid")
	}
	result.Cursor = &readmodelstore.LedgerEventCursor{EffectiveAt: effectiveAt.UTC(), OrderKey: token.OrderKey}
	return result, nil
}

func validLedgerOrderKey(value string) bool {
	if strings.TrimSpace(value) == "" || value != strings.TrimSpace(value) ||
		!utf8.ValidString(value) || len(utf16.Encode([]rune(value))) > 1024 {
		return false
	}
	return strings.IndexFunc(value, func(r rune) bool {
		return r < 0x20 || r == 0x7f
	}) == -1
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
	if req.GetTaxYear() < 2009 || req.GetTaxYear() > 9999 {
		return nil, status.Error(codes.InvalidArgument, "review tax year must be between 2009 and 9999")
	}
	cursor, err := decodeReviewPageToken(req.GetPageToken())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "review page token is invalid")
	}
	page, err := s.listOpenReviewsForTaxYear(ctx, subject, req.GetTaxYear(), cursor, limit)
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

// listOpenReviewsForTaxYear keeps the public review list consistent with the
// year-scoped dashboard. The database review queue is globally ordered, so the
// service scans it in bounded keyset pages and only exposes reviews whose
// referenced observations occurred in the requested tax year.
func (s *Service) listOpenReviewsForTaxYear(
	ctx context.Context,
	subject string,
	taxYear int32,
	cursor *readmodelstore.OpenReviewCursor,
	limit int32,
) (readmodelstore.OpenReviewPage, error) {
	result := readmodelstore.OpenReviewPage{Reviews: make([]readmodelstore.Review, 0, limit)}
	nextCursor := cursor
	seenCursors := make(map[string]struct{})

	for {
		page, err := s.Reads.ListOpenReviewsPage(ctx, subject, nextCursor, 200)
		if err != nil {
			return readmodelstore.OpenReviewPage{}, err
		}
		for index, review := range page.Reviews {
			evidence, evidenceErr := s.Reads.GetReviewEvidence(ctx, subject, review.ID)
			if evidenceErr != nil {
				return readmodelstore.OpenReviewPage{}, evidenceErr
			}
			matchesYear := false
			for _, observation := range evidence {
				if observation.OccurredAt != nil && int32(observation.OccurredAt.UTC().Year()) == taxYear {
					matchesYear = true
					break
				}
			}
			if !matchesYear {
				continue
			}
			result.Reviews = append(result.Reviews, review)
			if int32(len(result.Reviews)) == limit {
				if index+1 < len(page.Reviews) || page.HasMore {
					result.HasMore = true
					result.Next = &readmodelstore.OpenReviewCursor{CreatedAt: review.CreatedAt, ReviewID: review.ID}
				}
				return result, nil
			}
		}

		if !page.HasMore {
			return result, nil
		}
		if page.Next == nil {
			return readmodelstore.OpenReviewPage{}, errors.New("review query returned an incomplete page cursor")
		}
		cursorKey := page.Next.CreatedAt.UTC().Format(time.RFC3339Nano) + "\x00" + page.Next.ReviewID
		if _, exists := seenCursors[cursorKey]; exists {
			return readmodelstore.OpenReviewPage{}, errors.New("review query returned a repeated page cursor")
		}
		seenCursors[cursorKey] = struct{}{}
		nextCursor = page.Next
	}
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
	value, found, err := s.getCurrentTaxReport(ctx, subject, int(req.GetTaxYear()))
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
	values, err := s.listTaxReportHistory(ctx, subject, int(req.GetTaxYear()), limit)
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
	value, found, err := s.getActivatedTaxReport(ctx, subject, req.GetReportId())
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
	if len(object.Bytes) > maxTaxReportArtifactBytes {
		return nil, status.Error(codes.ResourceExhausted, "tax report model exceeds the response limit")
	}
	if _, err := validateTaxReportModelArtifact(subject, value, object); err != nil {
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

func (s *Service) GetTaxEvidencePack(ctx context.Context, req *enginev1.GetTaxEvidencePackRequest) (*enginev1.GetTaxEvidencePackResponse, error) {
	subject, err := source.ValidateRequestContext(req.GetContext(), false)
	if err != nil {
		return nil, err
	}
	if !validTaxReportID(req.GetReportId()) {
		return nil, status.Error(codes.InvalidArgument, "tax report ID is invalid")
	}
	if s.TaxReports == nil || s.TaxReportArtifacts == nil {
		return nil, status.Error(codes.Unavailable, "tax evidence pack query is unavailable")
	}
	value, found, err := s.getActivatedTaxReport(ctx, subject, req.GetReportId())
	if err != nil {
		return nil, status.Error(codes.Internal, "tax report query failed")
	}
	if !found {
		return nil, status.Error(codes.NotFound, "tax evidence pack not found")
	}
	if value.SubjectID != subject || value.ID != req.GetReportId() {
		log.Printf("tax evidence pack row identity verification failed: report=%q", req.GetReportId())
		return nil, status.Error(codes.DataLoss, "tax evidence pack integrity verification failed")
	}
	object, found, err := s.TaxReportArtifacts.GetTaxReportArtifact(
		ctx,
		subject,
		value.ID,
		value.EvidencePackDigest,
	)
	if err != nil {
		return nil, status.Error(codes.Internal, "tax evidence pack query failed")
	}
	if !found {
		return nil, status.Error(codes.NotFound, "tax evidence pack not found")
	}
	if len(object.Bytes) > maxTaxReportArtifactBytes {
		return nil, status.Error(codes.ResourceExhausted, "tax evidence pack exceeds the response limit")
	}
	evidenceIdentity, err := validateTaxEvidencePackArtifact(subject, value, object)
	if err != nil {
		log.Printf("tax evidence pack integrity verification failed: report=%q err=%v", value.ID, err)
		return nil, status.Error(codes.DataLoss, "tax evidence pack integrity verification failed")
	}
	reportObject, found, err := s.TaxReportArtifacts.GetTaxReportArtifact(
		ctx,
		subject,
		value.ID,
		value.ReportArtifactDigest,
	)
	if err != nil {
		return nil, status.Error(codes.Internal, "tax report model query failed while validating evidence pack")
	}
	if !found {
		log.Printf("tax evidence pack report model is missing: report=%q", value.ID)
		return nil, status.Error(codes.DataLoss, "tax evidence pack integrity verification failed")
	}
	if len(reportObject.Bytes) > maxTaxReportArtifactBytes {
		return nil, status.Error(codes.ResourceExhausted, "tax report model exceeds the response limit")
	}
	reportIdentity, err := validateTaxReportModelArtifact(subject, value, reportObject)
	if err != nil {
		log.Printf("tax evidence pack report model integrity verification failed: report=%q err=%v", value.ID, err)
		return nil, status.Error(codes.DataLoss, "tax evidence pack integrity verification failed")
	}
	contract, _ := taxReportArtifactContractForID(value.ID)
	if !sameTaxArtifactLedgerGeneration(contract, evidenceIdentity, reportIdentity) {
		log.Printf("tax evidence pack generation verification failed: report=%q", value.ID)
		return nil, status.Error(codes.DataLoss, "tax evidence pack integrity verification failed")
	}
	return &enginev1.GetTaxEvidencePackResponse{
		ReportId:       value.ID,
		ArtifactDigest: value.EvidencePackDigest,
		MediaType:      object.MediaType,
		CanonicalJson:  append([]byte(nil), object.Bytes...),
	}, nil
}

func sameTaxArtifactLedgerGeneration(contract taxReportArtifactContract, evidence taxEvidencePackIdentity, report taxReportModelIdentity) bool {
	if contract.reportSchema == taxReportModelSchemaV2 {
		return evidence.SourceLedgerGenerationID != "" && evidence.SourceLedgerGenerationID == report.SourceLedgerGenerationID
	}
	return evidence.GenerationID != "" && evidence.GenerationID == report.GenerationID
}

func validTaxReportID(value string) bool {
	_, valid := taxReportArtifactContractForID(value)
	return valid
}

type taxReportArtifactContract struct {
	reportIDPrefix    string
	reportSchema      string
	reportMediaType   string
	evidenceIDPrefix  string
	evidenceSchema    string
	evidenceMediaType string
}

func taxReportArtifactContractForID(value string) (taxReportArtifactContract, bool) {
	contracts := []taxReportArtifactContract{
		{
			reportIDPrefix: "tax-report-v2:", reportSchema: taxReportModelSchemaV2,
			reportMediaType: taxReportModelMediaTypeV2, evidenceIDPrefix: "tax-evidence-pack-v2",
			evidenceSchema: taxEvidencePackSchemaV2, evidenceMediaType: taxEvidencePackMediaTypeV2,
		},
		{
			reportIDPrefix: "tax-report:", reportSchema: taxReportModelSchemaV1,
			reportMediaType: taxReportModelMediaTypeV1, evidenceIDPrefix: "tax-evidence-pack",
			evidenceSchema: taxEvidencePackSchemaV1, evidenceMediaType: taxEvidencePackMediaTypeV1,
		},
	}
	for _, contract := range contracts {
		if len(value) != len(contract.reportIDPrefix)+64 || !strings.HasPrefix(value, contract.reportIDPrefix) {
			continue
		}
		for _, character := range value[len(contract.reportIDPrefix):] {
			if (character < '0' || character > '9') &&
				(character < 'a' || character > 'f') {
				return taxReportArtifactContract{}, false
			}
		}
		return contract, true
	}
	return taxReportArtifactContract{}, false
}

type taxReportModelIdentity struct {
	SchemaVersion            string                      `json:"schemaVersion"`
	ReportID                 string                      `json:"reportId"`
	InputDigest              string                      `json:"inputDigest"`
	SubjectID                string                      `json:"subjectId"`
	ResidentID               string                      `json:"residentId"`
	TaxYear                  int                         `json:"taxYear"`
	TaxInventoryRunID        string                      `json:"taxInventoryRunId"`
	TaxEstimateID            string                      `json:"taxEstimateId"`
	LotRunID                 string                      `json:"lotRunId"`
	GenerationID             string                      `json:"generationId"`
	SourceLedgerGenerationID string                      `json:"sourceLedgerGenerationId"`
	SchemaDigest             string                      `json:"schemaDigest"`
	DenominationAssetID      string                      `json:"denominationAssetId"`
	EvidencePackDigest       string                      `json:"evidencePackDigest"`
	Policy                   taxArtifactProducerIdentity `json:"policy"`
	Engine                   taxArtifactProducerIdentity `json:"engine"`
	IssuedAt                 time.Time                   `json:"issuedAt"`
}

type taxEvidencePackIdentity struct {
	SchemaVersion            string                      `json:"schemaVersion"`
	ManifestID               string                      `json:"manifestId"`
	ReportID                 string                      `json:"reportId"`
	SubjectID                string                      `json:"subjectId"`
	ResidentID               string                      `json:"residentId"`
	TaxYear                  int                         `json:"taxYear"`
	TaxInventoryRunID        string                      `json:"taxInventoryRunId"`
	TaxEstimateID            string                      `json:"taxEstimateId"`
	LotRunID                 string                      `json:"lotRunId"`
	GenerationID             string                      `json:"generationId"`
	SourceLedgerGenerationID string                      `json:"sourceLedgerGenerationId"`
	SchemaDigest             string                      `json:"schemaDigest"`
	Policy                   taxArtifactProducerIdentity `json:"policy"`
	Engine                   taxArtifactProducerIdentity `json:"engine"`
	IssuedAt                 time.Time                   `json:"issuedAt"`
}

type taxArtifactProducerIdentity struct {
	Name           string `json:"name"`
	Version        string `json:"version"`
	ArtifactDigest string `json:"artifactDigest"`
}

func expectedTaxEvidencePackManifestID(report taxreportstore.StoredReport) string {
	contract, valid := taxReportArtifactContractForID(report.ID)
	if !valid {
		return ""
	}
	digest := sha256.Sum256([]byte(report.ID + "\x00" + report.InputDigest))
	return contract.evidenceIDPrefix + ":" + fmt.Sprintf("%x", digest)
}

func sameTaxReportIssuedAt(artifactTime, storedTime time.Time) bool {
	// PostgreSQL timestamptz and pgx preserve microseconds, while a canonical
	// JSON artifact may carry Go's full nanosecond precision. Compare at the
	// durable store's precision so a legitimate DB round-trip is not rejected.
	return artifactTime.UTC().Truncate(time.Microsecond).Equal(
		storedTime.UTC().Truncate(time.Microsecond),
	)
}

func validTaxArtifactLedgerGeneration(contract taxReportArtifactContract, generationID, sourceLedgerGenerationID string) bool {
	if contract.reportSchema == taxReportModelSchemaV2 {
		return generationID == "" && sourceLedgerGenerationID != ""
	}
	return generationID != "" && sourceLedgerGenerationID == ""
}

func validateTaxReportModelArtifact(
	subject string,
	report taxreportstore.StoredReport,
	object artifactstore.Object,
) (taxReportModelIdentity, error) {
	contract, valid := taxReportArtifactContractForID(report.ID)
	if !valid {
		return taxReportModelIdentity{}, errors.New("stored report ID is invalid")
	}
	if len(object.Bytes) == 0 {
		return taxReportModelIdentity{}, errors.New("artifact bytes are empty")
	}
	if object.MediaType != contract.reportMediaType {
		return taxReportModelIdentity{}, fmt.Errorf("unexpected media type %q", object.MediaType)
	}
	if object.PrivacyClass != artifactstore.PrivacySubjectPrivate {
		return taxReportModelIdentity{}, fmt.Errorf("unexpected privacy class %q", object.PrivacyClass)
	}
	if object.Ref.Algorithm != "sha256" || object.Ref.Digest != report.ReportArtifactDigest {
		return taxReportModelIdentity{}, errors.New("artifact reference does not match the report digest")
	}
	actualDigest := fmt.Sprintf("%x", sha256.Sum256(object.Bytes))
	if actualDigest != report.ReportArtifactDigest {
		return taxReportModelIdentity{}, errors.New("artifact bytes do not match the report digest")
	}
	var identity taxReportModelIdentity
	if err := json.Unmarshal(object.Bytes, &identity); err != nil {
		return taxReportModelIdentity{}, fmt.Errorf("decode report model identity: %w", err)
	}
	if identity.SchemaVersion != contract.reportSchema ||
		identity.ReportID != report.ID ||
		identity.InputDigest != report.InputDigest ||
		identity.SubjectID != subject ||
		identity.ResidentID != report.ResidentID ||
		identity.TaxYear != report.TaxYear ||
		identity.TaxInventoryRunID != report.TaxInventoryRunID ||
		identity.TaxEstimateID != report.TaxEstimateID ||
		identity.LotRunID != report.LotRunID ||
		!validTaxArtifactLedgerGeneration(contract, identity.GenerationID, identity.SourceLedgerGenerationID) ||
		identity.SchemaDigest != report.SchemaDigest ||
		identity.DenominationAssetID != report.DenominationAssetID ||
		identity.EvidencePackDigest != report.EvidencePackDigest ||
		identity.Policy.Name != report.Policy.Name ||
		identity.Policy.Version != report.Policy.Version ||
		identity.Policy.ArtifactDigest != report.Policy.ArtifactDigest ||
		identity.Engine.Name != report.Engine.Name ||
		identity.Engine.Version != report.Engine.Version ||
		identity.Engine.ArtifactDigest != report.Engine.ArtifactDigest ||
		!sameTaxReportIssuedAt(identity.IssuedAt, report.IssuedAt) {
		return taxReportModelIdentity{}, errors.New("artifact model identity does not match the stored report")
	}
	return identity, nil
}

func validateTaxEvidencePackArtifact(
	subject string,
	report taxreportstore.StoredReport,
	object artifactstore.Object,
) (taxEvidencePackIdentity, error) {
	contract, valid := taxReportArtifactContractForID(report.ID)
	if !valid {
		return taxEvidencePackIdentity{}, errors.New("stored report ID is invalid")
	}
	if len(object.Bytes) == 0 {
		return taxEvidencePackIdentity{}, errors.New("artifact bytes are empty")
	}
	if object.MediaType != contract.evidenceMediaType {
		return taxEvidencePackIdentity{}, fmt.Errorf("unexpected media type %q", object.MediaType)
	}
	if object.PrivacyClass != artifactstore.PrivacySubjectPrivate {
		return taxEvidencePackIdentity{}, fmt.Errorf("unexpected privacy class %q", object.PrivacyClass)
	}
	if object.Ref.Algorithm != "sha256" || object.Ref.Digest != report.EvidencePackDigest {
		return taxEvidencePackIdentity{}, errors.New("artifact reference does not match the evidence pack digest")
	}
	actualDigest := fmt.Sprintf("%x", sha256.Sum256(object.Bytes))
	if actualDigest != report.EvidencePackDigest {
		return taxEvidencePackIdentity{}, errors.New("artifact bytes do not match the evidence pack digest")
	}
	var identity taxEvidencePackIdentity
	if err := json.Unmarshal(object.Bytes, &identity); err != nil {
		return taxEvidencePackIdentity{}, fmt.Errorf("decode evidence pack identity: %w", err)
	}
	if identity.SchemaVersion != contract.evidenceSchema ||
		identity.ManifestID != expectedTaxEvidencePackManifestID(report) ||
		identity.ReportID != report.ID ||
		identity.SubjectID != subject ||
		identity.ResidentID != report.ResidentID ||
		identity.TaxYear != report.TaxYear ||
		identity.TaxInventoryRunID != report.TaxInventoryRunID ||
		identity.TaxEstimateID != report.TaxEstimateID ||
		identity.LotRunID != report.LotRunID ||
		!validTaxArtifactLedgerGeneration(contract, identity.GenerationID, identity.SourceLedgerGenerationID) ||
		identity.SchemaDigest != report.SchemaDigest ||
		identity.Policy.Name != report.Policy.Name ||
		identity.Policy.Version != report.Policy.Version ||
		identity.Policy.ArtifactDigest != report.Policy.ArtifactDigest ||
		identity.Engine.Name != report.Engine.Name ||
		identity.Engine.Version != report.Engine.Version ||
		identity.Engine.ArtifactDigest != report.Engine.ArtifactDigest ||
		!sameTaxReportIssuedAt(identity.IssuedAt, report.IssuedAt) {
		return taxEvidencePackIdentity{}, errors.New("artifact evidence pack identity does not match the stored report")
	}
	return identity, nil
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
