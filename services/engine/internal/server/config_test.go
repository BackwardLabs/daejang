package server

import "testing"

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
