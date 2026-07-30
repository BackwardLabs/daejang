package upbitnormalizer

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/BackwardLabs/daejang-db/pkg/artifactstore"
	"github.com/BackwardLabs/daejang-db/pkg/evidencestore"
)

const (
	ProducerName    = "daejang-upbit-normalizer"
	ProducerVersion = "observation/v5"
	// Pinned from BackwardLabs/schema commit 310e9ae51d4d833c0a309cbea7b0532f17c3b340.
	SchemaDigest              = "13415ef66497cc99e0f09e8ac0cad5aa094144bbc85d6b9ce88188f406466ab2"
	normalizationReason       = "UPBIT_TRANSACTION_NORMALIZATION_UNSUPPORTED"
	cexDetailSchema           = "tax.cex-interpretation-input.v2"
	cexScalePolicy            = "upbit-document-decimal8/v1"
	cexAssetNamespace         = "cex-document-asset:upbit:decimal8:"
	cexDocumentDecimals uint8 = 8
)

var amountPattern = regexp.MustCompile(`^((?:0|[1-9][0-9]*|[1-9][0-9]{0,2}(?:,[0-9]{3})+)(?:\.[0-9]+)?) ([A-Z0-9]+)$`)
var assetPattern = regexp.MustCompile(`^[A-Z0-9]+$`)
var evmAddressPattern = regexp.MustCompile(`^0x[0-9a-fA-F]{40}$`)
var suiAddressPattern = regexp.MustCompile(`^0x[0-9a-fA-F]{64}$`)
var tronAddressPattern = regexp.MustCompile(`^T[1-9A-HJ-NP-Za-km-z]{33}$`)

type OwnedWalletSnapshot struct {
	SourceID string
	Address  string
	Status   string
	ChainIDs []string
}

type Input struct {
	SubjectID           string
	CoverageStart       time.Time
	CoverageEnd         time.Time
	OriginalArtifact    artifactstore.Ref
	InternalArtifact    artifactstore.Ref
	InternalEvidence    []byte
	ExpectedSubjectName string
	OwnedWallets        []OwnedWalletSnapshot
}

type Result struct {
	Evidence        evidencestore.SourceEvidence
	RootArtifact    []byte
	ResultDigest    string
	RecordCount     int64
	NormalizedCount int64
	TerminalStatus  string
	CoverageRecords []CoverageRecord
}

type CoverageRecord struct {
	TaxYear int32
	Status  string
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

type hashValue struct{ Algorithm, Value string }

type sourceValue struct {
	State string `json:"state"`
	Raw   string `json:"raw"`
}

type exchangePayload struct {
	RecordType       string      `json:"recordType"`
	EventAt          sourceValue `json:"eventAt"`
	EventType        sourceValue `json:"eventType"`
	Description      sourceValue `json:"description"`
	Asset            sourceValue `json:"asset"`
	UnitPrice        sourceValue `json:"unitPrice"`
	Quantity         sourceValue `json:"quantity"`
	GrossAmount      sourceValue `json:"grossAmount"`
	Fee              sourceValue `json:"fee"`
	SettlementAmount sourceValue `json:"settlementAmount"`
	Counterparty     sourceValue `json:"counterparty"`
	WalletAddress    sourceValue `json:"walletAddress"`
	TravelRuleInfo   sourceValue `json:"travelRuleInfo"`
}

type observationDetail struct {
	AssetScalePolicy string                  `json:"assetScalePolicy"`
	SchemaVersion    string                  `json:"schemaVersion"`
	Semantic         string                  `json:"semantic"`
	SourceCase       string                  `json:"sourceCase"`
	ActivityClass    string                  `json:"activityClass"`
	TransferEndpoint *transferEndpointDetail `json:"transferEndpoint,omitempty"`
}

type transferEndpointDetail struct {
	Resolution       string   `json:"resolution"`
	Kind             string   `json:"kind"`
	Display          string   `json:"display"`
	AddressFamily    string   `json:"addressFamily,omitempty"`
	WalletSourceID   string   `json:"walletSourceId,omitempty"`
	ChainCandidates  []string `json:"chainCandidates,omitempty"`
	ConnectionStatus string   `json:"connectionStatus"`
	ReviewRequired   bool     `json:"reviewRequired"`
}

type internalRecord struct {
	SourceRecordID          string          `json:"sourceRecordId"`
	MappingStatus           string          `json:"mappingStatus"`
	CanonicalSourceRecordID string          `json:"canonicalSourceRecordId"`
	ReasonCode              string          `json:"reasonCode"`
	Payload                 exchangePayload `json:"payload"`
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
	ProjectionDigest       string `json:"projectionDigest"`
	RecordCount            int64  `json:"recordCount"`
	NormalizedCount        int64  `json:"normalizedCount"`
	TerminalStatus         string `json:"terminalStatus"`
	ReasonCode             string `json:"reasonCode,omitempty"`
	AssetScalePolicy       string `json:"assetScalePolicy"`
}

type normalization struct {
	assets       []evidencestore.SubjectAsset
	observations []evidencestore.Observation
	links        []evidencestore.SourceOutcomeObservation
}

func Prepare(input Input) (Result, error) {
	if strings.TrimSpace(input.SubjectID) == "" || input.CoverageStart.IsZero() || input.CoverageEnd.Before(input.CoverageStart) || len(input.InternalEvidence) == 0 {
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
	subjectMatchAccepted := parsed.SubjectMatch.Status == "MATCH" || (parsed.SubjectMatch.Status == "INCONCLUSIVE" && parsed.SubjectMatch.PolicyRef == "mvp-subject-comparison-skipped:v1" && parsed.SubjectMatch.RawValuesRetained != nil && !*parsed.SubjectMatch.RawValuesRetained)
	runAccepted := parsed.Run.Status == "COMPLETE" || parsed.Run.Status == "PARTIAL"
	if (parsed.ContractVersion != "internal-document-evidence-input/v2" && parsed.ContractVersion != "internal-document-evidence-input/v3") || parsed.ProviderID != "UPBIT" || parsed.Artifact.SourceSystem != parsed.ProviderID || !subjectMatchAccepted || parsed.Document.DocumentType != "TRADE_STATEMENT" || parsed.Artifact.ArtifactID == "" || parsed.Artifact.ImportID == "" || parsed.Artifact.SubjectRef == "" || parsed.Artifact.ContentHash.Algorithm != "sha256" || len(parsed.Artifact.ContentHash.Value) != 64 || parsed.Producer.Name == "" || parsed.Producer.Version == "" || !runAccepted || int64(len(parsed.Records)) != parsed.Run.Summary.SourceRecordCount {
		return Result{}, errors.New("internal evidence contract is invalid")
	}

	accountID := "cex-account:upbit:" + digest([]byte(input.SubjectID))[:32]
	originalPointer, internalPointer := pointer(input.OriginalArtifact), pointer(input.InternalArtifact)
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
	assetsByID := map[string]evidencestore.SubjectAsset{}
	observations := make([]evidencestore.Observation, 0, len(parsed.Records)*2)
	links := make([]evidencestore.SourceOutcomeObservation, 0, len(parsed.Records)*2)
	coverageRecords := make([]CoverageRecord, 0, len(parsed.Records))
	seen := make(map[string]string, len(parsed.Records))
	for _, record := range parsed.Records {
		if record.SourceRecordID == "" || record.Source.SourceArtifactID != parsed.Artifact.ArtifactID || record.Source.SourcePage < 1 || record.Source.RecordHash.Algorithm != "sha256" || len(record.Source.RecordHash.Value) != 64 {
			return Result{}, errors.New("parser record provenance is invalid")
		}
		if _, exists := seen[record.SourceRecordID]; exists {
			return Result{}, errors.New("parser record identity is duplicated")
		}
		seen[record.SourceRecordID] = record.MappingStatus
		page, item := record.Source.SourcePage, record.Source.SourceItemIndex
		records = append(records, evidencestore.SourceRecord{ID: record.SourceRecordID, SourceArtifactID: parsed.Artifact.ArtifactID, NativeID: record.SourceRecordID, Coordinate: &evidencestore.SourceCoordinate{Kind: "DOCUMENT_ITEM", Page: &page, ItemIndex: &item}, ContentHashAlgorithm: "sha256", ContentHashValue: record.Source.RecordHash.Value})
		outcome := evidencestore.SourceOutcome{ExtractionRunID: parsed.Artifact.ImportID, SourceRecordID: record.SourceRecordID, SourceArtifactID: parsed.Artifact.ArtifactID}
		switch record.MappingStatus {
		case "MAPPED":
			normalized, reason := normalizeExchange(record, accountID, parsed.Artifact.ImportID, input)
			if reason != "" {
				outcome.Status, outcome.ReasonCode = "UNSUPPORTED", normalizationReason
				outcome.Reason = reason
				outcome.Evidence = &internalPointer
				break
			}
			outcome.Status = "NORMALIZED"
			for _, asset := range normalized.assets {
				assetsByID[asset.ID] = asset
			}
			observations = append(observations, normalized.observations...)
			links = append(links, normalized.links...)
		case "DUPLICATE":
			if record.CanonicalSourceRecordID == "" {
				return Result{}, errors.New("duplicate parser record has no canonical target")
			}
			outcome.Status, outcome.CanonicalSourceRecordID = "DUPLICATE", record.CanonicalSourceRecordID
		case "UNSUPPORTED", "ERROR", "NOT_RELEVANT":
			if record.ReasonCode == "" {
				return Result{}, errors.New("negative parser record has no reason code")
			}
			outcome.Status, outcome.ReasonCode = record.MappingStatus, record.ReasonCode
			outcome.Evidence = &internalPointer
		default:
			return Result{}, errors.New("parser mapping status is unsupported")
		}
		outcomes = append(outcomes, outcome)
		coverageRecords = append(coverageRecords, CoverageRecord{TaxYear: recordTaxYear(record, input.CoverageEnd), Status: outcome.Status})
	}
	for _, outcome := range outcomes {
		if outcome.Status == "DUPLICATE" {
			if _, exists := seen[outcome.CanonicalSourceRecordID]; !exists {
				return Result{}, errors.New("duplicate parser record targets an unknown record")
			}
		}
	}

	assets := make([]evidencestore.SubjectAsset, 0, len(assetsByID))
	for _, asset := range assetsByID {
		assets = append(assets, asset)
	}
	sortAssets(assets)
	normalizedCount := int64(0)
	for _, outcome := range outcomes {
		if outcome.Status == "NORMALIZED" {
			normalizedCount++
		}
	}
	terminalStatus := "COMPLETE"
	reasonCode := ""
	if normalizedCount != int64(len(records)) {
		terminalStatus, reasonCode = "PARTIAL", normalizationReason
	}
	var limitation *evidencestore.LimitationRef
	if terminalStatus == "PARTIAL" {
		limitation = &evidencestore.LimitationRef{ReasonCode: normalizationReason, Reason: "지원하지 않는 Upbit 거래 행이 포함되어 있습니다.", Evidence: internalPointer}
	}
	evidence := evidencestore.SourceEvidence{
		Accounts:                  []evidencestore.SubjectAccount{{ID: accountID, Kind: "CEX", Locator: "cex://upbit/account/" + digest([]byte(input.SubjectID))[:32], Venue: "UPBIT"}},
		Assets:                    assets,
		SourceArtifacts:           []evidencestore.SourceArtifact{{ID: parsed.Artifact.ArtifactID, Kind: "FILE", System: "UPBIT", ContentHashAlgorithm: "sha256", ContentHashValue: input.OriginalArtifact.Digest, Locator: input.OriginalArtifact.Locator, CoverageFrom: &coverageStart, CoverageTo: &coverageEnd, CoverageStatus: terminalStatus, Artifact: originalPointer, Collector: evidencestore.ProducerRef{Name: "daejang-web-upload", Version: "v1", Artifact: originalPointer}, CollectedAt: parsed.Artifact.CollectedAt.UTC()}},
		SourceRecords:             records,
		SourceExtractionRuns:      []evidencestore.ExtractionRun{{ID: parsed.Artifact.ImportID, SourceArtifactID: parsed.Artifact.ArtifactID, Status: terminalStatus, Producer: evidencestore.ProducerRef{Name: parsed.Producer.Name, Version: parsed.Producer.Version, Artifact: internalPointer}, CompletedAt: completedAt, Limitation: limitation}},
		SourceOutcomes:            outcomes,
		SourceOutcomeObservations: links,
		Observations:              observations,
	}
	projection, err := json.Marshal(evidence)
	if err != nil {
		return Result{}, err
	}
	manifest := rootManifest{SchemaVersion: "daejang.upbit-observation-evidence.v4", ProviderID: "UPBIT", DocumentType: parsed.Document.DocumentType, SourceArtifactDigest: input.OriginalArtifact.Digest, SourceDocumentHash: parsed.Artifact.ContentHash.Value, InternalEvidenceDigest: input.InternalArtifact.Digest, ProjectionDigest: digest(projection), RecordCount: int64(len(records)), NormalizedCount: normalizedCount, TerminalStatus: terminalStatus, ReasonCode: reasonCode, AssetScalePolicy: cexScalePolicy}
	root, err := json.Marshal(manifest)
	if err != nil {
		return Result{}, err
	}
	return Result{Evidence: evidence, RootArtifact: root, ResultDigest: digest(root), RecordCount: int64(len(records)), NormalizedCount: normalizedCount, TerminalStatus: terminalStatus, CoverageRecords: coverageRecords}, nil
}

func normalizeExchange(record internalRecord, accountID, runID string, input Input) (normalization, string) {
	p := record.Payload
	if p.RecordType != "EXCHANGE" {
		return normalization{}, "현재 지원하지 않는 Upbit 섹션입니다."
	}
	for _, value := range []sourceValue{p.EventAt, p.EventType, p.Asset, p.Quantity, p.GrossAmount, p.Fee, p.SettlementAmount} {
		if value.State != "PRESENT" || strings.TrimSpace(value.Raw) == "" {
			return normalization{}, "거래 필수 필드가 완전하지 않습니다."
		}
	}
	occurredAt, err := parseUpbitTime(p.EventAt.Raw)
	if err != nil {
		return normalization{}, "거래 시각을 해석할 수 없습니다."
	}
	occurredAt = occurredAt.UTC()
	eventType := p.EventType.Raw
	asset := p.Asset.Raw
	baseSymbol, quoteSymbol := asset, ""
	if eventType == "매수" || eventType == "매도" {
		parts := strings.Split(asset, "-")
		if len(parts) != 2 || parts[0] != "KRW" || !assetPattern.MatchString(parts[1]) {
			return normalization{}, "지원하는 KRW 마켓 자산 쌍이 아닙니다."
		}
		quoteSymbol, baseSymbol = parts[0], parts[1]
	} else if eventType != "입금" && eventType != "출금" {
		return normalization{}, "지원하지 않는 거래 유형입니다."
	}
	if !assetPattern.MatchString(baseSymbol) {
		return normalization{}, "자산 심볼을 해석할 수 없습니다."
	}
	baseDecimals := cexDocumentDecimals
	baseID := assetID(baseSymbol)
	assets := []evidencestore.SubjectAsset{assetDefinition(baseID, baseSymbol, baseDecimals)}
	activityClass := classifyActivity(eventType, baseSymbol, p.Description)
	makeObservation := func(local uint64, kind, symbol, quantity, semantic string, transfer *transferEndpointDetail) evidencestore.Observation {
		detail, _ := json.Marshal(observationDetail{AssetScalePolicy: cexScalePolicy, SchemaVersion: cexDetailSchema, Semantic: semantic, SourceCase: sourceCase(eventType), ActivityClass: activityClass, TransferEndpoint: transfer})
		id := "cex-observation:" + digest([]byte(runID + "\x00" + record.SourceRecordID + fmt.Sprintf("\x00%d", local)))[:32]
		at := occurredAt
		return evidencestore.Observation{ID: id, Domain: "CEX", Kind: kind, NativeID: record.SourceRecordID + ":" + strings.ToLower(semantic), AccountID: accountID, AssetID: assetID(symbol), Quantity: quantity, OccurredAt: &at, OriginKind: "SOURCE_RECORD", OriginLinkID: record.SourceRecordID, OriginRunID: runID, CoordinateJSON: json.RawMessage(fmt.Sprintf(`{"page":%d,"itemIndex":%d}`, record.Source.SourcePage, record.Source.SourceItemIndex)), LocalIndex: local, DetailJSON: detail}
	}
	observations := []evidencestore.Observation{}
	add := func(kind, symbol, quantity, semantic string, transfer *transferEndpointDetail) {
		observations = append(observations, makeObservation(uint64(len(observations)), kind, symbol, quantity, semantic, transfer))
	}
	switch eventType {
	case "매수", "매도":
		baseQuantity, ok := parseAmount(p.Quantity.Raw, baseSymbol, baseDecimals)
		if !ok || baseQuantity == "0" {
			return normalization{}, "거래 수량을 정확히 정규화할 수 없습니다."
		}
		grossAmount, ok := parseDecimalAmount(p.GrossAmount.Raw, quoteSymbol, cexDocumentDecimals)
		if !ok {
			return normalization{}, "KRW 거래금액을 정확히 정규화할 수 없습니다."
		}
		feeAmount, ok := parseDecimalAmount(p.Fee.Raw, quoteSymbol, cexDocumentDecimals)
		if !ok {
			return normalization{}, "KRW 거래 수수료를 정확히 정규화할 수 없습니다."
		}
		settlementQuantity, ok := parseAmount(p.SettlementAmount.Raw, quoteSymbol, cexDocumentDecimals)
		if !ok || settlementQuantity == "0" {
			return normalization{}, "KRW 정산금액을 정확히 정규화할 수 없습니다."
		}
		settlementAmount, _ := parseDecimalAmount(p.SettlementAmount.Raw, quoteSymbol, cexDocumentDecimals)
		if !tradeSettlementWithinDisplayedWon(eventType, grossAmount, feeAmount, settlementAmount) {
			return normalization{}, "KRW 거래금액·수수료·정산금액이 일치하지 않습니다."
		}
		quoteID := assetID(quoteSymbol)
		assets = append(assets, assetDefinition(quoteID, quoteSymbol, cexDocumentDecimals))
		grossQuantity, _ := parseAmount(p.GrossAmount.Raw, quoteSymbol, cexDocumentDecimals)
		feeQuantity, _ := parseAmount(p.Fee.Raw, quoteSymbol, cexDocumentDecimals)
		if eventType == "매수" {
			add("FILL", baseSymbol, baseQuantity, "BASE", nil)
			add("FILL", quoteSymbol, negate(grossQuantity), "QUOTE", nil)
		} else {
			add("FILL", baseSymbol, negate(baseQuantity), "BASE", nil)
			add("FILL", quoteSymbol, grossQuantity, "QUOTE", nil)
		}
		if feeQuantity != "0" {
			add("FEE", quoteSymbol, negate(feeQuantity), "FEE", nil)
		}
	case "입금":
		quantity, ok := parseAmount(p.Quantity.Raw, baseSymbol, baseDecimals)
		if !ok || quantity == "0" {
			return normalization{}, "입금 수량을 정확히 정규화할 수 없습니다."
		}
		gross, grossOK := parseAmount(p.GrossAmount.Raw, baseSymbol, baseDecimals)
		fee, feeOK := parseAmount(p.Fee.Raw, baseSymbol, baseDecimals)
		settlement, settlementOK := parseAmount(p.SettlementAmount.Raw, baseSymbol, baseDecimals)
		if !grossOK || !feeOK || !settlementOK || gross != quantity || fee != "0" || settlement != quantity {
			return normalization{}, "입금 수량·수수료·정산수량이 일치하지 않습니다."
		}
		endpoint := resolveTransferEndpoint(p, input)
		add("DEPOSIT", baseSymbol, quantity, "PRINCIPAL", &endpoint)
	case "출금":
		quantity, ok := parseAmount(p.Quantity.Raw, baseSymbol, baseDecimals)
		if !ok || quantity == "0" {
			return normalization{}, "출금 수량을 정확히 정규화할 수 없습니다."
		}
		gross, grossOK := parseAmount(p.GrossAmount.Raw, baseSymbol, baseDecimals)
		fee, ok := parseAmount(p.Fee.Raw, baseSymbol, baseDecimals)
		if !ok {
			return normalization{}, "출금 수수료를 정확히 정규화할 수 없습니다."
		}
		settlement, settlementOK := parseAmount(p.SettlementAmount.Raw, baseSymbol, baseDecimals)
		expectedSettlement, sumOK := addUnsigned(gross, fee)
		if !grossOK || !settlementOK || !sumOK || gross != quantity || settlement != expectedSettlement {
			return normalization{}, "출금 수량·수수료·정산수량이 일치하지 않습니다."
		}
		endpoint := resolveTransferEndpoint(p, input)
		add("WITHDRAWAL", baseSymbol, negate(quantity), "PRINCIPAL", &endpoint)
		if fee != "0" {
			add("FEE", baseSymbol, negate(fee), "FEE", nil)
		}
	}
	links := make([]evidencestore.SourceOutcomeObservation, len(observations))
	for i, observation := range observations {
		links[i] = evidencestore.SourceOutcomeObservation{ExtractionRunID: runID, SourceRecordID: record.SourceRecordID, ObservationID: observation.ID, Ordinal: uint32(i)}
	}
	return normalization{assets: assets, observations: observations, links: links}, ""
}

func classifyActivity(eventType, symbol string, description sourceValue) string {
	if description.State != "PRESENT" {
		return "UNSPECIFIED"
	}
	value := strings.Join(strings.Fields(description.Raw), " ")
	switch {
	case eventType == "입금" && symbol == "KRW" && value == "예치금 이용료":
		return "DEPOSIT_INTEREST"
	case eventType == "입금" && symbol == "KRW" && value == "원화":
		return "FIAT_DEPOSIT"
	case eventType == "출금" && symbol == "KRW" && value == "원화":
		return "FIAT_WITHDRAWAL"
	case eventType == "입금" && symbol != "KRW" && value == "디지털 자산 지급":
		return "AIRDROP"
	case (eventType == "입금" || eventType == "출금") && symbol != "KRW" && value == "디지털 자산":
		return "DIGITAL_ASSET_TRANSFER"
	default:
		return "UNSPECIFIED"
	}
}

func resolveTransferEndpoint(payload exchangePayload, input Input) transferEndpointDetail {
	if payload.WalletAddress.State == "PRESENT" && strings.TrimSpace(payload.WalletAddress.Raw) != "" {
		address := strings.TrimSpace(payload.WalletAddress.Raw)
		family, canonical := addressFamily(address)
		for _, wallet := range input.OwnedWallets {
			if wallet.Status != "ACTIVE" {
				continue
			}
			_, ownedCanonical := addressFamily(strings.TrimSpace(wallet.Address))
			if canonical == "" || ownedCanonical == "" || canonical != ownedCanonical {
				continue
			}
			chains := sortedUniqueStrings(wallet.ChainIDs)
			return transferEndpointDetail{
				Resolution:       "OWNED_REGISTERED",
				Kind:             "WALLET_ADDRESS",
				Display:          maskAddress(address),
				AddressFamily:    family,
				WalletSourceID:   wallet.SourceID,
				ChainCandidates:  chains,
				ConnectionStatus: "WALLET_OBSERVATION_PENDING",
				ReviewRequired:   true,
			}
		}
		return transferEndpointDetail{
			Resolution:       "EXTERNAL_KNOWN",
			Kind:             "WALLET_ADDRESS",
			Display:          maskAddress(address),
			AddressFamily:    family,
			ConnectionStatus: "EXTERNAL_COUNTERPARTY_REVIEW",
			ReviewRequired:   true,
		}
	}
	if payload.Counterparty.State == "PRESENT" && strings.TrimSpace(payload.Counterparty.Raw) != "" {
		if normalizedIdentity(payload.Counterparty.Raw) != "" &&
			normalizedIdentity(payload.Counterparty.Raw) == normalizedIdentity(input.ExpectedSubjectName) {
			return transferEndpointDetail{
				Resolution:       "OWNED_SUBJECT_NAME",
				Kind:             "PERSON_NAME",
				Display:          "본인",
				ConnectionStatus: "OWNERSHIP_MATCHED",
				ReviewRequired:   false,
			}
		}
		return transferEndpointDetail{
			Resolution:       "EXTERNAL_KNOWN",
			Kind:             "PERSON_NAME",
			Display:          "외부 상대방 정보 있음",
			ConnectionStatus: "EXTERNAL_COUNTERPARTY_REVIEW",
			ReviewRequired:   true,
		}
	}
	return transferEndpointDetail{
		Resolution:       "UNKNOWN",
		Kind:             "NONE",
		Display:          "확인 불가",
		ConnectionStatus: "COUNTERPARTY_REQUIRED",
		ReviewRequired:   true,
	}
}

func addressFamily(address string) (string, string) {
	switch {
	case evmAddressPattern.MatchString(address):
		return "EVM", strings.ToLower(address)
	case suiAddressPattern.MatchString(address):
		return "SUI", strings.ToLower(address)
	case tronAddressPattern.MatchString(address):
		return "TRON", address
	default:
		return "UNKNOWN", address
	}
}

func maskAddress(address string) string {
	if len(address) <= 8 {
		return "주소 확인됨"
	}
	if len(address) <= 14 {
		return address[:4] + "…" + address[len(address)-3:]
	}
	return address[:8] + "…" + address[len(address)-6:]
}

func normalizedIdentity(value string) string {
	return strings.ToLower(strings.Join(strings.Fields(value), ""))
}

func sortedUniqueStrings(values []string) []string {
	result := append([]string(nil), values...)
	sort.Strings(result)
	position := 0
	for _, value := range result {
		if position > 0 && result[position-1] == value {
			continue
		}
		result[position] = value
		position++
	}
	return result[:position]
}

func parseUpbitTime(value string) (time.Time, error) {
	parsed, err := time.ParseInLocation("2006-01-02 15:04:05", value, time.FixedZone("Asia/Seoul", 9*60*60))
	if err != nil {
		return time.Time{}, err
	}
	return parsed.UTC(), nil
}

func recordTaxYear(record internalRecord, coverageEnd time.Time) int32 {
	if record.Payload.EventAt.State == "PRESENT" {
		if occurredAt, err := parseUpbitTime(record.Payload.EventAt.Raw); err == nil {
			return int32(occurredAt.In(time.FixedZone("Asia/Seoul", 9*60*60)).Year())
		}
	}
	return int32(coverageEnd.In(time.FixedZone("Asia/Seoul", 9*60*60)).Year())
}

func sourceCase(eventType string) string {
	switch eventType {
	case "매수":
		return "BUY"
	case "매도":
		return "SELL"
	case "입금":
		return "DEPOSIT"
	case "출금":
		return "WITHDRAWAL"
	}
	return ""
}
func assetID(symbol string) string { return cexAssetNamespace + strings.ToLower(symbol) }
func assetDefinition(id, symbol string, decimals uint8) evidencestore.SubjectAsset {
	kind := "CEX_ASSET"
	venue := "UPBIT"
	if symbol == "KRW" {
		kind = "FIAT"
		venue = ""
	}
	d := decimals
	return evidencestore.SubjectAsset{ID: id, Kind: kind, Locator: "cex://upbit/document-asset/decimal8/" + symbol, Symbol: symbol, Decimals: &d, Venue: venue}
}
func parseAmount(raw, symbol string, decimals uint8) (string, bool) {
	m := amountPattern.FindStringSubmatch(raw)
	if m == nil || m[2] != symbol {
		return "", false
	}
	value := strings.ReplaceAll(m[1], ",", "")
	parts := strings.Split(value, ".")
	if len(parts) > 2 || len(parts) == 2 && len(parts[1]) > int(decimals) {
		return "", false
	}
	fraction := ""
	if len(parts) == 2 {
		fraction = parts[1]
	}
	digits := strings.TrimLeft(parts[0]+fraction+strings.Repeat("0", int(decimals)-len(fraction)), "0")
	if digits == "" {
		digits = "0"
	}
	return digits, true
}
func negate(value string) string {
	if value == "0" {
		return value
	}
	return "-" + value
}
func addUnsigned(left, right string) (string, bool) {
	l, leftOK := new(big.Int).SetString(left, 10)
	r, rightOK := new(big.Int).SetString(right, 10)
	if !leftOK || !rightOK || l.Sign() < 0 || r.Sign() < 0 {
		return "", false
	}
	return new(big.Int).Add(l, r).String(), true
}
func parseDecimalAmount(raw, symbol string, maxDecimals uint8) (*big.Rat, bool) {
	m := amountPattern.FindStringSubmatch(raw)
	if m == nil || m[2] != symbol {
		return nil, false
	}
	value := strings.ReplaceAll(m[1], ",", "")
	parts := strings.Split(value, ".")
	if len(parts) > 2 || len(parts) == 2 && len(parts[1]) > int(maxDecimals) {
		return nil, false
	}
	parsed, ok := new(big.Rat).SetString(value)
	if !ok || parsed.Sign() < 0 {
		return nil, false
	}
	return parsed, true
}
func tradeSettlementWithinDisplayedWon(eventType string, gross, fee, settlement *big.Rat) bool {
	if gross == nil || fee == nil || settlement == nil {
		return false
	}
	expected := new(big.Rat)
	if eventType == "매수" {
		expected.Add(gross, fee)
	} else {
		expected.Sub(gross, fee)
	}
	if expected.Sign() < 0 {
		return false
	}
	difference := new(big.Rat).Sub(settlement, expected)
	difference.Abs(difference)
	return difference.Cmp(big.NewRat(1, 1)) <= 0
}
func sortAssets(values []evidencestore.SubjectAsset) {
	for i := 1; i < len(values); i++ {
		for j := i; j > 0 && values[j].ID < values[j-1].ID; j-- {
			values[j], values[j-1] = values[j-1], values[j]
		}
	}
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
func digest(value []byte) string { sum := sha256.Sum256(value); return hex.EncodeToString(sum[:]) }
func dateOnly(value time.Time) time.Time {
	year, month, day := value.Date()
	return time.Date(year, month, day, 0, 0, 0, 0, time.UTC)
}
