package query

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/BackwardLabs/daejang-db/pkg/artifactstore"
	"github.com/BackwardLabs/daejang-db/pkg/readmodelstore"
	"github.com/BackwardLabs/daejang-db/pkg/taxreportstore"
	enginev1 "github.com/BackwardLabs/daejang/services/engine/gen/go/giwa/engine/v1"
	"github.com/BackwardLabs/daejang/services/engine/internal/lotread"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const queryTestSubjectID = "11111111-1111-4111-8111-111111111111"

type fakeReadStore struct {
	page             readmodelstore.OpenReviewPage
	ledgerPage       readmodelstore.LedgerEventPage
	dashboard        readmodelstore.Dashboard
	ledger           []readmodelstore.LedgerEvent
	lastSubject      string
	lastCursor       *readmodelstore.OpenReviewCursor
	lastLimit        int32
	lastLedgerCursor *readmodelstore.LedgerEventCursor
	lastLedgerLimit  int32
}

type fakeObservationReadStore struct {
	count      int64
	events     []readmodelstore.LedgerEvent
	page       readmodelstore.LedgerEventPage
	err        error
	lastLimit  int32
	lastCursor *readmodelstore.LedgerEventCursor
}

func (f *fakeObservationReadStore) CountUnmaterialized(context.Context, string, int32) (int64, error) {
	return f.count, f.err
}
func (f *fakeObservationReadStore) ListUnmaterializedPage(_ context.Context, _ string, _ int32, cursor *readmodelstore.LedgerEventCursor, limit int32) (readmodelstore.LedgerEventPage, error) {
	f.lastLimit = limit
	f.lastCursor = cursor
	if f.page.Events != nil || f.page.HasMore || f.page.Next != nil {
		return f.page, f.err
	}
	return readmodelstore.LedgerEventPage{Events: f.events}, f.err
}

type fakeLotStore struct {
	lineage     lotread.Lineage
	err         error
	lastSubject string
	lastEventID string
	lastRevID   string
}

func (f *fakeLotStore) EventLineage(_ context.Context, subjectID, eventID, revisionID string, _ int32) (lotread.Lineage, error) {
	f.lastSubject, f.lastEventID, f.lastRevID = subjectID, eventID, revisionID
	return f.lineage, f.err
}

type fakeTaxReportStore struct {
	current     taxreportstore.CurrentReportDetail
	report      taxreportstore.StoredReport
	found       bool
	reportFound bool
	err         error
	lastSubject string
	lastTaxYear int
	lastHistory int
	lastReport  string
}

type fakeTaxReportArtifactStore struct {
	object      artifactstore.Object
	objects     map[string]artifactstore.Object
	found       bool
	err         error
	lastSubject string
	lastReport  string
	lastDigest  string
	digests     []string
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
	if ledger.GetNextPageToken() == "" {
		t.Fatal("unconsumed canonical event did not produce a continuation token")
	}
	ledger, err = service.ListLedgerEvents(context.Background(), &enginev1.ListLedgerEventsRequest{
		Context: queryTestContext(), TaxYear: 2026, Limit: 1, PageToken: ledger.GetNextPageToken(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(ledger.GetItems()) != 1 || ledger.GetItems()[0].GetEventId() != "materialized" || ledger.GetNextPageToken() != "" {
		t.Fatalf("continuation did not return the unconsumed canonical event: %#v", ledger)
	}
}

func TestLedgerPageTokenKeepsIndependentStreamCursors(t *testing.T) {
	at := time.Date(2026, 7, 29, 0, 0, 0, 0, time.UTC)
	reads := &fakeReadStore{ledgerPage: readmodelstore.LedgerEventPage{
		Events: []readmodelstore.LedgerEvent{{EventID: "canonical", EffectiveAt: at, PageOrderKey: "canonical"}},
	}}
	observations := &fakeObservationReadStore{page: readmodelstore.LedgerEventPage{
		Events: []readmodelstore.LedgerEvent{{EventID: "observation", EffectiveAt: at, PageOrderKey: `["fragment","run","record"]`}},
	}}
	service := &Service{Reads: reads, Observations: observations}

	first, err := service.ListLedgerEvents(context.Background(), &enginev1.ListLedgerEventsRequest{
		Context: queryTestContext(), TaxYear: 2026, Limit: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(first.GetItems()) != 1 || first.GetItems()[0].GetEventId() != "canonical" || first.GetNextPageToken() == "" {
		t.Fatalf("canonical tie-break page is invalid: %#v", first)
	}

	reads.ledgerPage = readmodelstore.LedgerEventPage{}
	second, err := service.ListLedgerEvents(context.Background(), &enginev1.ListLedgerEventsRequest{
		Context: queryTestContext(), TaxYear: 2026, Limit: 1, PageToken: first.GetNextPageToken(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(second.GetItems()) != 1 || second.GetItems()[0].GetEventId() != "observation" {
		t.Fatalf("observation stream was skipped after a canonical tie: %#v", second)
	}
	if observations.lastCursor != nil {
		t.Fatalf("unconsumed observation cursor advanced prematurely: %#v", observations.lastCursor)
	}
}

func TestListLedgerEventsRejectsInvalidPageInputBeforeDatabaseQuery(t *testing.T) {
	for name, request := range map[string]*enginev1.ListLedgerEventsRequest{
		"invalid token":   {Context: queryTestContext(), TaxYear: 2026, PageToken: "not-base64!"},
		"oversized limit": {Context: queryTestContext(), TaxYear: 2026, Limit: 201},
	} {
		t.Run(name, func(t *testing.T) {
			reads := &fakeReadStore{}
			service := &Service{Reads: reads}
			_, err := service.ListLedgerEvents(context.Background(), request)
			if status.Code(err) != codes.InvalidArgument {
				t.Fatalf("status=%s, want INVALID_ARGUMENT: %v", status.Code(err), err)
			}
			if reads.lastLedgerLimit != 0 {
				t.Fatalf("database was queried for invalid input: %#v", reads)
			}
		})
	}
}

func TestListLedgerEventsRejectsPageTokenFromAnotherTaxYear(t *testing.T) {
	at := time.Date(2026, 7, 29, 0, 0, 0, 0, time.UTC)
	reads := &fakeReadStore{ledgerPage: readmodelstore.LedgerEventPage{
		Events:  []readmodelstore.LedgerEvent{{EventID: "canonical", EffectiveAt: at}},
		HasMore: true,
	}}
	service := &Service{Reads: reads}
	first, err := service.ListLedgerEvents(context.Background(), &enginev1.ListLedgerEventsRequest{
		Context: queryTestContext(), TaxYear: 2026, Limit: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	reads.lastLedgerLimit = 0
	_, err = service.ListLedgerEvents(context.Background(), &enginev1.ListLedgerEventsRequest{
		Context: queryTestContext(), TaxYear: 2025, Limit: 1, PageToken: first.GetNextPageToken(),
	})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("status=%s, want INVALID_ARGUMENT: %v", status.Code(err), err)
	}
	if reads.lastLedgerLimit != 0 {
		t.Fatal("database was queried with a cursor from another tax year")
	}
}

func TestLedgerEventLotsProjectsOnlyPersistedAllocations(t *testing.T) {
	acquiredAt := time.Date(2026, 3, 26, 13, 41, 49, 0, time.UTC)
	lots := &fakeLotStore{lineage: lotread.Lineage{
		RunID: "lot-run:abc", Coverage: "PARTIAL",
		Links: []lotread.Link{
			{Kind: "ACQUIRE", LegID: "leg:in", LotID: "lot:1", Quantity: "1000", BasisStatus: "UNKNOWN", RemainingQuantity: "400"},
			{
				Kind: "DISPOSE", LegID: "leg:out", LotID: "lot:2", Quantity: "600", BasisStatus: "KNOWN",
				BasisAmount: "152474700000000", BasisDenomination: "asset-krw-upbit",
				SourceEventID: "event:src", SourceLegID: "leg:src", SourceOccurredAt: &acquiredAt, SourceQuantity: "900",
			},
		},
	}}
	service := &Service{Lots: lots}

	response, err := service.GetLedgerEventLots(context.Background(), &enginev1.GetLedgerEventLotsRequest{
		Context: queryTestContext(), EventId: "event:1", RevisionId: "revision:1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if lots.lastSubject != queryTestSubjectID || lots.lastEventID != "event:1" || lots.lastRevID != "revision:1" {
		t.Fatalf("lot lineage was not scoped to the caller and Event revision: %#v", lots)
	}
	if response.GetRunId() != "lot-run:abc" || response.GetCoverage() != "PARTIAL" || len(response.GetLinks()) != 2 {
		t.Fatalf("unexpected lot lineage projection: %#v", response)
	}
	acquire := response.GetLinks()[0]
	if acquire.GetKind() != "ACQUIRE" || acquire.GetRemainingQuantity() != "400" ||
		acquire.GetBasisStatus() != "UNKNOWN" || acquire.GetBasisAmount() != "" || acquire.GetSourceOccurredAt() != nil {
		t.Fatalf("acquisition link invented a basis or source: %#v", acquire)
	}
	dispose := response.GetLinks()[1]
	if dispose.GetKind() != "DISPOSE" || dispose.GetQuantity() != "600" || dispose.GetBasisStatus() != "KNOWN" ||
		dispose.GetBasisAmount() != "152474700000000" || dispose.GetSourceEventId() != "event:src" ||
		!dispose.GetSourceOccurredAt().AsTime().Equal(acquiredAt) {
		t.Fatalf("disposal link lost its acquisition provenance: %#v", dispose)
	}
}

func TestLedgerEventLotsRejectsMissingEventCoordinates(t *testing.T) {
	service := &Service{Lots: &fakeLotStore{}}

	_, err := service.GetLedgerEventLots(context.Background(), &enginev1.GetLedgerEventLotsRequest{
		Context: queryTestContext(), EventId: "event:1",
	})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("expected InvalidArgument for a missing revision, got %v", err)
	}
}

func TestLedgerProjectionIncludesSafeTransferEndpointSummary(t *testing.T) {
	at := time.Date(2026, 7, 30, 0, 0, 0, 0, time.UTC)
	reads := &fakeReadStore{ledger: []readmodelstore.LedgerEvent{{
		EventID: "transfer", EventType: "TRANSFER", FlowShape: "SELF_TRANSFER", Subtype: "FIAT_DEPOSIT", EffectiveAt: at,
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
	if ledger.GetItems()[0].GetSubtype() != "FIAT_DEPOSIT" {
		t.Fatalf("ledger subtype was not projected: %#v", ledger.GetItems()[0])
	}
	if endpoint.GetResolution() != "OWNED_REGISTERED" || endpoint.GetDisplay() != "0x123456…abcdef" ||
		endpoint.GetWalletSourceId() != "wallet-source-1" || !endpoint.GetReviewRequired() ||
		len(endpoint.GetChainCandidates()) != 1 || endpoint.GetChainCandidates()[0] != "eip155:10" {
		t.Fatalf("unsafe or incomplete transfer endpoint projection: %#v", endpoint)
	}
}

func TestLedgerProjectionIncludesCanonicalTransactionProvenance(t *testing.T) {
	at := time.Date(2026, 7, 30, 0, 0, 0, 0, time.UTC)
	reads := &fakeReadStore{ledger: []readmodelstore.LedgerEvent{{
		EventID: "action", EffectiveAt: at,
		ChainID: "10", TransactionHash: "0xabc", TransactionCoordinate: "EXACT",
		ActionProofID: "proof-1", ActionProfileID: "aave-v3.supply",
		ActionProfileVersion: "1.0.0", ActionBindingID: "binding-1",
	}}}
	service := &Service{Reads: reads}

	ledger, err := service.ListLedgerEvents(context.Background(), &enginev1.ListLedgerEventsRequest{Context: queryTestContext(), TaxYear: 2026, Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	event := ledger.GetItems()[0]
	if event.GetChainId() != "10" || event.GetTransactionHash() != "0xabc" ||
		event.GetTransactionCoordinate() != "EXACT" || event.GetActionProofId() != "proof-1" ||
		event.GetActionProfileId() != "aave-v3.supply" || event.GetActionProfileVersion() != "1.0.0" ||
		event.GetActionBindingId() != "binding-1" {
		t.Fatalf("canonical transaction provenance was not projected: %#v", event)
	}
}

func TestLedgerProjectionIncludesPersistedAssetMetadata(t *testing.T) {
	at := time.Date(2026, 7, 30, 0, 0, 0, 0, time.UTC)
	decimals := uint8(8)
	reads := &fakeReadStore{ledger: []readmodelstore.LedgerEvent{{
		EventID: "trade", EffectiveAt: at,
		Postings: []readmodelstore.Posting{{
			LegID: "leg-usdt", AssetID: "asset-usdt-upbit", AssetSymbol: "USDT",
			AssetDecimals: &decimals, AssetVenue: "upbit", OccurredAt: at,
			Direction: "IN", Quantity: "180108722461", Role: "PRINCIPAL",
		}},
	}}}
	service := &Service{Reads: reads}

	ledger, err := service.ListLedgerEvents(context.Background(), &enginev1.ListLedgerEventsRequest{Context: queryTestContext(), TaxYear: 2026, Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	posting := ledger.GetItems()[0].GetPostings()[0]
	if posting.GetAssetSymbol() != "USDT" || posting.GetAssetDecimals() != 8 || !posting.GetHasAssetDecimals() || posting.GetAssetVenue() != "upbit" {
		t.Fatalf("asset metadata was not projected: %#v", posting)
	}
}

func TestLedgerProjectionIncludesCanonicalAccountSourceMetadata(t *testing.T) {
	at := time.Date(2026, 7, 30, 0, 0, 0, 0, time.UTC)
	reads := &fakeReadStore{ledger: []readmodelstore.LedgerEvent{{
		EventID: "wallet-transfer", EffectiveAt: at,
		Postings: []readmodelstore.Posting{{
			LegID: "leg-wallet", AccountID: "wallet-account-opaque",
			AccountKind: "WALLET", AccountLocator: "0x16512376e2ea3c7b464cedeea3dce9b8a590fd80",
			AccountLabel: "Main wallet", AccountChainID: "eip155:10",
			AssetID: "asset:opaque", OccurredAt: at, Direction: "IN", Quantity: "1", Role: "PRINCIPAL",
		}},
	}}}
	service := &Service{Reads: reads}

	ledger, err := service.ListLedgerEvents(context.Background(), &enginev1.ListLedgerEventsRequest{Context: queryTestContext(), TaxYear: 2026, Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	posting := ledger.GetItems()[0].GetPostings()[0]
	if posting.GetAccountKind() != "WALLET" ||
		posting.GetAccountLocator() != "0x16512376e2ea3c7b464cedeea3dce9b8a590fd80" ||
		posting.GetAccountLabel() != "Main wallet" || posting.GetAccountChainId() != "eip155:10" {
		t.Fatalf("account source metadata was not projected: %#v", posting)
	}
}

func (f *fakeTaxReportStore) GetCurrentReportForYear(_ context.Context, subject string, taxYear int) (taxreportstore.CurrentReportDetail, bool, error) {
	f.lastSubject, f.lastTaxYear = subject, taxYear
	return f.current, f.found, f.err
}

func (f *fakeTaxReportStore) ListReportHistory(_ context.Context, subject string, taxYear int, _ int32) ([]taxreportstore.StoredReport, error) {
	f.lastSubject, f.lastHistory = subject, taxYear
	return nil, f.err
}

func (f *fakeTaxReportStore) GetReport(_ context.Context, subject, reportID string) (taxreportstore.StoredReport, bool, error) {
	f.lastSubject, f.lastReport = subject, reportID
	return f.report, f.reportFound, f.err
}

func (f *fakeTaxReportArtifactStore) GetTaxReportArtifact(
	_ context.Context,
	subject string,
	reportID string,
	digest string,
) (artifactstore.Object, bool, error) {
	f.lastSubject, f.lastReport, f.lastDigest = subject, reportID, digest
	f.digests = append(f.digests, digest)
	if f.objects != nil {
		object, found := f.objects[digest]
		return object, found, f.err
	}
	return f.object, f.found, f.err
}

func (f *fakeReadStore) Dashboard(context.Context, string, int32) (readmodelstore.Dashboard, error) {
	return f.dashboard, nil
}

func (f *fakeReadStore) ListLedgerEventsPage(_ context.Context, _ string, _ int32, cursor *readmodelstore.LedgerEventCursor, limit int32) (readmodelstore.LedgerEventPage, error) {
	f.lastLedgerCursor = cursor
	f.lastLedgerLimit = limit
	if f.ledgerPage.Events != nil || f.ledgerPage.HasMore || f.ledgerPage.Next != nil {
		return f.ledgerPage, nil
	}
	return readmodelstore.LedgerEventPage{Events: f.ledger}, nil
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

func taxReportModelFixture(t *testing.T) (taxreportstore.StoredReport, []byte) {
	t.Helper()
	report := taxreportstore.StoredReport{
		SubjectID: queryTestSubjectID,
		Report: taxreportstore.Report{
			ID:                  "tax-report:" + strings.Repeat("a", 64),
			ResidentID:          "resident-1",
			TaxYear:             2027,
			TaxInventoryRunID:   "tax-inventory-run-1",
			TaxEstimateID:       "tax-estimate-1",
			LotRunID:            "lot-run-1",
			InputDigest:         strings.Repeat("1", 64),
			SchemaDigest:        strings.Repeat("2", 64),
			DenominationAssetID: "asset-krw-upbit",
			EvidencePackDigest:  strings.Repeat("3", 64),
			Policy: taxreportstore.Producer{
				Name: "giwa-korea-tax-policy", Version: "2027.1", ArtifactDigest: strings.Repeat("4", 64),
			},
			Engine: taxreportstore.Producer{
				Name: "giwa-tax-engine", Version: "1.0.0", ArtifactDigest: strings.Repeat("5", 64),
			},
			IssuedAt: time.Date(2028, 1, 10, 0, 0, 0, 0, time.UTC),
		},
	}
	value := taxReportModelJSON(t, report, "generation-1")
	report.ReportArtifactDigest = digestBytes(value)
	return report, value
}

func taxReportModelJSON(
	t *testing.T,
	report taxreportstore.StoredReport,
	generationID string,
) []byte {
	t.Helper()
	value, err := json.Marshal(map[string]any{
		"schemaVersion":       taxReportModelSchemaV1,
		"reportId":            report.ID,
		"inputDigest":         report.InputDigest,
		"subjectId":           report.SubjectID,
		"residentId":          report.ResidentID,
		"taxYear":             report.TaxYear,
		"taxInventoryRunId":   report.TaxInventoryRunID,
		"taxEstimateId":       report.TaxEstimateID,
		"lotRunId":            report.LotRunID,
		"generationId":        generationID,
		"schemaDigest":        report.SchemaDigest,
		"denominationAssetId": report.DenominationAssetID,
		"evidencePackDigest":  report.EvidencePackDigest,
		"policy": map[string]any{
			"name": report.Policy.Name, "version": report.Policy.Version, "artifactDigest": report.Policy.ArtifactDigest,
		},
		"engine": map[string]any{
			"name": report.Engine.Name, "version": report.Engine.Version, "artifactDigest": report.Engine.ArtifactDigest,
		},
		"issuedAt": report.IssuedAt.Format(time.RFC3339Nano),
	})
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func digestBytes(value []byte) string {
	digest := sha256.Sum256(value)
	return hex.EncodeToString(digest[:])
}

func taxReportArtifact(report taxreportstore.StoredReport, value []byte) artifactstore.Object {
	return artifactstore.Object{
		Ref:          artifactstore.Ref{Algorithm: "sha256", Digest: report.ReportArtifactDigest},
		Bytes:        value,
		MediaType:    taxReportModelMediaType,
		PrivacyClass: artifactstore.PrivacySubjectPrivate,
	}
}

func taxEvidencePackFixture(t *testing.T) (taxreportstore.StoredReport, []byte, []byte) {
	t.Helper()
	report := taxreportstore.StoredReport{
		SubjectID: queryTestSubjectID,
		Report: taxreportstore.Report{
			ID:                  "tax-report:" + strings.Repeat("b", 64),
			ResidentID:          "resident-1",
			TaxYear:             2027,
			TaxInventoryRunID:   "tax-inventory-run-1",
			TaxEstimateID:       "tax-estimate-1",
			LotRunID:            "lot-run-1",
			InputDigest:         strings.Repeat("1", 64),
			SchemaDigest:        strings.Repeat("2", 64),
			DenominationAssetID: "asset-krw-upbit",
			Policy: taxreportstore.Producer{
				Name: "giwa-korea-tax-policy", Version: "2027.1", ArtifactDigest: strings.Repeat("4", 64),
			},
			Engine: taxreportstore.Producer{
				Name: "giwa-tax-engine", Version: "1.0.0", ArtifactDigest: strings.Repeat("5", 64),
			},
			IssuedAt: time.Date(2028, 1, 10, 0, 0, 0, 0, time.UTC),
		},
	}
	value, err := json.Marshal(map[string]any{
		"schemaVersion":     taxEvidencePackSchemaV1,
		"manifestId":        expectedTaxEvidencePackManifestID(report),
		"reportId":          report.ID,
		"subjectId":         report.SubjectID,
		"residentId":        report.ResidentID,
		"taxYear":           report.TaxYear,
		"taxInventoryRunId": report.TaxInventoryRunID,
		"taxEstimateId":     report.TaxEstimateID,
		"lotRunId":          report.LotRunID,
		"generationId":      "generation-1",
		"schemaDigest":      report.SchemaDigest,
		"artifactRoots":     []any{},
		"evidenceCoordinates": []any{
			map[string]any{"kind": "POSTING", "eventId": "event-1", "revisionId": "revision-1", "legId": "leg-1"},
		},
		"policy": map[string]any{
			"name": report.Policy.Name, "version": report.Policy.Version, "artifactDigest": report.Policy.ArtifactDigest,
		},
		"engine": map[string]any{
			"name": report.Engine.Name, "version": report.Engine.Version, "artifactDigest": report.Engine.ArtifactDigest,
		},
		"issuedAt": report.IssuedAt.Format(time.RFC3339Nano),
	})
	if err != nil {
		t.Fatal(err)
	}
	report.EvidencePackDigest = digestBytes(value)
	reportModel := taxReportModelJSON(t, report, "generation-1")
	report.ReportArtifactDigest = digestBytes(reportModel)
	return report, reportModel, value
}

func taxEvidencePackArtifact(report taxreportstore.StoredReport, value []byte) artifactstore.Object {
	return artifactstore.Object{
		Ref:          artifactstore.Ref{Algorithm: "sha256", Digest: report.EvidencePackDigest},
		Bytes:        value,
		MediaType:    taxEvidencePackMediaType,
		PrivacyClass: artifactstore.PrivacySubjectPrivate,
	}
}

func mutateTaxEvidencePack(
	t *testing.T,
	report taxreportstore.StoredReport,
	canonicalJSON []byte,
	mutate func(map[string]any),
) (taxreportstore.StoredReport, artifactstore.Object) {
	t.Helper()
	var pack map[string]any
	if err := json.Unmarshal(canonicalJSON, &pack); err != nil {
		t.Fatal(err)
	}
	mutate(pack)
	mutated, err := json.Marshal(pack)
	if err != nil {
		t.Fatal(err)
	}
	report.EvidencePackDigest = digestBytes(mutated)
	return report, taxEvidencePackArtifact(report, mutated)
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

func TestTaxReportQueriesAllow2025And2026SimulationYears(t *testing.T) {
	for _, taxYear := range []int32{2025, 2026} {
		t.Run(strconv.Itoa(int(taxYear)), func(t *testing.T) {
			issuedAt := time.Date(int(taxYear)+1, 1, 10, 0, 0, 0, 0, time.UTC)
			store := &fakeTaxReportStore{
				found: true,
				current: taxreportstore.CurrentReportDetail{
					StoredReport: taxreportstore.StoredReport{
						SubjectID: queryTestSubjectID,
						Report: taxreportstore.Report{
							ID: "report-simulation", ResidentID: "resident-1",
							TaxYear: int(taxYear), Finality: "PROVISIONAL",
							Status: "PARTIAL", FilingStatus: "BLOCKED", IssuedAt: issuedAt,
						},
					},
					PointerVersion: 1,
					UpdatedAt:      issuedAt,
				},
			}
			service := &Service{TaxReports: store}

			if _, err := service.GetCurrentTaxReport(context.Background(), &enginev1.GetCurrentTaxReportRequest{
				Context: queryTestContext(), TaxYear: taxYear,
			}); err != nil {
				t.Fatalf("current report year %d was rejected: %v", taxYear, err)
			}
			if store.lastTaxYear != int(taxYear) {
				t.Fatalf("current report year=%d, want %d", store.lastTaxYear, taxYear)
			}
			if _, err := service.ListTaxReportHistory(context.Background(), &enginev1.ListTaxReportHistoryRequest{
				Context: queryTestContext(), TaxYear: taxYear,
			}); err != nil {
				t.Fatalf("report history year %d was rejected: %v", taxYear, err)
			}
			if store.lastHistory != int(taxYear) {
				t.Fatalf("history year=%d, want %d", store.lastHistory, taxYear)
			}
		})
	}
}

func TestTaxReportQueriesReject2024BeforeStoreAccess(t *testing.T) {
	store := &fakeTaxReportStore{}
	service := &Service{TaxReports: store}
	if _, err := service.GetCurrentTaxReport(context.Background(), &enginev1.GetCurrentTaxReportRequest{
		Context: queryTestContext(), TaxYear: 2024,
	}); status.Code(err) != codes.InvalidArgument {
		t.Fatalf("current status=%s, want INVALID_ARGUMENT: %v", status.Code(err), err)
	}
	if _, err := service.ListTaxReportHistory(context.Background(), &enginev1.ListTaxReportHistoryRequest{
		Context: queryTestContext(), TaxYear: 2024,
	}); status.Code(err) != codes.InvalidArgument {
		t.Fatalf("history status=%s, want INVALID_ARGUMENT: %v", status.Code(err), err)
	}
	if store.lastTaxYear != 0 || store.lastHistory != 0 {
		t.Fatalf("store was queried for unsupported year: %#v", store)
	}
}

func TestGetTaxReportModelReturnsExactSubjectScopedCanonicalArtifact(t *testing.T) {
	report, canonicalJSON := taxReportModelFixture(t)
	reports := &fakeTaxReportStore{report: report, reportFound: true}
	artifacts := &fakeTaxReportArtifactStore{
		object: taxReportArtifact(report, canonicalJSON),
		found:  true,
	}
	service := &Service{TaxReports: reports, TaxReportArtifacts: artifacts}

	response, err := service.GetTaxReportModel(context.Background(), &enginev1.GetTaxReportModelRequest{
		Context: queryTestContext(), ReportId: report.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if reports.lastSubject != queryTestSubjectID || reports.lastReport != report.ID {
		t.Fatalf("report lookup escaped actor scope: %#v", reports)
	}
	if artifacts.lastSubject != queryTestSubjectID ||
		artifacts.lastReport != report.ID ||
		artifacts.lastDigest != report.ReportArtifactDigest {
		t.Fatalf("artifact lookup was not exact and subject scoped: %#v", artifacts)
	}
	if response.GetReportId() != report.ID ||
		response.GetArtifactDigest() != report.ReportArtifactDigest ||
		response.GetMediaType() != taxReportModelMediaType ||
		!bytes.Equal(response.GetCanonicalJson(), canonicalJSON) {
		t.Fatalf("unexpected exact report model response: %#v", response)
	}
}

func TestGetTaxReportModelAcceptsPostgresTimestampPrecision(t *testing.T) {
	report, _ := taxReportModelFixture(t)
	artifactIssuedAt := time.Date(2028, 1, 10, 0, 0, 0, 123456789, time.UTC)
	report.IssuedAt = artifactIssuedAt
	canonicalJSON := taxReportModelJSON(t, report, "generation-1")
	report.ReportArtifactDigest = digestBytes(canonicalJSON)
	// pgx persists timestamptz at PostgreSQL's microsecond precision.
	report.IssuedAt = artifactIssuedAt.Truncate(time.Microsecond)
	service := &Service{
		TaxReports: &fakeTaxReportStore{report: report, reportFound: true},
		TaxReportArtifacts: &fakeTaxReportArtifactStore{
			object: taxReportArtifact(report, canonicalJSON),
			found:  true,
		},
	}

	if _, err := service.GetTaxReportModel(
		context.Background(),
		&enginev1.GetTaxReportModelRequest{
			Context: queryTestContext(), ReportId: report.ID,
		},
	); err != nil {
		t.Fatalf("PostgreSQL timestamp precision was rejected: %v", err)
	}
}

func TestGetTaxEvidencePackReturnsExactSubjectScopedCanonicalArtifact(t *testing.T) {
	report, reportModelJSON, canonicalJSON := taxEvidencePackFixture(t)
	reports := &fakeTaxReportStore{report: report, reportFound: true}
	artifacts := &fakeTaxReportArtifactStore{
		objects: map[string]artifactstore.Object{
			report.EvidencePackDigest:   taxEvidencePackArtifact(report, canonicalJSON),
			report.ReportArtifactDigest: taxReportArtifact(report, reportModelJSON),
		},
	}
	service := &Service{TaxReports: reports, TaxReportArtifacts: artifacts}

	response, err := service.GetTaxEvidencePack(context.Background(), &enginev1.GetTaxEvidencePackRequest{
		Context: queryTestContext(), ReportId: report.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if reports.lastSubject != queryTestSubjectID || reports.lastReport != report.ID {
		t.Fatalf("report lookup escaped actor scope: %#v", reports)
	}
	if artifacts.lastSubject != queryTestSubjectID || artifacts.lastReport != report.ID {
		t.Fatalf("artifact lookups escaped actor scope: %#v", artifacts)
	}
	if len(artifacts.digests) != 2 ||
		artifacts.digests[0] != report.EvidencePackDigest ||
		artifacts.digests[1] != report.ReportArtifactDigest {
		t.Fatalf("evidence and report model lookups were not exact: %#v", artifacts.digests)
	}
	if response.GetReportId() != report.ID ||
		response.GetArtifactDigest() != report.EvidencePackDigest ||
		response.GetMediaType() != taxEvidencePackMediaType ||
		!bytes.Equal(response.GetCanonicalJson(), canonicalJSON) {
		t.Fatalf("unexpected exact evidence pack response: %#v", response)
	}
}

func TestGetTaxEvidencePackFailsClosedOnIdentityMismatch(t *testing.T) {
	baseReport, _, canonicalJSON := taxEvidencePackFixture(t)
	for name, mutate := range map[string]func(map[string]any){
		"subject": func(pack map[string]any) {
			pack["subjectId"] = "22222222-2222-4222-8222-222222222222"
		},
		"manifest": func(pack map[string]any) {
			pack["manifestId"] = "tax-evidence-pack:" + strings.Repeat("0", 64)
		},
		"generation": func(pack map[string]any) {
			pack["generationId"] = ""
		},
		"policy": func(pack map[string]any) {
			pack["policy"].(map[string]any)["version"] = "different-policy"
		},
		"engine": func(pack map[string]any) {
			pack["engine"].(map[string]any)["artifactDigest"] = strings.Repeat("6", 64)
		},
		"issued time": func(pack map[string]any) {
			pack["issuedAt"] = "2028-01-11T00:00:00Z"
		},
	} {
		t.Run(name, func(t *testing.T) {
			report, object := mutateTaxEvidencePack(t, baseReport, canonicalJSON, mutate)
			service := &Service{
				TaxReports:         &fakeTaxReportStore{report: report, reportFound: true},
				TaxReportArtifacts: &fakeTaxReportArtifactStore{object: object, found: true},
			}

			_, err := service.GetTaxEvidencePack(context.Background(), &enginev1.GetTaxEvidencePackRequest{
				Context: queryTestContext(), ReportId: report.ID,
			})
			if status.Code(err) != codes.DataLoss {
				t.Fatalf("status=%s, want DATA_LOSS: %v", status.Code(err), err)
			}
		})
	}
}

func TestGetTaxEvidencePackRejectsNonCanonicalReportID(t *testing.T) {
	service := &Service{
		TaxReports:         &fakeTaxReportStore{},
		TaxReportArtifacts: &fakeTaxReportArtifactStore{},
	}
	for _, reportID := range []string{
		"report-1",
		"tax-report:ABCDEF",
		"tax-report:" + strings.Repeat("A", 64),
		"tax-report:" + strings.Repeat("a", 63),
	} {
		_, err := service.GetTaxEvidencePack(
			context.Background(),
			&enginev1.GetTaxEvidencePackRequest{
				Context: queryTestContext(), ReportId: reportID,
			},
		)
		if status.Code(err) != codes.InvalidArgument {
			t.Fatalf(
				"report ID %q status=%s, want INVALID_ARGUMENT: %v",
				reportID,
				status.Code(err),
				err,
			)
		}
	}
}

func TestGetTaxEvidencePackHidesMissingAndCrossSubjectArtifacts(t *testing.T) {
	report, _, canonicalJSON := taxEvidencePackFixture(t)
	for name, testCase := range map[string]struct {
		reports   *fakeTaxReportStore
		artifacts *fakeTaxReportArtifactStore
	}{
		"other subject report is absent": {
			reports:   &fakeTaxReportStore{reportFound: false},
			artifacts: &fakeTaxReportArtifactStore{},
		},
		"published artifact is absent": {
			reports: &fakeTaxReportStore{report: report, reportFound: true},
			artifacts: &fakeTaxReportArtifactStore{
				object: taxEvidencePackArtifact(report, canonicalJSON),
				found:  false,
			},
		},
	} {
		t.Run(name, func(t *testing.T) {
			service := &Service{TaxReports: testCase.reports, TaxReportArtifacts: testCase.artifacts}
			_, err := service.GetTaxEvidencePack(context.Background(), &enginev1.GetTaxEvidencePackRequest{
				Context: queryTestContext(), ReportId: report.ID,
			})
			if status.Code(err) != codes.NotFound {
				t.Fatalf("status=%s, want NOT_FOUND: %v", status.Code(err), err)
			}
			if testCase.reports.lastSubject != queryTestSubjectID {
				t.Fatalf("report lookup escaped actor scope: %#v", testCase.reports)
			}
		})
	}
}

func TestGetTaxEvidencePackFailsClosedOnArtifactMismatch(t *testing.T) {
	baseReport, _, canonicalJSON := taxEvidencePackFixture(t)
	for name, mutate := range map[string]func(*artifactstore.Object){
		"digest": func(object *artifactstore.Object) {
			object.Bytes = append(append([]byte(nil), object.Bytes...), ' ')
		},
		"reference": func(object *artifactstore.Object) {
			object.Ref.Digest = strings.Repeat("0", 64)
		},
		"media type": func(object *artifactstore.Object) {
			object.MediaType = taxReportModelMediaType
		},
		"privacy": func(object *artifactstore.Object) {
			object.PrivacyClass = artifactstore.PrivacyPublicChain
		},
	} {
		t.Run(name, func(t *testing.T) {
			object := taxEvidencePackArtifact(baseReport, canonicalJSON)
			mutate(&object)
			service := &Service{
				TaxReports:         &fakeTaxReportStore{report: baseReport, reportFound: true},
				TaxReportArtifacts: &fakeTaxReportArtifactStore{object: object, found: true},
			}
			_, err := service.GetTaxEvidencePack(context.Background(), &enginev1.GetTaxEvidencePackRequest{
				Context: queryTestContext(), ReportId: baseReport.ID,
			})
			if status.Code(err) != codes.DataLoss {
				t.Fatalf("status=%s, want DATA_LOSS: %v", status.Code(err), err)
			}
		})
	}
}

func TestGetTaxEvidencePackRejectsOversizedArtifactBeforeJSONDecode(t *testing.T) {
	report, _, _ := taxEvidencePackFixture(t)
	oversized := bytes.Repeat([]byte{'x'}, maxTaxReportArtifactBytes+1)
	report.EvidencePackDigest = digestBytes(oversized)
	service := &Service{
		TaxReports: &fakeTaxReportStore{report: report, reportFound: true},
		TaxReportArtifacts: &fakeTaxReportArtifactStore{
			object: taxEvidencePackArtifact(report, oversized),
			found:  true,
		},
	}
	_, err := service.GetTaxEvidencePack(context.Background(), &enginev1.GetTaxEvidencePackRequest{
		Context: queryTestContext(), ReportId: report.ID,
	})
	if status.Code(err) != codes.ResourceExhausted {
		t.Fatalf("status=%s, want RESOURCE_EXHAUSTED: %v", status.Code(err), err)
	}
}

func TestGetTaxEvidencePackFailsClosedWhenReportModelIsMissing(t *testing.T) {
	report, _, canonicalJSON := taxEvidencePackFixture(t)
	service := &Service{
		TaxReports: &fakeTaxReportStore{report: report, reportFound: true},
		TaxReportArtifacts: &fakeTaxReportArtifactStore{objects: map[string]artifactstore.Object{
			report.EvidencePackDigest: taxEvidencePackArtifact(report, canonicalJSON),
		}},
	}

	_, err := service.GetTaxEvidencePack(context.Background(), &enginev1.GetTaxEvidencePackRequest{
		Context: queryTestContext(), ReportId: report.ID,
	})
	if status.Code(err) != codes.DataLoss {
		t.Fatalf("status=%s, want DATA_LOSS: %v", status.Code(err), err)
	}
}

func TestGetTaxEvidencePackFailsClosedOnReportModelGenerationMismatch(t *testing.T) {
	report, _, canonicalJSON := taxEvidencePackFixture(t)
	reportModelJSON := taxReportModelJSON(t, report, "generation-2")
	report.ReportArtifactDigest = digestBytes(reportModelJSON)
	service := &Service{
		TaxReports: &fakeTaxReportStore{report: report, reportFound: true},
		TaxReportArtifacts: &fakeTaxReportArtifactStore{objects: map[string]artifactstore.Object{
			report.EvidencePackDigest:   taxEvidencePackArtifact(report, canonicalJSON),
			report.ReportArtifactDigest: taxReportArtifact(report, reportModelJSON),
		}},
	}

	_, err := service.GetTaxEvidencePack(context.Background(), &enginev1.GetTaxEvidencePackRequest{
		Context: queryTestContext(), ReportId: report.ID,
	})
	if status.Code(err) != codes.DataLoss {
		t.Fatalf("status=%s, want DATA_LOSS: %v", status.Code(err), err)
	}
}

func TestGetTaxReportModelRejectsNonCanonicalReportID(t *testing.T) {
	service := &Service{
		TaxReports:         &fakeTaxReportStore{},
		TaxReportArtifacts: &fakeTaxReportArtifactStore{},
	}
	for _, reportID := range []string{
		"report-1",
		"tax-report:ABCDEF",
		"tax-report:" + strings.Repeat("A", 64),
		"tax-report:" + strings.Repeat("a", 63),
	} {
		_, err := service.GetTaxReportModel(
			context.Background(),
			&enginev1.GetTaxReportModelRequest{
				Context: queryTestContext(), ReportId: reportID,
			},
		)
		if status.Code(err) != codes.InvalidArgument {
			t.Fatalf(
				"report ID %q status=%s, want INVALID_ARGUMENT: %v",
				reportID,
				status.Code(err),
				err,
			)
		}
	}
}

func TestGetTaxReportModelHidesMissingAndCrossSubjectArtifacts(t *testing.T) {
	report, canonicalJSON := taxReportModelFixture(t)
	for name, testCase := range map[string]struct {
		reports   *fakeTaxReportStore
		artifacts *fakeTaxReportArtifactStore
	}{
		"other subject report is absent": {
			reports:   &fakeTaxReportStore{reportFound: false},
			artifacts: &fakeTaxReportArtifactStore{},
		},
		"published artifact is absent": {
			reports: &fakeTaxReportStore{report: report, reportFound: true},
			artifacts: &fakeTaxReportArtifactStore{
				object: taxReportArtifact(report, canonicalJSON),
				found:  false,
			},
		},
	} {
		t.Run(name, func(t *testing.T) {
			service := &Service{TaxReports: testCase.reports, TaxReportArtifacts: testCase.artifacts}
			_, err := service.GetTaxReportModel(context.Background(), &enginev1.GetTaxReportModelRequest{
				Context: queryTestContext(), ReportId: report.ID,
			})
			if status.Code(err) != codes.NotFound {
				t.Fatalf("status=%s, want NOT_FOUND: %v", status.Code(err), err)
			}
			if testCase.reports.lastSubject != queryTestSubjectID {
				t.Fatalf("report lookup escaped actor scope: %#v", testCase.reports)
			}
		})
	}
}

func TestGetTaxReportModelFailsClosedOnArtifactMismatch(t *testing.T) {
	baseReport, canonicalJSON := taxReportModelFixture(t)
	for name, mutate := range map[string]func(*taxreportstore.StoredReport, *artifactstore.Object){
		"digest": func(_ *taxreportstore.StoredReport, object *artifactstore.Object) {
			object.Bytes = append(append([]byte(nil), object.Bytes...), ' ')
		},
		"media type": func(_ *taxreportstore.StoredReport, object *artifactstore.Object) {
			object.MediaType = "application/vnd.giwa.tax-evidence-pack.v1+json"
		},
		"model identity": func(report *taxreportstore.StoredReport, object *artifactstore.Object) {
			var model map[string]any
			if err := json.Unmarshal(object.Bytes, &model); err != nil {
				t.Fatal(err)
			}
			model["subjectId"] = "22222222-2222-4222-8222-222222222222"
			value, err := json.Marshal(model)
			if err != nil {
				t.Fatal(err)
			}
			report.ReportArtifactDigest = digestBytes(value)
			*object = taxReportArtifact(*report, value)
		},
	} {
		t.Run(name, func(t *testing.T) {
			report := baseReport
			object := taxReportArtifact(report, canonicalJSON)
			mutate(&report, &object)
			service := &Service{
				TaxReports:         &fakeTaxReportStore{report: report, reportFound: true},
				TaxReportArtifacts: &fakeTaxReportArtifactStore{object: object, found: true},
			}
			_, err := service.GetTaxReportModel(context.Background(), &enginev1.GetTaxReportModelRequest{
				Context: queryTestContext(), ReportId: report.ID,
			})
			if status.Code(err) != codes.DataLoss {
				t.Fatalf("status=%s, want DATA_LOSS: %v", status.Code(err), err)
			}
		})
	}
}

func TestGetTaxReportModelFailsClosedOnStoredIdentityMismatch(t *testing.T) {
	baseReport, canonicalJSON := taxReportModelFixture(t)
	for name, mutate := range map[string]func(map[string]any){
		"tax inventory run": func(model map[string]any) {
			model["taxInventoryRunId"] = "other-tax-inventory-run"
		},
		"tax estimate": func(model map[string]any) {
			model["taxEstimateId"] = "other-tax-estimate"
		},
		"lot run": func(model map[string]any) {
			model["lotRunId"] = "other-lot-run"
		},
		"generation": func(model map[string]any) {
			model["generationId"] = ""
		},
		"denomination": func(model map[string]any) {
			model["denominationAssetId"] = "asset-usd"
		},
		"policy": func(model map[string]any) {
			model["policy"].(map[string]any)["version"] = "different-policy"
		},
		"engine": func(model map[string]any) {
			model["engine"].(map[string]any)["artifactDigest"] = strings.Repeat("6", 64)
		},
		"issued time": func(model map[string]any) {
			model["issuedAt"] = "2028-01-11T00:00:00Z"
		},
	} {
		t.Run(name, func(t *testing.T) {
			var model map[string]any
			if err := json.Unmarshal(canonicalJSON, &model); err != nil {
				t.Fatal(err)
			}
			mutate(model)
			mutated, err := json.Marshal(model)
			if err != nil {
				t.Fatal(err)
			}
			report := baseReport
			report.ReportArtifactDigest = digestBytes(mutated)
			service := &Service{
				TaxReports: &fakeTaxReportStore{report: report, reportFound: true},
				TaxReportArtifacts: &fakeTaxReportArtifactStore{
					object: taxReportArtifact(report, mutated),
					found:  true,
				},
			}

			_, err = service.GetTaxReportModel(context.Background(), &enginev1.GetTaxReportModelRequest{
				Context: queryTestContext(), ReportId: report.ID,
			})
			if status.Code(err) != codes.DataLoss {
				t.Fatalf("status=%s, want DATA_LOSS: %v", status.Code(err), err)
			}
		})
	}
}

func TestGetTaxReportModelRejectsOversizedArtifactBeforeJSONDecode(t *testing.T) {
	report, _ := taxReportModelFixture(t)
	oversized := bytes.Repeat([]byte{'x'}, maxTaxReportArtifactBytes+1)
	report.ReportArtifactDigest = digestBytes(oversized)
	service := &Service{
		TaxReports: &fakeTaxReportStore{report: report, reportFound: true},
		TaxReportArtifacts: &fakeTaxReportArtifactStore{
			object: taxReportArtifact(report, oversized),
			found:  true,
		},
	}
	_, err := service.GetTaxReportModel(context.Background(), &enginev1.GetTaxReportModelRequest{
		Context: queryTestContext(), ReportId: report.ID,
	})
	if status.Code(err) != codes.ResourceExhausted {
		t.Fatalf("status=%s, want RESOURCE_EXHAUSTED: %v", status.Code(err), err)
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
