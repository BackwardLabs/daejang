package main

import (
	"fmt"
	"sort"
	"strings"
	"time"
)

const (
	OptimismChainID = "eip155:10"

	FindingLedgerEventMissing            = "LEDGER_EVENT_MISSING"
	FindingLedgerEventDuplicate          = "LEDGER_EVENT_DUPLICATE"
	FindingTransactionCoordinateNotExact = "TRANSACTION_COORDINATE_NOT_EXACT"
	FindingActionMismatch                = "ACTION_MISMATCH"
	FindingPostingMissing                = "POSTING_MISSING"
	FindingPostingDuplicate              = "POSTING_DUPLICATE"
	FindingPostingUnexpected             = "POSTING_UNEXPECTED"
	FindingPostingMismatch               = "POSTING_MISMATCH"
	FindingAssetDecimalsMismatch         = "ASSET_DECIMALS_MISMATCH"
	FindingLotLineageMismatch            = "LOT_LINEAGE_MISMATCH"
	FindingLotLineageReadFailed          = "LOT_LINEAGE_READ_FAILED"
	FindingReviewStateMismatch           = "REVIEW_STATE_MISMATCH"
	FindingReviewRequiredMissing         = "REVIEW_REQUIRED_MISSING"
	FindingFallbackActionCoexist         = "FALLBACK_ACTION_COEXIST"
	FindingOptimismCoverageMissing       = "OPTIMISM_COVERAGE_MISSING"
)

type TransactionKey struct {
	SubjectID       string `json:"subjectId"`
	ChainID         string `json:"chainId"`
	TransactionHash string `json:"transactionHash"`
}

type Posting struct {
	LegID         string `json:"legId"`
	AccountID     string `json:"accountId"`
	AssetID       string `json:"assetId"`
	Direction     string `json:"direction"`
	Quantity      string `json:"quantity"`
	Role          string `json:"role"`
	AssetDecimals *uint8 `json:"assetDecimals,omitempty"`
	FairValue     string `json:"fairValue,omitempty"`
	CostBasis     string `json:"costBasis,omitempty"`
	Denomination  string `json:"denomination,omitempty"`
}

type CanonicalEvent struct {
	EventID               string    `json:"eventId"`
	RevisionID            string    `json:"revisionId"`
	ActionProofID         string    `json:"actionProofId,omitempty"`
	ActionProfileID       string    `json:"actionProfileId,omitempty"`
	ActionProfileVersion  string    `json:"actionProfileVersion,omitempty"`
	ActionBindingID       string    `json:"actionBindingId,omitempty"`
	EventType             string    `json:"eventType"`
	FlowShape             string    `json:"flowShape"`
	Subtype               string    `json:"subtype,omitempty"`
	Resolution            string    `json:"resolution"`
	InterpretationSupport string    `json:"interpretationSupport"`
	ReviewState           string    `json:"reviewState,omitempty"`
	Postings              []Posting `json:"postings"`
	Lot                   *Lineage  `json:"lot,omitempty"`
}

type CanonicalTransaction struct {
	Key    TransactionKey   `json:"key"`
	Events []CanonicalEvent `json:"events"`
}

type LedgerEvent struct {
	EventID               string    `json:"eventId"`
	RevisionID            string    `json:"revisionId"`
	ChainID               string    `json:"chainId,omitempty"`
	TransactionHash       string    `json:"transactionHash,omitempty"`
	TransactionCoordinate string    `json:"transactionCoordinate"`
	ActionProofID         string    `json:"actionProofId,omitempty"`
	ActionProfileID       string    `json:"actionProfileId,omitempty"`
	ActionProfileVersion  string    `json:"actionProfileVersion,omitempty"`
	ActionBindingID       string    `json:"actionBindingId,omitempty"`
	EventType             string    `json:"eventType"`
	FlowShape             string    `json:"flowShape"`
	Subtype               string    `json:"subtype,omitempty"`
	Resolution            string    `json:"resolution"`
	InterpretationSupport string    `json:"interpretationSupport"`
	ReviewState           string    `json:"reviewState,omitempty"`
	Postings              []Posting `json:"postings"`
}

type LotLink struct {
	Kind              string     `json:"kind"`
	LegID             string     `json:"legId"`
	LotID             string     `json:"lotId"`
	Quantity          string     `json:"quantity"`
	BasisStatus       string     `json:"basisStatus"`
	BasisAmount       string     `json:"basisAmount,omitempty"`
	BasisDenomination string     `json:"basisDenomination,omitempty"`
	SourceEventID     string     `json:"sourceEventId,omitempty"`
	SourceLegID       string     `json:"sourceLegId,omitempty"`
	SourceOccurredAt  *time.Time `json:"sourceOccurredAt,omitempty"`
	SourceQuantity    string     `json:"sourceQuantity,omitempty"`
	RemainingQuantity string     `json:"remainingQuantity,omitempty"`
}

type Lineage struct {
	RunID    string    `json:"runId,omitempty"`
	Coverage string    `json:"coverage,omitempty"`
	Links    []LotLink `json:"links"`
}

type ReportInput struct {
	Canonical    CanonicalTransaction `json:"canonical"`
	LedgerEvents []LedgerEvent        `json:"ledgerEvents"`
	LotLineage   map[string]Lineage   `json:"lotLineage"`
	LotErrors    map[string]string    `json:"lotErrors,omitempty"`
	SampleCounts map[string]int       `json:"sampleCounts"`
}

type Finding struct {
	Code            string `json:"code"`
	Severity        string `json:"severity"`
	SubjectID       string `json:"subjectId,omitempty"`
	ChainID         string `json:"chainId,omitempty"`
	TransactionHash string `json:"transactionHash,omitempty"`
	EventID         string `json:"eventId,omitempty"`
	LegID           string `json:"legId,omitempty"`
	Detail          string `json:"detail"`
}

type Report struct {
	Key      TransactionKey `json:"key"`
	Findings []Finding      `json:"findings"`
}

func Crosscheck(input ReportInput) Report {
	report := Report{Key: input.Canonical.Key, Findings: []Finding{}}
	add := func(code, eventID, legID, detail string) {
		report.Findings = append(report.Findings, Finding{
			Code: code, Severity: "ERROR", SubjectID: input.Canonical.Key.SubjectID,
			ChainID: input.Canonical.Key.ChainID, TransactionHash: input.Canonical.Key.TransactionHash,
			EventID: eventID, LegID: legID, Detail: detail,
		})
	}

	if input.SampleCounts[OptimismChainID] == 0 {
		add(FindingOptimismCoverageMissing, "", "", "no canonical ActionProof transaction sample exists for eip155:10")
	}

	observedByEvent := make(map[string][]LedgerEvent, len(input.LedgerEvents))
	for _, event := range input.LedgerEvents {
		observedByEvent[event.EventID] = append(observedByEvent[event.EventID], event)
	}
	for _, canonical := range input.Canonical.Events {
		matches := observedByEvent[canonical.EventID]
		if len(matches) == 0 {
			add(FindingLedgerEventMissing, canonical.EventID, "", "canonical Event is absent from the ledger read model")
			continue
		}
		if len(matches) > 1 {
			add(FindingLedgerEventDuplicate, canonical.EventID, "", fmt.Sprintf("ledger read model returned the Event %d times", len(matches)))
		}
		observed := matches[0]
		chainMatches := equalFoldTrim(observed.ChainID, input.Canonical.Key.ChainID)
		transactionMatches := equalFoldTrim(observed.TransactionHash, input.Canonical.Key.TransactionHash)
		if observed.TransactionCoordinate != "EXACT" || !chainMatches || !transactionMatches {
			add(FindingTransactionCoordinateNotExact, canonical.EventID, "", fmt.Sprintf("coordinate=%s chainMatches=%t transactionMatches=%t", observed.TransactionCoordinate, chainMatches, transactionMatches))
		}
		if !sameAction(canonical, observed) {
			add(FindingActionMismatch, canonical.EventID, "", "ActionProof or Action classification differs from canonical rows")
		}
		comparePostings(&report, input.Canonical.Key, canonical, observed)

		lineageKey := eventRevisionKey(canonical.EventID, canonical.RevisionID)
		observedLineage := input.LotLineage[lineageKey]
		if detail := input.LotErrors[lineageKey]; detail != "" {
			add(FindingLotLineageReadFailed, canonical.EventID, "", "lotread.EventLineage failed: "+detail)
		} else if canonical.Lot != nil && !sameLineage(*canonical.Lot, observedLineage) {
			add(FindingLotLineageMismatch, canonical.EventID, "", "lotread.EventLineage differs from current canonical lot rows: "+lineageDifference(*canonical.Lot, observedLineage))
		}
		if canonical.ReviewState != observed.ReviewState {
			add(FindingReviewStateMismatch, canonical.EventID, "", fmt.Sprintf("canonical=%q ledger=%q", canonical.ReviewState, observed.ReviewState))
		}
		reviewReasons := reviewRequirement(observed)
		if observed.ReviewState == "" && len(reviewReasons) > 0 {
			add(FindingReviewRequiredMissing, canonical.EventID, "", "ledger row has no review workflow state; reasons: "+strings.Join(reviewReasons, ", "))
		}
	}

	if hasEventPrefix(input.Canonical.Events, "event-action:") && hasEventPrefix(input.Canonical.Events, "event-objective:") {
		add(FindingFallbackActionCoexist, "", "", "canonical Action and objective fallback Events coexist for one transaction")
	}

	sort.Slice(report.Findings, func(i, j int) bool {
		left, right := report.Findings[i], report.Findings[j]
		if left.Code != right.Code {
			return left.Code < right.Code
		}
		if left.EventID != right.EventID {
			return left.EventID < right.EventID
		}
		return left.LegID < right.LegID
	})
	return report
}

func comparePostings(report *Report, key TransactionKey, canonical CanonicalEvent, observed LedgerEvent) {
	observedByLeg := make(map[string][]Posting, len(observed.Postings))
	for _, posting := range observed.Postings {
		observedByLeg[posting.LegID] = append(observedByLeg[posting.LegID], posting)
	}
	expectedByLeg := make(map[string]struct{}, len(canonical.Postings))
	for _, expected := range canonical.Postings {
		expectedByLeg[expected.LegID] = struct{}{}
		matches := observedByLeg[expected.LegID]
		if len(matches) == 0 {
			report.Findings = append(report.Findings, eventFinding(key, FindingPostingMissing, canonical.EventID, expected.LegID, "canonical Posting leg is absent from the ledger read model"))
			continue
		}
		if len(matches) > 1 {
			report.Findings = append(report.Findings, eventFinding(key, FindingPostingDuplicate, canonical.EventID, expected.LegID, fmt.Sprintf("ledger read model returned the Posting leg %d times", len(matches))))
		}
		actual := matches[0]
		if expected.AccountID != actual.AccountID || expected.AssetID != actual.AssetID || expected.Direction != actual.Direction || expected.Quantity != actual.Quantity || expected.Role != actual.Role {
			report.Findings = append(report.Findings, eventFinding(key, FindingPostingMismatch, canonical.EventID, expected.LegID, "account, asset, direction, quantity, or role differs from canonical Posting"))
		}
		if !sameDecimals(expected.AssetDecimals, actual.AssetDecimals) {
			report.Findings = append(report.Findings, eventFinding(key, FindingAssetDecimalsMismatch, canonical.EventID, expected.LegID, fmt.Sprintf("canonical=%s ledger=%s", decimalText(expected.AssetDecimals), decimalText(actual.AssetDecimals))))
		}
	}
	for legID, postings := range observedByLeg {
		if _, expected := expectedByLeg[legID]; expected {
			continue
		}
		report.Findings = append(report.Findings, eventFinding(key, FindingPostingUnexpected, canonical.EventID, legID, fmt.Sprintf("ledger read model returned %d Posting row(s) for a leg absent from canonical Posting", len(postings))))
	}
}

func eventFinding(key TransactionKey, code, eventID, legID, detail string) Finding {
	return Finding{Code: code, Severity: "ERROR", SubjectID: key.SubjectID, ChainID: key.ChainID, TransactionHash: key.TransactionHash, EventID: eventID, LegID: legID, Detail: detail}
}

func sameAction(expected CanonicalEvent, actual LedgerEvent) bool {
	return expected.RevisionID == actual.RevisionID &&
		expected.ActionProofID == actual.ActionProofID &&
		expected.ActionProfileID == actual.ActionProfileID &&
		expected.ActionProfileVersion == actual.ActionProfileVersion &&
		expected.ActionBindingID == actual.ActionBindingID &&
		expected.EventType == actual.EventType && expected.FlowShape == actual.FlowShape &&
		expected.Subtype == actual.Subtype && expected.Resolution == actual.Resolution &&
		expected.InterpretationSupport == actual.InterpretationSupport
}

func reviewRequirement(event LedgerEvent) []string {
	reasons := []string{}
	if event.Resolution != "RESOLVED" || event.InterpretationSupport != "FULL" {
		if event.Resolution != "RESOLVED" {
			reasons = append(reasons, "resolution="+event.Resolution)
		}
		if event.InterpretationSupport != "FULL" {
			reasons = append(reasons, "interpretationSupport="+event.InterpretationSupport)
		}
	}
	material := 0
	valued := 0
	for _, posting := range event.Postings {
		if posting.Role == "FEE" || posting.Role == "GAS" {
			continue
		}
		material++
		if posting.FairValue != "" || posting.CostBasis != "" {
			valued++
		}
	}
	if material > 0 && valued < material {
		reasons = append(reasons, fmt.Sprintf("valuation=%d/%d", valued, material))
	}
	return reasons
}

func sameLineage(expected, actual Lineage) bool {
	expected.Links = append([]LotLink(nil), expected.Links...)
	actual.Links = append([]LotLink(nil), actual.Links...)
	sort.Slice(expected.Links, func(i, j int) bool { return lotLinkKey(expected.Links[i]) < lotLinkKey(expected.Links[j]) })
	sort.Slice(actual.Links, func(i, j int) bool { return lotLinkKey(actual.Links[i]) < lotLinkKey(actual.Links[j]) })
	if expected.RunID != actual.RunID || expected.Coverage != actual.Coverage || len(expected.Links) != len(actual.Links) {
		return false
	}
	for index := range expected.Links {
		if !sameLotLink(expected.Links[index], actual.Links[index]) {
			return false
		}
	}
	return true
}

func lineageDifference(expected, actual Lineage) string {
	if expected.RunID != actual.RunID {
		return fmt.Sprintf("run identity differs (canonicalPresent=%t ledgerPresent=%t)", expected.RunID != "", actual.RunID != "")
	}
	if expected.Coverage != actual.Coverage {
		return fmt.Sprintf("coverage differs (canonical=%q ledger=%q)", expected.Coverage, actual.Coverage)
	}
	if len(expected.Links) != len(actual.Links) {
		return fmt.Sprintf("link count differs (canonical=%d ledger=%d)", len(expected.Links), len(actual.Links))
	}
	expected.Links = append([]LotLink(nil), expected.Links...)
	actual.Links = append([]LotLink(nil), actual.Links...)
	sort.Slice(expected.Links, func(i, j int) bool { return lotLinkKey(expected.Links[i]) < lotLinkKey(expected.Links[j]) })
	sort.Slice(actual.Links, func(i, j int) bool { return lotLinkKey(actual.Links[i]) < lotLinkKey(actual.Links[j]) })
	for index := range expected.Links {
		if !sameLotLink(expected.Links[index], actual.Links[index]) {
			return fmt.Sprintf("link %d fields differ (kind=%q canonicalBasis=%q ledgerBasis=%q)", index+1, expected.Links[index].Kind, expected.Links[index].BasisStatus, actual.Links[index].BasisStatus)
		}
	}
	return "unknown difference"
}

func sameLotLink(left, right LotLink) bool {
	return left.Kind == right.Kind && left.LegID == right.LegID && left.LotID == right.LotID &&
		left.Quantity == right.Quantity && left.BasisStatus == right.BasisStatus &&
		left.BasisAmount == right.BasisAmount && left.BasisDenomination == right.BasisDenomination &&
		left.SourceEventID == right.SourceEventID && left.SourceLegID == right.SourceLegID &&
		sameTime(left.SourceOccurredAt, right.SourceOccurredAt) && left.SourceQuantity == right.SourceQuantity &&
		left.RemainingQuantity == right.RemainingQuantity
}

func sameTime(left, right *time.Time) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return left.Equal(*right)
}

func lotLinkKey(link LotLink) string {
	return strings.Join([]string{link.Kind, link.LegID, link.LotID, link.SourceEventID, link.SourceLegID}, "\x00")
}

func hasEventPrefix(events []CanonicalEvent, prefix string) bool {
	for _, event := range events {
		if strings.HasPrefix(event.EventID, prefix) {
			return true
		}
	}
	return false
}

func eventRevisionKey(eventID, revisionID string) string { return eventID + "\x00" + revisionID }

func equalFoldTrim(left, right string) bool {
	return strings.EqualFold(strings.TrimSpace(left), strings.TrimSpace(right))
}

func sameDecimals(left, right *uint8) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func decimalText(value *uint8) string {
	if value == nil {
		return "missing"
	}
	return fmt.Sprint(*value)
}
