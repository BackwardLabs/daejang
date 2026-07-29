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
	lastSubject string
	lastCursor  *readmodelstore.OpenReviewCursor
	lastLimit   int32
}

type fakeTaxReportStore struct {
	current     taxreportstore.CurrentReportDetail
	found       bool
	err         error
	lastSubject string
	lastTaxYear int
}

func (f *fakeTaxReportStore) GetCurrentReportForYear(_ context.Context, subject string, taxYear int) (taxreportstore.CurrentReportDetail, bool, error) {
	f.lastSubject, f.lastTaxYear = subject, taxYear
	return f.current, f.found, f.err
}

func (f *fakeTaxReportStore) ListReportHistory(context.Context, string, int, int32) ([]taxreportstore.StoredReport, error) {
	return nil, f.err
}

func (f *fakeReadStore) Dashboard(context.Context, string, int32) (readmodelstore.Dashboard, error) {
	return readmodelstore.Dashboard{}, nil
}

func (f *fakeReadStore) ListLedgerEvents(context.Context, string, int32, int32) ([]readmodelstore.LedgerEvent, error) {
	return nil, nil
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
