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
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestClientUsesBoundedOneRequestUnixProtocol(t *testing.T) {
	request := validRequest()
	passwordAlias := request.Password
	socketPath := serveOnce(t, func(connection net.Conn) {
		header, metadata, password, pdf := readRequest(t, connection)
		if string(header[:8]) != requestMagic || string(password) != "transient-password" || !bytes.Equal(pdf, request.PDF) {
			t.Fatalf("unexpected framed request")
		}
		var decoded requestMetadata
		if err := json.Unmarshal(metadata, &decoded); err != nil {
			t.Fatal(err)
		}
		if decoded.ExpectedSubjectName != "김대장" || decoded.ArtifactID != "artifact-1" {
			t.Fatalf("unexpected metadata: %#v", decoded)
		}
		writeResponse(t, connection, responseStatusOK, "", validInternalEvidenceEnvelope(request))
	})

	result, err := (Client{SocketPath: socketPath}).Parse(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if result.ParserName != "giwa-pdf-parser" || result.SourceRecordCount != 0 {
		t.Fatalf("unexpected result: %#v", result)
	}
	if !allZero(passwordAlias) {
		t.Fatal("client did not zeroize the caller-owned password buffer")
	}
	if bytes.Contains(result.InternalEvidence, []byte("김대장")) || bytes.Contains(result.InternalEvidence, []byte("transient-password")) {
		t.Fatal("internal evidence retained transient values")
	}
}

func TestClientAcceptsExplicitMVPSubjectComparisonSkip(t *testing.T) {
	request := validRequest()
	request.ExpectedSubjectName = ""
	socketPath := serveOnce(t, func(connection net.Conn) {
		received := readRequestValue(t, connection)
		if received.ExpectedSubjectName != "" {
			t.Fatalf("subject name crossed the skipped-comparison boundary: %#v", received)
		}
		writeResponse(t, connection, responseStatusOK, "", uncheckedInternalEvidenceEnvelope(request))
	})

	result, err := (Client{SocketPath: socketPath}).Parse(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(result.InternalEvidence, []byte(`"status":"INCONCLUSIVE"`)) ||
		bytes.Contains(result.InternalEvidence, []byte("김대장")) {
		t.Fatalf("unchecked subject decision was not preserved safely: %s", result.InternalEvidence)
	}
}

func TestClientRejectsUncheckedSubjectDecisionWithoutExactMVPPolicy(t *testing.T) {
	for name, body := range map[string]string{
		"missing policy": `{"status":"INCONCLUSIVE","rawValuesRetained":false}`,
		"wrong policy":   `{"status":"INCONCLUSIVE","policyRef":"other-policy:v1","rawValuesRetained":false}`,
		"raw retained":   `{"status":"INCONCLUSIVE","policyRef":"mvp-subject-comparison-skipped:v1","rawValuesRetained":true}`,
		"mismatch":       `{"status":"MISMATCH","policyRef":"mvp-subject-comparison-skipped:v1","rawValuesRetained":false}`,
	} {
		t.Run(name, func(t *testing.T) {
			request := validRequest()
			request.ExpectedSubjectName = ""
			socketPath := serveOnce(t, func(connection net.Conn) {
				readRequest(t, connection)
				envelope := strings.Replace(
					uncheckedInternalEvidenceEnvelope(request),
					`{"status":"INCONCLUSIVE","policyRef":"mvp-subject-comparison-skipped:v1","rawValuesRetained":false}`,
					body,
					1,
				)
				writeResponse(t, connection, responseStatusOK, "", envelope)
			})
			_, err := (Client{SocketPath: socketPath}).Parse(context.Background(), request)
			var parserErr *Error
			if !errors.As(err, &parserErr) || parserErr.Code != "PARSER_RESPONSE_INVALID" {
				t.Fatalf("unsafe subject decision was accepted: %#v", err)
			}
		})
	}
}

func TestClientReadinessRequiresAnExactActiveResponse(t *testing.T) {
	socketPath := serveOnce(t, func(connection net.Conn) {
		request := make([]byte, len(pingMagic))
		if _, err := io.ReadFull(connection, request); err != nil {
			t.Fatal(err)
		}
		if string(request) != pingMagic {
			t.Fatalf("unexpected health request: %q", request)
		}
		var trailing [1]byte
		if count, err := connection.Read(trailing[:]); count != 0 || !errors.Is(err, io.EOF) {
			t.Fatal("health request was not bounded to one frame")
		}
		mustWrite(t, connection, []byte(pongMagic))
	})

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := (Client{SocketPath: socketPath}).Ready(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestClientReadinessRejectsAStaleOrInvalidSocket(t *testing.T) {
	socketPath := serveOnce(t, func(connection net.Conn) {
		request := make([]byte, len(pingMagic))
		_, _ = io.ReadFull(connection, request)
		mustWrite(t, connection, []byte("BADPONG!"))
	})

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := (Client{SocketPath: socketPath}).Ready(ctx); err == nil {
		t.Fatal("invalid parser health response was accepted")
	}
}

func TestClientMapsOnlyAllowlistedSidecarErrors(t *testing.T) {
	for name, codes := range map[string][2]string{
		"subject mismatch": {"SUBJECT_MISMATCH", "SUBJECT_MISMATCH"},
		"wrong password":   {"PDF_PASSWORD_INVALID", "PDF_PASSWORD_INVALID"},
		"unknown detail":   {"raw-name-and-financial-value", "PARSER_PROCESS_FAILED"},
	} {
		t.Run(name, func(t *testing.T) {
			sidecarCode, expectedCode := codes[0], codes[1]
			socketPath := serveOnce(t, func(connection net.Conn) {
				readRequest(t, connection)
				writeResponse(t, connection, responseStatusError, sidecarCode, "")
			})
			_, err := (Client{SocketPath: socketPath}).Parse(context.Background(), validRequest())
			var parserErr *Error
			if !errors.As(err, &parserErr) || parserErr.Code != expectedCode {
				t.Fatalf("unexpected error: %#v", err)
			}
			if strings.Contains(err.Error(), "raw-name") || strings.Contains(err.Error(), "financial") {
				t.Fatalf("sidecar detail leaked through error: %v", err)
			}
		})
	}
}

func TestClientTimesOutAndClosesConnection(t *testing.T) {
	socketPath := serveOnce(t, func(connection net.Conn) {
		readRequest(t, connection)
		time.Sleep(200 * time.Millisecond)
	})
	_, err := (Client{SocketPath: socketPath, Timeout: 20 * time.Millisecond}).Parse(context.Background(), validRequest())
	var parserErr *Error
	if !errors.As(err, &parserErr) || parserErr.Code != "PARSER_TIMEOUT" {
		t.Fatalf("unexpected error: %#v", err)
	}
}

func TestClientRejectsOversizedAndTrailingResponses(t *testing.T) {
	for name, handler := range map[string]func(*testing.T, net.Conn){
		"oversized": func(t *testing.T, connection net.Conn) {
			readRequest(t, connection)
			header := make([]byte, responseHeaderBytes)
			copy(header[:8], responseMagic)
			binary.BigEndian.PutUint64(header[16:24], 4096)
			mustWrite(t, connection, header)
		},
		"trailing": func(t *testing.T, connection net.Conn) {
			request := readRequestValue(t, connection)
			writeResponseWithTrailing(t, connection, validInternalEvidenceEnvelope(request))
		},
	} {
		t.Run(name, func(t *testing.T) {
			socketPath := serveOnce(t, func(connection net.Conn) { handler(t, connection) })
			_, err := (Client{SocketPath: socketPath, MaxOutputBytes: 128}).Parse(context.Background(), validRequest())
			var parserErr *Error
			if !errors.As(err, &parserErr) || parserErr.Code != "PARSER_RESPONSE_INVALID" {
				t.Fatalf("unexpected error: %#v", err)
			}
		})
	}
}

func TestClientRejectsInvalidInputBeforeDialAndClearsPassword(t *testing.T) {
	request := validRequest()
	request.PDF = []byte("not a pdf")
	passwordAlias := request.Password
	_, err := (Client{SocketPath: "/does/not/exist.sock"}).Parse(context.Background(), request)
	var parserErr *Error
	if !errors.As(err, &parserErr) || parserErr.Code != "PARSER_INPUT_INVALID" {
		t.Fatalf("unexpected error: %#v", err)
	}
	if !allZero(passwordAlias) {
		t.Fatal("password was not cleared on validation failure")
	}
}

func TestClientRejectsRelativeSocketPath(t *testing.T) {
	_, err := (Client{SocketPath: "parser.sock"}).Parse(context.Background(), validRequest())
	if err == nil || !strings.Contains(err.Error(), "absolute parser socket") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func validRequest() Request {
	return Request{
		PDF: []byte("%PDF-1.7\nencrypted-body"), Password: []byte("transient-password"),
		ArtifactID: "artifact-1", ImportID: "import-1", SubjectRef: "subject-1",
		CollectedAt: time.Date(2026, 7, 29, 1, 2, 3, 0, time.UTC), ExpectedSubjectName: "김대장",
	}
}

func validInternalEvidenceEnvelope(request Request) string {
	return `{"contractVersion":"internal-document-evidence-input/v2","providerId":"UPBIT","artifact":{"artifactId":"artifact-1","importId":"import-1","subjectRef":"subject-1","sourceSystem":"UPBIT","contentHash":{"algorithm":"sha256","value":"` + hashBytes(request.PDF) + `"}},"subjectMatch":{"status":"MATCH"},"producer":{"name":"giwa-pdf-parser","version":"0.2.0"},"document":{"documentType":"TRADE_STATEMENT"},"records":[],"run":{"status":"COMPLETE","summary":{"sourceRecordCount":0}}}`
}

func uncheckedInternalEvidenceEnvelope(request Request) string {
	return `{"contractVersion":"internal-document-evidence-input/v2","providerId":"UPBIT","artifact":{"artifactId":"artifact-1","importId":"import-1","subjectRef":"subject-1","sourceSystem":"UPBIT","contentHash":{"algorithm":"sha256","value":"` + hashBytes(request.PDF) + `"}},"subjectMatch":{"status":"INCONCLUSIVE","policyRef":"mvp-subject-comparison-skipped:v1","rawValuesRetained":false},"producer":{"name":"giwa-pdf-parser","version":"0.2.0"},"document":{"documentType":"TRADE_STATEMENT"},"records":[],"run":{"status":"COMPLETE","summary":{"sourceRecordCount":0}}}`
}

func serveOnce(t *testing.T, handler func(net.Conn)) string {
	t.Helper()
	placeholder, err := os.CreateTemp("/tmp", "djpdf-*.sock")
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Clean(placeholder.Name())
	if err := placeholder.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		listener.Close()
		_ = os.Remove(path)
	})
	ready := make(chan struct{})
	go func() {
		close(ready)
		connection, acceptErr := listener.Accept()
		if acceptErr != nil {
			return
		}
		defer connection.Close()
		handler(connection)
	}()
	<-ready
	return path
}

func readRequest(t *testing.T, connection net.Conn) ([]byte, []byte, []byte, []byte) {
	t.Helper()
	header := make([]byte, requestHeaderBytes)
	if _, err := io.ReadFull(connection, header); err != nil {
		t.Fatal(err)
	}
	metadata := make([]byte, int(binary.BigEndian.Uint32(header[8:12])))
	password := make([]byte, int(binary.BigEndian.Uint32(header[12:16])))
	pdf := make([]byte, int(binary.BigEndian.Uint64(header[16:24])))
	for _, value := range [][]byte{metadata, password, pdf} {
		if _, err := io.ReadFull(connection, value); err != nil {
			t.Fatal(err)
		}
	}
	var trailing [1]byte
	if count, err := connection.Read(trailing[:]); count != 0 || !errors.Is(err, io.EOF) {
		t.Fatalf("request was not exactly one frame: count=%d err=%v", count, err)
	}
	return header, metadata, password, pdf
}

func readRequestValue(t *testing.T, connection net.Conn) Request {
	_, metadata, _, pdf := readRequest(t, connection)
	var decoded requestMetadata
	if err := json.Unmarshal(metadata, &decoded); err != nil {
		t.Fatal(err)
	}
	return Request{PDF: pdf, ArtifactID: decoded.ArtifactID, ImportID: decoded.ImportID, SubjectRef: decoded.SubjectRef}
}

func writeResponse(t *testing.T, connection net.Conn, status uint32, code, body string) {
	t.Helper()
	header := make([]byte, responseHeaderBytes)
	copy(header[:8], responseMagic)
	binary.BigEndian.PutUint32(header[8:12], status)
	binary.BigEndian.PutUint32(header[12:16], uint32(len(code)))
	binary.BigEndian.PutUint64(header[16:24], uint64(len(body)))
	mustWrite(t, connection, header, []byte(code), []byte(body))
}

func writeResponseWithTrailing(t *testing.T, connection net.Conn, body string) {
	writeResponse(t, connection, responseStatusOK, "", body)
	mustWrite(t, connection, []byte("x"))
}

func mustWrite(t *testing.T, writer io.Writer, values ...[]byte) {
	t.Helper()
	for _, value := range values {
		if _, err := writer.Write(value); err != nil {
			t.Fatal(err)
		}
	}
}

func allZero(value []byte) bool {
	return bytes.Equal(value, make([]byte, len(value)))
}

func hashBytes(value []byte) string {
	digest := sha256.Sum256(value)
	return fmt.Sprintf("%x", digest)
}
