package jitgrpc

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/BackwardLabs/daejang/services/engine/internal/worker"
	jitv1 "github.com/BackwardLabs/daejang/services/engine/internal/worker/jitgrpc/contract"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/local"
	"google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"
)

type Client struct {
	candidate jitv1.CandidateQueryServiceClient
	jit       jitv1.JitEngineServiceClient
	config    runtimeConfig
	close     func() error
}

func Dial(ctx context.Context, config Config) (*Client, error) {
	validated, err := validate(config)
	if err != nil {
		return nil, err
	}
	connection, err := dial(ctx, validated)
	if err != nil {
		return nil, err
	}
	return &Client{
		candidate: jitv1.NewCandidateQueryServiceClient(connection),
		jit:       jitv1.NewJitEngineServiceClient(connection), config: validated, close: connection.Close,
	}, nil
}

func New(candidate jitv1.CandidateQueryServiceClient, jit jitv1.JitEngineServiceClient, config Config) (*Client, error) {
	if candidate == nil || jit == nil {
		return nil, errors.New("JIT candidate and run clients are required")
	}
	validated, err := validate(config)
	if err != nil {
		return nil, err
	}
	return &Client{candidate: candidate, jit: jit, config: validated, close: func() error { return nil }}, nil
}

func (c *Client) Close() error {
	if c == nil || c.close == nil {
		return nil
	}
	return c.close()
}

func dial(ctx context.Context, config runtimeConfig) (*grpc.ClientConn, error) {
	options := []grpc.DialOption{}
	target := config.endpoint.Host
	if config.endpoint.Scheme == "unix" {
		socket := config.endpoint.Path
		target = "passthrough:///" + socket
		options = append(options,
			grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
				return (&net.Dialer{}).DialContext(ctx, "unix", socket)
			}),
			grpc.WithTransportCredentials(local.NewCredentials()),
		)
	} else {
		tlsConfig, err := clientTLS(config.endpoint.Hostname(), config.TLS)
		if err != nil {
			return nil, err
		}
		options = append(options, grpc.WithTransportCredentials(credentials.NewTLS(tlsConfig)))
	}
	connection, err := grpc.NewClient(target, options...)
	if err != nil {
		return nil, fmt.Errorf("create authenticated JIT client: %w", err)
	}
	healthClient := grpc_health_v1.NewHealthClient(connection)
	for _, service := range []string{
		jitv1.CandidateQueryService_ServiceDesc.ServiceName,
		jitv1.JitEngineService_ServiceDesc.ServiceName,
	} {
		healthCtx, cancel := context.WithTimeout(ctx, config.requestTimeout)
		response, healthErr := healthClient.Check(healthCtx, &grpc_health_v1.HealthCheckRequest{Service: service})
		cancel()
		if healthErr != nil || response.GetStatus() != grpc_health_v1.HealthCheckResponse_SERVING {
			_ = connection.Close()
			if healthErr != nil {
				return nil, fmt.Errorf("authenticate and health-check JIT service %s: %w", service, healthErr)
			}
			return nil, fmt.Errorf("JIT service %s is not serving", service)
		}
	}
	if err := ctx.Err(); err != nil {
		_ = connection.Close()
		return nil, err
	}
	return connection, nil
}

func clientTLS(defaultServerName string, config TLSConfig) (*tls.Config, error) {
	certificate, err := tls.LoadX509KeyPair(config.CertFile, config.KeyFile)
	if err != nil {
		return nil, fmt.Errorf("load JIT client certificate: %w", err)
	}
	caBytes, err := os.ReadFile(config.CAFile)
	if err != nil {
		return nil, fmt.Errorf("read JIT client CA: %w", err)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(caBytes) {
		return nil, errors.New("JIT client CA does not contain a PEM certificate")
	}
	serverName := strings.TrimSpace(config.ServerName)
	if serverName == "" {
		serverName = defaultServerName
	}
	return &tls.Config{
		MinVersion: tls.VersionTLS13, RootCAs: roots, Certificates: []tls.Certificate{certificate}, ServerName: serverName,
	}, nil
}

func (c *Client) Start(ctx context.Context, request worker.EVMJITRequest) (worker.JITRun, error) {
	chains, mappings, err := c.resolve(request)
	if err != nil {
		return worker.JITRun{}, err
	}
	selections := make([]*jitv1.CandidateSelectionBinding, 0, len(chains))
	accounts := make([]*jitv1.JitAccountInput, 0, len(chains))
	for index, chain := range chains {
		mapping := mappings[index]
		selection, err := c.materialize(ctx, chain, mapping, request.Address)
		if err != nil {
			return worker.JITRun{}, err
		}
		accountID := stableID("wallet-account", request.SubjectID, request.SourceID, chain.ChainID)
		accounts = append(accounts, &jitv1.JitAccountInput{
			AccountId: accountID, ChainId: chain.ChainID, Address: strings.ToLower(request.Address),
			OwnershipFrom: timestamppb.New(normalizeDate(request.CoverageStart)),
			OwnershipTo:   timestamppb.New(normalizeDate(request.CoverageEnd).AddDate(0, 0, 1)),
		})
		selections = append(selections, &jitv1.CandidateSelectionBinding{AccountId: accountID, Selection: selection})
	}
	rpcCtx, cancel := context.WithTimeout(ctx, c.config.requestTimeout)
	defer cancel()
	response, err := c.jit.StartJitRun(rpcCtx, &jitv1.StartJitRunRequest{
		GenerationId: stableID("sync-job", request.IdempotencyKey), SubjectId: request.SubjectID,
		IndexSnapshotId: mappings[0].IndexSnapshotID, EvidenceProfile: chains[0].EvidenceProfile,
		Accounts: accounts, CandidateSelections: selections,
	})
	if err != nil {
		return worker.JITRun{}, rpcFailure("JIT_START_FAILED", "JIT 실행 요청에 실패했습니다.", err)
	}
	if response.GetAccepted() == nil || strings.TrimSpace(response.GetAccepted().GetRunId()) == "" {
		return worker.JITRun{}, worker.NewJITFailure("JIT_START_INVALID_RESPONSE", "JIT 실행 식별자를 받지 못했습니다.", false, nil)
	}
	return worker.JITRun{ID: response.GetAccepted().GetRunId()}, nil
}

func (c *Client) materialize(ctx context.Context, chain chainRuntime, mapping coverageRuntime, address string) (*jitv1.AccountCandidateSelectionRef, error) {
	rpcCtx, cancel := context.WithTimeout(ctx, c.config.requestTimeout)
	defer cancel()
	response, err := c.candidate.MaterializeAccountSelection(rpcCtx, &jitv1.MaterializeAccountSelectionRequest{
		IndexSnapshotId: mapping.IndexSnapshotID, ChainStore: chain.ChainStore, ChainId: chain.ChainID,
		GenesisHash: chain.GenesisHash, Address: strings.ToLower(address),
		Range:           &jitv1.BlockRange{FromBlock: strconv.FormatUint(mapping.FromBlock, 10), ToBlock: strconv.FormatUint(mapping.ToBlock, 10)},
		EvidenceProfile: chain.EvidenceProfile, ProfileHash: chain.ProfileHash,
	})
	if err != nil {
		return nil, rpcFailure("JIT_SELECTION_FAILED", "JIT 후보 범위 생성에 실패했습니다.", err)
	}
	selection := response.GetSelection()
	if selection == nil || selection.GetSelectionId() == "" || !digestPattern.MatchString(selection.GetSelectionDigest()) {
		return nil, worker.NewJITFailure("JIT_SELECTION_INVALID_RESPONSE", "JIT 후보 범위 응답이 올바르지 않습니다.", false, nil)
	}
	return selection, nil
}

func (c *Client) AwaitTerminal(ctx context.Context, run worker.JITRun) (worker.JITTerminalResult, error) {
	if strings.TrimSpace(run.ID) == "" {
		return worker.JITTerminalResult{}, worker.NewJITFailure("JIT_RUN_INVALID", "JIT 실행 식별자가 비어 있습니다.", false, nil)
	}
	awaitCtx, cancel := context.WithTimeout(ctx, c.config.awaitTimeout)
	defer cancel()
	ticker := time.NewTicker(c.config.pollInterval)
	defer ticker.Stop()
	for {
		result, retry, err := c.getRun(awaitCtx, run.ID)
		if err == nil && !retry {
			return result, nil
		}
		if err != nil && !retry {
			return worker.JITTerminalResult{}, err
		}
		select {
		case <-awaitCtx.Done():
			return worker.JITTerminalResult{}, worker.NewJITFailure("JIT_AWAIT_TIMEOUT", "JIT 실행 완료를 기다리는 시간이 초과되었습니다.", true, awaitCtx.Err())
		case <-ticker.C:
		}
	}
}

func (c *Client) getRun(ctx context.Context, runID string) (worker.JITTerminalResult, bool, error) {
	rpcCtx, cancel := context.WithTimeout(ctx, c.config.requestTimeout)
	defer cancel()
	response, err := c.jit.GetJitRun(rpcCtx, &jitv1.GetJitRunRequest{RunId: runID})
	if err != nil {
		failure := rpcFailure("JIT_STATUS_FAILED", "JIT 실행 상태를 조회하지 못했습니다.", err)
		var typed *worker.JITFailure
		if errors.As(failure, &typed) && typed.Retryable() {
			return worker.JITTerminalResult{}, true, nil
		}
		return worker.JITTerminalResult{}, false, failure
	}
	result := response.GetResult()
	if result == nil || result.GetRunId() != runID {
		return worker.JITTerminalResult{}, false, worker.NewJITFailure("JIT_STATUS_INVALID_RESPONSE", "JIT 실행 상태 응답이 올바르지 않습니다.", false, nil)
	}
	switch result.GetStatus() {
	case "ACCEPTED", "RUNNING":
		return worker.JITTerminalResult{}, true, nil
	case "COMPLETE", "PARTIAL":
		if strings.TrimSpace(result.GetSubjectEvidenceFragmentId()) == "" {
			return worker.JITTerminalResult{}, false, worker.NewJITFailure("JIT_TERMINAL_FRAGMENT_MISSING", "JIT 성공 결과에 terminal fragment가 없습니다.", false, nil)
		}
		processed, total := progressCounts(result.GetProgress())
		return worker.JITTerminalResult{
			State: "SUCCEEDED", FragmentID: result.GetSubjectEvidenceFragmentId(), ProcessedRecords: processed, TotalRecords: total,
			CheckpointCursor: result.GetResultDigest(), SegmentCursor: result.GetIndexSnapshotId(),
		}, false, nil
	case "FAILED":
		return worker.JITTerminalResult{State: "FAILED", FailureCode: "JIT_RUN_FAILED", FailureMessage: "JIT 실행이 실패했습니다."}, false, nil
	default:
		return worker.JITTerminalResult{}, false, worker.NewJITFailure("JIT_STATUS_UNKNOWN", "알 수 없는 JIT 실행 상태입니다.", false, nil)
	}
}

func (c *Client) resolve(request worker.EVMJITRequest) ([]chainRuntime, []coverageRuntime, error) {
	if strings.TrimSpace(request.IdempotencyKey) == "" || strings.TrimSpace(request.SubjectID) == "" || strings.TrimSpace(request.SourceID) == "" {
		return nil, nil, worker.NewJITFailure("JIT_REQUEST_INVALID", "JIT 요청 식별자가 올바르지 않습니다.", false, nil)
	}
	address := strings.ToLower(strings.TrimSpace(request.Address))
	if !evmAddressPattern.MatchString(address) {
		return nil, nil, worker.NewJITFailure("JIT_REQUEST_INVALID", "등록된 EVM 지갑 주소가 올바르지 않습니다.", false, nil)
	}
	start, end := normalizeDate(request.CoverageStart), normalizeDate(request.CoverageEnd)
	if end.Before(start) || len(request.ChainIDs) == 0 {
		return nil, nil, worker.NewJITFailure("JIT_REQUEST_INVALID", "JIT 체인 또는 요청 기간이 올바르지 않습니다.", false, nil)
	}
	chainIDs := append([]string(nil), request.ChainIDs...)
	sort.Strings(chainIDs)
	chains := make([]chainRuntime, 0, len(chainIDs))
	mappings := make([]coverageRuntime, 0, len(chainIDs))
	seen := make(map[string]struct{}, len(chainIDs))
	var snapshot string
	for _, chainID := range chainIDs {
		if _, duplicate := seen[chainID]; duplicate {
			continue
		}
		seen[chainID] = struct{}{}
		chain, ok := c.config.chains[chainID]
		if !ok {
			return nil, nil, worker.NewJITFailure("JIT_CHAIN_UNSUPPORTED", "등록된 체인의 JIT 설정을 찾을 수 없습니다.", false, nil)
		}
		mapping, ok := chain.coverage[coverageKey(start, end)]
		if !ok {
			return nil, nil, worker.NewJITFailure("JIT_COVERAGE_MAPPING_UNAVAILABLE", "요청 기간에 대한 검증된 JIT 블록 범위가 없습니다.", false, nil)
		}
		if snapshot == "" {
			snapshot = mapping.IndexSnapshotID
		} else if snapshot != mapping.IndexSnapshotID {
			return nil, nil, worker.NewJITFailure("JIT_SNAPSHOT_MISMATCH", "여러 체인의 JIT index snapshot이 일치하지 않습니다.", false, nil)
		}
		chains, mappings = append(chains, chain), append(mappings, mapping)
	}
	return chains, mappings, nil
}

func rpcFailure(code, message string, err error) error {
	switch status.Code(err) {
	case codes.InvalidArgument, codes.FailedPrecondition, codes.NotFound, codes.PermissionDenied, codes.Unauthenticated:
		return worker.NewJITFailure(code, message, false, err)
	case codes.Canceled:
		return worker.NewJITFailure(code, message, true, err)
	default:
		return worker.NewJITFailure(code, message, true, err)
	}
}

func progressCounts(progress *jitv1.JitProgress) (int64, *int64) {
	if progress == nil {
		return 0, nil
	}
	processed := saturatingInt64(progress.GetCandidatesTerminal())
	totalValue := saturatingInt64(progress.GetLogicalCandidates())
	return processed, &totalValue
}

func saturatingInt64(value uint64) int64 {
	const maxInt64 = int64(^uint64(0) >> 1)
	if value > uint64(maxInt64) {
		return maxInt64
	}
	return int64(value)
}

func stableID(domain string, values ...string) string {
	hash := sha256.New()
	_, _ = hash.Write([]byte(domain))
	for _, value := range values {
		_, _ = hash.Write([]byte{0})
		_, _ = hash.Write([]byte(value))
	}
	return domain + "-" + hex.EncodeToString(hash.Sum(nil))
}
