package server

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"testing"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/peer"
	"google.golang.org/grpc/status"
)

func TestRequireWebAPIClientAllowsOnlyPinnedApplicationIdentity(t *testing.T) {
	interceptor := requireWebAPIClient("web-api.internal")
	handler := func(context.Context, any) (any, error) { return "ok", nil }
	contextWithDNSName := func(name string) context.Context {
		return peer.NewContext(context.Background(), &peer.Peer{
			AuthInfo: credentials.TLSInfo{State: tls.ConnectionState{
				PeerCertificates: []*x509.Certificate{{DNSNames: []string{name}}},
			}},
		})
	}

	result, err := interceptor(
		contextWithDNSName("web-api.internal"),
		struct{}{},
		&grpc.UnaryServerInfo{FullMethod: "/giwa.engine.v1.ReviewService/GetReview"},
		handler,
	)
	if err != nil || result != "ok" {
		t.Fatalf("authorized Web API certificate was rejected: result=%v err=%v", result, err)
	}

	_, err = interceptor(
		contextWithDNSName("probe.internal"),
		struct{}{},
		&grpc.UnaryServerInfo{FullMethod: "/giwa.engine.v1.ReviewService/ResolveReview"},
		handler,
	)
	if status.Code(err) != codes.PermissionDenied {
		t.Fatalf("probe certificate reached an application RPC: %v", err)
	}

	_, err = interceptor(
		contextWithDNSName("*.internal"),
		struct{}{},
		&grpc.UnaryServerInfo{FullMethod: "/giwa.engine.v1.ReviewService/GetReview"},
		handler,
	)
	if status.Code(err) != codes.PermissionDenied {
		t.Fatalf("wildcard client certificate reached an application RPC: %v", err)
	}
}

func TestRequireWebAPIClientLimitsProbeCertificateToHealth(t *testing.T) {
	interceptor := requireWebAPIClient("web-api.internal")
	ctx := peer.NewContext(context.Background(), &peer.Peer{
		AuthInfo: credentials.TLSInfo{State: tls.ConnectionState{
			PeerCertificates: []*x509.Certificate{{DNSNames: []string{"probe.internal"}}},
		}},
	})
	result, err := interceptor(
		ctx,
		struct{}{},
		&grpc.UnaryServerInfo{FullMethod: "/grpc.health.v1.Health/Check"},
		func(context.Context, any) (any, error) { return "healthy", nil },
	)
	if err != nil || result != "healthy" {
		t.Fatalf("probe certificate could not call health: result=%v err=%v", result, err)
	}
}

func TestRequireWebAPIClientRejectsMissingPeerCertificate(t *testing.T) {
	interceptor := requireWebAPIClient("web-api.internal")
	_, err := interceptor(
		context.Background(),
		struct{}{},
		&grpc.UnaryServerInfo{FullMethod: "/giwa.engine.v1.QueryService/ListReviews"},
		func(context.Context, any) (any, error) { return nil, nil },
	)
	if status.Code(err) != codes.Unauthenticated {
		t.Fatalf("application RPC accepted a missing peer certificate: %v", err)
	}
}
