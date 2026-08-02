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
	return s.getWallet(ctx, subjectID, sourceID, false)
}

// GetWalletForActionRuntimeReplay resolves a retained wallet and every chain
// scope the user previously registered. A disconnected source may be used only
// by the worker's narrowly identified Action-runtime replay path; ordinary
// collection continues to use GetActiveWallet and remains fail-closed.
func (s SourceWalletStore) GetWalletForActionRuntimeReplay(ctx context.Context, subjectID, sourceID string) (WalletSource, bool, error) {
	return s.getWallet(ctx, subjectID, sourceID, true)
}

func (s SourceWalletStore) getWallet(ctx context.Context, subjectID, sourceID string, includeDisconnected bool) (WalletSource, bool, error) {
	values, err := s.Store.ListWallets(ctx, subjectID)
	if err != nil {
		return WalletSource{}, false, err
	}
	for _, value := range values {
		if value.ID != sourceID || (value.Status != "ACTIVE" && !(includeDisconnected && value.Status == "DISCONNECTED")) {
			continue
		}
		chains := make([]string, 0, len(value.ChainScopes))
		for _, scope := range value.ChainScopes {
			if scope.Status == "ACTIVE" || (includeDisconnected && scope.Status == "DISABLED") {
				chains = append(chains, scope.ChainID)
			}
		}
		if len(chains) == 0 {
			return WalletSource{}, false, nil
		}
		return WalletSource{ID: value.ID, Address: value.Address, ChainIDs: chains}, true, nil
	}
	return WalletSource{}, false, nil
}
