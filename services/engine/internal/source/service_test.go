package source

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/BackwardLabs/daejang-db/pkg/sourcejobstore"
	enginev1 "github.com/BackwardLabs/daejang/services/engine/gen/go/giwa/engine/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"
)

type recordingImporter struct {
	params UpbitDocumentImportParams
	calls  int
}

func (i *recordingImporter) ImportUpbitDocument(_ context.Context, params UpbitDocumentImportParams) (UpbitDocumentImportResult, error) {
	i.calls++
	i.params = params
	now := time.Date(2026, 7, 29, 0, 0, 0, 0, time.UTC)
	return UpbitDocumentImportResult{
		Document: sourcejobstore.DocumentSource{
			ID: testSourceID, Provider: "UPBIT", OriginalFilename: params.OriginalFilename,
			MediaType: params.MediaType, ByteLength: params.ByteLength, ArtifactDigest: params.ArtifactDigest,
			CoverageStart: params.CoverageStart, CoverageEnd: params.CoverageEnd, Status: "ACTIVE", CreatedAt: now, UpdatedAt: now,
		},
		Job: sourcejobstore.SyncJob{
			ID: testJobID, SourceKind: "UPBIT_PDF", SourceID: testSourceID, State: "SUCCEEDED", Phase: "COMPLETE",
			CreatedAt: now, UpdatedAt: now,
		},
		EvidenceTerminalStatus: "PARTIAL", SourceRecordCount: 3,
	}, nil
}

type recordingStore struct {
	registered RegisterWalletParams
	source     WalletSource
}

func (s *recordingStore) ListDocuments(context.Context, string) ([]DocumentSource, error) {
	return nil, nil
}

func (s *recordingStore) RegisterWallet(_ context.Context, params RegisterWalletParams) (WalletSource, error) {
	s.registered = params
	return s.source, nil
}

func (s *recordingStore) ListWallets(context.Context, string) ([]WalletSource, error) {
	return []WalletSource{s.source}, nil
}

func (s *recordingStore) DisconnectWallet(context.Context, string, string, time.Time) (WalletSource, error) {
	return s.source, nil
}

func TestRegisterWalletUsesAuthenticatedActor(t *testing.T) {
	now := time.Date(2026, 7, 26, 12, 0, 0, 0, time.UTC)
	store := &recordingStore{source: WalletSource{
		ID: "11111111-1111-4111-8111-111111111111", Address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		AccountType: "EOA", VerificationChainID: "eip155:1", VerifiedAt: now,
		Status: "ACTIVE", CreatedAt: now, UpdatedAt: now,
	}}
	service := Service{Store: store}
	response, err := service.RegisterWallet(context.Background(), &enginev1.RegisterWalletRequest{
		Context: validContext(), Address: store.source.Address, VerificationChainId: "eip155:1",
		ChainIds: []string{"eip155:1"}, VerifiedAt: timestamppb.New(now),
	})
	if err != nil {
		t.Fatal(err)
	}
	if store.registered.SubjectID != validContext().Actor.UserId || response.GetSource().GetId() != store.source.ID {
		t.Fatalf("request context was not mapped to the source operation: params=%#v response=%#v", store.registered, response)
	}
}

func TestRegisterWalletRejectsMissingIdempotencyKey(t *testing.T) {
	requestContext := validContext()
	requestContext.IdempotencyKey = ""
	_, err := (&Service{Store: &recordingStore{}}).RegisterWallet(context.Background(), &enginev1.RegisterWalletRequest{
		Context: requestContext, VerifiedAt: timestamppb.Now(),
	})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("missing idempotency key returned %v", err)
	}
}

func TestRegisterDocumentAlwaysRequiresVerifiedParser(t *testing.T) {
	_, err := (&Service{Store: &recordingStore{}}).RegisterDocument(
		context.Background(),
		&enginev1.RegisterDocumentRequest{Context: validContext()},
	)
	if status.Code(err) != codes.FailedPrecondition || status.Convert(err).Message() != "DOCUMENT_IMPORT_REQUIRES_VERIFIED_PARSER" {
		t.Fatalf("legacy document registration was not fail-closed: %v", err)
	}
}

func TestImportUpbitDocumentValidatesDigestAndClearsDecryptedRequest(t *testing.T) {
	importer := &recordingImporter{}
	original := []byte("%PDF-1.7 encrypted")
	password := []byte("transient-password")
	request := &enginev1.ImportUpbitDocumentRequest{
		Context: validContext(), UploadId: testUploadID, ObjectKey: "private/source.pdf",
		ArtifactDigest: digestBytes(original), OriginalFilename: "statement.pdf", MediaType: "application/pdf",
		ByteLength: int64(len(original)), CoverageStart: "2026-01-01", CoverageEnd: "2026-06-30",
		ExpectedSubjectName: "홍길동", EncryptedOriginalPdf: original, PdfPasswordUtf8: password,
	}
	response, err := (&Service{Importer: importer}).ImportUpbitDocument(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if importer.calls != 1 || importer.params.SubjectID != validContext().Actor.UserId ||
		response.GetEvidenceTerminalStatus() != "PARTIAL" || response.GetJob().GetState() != "SUCCEEDED" {
		t.Fatalf("import request was not mapped safely: params=%#v response=%#v", importer.params, response)
	}
	if !allZero(original) || !allZero(password) {
		t.Fatal("RPC boundary retained PDF request bytes")
	}
}

func TestImportUpbitDocumentRejectsMismatchedEncryptedDigestBeforeClaim(t *testing.T) {
	importer := &recordingImporter{}
	password := make([]byte, 257)
	_, err := (&Service{Importer: importer}).ImportUpbitDocument(context.Background(), &enginev1.ImportUpbitDocumentRequest{
		Context: validContext(), UploadId: testUploadID, ObjectKey: "private/source.pdf",
		ArtifactDigest: strings.Repeat("a", 64), OriginalFilename: "statement.pdf", MediaType: "application/pdf",
		ByteLength: int64(len("%PDF-1.7 encrypted")), CoverageStart: "2026-01-01", CoverageEnd: "2026-06-30",
		ExpectedSubjectName: "홍길동", EncryptedOriginalPdf: []byte("%PDF-1.7 encrypted"), PdfPasswordUtf8: password,
	})
	if status.Code(err) != codes.InvalidArgument || importer.calls != 0 || !allZero(password) {
		t.Fatalf("digest mismatch crossed the claim boundary: err=%v calls=%d", err, importer.calls)
	}
}

func validContext() *enginev1.RequestContext {
	return &enginev1.RequestContext{
		RequestId: "req-test", IdempotencyKey: "challenge-test",
		Actor: &enginev1.ActorContext{
			UserId:    "00000000-0000-4000-8000-000000000001",
			SessionId: "00000000-0000-4000-8000-000000000002",
		},
	}
}
