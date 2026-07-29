package pdfparser

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"path/filepath"
	"strings"
	"time"
)

const (
	defaultTimeout               = 30 * time.Second
	defaultMaxInputBytes         = 20 << 20
	defaultMaxOutputBytes        = 32 << 20
	maxMetadataBytes             = 16 << 10
	maxPasswordBytes             = 256
	requestHeaderBytes           = 24
	responseHeaderBytes          = 24
	requestMagic                 = "DJPARS01"
	responseMagic                = "DJPRES01"
	pingMagic                    = "DJPING01"
	pongMagic                    = "DJPONG01"
	responseStatusOK      uint32 = 0
	responseStatusError          = 1
)

// Request is sent only over the private parser Unix socket. Password is a
// caller-owned transient buffer and is cleared before Parse returns.
type Request struct {
	PDF                 []byte
	Password            []byte
	ArtifactID          string
	ImportID            string
	SubjectRef          string
	CollectedAt         time.Time
	ExpectedSubjectName string
}

type Result struct {
	InternalEvidence   json.RawMessage
	ParserName         string
	ParserVersion      string
	DocumentType       string
	ParseStatus        string
	SourceDocumentHash string
	SourceRecordCount  int64
	MappedCount        int64
	DuplicateCount     int64
	UnsupportedCount   int64
	ErrorCount         int64
	NotRelevantCount   int64
}

type Error struct{ Code string }

func (e *Error) Error() string {
	if e == nil {
		return ""
	}
	return e.Code
}

// Client sends one bounded request over one Unix connection. No parser code,
// Python runtime, password, or extracted PII exists in the Engine process
// configuration or logs beyond the transient request buffers.
type Client struct {
	SocketPath     string
	Timeout        time.Duration
	MaxInputBytes  int
	MaxOutputBytes int
}

type requestMetadata struct {
	ArtifactID          string `json:"artifactId"`
	ImportID            string `json:"importId"`
	SubjectRef          string `json:"subjectRef"`
	CollectedAt         string `json:"collectedAt"`
	ExpectedSubjectName string `json:"expectedSubjectName"`
}

type internalEvidenceEnvelope struct {
	ContractVersion string `json:"contractVersion"`
	ProviderID      string `json:"providerId"`
	Artifact        struct {
		ArtifactID   string `json:"artifactId"`
		ImportID     string `json:"importId"`
		SubjectRef   string `json:"subjectRef"`
		SourceSystem string `json:"sourceSystem"`
		ContentHash  struct {
			Algorithm string `json:"algorithm"`
			Value     string `json:"value"`
		} `json:"contentHash"`
	} `json:"artifact"`
	SubjectMatch struct {
		Status string `json:"status"`
	} `json:"subjectMatch"`
	Producer struct {
		Name    string `json:"name"`
		Version string `json:"version"`
	} `json:"producer"`
	Document struct {
		DocumentType string `json:"documentType"`
	} `json:"document"`
	Records []struct {
		SourceRecordID string `json:"sourceRecordId"`
		MappingStatus  string `json:"mappingStatus"`
		Source         struct {
			SourceArtifactID string `json:"sourceArtifactId"`
			SourcePage       int64  `json:"sourcePage"`
			SourceItemIndex  int64  `json:"sourceItemIndex"`
			RecordHash       struct {
				Algorithm string `json:"algorithm"`
				Value     string `json:"value"`
			} `json:"recordHash"`
		} `json:"source"`
		CanonicalSourceRecordID string `json:"canonicalSourceRecordId"`
		ReasonCode              string `json:"reasonCode"`
	} `json:"records"`
	Run struct {
		Status  string `json:"status"`
		Summary struct {
			SourceRecordCount int64 `json:"sourceRecordCount"`
			MappedCount       int64 `json:"mappedCount"`
			DuplicateCount    int64 `json:"duplicateCount"`
			UnsupportedCount  int64 `json:"unsupportedCount"`
			ErrorCount        int64 `json:"errorCount"`
			NotRelevantCount  int64 `json:"notRelevantCount"`
		} `json:"summary"`
	} `json:"run"`
}

func (c Client) Ready(ctx context.Context) error {
	if strings.TrimSpace(c.SocketPath) == "" || !filepath.IsAbs(c.SocketPath) {
		return errors.New("absolute parser socket path is required")
	}
	connection, err := (&net.Dialer{}).DialContext(ctx, "unix", c.SocketPath)
	if err != nil {
		return fmt.Errorf("dial parser health socket: %w", err)
	}
	defer connection.Close()
	if deadline, ok := ctx.Deadline(); ok {
		if err := connection.SetDeadline(deadline); err != nil {
			return fmt.Errorf("set parser health deadline: %w", err)
		}
	}
	if err := writeAll(connection, []byte(pingMagic)); err != nil {
		return fmt.Errorf("write parser health request: %w", err)
	}
	if unixConnection, ok := connection.(*net.UnixConn); ok {
		if err := unixConnection.CloseWrite(); err != nil {
			return fmt.Errorf("close parser health request: %w", err)
		}
	}
	response := make([]byte, len(pongMagic))
	if _, err := io.ReadFull(connection, response); err != nil {
		return fmt.Errorf("read parser health response: %w", err)
	}
	var trailing [1]byte
	if count, readErr := connection.Read(trailing[:]); string(response) != pongMagic || count != 0 || !errors.Is(readErr, io.EOF) {
		return errors.New("invalid parser health response")
	}
	return nil
}

func (c Client) Parse(ctx context.Context, request Request) (Result, error) {
	defer clear(request.Password)
	if strings.TrimSpace(c.SocketPath) == "" || !filepath.IsAbs(c.SocketPath) {
		return Result{}, errors.New("absolute parser socket path is required")
	}
	maxInputBytes := c.MaxInputBytes
	if maxInputBytes <= 0 {
		maxInputBytes = defaultMaxInputBytes
	}
	if len(request.PDF) == 0 || len(request.PDF) > maxInputBytes ||
		len(request.PDF) < len("%PDF-") || !bytes.Equal(request.PDF[:len("%PDF-")], []byte("%PDF-")) {
		return Result{}, &Error{Code: "PARSER_INPUT_INVALID"}
	}
	if len(request.Password) > maxPasswordBytes {
		return Result{}, &Error{Code: "PARSER_REQUEST_INVALID"}
	}
	if request.CollectedAt.IsZero() {
		return Result{}, &Error{Code: "PARSER_CONTEXT_INVALID"}
	}
	metadata, err := json.Marshal(requestMetadata{
		ArtifactID: request.ArtifactID, ImportID: request.ImportID, SubjectRef: request.SubjectRef,
		CollectedAt:         request.CollectedAt.UTC().Format(time.RFC3339Nano),
		ExpectedSubjectName: request.ExpectedSubjectName,
	})
	if err != nil || len(metadata) == 0 || len(metadata) > maxMetadataBytes {
		clear(metadata)
		return Result{}, &Error{Code: "PARSER_CONTEXT_INVALID"}
	}
	defer clear(metadata)

	timeout := c.Timeout
	if timeout <= 0 {
		timeout = defaultTimeout
	}
	parseCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	connection, err := (&net.Dialer{}).DialContext(parseCtx, "unix", c.SocketPath)
	if err != nil {
		if errors.Is(parseCtx.Err(), context.DeadlineExceeded) {
			return Result{}, &Error{Code: "PARSER_TIMEOUT"}
		}
		return Result{}, &Error{Code: "PARSER_UNAVAILABLE"}
	}
	defer connection.Close()
	if deadline, ok := parseCtx.Deadline(); ok {
		if err := connection.SetDeadline(deadline); err != nil {
			return Result{}, &Error{Code: "PARSER_TRANSPORT_FAILED"}
		}
	}

	header := make([]byte, requestHeaderBytes)
	copy(header[:8], requestMagic)
	binary.BigEndian.PutUint32(header[8:12], uint32(len(metadata)))
	binary.BigEndian.PutUint32(header[12:16], uint32(len(request.Password)))
	binary.BigEndian.PutUint64(header[16:24], uint64(len(request.PDF)))
	if err := writeAll(connection, header, metadata, request.Password, request.PDF); err != nil {
		return Result{}, transportError(parseCtx, err)
	}
	if unixConnection, ok := connection.(*net.UnixConn); ok {
		if err := unixConnection.CloseWrite(); err != nil {
			return Result{}, transportError(parseCtx, err)
		}
	}

	responseHeader := make([]byte, responseHeaderBytes)
	if _, err := io.ReadFull(connection, responseHeader); err != nil {
		return Result{}, transportError(parseCtx, err)
	}
	if string(responseHeader[:8]) != responseMagic {
		return Result{}, &Error{Code: "PARSER_RESPONSE_INVALID"}
	}
	status := binary.BigEndian.Uint32(responseHeader[8:12])
	codeLength := binary.BigEndian.Uint32(responseHeader[12:16])
	bodyLength := binary.BigEndian.Uint64(responseHeader[16:24])
	maxOutputBytes := c.MaxOutputBytes
	if maxOutputBytes <= 0 {
		maxOutputBytes = defaultMaxOutputBytes
	}
	if codeLength > 64 || bodyLength > uint64(maxOutputBytes) ||
		(status != responseStatusOK && status != responseStatusError) {
		return Result{}, &Error{Code: "PARSER_RESPONSE_INVALID"}
	}
	code := make([]byte, int(codeLength))
	body := make([]byte, int(bodyLength))
	defer clear(code)
	if _, err := io.ReadFull(connection, code); err != nil {
		clear(body)
		return Result{}, transportError(parseCtx, err)
	}
	if _, err := io.ReadFull(connection, body); err != nil {
		clear(body)
		return Result{}, transportError(parseCtx, err)
	}
	var trailing [1]byte
	if count, readErr := connection.Read(trailing[:]); count != 0 || !errors.Is(readErr, io.EOF) {
		clear(body)
		return Result{}, &Error{Code: "PARSER_RESPONSE_INVALID"}
	}
	if status == responseStatusError {
		clear(body)
		errorCode := string(code)
		if !safeParserErrorCode(errorCode) {
			return Result{}, &Error{Code: "PARSER_PROCESS_FAILED"}
		}
		return Result{}, &Error{Code: errorCode}
	}
	if len(code) != 0 || len(body) == 0 {
		clear(body)
		return Result{}, &Error{Code: "PARSER_RESPONSE_INVALID"}
	}
	result, decodeErr := decodeInternalEvidence(body, request)
	clear(body)
	return result, decodeErr
}

func writeAll(writer io.Writer, values ...[]byte) error {
	for _, value := range values {
		for len(value) > 0 {
			written, err := writer.Write(value)
			if err != nil {
				return err
			}
			if written == 0 {
				return io.ErrShortWrite
			}
			value = value[written:]
		}
	}
	return nil
}

func transportError(ctx context.Context, cause error) error {
	var netError net.Error
	if errors.Is(ctx.Err(), context.DeadlineExceeded) ||
		(errors.As(cause, &netError) && netError.Timeout()) {
		return &Error{Code: "PARSER_TIMEOUT"}
	}
	return &Error{Code: "PARSER_TRANSPORT_FAILED"}
}

func safeParserErrorCode(code string) bool {
	switch code {
	case "PARSER_REQUEST_INVALID", "PARSER_DOCUMENT_REJECTED", "SUBJECT_CLAIM_UNAVAILABLE",
		"SUBJECT_MISMATCH", "PDF_PASSWORD_INVALID", "PARSER_TIMEOUT", "PARSER_PROCESS_FAILED":
		return true
	default:
		return false
	}
}

func decodeInternalEvidence(value []byte, request Request) (Result, error) {
	decoder := json.NewDecoder(bytes.NewReader(value))
	var envelope internalEvidenceEnvelope
	if err := decoder.Decode(&envelope); err != nil {
		return Result{}, &Error{Code: "PARSER_RESPONSE_INVALID"}
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return Result{}, &Error{Code: "PARSER_RESPONSE_INVALID"}
	}
	if envelope.ContractVersion != "internal-document-evidence-input/v2" ||
		envelope.SubjectMatch.Status != "MATCH" || envelope.ProviderID != "UPBIT" ||
		envelope.Artifact.SourceSystem != envelope.ProviderID ||
		envelope.Artifact.ArtifactID != request.ArtifactID ||
		envelope.Artifact.ImportID != request.ImportID ||
		envelope.Artifact.SubjectRef != request.SubjectRef ||
		envelope.Artifact.ContentHash.Algorithm != "sha256" ||
		envelope.Artifact.ContentHash.Value != sha256Hex(request.PDF) ||
		strings.TrimSpace(envelope.Producer.Name) == "" ||
		strings.TrimSpace(envelope.Producer.Version) == "" ||
		strings.TrimSpace(envelope.Document.DocumentType) == "" ||
		strings.TrimSpace(envelope.Run.Status) == "" ||
		int64(len(envelope.Records)) != envelope.Run.Summary.SourceRecordCount {
		return Result{}, &Error{Code: "PARSER_RESPONSE_INVALID"}
	}
	for _, record := range envelope.Records {
		if strings.TrimSpace(record.SourceRecordID) == "" ||
			record.Source.SourceArtifactID != envelope.Artifact.ArtifactID ||
			record.Source.SourcePage < 1 || record.Source.SourceItemIndex < 0 ||
			record.Source.RecordHash.Algorithm != "sha256" || len(record.Source.RecordHash.Value) != 64 {
			return Result{}, &Error{Code: "PARSER_RESPONSE_INVALID"}
		}
	}

	internalEvidence := append(json.RawMessage(nil), value...)
	summary := envelope.Run.Summary
	return Result{
		InternalEvidence: internalEvidence, ParserName: envelope.Producer.Name,
		ParserVersion: envelope.Producer.Version, DocumentType: envelope.Document.DocumentType,
		ParseStatus: envelope.Run.Status, SourceDocumentHash: envelope.Artifact.ContentHash.Value,
		SourceRecordCount: summary.SourceRecordCount, MappedCount: summary.MappedCount,
		DuplicateCount: summary.DuplicateCount, UnsupportedCount: summary.UnsupportedCount,
		ErrorCount: summary.ErrorCount, NotRelevantCount: summary.NotRelevantCount,
	}, nil
}

func sha256Hex(value []byte) string {
	digest := sha256.Sum256(value)
	return fmt.Sprintf("%x", digest)
}
