package main

import (
	"context"
	"encoding/base64"
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
	var objectEncryptionKey []byte
	if encodedKey := os.Getenv("PRIVATE_OBJECT_ENCRYPTION_KEY"); encodedKey != "" {
		decodedKey, decodeErr := base64.StdEncoding.DecodeString(encodedKey)
		if decodeErr != nil || len(decodedKey) != 32 {
			log.Fatal("PRIVATE_OBJECT_ENCRYPTION_KEY must be a base64-encoded 32-byte key")
		}
		objectEncryptionKey = decodedKey
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
	if err := (worker.Runner{
		Store: runtime.Store, Wallets: worker.SourceWalletStore{Store: sourceRuntime.Store}, EVMJIT: jitClient, ObjectRoot: root, ObjectEncryptionKey: objectEncryptionKey,
	}).Run(ctx); err != nil {
		log.Fatal(err)
	}
}
