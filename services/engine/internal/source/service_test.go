package source

import (
	"context"
	"testing"
	"time"

	enginev1 "github.com/BackwardLabs/daejang/services/engine/gen/go/giwa/engine/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"
)

type recordingStore struct {
	registered RegisterWalletParams
	document   RegisterDocumentParams
	source     WalletSource
}

func (s *recordingStore) RegisterDocument(_ context.Context, params RegisterDocumentParams) (DocumentSource, error) {
	s.document = params
	return DocumentSource{ID: "22222222-2222-4222-8222-222222222222", Provider: "UPBIT", CoverageStart: params.CoverageStart, CoverageEnd: params.CoverageEnd, CreatedAt: time.Now(), UpdatedAt: time.Now()}, nil
}

func (s *recordingStore) ListDocuments(context.Context, string) ([]DocumentSource, error) {
	return nil, nil
}

func (s *recordingStore) RegisterWallet(_ context.Context, params RegisterWalletParams) (WalletSource, error) {
	s.registered = params
	return s.source, nil
}

func (s *recordingStore) ListWallets(context.Context, string) ([]WalletSource, error) {
	return []WalletSource{s.source}, nil
}

func (s *recordingStore) DisconnectWallet(context.Context, string, string, time.Time) (WalletSource, error) {
	return s.source, nil
}

func TestRegisterWalletUsesAuthenticatedActor(t *testing.T) {
	now := time.Date(2026, 7, 26, 12, 0, 0, 0, time.UTC)
	store := &recordingStore{source: WalletSource{
		ID: "11111111-1111-4111-8111-111111111111", Address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		AccountType: "EOA", VerificationChainID: "eip155:1", VerifiedAt: now,
		Status: "ACTIVE", CreatedAt: now, UpdatedAt: now,
	}}
	service := Service{Store: store}
	response, err := service.RegisterWallet(context.Background(), &enginev1.RegisterWalletRequest{
		Context: validContext(), Address: store.source.Address, VerificationChainId: "eip155:1",
		ChainIds: []string{"eip155:1"}, VerifiedAt: timestamppb.New(now),
	})
	if err != nil {
		t.Fatal(err)
	}
	if store.registered.SubjectID != validContext().Actor.UserId || response.GetSource().GetId() != store.source.ID {
		t.Fatalf("request context was not mapped to the source operation: params=%#v response=%#v", store.registered, response)
	}
}

func TestRegisterWalletRejectsMissingIdempotencyKey(t *testing.T) {
	requestContext := validContext()
	requestContext.IdempotencyKey = ""
	_, err := (&Service{Store: &recordingStore{}}).RegisterWallet(context.Background(), &enginev1.RegisterWalletRequest{
		Context: requestContext, VerifiedAt: timestamppb.Now(),
	})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("missing idempotency key returned %v", err)
	}
}

func validContext() *enginev1.RequestContext {
	return &enginev1.RequestContext{
		RequestId: "req-test", IdempotencyKey: "challenge-test",
		Actor: &enginev1.ActorContext{
			UserId:    "00000000-0000-4000-8000-000000000001",
			SessionId: "00000000-0000-4000-8000-000000000002",
		},
	}
}
