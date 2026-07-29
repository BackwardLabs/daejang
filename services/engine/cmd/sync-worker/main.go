package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/BackwardLabs/daejang-db/pkg/sourcejobstore"
	"github.com/BackwardLabs/daejang-db/pkg/sourcestore"
	"github.com/BackwardLabs/daejang/services/engine/internal/worker"
	"github.com/BackwardLabs/daejang/services/engine/internal/worker/jitgrpc"
)

func main() {
	dsn := os.Getenv("DAEJANG_SOURCE_DATABASE_URL")
	root := os.Getenv("DAEJANG_PRIVATE_OBJECT_ROOT")
	jitConfigPath := os.Getenv("DAEJANG_JIT_BRIDGE_CONFIG")
	if dsn == "" || root == "" || jitConfigPath == "" {
		log.Fatal("DAEJANG_SOURCE_DATABASE_URL, DAEJANG_PRIVATE_OBJECT_ROOT, and DAEJANG_JIT_BRIDGE_CONFIG are required")
	}
	objectKeyring := worker.PrivateObjectKeyring{Keys: map[string][]byte{}}
	if encodedKeys := os.Getenv("PRIVATE_OBJECT_DECRYPTION_KEYS"); encodedKeys != "" {
		var values map[string]string
		if err := json.Unmarshal([]byte(encodedKeys), &values); err != nil {
			log.Fatal("PRIVATE_OBJECT_DECRYPTION_KEYS must be a JSON object")
		}
		for keyID, encodedKey := range values {
			decodedKey, err := base64.StdEncoding.DecodeString(encodedKey)
			if err != nil || len(decodedKey) != 32 || keyID == "" {
				log.Fatal("PRIVATE_OBJECT_DECRYPTION_KEYS contains an invalid entry")
			}
			objectKeyring.Keys[keyID] = decodedKey
		}
	}
	if encodedKey := os.Getenv("PRIVATE_OBJECT_ENCRYPTION_KEY"); encodedKey != "" {
		decodedKey, decodeErr := base64.StdEncoding.DecodeString(encodedKey)
		if decodeErr != nil || len(decodedKey) != 32 {
			log.Fatal("PRIVATE_OBJECT_ENCRYPTION_KEY must be a base64-encoded 32-byte key")
		}
		objectKeyring.CurrentKeyID = os.Getenv("PRIVATE_OBJECT_ENCRYPTION_KEY_ID")
		if objectKeyring.CurrentKeyID == "" {
			log.Fatal("PRIVATE_OBJECT_ENCRYPTION_KEY_ID is required with PRIVATE_OBJECT_ENCRYPTION_KEY")
		}
		objectKeyring.Keys[objectKeyring.CurrentKeyID] = decodedKey
	}
	objectKeyring.LegacyKeyID = os.Getenv("PRIVATE_OBJECT_LEGACY_KEY_ID")
	if objectKeyring.LegacyKeyID != "" {
		if _, exists := objectKeyring.Keys[objectKeyring.LegacyKeyID]; !exists {
			log.Fatal("PRIVATE_OBJECT_LEGACY_KEY_ID must identify a configured key")
		}
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	runtime, err := sourcejobstore.Open(ctx, sourcejobstore.Options{DatabaseURL: dsn, ApplicationName: "daejang-sync-worker"})
	if err != nil {
		log.Fatal(err)
	}
	defer runtime.Close()
	sourceRuntime, err := sourcestore.Open(ctx, sourcestore.Options{DatabaseURL: dsn, ApplicationName: "daejang-sync-worker-sources"})
	if err != nil {
		log.Fatal(err)
	}
	defer sourceRuntime.Close()
	jitConfig, err := jitgrpc.Load(jitConfigPath)
	if err != nil {
		log.Fatal(err)
	}
	jitClient, err := jitgrpc.Dial(ctx, jitConfig)
	if err != nil {
		log.Fatal(err)
	}
	defer jitClient.Close()
	if readyFile := os.Getenv("DAEJANG_WORKER_READY_FILE"); readyFile != "" {
		if err := os.WriteFile(readyFile, []byte("ready\n"), 0o600); err != nil {
			log.Fatal(err)
		}
		defer os.Remove(readyFile)
	}
	if err := (worker.Runner{
		Store: runtime.Store, Wallets: worker.SourceWalletStore{Store: sourceRuntime.Store}, EVMJIT: jitClient, ObjectRoot: root, ObjectKeyring: objectKeyring,
	}).Run(ctx); err != nil {
		log.Fatal(err)
	}
}
