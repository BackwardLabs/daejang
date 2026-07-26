package server

import (
	"context"
	"fmt"
	"net"

	"github.com/BackwardLabs/daejang-db/pkg/sourcestore"
	enginev1 "github.com/BackwardLabs/daejang/services/engine/gen/go/giwa/engine/v1"
	"github.com/BackwardLabs/daejang/services/engine/internal/source"
	"google.golang.org/grpc"
	"google.golang.org/grpc/health"
	"google.golang.org/grpc/health/grpc_health_v1"
)

func Run(ctx context.Context, config Config) error {
	runtime, err := sourcestore.Open(ctx, sourcestore.Options{
		DatabaseURL: config.DatabaseURL, ApplicationName: "daejang-engine-source-api",
	})
	if err != nil {
		return fmt.Errorf("open source persistence: %w", err)
	}
	defer runtime.Close()

	listener, err := net.Listen("tcp", config.Listen)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", config.Listen, err)
	}
	defer listener.Close()

	var options []grpc.ServerOption
	if config.TLSCertificatePath != "" {
		credentials, err := loadServerCredentials(config)
		if err != nil {
			return fmt.Errorf("configure Engine mTLS: %w", err)
		}
		options = append(options, grpc.Creds(credentials))
	}
	grpcServer := grpc.NewServer(options...)
	healthServer := health.NewServer()
	grpc_health_v1.RegisterHealthServer(grpcServer, healthServer)
	enginev1.RegisterSourceServiceServer(grpcServer, &source.Service{
		Store: source.PostgresStore{Store: runtime.Store},
	})
	healthServer.SetServingStatus("", grpc_health_v1.HealthCheckResponse_SERVING)
	healthServer.SetServingStatus(enginev1.SourceService_ServiceDesc.ServiceName, grpc_health_v1.HealthCheckResponse_SERVING)

	serveError := make(chan error, 1)
	go func() {
		serveError <- grpcServer.Serve(listener)
	}()
	select {
	case <-ctx.Done():
		healthServer.Shutdown()
		grpcServer.GracefulStop()
		return nil
	case err := <-serveError:
		return fmt.Errorf("serve Engine gRPC: %w", err)
	}
}
