package worker

import (
	"context"
	"testing"

	"github.com/BackwardLabs/daejang-db/pkg/sourcestore"
)

type fakeSourceWalletRegistry struct {
	values []sourcestore.WalletSource
}

func (s fakeSourceWalletRegistry) ListWallets(context.Context, string) ([]sourcestore.WalletSource, error) {
	return s.values, nil
}

func TestSourceWalletStoreKeepsDisconnectedSourcesReplayOnly(t *testing.T) {
	registry := fakeSourceWalletRegistry{values: []sourcestore.WalletSource{{
		ID: "wallet-1", Address: "0x1111111111111111111111111111111111111111", Status: "DISCONNECTED",
		ChainScopes: []sourcestore.ChainScope{
			{ChainID: "eip155:1", Status: "DISABLED"},
			{ChainID: "eip155:10", Status: "DISABLED"},
		},
	}}}
	store := SourceWalletStore{Store: registry}

	if _, found, err := store.GetActiveWallet(context.Background(), "subject-1", "wallet-1"); err != nil || found {
		t.Fatalf("ordinary collection reopened a disconnected wallet: found=%v err=%v", found, err)
	}
	replay, found, err := store.GetWalletForActionRuntimeReplay(context.Background(), "subject-1", "wallet-1")
	if err != nil || !found {
		t.Fatalf("historical replay could not resolve retained wallet: found=%v err=%v", found, err)
	}
	if len(replay.ChainIDs) != 2 || replay.ChainIDs[0] != "eip155:1" || replay.ChainIDs[1] != "eip155:10" {
		t.Fatalf("historical chain scope was lost: %#v", replay)
	}
}
