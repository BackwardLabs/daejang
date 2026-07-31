package server

import (
	"encoding/base64"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
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
	SourceArtifactDatabaseURL string
	SourceArtifactRoot        string
	SourceArtifactTemp        string
	TaxArtifactDatabaseURL    string
	TaxArtifactRoot           string
	TaxArtifactTemp           string
	PDFParserSocketPath       string
	PDFParserTimeout          time.Duration
	PDFImportLeaseDuration    time.Duration
	TLSCertificatePath        string
	TLSPrivateKeyPath         string
	TLSClientCAPath           string
	WebAPIClientDNSName       string
	AllowInsecureLoopback     bool
	PrivateObjectKey          []byte
	PrivateObjectKeyID        string
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
		SourceArtifactDatabaseURL: getenv("DAEJANG_SOURCE_ARTIFACT_DATABASE_URL"),
		SourceArtifactRoot:        getenv("DAEJANG_SOURCE_ARTIFACT_ROOT"),
		SourceArtifactTemp:        getenv("DAEJANG_SOURCE_ARTIFACT_TEMP"),
		TaxArtifactDatabaseURL:    getenv("DAEJANG_TAX_ARTIFACT_DATABASE_URL"),
		TaxArtifactRoot:           getenv("DAEJANG_TAX_ARTIFACT_ROOT"),
		TaxArtifactTemp:           getenv("DAEJANG_TAX_ARTIFACT_TEMP"),
		PDFParserSocketPath:       getenv("ENGINE_PDF_PARSER_SOCKET_PATH"),
		TLSCertificatePath:        getenv("ENGINE_TLS_CERT_PATH"),
		TLSPrivateKeyPath:         getenv("ENGINE_TLS_KEY_PATH"),
		TLSClientCAPath:           getenv("ENGINE_TLS_CLIENT_CA_PATH"),
		WebAPIClientDNSName:       getenv("ENGINE_WEB_API_CLIENT_DNS_NAME"),
		PrivateObjectKeyID:        getenv("PRIVATE_OBJECT_ENCRYPTION_KEY_ID"),
	}
	if encodedKey := getenv("PRIVATE_OBJECT_ENCRYPTION_KEY"); encodedKey != "" {
		key, err := base64.StdEncoding.DecodeString(encodedKey)
		if err != nil || len(key) != 32 {
			return Config{}, errors.New("PRIVATE_OBJECT_ENCRYPTION_KEY must be a base64-encoded 32-byte key")
		}
		result.PrivateObjectKey = key
		if result.PrivateObjectKeyID == "" {
			return Config{}, errors.New("PRIVATE_OBJECT_ENCRYPTION_KEY_ID is required with PRIVATE_OBJECT_ENCRYPTION_KEY")
		}
	} else if result.PrivateObjectKeyID != "" {
		return Config{}, errors.New("PRIVATE_OBJECT_ENCRYPTION_KEY is required with PRIVATE_OBJECT_ENCRYPTION_KEY_ID")
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
	if result.SourceArtifactDatabaseURL == "" {
		result.SourceArtifactDatabaseURL = result.DatabaseURL
	}
	if result.SourceArtifactRoot == "" || result.SourceArtifactTemp == "" || result.PDFParserSocketPath == "" {
		return Config{}, errors.New("source artifact paths and PDF parser socket path are required")
	}
	if !filepath.IsAbs(result.PDFParserSocketPath) {
		return Config{}, errors.New("ENGINE_PDF_PARSER_SOCKET_PATH must be absolute")
	}
	result.PDFParserTimeout = 30 * time.Second
	if raw := getenv("ENGINE_PDF_PARSER_TIMEOUT"); raw != "" {
		value, err := time.ParseDuration(raw)
		if err != nil || value <= 0 || value > 60*time.Second {
			return Config{}, errors.New("ENGINE_PDF_PARSER_TIMEOUT must be between 1ns and 60s")
		}
		result.PDFParserTimeout = value
	}
	result.PDFImportLeaseDuration = 2 * time.Minute
	if raw := getenv("ENGINE_PDF_IMPORT_LEASE_DURATION"); raw != "" {
		value, err := time.ParseDuration(raw)
		if err != nil || value <= 0 {
			return Config{}, errors.New("ENGINE_PDF_IMPORT_LEASE_DURATION must be a positive duration")
		}
		result.PDFImportLeaseDuration = value
	}
	if result.PDFImportLeaseDuration <= result.PDFParserTimeout {
		return Config{}, errors.New("ENGINE_PDF_IMPORT_LEASE_DURATION must exceed ENGINE_PDF_PARSER_TIMEOUT")
	}
	if result.ReportDatabaseURL == "" {
		result.ReportDatabaseURL = result.QueryDatabaseURL
	}
	taxArtifactValues := []string{
		result.TaxArtifactDatabaseURL,
		result.TaxArtifactRoot,
		result.TaxArtifactTemp,
	}
	taxArtifactCount := 0
	for _, value := range taxArtifactValues {
		if value != "" {
			taxArtifactCount++
		}
	}
	if taxArtifactCount != 0 && taxArtifactCount != len(taxArtifactValues) {
		return Config{}, errors.New("tax artifact database and paths must be configured together")
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
		if strings.HasPrefix(result.Listen, "unix://") {
			socketPath := strings.TrimPrefix(result.Listen, "unix://")
			if !filepath.IsAbs(socketPath) {
				return Config{}, errors.New("ENGINE_LISTEN Unix socket path must be absolute")
			}
			return result, nil
		}
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
