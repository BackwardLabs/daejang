package source

import (
	"context"
	"errors"
	"regexp"
	"time"

	enginev1 "github.com/BackwardLabs/daejang/services/engine/gen/go/giwa/engine/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"
)

var uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

var ErrNotFound = errors.New("SOURCE_NOT_FOUND")

type WalletSource struct {
	ID                  string
	Address             string
	AccountType         string
	VerificationChainID string
	VerifiedAt          time.Time
	Label               string
	Status              string
	CreatedAt           time.Time
	UpdatedAt           time.Time
	DisconnectedAt      *time.Time
	ChainScopes         []ChainScope
}

type ChainScope struct {
	ChainID string
	Status  string
}

type RegisterWalletParams struct {
	SubjectID           string
	Address             string
	VerificationChainID string
	ChainIDs            []string
	Label               string
	VerifiedAt          time.Time
}

type Store interface {
	RegisterWallet(context.Context, RegisterWalletParams) (WalletSource, error)
	ListWallets(context.Context, string) ([]WalletSource, error)
	DisconnectWallet(context.Context, string, string, time.Time) (WalletSource, error)
}

type Service struct {
	enginev1.UnimplementedSourceServiceServer
	Store Store
}

func (s *Service) RegisterWallet(ctx context.Context, request *enginev1.RegisterWalletRequest) (*enginev1.RegisterWalletResponse, error) {
	subjectID, err := validateContext(request.GetContext(), true)
	if err != nil {
		return nil, err
	}
	verifiedAt, err := requiredTime(request.GetVerifiedAt(), "verified_at")
	if err != nil {
		return nil, err
	}
	result, err := s.Store.RegisterWallet(ctx, RegisterWalletParams{
		SubjectID: subjectID, Address: request.GetAddress(),
		VerificationChainID: request.GetVerificationChainId(), ChainIDs: request.GetChainIds(),
		Label: request.GetLabel(), VerifiedAt: verifiedAt,
	})
	if err != nil {
		return nil, mapStoreError(err)
	}
	return &enginev1.RegisterWalletResponse{Source: toProto(result)}, nil
}

func (s *Service) ListSources(ctx context.Context, request *enginev1.ListSourcesRequest) (*enginev1.ListSourcesResponse, error) {
	subjectID, err := validateContext(request.GetContext(), false)
	if err != nil {
		return nil, err
	}
	sources, err := s.Store.ListWallets(ctx, subjectID)
	if err != nil {
		return nil, mapStoreError(err)
	}
	items := make([]*enginev1.WalletSource, 0, len(sources))
	for _, value := range sources {
		items = append(items, toProto(value))
	}
	return &enginev1.ListSourcesResponse{Items: items}, nil
}

func (s *Service) DisconnectSource(ctx context.Context, request *enginev1.DisconnectSourceRequest) (*enginev1.DisconnectSourceResponse, error) {
	subjectID, err := validateContext(request.GetContext(), true)
	if err != nil {
		return nil, err
	}
	disconnectedAt, err := requiredTime(request.GetDisconnectedAt(), "disconnected_at")
	if err != nil {
		return nil, err
	}
	result, err := s.Store.DisconnectWallet(ctx, subjectID, request.GetSourceId(), disconnectedAt)
	if err != nil {
		return nil, mapStoreError(err)
	}
	return &enginev1.DisconnectSourceResponse{Source: toProto(result)}, nil
}

func validateContext(value *enginev1.RequestContext, mutation bool) (string, error) {
	if value == nil || value.GetRequestId() == "" || value.GetActor() == nil ||
		!uuidPattern.MatchString(value.GetActor().GetUserId()) || value.GetActor().GetSessionId() == "" {
		return "", status.Error(codes.Unauthenticated, "validated request context is required")
	}
	if mutation && value.GetIdempotencyKey() == "" {
		return "", status.Error(codes.InvalidArgument, "idempotency key is required")
	}
	return value.GetActor().GetUserId(), nil
}

func requiredTime(value *timestamppb.Timestamp, field string) (time.Time, error) {
	if value == nil || !value.IsValid() {
		return time.Time{}, status.Errorf(codes.InvalidArgument, "%s is required", field)
	}
	return value.AsTime().UTC(), nil
}

func mapStoreError(err error) error {
	if errors.Is(err, ErrNotFound) {
		return status.Error(codes.NotFound, "source not found")
	}
	return status.Error(codes.Internal, "source operation failed")
}

func toProto(value WalletSource) *enginev1.WalletSource {
	result := &enginev1.WalletSource{
		Id: value.ID, Address: value.Address, AccountType: value.AccountType,
		VerificationChainId: value.VerificationChainID, VerifiedAt: timestamppb.New(value.VerifiedAt),
		Label: value.Label, Status: value.Status, CreatedAt: timestamppb.New(value.CreatedAt),
		UpdatedAt:   timestamppb.New(value.UpdatedAt),
		ChainScopes: make([]*enginev1.WalletChainScope, 0, len(value.ChainScopes)),
	}
	if value.DisconnectedAt != nil {
		result.DisconnectedAt = timestamppb.New(*value.DisconnectedAt)
	}
	for _, scope := range value.ChainScopes {
		result.ChainScopes = append(result.ChainScopes, &enginev1.WalletChainScope{ChainId: scope.ChainID, Status: scope.Status})
	}
	return result
}
