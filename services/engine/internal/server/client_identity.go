package server

import (
	"context"
	"crypto/x509"
	"strings"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/peer"
	"google.golang.org/grpc/status"
)

const healthMethodPrefix = "/grpc.health.v1.Health/"

// requireWebAPIClient binds every application RPC to the Web API certificate
// identity. The separately issued probe certificate is intentionally limited
// to the standard gRPC health service.
func requireWebAPIClient(expectedDNSName string) grpc.UnaryServerInterceptor {
	return func(
		ctx context.Context,
		request any,
		info *grpc.UnaryServerInfo,
		handler grpc.UnaryHandler,
	) (any, error) {
		if err := authorizeEngineClient(ctx, info.FullMethod, expectedDNSName); err != nil {
			return nil, err
		}
		return handler(ctx, request)
	}
}

func requireWebAPIStreamClient(expectedDNSName string) grpc.StreamServerInterceptor {
	return func(
		server any,
		stream grpc.ServerStream,
		info *grpc.StreamServerInfo,
		handler grpc.StreamHandler,
	) error {
		if err := authorizeEngineClient(stream.Context(), info.FullMethod, expectedDNSName); err != nil {
			return err
		}
		return handler(server, stream)
	}
}

func authorizeEngineClient(ctx context.Context, fullMethod, expectedDNSName string) error {
	if strings.HasPrefix(fullMethod, healthMethodPrefix) {
		return nil
	}
	certificate, err := peerCertificate(ctx)
	if err != nil {
		return err
	}
	for _, dnsName := range certificate.DNSNames {
		if !strings.Contains(dnsName, "*") && strings.EqualFold(dnsName, expectedDNSName) {
			return nil
		}
	}
	return status.Error(codes.PermissionDenied, "Engine client certificate is not authorized for application RPCs")
}

func peerCertificate(ctx context.Context) (*x509.Certificate, error) {
	value, ok := peer.FromContext(ctx)
	if !ok {
		return nil, status.Error(codes.Unauthenticated, "verified Engine client certificate is required")
	}
	tlsInfo, ok := value.AuthInfo.(credentials.TLSInfo)
	if !ok || len(tlsInfo.State.PeerCertificates) == 0 {
		return nil, status.Error(codes.Unauthenticated, "verified Engine client certificate is required")
	}
	return tlsInfo.State.PeerCertificates[0], nil
}
