package upbitnormalizer

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/BackwardLabs/daejang-db/pkg/artifactstore"
)

const hashA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const hashB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

func TestPreparePublishesMappedRowsAsReviewRequiredWithoutObservations(t *testing.T) {
	result, err := Prepare(validInput(t, []map[string]any{
		mappedRecord("row-1", 1, 0),
		{
			"sourceRecordId": "row-2", "mappingStatus": "DUPLICATE",
			"canonicalSourceRecordId": "row-1",
			"source":                  source("row-2", 1, 1),
		},
	}))
	if err != nil {
		t.Fatal(err)
	}
	if result.RecordCount != 2 || result.NormalizedCount != 0 || len(result.Evidence.Observations) != 0 {
		t.Fatalf("unsafe normalization result: %#v", result)
	}
	if result.Evidence.SourceOutcomes[0].Status != "UNSUPPORTED" ||
		result.Evidence.SourceOutcomes[0].ReasonCode != reviewReason ||
		result.Evidence.SourceOutcomes[1].Status != "UNSUPPORTED" ||
		result.Evidence.SourceOutcomes[1].ReasonCode != reviewReason {
		t.Fatalf("unexpected outcomes: %#v", result.Evidence.SourceOutcomes)
	}
	if result.Evidence.SourceArtifacts[0].ContentHashValue != hashA ||
		result.Evidence.SourceArtifacts[0].Artifact.Digest != hashA {
		t.Fatalf("encrypted original was not the retained source artifact: %#v", result.Evidence.SourceArtifacts[0])
	}
	if strings.Contains(string(result.RootArtifact), "financial-value-sentinel") {
		t.Fatal("root manifest retained parser payload values")
	}
}

func TestPreparePublishesDuplicateTargetingNegativeRecordAsReviewRequired(t *testing.T) {
	result, err := Prepare(validInput(t, []map[string]any{
		{
			"sourceRecordId": "row-1", "mappingStatus": "UNSUPPORTED", "reasonCode": "NOT_SUPPORTED",
			"source": source("row-1", 1, 0),
		},
		{
			"sourceRecordId": "row-2", "mappingStatus": "DUPLICATE", "canonicalSourceRecordId": "row-1",
			"source": source("row-2", 1, 1),
		},
	}))
	if err != nil {
		t.Fatal(err)
	}
	if result.Evidence.SourceOutcomes[1].Status != "UNSUPPORTED" ||
		result.Evidence.SourceOutcomes[1].CanonicalSourceRecordID != "" {
		t.Fatalf("duplicate row escaped review-required boundary: %#v", result.Evidence.SourceOutcomes[1])
	}
}

func TestPrepareRejectsDuplicateTargetingUnknownRecord(t *testing.T) {
	_, err := Prepare(validInput(t, []map[string]any{
		mappedRecord("row-1", 1, 0),
		{
			"sourceRecordId": "row-2", "mappingStatus": "DUPLICATE", "canonicalSourceRecordId": "missing",
			"source": source("row-2", 1, 1),
		},
	}))
	if err == nil {
		t.Fatal("duplicate targeting an unknown record was accepted")
	}
}

func TestPrepareRejectsSubjectMismatch(t *testing.T) {
	input := validInput(t, []map[string]any{mappedRecord("row-1", 1, 0)})
	var value map[string]any
	if err := json.Unmarshal(input.InternalEvidence, &value); err != nil {
		t.Fatal(err)
	}
	value["subjectMatch"] = map[string]any{"status": "MISMATCH"}
	input.InternalEvidence, _ = json.Marshal(value)
	if _, err := Prepare(input); err == nil {
		t.Fatal("subject mismatch was accepted")
	}
}

func TestPrepareAcceptsExplicitMVPSubjectComparisonSkip(t *testing.T) {
	input := validInput(t, []map[string]any{mappedRecord("row-1", 1, 0)})
	var value map[string]any
	if err := json.Unmarshal(input.InternalEvidence, &value); err != nil {
		t.Fatal(err)
	}
	value["subjectMatch"] = map[string]any{
		"status":            "INCONCLUSIVE",
		"policyRef":         "mvp-subject-comparison-skipped:v1",
		"rawValuesRetained": false,
	}
	input.InternalEvidence, _ = json.Marshal(value)

	result, err := Prepare(input)
	if err != nil {
		t.Fatal(err)
	}
	if result.RecordCount != 1 || result.NormalizedCount != 0 {
		t.Fatalf("unexpected review-only result: %#v", result)
	}
}

func TestPrepareRejectsUncheckedSubjectDecisionWithoutExactMVPPolicy(t *testing.T) {
	for name, subjectMatch := range map[string]map[string]any{
		"missing policy": {
			"status": "INCONCLUSIVE", "rawValuesRetained": false,
		},
		"wrong policy": {
			"status": "INCONCLUSIVE", "policyRef": "other-policy:v1", "rawValuesRetained": false,
		},
		"raw retained": {
			"status": "INCONCLUSIVE", "policyRef": "mvp-subject-comparison-skipped:v1", "rawValuesRetained": true,
		},
	} {
		t.Run(name, func(t *testing.T) {
			input := validInput(t, []map[string]any{mappedRecord("row-1", 1, 0)})
			var value map[string]any
			if err := json.Unmarshal(input.InternalEvidence, &value); err != nil {
				t.Fatal(err)
			}
			value["subjectMatch"] = subjectMatch
			input.InternalEvidence, _ = json.Marshal(value)
			if _, err := Prepare(input); err == nil {
				t.Fatal("unsafe unchecked subject decision was accepted")
			}
		})
	}
}

func TestPrepareRejectsMalformedTrailingContent(t *testing.T) {
	input := validInput(t, []map[string]any{mappedRecord("row-1", 1, 0)})
	input.InternalEvidence = append(input.InternalEvidence, []byte(`{"truncated"`)...)
	if _, err := Prepare(input); err == nil {
		t.Fatal("malformed trailing parser output was accepted")
	}
}

func validInput(t *testing.T, records []map[string]any) Input {
	t.Helper()
	now := time.Date(2026, 7, 29, 3, 4, 5, 0, time.UTC)
	evidence := map[string]any{
		"contractVersion": "internal-document-evidence-input/v2",
		"providerId":      "UPBIT",
		"artifact": map[string]any{
			"artifactId": "artifact-1", "importId": "import-1", "subjectRef": "subject-1",
			"sourceSystem": "UPBIT", "contentHash": map[string]any{"algorithm": "sha256", "value": hashB},
			"collectedAt": now.Format(time.RFC3339),
		},
		"producer":     map[string]any{"name": "giwa-pdf-parser", "version": "0.2.0"},
		"document":     map[string]any{"documentType": "TRADE_STATEMENT"},
		"subjectMatch": map[string]any{"status": "MATCH"},
		"records":      records,
		"run": map[string]any{
			"status": "COMPLETE", "completedAt": now.Format(time.RFC3339),
			"summary": map[string]any{"sourceRecordCount": len(records)},
		},
	}
	encoded, err := json.Marshal(evidence)
	if err != nil {
		t.Fatal(err)
	}
	return Input{
		SubjectID:     "00000000-0000-4000-8000-000000000001",
		CoverageStart: now.AddDate(0, -1, 0), CoverageEnd: now,
		OriginalArtifact: artifactstore.Ref{Algorithm: "sha256", Digest: hashA, Locator: "artifact://sha256/" + hashA},
		InternalArtifact: artifactstore.Ref{Algorithm: "sha256", Digest: hashB, Locator: "artifact://sha256/" + hashB},
		InternalEvidence: encoded,
	}
}

func mappedRecord(id string, page, item uint64) map[string]any {
	return map[string]any{
		"sourceRecordId": id, "mappingStatus": "MAPPED", "source": source(id, page, item),
		"payload": map[string]any{"sentinel": "financial-value-sentinel"},
	}
}

func source(id string, page, item uint64) map[string]any {
	return map[string]any{
		"sourceArtifactId": "artifact-1", "sourcePage": page, "sourceItemIndex": item,
		"recordHash": map[string]any{"algorithm": "sha256", "value": hashB},
	}
}
