package source

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	"github.com/BackwardLabs/daejang-db/pkg/sourcejobstore"
	enginev1 "github.com/BackwardLabs/daejang/services/engine/gen/go/giwa/engine/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"
)

const (
	maxEncryptedPDFBytes = 20 << 20
)

func (s *Service) ImportUpbitDocument(ctx context.Context, request *enginev1.ImportUpbitDocumentRequest) (*enginev1.ImportUpbitDocumentResponse, error) {
	subjectID, err := validateContext(request.GetContext(), true)
	if err != nil {
		return nil, err
	}
	if s.Importer == nil {
		return nil, status.Error(codes.Unavailable, "document import is unavailable")
	}
	coverageStart, err := parseDate(request.GetCoverageStart(), "coverage_start")
	if err != nil {
		return nil, err
	}
	coverageEnd, err := parseDate(request.GetCoverageEnd(), "coverage_end")
	if err != nil || coverageEnd.Before(coverageStart) {
		return nil, status.Error(codes.InvalidArgument, "coverage_end must be an ISO date on or after coverage_start")
	}
	encrypted := request.GetEncryptedOriginalPdf()
	password := request.GetPdfPasswordUtf8()
	defer clear(encrypted)
	defer clear(password)
	expectedSubjectName := strings.TrimSpace(request.GetExpectedSubjectName())
	if !uuidPattern.MatchString(request.GetUploadId()) || request.GetObjectKey() == "" || len(request.GetObjectKey()) > 500 ||
		request.GetOriginalFilename() == "" || len(request.GetOriginalFilename()) > 255 || request.GetMediaType() != "application/pdf" ||
		request.GetByteLength() != int64(len(encrypted)) || len(encrypted) == 0 || len(encrypted) > maxEncryptedPDFBytes ||
		len(password) > 256 || !hasPDFHeader(encrypted) ||
		expectedSubjectName == "" || len(expectedSubjectName) > 255 || !validSHA256(request.GetArtifactDigest()) ||
		digestBytes(encrypted) != request.GetArtifactDigest() {
		return nil, status.Error(codes.InvalidArgument, "validated UPBIT PDF import metadata and bytes are required")
	}

	result, err := s.Importer.ImportUpbitDocument(ctx, UpbitDocumentImportParams{
		SubjectID: subjectID, IdempotencyKey: request.GetContext().GetIdempotencyKey(),
		UploadID: request.GetUploadId(), ObjectKey: request.GetObjectKey(), ArtifactDigest: request.GetArtifactDigest(),
		OriginalFilename: request.GetOriginalFilename(), MediaType: request.GetMediaType(), ByteLength: request.GetByteLength(),
		CoverageStart: coverageStart, CoverageEnd: coverageEnd, ExpectedSubjectName: expectedSubjectName,
		EncryptedOriginalPDF: encrypted, PDFPasswordUTF8: password,
	})
	if err != nil {
		return nil, mapImportError(err)
	}
	return &enginev1.ImportUpbitDocumentResponse{
		Source: documentToProto(documentFromDatabase(result.Document)), Job: syncJobToProto(result.Job),
		EvidenceTerminalStatus: result.EvidenceTerminalStatus,
		SourceRecordCount:      result.SourceRecordCount, NormalizedRecordCount: result.NormalizedRecordCount,
	}, nil
}

func mapImportError(err error) error {
	var importError *DocumentImportError
	if errors.As(err, &importError) {
		switch importError.Code {
		case "SUBJECT_MISMATCH", "SUBJECT_CLAIM_UNAVAILABLE", "PARSER_DOCUMENT_REJECTED", "PDF_PASSWORD_INVALID":
			return status.Error(codes.FailedPrecondition, importError.Code)
		case "IMPORT_IN_PROGRESS":
			return status.Error(codes.Aborted, importError.Code)
		case "IMPORT_IDEMPOTENCY_CONFLICT":
			return status.Error(codes.AlreadyExists, importError.Code)
		}
	}
	if errors.Is(err, sourcejobstore.ErrLeaseUnavailable) {
		return status.Error(codes.Aborted, "IMPORT_IN_PROGRESS")
	}
	if errors.Is(err, sourcejobstore.ErrImmutableIdentityMismatch) || errors.Is(err, sourcejobstore.ErrJobNotClaimable) {
		return status.Error(codes.AlreadyExists, "IMPORT_IDEMPOTENCY_CONFLICT")
	}
	if errors.Is(err, sourcejobstore.ErrSourceNotFound) {
		return status.Error(codes.FailedPrecondition, "CONFIRMED_UPLOAD_NOT_FOUND")
	}
	return status.Error(codes.Internal, "document import failed")
}

func hasPDFHeader(value []byte) bool {
	return len(value) >= len("%PDF-") && string(value[:len("%PDF-")]) == "%PDF-"
}

func validSHA256(value string) bool {
	if len(value) != sha256.Size*2 || strings.ToLower(value) != value {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func digestBytes(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}

func syncJobToProto(value sourcejobstore.SyncJob) *enginev1.SyncJob {
	result := &enginev1.SyncJob{
		Id: value.ID, SourceKind: value.SourceKind, SourceId: value.SourceID, State: value.State, Phase: value.Phase,
		Attempts: value.Attempts, ProcessedRecords: value.ProcessedRecords, FailureCode: value.FailureCode,
		FailureMessage: value.FailureMessage, OutputFragmentId: value.OutputFragmentID, Trigger: value.Trigger,
		CheckpointCursor: value.CheckpointCursor, SegmentCursor: value.SegmentCursor,
		UpstreamJitRunId: value.UpstreamJITRunID, ProgressVersion: value.ProgressVersion,
		CreatedAt: timestamppb.New(value.CreatedAt), UpdatedAt: timestamppb.New(value.UpdatedAt),
	}
	if value.RequestedCoverageStart != nil {
		result.RequestedCoverageStart = value.RequestedCoverageStart.Format("2006-01-02")
	}
	if value.RequestedCoverageEnd != nil {
		result.RequestedCoverageEnd = value.RequestedCoverageEnd.Format("2006-01-02")
	}
	if value.TotalRecords != nil {
		result.TotalRecords, result.HasTotalRecords = *value.TotalRecords, true
	}
	toTimestamp := func(value *time.Time) *timestamppb.Timestamp {
		if value == nil {
			return nil
		}
		return timestamppb.New(*value)
	}
	result.StartedAt, result.CompletedAt = toTimestamp(value.StartedAt), toTimestamp(value.CompletedAt)
	return result
}
