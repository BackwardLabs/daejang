package upbitnormalizer

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/BackwardLabs/daejang-db/pkg/artifactstore"
	"github.com/BackwardLabs/daejang-db/pkg/evidencestore"
)

const (
	ProducerName    = "daejang-upbit-normalizer"
	ProducerVersion = "review-required/v1"
	// Pinned from BackwardLabs/schema commit 310e9ae51d4d833c0a309cbea7b0532f17c3b340.
	SchemaDigest = "13415ef66497cc99e0f09e8ac0cad5aa094144bbc85d6b9ce88188f406466ab2"
	reviewReason = "UPBIT_TRANSACTION_NORMALIZATION_REVIEW_REQUIRED"
)

type Input struct {
	SubjectID        string
	CoverageStart    time.Time
	CoverageEnd      time.Time
	OriginalArtifact artifactstore.Ref
	InternalArtifact artifactstore.Ref
	InternalEvidence []byte
}

type Result struct {
	Evidence        evidencestore.SourceEvidence
	RootArtifact    []byte
	ResultDigest    string
	RecordCount     int64
	NormalizedCount int64
}

type internalEvidence struct {
	ContractVersion string `json:"contractVersion"`
	ProviderID      string `json:"providerId"`
	Artifact        struct {
		ArtifactID   string    `json:"artifactId"`
		ImportID     string    `json:"importId"`
		SubjectRef   string    `json:"subjectRef"`
		SourceSystem string    `json:"sourceSystem"`
		ContentHash  hashValue `json:"contentHash"`
		CollectedAt  time.Time `json:"collectedAt"`
	} `json:"artifact"`
	Producer struct {
		Name    string `json:"name"`
		Version string `json:"version"`
	} `json:"producer"`
	Document struct {
		DocumentType string `json:"documentType"`
	} `json:"document"`
	SubjectMatch struct {
		Status            string `json:"status"`
		PolicyRef         string `json:"policyRef"`
		RawValuesRetained *bool  `json:"rawValuesRetained"`
	} `json:"subjectMatch"`
	Records []internalRecord `json:"records"`
	Run     struct {
		Status      string    `json:"status"`
		CompletedAt time.Time `json:"completedAt"`
		Summary     struct {
			SourceRecordCount int64 `json:"sourceRecordCount"`
		} `json:"summary"`
	} `json:"run"`
}

type hashValue struct {
	Algorithm string `json:"algorithm"`
	Value     string `json:"value"`
}

type internalRecord struct {
	SourceRecordID          string `json:"sourceRecordId"`
	MappingStatus           string `json:"mappingStatus"`
	CanonicalSourceRecordID string `json:"canonicalSourceRecordId"`
	ReasonCode              string `json:"reasonCode"`
	Source                  struct {
		SourceArtifactID string    `json:"sourceArtifactId"`
		SourcePage       uint64    `json:"sourcePage"`
		SourceItemIndex  uint64    `json:"sourceItemIndex"`
		RecordHash       hashValue `json:"recordHash"`
	} `json:"source"`
}

type rootManifest struct {
	SchemaVersion          string `json:"schemaVersion"`
	ProviderID             string `json:"providerId"`
	DocumentType           string `json:"documentType"`
	SourceArtifactDigest   string `json:"sourceArtifactDigest"`
	SourceDocumentHash     string `json:"sourceDocumentHash"`
	InternalEvidenceDigest string `json:"internalEvidenceDigest"`
	RecordCount            int64  `json:"recordCount"`
	NormalizedCount        int64  `json:"normalizedCount"`
	TerminalStatus         string `json:"terminalStatus"`
	ReasonCode             string `json:"reasonCode"`
}

func Prepare(input Input) (Result, error) {
	if strings.TrimSpace(input.SubjectID) == "" || input.CoverageStart.IsZero() ||
		input.CoverageEnd.Before(input.CoverageStart) || len(input.InternalEvidence) == 0 {
		return Result{}, errors.New("subject, coverage, and internal evidence are required")
	}
	if err := validateRef(input.OriginalArtifact); err != nil {
		return Result{}, fmt.Errorf("original artifact: %w", err)
	}
	if err := validateRef(input.InternalArtifact); err != nil {
		return Result{}, fmt.Errorf("internal artifact: %w", err)
	}
	var parsed internalEvidence
	decoder := json.NewDecoder(bytes.NewReader(input.InternalEvidence))
	if err := decoder.Decode(&parsed); err != nil {
		return Result{}, errors.New("internal evidence is invalid")
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return Result{}, errors.New("internal evidence has trailing content")
	}
	subjectMatchAccepted :=
		parsed.SubjectMatch.Status == "MATCH" ||
			(parsed.SubjectMatch.Status == "INCONCLUSIVE" &&
				parsed.SubjectMatch.PolicyRef == "mvp-subject-comparison-skipped:v1" &&
				parsed.SubjectMatch.RawValuesRetained != nil &&
				!*parsed.SubjectMatch.RawValuesRetained)
	if parsed.ContractVersion != "internal-document-evidence-input/v2" ||
		parsed.ProviderID != "UPBIT" || parsed.Artifact.SourceSystem != parsed.ProviderID ||
		!subjectMatchAccepted || parsed.Document.DocumentType == "" ||
		parsed.Artifact.ArtifactID == "" || parsed.Artifact.ImportID == "" ||
		parsed.Artifact.SubjectRef == "" || parsed.Artifact.ContentHash.Algorithm != "sha256" ||
		len(parsed.Artifact.ContentHash.Value) != 64 || parsed.Producer.Name == "" ||
		parsed.Producer.Version == "" || parsed.Run.Status == "FAILED" ||
		int64(len(parsed.Records)) != parsed.Run.Summary.SourceRecordCount {
		return Result{}, errors.New("internal evidence contract is invalid")
	}

	accountID := "cex-account:upbit:" + digest([]byte(input.SubjectID))[:32]
	originalPointer := pointer(input.OriginalArtifact)
	internalPointer := pointer(input.InternalArtifact)
	coverageStart, coverageEnd := dateOnly(input.CoverageStart), dateOnly(input.CoverageEnd)
	completedAt := parsed.Run.CompletedAt.UTC()
	if completedAt.IsZero() {
		completedAt = parsed.Artifact.CollectedAt.UTC()
	}
	if completedAt.IsZero() {
		return Result{}, errors.New("parser completion time is required")
	}

	records := make([]evidencestore.SourceRecord, 0, len(parsed.Records))
	outcomes := make([]evidencestore.SourceOutcome, 0, len(parsed.Records))
	seen := make(map[string]string, len(parsed.Records))
	duplicateTargets := make([]string, 0)
	for _, record := range parsed.Records {
		if record.SourceRecordID == "" || record.Source.SourceArtifactID != parsed.Artifact.ArtifactID ||
			record.Source.SourcePage < 1 || record.Source.RecordHash.Algorithm != "sha256" ||
			len(record.Source.RecordHash.Value) != 64 {
			return Result{}, errors.New("parser record provenance is invalid")
		}
		if _, exists := seen[record.SourceRecordID]; exists {
			return Result{}, errors.New("parser record identity is duplicated")
		}
		seen[record.SourceRecordID] = record.MappingStatus
		page, item := record.Source.SourcePage, record.Source.SourceItemIndex
		records = append(records, evidencestore.SourceRecord{
			ID: record.SourceRecordID, SourceArtifactID: parsed.Artifact.ArtifactID,
			NativeID:             record.SourceRecordID,
			Coordinate:           &evidencestore.SourceCoordinate{Kind: "DOCUMENT_ITEM", Page: &page, ItemIndex: &item},
			ContentHashAlgorithm: "sha256", ContentHashValue: record.Source.RecordHash.Value,
		})
		outcome := evidencestore.SourceOutcome{
			ExtractionRunID: parsed.Artifact.ImportID, SourceRecordID: record.SourceRecordID,
			SourceArtifactID: parsed.Artifact.ArtifactID, Evidence: &internalPointer,
		}
		switch record.MappingStatus {
		case "MAPPED":
			outcome.Status, outcome.ReasonCode = "UNSUPPORTED", reviewReason
			outcome.Reason = "거래 의미 규칙 검토가 완료되기 전에는 세금 관측값을 생성하지 않습니다."
		case "DUPLICATE":
			if record.CanonicalSourceRecordID == "" {
				return Result{}, errors.New("duplicate parser record has no canonical target")
			}
			duplicateTargets = append(duplicateTargets, record.CanonicalSourceRecordID)
			outcome.Status, outcome.ReasonCode = "UNSUPPORTED", reviewReason
			outcome.Reason = "중복 거래의 정규화 규칙 검토가 완료되기 전에는 세금 관측값을 생성하지 않습니다."
		case "UNSUPPORTED", "ERROR", "NOT_RELEVANT":
			if record.ReasonCode == "" {
				return Result{}, errors.New("negative parser record has no reason code")
			}
			outcome.Status, outcome.ReasonCode = record.MappingStatus, record.ReasonCode
		default:
			return Result{}, errors.New("parser mapping status is unsupported")
		}
		outcomes = append(outcomes, outcome)
	}
	for _, target := range duplicateTargets {
		if _, exists := seen[target]; !exists {
			return Result{}, errors.New("duplicate parser record targets an unknown record")
		}
	}

	evidence := evidencestore.SourceEvidence{
		Accounts: []evidencestore.SubjectAccount{{
			ID: accountID, Kind: "CEX", Locator: "cex://upbit/account/" + digest([]byte(input.SubjectID))[:32], Venue: "UPBIT",
		}},
		SourceArtifacts: []evidencestore.SourceArtifact{{
			ID: parsed.Artifact.ArtifactID, Kind: "FILE", System: "UPBIT",
			ContentHashAlgorithm: "sha256", ContentHashValue: input.OriginalArtifact.Digest,
			Locator: input.OriginalArtifact.Locator, CoverageFrom: &coverageStart, CoverageTo: &coverageEnd,
			CoverageStatus: "PARTIAL", Artifact: originalPointer,
			Collector:   evidencestore.ProducerRef{Name: "daejang-web-upload", Version: "v1", Artifact: originalPointer},
			CollectedAt: parsed.Artifact.CollectedAt.UTC(),
		}},
		SourceRecords: records,
		SourceExtractionRuns: []evidencestore.ExtractionRun{{
			ID: parsed.Artifact.ImportID, SourceArtifactID: parsed.Artifact.ArtifactID, Status: "PARTIAL",
			Producer:    evidencestore.ProducerRef{Name: parsed.Producer.Name, Version: parsed.Producer.Version, Artifact: internalPointer},
			CompletedAt: completedAt,
			Limitation:  &evidencestore.LimitationRef{ReasonCode: reviewReason, Reason: "Upbit 거래내역 의미 규칙 검토가 필요합니다.", Evidence: internalPointer},
		}},
		SourceOutcomes: outcomes,
	}
	manifest := rootManifest{
		SchemaVersion: "daejang.upbit-review-evidence.v1", ProviderID: "UPBIT",
		DocumentType: parsed.Document.DocumentType, SourceArtifactDigest: input.OriginalArtifact.Digest,
		SourceDocumentHash: parsed.Artifact.ContentHash.Value, InternalEvidenceDigest: input.InternalArtifact.Digest,
		RecordCount: int64(len(records)), NormalizedCount: 0, TerminalStatus: "PARTIAL", ReasonCode: reviewReason,
	}
	root, err := json.Marshal(manifest)
	if err != nil {
		return Result{}, err
	}
	return Result{Evidence: evidence, RootArtifact: root, ResultDigest: digest(root), RecordCount: int64(len(records))}, nil
}

func validateRef(ref artifactstore.Ref) error {
	if ref.Algorithm != "sha256" || len(ref.Digest) != 64 || strings.TrimSpace(ref.Locator) == "" {
		return errors.New("sha256 artifact reference is required")
	}
	return nil
}

func pointer(ref artifactstore.Ref) evidencestore.ArtifactPointer {
	return evidencestore.ArtifactPointer{Algorithm: ref.Algorithm, Digest: ref.Digest, Privacy: "SUBJECT_PRIVATE"}
}

func digest(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}

func dateOnly(value time.Time) time.Time {
	year, month, day := value.Date()
	return time.Date(year, month, day, 0, 0, 0, 0, time.UTC)
}
