package worker

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/BackwardLabs/daejang-db/pkg/sourcejobstore"
)

type Store interface {
	Claim(context.Context, time.Duration) (sourcejobstore.SyncJob, bool, error)
	RenewLease(context.Context, sourcejobstore.SyncJob, time.Duration) error
	Retry(context.Context, sourcejobstore.SyncJob, time.Duration, string, string) error
	GetDocument(context.Context, string, string) (sourcejobstore.DocumentSource, bool, error)
	UpdateProgress(context.Context, sourcejobstore.SyncJob, sourcejobstore.Progress) (sourcejobstore.SyncJob, error)
	Complete(context.Context, sourcejobstore.SyncJob, sourcejobstore.Progress) error
	Fail(context.Context, sourcejobstore.SyncJob, string, string) error
}

type WalletSource struct {
	ID       string
	Address  string
	ChainIDs []string
}

type WalletStore interface {
	GetActiveWallet(context.Context, string, string) (WalletSource, bool, error)
	GetWalletForActionRuntimeReplay(context.Context, string, string) (WalletSource, bool, error)
}

type EVMJITRequest struct {
	IdempotencyKey string
	SubjectID      string
	SourceID       string
	Address        string
	ChainIDs       []string
	CoverageStart  time.Time
	CoverageEnd    time.Time
	Trigger        string
}

type JITRun struct{ ID string }

type JITTerminalResult struct {
	State            string
	FragmentID       string
	FailureCode      string
	FailureMessage   string
	ProcessedRecords int64
	TotalRecords     *int64
	CheckpointCursor string
	SegmentCursor    string
}

// JITFailure separates a permanent, user-visible source-job failure from a
// transient transport/runtime error that must leave the leased job retryable.
type JITFailure struct {
	code      string
	message   string
	retryable bool
	cause     error
}

func NewJITFailure(code, message string, retryable bool, cause error) *JITFailure {
	return &JITFailure{code: code, message: message, retryable: retryable, cause: cause}
}

func (e *JITFailure) Error() string {
	if e == nil {
		return ""
	}
	if e.cause != nil {
		return fmt.Sprintf("%s: %v", e.code, e.cause)
	}
	return e.code
}

func (e *JITFailure) Unwrap() error   { return e.cause }
func (e *JITFailure) Code() string    { return e.code }
func (e *JITFailure) Message() string { return e.message }
func (e *JITFailure) Retryable() bool { return e.retryable }

type EVMJITOrchestrator interface {
	Start(context.Context, EVMJITRequest) (JITRun, error)
	Retry(context.Context, JITRun) (JITRun, error)
	AwaitTerminal(context.Context, JITRun) (JITTerminalResult, error)
}

type Runner struct {
	Store             Store
	ObjectRoot        string
	ObjectKeyring     PrivateObjectKeyring
	LeaseDuration     time.Duration
	HeartbeatInterval time.Duration
	PollInterval      time.Duration
	RetryDelay        time.Duration
	Wallets           WalletStore
	EVMJIT            EVMJITOrchestrator
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
	if r.RetryDelay <= 0 {
		r.RetryDelay = 5 * time.Second
	}
	if r.HeartbeatInterval <= 0 {
		r.HeartbeatInterval = r.LeaseDuration / 3
	}
	if r.HeartbeatInterval <= 0 || r.HeartbeatInterval >= r.LeaseDuration {
		return errors.New("worker heartbeat interval must be positive and shorter than the lease")
	}
	for {
		job, ok, err := r.Store.Claim(ctx, r.LeaseDuration)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
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
		if err := r.processWithLease(ctx, job); err != nil {
			if ctx.Err() != nil {
				return nil
			}
			if errors.Is(err, sourcejobstore.ErrLeaseLost) {
				continue
			}
			code, message := retryDetails(err)
			if retryErr := r.Store.Retry(ctx, job, r.RetryDelay, code, message); retryErr != nil {
				if errors.Is(retryErr, sourcejobstore.ErrLeaseLost) {
					continue
				}
				return retryErr
			}
		}
	}
}

func (r Runner) processWithLease(ctx context.Context, job sourcejobstore.SyncJob) error {
	processCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	processDone := make(chan error, 1)
	heartbeatDone := make(chan error, 1)
	go func() { processDone <- r.process(processCtx, job) }()
	go func() { heartbeatDone <- r.maintainLease(processCtx, job) }()

	select {
	case processErr := <-processDone:
		cancel()
		heartbeatErr := <-heartbeatDone
		if processErr != nil && errors.Is(processErr, context.Canceled) && heartbeatErr != nil {
			return heartbeatErr
		}
		return processErr
	case heartbeatErr := <-heartbeatDone:
		cancel()
		processErr := <-processDone
		// A terminal mutation may win the race with a heartbeat and clear the
		// lease. In that case the committed terminal result is authoritative.
		if processErr == nil {
			return nil
		}
		if heartbeatErr != nil {
			return heartbeatErr
		}
		return processErr
	}
}

func (r Runner) maintainLease(ctx context.Context, job sourcejobstore.SyncJob) error {
	ticker := time.NewTicker(r.HeartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			if err := r.Store.RenewLease(ctx, job, r.LeaseDuration); err != nil {
				if ctx.Err() != nil {
					return nil
				}
				return err
			}
		}
	}
}

func retryDetails(err error) (string, string) {
	var failure *JITFailure
	if errors.As(err, &failure) && failure.Retryable() {
		code := strings.TrimSpace(failure.Code())
		if code == "" {
			code = "JIT_RETRYABLE_FAILURE"
		}
		message := strings.TrimSpace(failure.Message())
		if message == "" {
			message = "JIT 실행을 일시적으로 완료하지 못해 다시 시도합니다."
		}
		return code, message
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "SYNC_UPSTREAM_TIMEOUT", "상위 처리기의 응답 시간이 초과되어 다시 시도합니다."
	}
	return "SYNC_RETRYABLE_FAILURE", "동기화 작업을 일시적으로 완료하지 못해 다시 시도합니다."
}

func (r Runner) process(ctx context.Context, job sourcejobstore.SyncJob) error {
	switch job.SourceKind {
	case "EVM_WALLET":
		return r.processEVM(ctx, job)
	case "UPBIT_PDF":
		return r.processUpbit(ctx, job)
	default:
		return r.Store.Fail(ctx, job, "UNSUPPORTED_SOURCE_KIND", "이 소스 유형의 수집기는 아직 준비되지 않았습니다.")
	}
}

func (r Runner) processEVM(ctx context.Context, job sourcejobstore.SyncJob) error {
	if r.Wallets == nil || r.EVMJIT == nil {
		return r.Store.Fail(ctx, job, "EVM_JIT_UNAVAILABLE", "EVM JIT 실행기가 구성되지 않았습니다.")
	}
	var wallet WalletSource
	var found bool
	var err error
	if sourcejobstore.IsActionRuntimeReplay(job.Trigger, job.IdempotencyKey) {
		wallet, found, err = r.Wallets.GetWalletForActionRuntimeReplay(ctx, job.SubjectID, job.SourceID)
	} else {
		wallet, found, err = r.Wallets.GetActiveWallet(ctx, job.SubjectID, job.SourceID)
	}
	if err != nil {
		return err
	}
	if !found {
		return r.Store.Fail(ctx, job, "SOURCE_NOT_FOUND", "등록된 지갑 소스를 찾을 수 없습니다.")
	}
	if job.RequestedCoverageStart == nil || job.RequestedCoverageEnd == nil {
		return r.Store.Fail(ctx, job, "SYNC_COVERAGE_MISSING", "동기화 요청 기간이 없습니다.")
	}
	run := JITRun{ID: job.UpstreamJITRunID}
	if run.ID == "" {
		run, err = r.EVMJIT.Start(ctx, EVMJITRequest{
			IdempotencyKey: job.ID, SubjectID: job.SubjectID, SourceID: job.SourceID,
			Address: wallet.Address, ChainIDs: append([]string(nil), wallet.ChainIDs...),
			CoverageStart: *job.RequestedCoverageStart, CoverageEnd: *job.RequestedCoverageEnd,
			Trigger: job.Trigger,
		})
		if err != nil {
			return r.handleJITError(ctx, job, err)
		}
		if strings.TrimSpace(run.ID) == "" {
			return r.Store.Fail(ctx, job, "JIT_RUN_INVALID", "JIT 실행 식별자가 비어 있습니다.")
		}
		job, err = r.Store.UpdateProgress(ctx, job, sourcejobstore.Progress{
			Phase: "PUBLISH", UpstreamJITRunID: run.ID, ExpectedVersion: job.ProgressVersion,
		})
		if err != nil {
			return err
		}
	}
	terminal, err := r.EVMJIT.AwaitTerminal(ctx, run)
	if err != nil {
		return r.handleJITError(ctx, job, err)
	}
	if terminal.State != "SUCCEEDED" {
		if job.Attempts == 1 {
			retried, retryErr := r.EVMJIT.Retry(ctx, run)
			if retryErr != nil {
				return r.handleJITError(ctx, job, retryErr)
			}
			if strings.TrimSpace(retried.ID) == "" {
				return r.Store.Fail(ctx, job, "JIT_RETRY_INVALID", "JIT 재시도 실행 식별자가 비어 있습니다.")
			}
			job, err = r.Store.UpdateProgress(ctx, job, sourcejobstore.Progress{
				Phase: "PUBLISH", UpstreamJITRunID: retried.ID, ExpectedVersion: job.ProgressVersion,
			})
			if err != nil {
				return err
			}
			return NewJITFailure("JIT_RUN_RETRIED", "실패한 JIT 실행을 새 revision으로 다시 시도합니다.", true, nil)
		}
		code := strings.TrimSpace(terminal.FailureCode)
		if code == "" {
			code = "JIT_RUN_FAILED"
		}
		message := strings.TrimSpace(terminal.FailureMessage)
		if message == "" {
			message = "JIT 실행이 완료되지 않았습니다."
		}
		return r.Store.Fail(ctx, job, code, message)
	}
	if strings.TrimSpace(terminal.FragmentID) == "" {
		return r.Store.Fail(ctx, job, "JIT_TERMINAL_FRAGMENT_MISSING", "JIT 성공 결과에 terminal fragment가 없습니다.")
	}
	return r.Store.Complete(ctx, job, sourcejobstore.Progress{
		Phase: "COMPLETE", ProcessedRecords: terminal.ProcessedRecords, TotalRecords: terminal.TotalRecords,
		CheckpointCursor: terminal.CheckpointCursor, SegmentCursor: terminal.SegmentCursor,
		UpstreamJITRunID: run.ID, OutputFragmentID: terminal.FragmentID,
		ExpectedVersion: job.ProgressVersion,
	})
}

func (r Runner) handleJITError(ctx context.Context, job sourcejobstore.SyncJob, err error) error {
	var failure *JITFailure
	if !errors.As(err, &failure) || failure.Retryable() {
		return err
	}
	code := strings.TrimSpace(failure.Code())
	if code == "" {
		code = "JIT_REQUEST_FAILED"
	}
	message := strings.TrimSpace(failure.Message())
	if message == "" {
		message = "JIT 실행 요청을 처리할 수 없습니다."
	}
	return r.Store.Fail(ctx, job, code, message)
}

func (r Runner) processUpbit(ctx context.Context, job sourcejobstore.SyncJob) error {
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
	contents, err := readPrivateObject(path, r.ObjectKeyring, source.ObjectKey)
	if err != nil {
		if errors.Is(err, errPrivateObjectNotFound) {
			return r.Store.Fail(ctx, job, "OBJECT_NOT_FOUND", "업로드된 PDF 파일을 찾을 수 없습니다.")
		}
		return r.Store.Fail(ctx, job, "OBJECT_DECRYPT_FAILED", "암호화된 업로드 파일을 읽을 수 없습니다.")
	}
	if len(contents) < 5 {
		return r.Store.Fail(ctx, job, "INVALID_PDF", "PDF 파일이 비어 있거나 손상되었습니다.")
	}
	if string(contents[:5]) != "%PDF-" {
		return r.Store.Fail(ctx, job, "INVALID_PDF", "PDF 형식을 확인할 수 없습니다.")
	}
	hash := sha256.Sum256(contents)
	if hex.EncodeToString(hash[:]) != source.ArtifactDigest {
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
