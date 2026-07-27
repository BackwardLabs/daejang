package worker

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/BackwardLabs/daejang-db/pkg/sourcejobstore"
)

func TestSafeObjectPathRejectsTraversal(t *testing.T) {
	if _, err := safeObjectPath("/tmp/objects", "../secret"); err == nil {
		t.Fatal("path traversal was accepted")
	}
	value, err := safeObjectPath("/tmp/objects", "upbit/user/file.pdf")
	if err != nil || value != "/tmp/objects/upbit/user/file.pdf" {
		t.Fatalf("safe path failed: %q %v", value, err)
	}
}

type recordingStore struct {
	document sourcejobstore.DocumentSource
	code     string
	message  string
}

func (s *recordingStore) Claim(context.Context, time.Duration) (sourcejobstore.SyncJob, bool, error) {
	return sourcejobstore.SyncJob{}, false, nil
}
func (s *recordingStore) GetDocument(context.Context, string, string) (sourcejobstore.DocumentSource, bool, error) {
	return s.document, true, nil
}
func (s *recordingStore) Complete(context.Context, sourcejobstore.SyncJob, sourcejobstore.Progress) error {
	return nil
}
func (s *recordingStore) Fail(_ context.Context, _ sourcejobstore.SyncJob, code, message string) error {
	s.code, s.message = code, message
	return nil
}

func TestValidPdfFailsClosedUntilLayoutParserExists(t *testing.T) {
	root := t.TempDir()
	contents := []byte("%PDF-integration")
	objectKey := "upbit/source.pdf"
	path := filepath.Join(root, objectKey)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, contents, 0o600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(contents)
	store := &recordingStore{document: sourcejobstore.DocumentSource{
		ObjectKey: objectKey, ArtifactDigest: hex.EncodeToString(digest[:]),
	}}
	job := sourcejobstore.SyncJob{SubjectID: "subject", SourceID: "source", SourceKind: "UPBIT_PDF"}
	if err := (Runner{Store: store, ObjectRoot: root}).process(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if store.code != "UPBIT_PDF_LAYOUT_UNSUPPORTED" || store.message == "" {
		t.Fatalf("unexpected failure: code=%q message=%q", store.code, store.message)
	}
}
