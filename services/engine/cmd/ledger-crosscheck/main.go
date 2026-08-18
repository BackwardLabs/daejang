package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/BackwardLabs/daejang-db/pkg/readmodelstore"
	"github.com/BackwardLabs/daejang/services/engine/internal/lotread"
	"github.com/jackc/pgx/v5/pgxpool"
)

type options struct {
	databaseURLEnv     string
	subjectID          string
	chainID            string
	transactionHash    string
	sampleLimit        int
	timeout            time.Duration
	includeIdentifiers bool
}

type outputRecord struct {
	Kind    string      `json:"kind"`
	Report  *Report     `json:"report,omitempty"`
	Summary *runSummary `json:"summary,omitempty"`
}

type runSummary struct {
	SamplesDiscovered   int            `json:"samplesDiscovered"`
	TransactionsChecked int            `json:"transactionsChecked"`
	TransactionsPassed  int            `json:"transactionsPassed"`
	FindingCount        int            `json:"findingCount"`
	FindingsByCode      map[string]int `json:"findingsByCode"`
	SampleCounts        map[string]int `json:"sampleCounts"`
	OptimismCovered     bool           `json:"optimismCovered"`
}

func main() {
	os.Exit(run())
}

func run() int {
	value := parseOptions()
	if err := validateOptions(value); err != nil {
		fmt.Fprintf(os.Stderr, "ledger-crosscheck: %v\n", err)
		return 1
	}
	databaseURL := strings.TrimSpace(os.Getenv(value.databaseURLEnv))
	if databaseURL == "" {
		fmt.Fprintf(os.Stderr, "ledger-crosscheck: %s is empty\n", value.databaseURLEnv)
		return 1
	}
	readOnlyURL, err := forceReadOnlyURL(databaseURL)
	if err != nil {
		fmt.Fprintf(os.Stderr, "ledger-crosscheck: database URL is invalid: %v\n", err)
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), value.timeout)
	defer cancel()
	pool, err := openCanonicalPool(ctx, readOnlyURL)
	if err != nil {
		fmt.Fprintf(os.Stderr, "ledger-crosscheck: %v\n", err)
		return 1
	}
	defer pool.Close()
	readRuntime, err := readmodelstore.Open(ctx, readmodelstore.Options{DatabaseURL: readOnlyURL, ApplicationName: "ledger-crosscheck-readmodel"})
	if err != nil {
		fmt.Fprintf(os.Stderr, "ledger-crosscheck: open ledger read model: %v\n", err)
		return 1
	}
	defer readRuntime.Close()
	lotRuntime, err := lotread.Open(ctx, readOnlyURL, "ledger-crosscheck-lotread")
	if err != nil {
		fmt.Fprintf(os.Stderr, "ledger-crosscheck: open lot read model: %v\n", err)
		return 1
	}
	defer lotRuntime.Close()

	filter := SampleFilter{SubjectID: value.subjectID, ChainID: value.chainID, TransactionHash: value.transactionHash, Limit: value.sampleLimit}
	samples, err := DiscoverSamples(ctx, pool, filter)
	if err != nil {
		fmt.Fprintf(os.Stderr, "ledger-crosscheck: %v\n", err)
		return 1
	}
	counts, err := CountCanonicalSamplesByChain(ctx, pool)
	if err != nil {
		fmt.Fprintf(os.Stderr, "ledger-crosscheck: %v\n", err)
		return 1
	}

	encoder := json.NewEncoder(os.Stdout)
	summary := runSummary{SamplesDiscovered: len(samples), FindingsByCode: map[string]int{}, SampleCounts: counts, OptimismCovered: counts[OptimismChainID] > 0}
	if len(samples) == 0 {
		report := Crosscheck(ReportInput{Canonical: CanonicalTransaction{}, SampleCounts: counts})
		if len(report.Findings) == 0 {
			report.Findings = append(report.Findings, Finding{Code: FindingLedgerEventMissing, Severity: "ERROR", Detail: "no canonical ActionProof transaction samples matched the requested scope"})
		}
		if !value.includeIdentifiers {
			report = redactReport(report)
		}
		if err := encoder.Encode(outputRecord{Kind: "transaction", Report: &report}); err != nil {
			fmt.Fprintf(os.Stderr, "ledger-crosscheck: encode report: %v\n", err)
			return 1
		}
		accumulateSummary(&summary, report)
	}
	for index, sample := range samples {
		canonical, err := LoadCanonicalTransaction(ctx, pool, sample.Key)
		if err != nil {
			fmt.Fprintf(os.Stderr, "ledger-crosscheck: load canonical transaction sample %d: %v\n", index+1, err)
			return 1
		}
		ledgerEvents, err := loadLedgerEvents(ctx, readRuntime.Store, canonical, sample.TaxYear)
		if err != nil {
			fmt.Fprintf(os.Stderr, "ledger-crosscheck: load ledger transaction sample %d: %v\n", index+1, err)
			return 1
		}
		lineage, lotErrors := loadLotLineage(ctx, lotRuntime.Store, canonical)
		if err := ctx.Err(); err != nil {
			fmt.Fprintf(os.Stderr, "ledger-crosscheck: load lot lineage sample %d: %v\n", index+1, err)
			return 1
		}
		reportCounts := counts
		if index > 0 && counts[OptimismChainID] == 0 {
			reportCounts = cloneCounts(counts)
			reportCounts[OptimismChainID] = 1
		}
		report := Crosscheck(ReportInput{Canonical: canonical, LedgerEvents: ledgerEvents, LotLineage: lineage, LotErrors: lotErrors, SampleCounts: reportCounts})
		if !value.includeIdentifiers {
			report = redactReport(report)
		}
		if err := encoder.Encode(outputRecord{Kind: "transaction", Report: &report}); err != nil {
			fmt.Fprintf(os.Stderr, "ledger-crosscheck: encode report: %v\n", err)
			return 1
		}
		accumulateSummary(&summary, report)
	}
	if err := encoder.Encode(outputRecord{Kind: "summary", Summary: &summary}); err != nil {
		fmt.Fprintf(os.Stderr, "ledger-crosscheck: encode summary: %v\n", err)
		return 1
	}
	if summary.FindingCount > 0 {
		return 2
	}
	return 0
}

func parseOptions() options {
	var value options
	flag.StringVar(&value.databaseURLEnv, "database-url-env", "DAEJANG_QUERY_DATABASE_URL", "environment variable containing the read-only query database URL")
	flag.StringVar(&value.subjectID, "subject", "", "optional exact subject UUID")
	flag.StringVar(&value.chainID, "chain-id", "", "optional exact CAIP-2 chain ID; requires --subject and --tx-hash")
	flag.StringVar(&value.transactionHash, "tx-hash", "", "optional exact transaction hash; requires --subject and --chain-id")
	flag.IntVar(&value.sampleLimit, "sample-limit", 100, "maximum canonical ActionProof transaction samples")
	flag.DurationVar(&value.timeout, "timeout", 2*time.Minute, "total read-only crosscheck timeout")
	flag.BoolVar(&value.includeIdentifiers, "include-identifiers", false, "emit raw subject, transaction, Event, and leg identifiers")
	flag.Parse()
	value.databaseURLEnv = strings.TrimSpace(value.databaseURLEnv)
	value.subjectID = strings.TrimSpace(value.subjectID)
	value.chainID = strings.ToLower(strings.TrimSpace(value.chainID))
	value.transactionHash = strings.ToLower(strings.TrimSpace(value.transactionHash))
	return value
}

func validateOptions(value options) error {
	if value.databaseURLEnv == "" {
		return errors.New("database URL environment variable name is required")
	}
	if strings.EqualFold(value.databaseURLEnv, "DAEJANG_POSTING_DATABASE_URL") {
		return errors.New("DAEJANG_POSTING_DATABASE_URL is a writer credential and is refused")
	}
	if value.sampleLimit < 1 || value.sampleLimit > 500 {
		return errors.New("sample limit must be between 1 and 500")
	}
	if value.timeout <= 0 {
		return errors.New("timeout must be positive")
	}
	if value.subjectID != "" && !isReadModelSubject(value.subjectID) {
		return errors.New("subject must be a lowercase UUID accepted by the ledger read model")
	}
	if (value.chainID == "") != (value.transactionHash == "") {
		return errors.New("chain ID and transaction hash must be supplied together")
	}
	if value.chainID != "" && value.subjectID == "" {
		return errors.New("an exact transaction crosscheck requires --subject")
	}
	return nil
}

func forceReadOnlyURL(databaseURL string) (string, error) {
	parsed, err := url.Parse(databaseURL)
	if err != nil {
		return "", err
	}
	if parsed.Scheme != "postgres" && parsed.Scheme != "postgresql" {
		return "", errors.New("database URL must use postgres or postgresql")
	}
	query := parsed.Query()
	query.Set("default_transaction_read_only", "on")
	parsed.RawQuery = query.Encode()
	return parsed.String(), nil
}

func openCanonicalPool(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse query database URL: %w", err)
	}
	config.MinConns = 1
	config.MaxConns = 3
	config.ConnConfig.RuntimeParams["application_name"] = "ledger-crosscheck-canonical"
	config.ConnConfig.RuntimeParams["default_transaction_read_only"] = "on"
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, fmt.Errorf("open canonical query pool: %w", err)
	}
	var role, readOnly string
	if err := pool.QueryRow(ctx, `SELECT current_user,current_setting('default_transaction_read_only')`).Scan(&role, &readOnly); err != nil {
		pool.Close()
		return nil, fmt.Errorf("verify canonical query pool: %w", err)
	}
	if role == "daejang_event_app" || readOnly != "on" {
		pool.Close()
		return nil, fmt.Errorf("refuse database role %q with default_transaction_read_only=%q", role, readOnly)
	}
	return pool, nil
}

func loadLedgerEvents(ctx context.Context, store *readmodelstore.Store, canonical CanonicalTransaction, taxYear int32) ([]LedgerEvent, error) {
	wanted := make(map[string]struct{}, len(canonical.Events))
	for _, event := range canonical.Events {
		wanted[event.EventID] = struct{}{}
	}
	result := []LedgerEvent{}
	var cursor *readmodelstore.LedgerEventCursor
	seenCursor := map[string]struct{}{}
	for {
		page, err := store.ListLedgerEventsPage(ctx, canonical.Key.SubjectID, taxYear, cursor, 200)
		if err != nil {
			return nil, fmt.Errorf("call readmodelstore.ListLedgerEventsPage (subjectLength=%d taxYear=%d): %w", len(canonical.Key.SubjectID), taxYear, err)
		}
		for _, event := range page.Events {
			if _, ok := wanted[event.EventID]; ok {
				result = append(result, ledgerEventFromReadModel(event))
			}
		}
		if !page.HasMore || page.Next == nil {
			break
		}
		cursorKey := page.Next.EffectiveAt.UTC().Format(time.RFC3339Nano) + "\x00" + page.Next.OrderKey
		if _, duplicate := seenCursor[cursorKey]; duplicate {
			return nil, errors.New("readmodelstore.ListLedgerEventsPage returned a repeated cursor")
		}
		seenCursor[cursorKey] = struct{}{}
		cursor = page.Next
	}
	return result, nil
}

func ledgerEventFromReadModel(event readmodelstore.LedgerEvent) LedgerEvent {
	result := LedgerEvent{EventID: event.EventID, RevisionID: event.RevisionID, ChainID: event.ChainID, TransactionHash: event.TransactionHash,
		TransactionCoordinate: event.TransactionCoordinate, ActionProofID: event.ActionProofID, ActionProfileID: event.ActionProfileID,
		ActionProfileVersion: event.ActionProfileVersion, ActionBindingID: event.ActionBindingID, EventType: event.EventType,
		FlowShape: event.FlowShape, Subtype: event.Subtype, Resolution: event.Resolution, InterpretationSupport: event.InterpretationSupport,
		ReviewState: event.ReviewState, Postings: make([]Posting, 0, len(event.Postings))}
	for _, posting := range event.Postings {
		result.Postings = append(result.Postings, Posting{LegID: posting.LegID, AccountID: posting.AccountID, AssetID: posting.AssetID,
			Direction: posting.Direction, Quantity: posting.Quantity, Role: posting.Role, AssetDecimals: posting.AssetDecimals,
			FairValue: posting.FairValue, CostBasis: posting.CostBasis, Denomination: posting.Denomination})
	}
	return result
}

func loadLotLineage(ctx context.Context, store *lotread.Store, canonical CanonicalTransaction) (map[string]Lineage, map[string]string) {
	result := make(map[string]Lineage, len(canonical.Events))
	errorsByEvent := make(map[string]string)
	for _, event := range canonical.Events {
		key := eventRevisionKey(event.EventID, event.RevisionID)
		value, err := store.EventLineage(ctx, canonical.Key.SubjectID, event.EventID, event.RevisionID, 500)
		if err != nil {
			errorsByEvent[key] = err.Error()
			continue
		}
		lineage := Lineage{RunID: value.RunID, Coverage: value.Coverage, Links: make([]LotLink, 0, len(value.Links))}
		for _, link := range value.Links {
			lineage.Links = append(lineage.Links, LotLink{Kind: link.Kind, LegID: link.LegID, LotID: link.LotID, Quantity: link.Quantity,
				BasisStatus: link.BasisStatus, BasisAmount: link.BasisAmount, BasisDenomination: link.BasisDenomination,
				SourceEventID: link.SourceEventID, SourceLegID: link.SourceLegID, SourceOccurredAt: link.SourceOccurredAt,
				SourceQuantity: link.SourceQuantity, RemainingQuantity: link.RemainingQuantity})
		}
		result[key] = lineage
	}
	return result, errorsByEvent
}

func redactReport(report Report) Report {
	report.Key.SubjectID = opaqueID(report.Key.SubjectID)
	report.Key.TransactionHash = opaqueID(report.Key.TransactionHash)
	for index := range report.Findings {
		report.Findings[index].SubjectID = opaqueID(report.Findings[index].SubjectID)
		report.Findings[index].TransactionHash = opaqueID(report.Findings[index].TransactionHash)
		report.Findings[index].EventID = opaqueID(report.Findings[index].EventID)
		report.Findings[index].LegID = opaqueID(report.Findings[index].LegID)
	}
	return report
}

func opaqueID(value string) string {
	if value == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(value))
	return "sha256:" + hex.EncodeToString(sum[:8])
}

func accumulateSummary(summary *runSummary, report Report) {
	summary.TransactionsChecked++
	if len(report.Findings) == 0 {
		summary.TransactionsPassed++
	}
	for _, finding := range report.Findings {
		summary.FindingCount++
		summary.FindingsByCode[finding.Code]++
	}
}

func cloneCounts(input map[string]int) map[string]int {
	result := make(map[string]int, len(input)+1)
	for key, value := range input {
		result[key] = value
	}
	return result
}
