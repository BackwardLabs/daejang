package query

import (
	"context"
	"os"
	"testing"

	"github.com/BackwardLabs/daejang-db/pkg/readmodelstore"
	"github.com/BackwardLabs/daejang-db/pkg/reportstore"
	enginev1 "github.com/BackwardLabs/daejang/services/engine/gen/go/giwa/engine/v1"
	"github.com/BackwardLabs/daejang/services/engine/internal/observationread"
)

func TestExternalUpbitObservationsReachLedgerAndReportAPIs(t *testing.T) {
	databaseURL := os.Getenv("DAEJANG_QUERY_EXTERNAL_DATABASE_URL")
	subjectID := os.Getenv("DAEJANG_QUERY_EXTERNAL_SUBJECT_ID")
	if databaseURL == "" || subjectID == "" {
		t.Skip("external query integration test is not configured")
	}
	ctx := context.Background()
	reads, err := readmodelstore.Open(ctx, readmodelstore.Options{DatabaseURL: databaseURL, ApplicationName: "daejang-query-external-reads"})
	if err != nil {
		t.Fatal(err)
	}
	defer reads.Close()
	reports, err := reportstore.Open(ctx, reportstore.Options{DatabaseURL: databaseURL, ApplicationName: "daejang-query-external-reports"})
	if err != nil {
		t.Fatal(err)
	}
	defer reports.Close()
	observations, err := observationread.Open(ctx, databaseURL, "daejang-query-external-observations")
	if err != nil {
		t.Fatal(err)
	}
	defer observations.Close()
	service := &Service{Reads: reads.Store, Reports: reports.Store, Observations: observations.Store}
	requestContext := &enginev1.RequestContext{RequestId: "external-upbit-proof", Actor: &enginev1.ActorContext{UserId: subjectID, SessionId: "external-upbit-proof"}}

	for _, expected := range []struct {
		year                 int32
		ledger, transactions int
		complete, exception  int64
	}{
		{year: 2025, ledger: 78, transactions: 78, complete: 78, exception: 0},
		{year: 2026, ledger: 1, transactions: 2, complete: 1, exception: 1},
	} {
		ledger, err := service.ListLedgerEvents(ctx, &enginev1.ListLedgerEventsRequest{Context: requestContext, TaxYear: expected.year, Limit: 200})
		if err != nil {
			t.Fatalf("list %d ledger events: %v", expected.year, err)
		}
		if len(ledger.GetItems()) != expected.ledger {
			t.Fatalf("%d ledger event count=%d want=%d", expected.year, len(ledger.GetItems()), expected.ledger)
		}
		for _, event := range ledger.GetItems() {
			if event.GetResolution() != "PARTIAL" || event.GetInterpretationSupport() != "OBSERVATION_ONLY" || len(event.GetPostings()) == 0 {
				t.Fatalf("%d unsafe observation ledger projection: %#v", expected.year, event)
			}
		}
		reportResponse, err := service.ListReports(ctx, &enginev1.ListReportsRequest{Context: requestContext, TaxYear: expected.year, Limit: 20})
		if err != nil {
			t.Fatalf("list %d reports: %v", expected.year, err)
		}
		if len(reportResponse.GetItems()) == 0 {
			t.Fatalf("%d report API returned no items", expected.year)
		}
		latest := reportResponse.GetItems()[0]
		if latest.GetStatus() != "PARTIAL" || latest.GetTransactionCount() != int64(expected.transactions) || latest.GetCompleteCount() != expected.complete || latest.GetExceptionCount() != expected.exception || latest.GetProfitAmount() != "UNKNOWN" {
			t.Fatalf("%d latest coverage report is wrong: %#v", expected.year, latest)
		}
	}
}
