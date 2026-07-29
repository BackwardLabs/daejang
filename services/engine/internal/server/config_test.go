package server

import (
	"testing"
)

func validImportConfig() map[string]string {
	return map[string]string{
		"DAEJANG_SOURCE_DATABASE_URL":    "postgres://example.invalid/daejang",
		"DAEJANG_SOURCE_ARTIFACT_ROOT":   "/var/lib/daejang/source-artifacts",
		"DAEJANG_SOURCE_ARTIFACT_TEMP":   "/var/lib/daejang/source-artifacts-tmp",
		"ENGINE_PDF_PARSER_SOCKET_PATH":  "/run/daejang/pdf-parser/parser.sock",
		"ENGINE_ALLOW_INSECURE_LOOPBACK": "true",
	}
}

func TestLoadConfigRequiresMTLSOutsideExplicitLoopbackDevelopment(t *testing.T) {
	_, err := LoadConfig(func(key string) string {
		values := validImportConfig()
		delete(values, "ENGINE_ALLOW_INSECURE_LOOPBACK")
		return values[key]
	})
	if err == nil {
		t.Fatal("Engine accepted a plaintext listener without explicit loopback opt-in")
	}
}

func TestLoadConfigAllowsExplicitInsecureLoopback(t *testing.T) {
	config, err := LoadConfig(func(key string) string {
		values := validImportConfig()
		return values[key]
	})
	if err != nil {
		t.Fatal(err)
	}
	if config.Listen != "127.0.0.1:50051" || !config.AllowInsecureLoopback {
		t.Fatalf("unexpected development config: %#v", config)
	}
}

func TestLoadConfigAllowsProtectedUnixSocketWithoutTLS(t *testing.T) {
	config, err := LoadConfig(func(key string) string {
		values := validImportConfig()
		delete(values, "ENGINE_ALLOW_INSECURE_LOOPBACK")
		values["ENGINE_LISTEN"] = "unix:///run/giwa/engine.sock"
		return values[key]
	})
	if err != nil {
		t.Fatal(err)
	}
	if config.Listen != "unix:///run/giwa/engine.sock" {
		t.Fatalf("unexpected Unix listener: %#v", config)
	}
}

func TestLoadConfigRequiresCompleteReviewPersistenceConfiguration(t *testing.T) {
	_, err := LoadConfig(func(key string) string {
		values := validImportConfig()
		values["DAEJANG_REVIEW_DATABASE_URL"] = "postgres://example.invalid/daejang"
		return values[key]
	})
	if err == nil {
		t.Fatal("Engine accepted Review persistence without artifact directories")
	}
}

func TestLoadConfigAcceptsCompleteReviewV2Configuration(t *testing.T) {
	config, err := LoadConfig(func(key string) string {
		values := validImportConfig()
		values["DAEJANG_SOURCE_DATABASE_URL"] = "postgres://example.invalid/source"
		values["DAEJANG_REVIEW_DATABASE_URL"] = "postgres://example.invalid/review"
		values["DAEJANG_REVIEW_ARTIFACT_DATABASE_URL"] = "postgres://example.invalid/artifact"
		values["DAEJANG_REVIEW_ARTIFACT_ROOT"] = "/var/lib/daejang/review-artifacts"
		values["DAEJANG_REVIEW_ARTIFACT_TEMP"] = "/var/lib/daejang/review-artifacts-tmp"
		return values[key]
	})
	if err != nil {
		t.Fatal(err)
	}
	if config.ReviewDatabaseURL == "" || config.ReviewArtifactDatabaseURL == "" {
		t.Fatalf("unexpected Review V2 config: %#v", config)
	}
}

func TestLoadConfigRequiresWebAPIIdentityWithMTLS(t *testing.T) {
	_, err := LoadConfig(func(key string) string {
		values := validImportConfig()
		values["DAEJANG_SOURCE_DATABASE_URL"] = "postgres://example.invalid/source"
		delete(values, "ENGINE_ALLOW_INSECURE_LOOPBACK")
		values["ENGINE_TLS_CERT_PATH"] = "/run/secrets/server.pem"
		values["ENGINE_TLS_KEY_PATH"] = "/run/secrets/server-key.pem"
		values["ENGINE_TLS_CLIENT_CA_PATH"] = "/run/secrets/client-ca.pem"
		return values[key]
	})
	if err == nil {
		t.Fatal("Engine accepted mTLS without a pinned Web API certificate identity")
	}
}

func TestLoadConfigAcceptsCompleteMTLSIdentity(t *testing.T) {
	config, err := LoadConfig(func(key string) string {
		values := validImportConfig()
		values["DAEJANG_SOURCE_DATABASE_URL"] = "postgres://example.invalid/source"
		delete(values, "ENGINE_ALLOW_INSECURE_LOOPBACK")
		values["ENGINE_TLS_CERT_PATH"] = "/run/secrets/server.pem"
		values["ENGINE_TLS_KEY_PATH"] = "/run/secrets/server-key.pem"
		values["ENGINE_TLS_CLIENT_CA_PATH"] = "/run/secrets/client-ca.pem"
		values["ENGINE_WEB_API_CLIENT_DNS_NAME"] = "web-api.internal"
		return values[key]
	})
	if err != nil {
		t.Fatal(err)
	}
	if config.WebAPIClientDNSName != "web-api.internal" {
		t.Fatalf("unexpected Web API identity: %#v", config)
	}
}

func TestLoadConfigRejectsWildcardWebAPIIdentity(t *testing.T) {
	_, err := LoadConfig(func(key string) string {
		values := validImportConfig()
		values["DAEJANG_SOURCE_DATABASE_URL"] = "postgres://example.invalid/source"
		delete(values, "ENGINE_ALLOW_INSECURE_LOOPBACK")
		values["ENGINE_TLS_CERT_PATH"] = "/run/secrets/server.pem"
		values["ENGINE_TLS_KEY_PATH"] = "/run/secrets/server-key.pem"
		values["ENGINE_TLS_CLIENT_CA_PATH"] = "/run/secrets/client-ca.pem"
		values["ENGINE_WEB_API_CLIENT_DNS_NAME"] = "*.internal"
		return values[key]
	})
	if err == nil {
		t.Fatal("Engine accepted a wildcard application client identity")
	}
}

func TestLoadConfigRequiresImportRuntime(t *testing.T) {
	values := validImportConfig()
	delete(values, "ENGINE_PDF_PARSER_SOCKET_PATH")
	_, err := LoadConfig(func(key string) string { return values[key] })
	if err == nil {
		t.Fatal("Engine accepted a source import runtime without the parser socket")
	}
}

func TestLoadConfigRejectsRelativeParserSocket(t *testing.T) {
	values := validImportConfig()
	values["ENGINE_PDF_PARSER_SOCKET_PATH"] = "parser.sock"
	_, err := LoadConfig(func(key string) string { return values[key] })
	if err == nil {
		t.Fatal("Engine accepted a relative parser socket path")
	}
}

func TestLoadConfigRequiresLeaseLongerThanParserTimeout(t *testing.T) {
	values := validImportConfig()
	values["ENGINE_PDF_PARSER_TIMEOUT"] = "45s"
	values["ENGINE_PDF_IMPORT_LEASE_DURATION"] = "30s"
	_, err := LoadConfig(func(key string) string { return values[key] })
	if err == nil {
		t.Fatal("Engine accepted an import lease shorter than its parser timeout")
	}
}

func TestLoadConfigCapsParserTimeoutBelowImportRPCDeadline(t *testing.T) {
	values := validImportConfig()
	values["ENGINE_PDF_PARSER_TIMEOUT"] = "61s"
	_, err := LoadConfig(func(key string) string { return values[key] })
	if err == nil {
		t.Fatal("Engine accepted a parser timeout that can exceed the Web API import deadline")
	}
}
