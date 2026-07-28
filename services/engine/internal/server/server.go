package server

import (
	"context"
	"fmt"
	"net"
	"time"

	"github.com/BackwardLabs/daejang-db/pkg/artifactstore"
	"github.com/BackwardLabs/daejang-db/pkg/readmodelstore"
	"github.com/BackwardLabs/daejang-db/pkg/reportstore"
	"github.com/BackwardLabs/daejang-db/pkg/reviewstore"
	"github.com/BackwardLabs/daejang-db/pkg/sourcejobstore"
	"github.com/BackwardLabs/daejang-db/pkg/sourcestore"
	"github.com/BackwardLabs/daejang-db/pkg/taxreportstore"
	enginev1 "github.com/BackwardLabs/daejang/services/engine/gen/go/giwa/engine/v1"
	"github.com/BackwardLabs/daejang/services/engine/internal/query"
	"github.com/BackwardLabs/daejang/services/engine/internal/review"
	"github.com/BackwardLabs/daejang/services/engine/internal/source"
	"github.com/BackwardLabs/daejang/services/engine/internal/workflow"
	"google.golang.org/grpc"
	"google.golang.org/grpc/health"
	"google.golang.org/grpc/health/grpc_health_v1"
)

func Run(ctx context.Context, config Config) error {
	sourceRuntime, err := sourcestore.Open(ctx, sourcestore.Options{
		DatabaseURL: config.DatabaseURL, ApplicationName: "daejang-engine-source-api",
	})
	if err != nil {
		return fmt.Errorf("open source persistence: %w", err)
	}
	defer sourceRuntime.Close()
	jobRuntime, err := sourcejobstore.Open(ctx, sourcejobstore.Options{DatabaseURL: config.DatabaseURL, ApplicationName: "daejang-engine-workflow-api"})
	if err != nil {
		return fmt.Errorf("open source job persistence: %w", err)
	}
	defer jobRuntime.Close()
	readRuntime, err := readmodelstore.Open(ctx, readmodelstore.Options{DatabaseURL: config.QueryDatabaseURL, ApplicationName: "daejang-engine-query-api"})
	if err != nil {
		return fmt.Errorf("open read model persistence: %w", err)
	}
	defer readRuntime.Close()
	reportRuntime, err := reportstore.Open(ctx, reportstore.Options{DatabaseURL: config.ReportDatabaseURL, ApplicationName: "daejang-engine-report-api"})
	if err != nil {
		return fmt.Errorf("open report persistence: %w", err)
	}
	defer reportRuntime.Close()
	taxReportRuntime, err := taxreportstore.Open(ctx, taxreportstore.Options{
		DatabaseURL: config.QueryDatabaseURL, ApplicationName: "daejang-engine-tax-report-query",
	})
	if err != nil {
		return fmt.Errorf("open tax report query persistence: %w", err)
	}
	defer taxReportRuntime.Close()

	var reviewRuntime *reviewstore.Runtime
	var reviewArtifactRuntime *artifactstore.Runtime
	if config.ReviewDatabaseURL != "" {
		reviewRuntime, err = reviewstore.Open(ctx, reviewstore.Options{
			DatabaseURL: config.ReviewDatabaseURL, ApplicationName: "daejang-engine-review-api",
			RequireResolutionV2: true,
		})
		if err != nil {
			return fmt.Errorf("open review persistence: %w", err)
		}
		defer reviewRuntime.Close()
		reviewArtifactRuntime, err = artifactstore.Open(ctx, artifactstore.Options{
			DatabaseURL: config.ReviewArtifactDatabaseURL, ApplicationName: "daejang-engine-review-artifacts",
			ArtifactRoot: config.ReviewArtifactRoot, ArtifactTemp: config.ReviewArtifactTemp,
		})
		if err != nil {
			return fmt.Errorf("open review artifact persistence: %w", err)
		}
		defer reviewArtifactRuntime.Close()
		if err := readRuntime.Store.CheckReviewEvidenceAccess(ctx); err != nil {
			return fmt.Errorf("verify review evidence query access: %w", err)
		}
	}

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
		options = append(
			options,
			grpc.Creds(credentials),
			grpc.UnaryInterceptor(requireWebAPIClient(config.WebAPIClientDNSName)),
			grpc.StreamInterceptor(requireWebAPIStreamClient(config.WebAPIClientDNSName)),
		)
	}
	grpcServer := grpc.NewServer(options...)
	healthServer := health.NewServer()
	grpc_health_v1.RegisterHealthServer(grpcServer, healthServer)
	enginev1.RegisterSourceServiceServer(grpcServer, &source.Service{
		Store: source.PostgresStore{Store: sourceRuntime.Store, DocumentStore: jobRuntime.Store},
	})
	enginev1.RegisterWorkflowServiceServer(grpcServer, &workflow.Service{Store: jobRuntime.Store})
	enginev1.RegisterQueryServiceServer(grpcServer, &query.Service{
		Reads: readRuntime.Store, Reports: reportRuntime.Store, TaxReports: taxReportRuntime.Store,
	})
	services := []string{"", enginev1.SourceService_ServiceDesc.ServiceName, enginev1.WorkflowService_ServiceDesc.ServiceName, enginev1.QueryService_ServiceDesc.ServiceName}
	if reviewRuntime != nil {
		enginev1.RegisterReviewServiceServer(grpcServer, &review.Service{
			Reviews: reviewRuntime.Store, Evidence: readRuntime.Store,
			Artifacts: reviewArtifactRuntime.Store,
		})
		services = append(services, enginev1.ReviewService_ServiceDesc.ServiceName)
	}
	for _, name := range services {
		healthServer.SetServingStatus(name, grpc_health_v1.HealthCheckResponse_NOT_SERVING)
	}
	healthCtx, cancelHealth := context.WithCancel(ctx)
	defer cancelHealth()
	go monitorHealth(healthCtx, healthServer, services, func(checkCtx context.Context) error {
		if err := sourceRuntime.Ping(checkCtx); err != nil {
			return err
		}
		if err := jobRuntime.Ping(checkCtx); err != nil {
			return err
		}
		if err := readRuntime.Ping(checkCtx); err != nil {
			return err
		}
		if err := reportRuntime.Ping(checkCtx); err != nil {
			return err
		}
		if reviewRuntime != nil {
			if err := readRuntime.Store.CheckReviewEvidenceAccess(checkCtx); err != nil {
				return err
			}
			if err := reviewRuntime.Ping(checkCtx); err != nil {
				return err
			}
			if err := reviewArtifactRuntime.Ping(checkCtx); err != nil {
				return err
			}
		}
		return nil
	})

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

func monitorHealth(ctx context.Context, healthServer *health.Server, services []string, ping func(context.Context) error) {
	update := func() {
		checkCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
		defer cancel()
		state := grpc_health_v1.HealthCheckResponse_SERVING
		if err := ping(checkCtx); err != nil {
			state = grpc_health_v1.HealthCheckResponse_NOT_SERVING
		}
		for _, name := range services {
			healthServer.SetServingStatus(name, state)
		}
	}
	update()
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			update()
		}
	}
}
