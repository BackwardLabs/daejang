package server

import (
	"testing"
)

func TestLoadConfigRequiresMTLSOutsideExplicitLoopbackDevelopment(t *testing.T) {
	_, err := LoadConfig(func(key string) string {
		values := map[string]string{"DAEJANG_SOURCE_DATABASE_URL": "postgres://example.invalid/daejang"}
		return values[key]
	})
	if err == nil {
		t.Fatal("Engine accepted a plaintext listener without explicit loopback opt-in")
	}
}

func TestLoadConfigAllowsExplicitInsecureLoopback(t *testing.T) {
	config, err := LoadConfig(func(key string) string {
		values := map[string]string{
			"DAEJANG_SOURCE_DATABASE_URL":    "postgres://example.invalid/daejang",
			"ENGINE_ALLOW_INSECURE_LOOPBACK": "true",
		}
		return values[key]
	})
	if err != nil {
		t.Fatal(err)
	}
	if config.Listen != "127.0.0.1:50051" || !config.AllowInsecureLoopback {
		t.Fatalf("unexpected development config: %#v", config)
	}
}

func TestLoadConfigRequiresCompleteReviewPersistenceConfiguration(t *testing.T) {
	_, err := LoadConfig(func(key string) string {
		values := map[string]string{
			"DAEJANG_SOURCE_DATABASE_URL":    "postgres://example.invalid/daejang",
			"DAEJANG_REVIEW_DATABASE_URL":    "postgres://example.invalid/daejang",
			"ENGINE_ALLOW_INSECURE_LOOPBACK": "true",
		}
		return values[key]
	})
	if err == nil {
		t.Fatal("Engine accepted Review persistence without artifact directories")
	}
}

func TestLoadConfigAcceptsCompleteReviewV2Configuration(t *testing.T) {
	config, err := LoadConfig(func(key string) string {
		values := map[string]string{
			"DAEJANG_SOURCE_DATABASE_URL":          "postgres://example.invalid/source",
			"DAEJANG_REVIEW_DATABASE_URL":          "postgres://example.invalid/review",
			"DAEJANG_REVIEW_ARTIFACT_DATABASE_URL": "postgres://example.invalid/artifact",
			"DAEJANG_REVIEW_ARTIFACT_ROOT":         "/var/lib/daejang/review-artifacts",
			"DAEJANG_REVIEW_ARTIFACT_TEMP":         "/var/lib/daejang/review-artifacts-tmp",
			"ENGINE_ALLOW_INSECURE_LOOPBACK":       "true",
		}
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
		values := map[string]string{
			"DAEJANG_SOURCE_DATABASE_URL": "postgres://example.invalid/source",
			"ENGINE_TLS_CERT_PATH":        "/run/secrets/server.pem",
			"ENGINE_TLS_KEY_PATH":         "/run/secrets/server-key.pem",
			"ENGINE_TLS_CLIENT_CA_PATH":   "/run/secrets/client-ca.pem",
		}
		return values[key]
	})
	if err == nil {
		t.Fatal("Engine accepted mTLS without a pinned Web API certificate identity")
	}
}

func TestLoadConfigAcceptsCompleteMTLSIdentity(t *testing.T) {
	config, err := LoadConfig(func(key string) string {
		values := map[string]string{
			"DAEJANG_SOURCE_DATABASE_URL":    "postgres://example.invalid/source",
			"ENGINE_TLS_CERT_PATH":           "/run/secrets/server.pem",
			"ENGINE_TLS_KEY_PATH":            "/run/secrets/server-key.pem",
			"ENGINE_TLS_CLIENT_CA_PATH":      "/run/secrets/client-ca.pem",
			"ENGINE_WEB_API_CLIENT_DNS_NAME": "web-api.internal",
		}
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
		values := map[string]string{
			"DAEJANG_SOURCE_DATABASE_URL":   "postgres://example.invalid/source",
			"ENGINE_TLS_CERT_PATH":           "/run/secrets/server.pem",
			"ENGINE_TLS_KEY_PATH":            "/run/secrets/server-key.pem",
			"ENGINE_TLS_CLIENT_CA_PATH":      "/run/secrets/client-ca.pem",
			"ENGINE_WEB_API_CLIENT_DNS_NAME": "*.internal",
		}
		return values[key]
	})
	if err == nil {
		t.Fatal("Engine accepted a wildcard application client identity")
	}
}
