package query

import (
	"context"
	"encoding/base64"
	"testing"
	"time"

	"github.com/BackwardLabs/daejang-db/pkg/readmodelstore"
	"github.com/BackwardLabs/daejang-db/pkg/taxreportstore"
	enginev1 "github.com/BackwardLabs/daejang/services/engine/gen/go/giwa/engine/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const queryTestSubjectID = "11111111-1111-4111-8111-111111111111"

type fakeReadStore struct {
	page        readmodelstore.OpenReviewPage
	dashboard   readmodelstore.Dashboard
	ledger      []readmodelstore.LedgerEvent
	lastSubject string
	lastCursor  *readmodelstore.OpenReviewCursor
	lastLimit   int32
}

type fakeObservationReadStore struct {
	count     int64
	events    []readmodelstore.LedgerEvent
	err       error
	lastLimit int32
}

func (f *fakeObservationReadStore) CountUnmaterialized(context.Context, string, int32) (int64, error) {
	return f.count, f.err
}
func (f *fakeObservationReadStore) ListUnmaterialized(_ context.Context, _ string, _ int32, limit int32) ([]readmodelstore.LedgerEvent, error) {
	f.lastLimit = limit
	return f.events, f.err
}

type fakeTaxReportStore struct {
	current     taxreportstore.CurrentReportDetail
	found       bool
	err         error
	lastSubject string
	lastTaxYear int
}

func TestObservationReadProjectionMergesBeforeApplyingLedgerLimit(t *testing.T) {
	at := time.Date(2026, 7, 29, 0, 0, 0, 0, time.UTC)
	reads := &fakeReadStore{ledger: []readmodelstore.LedgerEvent{{EventID: "materialized", EffectiveAt: at.Add(-time.Hour)}}}
	observations := &fakeObservationReadStore{events: []readmodelstore.LedgerEvent{{EventID: "observation", EffectiveAt: at}}}
	service := &Service{Reads: reads, Observations: observations}

	ledger, err := service.ListLedgerEvents(context.Background(), &enginev1.ListLedgerEventsRequest{Context: queryTestContext(), TaxYear: 2026, Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if observations.lastLimit != 1 || len(ledger.GetItems()) != 1 || ledger.GetItems()[0].GetEventId() != "observation" {
		t.Fatalf("ledger limit was applied before merge: limit=%d response=%#v", observations.lastLimit, ledger)
	}
}

func TestLedgerProjectionIncludesSafeTransferEndpointSummary(t *testing.T) {
	at := time.Date(2026, 7, 30, 0, 0, 0, 0, time.UTC)
	reads := &fakeReadStore{ledger: []readmodelstore.LedgerEvent{{
		EventID: "transfer", EventType: "TRANSFER", FlowShape: "SELF_TRANSFER", EffectiveAt: at,
		TransferEndpoint: &readmodelstore.TransferEndpoint{
			Resolution: "OWNED_REGISTERED", Kind: "WALLET_ADDRESS", Display: "0x123456…abcdef",
			AddressFamily: "EVM", WalletSourceID: "wallet-source-1",
			ChainCandidates: []string{"eip155:10"}, ConnectionStatus: "WALLET_OBSERVATION_PENDING",
			ReviewRequired: true,
		},
	}}}
	service := &Service{Reads: reads}

	ledger, err := service.ListLedgerEvents(context.Background(), &enginev1.ListLedgerEventsRequest{Context: queryTestContext(), TaxYear: 2026, Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	endpoint := ledger.GetItems()[0].GetTransferEndpoint()
	if endpoint.GetResolution() != "OWNED_REGISTERED" || endpoint.GetDisplay() != "0x123456…abcdef" ||
		endpoint.GetWalletSourceId() != "wallet-source-1" || !endpoint.GetReviewRequired() ||
		len(endpoint.GetChainCandidates()) != 1 || endpoint.GetChainCandidates()[0] != "eip155:10" {
		t.Fatalf("unsafe or incomplete transfer endpoint projection: %#v", endpoint)
	}
}

func (f *fakeTaxReportStore) GetCurrentReportForYear(_ context.Context, subject string, taxYear int) (taxreportstore.CurrentReportDetail, bool, error) {
	f.lastSubject, f.lastTaxYear = subject, taxYear
	return f.current, f.found, f.err
}

func (f *fakeTaxReportStore) ListReportHistory(context.Context, string, int, int32) ([]taxreportstore.StoredReport, error) {
	return nil, f.err
}

func (f *fakeReadStore) Dashboard(context.Context, string, int32) (readmodelstore.Dashboard, error) {
	return f.dashboard, nil
}

func (f *fakeReadStore) ListLedgerEvents(context.Context, string, int32, int32) ([]readmodelstore.LedgerEvent, error) {
	return f.ledger, nil
}

func TestObservationReadProjectionAugmentsDashboardAndLedgerWithoutReplacingMaterializedEvents(t *testing.T) {
	at := time.Date(2026, 7, 29, 0, 0, 0, 0, time.UTC)
	reads := &fakeReadStore{dashboard: readmodelstore.Dashboard{TransactionCount: 2}, ledger: []readmodelstore.LedgerEvent{{EventID: "materialized", EffectiveAt: at.Add(-time.Hour)}}}
	observations := &fakeObservationReadStore{count: 3, events: []readmodelstore.LedgerEvent{{EventID: "observation", Resolution: "PARTIAL", InterpretationSupport: "OBSERVATION_ONLY", EffectiveAt: at}}}
	service := &Service{Reads: reads, Observations: observations}
	dashboard, err := service.GetDashboard(context.Background(), &enginev1.GetDashboardRequest{Context: queryTestContext(), TaxYear: 2026})
	if err != nil || dashboard.GetDashboard().GetTransactionCount() != 5 {
		t.Fatalf("observation dashboard projection: response=%#v err=%v", dashboard, err)
	}
	ledger, err := service.ListLedgerEvents(context.Background(), &enginev1.ListLedgerEventsRequest{Context: queryTestContext(), TaxYear: 2026, Limit: 10})
	if err != nil || len(ledger.GetItems()) != 2 || ledger.GetItems()[0].GetEventId() != "observation" || ledger.GetItems()[1].GetEventId() != "materialized" {
		t.Fatalf("combined ledger projection: response=%#v err=%v", ledger, err)
	}
}

func (f *fakeReadStore) ListOpenReviewsPage(
	_ context.Context,
	subject string,
	cursor *readmodelstore.OpenReviewCursor,
	limit int32,
) (readmodelstore.OpenReviewPage, error) {
	f.lastSubject = subject
	f.lastCursor = cursor
	f.lastLimit = limit
	return f.page, nil
}

func queryTestContext() *enginev1.RequestContext {
	return &enginev1.RequestContext{
		RequestId: "request-1",
		Actor: &enginev1.ActorContext{
			UserId:    queryTestSubjectID,
			SessionId: "session-1",
		},
	}
}

func TestListReviewsReturnsAndConsumesOpaqueKeysetCursor(t *testing.T) {
	createdAt := time.Date(2027, 2, 3, 4, 5, 6, 789, time.UTC)
	reads := &fakeReadStore{page: readmodelstore.OpenReviewPage{
		Reviews: []readmodelstore.Review{{
			ID: "review-2", ExecutionID: "execution-2", RevisionID: "revision-2",
			PointerVersion: 3, Status: "OPEN", ReasonCodes: []string{"NEEDS_CONTEXT"},
			CreatedAt: createdAt,
		}},
		Next:    &readmodelstore.OpenReviewCursor{CreatedAt: createdAt, ReviewID: "review-2"},
		HasMore: true,
	}}
	service := &Service{Reads: reads}
	first, err := service.ListReviews(context.Background(), &enginev1.ListReviewsRequest{
		Context: queryTestContext(),
		Limit:   25,
	})
	if err != nil {
		t.Fatal(err)
	}
	if reads.lastSubject != queryTestSubjectID || reads.lastCursor != nil || reads.lastLimit != 25 {
		t.Fatalf("unexpected first page input: subject=%q cursor=%#v limit=%d", reads.lastSubject, reads.lastCursor, reads.lastLimit)
	}
	if len(first.GetItems()) != 1 || first.GetItems()[0].GetId() != "review-2" || first.GetNextPageToken() == "" {
		t.Fatalf("unexpected first page response: %#v", first)
	}

	reads.page = readmodelstore.OpenReviewPage{}
	second, err := service.ListReviews(context.Background(), &enginev1.ListReviewsRequest{
		Context:   queryTestContext(),
		Limit:     25,
		PageToken: first.GetNextPageToken(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if reads.lastCursor == nil ||
		reads.lastCursor.ReviewID != "review-2" ||
		!reads.lastCursor.CreatedAt.Equal(createdAt) {
		t.Fatalf("cursor did not round-trip: %#v", reads.lastCursor)
	}
	if second.GetNextPageToken() != "" {
		t.Fatalf("terminal page returned a cursor: %#v", second)
	}
}

func TestListReviewsRejectsInvalidPageInputBeforeDatabaseQuery(t *testing.T) {
	nulReviewIDToken := base64.RawURLEncoding.EncodeToString([]byte(
		`{"v":1,"createdAt":"2027-01-01T00:00:00Z","reviewId":"x\u0000y"}`,
	))
	zeroTimeToken := base64.RawURLEncoding.EncodeToString([]byte(
		`{"v":1,"createdAt":"0001-01-01T00:00:00Z","reviewId":"review-1"}`,
	))
	for name, request := range map[string]*enginev1.ListReviewsRequest{
		"invalid token": {
			Context: queryTestContext(), PageToken: "not-base64!",
		},
		"NUL review ID": {
			Context: queryTestContext(), PageToken: nulReviewIDToken,
		},
		"zero time": {
			Context: queryTestContext(), PageToken: zeroTimeToken,
		},
		"oversized limit": {
			Context: queryTestContext(), Limit: 201,
		},
	} {
		t.Run(name, func(t *testing.T) {
			reads := &fakeReadStore{}
			service := &Service{Reads: reads}
			_, err := service.ListReviews(context.Background(), request)
			if status.Code(err) != codes.InvalidArgument {
				t.Fatalf("status=%s, want INVALID_ARGUMENT: %v", status.Code(err), err)
			}
			if reads.lastSubject != "" {
				t.Fatalf("database was queried for invalid input: %#v", reads)
			}
		})
	}
}

func TestGetCurrentTaxReportScopesByActorAndPreservesUnknownAmount(t *testing.T) {
	issuedAt := time.Date(2028, 1, 10, 0, 0, 0, 0, time.UTC)
	store := &fakeTaxReportStore{found: true, current: taxreportstore.CurrentReportDetail{
		StoredReport: taxreportstore.StoredReport{SubjectID: queryTestSubjectID, Report: taxreportstore.Report{
			ID: "report-1", ResidentID: "resident-1", TaxYear: 2027, Finality: "PROVISIONAL",
			Status: "PARTIAL", FilingStatus: "BLOCKED", TaxInventoryRunID: "inventory-1",
			TaxEstimateID: "estimate-1", LotRunID: "lot-1", DenominationAssetID: "asset-krw",
			IssuedAt: issuedAt, GainLoss: taxreportstore.Amount{Status: "KNOWN", Amount: "0"},
			TotalTax: taxreportstore.Amount{Status: "UNKNOWN"},
		}}, PointerVersion: 2, UpdatedAt: issuedAt,
	}}
	service := &Service{TaxReports: store}
	response, err := service.GetCurrentTaxReport(context.Background(), &enginev1.GetCurrentTaxReportRequest{
		Context: queryTestContext(), TaxYear: 2027,
	})
	if err != nil {
		t.Fatal(err)
	}
	if store.lastSubject != queryTestSubjectID || store.lastTaxYear != 2027 {
		t.Fatalf("query was not actor scoped: subject=%q year=%d", store.lastSubject, store.lastTaxYear)
	}
	report := response.GetReport()
	if report.GetFinality() != "PROVISIONAL" || report.GetFilingStatus() != "BLOCKED" {
		t.Fatalf("report status was not preserved: %#v", report)
	}
	if report.GetTotalTax().GetHasAmount() || report.GetTotalTax().GetAmount() != "" {
		t.Fatalf("UNKNOWN tax amount was fabricated: %#v", report.GetTotalTax())
	}
	if !report.GetGainLoss().GetHasAmount() || report.GetGainLoss().GetAmount() != "0" {
		t.Fatalf("known zero was not preserved: %#v", report.GetGainLoss())
	}
}

func TestGetCurrentTaxReportDoesNotLeakCrossSubjectOrAmbiguousResidency(t *testing.T) {
	for name, store := range map[string]*fakeTaxReportStore{
		"missing":   {found: false},
		"ambiguous": {err: taxreportstore.ErrAmbiguousResident},
	} {
		t.Run(name, func(t *testing.T) {
			service := &Service{TaxReports: store}
			_, err := service.GetCurrentTaxReport(context.Background(), &enginev1.GetCurrentTaxReportRequest{
				Context: queryTestContext(), TaxYear: 2027,
			})
			want := codes.NotFound
			if name == "ambiguous" {
				want = codes.FailedPrecondition
			}
			if status.Code(err) != want {
				t.Fatalf("status=%s, want %s: %v", status.Code(err), want, err)
			}
			if store.lastSubject != queryTestSubjectID {
				t.Fatalf("query escaped actor subject: %#v", store)
			}
		})
	}
}

func TestLegacyReportCreationIsDisabledInsteadOfSynthesizingZeroKRW(t *testing.T) {
	service := &Service{}
	_, err := service.CreateReport(context.Background(), &enginev1.CreateReportRequest{
		Context: &enginev1.RequestContext{
			RequestId: "request-legacy", IdempotencyKey: "legacy-report",
			Actor: &enginev1.ActorContext{UserId: queryTestSubjectID, SessionId: "session-1"},
		},
		TaxYear: 2027,
	})
	if status.Code(err) != codes.FailedPrecondition || status.Convert(err).Message() != "LEGACY_REPORT_CREATION_DISABLED" {
		t.Fatalf("legacy report was not segregated: %v", err)
	}
}
