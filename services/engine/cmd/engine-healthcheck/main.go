package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"os"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/health/grpc_health_v1"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run() error {
	target := env("ENGINE_HEALTH_TARGET", "127.0.0.1:50051")
	serverName := env("ENGINE_HEALTH_SERVER_NAME", "engine.internal")
	ca, err := os.ReadFile(os.Getenv("ENGINE_HEALTH_CA_PATH"))
	if err != nil {
		return err
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(ca) {
		return fmt.Errorf("invalid health CA")
	}
	certificate, err := tls.LoadX509KeyPair(os.Getenv("ENGINE_HEALTH_CERT_PATH"), os.Getenv("ENGINE_HEALTH_KEY_PATH"))
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	connection, err := grpc.DialContext(ctx, target, grpc.WithTransportCredentials(credentials.NewTLS(&tls.Config{RootCAs: roots, Certificates: []tls.Certificate{certificate}, ServerName: serverName, MinVersion: tls.VersionTLS12})), grpc.WithBlock())
	if err != nil {
		return err
	}
	defer connection.Close()
	response, err := grpc_health_v1.NewHealthClient(connection).Check(ctx, &grpc_health_v1.HealthCheckRequest{})
	if err != nil {
		return err
	}
	if response.GetStatus() != grpc_health_v1.HealthCheckResponse_SERVING {
		return fmt.Errorf("engine is %s", response.GetStatus())
	}
	return nil
}
func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
