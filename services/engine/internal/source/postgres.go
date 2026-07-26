package source

import (
	"context"
	"errors"
	"time"

	"github.com/BackwardLabs/daejang-db/pkg/sourcestore"
)

type PostgresStore struct {
	Store *sourcestore.Store
}

func (s PostgresStore) RegisterWallet(ctx context.Context, params RegisterWalletParams) (WalletSource, error) {
	value, err := s.Store.RegisterWallet(ctx, sourcestore.RegisterWalletParams{
		SubjectID: params.SubjectID, Address: params.Address,
		VerificationChainID: params.VerificationChainID, ChainIDs: params.ChainIDs,
		Label: params.Label, VerifiedAt: params.VerifiedAt,
	})
	return fromDatabase(value), err
}

func (s PostgresStore) ListWallets(ctx context.Context, subjectID string) ([]WalletSource, error) {
	values, err := s.Store.ListWallets(ctx, subjectID)
	if err != nil {
		return nil, err
	}
	result := make([]WalletSource, 0, len(values))
	for _, value := range values {
		result = append(result, fromDatabase(value))
	}
	return result, nil
}

func (s PostgresStore) DisconnectWallet(ctx context.Context, subjectID, sourceID string, at time.Time) (WalletSource, error) {
	value, err := s.Store.DisconnectWallet(ctx, subjectID, sourceID, at)
	if errors.Is(err, sourcestore.ErrSourceNotFound) {
		return WalletSource{}, ErrNotFound
	}
	return fromDatabase(value), err
}

func fromDatabase(value sourcestore.WalletSource) WalletSource {
	result := WalletSource{
		ID: value.ID, Address: value.Address, AccountType: value.AccountType,
		VerificationChainID: value.VerificationChainID, VerifiedAt: value.VerifiedAt,
		Label: value.Label, Status: value.Status, CreatedAt: value.CreatedAt,
		UpdatedAt: value.UpdatedAt, DisconnectedAt: value.DisconnectedAt,
		ChainScopes: make([]ChainScope, 0, len(value.ChainScopes)),
	}
	for _, scope := range value.ChainScopes {
		result.ChainScopes = append(result.ChainScopes, ChainScope{ChainID: scope.ChainID, Status: scope.Status})
	}
	return result
}
