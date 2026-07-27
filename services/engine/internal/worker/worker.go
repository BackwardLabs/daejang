package worker

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/BackwardLabs/daejang-db/pkg/sourcejobstore"
)

type Store interface {
	Claim(context.Context, time.Duration) (sourcejobstore.SyncJob, bool, error)
	GetDocument(context.Context, string, string) (sourcejobstore.DocumentSource, bool, error)
	Complete(context.Context, sourcejobstore.SyncJob, sourcejobstore.Progress) error
	Fail(context.Context, sourcejobstore.SyncJob, string, string) error
}

type Runner struct {
	Store         Store
	ObjectRoot    string
	LeaseDuration time.Duration
	PollInterval  time.Duration
}

func (r Runner) Run(ctx context.Context) error {
	if r.Store == nil || r.ObjectRoot == "" {
		return errors.New("worker store and object root are required")
	}
	if r.LeaseDuration <= 0 {
		r.LeaseDuration = 2 * time.Minute
	}
	if r.PollInterval <= 0 {
		r.PollInterval = time.Second
	}
	for {
		job, ok, err := r.Store.Claim(ctx, r.LeaseDuration)
		if err != nil {
			return err
		}
		if !ok {
			timer := time.NewTimer(r.PollInterval)
			select {
			case <-ctx.Done():
				timer.Stop()
				return nil
			case <-timer.C:
				continue
			}
		}
		if err := r.process(ctx, job); err != nil {
			return err
		}
	}
}

func (r Runner) process(ctx context.Context, job sourcejobstore.SyncJob) error {
	if job.SourceKind != "UPBIT_PDF" {
		return r.Store.Fail(ctx, job, "UNSUPPORTED_SOURCE_KIND", "이 소스 유형의 수집기는 아직 준비되지 않았습니다.")
	}
	source, found, err := r.Store.GetDocument(ctx, job.SubjectID, job.SourceID)
	if err != nil {
		return err
	}
	if !found {
		return r.Store.Fail(ctx, job, "SOURCE_NOT_FOUND", "등록된 문서 소스를 찾을 수 없습니다.")
	}
	path, err := safeObjectPath(r.ObjectRoot, source.ObjectKey)
	if err != nil {
		return r.Store.Fail(ctx, job, "INVALID_OBJECT_KEY", "저장된 파일 경로가 올바르지 않습니다.")
	}
	file, err := os.Open(path)
	if err != nil {
		return r.Store.Fail(ctx, job, "OBJECT_NOT_FOUND", "업로드된 PDF 파일을 찾을 수 없습니다.")
	}
	defer file.Close()
	hash := sha256.New()
	header := make([]byte, 5)
	if _, err := io.ReadFull(file, header); err != nil {
		return r.Store.Fail(ctx, job, "INVALID_PDF", "PDF 파일이 비어 있거나 손상되었습니다.")
	}
	if !bytes.Equal(header, []byte("%PDF-")) {
		return r.Store.Fail(ctx, job, "INVALID_PDF", "PDF 형식을 확인할 수 없습니다.")
	}
	if _, err := io.Copy(hash, io.MultiReader(bytes.NewReader(header), file)); err != nil {
		return err
	}
	if hex.EncodeToString(hash.Sum(nil)) != source.ArtifactDigest {
		return r.Store.Fail(ctx, job, "DIGEST_MISMATCH", "업로드 파일의 무결성 검증에 실패했습니다.")
	}
	// Provider-specific row extraction requires an approved Upbit document
	// fixture and layout version. Until that parser is present, fail closed
	// instead of reporting a successful zero-row import.
	return r.Store.Fail(ctx, job, "UPBIT_PDF_LAYOUT_UNSUPPORTED", "현재 지원하는 Upbit 거래내역 문서 형식이 아닙니다.")
}

func safeObjectPath(root, key string) (string, error) {
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	clean := filepath.Clean(strings.TrimSpace(key))
	if clean == "." || filepath.IsAbs(clean) || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", errors.New("unsafe object key")
	}
	value := filepath.Join(rootAbs, clean)
	if value != rootAbs && !strings.HasPrefix(value, rootAbs+string(filepath.Separator)) {
		return "", fmt.Errorf("object path escapes root")
	}
	return value, nil
}
