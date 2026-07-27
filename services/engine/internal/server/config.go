package server

import (
	"errors"
	"net"
	"os"
	"strconv"
	"strings"
)

type Config struct {
	Listen                    string
	DatabaseURL               string
	QueryDatabaseURL          string
	ReportDatabaseURL         string
	ReviewDatabaseURL         string
	ReviewArtifactDatabaseURL string
	ReviewArtifactRoot        string
	ReviewArtifactTemp        string
	TLSCertificatePath        string
	TLSPrivateKeyPath         string
	TLSClientCAPath           string
	WebAPIClientDNSName       string
	AllowInsecureLoopback     bool
}

func LoadConfig(getenv func(string) string) (Config, error) {
	result := Config{
		Listen:                    getenv("ENGINE_LISTEN"),
		DatabaseURL:               getenv("DAEJANG_SOURCE_DATABASE_URL"),
		QueryDatabaseURL:          getenv("DAEJANG_QUERY_DATABASE_URL"),
		ReportDatabaseURL:         getenv("DAEJANG_REPORT_DATABASE_URL"),
		ReviewDatabaseURL:         getenv("DAEJANG_REVIEW_DATABASE_URL"),
		ReviewArtifactDatabaseURL: getenv("DAEJANG_REVIEW_ARTIFACT_DATABASE_URL"),
		ReviewArtifactRoot:        getenv("DAEJANG_REVIEW_ARTIFACT_ROOT"),
		ReviewArtifactTemp:        getenv("DAEJANG_REVIEW_ARTIFACT_TEMP"),
		TLSCertificatePath:        getenv("ENGINE_TLS_CERT_PATH"),
		TLSPrivateKeyPath:         getenv("ENGINE_TLS_KEY_PATH"),
		TLSClientCAPath:           getenv("ENGINE_TLS_CLIENT_CA_PATH"),
		WebAPIClientDNSName:       getenv("ENGINE_WEB_API_CLIENT_DNS_NAME"),
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
	reviewValues := []string{
		result.ReviewDatabaseURL,
		result.ReviewArtifactDatabaseURL,
		result.ReviewArtifactRoot,
		result.ReviewArtifactTemp,
	}
	reviewCount := 0
	for _, value := range reviewValues {
		if value != "" {
			reviewCount++
		}
	}
	if reviewCount != 0 && reviewCount != len(reviewValues) {
		return Config{}, errors.New("review databases and artifact paths must be configured together")
	}
	tlsValues := []string{
		result.TLSCertificatePath,
		result.TLSPrivateKeyPath,
		result.TLSClientCAPath,
		result.WebAPIClientDNSName,
	}
	tlsCount := 0
	for _, value := range tlsValues {
		if value != "" {
			tlsCount++
		}
	}
	if tlsCount != 0 && tlsCount != len(tlsValues) {
		return Config{}, errors.New("Engine TLS certificate, key, client CA, and Web API client DNS name must be configured together")
	}
	if result.WebAPIClientDNSName != "" &&
		(strings.Contains(result.WebAPIClientDNSName, "*") ||
			strings.TrimSpace(result.WebAPIClientDNSName) != result.WebAPIClientDNSName) {
		return Config{}, errors.New("ENGINE_WEB_API_CLIENT_DNS_NAME must be an exact DNS SAN without wildcards")
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
