package worker

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
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
	document  sourcejobstore.DocumentSource
	code      string
	message   string
	progress  []sourcejobstore.Progress
	completed bool
}

func (s *recordingStore) Claim(context.Context, time.Duration) (sourcejobstore.SyncJob, bool, error) {
	return sourcejobstore.SyncJob{}, false, nil
}
func (s *recordingStore) RenewLease(context.Context, sourcejobstore.SyncJob, time.Duration) error {
	return nil
}
func (s *recordingStore) Retry(context.Context, sourcejobstore.SyncJob, time.Duration, string, string) error {
	return nil
}
func (s *recordingStore) GetDocument(context.Context, string, string) (sourcejobstore.DocumentSource, bool, error) {
	return s.document, true, nil
}
func (s *recordingStore) UpdateProgress(_ context.Context, job sourcejobstore.SyncJob, progress sourcejobstore.Progress) (sourcejobstore.SyncJob, error) {
	s.progress = append(s.progress, progress)
	job.ProgressVersion++
	job.UpstreamJITRunID = progress.UpstreamJITRunID
	return job, nil
}
func (s *recordingStore) Complete(_ context.Context, _ sourcejobstore.SyncJob, progress sourcejobstore.Progress) error {
	s.progress = append(s.progress, progress)
	s.completed = true
	return nil
}
func (s *recordingStore) Fail(_ context.Context, _ sourcejobstore.SyncJob, code, message string) error {
	s.code, s.message = code, message
	return nil
}

type fakeWalletStore struct{ value WalletSource }

func (s fakeWalletStore) GetActiveWallet(context.Context, string, string) (WalletSource, bool, error) {
	return s.value, s.value.ID != "", nil
}

type fakeJIT struct {
	started  int
	retried  int
	request  EVMJITRequest
	terminal JITTerminalResult
	startErr error
	retryErr error
	awaitErr error
}

func (j *fakeJIT) Start(_ context.Context, request EVMJITRequest) (JITRun, error) {
	j.started++
	j.request = request
	if j.startErr != nil {
		return JITRun{}, j.startErr
	}
	return JITRun{ID: "jit-run-1"}, nil
}

func (j *fakeJIT) Retry(_ context.Context, _ JITRun) (JITRun, error) {
	j.retried++
	if j.retryErr != nil {
		return JITRun{}, j.retryErr
	}
	return JITRun{ID: "jit-run-retry-1"}, nil
}

func (j *fakeJIT) AwaitTerminal(context.Context, JITRun) (JITTerminalResult, error) {
	if j.awaitErr != nil {
		return JITTerminalResult{}, j.awaitErr
	}
	return j.terminal, nil
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

func TestEVMJobCompletesOnlyWithTerminalFragment(t *testing.T) {
	for name, terminal := range map[string]JITTerminalResult{
		"missing fragment":   {State: "SUCCEEDED"},
		"published fragment": {State: "SUCCEEDED", FragmentID: "fragment-1", ProcessedRecords: 3},
	} {
		t.Run(name, func(t *testing.T) {
			store := &recordingStore{}
			jit := &fakeJIT{terminal: terminal}
			coverageStart := time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC)
			coverageEnd := time.Date(2027, 12, 31, 0, 0, 0, 0, time.UTC)
			job := sourcejobstore.SyncJob{
				ID: "job-1", SubjectID: "subject-1", SourceID: "wallet-1", SourceKind: "EVM_WALLET",
				LeaseToken: "lease-1", RequestedCoverageStart: &coverageStart,
				RequestedCoverageEnd: &coverageEnd, Trigger: "USER_REQUEST",
			}
			runner := Runner{
				Store: store, Wallets: fakeWalletStore{value: WalletSource{
					ID: "wallet-1", Address: "0x1111111111111111111111111111111111111111", ChainIDs: []string{"eip155:1"},
				}}, EVMJIT: jit,
			}
			if err := runner.process(context.Background(), job); err != nil {
				t.Fatal(err)
			}
			if terminal.FragmentID == "" {
				if store.completed || store.code != "JIT_TERMINAL_FRAGMENT_MISSING" {
					t.Fatalf("fragment-less JIT success escaped fail-closed: %#v", store)
				}
				return
			}
			if !store.completed || store.code != "" {
				t.Fatalf("published fragment did not complete: %#v", store)
			}
			last := store.progress[len(store.progress)-1]
			if last.OutputFragmentID != terminal.FragmentID || last.ExpectedVersion != 1 {
				t.Fatalf("completion did not use fenced terminal progress: %#v", last)
			}
			if jit.request.CoverageStart.Format("2006-01-02") != "2027-01-01" || jit.request.CoverageEnd.Format("2006-01-02") != "2027-12-31" {
				t.Fatalf("inclusive DATE coverage was not preserved: %#v", jit.request)
			}
		})
	}
}

func TestEVMJobRetriesOneFailedJITRevisionBeforeFailingTheSourceJob(t *testing.T) {
	store := &recordingStore{}
	jit := &fakeJIT{terminal: JITTerminalResult{State: "FAILED", FailureCode: "JIT_RUN_FAILED"}}
	coverageStart := time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC)
	coverageEnd := time.Date(2027, 12, 31, 0, 0, 0, 0, time.UTC)
	job := sourcejobstore.SyncJob{
		ID: "job-1", SubjectID: "subject-1", SourceID: "wallet-1", SourceKind: "EVM_WALLET",
		LeaseToken: "lease-1", Attempts: 1, RequestedCoverageStart: &coverageStart,
		RequestedCoverageEnd: &coverageEnd, Trigger: "BACKFILL",
	}
	err := (Runner{
		Store: store, Wallets: fakeWalletStore{value: WalletSource{ID: "wallet-1", Address: "0x0000000000000000000000000000000000000001", ChainIDs: []string{"eip155:1"}}},
		EVMJIT: jit, ObjectRoot: t.TempDir(),
	}).processEVM(context.Background(), job)
	var failure *JITFailure
	if !errors.As(err, &failure) || !failure.Retryable() || jit.retried != 1 || store.code != "" {
		t.Fatalf("failed JIT revision was not left retryable: error=%v retries=%d failure=%q", err, jit.retried, store.code)
	}
	if len(store.progress) != 2 || store.progress[1].UpstreamJITRunID != "jit-run-retry-1" {
		t.Fatalf("retry run was not persisted before releasing the source job: %#v", store.progress)
	}
}

func TestEVMJobResumesPersistedJITRunWithoutStartingDuplicate(t *testing.T) {
	store := &recordingStore{}
	jit := &fakeJIT{terminal: JITTerminalResult{State: "SUCCEEDED", FragmentID: "fragment-1"}}
	coverageStart := time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC)
	coverageEnd := time.Date(2027, 12, 31, 0, 0, 0, 0, time.UTC)
	job := sourcejobstore.SyncJob{
		ID: "job-1", SubjectID: "subject-1", SourceID: "wallet-1", SourceKind: "EVM_WALLET",
		LeaseToken: "lease-2", UpstreamJITRunID: "jit-run-existing", ProgressVersion: 4,
		RequestedCoverageStart: &coverageStart, RequestedCoverageEnd: &coverageEnd,
	}
	runner := Runner{Store: store, Wallets: fakeWalletStore{value: WalletSource{ID: "wallet-1"}}, EVMJIT: jit}
	if err := runner.process(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if jit.started != 0 || !store.completed {
		t.Fatalf("persisted run was duplicated or not completed: started=%d completed=%v", jit.started, store.completed)
	}
	if got := store.progress[len(store.progress)-1].ExpectedVersion; got != 4 {
		t.Fatalf("resume lost progress fence: got %d", got)
	}
}

func TestEVMJobClosesPermanentJITConfigurationFailure(t *testing.T) {
	coverageStart := time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC)
	coverageEnd := time.Date(2027, 12, 31, 0, 0, 0, 0, time.UTC)
	job := sourcejobstore.SyncJob{
		ID: "job-1", SubjectID: "subject-1", SourceID: "wallet-1", SourceKind: "EVM_WALLET",
		RequestedCoverageStart: &coverageStart, RequestedCoverageEnd: &coverageEnd,
	}
	store := &recordingStore{}
	runner := Runner{
		Store: store, Wallets: fakeWalletStore{value: WalletSource{ID: "wallet-1"}},
		EVMJIT: &fakeJIT{startErr: NewJITFailure("JIT_COVERAGE_MAPPING_UNAVAILABLE", "검증된 블록 범위가 없습니다.", false, nil)},
	}
	if err := runner.process(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if store.code != "JIT_COVERAGE_MAPPING_UNAVAILABLE" || store.message == "" {
		t.Fatalf("permanent JIT configuration failure was not closed on the job: %#v", store)
	}
}

func TestEVMJobLeavesTransientJITFailureRetryable(t *testing.T) {
	coverageStart := time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC)
	coverageEnd := time.Date(2027, 12, 31, 0, 0, 0, 0, time.UTC)
	job := sourcejobstore.SyncJob{
		ID: "job-1", SubjectID: "subject-1", SourceID: "wallet-1", SourceKind: "EVM_WALLET",
		RequestedCoverageStart: &coverageStart, RequestedCoverageEnd: &coverageEnd,
	}
	store := &recordingStore{}
	runner := Runner{
		Store: store, Wallets: fakeWalletStore{value: WalletSource{ID: "wallet-1"}},
		EVMJIT: &fakeJIT{startErr: NewJITFailure("JIT_START_FAILED", "일시적인 JIT 오류입니다.", true, context.DeadlineExceeded)},
	}
	if err := runner.process(context.Background(), job); err == nil {
		t.Fatal("transient JIT failure was converted into a terminal source-job failure")
	}
	if store.code != "" || store.completed {
		t.Fatalf("transient failure mutated terminal job state: %#v", store)
	}
}

type heartbeatStore struct {
	recordingStore
	renewed  chan struct{}
	renewErr error
}

func (s *heartbeatStore) RenewLease(context.Context, sourcejobstore.SyncJob, time.Duration) error {
	if s.renewErr != nil {
		return s.renewErr
	}
	select {
	case s.renewed <- struct{}{}:
	default:
	}
	return nil
}

type heartbeatJIT struct {
	renewed  <-chan struct{}
	canceled chan struct{}
}

func (j heartbeatJIT) Start(context.Context, EVMJITRequest) (JITRun, error) {
	return JITRun{ID: "jit-run-heartbeat"}, nil
}

func (j heartbeatJIT) Retry(context.Context, JITRun) (JITRun, error) {
	return JITRun{ID: "jit-run-heartbeat-retry"}, nil
}

func (j heartbeatJIT) AwaitTerminal(ctx context.Context, _ JITRun) (JITTerminalResult, error) {
	if j.renewed != nil {
		for range 2 {
			select {
			case <-ctx.Done():
				return JITTerminalResult{}, ctx.Err()
			case <-j.renewed:
			}
		}
		return JITTerminalResult{State: "SUCCEEDED", FragmentID: "fragment-heartbeat"}, nil
	}
	<-ctx.Done()
	close(j.canceled)
	return JITTerminalResult{}, ctx.Err()
}

func heartbeatJob() sourcejobstore.SyncJob {
	coverageStart := time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC)
	coverageEnd := time.Date(2027, 12, 31, 0, 0, 0, 0, time.UTC)
	return sourcejobstore.SyncJob{
		ID: "job-heartbeat", SubjectID: "subject-heartbeat", SourceID: "wallet-heartbeat",
		SourceKind: "EVM_WALLET", LeaseToken: "lease-heartbeat",
		RequestedCoverageStart: &coverageStart, RequestedCoverageEnd: &coverageEnd,
		Trigger: "USER_REQUEST",
	}
}

func TestProcessWithLeaseRenewsUntilJITCompletes(t *testing.T) {
	renewed := make(chan struct{}, 4)
	store := &heartbeatStore{renewed: renewed}
	runner := Runner{
		Store: store, LeaseDuration: 90 * time.Millisecond, HeartbeatInterval: 10 * time.Millisecond,
		Wallets: fakeWalletStore{value: WalletSource{ID: "wallet-heartbeat"}},
		EVMJIT:  heartbeatJIT{renewed: renewed},
	}
	if err := runner.processWithLease(context.Background(), heartbeatJob()); err != nil {
		t.Fatal(err)
	}
	if !store.completed {
		t.Fatal("terminal JIT result did not complete after maintained lease")
	}
}

func TestProcessWithLeaseCancelsJITWhenHeartbeatLosesFence(t *testing.T) {
	canceled := make(chan struct{})
	store := &heartbeatStore{renewed: make(chan struct{}, 1), renewErr: sourcejobstore.ErrLeaseLost}
	runner := Runner{
		Store: store, LeaseDuration: 90 * time.Millisecond, HeartbeatInterval: 10 * time.Millisecond,
		Wallets: fakeWalletStore{value: WalletSource{ID: "wallet-heartbeat"}},
		EVMJIT:  heartbeatJIT{canceled: canceled},
	}
	err := runner.processWithLease(context.Background(), heartbeatJob())
	if !errors.Is(err, sourcejobstore.ErrLeaseLost) {
		t.Fatalf("heartbeat fence loss was not propagated: %v", err)
	}
	select {
	case <-canceled:
	case <-time.After(time.Second):
		t.Fatal("JIT await was not canceled after heartbeat fence loss")
	}
	if store.completed || store.code != "" {
		t.Fatalf("lost lease mutated terminal state: %#v", store)
	}
}

type terminalRaceStore struct {
	heartbeatStore
	renewEntered    chan struct{}
	completeStarted chan struct{}
}

type oneRenewJIT struct{ renewed <-chan struct{} }

func (j oneRenewJIT) Start(context.Context, EVMJITRequest) (JITRun, error) {
	return JITRun{ID: "jit-run-terminal-race"}, nil
}

func (j oneRenewJIT) Retry(context.Context, JITRun) (JITRun, error) {
	return JITRun{ID: "jit-run-terminal-race-retry"}, nil
}

func (j oneRenewJIT) AwaitTerminal(ctx context.Context, _ JITRun) (JITTerminalResult, error) {
	select {
	case <-ctx.Done():
		return JITTerminalResult{}, ctx.Err()
	case <-j.renewed:
		return JITTerminalResult{State: "SUCCEEDED", FragmentID: "fragment-terminal-race"}, nil
	}
}

func (s *terminalRaceStore) RenewLease(context.Context, sourcejobstore.SyncJob, time.Duration) error {
	close(s.renewEntered)
	<-s.completeStarted
	return sourcejobstore.ErrLeaseLost
}

func (s *terminalRaceStore) Complete(context.Context, sourcejobstore.SyncJob, sourcejobstore.Progress) error {
	close(s.completeStarted)
	s.completed = true
	return nil
}

func TestProcessWithLeaseAcceptsCommittedTerminalResultRacingHeartbeat(t *testing.T) {
	renewEntered := make(chan struct{})
	store := &terminalRaceStore{
		heartbeatStore: heartbeatStore{renewed: make(chan struct{}, 1)},
		renewEntered:   renewEntered, completeStarted: make(chan struct{}),
	}
	j := oneRenewJIT{renewed: renewEntered}
	runner := Runner{
		Store: store, LeaseDuration: 90 * time.Millisecond, HeartbeatInterval: 10 * time.Millisecond,
		Wallets: fakeWalletStore{value: WalletSource{ID: "wallet-heartbeat"}}, EVMJIT: j,
	}
	if err := runner.processWithLease(context.Background(), heartbeatJob()); err != nil {
		t.Fatalf("committed terminal state lost race to heartbeat: %v", err)
	}
	if !store.completed {
		t.Fatal("terminal state was not committed")
	}
}

type runRetryStore struct {
	recordingStore
	cancel    context.CancelFunc
	claimDone bool
	retryCode string
}

func (s *runRetryStore) Claim(context.Context, time.Duration) (sourcejobstore.SyncJob, bool, error) {
	if s.claimDone {
		return sourcejobstore.SyncJob{}, false, nil
	}
	s.claimDone = true
	return heartbeatJob(), true, nil
}

func (s *runRetryStore) Retry(_ context.Context, _ sourcejobstore.SyncJob, _ time.Duration, code, _ string) error {
	s.retryCode = code
	s.cancel()
	return nil
}

func TestRunRequeuesTransientJITFailureWithoutCrashingWorker(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	store := &runRetryStore{cancel: cancel}
	runner := Runner{
		Store: store, ObjectRoot: t.TempDir(), LeaseDuration: 90 * time.Millisecond,
		HeartbeatInterval: 10 * time.Millisecond, PollInterval: time.Millisecond, RetryDelay: time.Millisecond,
		Wallets: fakeWalletStore{value: WalletSource{ID: "wallet-heartbeat"}},
		EVMJIT:  &fakeJIT{startErr: NewJITFailure("JIT_START_FAILED", "일시적인 JIT 오류입니다.", true, context.DeadlineExceeded)},
	}
	if err := runner.Run(ctx); err != nil {
		t.Fatal(err)
	}
	if store.retryCode != "JIT_START_FAILED" {
		t.Fatalf("transient JIT failure was not requeued safely: %q", store.retryCode)
	}
}
