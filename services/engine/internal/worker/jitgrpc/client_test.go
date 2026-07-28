package jitgrpc

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/BackwardLabs/daejang/services/engine/internal/worker"
	jitv1 "github.com/BackwardLabs/daejang/services/engine/internal/worker/jitgrpc/contract"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	localcredentials "google.golang.org/grpc/credentials/local"
	"google.golang.org/grpc/health"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/test/bufconn"
)

type recordingJITServer struct {
	jitv1.UnimplementedCandidateQueryServiceServer
	jitv1.UnimplementedJitEngineServiceServer
	mu           sync.Mutex
	materialized []*jitv1.MaterializeAccountSelectionRequest
	started      *jitv1.StartJitRunRequest
	getCalls     int
}

func (s *recordingJITServer) MaterializeAccountSelection(_ context.Context, request *jitv1.MaterializeAccountSelectionRequest) (*jitv1.MaterializeAccountSelectionResponse, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.materialized = append(s.materialized, request)
	return &jitv1.MaterializeAccountSelectionResponse{Selection: &jitv1.AccountCandidateSelectionRef{
		SelectionId: "selection-1", SelectionDigest: strings.Repeat("a", 64), LogicalCandidateCount: 3,
	}}, nil
}

func (s *recordingJITServer) StartJitRun(_ context.Context, request *jitv1.StartJitRunRequest) (*jitv1.StartJitRunResponse, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.started = request
	return &jitv1.StartJitRunResponse{Accepted: &jitv1.StartJitRunAccepted{RunId: "jit-run-1", State: "ACCEPTED"}}, nil
}

func (s *recordingJITServer) GetJitRun(_ context.Context, request *jitv1.GetJitRunRequest) (*jitv1.GetJitRunResponse, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.getCalls++
	status := "RUNNING"
	fragment := ""
	if s.getCalls > 1 {
		status = "PARTIAL"
		fragment = "subject-fragment-1"
	}
	return &jitv1.GetJitRunResponse{Result: &jitv1.JitRunResultEnvelope{
		RunId: request.GetRunId(), Status: status, SubjectEvidenceFragmentId: fragment,
		IndexSnapshotId: "snapshot-2027", ResultDigest: strings.Repeat("b", 64),
		Progress: &jitv1.JitProgress{LogicalCandidates: 3, CandidatesTerminal: 3},
	}}, nil
}

func TestClientUsesExactCoverageMappingAndPublishedTerminalFragment(t *testing.T) {
	server := &recordingJITServer{}
	connection := newTestConnection(t, server)
	client, err := New(
		jitv1.NewCandidateQueryServiceClient(connection), jitv1.NewJitEngineServiceClient(connection),
		testConfig(),
	)
	if err != nil {
		t.Fatal(err)
	}
	request := worker.EVMJITRequest{
		IdempotencyKey: "job-1", SubjectID: "subject-1", SourceID: "wallet-1",
		Address: "0x1111111111111111111111111111111111111111", ChainIDs: []string{"eip155:1"},
		CoverageStart: time.Date(2027, 1, 1, 15, 0, 0, 0, time.FixedZone("KST", 9*60*60)),
		CoverageEnd:   time.Date(2027, 12, 31, 15, 0, 0, 0, time.FixedZone("KST", 9*60*60)),
	}
	run, err := client.Start(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	terminal, err := client.AwaitTerminal(context.Background(), run)
	if err != nil {
		t.Fatal(err)
	}
	if terminal.State != "SUCCEEDED" || terminal.FragmentID != "subject-fragment-1" || terminal.ProcessedRecords != 3 || terminal.TotalRecords == nil || *terminal.TotalRecords != 3 {
		t.Fatalf("unexpected terminal result: %#v", terminal)
	}
	server.mu.Lock()
	defer server.mu.Unlock()
	if len(server.materialized) != 1 {
		t.Fatalf("unexpected materialization count: %d", len(server.materialized))
	}
	materialized := server.materialized[0]
	if materialized.GetRange().GetFromBlock() != "100" || materialized.GetRange().GetToBlock() != "200" || materialized.GetIndexSnapshotId() != "snapshot-2027" {
		t.Fatalf("coverage mapping was not sent exactly: %#v", materialized)
	}
	if server.started == nil || len(server.started.GetAccounts()) != 1 || len(server.started.GetCandidateSelections()) != 1 {
		t.Fatalf("JIT start request is incomplete: %#v", server.started)
	}
	account := server.started.GetAccounts()[0]
	if got := account.GetOwnershipFrom().AsTime(); !got.Equal(time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("inclusive start date was not normalized: %s", got)
	}
	if got := account.GetOwnershipTo().AsTime(); !got.Equal(time.Date(2028, 1, 1, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("inclusive end date was not converted to exclusive boundary: %s", got)
	}
}

func TestClientFailsClosedWithoutVerifiedCoverageMapping(t *testing.T) {
	server := &recordingJITServer{}
	connection := newTestConnection(t, server)
	client, err := New(
		jitv1.NewCandidateQueryServiceClient(connection), jitv1.NewJitEngineServiceClient(connection), testConfig(),
	)
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.Start(context.Background(), worker.EVMJITRequest{
		IdempotencyKey: "job-1", SubjectID: "subject-1", SourceID: "wallet-1",
		Address: "0x1111111111111111111111111111111111111111", ChainIDs: []string{"eip155:1"},
		CoverageStart: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), CoverageEnd: time.Date(2026, 12, 31, 0, 0, 0, 0, time.UTC),
	})
	var failure *worker.JITFailure
	if !strings.Contains(err.Error(), "JIT_COVERAGE_MAPPING_UNAVAILABLE") || !asJITFailure(err, &failure) || failure.Retryable() {
		t.Fatalf("missing coverage did not fail closed: %v", err)
	}
	server.mu.Lock()
	defer server.mu.Unlock()
	if len(server.materialized) != 0 || server.started != nil {
		t.Fatal("JIT RPC was called without an exact coverage mapping")
	}
}

func TestRemoteEndpointRequiresMutualTLS(t *testing.T) {
	config := testConfig()
	config.Endpoint = "tcp://jit.example.com:443"
	if _, err := validate(config); err == nil || !strings.Contains(err.Error(), "requires CA") {
		t.Fatalf("plaintext remote endpoint was accepted: %v", err)
	}
}

func TestDialUsesLocalCredentialsAndRequiresServingJITServices(t *testing.T) {
	directory, err := os.MkdirTemp("/private/tmp", "jitgrpc-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(directory) })
	socket := filepath.Join(directory, "jitd.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		if errors.Is(err, syscall.EPERM) || errors.Is(err, syscall.EACCES) {
			t.Skipf("sandbox does not allow Unix socket bind: %v", err)
		}
		t.Fatal(err)
	}
	server := grpc.NewServer(grpc.Creds(localcredentials.NewCredentials()))
	healthServer := health.NewServer()
	healthServer.SetServingStatus(jitv1.CandidateQueryService_ServiceDesc.ServiceName, healthpb.HealthCheckResponse_SERVING)
	healthServer.SetServingStatus(jitv1.JitEngineService_ServiceDesc.ServiceName, healthpb.HealthCheckResponse_SERVING)
	healthpb.RegisterHealthServer(server, healthServer)
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(server.Stop)
	config := testConfig()
	config.Endpoint = "unix://" + socket
	client, err := Dial(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Close(); err != nil {
		t.Fatal(err)
	}
}

func newTestConnection(t *testing.T, implementation *recordingJITServer) *grpc.ClientConn {
	t.Helper()
	listener := bufconn.Listen(1 << 20)
	server := grpc.NewServer()
	jitv1.RegisterCandidateQueryServiceServer(server, implementation)
	jitv1.RegisterJitEngineServiceServer(server, implementation)
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(server.Stop)
	connection, err := grpc.NewClient(
		"passthrough:///bufconn",
		grpc.WithContextDialer(func(context.Context, string) (net.Conn, error) { return listener.Dial() }),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = connection.Close() })
	return connection
}

func testConfig() Config {
	return Config{
		Endpoint: "unix:///var/run/daejang/jitd.sock", RequestTimeout: "1s", PollInterval: "1ms", AwaitTimeout: "1s",
		Chains: []ChainConfig{{
			ChainID: "eip155:1", ChainStore: "ethereum-mainnet", GenesisHash: "0x" + strings.Repeat("a", 64),
			EvidenceProfile: evidenceProfile, ProfileHash: strings.Repeat("b", 64),
			Coverage: []CoverageMapping{{
				CoverageStart: "2027-01-01", CoverageEnd: "2027-12-31", IndexSnapshotID: "snapshot-2027", FromBlock: 100, ToBlock: 200,
			}},
		}},
	}
}

func asJITFailure(err error, target **worker.JITFailure) bool {
	for err != nil {
		if value, ok := err.(*worker.JITFailure); ok {
			*target = value
			return true
		}
		value, ok := err.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		err = value.Unwrap()
	}
	return false
}
