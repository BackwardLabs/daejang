package server

import (
	"errors"
	"net"
	"os"
	"strconv"
)

type Config struct {
	Listen                string
	DatabaseURL           string
	QueryDatabaseURL      string
	ReportDatabaseURL     string
	TLSCertificatePath    string
	TLSPrivateKeyPath     string
	TLSClientCAPath       string
	AllowInsecureLoopback bool
}

func LoadConfig(getenv func(string) string) (Config, error) {
	result := Config{
		Listen:             getenv("ENGINE_LISTEN"),
		DatabaseURL:        getenv("DAEJANG_SOURCE_DATABASE_URL"),
		QueryDatabaseURL:   getenv("DAEJANG_QUERY_DATABASE_URL"),
		ReportDatabaseURL:  getenv("DAEJANG_REPORT_DATABASE_URL"),
		TLSCertificatePath: getenv("ENGINE_TLS_CERT_PATH"),
		TLSPrivateKeyPath:  getenv("ENGINE_TLS_KEY_PATH"),
		TLSClientCAPath:    getenv("ENGINE_TLS_CLIENT_CA_PATH"),
	}
	if result.Listen == "" {
		result.Listen = "127.0.0.1:50051"
	}
	if raw := getenv("ENGINE_ALLOW_INSECURE_LOOPBACK"); raw != "" {
		value, err := strconv.ParseBool(raw)
		if err != nil {
			return Config{}, errors.New("ENGINE_ALLOW_INSECURE_LOOPBACK must be true or false")
		}
		result.AllowInsecureLoopback = value
	}
	if result.DatabaseURL == "" {
		return Config{}, errors.New("DAEJANG_SOURCE_DATABASE_URL is required")
	}
	if result.QueryDatabaseURL == "" {
		result.QueryDatabaseURL = result.DatabaseURL
	}
	if result.ReportDatabaseURL == "" {
		result.ReportDatabaseURL = result.QueryDatabaseURL
	}
	tlsValues := []string{result.TLSCertificatePath, result.TLSPrivateKeyPath, result.TLSClientCAPath}
	tlsCount := 0
	for _, value := range tlsValues {
		if value != "" {
			tlsCount++
		}
	}
	if tlsCount != 0 && tlsCount != len(tlsValues) {
		return Config{}, errors.New("Engine TLS certificate, key, and client CA must be configured together")
	}
	if tlsCount == 0 {
		host, _, err := net.SplitHostPort(result.Listen)
		if err != nil {
			return Config{}, errors.New("ENGINE_LISTEN must be a host:port address")
		}
		if !result.AllowInsecureLoopback || (host != "127.0.0.1" && host != "::1" && host != "localhost") {
			return Config{}, errors.New("mTLS is required unless insecure loopback is explicitly enabled")
		}
	}
	return result, nil
}

func LoadEnvironment() (Config, error) {
	return LoadConfig(os.Getenv)
}
