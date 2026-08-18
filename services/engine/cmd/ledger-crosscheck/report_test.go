package main

import (
	"slices"
	"strings"
	"testing"
	"time"
)

func TestCrosscheckAllowsMultipleCanonicalActionEventsForOneTransaction(t *testing.T) {
	input := passingInput()
	second := input.Canonical.Events[0]
	second.Postings = append([]Posting(nil), second.Postings...)
	second.EventID = "event-action:second"
	second.RevisionID = "revision-second"
	second.Postings[0].LegID = "leg-second"
	input.Canonical.Events = append(input.Canonical.Events, second)
	input.LedgerEvents = append(input.LedgerEvents, observedFromCanonical(second, input.Canonical.Key))

	report := Crosscheck(input)
	if len(report.Findings) != 0 {
		t.Fatalf("multiple protocol Actions in one transaction are not duplicates: %#v", report.Findings)
	}
}

func TestCrosscheckFindsDuplicateLedgerEvent(t *testing.T) {
	input := passingInput()
	input.LedgerEvents = append(input.LedgerEvents, input.LedgerEvents[0])

	assertCodes(t, Crosscheck(input), FindingLedgerEventDuplicate)
}

func TestCrosscheckFindsMissingLedgerEvent(t *testing.T) {
	input := passingInput()
	input.LedgerEvents = nil

	assertCodes(t, Crosscheck(input), FindingLedgerEventMissing)
}

func TestCrosscheckFindsNonExactTransactionCoordinate(t *testing.T) {
	input := passingInput()
	input.LedgerEvents[0].TransactionCoordinate = "AMBIGUOUS"
	input.LedgerEvents[0].ChainID = ""
	input.LedgerEvents[0].TransactionHash = ""

	assertCodes(t, Crosscheck(input), FindingTransactionCoordinateNotExact)
}

func TestCrosscheckFindsActionMismatch(t *testing.T) {
	input := passingInput()
	input.LedgerEvents[0].ActionProfileID = "wrong-profile"

	assertCodes(t, Crosscheck(input), FindingActionMismatch)
}

func TestCrosscheckFindsMissingPosting(t *testing.T) {
	input := passingInput()
	input.LedgerEvents[0].Postings = nil

	assertCodes(t, Crosscheck(input), FindingPostingMissing)
}

func TestCrosscheckFindsDuplicatePosting(t *testing.T) {
	input := passingInput()
	input.LedgerEvents[0].Postings = append(input.LedgerEvents[0].Postings, input.LedgerEvents[0].Postings[0])

	assertCodes(t, Crosscheck(input), FindingPostingDuplicate)
}

func TestCrosscheckFindsUnexpectedPosting(t *testing.T) {
	input := passingInput()
	extra := input.LedgerEvents[0].Postings[0]
	extra.LegID = "leg-unexpected"
	input.LedgerEvents[0].Postings = append(input.LedgerEvents[0].Postings, extra)

	assertCodes(t, Crosscheck(input), FindingPostingUnexpected)
}

func TestCrosscheckFindsPostingValueMismatch(t *testing.T) {
	input := passingInput()
	input.LedgerEvents[0].Postings[0].AssetID = "asset:wrong"

	assertCodes(t, Crosscheck(input), FindingPostingMismatch)
}

func TestCrosscheckFindsAssetDecimalsMismatch(t *testing.T) {
	input := passingInput()
	wrong := uint8(6)
	input.LedgerEvents[0].Postings[0].AssetDecimals = &wrong

	assertCodes(t, Crosscheck(input), FindingAssetDecimalsMismatch)
}

func TestCrosscheckFindsLotLineageMismatch(t *testing.T) {
	input := passingInput()
	input.Canonical.Events[0].Lot = &Lineage{
		RunID: "lot-run:1", Coverage: "COMPLETE",
		Links: []LotLink{{Kind: "ACQUIRE", LegID: "leg-1", LotID: "lot-1", Quantity: "100", BasisStatus: "KNOWN"}},
	}
	input.LotLineage[eventRevisionKey("event-action:first", "revision-1")] = Lineage{
		RunID: "lot-run:1", Coverage: "PARTIAL",
		Links: []LotLink{{Kind: "ACQUIRE", LegID: "leg-1", LotID: "lot-1", Quantity: "100", BasisStatus: "UNKNOWN"}},
	}

	assertCodes(t, Crosscheck(input), FindingLotLineageMismatch)
}

func TestCrosscheckTreatsNilAndEmptyLotLinksAsEqual(t *testing.T) {
	input := passingInput()
	input.Canonical.Events[0].Lot = &Lineage{Links: []LotLink{}}
	input.LotLineage[eventRevisionKey("event-action:first", "revision-1")] = Lineage{}

	if report := Crosscheck(input); len(report.Findings) != 0 {
		t.Fatalf("empty lot lineage representations must compare equal: %#v", report.Findings)
	}
}

func TestCrosscheckTreatsEquivalentLotTimestampsAsEqual(t *testing.T) {
	input := passingInput()
	instant := time.Date(2026, time.August, 18, 1, 2, 3, 0, time.UTC)
	kst := instant.In(time.FixedZone("KST", 9*60*60))
	canonical := Lineage{RunID: "run-1", Coverage: "COMPLETE", Links: []LotLink{{Kind: "DISPOSE", LegID: "leg-1", LotID: "lot-1", Quantity: "1", BasisStatus: "UNKNOWN", SourceOccurredAt: &instant}}}
	observed := canonical
	observed.Links = append([]LotLink(nil), canonical.Links...)
	observed.Links[0].SourceOccurredAt = &kst
	input.Canonical.Events[0].Lot = &canonical
	input.LotLineage[eventRevisionKey("event-action:first", "revision-1")] = observed

	if report := Crosscheck(input); len(report.Findings) != 0 {
		t.Fatalf("the same lot instant in different time zones must compare equal: %#v", report.Findings)
	}
}

func TestCrosscheckReportsLotReadFailure(t *testing.T) {
	input := passingInput()
	key := eventRevisionKey("event-action:first", "revision-1")
	input.Canonical.Events[0].Lot = &Lineage{RunID: "run-1", Coverage: "PARTIAL"}
	input.LotErrors = map[string]string{key: "source_quantity is NULL"}

	assertCodes(t, Crosscheck(input), FindingLotLineageReadFailed)
}

func TestCrosscheckFindsReviewStateMismatch(t *testing.T) {
	input := passingInput()
	input.Canonical.Events[0].ReviewState = "OPEN"

	assertCodes(t, Crosscheck(input), FindingReviewStateMismatch)
}

func TestCrosscheckFindsPartialEventWithoutOpenReview(t *testing.T) {
	input := passingInput()
	input.Canonical.Events[0].Resolution = "PARTIAL"
	input.Canonical.Events[0].InterpretationSupport = "DETECTED_ONLY"
	input.LedgerEvents[0].Resolution = "PARTIAL"
	input.LedgerEvents[0].InterpretationSupport = "DETECTED_ONLY"

	report := Crosscheck(input)
	assertCodes(t, report, FindingReviewRequiredMissing)
	if !findingDetailContains(report, FindingReviewRequiredMissing, "resolution=PARTIAL") {
		t.Fatalf("partial review finding must name the trigger: %#v", report.Findings)
	}
}

func TestCrosscheckFindsValuationPendingWithoutOpenReview(t *testing.T) {
	input := passingInput()
	input.Canonical.Events[0].Postings[0].FairValue = ""
	input.LedgerEvents[0].Postings[0].FairValue = ""

	report := Crosscheck(input)
	assertCodes(t, report, FindingReviewRequiredMissing)
	if !findingDetailContains(report, FindingReviewRequiredMissing, "valuation=0/1") {
		t.Fatalf("valuation review finding must name the trigger: %#v", report.Findings)
	}
}

func TestCrosscheckFindsObjectiveFallbackAlongsideAction(t *testing.T) {
	input := passingInput()
	fallback := input.Canonical.Events[0]
	fallback.Postings = append([]Posting(nil), fallback.Postings...)
	fallback.EventID = "event-objective:fallback"
	fallback.RevisionID = "revision-fallback"
	fallback.ActionProofID = ""
	fallback.ActionProfileID = ""
	fallback.ActionProfileVersion = ""
	fallback.ActionBindingID = ""
	fallback.EventType = "OTHER"
	fallback.FlowShape = "POSITION_CHANGE"
	fallback.Subtype = ""
	fallback.Resolution = "PARTIAL"
	fallback.InterpretationSupport = "DETECTED_ONLY"
	fallback.ReviewState = "OPEN"
	fallback.Postings[0].LegID = "leg-fallback"
	input.Canonical.Events = append(input.Canonical.Events, fallback)
	input.LedgerEvents = append(input.LedgerEvents, observedFromCanonical(fallback, input.Canonical.Key))

	assertCodes(t, Crosscheck(input), FindingFallbackActionCoexist)
}

func TestCrosscheckRequiresOptimismSampleCoverage(t *testing.T) {
	input := passingInput()
	delete(input.SampleCounts, OptimismChainID)
	assertCodes(t, Crosscheck(input), FindingOptimismCoverageMissing)

	input.SampleCounts[OptimismChainID] = 1
	if report := Crosscheck(input); len(report.Findings) != 0 {
		t.Fatalf("positive Optimism coverage must satisfy the global gate: %#v", report.Findings)
	}
}

func TestReadModelSubjectValidationRejectsSyntheticProductionRows(t *testing.T) {
	if !isReadModelSubject("00000000-0000-4000-8000-000000000001") {
		t.Fatal("valid UUID subject was rejected")
	}
	if isReadModelSubject("ledger-e2e-synthetic-subject-1") {
		t.Fatal("synthetic non-UUID subject would make ListLedgerEventsPage reject the sample")
	}
}

func TestCoordinateFindingDoesNotEmbedTransactionHashInDetail(t *testing.T) {
	input := passingInput()
	input.LedgerEvents[0].TransactionCoordinate = "AMBIGUOUS"
	input.LedgerEvents[0].TransactionHash = "0xsecret-transaction"

	report := Crosscheck(input)
	if findingDetailContains(report, FindingTransactionCoordinateNotExact, input.LedgerEvents[0].TransactionHash) {
		t.Fatalf("coordinate finding detail leaked a transaction hash: %#v", report.Findings)
	}
}

func passingInput() ReportInput {
	decimals := uint8(18)
	key := TransactionKey{SubjectID: "00000000-0000-4000-8000-000000000001", ChainID: OptimismChainID, TransactionHash: "0xabc"}
	event := CanonicalEvent{
		EventID: "event-action:first", RevisionID: "revision-1",
		ActionProofID: "action-proof:1", ActionProfileID: "weth9.wrap", ActionProfileVersion: "v1", ActionBindingID: "binding-1",
		EventType: "WRAP", FlowShape: "POSITION_CHANGE", Subtype: "WRAP", Resolution: "RESOLVED", InterpretationSupport: "FULL",
		Postings: []Posting{{LegID: "leg-1", AccountID: "account-1", AssetID: "asset:weth", Direction: "IN", Quantity: "100", Role: "PRINCIPAL", AssetDecimals: &decimals, FairValue: "1000", Denomination: "asset:krw"}},
	}
	return ReportInput{
		Canonical:    CanonicalTransaction{Key: key, Events: []CanonicalEvent{event}},
		LedgerEvents: []LedgerEvent{observedFromCanonical(event, key)},
		LotLineage:   map[string]Lineage{},
		SampleCounts: map[string]int{OptimismChainID: 1},
	}
}

func observedFromCanonical(event CanonicalEvent, key TransactionKey) LedgerEvent {
	return LedgerEvent{
		EventID: event.EventID, RevisionID: event.RevisionID,
		ChainID: key.ChainID, TransactionHash: key.TransactionHash, TransactionCoordinate: "EXACT",
		ActionProofID: event.ActionProofID, ActionProfileID: event.ActionProfileID, ActionProfileVersion: event.ActionProfileVersion, ActionBindingID: event.ActionBindingID,
		EventType: event.EventType, FlowShape: event.FlowShape, Subtype: event.Subtype, Resolution: event.Resolution, InterpretationSupport: event.InterpretationSupport,
		ReviewState: event.ReviewState, Postings: append([]Posting(nil), event.Postings...),
	}
}

func assertCodes(t *testing.T, report Report, want ...string) {
	t.Helper()
	got := make([]string, 0, len(report.Findings))
	for _, finding := range report.Findings {
		got = append(got, finding.Code)
	}
	for _, code := range want {
		if !slices.Contains(got, code) {
			t.Fatalf("missing finding %s in %v (%#v)", code, got, report.Findings)
		}
	}
}

func findingDetailContains(report Report, code, fragment string) bool {
	for _, finding := range report.Findings {
		if finding.Code == code && strings.Contains(finding.Detail, fragment) {
			return true
		}
	}
	return false
}
