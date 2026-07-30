package source

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/BackwardLabs/daejang-db/pkg/artifactstore"
	"github.com/BackwardLabs/daejang-db/pkg/evidencestore"
	"github.com/BackwardLabs/daejang-db/pkg/sourcejobstore"
	"github.com/BackwardLabs/daejang/services/engine/internal/pdfparser"
)

const (
	testSubjectID = "00000000-0000-4000-8000-000000000001"
	testUploadID  = "00000000-0000-4000-8000-000000000003"
	testSourceID  = "00000000-0000-4000-8000-000000000004"
	testJobID     = "00000000-0000-4000-8000-000000000005"
)

type importJobFake struct {
	claim            sourcejobstore.DocumentImportClaim
	completed        sourcejobstore.SyncJob
	jobLookup        sourcejobstore.SyncJob
	jobLookupErr     error
	documentLookup   sourcejobstore.DocumentSource
	documentFound    bool
	documentErr      error
	failedCode       string
	complete         sourcejobstore.Progress
	published        *bool
	claimCalls       int
	getDocumentCalls int
	getJobCalls      int
	completeCalled   bool
}

func (f *importJobFake) RegisterAndClaimDocumentImport(_ context.Context, _ sourcejobstore.RegisterDocumentImportParams, _ time.Duration) (sourcejobstore.DocumentImportClaim, error) {
	f.claimCalls++
	return f.claim, nil
}

func (f *importJobFake) Complete(_ context.Context, _ sourcejobstore.SyncJob, progress sourcejobstore.Progress) error {
	if f.published != nil && !*f.published {
		return errors.New("completion happened before publication")
	}
	f.completeCalled, f.complete = true, progress
	return nil
}

func (f *importJobFake) FailDocumentImport(_ context.Context, _ sourcejobstore.SyncJob, code, _ string) error {
	f.failedCode = code
	return nil
}

func (f *importJobFake) GetDocument(context.Context, string, string) (sourcejobstore.DocumentSource, bool, error) {
	f.getDocumentCalls++
	return f.documentLookup, f.documentFound, f.documentErr
}

func (f *importJobFake) GetJob(context.Context, string, string) (sourcejobstore.SyncJob, error) {
	f.getJobCalls++
	if f.jobLookupErr != nil {
		return sourcejobstore.SyncJob{}, f.jobLookupErr
	}
	if f.jobLookup.ID != "" {
		return f.jobLookup, nil
	}
	if f.completeCalled && f.completed.ID != "" {
		return f.completed, nil
	}
	return sourcejobstore.SyncJob{}, sourcejobstore.ErrJobNotFound
}

type artifactPut struct {
	value   []byte
	options artifactstore.PutOptions
}

type importArtifactFake struct{ puts []artifactPut }

func (f *importArtifactFake) Put(_ context.Context, value []byte, options artifactstore.PutOptions) (artifactstore.Ref, error) {
	copyValue := append([]byte(nil), value...)
	f.puts = append(f.puts, artifactPut{value: copyValue, options: options})
	digest := digestBytes(value)
	return artifactstore.Ref{Algorithm: "sha256", Digest: digest, Locator: "artifact://sha256/" + digest}, nil
}

type importEvidenceFake struct {
	published bool
	params    evidencestore.PublishSourceEvidenceParams
	err       error
}

func (f *importEvidenceFake) PublishSourceEvidence(_ context.Context, params evidencestore.PublishSourceEvidenceParams) (evidencestore.Fragment, error) {
	f.published, f.params = true, params
	if f.err != nil {
		return evidencestore.Fragment{}, f.err
	}
	return evidencestore.Fragment{FragmentID: params.FragmentID, TerminalStatus: params.TerminalStatus}, nil
}

type importParserFake struct {
	result pdfparser.Result
	err    error
	calls  int
	inputs []pdfparser.Request
}

func (f *importParserFake) Parse(_ context.Context, input pdfparser.Request) (pdfparser.Result, error) {
	f.calls++
	f.inputs = append(f.inputs, input)
	return f.result, f.err
}

func TestDocumentImporterPublishesPartialEvidenceBeforeCompletingJob(t *testing.T) {
	now := time.Date(2026, 7, 29, 1, 2, 3, 0, time.UTC)
	claim := runningImportClaim(now)
	evidence := &importEvidenceFake{}
	jobs := &importJobFake{claim: claim, published: &evidence.published}
	completed := claim.Job
	completed.State, completed.Phase = "SUCCEEDED", "COMPLETE"
	jobs.completed = completed
	artifacts := &importArtifactFake{}
	internal := testInternalEvidence(t, now, claim.Document.ID, claim.Job.ID)
	parser := &importParserFake{result: pdfparser.Result{InternalEvidence: internal}}
	original := []byte("%PDF-1.7 encrypted-original")
	password := []byte("transient-password")
	passwordSnapshot := append([]byte(nil), password...)
	params := testImportParams(original, password, now)

	result, err := (&DocumentImporter{
		Jobs: jobs, Artifacts: artifacts, Evidence: evidence, Parser: parser, Now: func() time.Time { return now },
	}).ImportUpbitDocument(context.Background(), params)
	if err != nil {
		t.Fatal(err)
	}
	if !evidence.published || !jobs.completeCalled || jobs.complete.OutputFragmentID == "" {
		t.Fatalf("publication/complete boundary was not closed: evidence=%t progress=%#v", evidence.published, jobs.complete)
	}
	if result.EvidenceTerminalStatus != "PARTIAL" || result.SourceRecordCount != 1 || result.NormalizedRecordCount != 0 {
		t.Fatalf("unexpected safe result: %#v", result)
	}
	if evidence.params.TerminalStatus != "PARTIAL" || len(evidence.params.Evidence.Observations) != 0 ||
		len(evidence.params.Evidence.SourceOutcomes) != 1 || evidence.params.Evidence.SourceOutcomes[0].Status != "UNSUPPORTED" {
		t.Fatalf("unsafe source evidence was published: %#v", evidence.params)
	}
	if len(artifacts.puts) != 3 {
		t.Fatalf("expected encrypted original, internal evidence, and root manifest; got %d", len(artifacts.puts))
	}
	if artifacts.puts[1].options.MediaType != privateParserEvidenceMediaType {
		t.Fatalf("restricted parser evidence did not use the encrypted media boundary: %#v", artifacts.puts[1].options)
	}
	for _, put := range artifacts.puts {
		if put.options.Privacy != artifactstore.PrivacySubjectPrivate || put.options.Retention != artifactstore.RetentionSubjectPrivate {
			t.Fatalf("artifact escaped subject-private storage: %#v", put.options)
		}
		if bytes.Equal(put.value, passwordSnapshot) {
			t.Fatal("PDF password was persisted as an artifact")
		}
	}
	if !allZero(original) || !allZero(password) {
		t.Fatal("PDF request buffers were not zeroized")
	}
}

func TestDocumentImporterRejectsParserFailureBeforeCreatingDurableState(t *testing.T) {
	now := time.Date(2026, 7, 29, 1, 2, 3, 0, time.UTC)
	jobs := &importJobFake{claim: runningImportClaim(now)}
	parser := &importParserFake{err: &pdfparser.Error{Code: "SUBJECT_MISMATCH"}}
	artifacts := &importArtifactFake{}
	password := []byte("transient-password")
	_, err := (&DocumentImporter{Jobs: jobs, Artifacts: artifacts, Evidence: &importEvidenceFake{}, Parser: parser}).ImportUpbitDocument(
		context.Background(), testImportParams([]byte("%PDF-1.7 encrypted-original"), password, now),
	)
	var importError *DocumentImportError
	if !errors.As(err, &importError) || importError.Code != "SUBJECT_MISMATCH" {
		t.Fatalf("parser failure was not safely returned: err=%v", err)
	}
	if jobs.claimCalls != 0 || jobs.failedCode != "" {
		t.Fatal("parser failure created durable source or job state")
	}
	if len(artifacts.puts) != 0 || !allZero(password) {
		t.Fatal("parser failure persisted or retained PDF password bytes")
	}
}

func TestDocumentImporterReturnsSucceededIdempotentResultWithoutArtifactReprocessing(t *testing.T) {
	now := time.Date(2026, 7, 29, 1, 2, 3, 0, time.UTC)
	claim := runningImportClaim(now)
	total := int64(7)
	claim.Job.State, claim.Job.Phase, claim.Job.LeaseToken = "SUCCEEDED", "COMPLETE", ""
	claim.Job.TotalRecords, claim.Job.ProcessedRecords, claim.Job.OutputFragmentID = &total, 0, "fragment-1"
	jobs := &importJobFake{
		jobLookup: claim.Job, documentLookup: claim.Document, documentFound: true,
	}
	parser, artifacts, evidence := &importParserFake{}, &importArtifactFake{}, &importEvidenceFake{}
	password := []byte("transient-password")
	result, err := (&DocumentImporter{Jobs: jobs, Artifacts: artifacts, Evidence: evidence, Parser: parser}).ImportUpbitDocument(
		context.Background(), testImportParams([]byte("%PDF-1.7 encrypted-original"), password, now),
	)
	if err != nil {
		t.Fatal(err)
	}
	if jobs.getJobCalls != 1 || jobs.getDocumentCalls != 1 {
		t.Fatalf("completed replay did not read exact persisted identity: jobs=%d documents=%d", jobs.getJobCalls, jobs.getDocumentCalls)
	}
	if parser.calls != 0 || jobs.claimCalls != 0 || len(artifacts.puts) != 0 || evidence.published || jobs.completeCalled {
		t.Fatal("idempotent terminal import did not return before parsing or durable mutation")
	}
	if result.SourceRecordCount != total || result.EvidenceTerminalStatus != "PARTIAL" || !allZero(password) {
		t.Fatalf("unexpected idempotent result: %#v", result)
	}
}

func TestCompletedImportResultPreservesCompleteTerminalStatus(t *testing.T) {
	total := int64(7)
	result := completedImportResult(sourcejobstore.DocumentSource{}, sourcejobstore.SyncJob{
		State: "SUCCEEDED", TotalRecords: &total, ProcessedRecords: total,
	})
	if result.EvidenceTerminalStatus != "COMPLETE" || result.SourceRecordCount != total || result.NormalizedRecordCount != total {
		t.Fatalf("completed replay changed terminal result: %#v", result)
	}
}

func TestDocumentImporterRejectsMismatchedSucceededIdentityBeforeParsing(t *testing.T) {
	now := time.Date(2026, 7, 29, 1, 2, 3, 0, time.UTC)
	claim := runningImportClaim(now)
	claim.Job.State, claim.Job.Phase, claim.Job.LeaseToken = "SUCCEEDED", "COMPLETE", ""
	claim.Job.OutputFragmentID = "fragment-1"
	claim.Document.ObjectKey = "private/other.pdf"
	jobs := &importJobFake{
		jobLookup: claim.Job, documentLookup: claim.Document, documentFound: true,
	}
	parser := &importParserFake{}
	password := []byte("transient-password")
	_, err := (&DocumentImporter{
		Jobs: jobs, Artifacts: &importArtifactFake{}, Evidence: &importEvidenceFake{}, Parser: parser,
	}).ImportUpbitDocument(
		context.Background(), testImportParams([]byte("%PDF-1.7 encrypted-original"), password, now),
	)
	if !errors.Is(err, sourcejobstore.ErrImmutableIdentityMismatch) {
		t.Fatalf("mismatched completed identity returned unexpected error: %v", err)
	}
	if parser.calls != 0 || jobs.claimCalls != 0 || !allZero(password) {
		t.Fatal("mismatched completed identity reached parsing or durable mutation")
	}
}

func TestDocumentImporterAllowsCorrectPasswordAfterRejectedPassword(t *testing.T) {
	now := time.Date(2026, 7, 29, 1, 2, 3, 0, time.UTC)
	claim := runningImportClaim(now)
	jobs := &importJobFake{claim: claim}
	completed := claim.Job
	completed.State, completed.Phase = "SUCCEEDED", "COMPLETE"
	jobs.completed = completed
	evidence := &importEvidenceFake{}
	jobs.published = &evidence.published
	parser := &importParserFake{err: &pdfparser.Error{Code: "PDF_PASSWORD_INVALID"}}
	importer := &DocumentImporter{
		Jobs: jobs, Artifacts: &importArtifactFake{}, Evidence: evidence,
		Parser: parser, Now: func() time.Time { return now },
	}

	_, err := importer.ImportUpbitDocument(
		context.Background(),
		testImportParams(
			[]byte("%PDF-1.7 encrypted-original"),
			[]byte("wrong-password"),
			now,
		),
	)
	var importError *DocumentImportError
	if !errors.As(err, &importError) || importError.Code != "PDF_PASSWORD_INVALID" {
		t.Fatalf("wrong password returned unexpected error: %v", err)
	}
	if jobs.claimCalls != 0 {
		t.Fatal("wrong password created a durable import claim")
	}

	parser.err = nil
	parser.result = pdfparser.Result{
		InternalEvidence: testInternalEvidence(t, now, claim.Document.ID, claim.Job.ID),
	}
	result, err := importer.ImportUpbitDocument(
		context.Background(),
		testImportParams(
			[]byte("%PDF-1.7 encrypted-original"),
			[]byte("correct-password"),
			now,
		),
	)
	if err != nil {
		t.Fatal(err)
	}
	if jobs.claimCalls != 1 || result.Job.State != "SUCCEEDED" {
		t.Fatalf("corrected password did not complete import: %#v", result)
	}
}

func TestDocumentImporterLeavesAmbiguousPublicationReclaimable(t *testing.T) {
	now := time.Date(2026, 7, 29, 1, 2, 3, 0, time.UTC)
	claim := runningImportClaim(now)
	jobs := &importJobFake{claim: claim}
	evidence := &importEvidenceFake{err: errors.New("response lost")}
	internal := testInternalEvidence(t, now, claim.Document.ID, claim.Job.ID)
	password := []byte("transient-password")
	_, err := (&DocumentImporter{
		Jobs: jobs, Artifacts: &importArtifactFake{}, Evidence: evidence,
		Parser: &importParserFake{result: pdfparser.Result{InternalEvidence: internal}}, Now: func() time.Time { return now },
	}).ImportUpbitDocument(context.Background(), testImportParams([]byte("%PDF-1.7 encrypted-original"), password, now))
	var importError *DocumentImportError
	if !errors.As(err, &importError) || importError.Code != "EVIDENCE_PUBLICATION_FAILED" {
		t.Fatalf("unexpected publication error: %v", err)
	}
	if jobs.failedCode != "" || jobs.completeCalled || !allZero(password) {
		t.Fatal("ambiguous publication was terminalized instead of left for exact lease reclaim")
	}
}

func runningImportClaim(now time.Time) sourcejobstore.DocumentImportClaim {
	coverageStart, coverageEnd := now.AddDate(0, -1, 0), now
	originalDigest := digestBytes([]byte("%PDF-1.7 encrypted-original"))
	sourceID := stableImportUUID(testSubjectID, "UPBIT\x00"+originalDigest)
	jobID := stableImportUUID(testSubjectID, "import-test")
	return sourcejobstore.DocumentImportClaim{
		Document: sourcejobstore.DocumentSource{
			ID: sourceID, SubjectID: testSubjectID, Provider: "UPBIT", UploadID: testUploadID,
			ObjectKey: "private/test.pdf", ArtifactDigest: originalDigest, ByteLength: int64(len("%PDF-1.7 encrypted-original")),
			OriginalFilename: "statement.pdf", MediaType: "application/pdf", CoverageStart: coverageStart,
			CoverageEnd: coverageEnd, Status: "ACTIVE", CreatedAt: now, UpdatedAt: now,
		},
		Job: sourcejobstore.SyncJob{
			ID: jobID, SubjectID: testSubjectID, SourceKind: "UPBIT_PDF", SourceID: sourceID,
			RequestedCoverageStart: &coverageStart, RequestedCoverageEnd: &coverageEnd,
			Trigger: "USER_REQUEST", IdempotencyKey: "import-test",
			State: "RUNNING", LeaseToken: "lease-token", ProgressVersion: 0, CreatedAt: now, UpdatedAt: now,
		},
	}
}

func testImportParams(original, password []byte, now time.Time) UpbitDocumentImportParams {
	return UpbitDocumentImportParams{
		SubjectID: testSubjectID, IdempotencyKey: "import-test", UploadID: testUploadID, ObjectKey: "private/test.pdf",
		ArtifactDigest: digestBytes(original), OriginalFilename: "statement.pdf", MediaType: "application/pdf",
		ByteLength: int64(len(original)), CoverageStart: now.AddDate(0, -1, 0), CoverageEnd: now,
		ExpectedSubjectName: "홍길동", EncryptedOriginalPDF: original, PDFPasswordUTF8: password,
	}
}

func testInternalEvidence(t *testing.T, now time.Time, artifactID, importID string) json.RawMessage {
	t.Helper()
	hash := func(value string) map[string]string {
		sum := sha256.Sum256([]byte(value))
		return map[string]string{"algorithm": "sha256", "value": hex.EncodeToString(sum[:])}
	}
	value := map[string]any{
		"contractVersion": "internal-document-evidence-input/v2", "providerId": "UPBIT",
		"artifact": map[string]any{
			"artifactId": artifactID, "importId": importID, "subjectRef": "subject:opaque", "sourceSystem": "UPBIT",
			"contentHash": hash("decrypted"), "collectedAt": now,
		},
		"producer":     map[string]any{"name": "giwa-pdf-parser", "version": "test"},
		"document":     map[string]any{"documentType": "TRADE_STATEMENT"},
		"subjectMatch": map[string]any{"status": "MATCH"},
		"records": []any{map[string]any{
			"sourceRecordId": "record-1", "mappingStatus": "MAPPED",
			"source": map[string]any{
				"sourceArtifactId": artifactID, "sourcePage": 1, "sourceItemIndex": 0, "recordHash": hash("record-1"),
			},
		}},
		"run": map[string]any{
			"status": "COMPLETE", "completedAt": now,
			"summary": map[string]any{"sourceRecordCount": 1, "mappedCount": 1},
		},
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func allZero(value []byte) bool {
	for _, item := range value {
		if item != 0 {
			return false
		}
	}
	return true
}
