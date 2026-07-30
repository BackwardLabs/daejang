package upbitnormalizer

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/BackwardLabs/daejang-db/pkg/artifactstore"
)

const hashA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const hashB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

func TestPrepareNormalizesBuyAndSellToDeterministicCEXObservations(t *testing.T) {
	input := validInput(t, []map[string]any{
		mappedExchange("buy", 1, 0, "매수", "KRW-BTC", "0.10000000 BTC", "10,000,000 KRW", "5,000.00 KRW", "10,005,000 KRW"),
		mappedExchange("sell", 1, 1, "매도", "KRW-BTC", "0.05000000 BTC", "6,000,000 KRW", "3,000.00 KRW", "5,997,000 KRW"),
	})
	first, err := Prepare(input)
	if err != nil {
		t.Fatal(err)
	}
	second, err := Prepare(input)
	if err != nil {
		t.Fatal(err)
	}
	if first.ResultDigest != second.ResultDigest || string(first.RootArtifact) != string(second.RootArtifact) {
		t.Fatal("normalization is not deterministic")
	}
	if first.TerminalStatus != "COMPLETE" || first.NormalizedCount != 2 || len(first.Evidence.Observations) != 6 || len(first.Evidence.SourceOutcomeObservations) != 6 {
		t.Fatalf("unexpected result: %#v", first)
	}
	got := first.Evidence.Observations
	if got[0].Kind != "FILL" || got[0].Quantity != "10000000" || got[0].AssetID != "cex-document-asset:upbit:decimal8:btc" || got[1].Quantity != "-1000000000000000" || got[1].AssetID != "cex-document-asset:upbit:decimal8:krw" || got[2].Kind != "FEE" || got[2].Quantity != "-500000000000" {
		t.Fatalf("unexpected buy observations: %#v", got[:3])
	}
	if got[3].Quantity != "-5000000" || got[4].Quantity != "600000000000000" || got[5].Kind != "FEE" || got[5].Quantity != "-300000000000" {
		t.Fatalf("unexpected sell observations: %#v", got[3:])
	}
	if got[0].OccurredAt == nil || got[0].OccurredAt.Format(time.RFC3339) != "2026-07-28T15:04:05Z" {
		t.Fatalf("KST timestamp was not normalized to UTC: %#v", got[0].OccurredAt)
	}
	if string(got[0].DetailJSON) != `{"assetScalePolicy":"upbit-document-decimal8/v1","schemaVersion":"tax.cex-interpretation-input.v2","semantic":"BASE","sourceCase":"BUY"}` {
		t.Fatalf("unexpected tax-engine detail: %s", got[0].DetailJSON)
	}
	if strings.Contains(string(first.RootArtifact), "10005000") || strings.Contains(string(first.RootArtifact), "BTC") {
		t.Fatal("root manifest retained transaction values")
	}
}

func TestPrepareNormalizesDepositAndWithdrawalWithFee(t *testing.T) {
	result, err := Prepare(validInput(t, []map[string]any{
		mappedExchange("deposit", 2, 0, "입금", "USDT", "12.345678 USDT", "12.345678 USDT", "0 USDT", "12.345678 USDT"),
		mappedExchange("withdraw", 2, 1, "출금", "USDT", "10 USDT", "10 USDT", "0.5 USDT", "10.5 USDT"),
	}))
	if err != nil {
		t.Fatal(err)
	}
	if result.NormalizedCount != 2 || len(result.Evidence.Observations) != 3 {
		t.Fatalf("unexpected result: %#v", result)
	}
	values := result.Evidence.Observations
	if values[0].Kind != "DEPOSIT" || values[0].Quantity != "1234567800" || values[1].Kind != "WITHDRAWAL" || values[1].Quantity != "-1000000000" || values[2].Kind != "FEE" || values[2].Quantity != "-50000000" {
		t.Fatalf("unexpected transfer observations: %#v", values)
	}
}

func TestPrepareClassifiesTransferEndpointWithoutPublishingRawIdentity(t *testing.T) {
	ownedAddress := "0x1234567890abcdef1234567890abcdef12345678"
	externalAddress := "TJRabPrwbZy45sbavfcjinPJC18kjpRTv8"
	deposit := mappedExchange("deposit", 2, 0, "입금", "USDT", "12 USDT", "12 USDT", "0 USDT", "12 USDT")
	deposit["payload"].(map[string]any)["walletAddress"] = present("0x" + strings.ToUpper(ownedAddress[2:]))
	withdrawal := mappedExchange("withdraw", 2, 1, "출금", "USDT", "10 USDT", "10 USDT", "0 USDT", "10 USDT")
	withdrawal["payload"].(map[string]any)["walletAddress"] = present(externalAddress)
	unknown := mappedExchange("unknown", 2, 2, "입금", "BTC", "1 BTC", "1 BTC", "0 BTC", "1 BTC")
	unknown["payload"].(map[string]any)["walletAddress"] = map[string]any{"state": "BLANK"}

	input := validInput(t, []map[string]any{deposit, withdrawal, unknown})
	input.OwnedWallets = []OwnedWalletSnapshot{{
		SourceID: "wallet-source-1", Address: ownedAddress, Status: "ACTIVE",
		ChainIDs: []string{"eip155:10", "eip155:1", "eip155:10"},
	}}
	result, err := Prepare(input)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Evidence.Observations) != 3 {
		t.Fatalf("unexpected observations: %#v", result.Evidence.Observations)
	}
	assertTransferDetail(t, result.Evidence.Observations[0].DetailJSON, "OWNED_REGISTERED", "WALLET_OBSERVATION_PENDING", "wallet-source-1")
	assertTransferDetail(t, result.Evidence.Observations[1].DetailJSON, "EXTERNAL_KNOWN", "EXTERNAL_COUNTERPARTY_REVIEW", "")
	assertTransferDetail(t, result.Evidence.Observations[2].DetailJSON, "UNKNOWN", "COUNTERPARTY_REQUIRED", "")
	for _, observation := range result.Evidence.Observations {
		if strings.Contains(string(observation.DetailJSON), ownedAddress) || strings.Contains(string(observation.DetailJSON), externalAddress) {
			t.Fatal("raw transfer identity escaped into Observation detail")
		}
	}
}

func TestPrepareRecognizesAuthenticatedSubjectNameWithoutRetainingIt(t *testing.T) {
	record := mappedExchange("krw-deposit", 1, 0, "입금", "KRW", "1,000 KRW", "1,000 KRW", "0 KRW", "1,000 KRW")
	record["payload"].(map[string]any)["counterparty"] = present("Synthetic Owner")
	input := validInput(t, []map[string]any{record})
	input.ExpectedSubjectName = " Synthetic   Owner "
	result, err := Prepare(input)
	if err != nil {
		t.Fatal(err)
	}
	assertTransferDetail(t, result.Evidence.Observations[0].DetailJSON, "OWNED_SUBJECT_NAME", "OWNERSHIP_MATCHED", "")
	if strings.Contains(string(result.Evidence.Observations[0].DetailJSON), "Synthetic Owner") {
		t.Fatal("raw subject name escaped into Observation detail")
	}
}

func TestPrepareStillAcceptsRedactedV2Evidence(t *testing.T) {
	input := validInput(t, []map[string]any{
		mappedExchange("legacy", 1, 0, "입금", "KRW", "1 KRW", "1 KRW", "0 KRW", "1 KRW"),
	})
	var value map[string]any
	if err := json.Unmarshal(input.InternalEvidence, &value); err != nil {
		t.Fatal(err)
	}
	value["contractVersion"] = "internal-document-evidence-input/v2"
	payload := value["records"].([]any)[0].(map[string]any)["payload"].(map[string]any)
	delete(payload, "counterparty")
	delete(payload, "walletAddress")
	delete(payload, "travelRuleInfo")
	input.InternalEvidence, _ = json.Marshal(value)
	result, err := Prepare(input)
	if err != nil {
		t.Fatal(err)
	}
	assertTransferDetail(t, result.Evidence.Observations[0].DetailJSON, "UNKNOWN", "COUNTERPARTY_REQUIRED", "")
}

func TestTransferEndpointChangesBindProjectionDigest(t *testing.T) {
	firstRecord := mappedExchange("deposit", 1, 0, "입금", "USDT", "1 USDT", "1 USDT", "0 USDT", "1 USDT")
	firstRecord["payload"].(map[string]any)["walletAddress"] = present("0x1111111111111111111111111111111111111111")
	secondRecord := mappedExchange("deposit", 1, 0, "입금", "USDT", "1 USDT", "1 USDT", "0 USDT", "1 USDT")
	secondRecord["payload"].(map[string]any)["walletAddress"] = present("0x2222222222222222222222222222222222222222")
	first, err := Prepare(validInput(t, []map[string]any{firstRecord}))
	if err != nil {
		t.Fatal(err)
	}
	second, err := Prepare(validInput(t, []map[string]any{secondRecord}))
	if err != nil {
		t.Fatal(err)
	}
	if first.ResultDigest == second.ResultDigest {
		t.Fatal("transfer endpoint classification did not bind the projection digest")
	}
}

func TestMaskAddressNeverReturnsTheFullSourceValue(t *testing.T) {
	for _, value := range []string{"short", "TAsbMaT5EkF73", "0x1111111111111111111111111111111111111111"} {
		masked := maskAddress(value)
		if masked == value || strings.Contains(masked, value) {
			t.Fatalf("address was not masked: input=%q output=%q", value, masked)
		}
	}
}

func TestPrepareKeepsUnsupportedRowsExplicitAndPublishesPartialClosure(t *testing.T) {
	result, err := Prepare(validInput(t, []map[string]any{
		mappedExchange("buy", 1, 0, "매수", "KRW-ETH", "1 ETH", "3,000,000 KRW", "1,500 KRW", "3,001,500 KRW"),
		{"sourceRecordId": "nft", "mappingStatus": "MAPPED", "source": source("nft", 1, 1), "payload": map[string]any{"recordType": "NFT"}},
	}))
	if err != nil {
		t.Fatal(err)
	}
	if result.TerminalStatus != "PARTIAL" || result.NormalizedCount != 1 || result.Evidence.SourceOutcomes[0].Status != "NORMALIZED" || result.Evidence.SourceOutcomes[1].Status != "UNSUPPORTED" || result.Evidence.SourceOutcomes[1].ReasonCode != normalizationReason {
		t.Fatalf("unexpected mixed closure: %#v", result)
	}
	if result.Evidence.SourceExtractionRuns[0].Status != "PARTIAL" || result.Evidence.SourceExtractionRuns[0].Limitation == nil {
		t.Fatal("partial limitation is missing")
	}
}

func TestPrepareFailsClosedOnMalformedAmountsUnitsPrecisionAndTime(t *testing.T) {
	for name, mutate := range map[string]func(map[string]any){
		"wrong unit":                   func(p map[string]any) { p["quantity"] = present("1 ETH") },
		"excess precision":             func(p map[string]any) { p["quantity"] = present("0.0000000000000000001 BTC") },
		"zero padded excess precision": func(p map[string]any) { p["quantity"] = present("1.000000000 BTC") },
		"short comma group":            func(p map[string]any) { p["grossAmount"] = present("1,2 KRW") },
		"empty comma group":            func(p map[string]any) { p["grossAmount"] = present("1,,000 KRW") },
		"trailing comma":               func(p map[string]any) { p["grossAmount"] = present("1, KRW") },
		"bad time":                     func(p map[string]any) { p["eventAt"] = present("2026/07/29") },
		"missing state":                func(p map[string]any) { p["settlementAmount"] = map[string]any{"state": "NOT_PRINTED"} },
		"contradictory settlement": func(p map[string]any) {
			p["settlementAmount"] = present("1 KRW")
		},
	} {
		t.Run(name, func(t *testing.T) {
			record := mappedExchange("row", 1, 0, "매수", "KRW-BTC", "1 BTC", "1,000 KRW", "1 KRW", "1,001 KRW")
			mutate(record["payload"].(map[string]any))
			result, err := Prepare(validInput(t, []map[string]any{record}))
			if err != nil {
				t.Fatal(err)
			}
			if result.NormalizedCount != 0 || len(result.Evidence.Observations) != 0 || result.Evidence.SourceOutcomes[0].Status != "UNSUPPORTED" {
				t.Fatalf("unsafe row normalized: %#v", result)
			}
		})
	}
}

func TestPrepareFailsClosedOnContradictoryTransferSettlement(t *testing.T) {
	for name, record := range map[string]map[string]any{
		"deposit":    mappedExchange("deposit", 1, 0, "입금", "USDT", "10 USDT", "10 USDT", "0 USDT", "9 USDT"),
		"withdrawal": mappedExchange("withdrawal", 1, 0, "출금", "USDT", "10 USDT", "10 USDT", "0.5 USDT", "10 USDT"),
	} {
		t.Run(name, func(t *testing.T) {
			result, err := Prepare(validInput(t, []map[string]any{record}))
			if err != nil {
				t.Fatal(err)
			}
			if result.NormalizedCount != 0 || len(result.Evidence.Observations) != 0 || result.Evidence.SourceOutcomes[0].Status != "UNSUPPORTED" {
				t.Fatalf("contradictory transfer normalized: %#v", result)
			}
		})
	}
}

func TestPrepareAcceptsSubWonTradeFeeWithinDisplayedRoundingBoundary(t *testing.T) {
	result, err := Prepare(validInput(t, []map[string]any{
		mappedExchange("buy", 1, 0, "매수", "KRW-BTC", "1 BTC", "1,000 KRW", "0.75 KRW", "1,001 KRW"),
		mappedExchange("sell", 1, 1, "매도", "KRW-BTC", "1 BTC", "1,000 KRW", "0.75 KRW", "999 KRW"),
	}))
	if err != nil {
		t.Fatal(err)
	}
	if result.TerminalStatus != "COMPLETE" || result.NormalizedCount != 2 {
		t.Fatalf("valid displayed KRW rounding was rejected: %#v", result)
	}
}

func TestResultDigestBindsNormalizedObservationProjection(t *testing.T) {
	first, err := Prepare(validInput(t, []map[string]any{
		mappedExchange("buy", 1, 0, "매수", "KRW-BTC", "1 BTC", "1,000 KRW", "1 KRW", "1,001 KRW"),
	}))
	if err != nil {
		t.Fatal(err)
	}
	secondInput := validInput(t, []map[string]any{
		mappedExchange("buy", 1, 0, "매수", "KRW-BTC", "2 BTC", "1,000 KRW", "1 KRW", "1,001 KRW"),
	})
	second, err := Prepare(secondInput)
	if err != nil {
		t.Fatal(err)
	}
	if first.RecordCount != second.RecordCount || first.NormalizedCount != second.NormalizedCount || first.ResultDigest == second.ResultDigest {
		t.Fatalf("root digest did not bind changed projection: first=%s second=%s", first.ResultDigest, second.ResultDigest)
	}
}

func TestPrepareRejectsUnknownParserRunStatus(t *testing.T) {
	input := validInput(t, []map[string]any{mappedExchange("row", 1, 0, "입금", "KRW", "1 KRW", "1 KRW", "0 KRW", "1 KRW")})
	var value map[string]any
	if err := json.Unmarshal(input.InternalEvidence, &value); err != nil {
		t.Fatal(err)
	}
	value["run"].(map[string]any)["status"] = "UNKNOWN"
	input.InternalEvidence, _ = json.Marshal(value)
	if _, err := Prepare(input); err == nil {
		t.Fatal("unknown parser run status was accepted")
	}
}

func TestPrepareAssignsEverySourceRecordToOneKoreanTaxYear(t *testing.T) {
	normalized := mappedExchange("normalized", 1, 0, "입금", "KRW", "1 KRW", "1 KRW", "0 KRW", "1 KRW")
	normalized["payload"].(map[string]any)["eventAt"] = present("2026-01-01 00:30:00")
	unsupported := map[string]any{"sourceRecordId": "unsupported", "mappingStatus": "MAPPED", "source": source("unsupported", 1, 1), "payload": map[string]any{"recordType": "NFT", "eventAt": present("2025-12-31 23:30:00")}}
	result, err := Prepare(validInput(t, []map[string]any{normalized, unsupported}))
	if err != nil {
		t.Fatal(err)
	}
	if len(result.CoverageRecords) != 2 || result.CoverageRecords[0].TaxYear != 2026 || result.CoverageRecords[0].Status != "NORMALIZED" || result.CoverageRecords[1].TaxYear != 2025 || result.CoverageRecords[1].Status != "UNSUPPORTED" {
		t.Fatalf("unexpected coverage records: %#v", result.CoverageRecords)
	}
}

func TestPreparePreservesParserDuplicateOutcome(t *testing.T) {
	result, err := Prepare(validInput(t, []map[string]any{
		mappedExchange("row-1", 1, 0, "입금", "KRW", "1,000 KRW", "1,000 KRW", "0 KRW", "1,000 KRW"),
		{"sourceRecordId": "row-2", "mappingStatus": "DUPLICATE", "canonicalSourceRecordId": "row-1", "source": source("row-2", 1, 1)},
	}))
	if err != nil {
		t.Fatal(err)
	}
	if result.Evidence.SourceOutcomes[1].Status != "DUPLICATE" || result.Evidence.SourceOutcomes[1].CanonicalSourceRecordID != "row-1" {
		t.Fatalf("duplicate was not preserved: %#v", result.Evidence.SourceOutcomes[1])
	}
}

func TestPrepareRejectsDuplicateTargetingUnknownRecord(t *testing.T) {
	_, err := Prepare(validInput(t, []map[string]any{{"sourceRecordId": "row-2", "mappingStatus": "DUPLICATE", "canonicalSourceRecordId": "missing", "source": source("row-2", 1, 1)}}))
	if err == nil {
		t.Fatal("duplicate targeting an unknown record was accepted")
	}
}

func TestPrepareRejectsSubjectMismatchAndMalformedTrailingContent(t *testing.T) {
	input := validInput(t, []map[string]any{mappedExchange("row", 1, 0, "입금", "KRW", "1 KRW", "1 KRW", "0 KRW", "1 KRW")})
	var value map[string]any
	if err := json.Unmarshal(input.InternalEvidence, &value); err != nil {
		t.Fatal(err)
	}
	value["subjectMatch"] = map[string]any{"status": "MISMATCH"}
	input.InternalEvidence, _ = json.Marshal(value)
	if _, err := Prepare(input); err == nil {
		t.Fatal("subject mismatch was accepted")
	}
	input = validInput(t, []map[string]any{mappedExchange("row", 1, 0, "입금", "KRW", "1 KRW", "1 KRW", "0 KRW", "1 KRW")})
	input.InternalEvidence = append(input.InternalEvidence, []byte(`{"truncated"`)...)
	if _, err := Prepare(input); err == nil {
		t.Fatal("malformed trailing parser output was accepted")
	}
}

func TestPrepareExternalParserFixture(t *testing.T) {
	path := os.Getenv("DAEJANG_UPBIT_INTERNAL_EVIDENCE_FIXTURE")
	if path == "" {
		t.Skip("DAEJANG_UPBIT_INTERNAL_EVIDENCE_FIXTURE is not set")
	}
	value, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	input := validInput(t, nil)
	input.InternalEvidence = value
	result, err := Prepare(input)
	if err != nil {
		t.Fatal(err)
	}
	if result.RecordCount == 0 || result.NormalizedCount == 0 || len(result.Evidence.Observations) == 0 {
		t.Fatalf("external parser fixture produced no normalized closure: records=%d normalized=%d observations=%d", result.RecordCount, result.NormalizedCount, len(result.Evidence.Observations))
	}
	t.Logf("external parser fixture closure: records=%d normalized=%d observations=%d status=%s", result.RecordCount, result.NormalizedCount, len(result.Evidence.Observations), result.TerminalStatus)
	reasons := map[string]int{}
	for _, outcome := range result.Evidence.SourceOutcomes {
		if outcome.Status != "NORMALIZED" {
			reasons[outcome.Reason]++
		}
	}
	t.Logf("external parser fixture non-normalized reasons: %#v", reasons)
}

func validInput(t *testing.T, records []map[string]any) Input {
	t.Helper()
	now := time.Date(2026, 7, 29, 3, 4, 5, 0, time.UTC)
	evidence := map[string]any{"contractVersion": "internal-document-evidence-input/v3", "providerId": "UPBIT", "artifact": map[string]any{"artifactId": "artifact-1", "importId": "import-1", "subjectRef": "subject-1", "sourceSystem": "UPBIT", "contentHash": map[string]any{"algorithm": "sha256", "value": hashB}, "collectedAt": now.Format(time.RFC3339)}, "producer": map[string]any{"name": "giwa-pdf-parser", "version": "0.3.0"}, "document": map[string]any{"documentType": "TRADE_STATEMENT"}, "subjectMatch": map[string]any{"status": "MATCH"}, "records": records, "run": map[string]any{"status": "COMPLETE", "completedAt": now.Format(time.RFC3339), "summary": map[string]any{"sourceRecordCount": len(records)}}}
	encoded, err := json.Marshal(evidence)
	if err != nil {
		t.Fatal(err)
	}
	return Input{SubjectID: "00000000-0000-4000-8000-000000000001", CoverageStart: now.AddDate(0, -1, 0), CoverageEnd: now, OriginalArtifact: artifactstore.Ref{Algorithm: "sha256", Digest: hashA, Locator: "artifact://sha256/" + hashA}, InternalArtifact: artifactstore.Ref{Algorithm: "sha256", Digest: hashB, Locator: "artifact://sha256/" + hashB}, InternalEvidence: encoded}
}

func mappedExchange(id string, page, item uint64, eventType, asset, quantity, gross, fee, settlement string) map[string]any {
	return map[string]any{"sourceRecordId": id, "mappingStatus": "MAPPED", "source": source(id, page, item), "payload": map[string]any{"recordType": "EXCHANGE", "eventAt": present("2026-07-29 00:04:05"), "eventType": present(eventType), "description": present("fixture"), "asset": present(asset), "unitPrice": present("1 KRW"), "quantity": present(quantity), "grossAmount": present(gross), "fee": present(fee), "settlementAmount": present(settlement), "counterparty": map[string]any{"state": "NOT_PRINTED"}, "walletAddress": map[string]any{"state": "NOT_PRINTED"}, "travelRuleInfo": map[string]any{"state": "NOT_PRINTED"}, "quality": map[string]any{"reviewStatus": "CLEAR"}}}
}
func present(raw string) map[string]any { return map[string]any{"state": "PRESENT", "raw": raw} }

func assertTransferDetail(t *testing.T, raw json.RawMessage, resolution, connectionStatus, walletSourceID string) {
	t.Helper()
	var detail struct {
		TransferEndpoint transferEndpointDetail `json:"transferEndpoint"`
	}
	if err := json.Unmarshal(raw, &detail); err != nil {
		t.Fatal(err)
	}
	if detail.TransferEndpoint.Resolution != resolution || detail.TransferEndpoint.ConnectionStatus != connectionStatus || detail.TransferEndpoint.WalletSourceID != walletSourceID {
		t.Fatalf("unexpected transfer detail: %s", raw)
	}
}
func source(id string, page, item uint64) map[string]any {
	return map[string]any{"sourceArtifactId": "artifact-1", "sourcePage": page, "sourceItemIndex": item, "recordHash": map[string]any{"algorithm": "sha256", "value": hashB}}
}
