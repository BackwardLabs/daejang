package pdfparser

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const (
	syntheticFixturePassword = "synthetic-pdf-password-do-not-persist"
	syntheticFixtureSubject  = "SYNTHETIC_VERIFIED_SUBJECT_DO_NOT_PERSIST"
)

func TestPinnedPythonParserWithEncryptedSyntheticUpbitFixture(t *testing.T) {
	if os.Getenv("RUN_PDF_PARSER_INTEGRATION_TESTS") != "1" {
		t.Skip("set RUN_PDF_PARSER_INTEGRATION_TESTS=1 with PDF_PARSER_PYTHON")
	}
	python := os.Getenv("PDF_PARSER_PYTHON")
	if !filepath.IsAbs(python) {
		t.Fatal("PDF_PARSER_PYTHON must be an absolute pinned-parser venv path")
	}
	serverPath, err := filepath.Abs(filepath.Join("..", "..", "python", "pdf_parser_server.py"))
	if err != nil {
		t.Fatal(err)
	}
	socketPath := filepath.Join(
		"/tmp",
		fmt.Sprintf("djpdf-integration-%d-%d.sock", os.Getpid(), time.Now().UnixNano()),
	)
	t.Cleanup(func() { _ = os.Remove(socketPath) })
	command := exec.Command(
		python,
		"-I",
		"-B",
		serverPath,
		"--socket",
		socketPath,
		"--request-timeout-seconds",
		"10",
	)
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = command.Process.Kill()
		_, _ = command.Process.Wait()
	})

	readyCtx, cancelReady := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelReady()
	client := Client{SocketPath: socketPath, Timeout: 10 * time.Second}
	for {
		if err := client.Ready(readyCtx); err == nil {
			break
		}
		select {
		case <-readyCtx.Done():
			t.Fatal("pinned parser did not become ready")
		case <-time.After(25 * time.Millisecond):
		}
	}

	encoded, err := os.ReadFile(
		filepath.Join("testdata", "synthetic_upbit_trade.encrypted.pdf.b64"),
	)
	if err != nil {
		t.Fatal(err)
	}
	pdf, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(encoded)))
	if err != nil {
		t.Fatal(err)
	}
	password := []byte(syntheticFixturePassword)
	result, err := client.Parse(context.Background(), Request{
		PDF: pdf, Password: password, ArtifactID: "artifact:synthetic-sidecar",
		ImportID: "import:synthetic-sidecar", SubjectRef: "subject:synthetic-sidecar",
		CollectedAt:         time.Date(2026, 7, 29, 0, 0, 0, 0, time.UTC),
		ExpectedSubjectName: syntheticFixtureSubject,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.ParserName != "giwa-pdf-parser" || result.DocumentType != "TRADE_STATEMENT" ||
		result.SourceRecordCount != 1 || !allZero(password) {
		t.Fatalf("unexpected pinned parser result: %#v", result)
	}
	if strings.Contains(string(result.InternalEvidence), syntheticFixturePassword) ||
		strings.Contains(string(result.InternalEvidence), syntheticFixtureSubject) {
		t.Fatal("transient fixture password or subject escaped into internal evidence")
	}

	uncheckedPassword := []byte(syntheticFixturePassword)
	uncheckedResult, err := client.Parse(context.Background(), Request{
		PDF: append([]byte(nil), pdf...), Password: uncheckedPassword,
		ArtifactID:  "artifact:synthetic-sidecar-unchecked",
		ImportID:    "import:synthetic-sidecar-unchecked",
		SubjectRef:  "subject:synthetic-sidecar-unchecked",
		CollectedAt: time.Date(2026, 7, 29, 0, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatal(err)
	}
	evidence := string(uncheckedResult.InternalEvidence)
	if !strings.Contains(evidence, `"status":"INCONCLUSIVE"`) ||
		!strings.Contains(evidence, `"policyRef":"mvp-subject-comparison-skipped:v1"`) ||
		strings.Contains(evidence, syntheticFixtureSubject) ||
		!allZero(uncheckedPassword) {
		t.Fatalf("unchecked subject decision was not preserved safely: %s", evidence)
	}

	mismatchPassword := []byte(syntheticFixturePassword)
	_, err = client.Parse(context.Background(), Request{
		PDF: append([]byte(nil), pdf...), Password: mismatchPassword,
		ArtifactID:          "artifact:synthetic-sidecar-mismatch",
		ImportID:            "import:synthetic-sidecar-mismatch",
		SubjectRef:          "subject:synthetic-sidecar-mismatch",
		CollectedAt:         time.Date(2026, 7, 29, 0, 0, 0, 0, time.UTC),
		ExpectedSubjectName: "NOT_THE_DOCUMENT_SUBJECT",
	})
	var parserError *Error
	if !errors.As(err, &parserError) || parserError.Code != "SUBJECT_MISMATCH" ||
		!allZero(mismatchPassword) {
		t.Fatalf("required subject comparison stopped failing closed: %#v", err)
	}
}
