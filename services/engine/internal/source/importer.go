package source

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/BackwardLabs/daejang-db/pkg/artifactstore"
	"github.com/BackwardLabs/daejang-db/pkg/evidencestore"
	"github.com/BackwardLabs/daejang-db/pkg/sourcejobstore"
	"github.com/BackwardLabs/daejang/services/engine/internal/pdfparser"
	"github.com/BackwardLabs/daejang/services/engine/internal/upbitnormalizer"
)

const defaultImportLeaseDuration = 2 * time.Minute

type UpbitDocumentImportParams struct {
	SubjectID, IdempotencyKey, UploadID, ObjectKey, ArtifactDigest string
	OriginalFilename, MediaType, ExpectedSubjectName               string
	ByteLength                                                     int64
	CoverageStart, CoverageEnd                                     time.Time
	EncryptedOriginalPDF, PDFPasswordUTF8                          []byte
}

type UpbitDocumentImportResult struct {
	Document               sourcejobstore.DocumentSource
	Job                    sourcejobstore.SyncJob
	EvidenceTerminalStatus string
	SourceRecordCount      int64
	NormalizedRecordCount  int64
}

type DocumentImportError struct{ Code string }

func (e *DocumentImportError) Error() string { return e.Code }

type DocumentImportJobs interface {
	RegisterAndClaimDocumentImport(context.Context, sourcejobstore.RegisterDocumentImportParams, time.Duration) (sourcejobstore.DocumentImportClaim, error)
	Complete(context.Context, sourcejobstore.SyncJob, sourcejobstore.Progress) error
	FailDocumentImport(context.Context, sourcejobstore.SyncJob, string, string) error
	GetDocument(context.Context, string, string) (sourcejobstore.DocumentSource, bool, error)
	GetJob(context.Context, string, string) (sourcejobstore.SyncJob, error)
}

type DocumentImportArtifacts interface {
	Put(context.Context, []byte, artifactstore.PutOptions) (artifactstore.Ref, error)
}

type DocumentImportEvidence interface {
	PublishSourceEvidence(context.Context, evidencestore.PublishSourceEvidenceParams) (evidencestore.Fragment, error)
}

type DocumentImportWallets interface {
	ListWallets(context.Context, string) ([]WalletSource, error)
}

type DocumentParser interface {
	Parse(context.Context, pdfparser.Request) (pdfparser.Result, error)
}

type DocumentImporter struct {
	Jobs          DocumentImportJobs
	Artifacts     DocumentImportArtifacts
	Evidence      DocumentImportEvidence
	Parser        DocumentParser
	Wallets       DocumentImportWallets
	LeaseDuration time.Duration
	Now           func() time.Time
}

func (i *DocumentImporter) ImportUpbitDocument(ctx context.Context, params UpbitDocumentImportParams) (UpbitDocumentImportResult, error) {
	encrypted := params.EncryptedOriginalPDF
	password := params.PDFPasswordUTF8
	defer clear(encrypted)
	defer clear(password)
	if i == nil || i.Jobs == nil || i.Artifacts == nil || i.Evidence == nil || i.Parser == nil {
		return UpbitDocumentImportResult{}, errors.New("document importer dependencies are required")
	}
	leaseDuration := i.LeaseDuration
	if leaseDuration <= 0 {
		leaseDuration = defaultImportLeaseDuration
	}
	now := time.Now
	if i.Now != nil {
		now = i.Now
	}
	documentID := stableImportUUID(params.SubjectID, "UPBIT\x00"+params.ArtifactDigest)
	jobID := stableImportUUID(params.SubjectID, params.IdempotencyKey)
	completed, found, err := i.completedExactImport(ctx, params, documentID, jobID)
	if err != nil {
		return UpbitDocumentImportResult{}, err
	}
	if found {
		return completed, nil
	}
	parsed, err := i.Parser.Parse(ctx, pdfparser.Request{
		PDF: encrypted, Password: password, ArtifactID: documentID, ImportID: jobID,
		SubjectRef: pseudonymousSubjectRef(params.SubjectID), CollectedAt: now().UTC(),
		ExpectedSubjectName: params.ExpectedSubjectName,
	})
	if err != nil {
		code := "PARSER_FAILED"
		var parserError *pdfparser.Error
		if errors.As(err, &parserError) {
			code = parserError.Code
		}
		return UpbitDocumentImportResult{}, &DocumentImportError{Code: code}
	}
	ownedWallets, err := i.loadOwnedWallets(ctx, params.SubjectID)
	if err != nil {
		return UpbitDocumentImportResult{}, &DocumentImportError{Code: "WALLET_SOURCE_LOOKUP_FAILED"}
	}

	claim, err := i.Jobs.RegisterAndClaimDocumentImport(ctx, sourcejobstore.RegisterDocumentImportParams{
		Document: sourcejobstore.RegisterDocumentParams{
			SubjectID: params.SubjectID, UploadID: params.UploadID, ObjectKey: params.ObjectKey,
			ArtifactDigest: params.ArtifactDigest, OriginalFilename: params.OriginalFilename,
			MediaType: params.MediaType, ByteLength: params.ByteLength,
			CoverageStart: params.CoverageStart, CoverageEnd: params.CoverageEnd,
		},
		RequestedCoverageStart: params.CoverageStart, RequestedCoverageEnd: params.CoverageEnd,
		Trigger: "USER_REQUEST", IdempotencyKey: params.IdempotencyKey,
	}, leaseDuration)
	if err != nil {
		return UpbitDocumentImportResult{}, err
	}
	if claim.Document.ID != documentID || claim.Job.ID != jobID {
		return UpbitDocumentImportResult{}, errors.New("document import identity does not match parser context")
	}
	if claim.Job.State == "SUCCEEDED" {
		return completedImportResult(claim.Document, claim.Job), nil
	}
	if claim.Job.State != "RUNNING" || claim.Job.LeaseToken == "" {
		return UpbitDocumentImportResult{}, errors.New("document import claim is not leased")
	}

	fail := func(code, message string, cause error) (UpbitDocumentImportResult, error) {
		failCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		if failErr := i.Jobs.FailDocumentImport(failCtx, claim.Job, code, message); failErr != nil {
			return UpbitDocumentImportResult{}, fmt.Errorf("%s; mark import failed: %w", code, failErr)
		}
		if cause != nil {
			return UpbitDocumentImportResult{}, cause
		}
		return UpbitDocumentImportResult{}, &DocumentImportError{Code: code}
	}

	originalRef, err := i.Artifacts.Put(ctx, params.EncryptedOriginalPDF, privateArtifact("application/pdf"))
	if err != nil {
		return UpbitDocumentImportResult{}, &DocumentImportError{Code: "ORIGINAL_ARTIFACT_STORE_FAILED"}
	}
	internalRef, err := i.Artifacts.Put(ctx, parsed.InternalEvidence, privateArtifact(privateParserEvidenceMediaType))
	if err != nil {
		return UpbitDocumentImportResult{}, &DocumentImportError{Code: "INTERNAL_EVIDENCE_STORE_FAILED"}
	}
	normalized, err := upbitnormalizer.Prepare(upbitnormalizer.Input{
		SubjectID: params.SubjectID, CoverageStart: params.CoverageStart, CoverageEnd: params.CoverageEnd,
		OriginalArtifact: originalRef, InternalArtifact: internalRef, InternalEvidence: parsed.InternalEvidence,
		ExpectedSubjectName: params.ExpectedSubjectName, OwnedWallets: ownedWallets,
	})
	if err != nil {
		return fail("NORMALIZATION_FAILED", "UPBIT evidence normalization failed", errors.New("normalize parser evidence"))
	}
	rootRef, err := i.Artifacts.Put(ctx, normalized.RootArtifact, privateArtifact("application/json"))
	if err != nil {
		return UpbitDocumentImportResult{}, &DocumentImportError{Code: "ROOT_ARTIFACT_STORE_FAILED"}
	}
	if rootRef.Digest != normalized.ResultDigest {
		return fail("ROOT_ARTIFACT_DIGEST_MISMATCH", "Evidence manifest digest did not match", errors.New("evidence manifest digest mismatch"))
	}

	fragmentID := stableImportUUID(params.SubjectID, "upbit-fragment\x00"+claim.Job.ID)
	generationID := stableImportUUID(params.SubjectID, "upbit-generation\x00"+claim.Job.ID)
	finalizeDuration := 30 * time.Second
	if claim.Job.LeaseExpiresAt != nil {
		remaining := time.Until(*claim.Job.LeaseExpiresAt) - time.Second
		if remaining <= 0 {
			return UpbitDocumentImportResult{}, &DocumentImportError{Code: "IMPORT_LEASE_EXPIRED"}
		}
		if remaining < finalizeDuration {
			finalizeDuration = remaining
		}
	}
	finalizeCtx, cancelFinalize := context.WithTimeout(context.WithoutCancel(ctx), finalizeDuration)
	defer cancelFinalize()
	fragment, err := i.Evidence.PublishSourceEvidence(finalizeCtx, evidencestore.PublishSourceEvidenceParams{
		SubjectID: params.SubjectID, FragmentID: fragmentID, ProducerRunID: claim.Job.ID,
		GenerationID: generationID, ArtifactDigest: rootRef.Digest, ResultDigest: normalized.ResultDigest,
		SchemaDigest: upbitnormalizer.SchemaDigest, ProducerName: upbitnormalizer.ProducerName,
		ProducerVersion: upbitnormalizer.ProducerVersion, TerminalStatus: normalized.TerminalStatus, Evidence: normalized.Evidence,
	})
	if err != nil {
		// Publication may have committed before a transport response was lost. Keep
		// the lease reclaimable so an exact idempotent retry can verify publication
		// and close the job instead of creating a published/FAILED split state.
		return UpbitDocumentImportResult{}, &DocumentImportError{Code: "EVIDENCE_PUBLICATION_FAILED"}
	}
	total := normalized.RecordCount
	if err := i.Jobs.Complete(finalizeCtx, claim.Job, sourcejobstore.Progress{
		Phase: "COMPLETE", ProcessedRecords: normalized.NormalizedCount, TotalRecords: &total,
		OutputFragmentID: fragment.FragmentID, ExpectedVersion: claim.Job.ProgressVersion,
	}); err != nil {
		return UpbitDocumentImportResult{}, errors.New("complete published document import")
	}
	completedJob, err := i.Jobs.GetJob(finalizeCtx, params.SubjectID, claim.Job.ID)
	if err != nil {
		return UpbitDocumentImportResult{}, errors.New("load completed document import")
	}
	return UpbitDocumentImportResult{
		Document: claim.Document, Job: completedJob, EvidenceTerminalStatus: normalized.TerminalStatus,
		SourceRecordCount: normalized.RecordCount, NormalizedRecordCount: normalized.NormalizedCount,
	}, nil
}

func (i *DocumentImporter) loadOwnedWallets(ctx context.Context, subjectID string) ([]upbitnormalizer.OwnedWalletSnapshot, error) {
	if i.Wallets == nil {
		return nil, nil
	}
	values, err := i.Wallets.ListWallets(ctx, subjectID)
	if err != nil {
		return nil, err
	}
	result := make([]upbitnormalizer.OwnedWalletSnapshot, 0, len(values))
	for _, value := range values {
		if value.Status != "ACTIVE" {
			continue
		}
		chains := make([]string, 0, len(value.ChainScopes))
		for _, scope := range value.ChainScopes {
			if scope.Status == "ACTIVE" {
				chains = append(chains, scope.ChainID)
			}
		}
		result = append(result, upbitnormalizer.OwnedWalletSnapshot{
			SourceID: value.ID, Address: value.Address, Status: value.Status, ChainIDs: chains,
		})
	}
	return result, nil
}

func (i *DocumentImporter) completedExactImport(
	ctx context.Context,
	params UpbitDocumentImportParams,
	documentID, jobID string,
) (UpbitDocumentImportResult, bool, error) {
	job, err := i.Jobs.GetJob(ctx, params.SubjectID, jobID)
	if errors.Is(err, sourcejobstore.ErrJobNotFound) {
		return UpbitDocumentImportResult{}, false, nil
	}
	if err != nil {
		return UpbitDocumentImportResult{}, false, fmt.Errorf("load existing document import: %w", err)
	}
	if job.State != "SUCCEEDED" {
		return UpbitDocumentImportResult{}, false, nil
	}
	if !sameCompletedImportJob(job, params, documentID, jobID) {
		return UpbitDocumentImportResult{}, false, sourcejobstore.ErrImmutableIdentityMismatch
	}
	document, found, err := i.Jobs.GetDocument(ctx, params.SubjectID, documentID)
	if err != nil {
		return UpbitDocumentImportResult{}, false, fmt.Errorf("load completed document import source: %w", err)
	}
	if !found {
		return UpbitDocumentImportResult{}, false, sourcejobstore.ErrSourceNotFound
	}
	if !sameCompletedImportDocument(document, params, documentID) {
		return UpbitDocumentImportResult{}, false, sourcejobstore.ErrImmutableIdentityMismatch
	}
	return completedImportResult(document, job), true, nil
}

func sameCompletedImportJob(
	job sourcejobstore.SyncJob,
	params UpbitDocumentImportParams,
	documentID, jobID string,
) bool {
	return job.ID == jobID && job.SubjectID == params.SubjectID &&
		job.SourceKind == "UPBIT_PDF" && job.SourceID == documentID &&
		job.Trigger == "USER_REQUEST" && job.IdempotencyKey == params.IdempotencyKey &&
		job.RequestedCoverageStart != nil && sameImportDate(*job.RequestedCoverageStart, params.CoverageStart) &&
		job.RequestedCoverageEnd != nil && sameImportDate(*job.RequestedCoverageEnd, params.CoverageEnd)
}

func sameCompletedImportDocument(
	document sourcejobstore.DocumentSource,
	params UpbitDocumentImportParams,
	documentID string,
) bool {
	return document.ID == documentID && document.SubjectID == params.SubjectID && document.Provider == "UPBIT" &&
		document.UploadID == params.UploadID && document.ObjectKey == params.ObjectKey &&
		document.ArtifactDigest == params.ArtifactDigest && document.OriginalFilename == params.OriginalFilename &&
		document.MediaType == params.MediaType && document.ByteLength == params.ByteLength &&
		sameImportDate(document.CoverageStart, params.CoverageStart) &&
		sameImportDate(document.CoverageEnd, params.CoverageEnd)
}

func sameImportDate(left, right time.Time) bool {
	if left.IsZero() || right.IsZero() {
		return left.IsZero() && right.IsZero()
	}
	left, right = left.UTC(), right.UTC()
	return left.Year() == right.Year() && left.Month() == right.Month() && left.Day() == right.Day()
}

func completedImportResult(document sourcejobstore.DocumentSource, job sourcejobstore.SyncJob) UpbitDocumentImportResult {
	sourceCount := int64(0)
	if job.TotalRecords != nil {
		sourceCount = *job.TotalRecords
	}
	terminalStatus := "PARTIAL"
	if job.TotalRecords != nil && job.ProcessedRecords == *job.TotalRecords {
		terminalStatus = "COMPLETE"
	}
	return UpbitDocumentImportResult{
		Document: document, Job: job, EvidenceTerminalStatus: terminalStatus,
		SourceRecordCount: sourceCount, NormalizedRecordCount: job.ProcessedRecords,
	}
}

func privateArtifact(mediaType string) artifactstore.PutOptions {
	return artifactstore.PutOptions{
		MediaType: mediaType, Retention: artifactstore.RetentionSubjectPrivate, Privacy: artifactstore.PrivacySubjectPrivate,
	}
}

func pseudonymousSubjectRef(subjectID string) string {
	sum := sha256.Sum256([]byte("upbit-subject\x00" + subjectID))
	return "subject:sha256:" + hex.EncodeToString(sum[:])
}

func stableImportUUID(subjectID, identity string) string {
	sum := sha256.Sum256([]byte(subjectID + "\x00" + identity))
	value := sum[:16]
	value[6] = (value[6] & 0x0f) | 0x50
	value[8] = (value[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		value[0:4], value[4:6], value[6:8], value[8:10], value[10:16])
}
