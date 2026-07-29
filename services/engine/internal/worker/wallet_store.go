package worker

import (
	"context"

	"github.com/BackwardLabs/daejang-db/pkg/sourcestore"
)

// SourceWalletStore adapts the subject-scoped source registry to the worker
// boundary without exposing its persistence model to the JIT orchestrator.
type SourceWalletStore struct {
	Store interface {
		ListWallets(context.Context, string) ([]sourcestore.WalletSource, error)
	}
}

func (s SourceWalletStore) GetActiveWallet(ctx context.Context, subjectID, sourceID string) (WalletSource, bool, error) {
	values, err := s.Store.ListWallets(ctx, subjectID)
	if err != nil {
		return WalletSource{}, false, err
	}
	for _, value := range values {
		if value.ID != sourceID || value.Status != "ACTIVE" {
			continue
		}
		chains := make([]string, 0, len(value.ChainScopes))
		for _, scope := range value.ChainScopes {
			if scope.Status == "ACTIVE" {
				chains = append(chains, scope.ChainID)
			}
		}
		return WalletSource{ID: value.ID, Address: value.Address, ChainIDs: chains}, true, nil
	}
	return WalletSource{}, false, nil
}
