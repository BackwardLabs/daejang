package review

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/BackwardLabs/daejang-db/pkg/artifactstore"
	"github.com/BackwardLabs/daejang-db/pkg/readmodelstore"
	"github.com/BackwardLabs/daejang-db/pkg/reviewstore"
	enginev1 "github.com/BackwardLabs/daejang/services/engine/gen/go/giwa/engine/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const testSubjectID = "11111111-1111-4111-8111-111111111111"

type fakeReviewStore struct {
	value          reviewstore.Review
	found          bool
	getErr         error
	resolveErr     error
	resolveErrOnce error
	commitOnError  bool
	resolveCalls   int
	lastSubjectID  string
	evidence       []readmodelstore.ReviewEvidence
	evidenceSet    bool
	evidenceErr    error
	evidenceCalls  int
	params         reviewstore.ResolveV2Params
}

func (s *fakeReviewStore) Get(_ context.Context, subjectID, _ string) (reviewstore.Review, bool, error) {
	s.lastSubjectID = subjectID
	return s.value, s.found, s.getErr
}

func (s *fakeReviewStore) GetReviewEvidence(_ context.Context, subjectID, _ string) ([]readmodelstore.ReviewEvidence, error) {
	s.lastSubjectID = subjectID
	s.evidenceCalls++
	if !s.evidenceSet {
		result := make([]readmodelstore.ReviewEvidence, 0, len(s.value.Revision.Observations))
		for ordinal, reference := range s.value.Revision.Observations {
			result = append(result, readmodelstore.ReviewEvidence{
				Ordinal:       int32(ordinal),
				FragmentID:    reference.FragmentID,
				ObservationID: reference.ObservationID,
			})
		}
		return result, s.evidenceErr
	}
	return append([]readmodelstore.ReviewEvidence(nil), s.evidence...), s.evidenceErr
}

func (s *fakeReviewStore) ResolveV2(_ context.Context, params reviewstore.ResolveV2Params) (reviewstore.ResolveV2Result, error) {
	s.resolveCalls++
	s.params = params
	if s.resolveErrOnce != nil {
		err := s.resolveErrOnce
		s.resolveErrOnce = nil
		if s.commitOnError {
			s.applyResolution(params)
		}
		return reviewstore.ResolveV2Result{}, err
	}
	if s.resolveErr != nil {
		return reviewstore.ResolveV2Result{}, s.resolveErr
	}
	if s.value.Pointer.CurrentRevisionID == params.RevisionID {
		return reviewstore.ResolveV2Result{
			Pointer: s.value.Pointer, Replayed: true,
		}, nil
	}
	s.applyResolution(params)
	return reviewstore.ResolveV2Result{Pointer: s.value.Pointer}, nil
}

func (s *fakeReviewStore) applyResolution(params reviewstore.ResolveV2Params) {
	s.value.Pointer.CurrentRevisionID = params.RevisionID
	s.value.Pointer.Version = params.ExpectedPointerVersion + 1
	s.value.Revision.ID = params.RevisionID
	s.value.Revision.Number++
	s.value.Revision.Status = "RESOLVED"
	s.value.Revision.SupersedesID = params.ExpectedCurrentRevisionID
	s.value.Revision.ActorType = params.ActorType
	s.value.Revision.ActorID = params.ActorID
	s.value.Revision.ResolutionCode = params.ResolutionCode
	s.value.Revision.ResolutionNote = params.ResolutionNote
	s.value.Revision.CanonicalArtifactDigest = params.CanonicalArtifactDigest
	s.value.Revision.CreatedAt = params.CreatedAt
}

type fakeArtifactStore struct {
	values  [][]byte
	options []artifactstore.PutOptions
	err     error
}

func (s *fakeArtifactStore) Put(_ context.Context, value []byte, options artifactstore.PutOptions) (artifactstore.Ref, error) {
	if s.err != nil {
		return artifactstore.Ref{}, s.err
	}
	s.values = append(s.values, append([]byte(nil), value...))
	s.options = append(s.options, options)
	digest := sha256.Sum256(value)
	return artifactstore.Ref{Algorithm: "sha256", Digest: hex.EncodeToString(digest[:])}, nil
}

func openReview() reviewstore.Review {
	createdAt := time.Date(2027, 1, 2, 3, 4, 5, 0, time.UTC)
	return reviewstore.Review{
		SubjectID: testSubjectID,
		ID:        "review-1",
		CreatedAt: createdAt,
		Pointer: reviewstore.Pointer{
			SubjectID: testSubjectID, ReviewID: "review-1",
			CurrentRevisionID: "revision-1", Version: 3,
		},
		Revision: reviewstore.Revision{
			ID: "revision-1", Number: 1, Status: "OPEN", CreatedAt: createdAt,
			Options: []reviewstore.Option{
				{Code: "PERSONAL", Label: "개인 거래"},
				{Code: "PROVIDE_CONTEXT", Label: "추가 맥락", RequiresEvidence: true},
			},
			Observations: []reviewstore.ObservationRef{{
				FragmentID: "fragment-1", ObservationID: "observation-1",
			}},
		},
	}
}

func requestContext(intentKey string) *enginev1.RequestContext {
	return &enginev1.RequestContext{
		RequestId: "request-1", IdempotencyKey: intentKey,
		Actor: &enginev1.ActorContext{UserId: testSubjectID, SessionId: "session-1"},
	}
}

func resolveRequest(intentKey, code, note string) *enginev1.ResolveReviewRequest {
	return &enginev1.ResolveReviewRequest{
		Context: requestContext(intentKey), ReviewId: "review-1",
		ExpectedRevisionId: "revision-1", ExpectedPointerVersion: 3,
		ResolutionCode: code, ResolutionNote: note,
	}
}

func TestResolveReviewDerivesSubjectAndActorAndReplaysStableIntent(t *testing.T) {
	reviews := &fakeReviewStore{value: openReview(), found: true}
	artifacts := &fakeArtifactStore{}
	service := &Service{
		Reviews: reviews, Evidence: reviews, Artifacts: artifacts,
		Now: func() time.Time { return time.Date(2027, 2, 3, 4, 5, 6, 0, time.UTC) },
	}

	first, err := service.ResolveReview(context.Background(), resolveRequest("intent-1", "PERSONAL", "사용자 확인"))
	if err != nil {
		t.Fatal(err)
	}
	if first.Replayed {
		t.Fatal("first resolution was reported as a replay")
	}
	if reviews.params.SubjectID != testSubjectID || reviews.params.ActorID != testSubjectID || reviews.params.ActorType != "USER" {
		t.Fatalf("subject or actor was not session derived: %#v", reviews.params)
	}
	if len(artifacts.values) != 1 {
		t.Fatalf("artifact writes = %d, want 1", len(artifacts.values))
	}
	if artifacts.options[0].Privacy != artifactstore.PrivacySubjectPrivate ||
		artifacts.options[0].Retention != artifactstore.RetentionSubjectPrivate ||
		artifacts.options[0].Pin {
		t.Fatalf("unsafe resolution artifact options: %#v", artifacts.options[0])
	}
	var artifact resolutionArtifact
	if err := json.Unmarshal(artifacts.values[0], &artifact); err != nil {
		t.Fatal(err)
	}
	if artifact.SubjectID != testSubjectID || artifact.ActorID != testSubjectID || artifact.IntentKey != "intent-1" {
		t.Fatalf("artifact identity was not derived correctly: %#v", artifact)
	}

	second, err := service.ResolveReview(context.Background(), resolveRequest("intent-1", "PERSONAL", "사용자 확인"))
	if err != nil {
		t.Fatal(err)
	}
	if !second.Replayed || reviews.resolveCalls != 2 || len(artifacts.values) != 1 {
		t.Fatalf("retry was not a read-only replay: response=%#v resolves=%d artifacts=%d", second, reviews.resolveCalls, len(artifacts.values))
	}
}

func TestResolveReviewRejectsStalePointerBeforeArtifactWrite(t *testing.T) {
	value := openReview()
	value.Pointer.Version = 4
	reviews := &fakeReviewStore{value: value, found: true}
	artifacts := &fakeArtifactStore{}
	service := &Service{Reviews: reviews, Evidence: reviews, Artifacts: artifacts}

	_, err := service.ResolveReview(context.Background(), resolveRequest("intent-stale", "PERSONAL", ""))
	if status.Code(err) != codes.Aborted {
		t.Fatalf("status = %s, want ABORTED: %v", status.Code(err), err)
	}
	if reviews.resolveCalls != 0 || len(artifacts.values) != 0 {
		t.Fatal("stale request produced durable writes")
	}
}

func TestResolveReviewRejectsInvalidOptionAndMissingEvidenceNote(t *testing.T) {
	tests := []struct {
		name string
		code string
		note string
	}{
		{name: "unknown option", code: "NOT_ALLOWED"},
		{name: "evidence note required", code: "PROVIDE_CONTEXT", note: "   "},
		{name: "PostgreSQL NUL note", code: "PERSONAL", note: "first\x00second"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			reviews := &fakeReviewStore{value: openReview(), found: true}
			artifacts := &fakeArtifactStore{}
			service := &Service{Reviews: reviews, Evidence: reviews, Artifacts: artifacts}
			_, err := service.ResolveReview(context.Background(), resolveRequest("intent-invalid", test.code, test.note))
			if status.Code(err) != codes.InvalidArgument {
				t.Fatalf("status = %s, want INVALID_ARGUMENT: %v", status.Code(err), err)
			}
			if reviews.resolveCalls != 0 || len(artifacts.values) != 0 {
				t.Fatal("invalid request produced durable writes")
			}
		})
	}
}

func TestResolveReviewRejectsPointerOverflowBeforeArtifactWrite(t *testing.T) {
	reviews := &fakeReviewStore{value: openReview(), found: true}
	artifacts := &fakeArtifactStore{}
	service := &Service{Reviews: reviews, Evidence: reviews, Artifacts: artifacts}
	request := resolveRequest("intent-overflow", "PERSONAL", "")
	request.ExpectedPointerVersion = math.MaxInt64

	_, err := service.ResolveReview(context.Background(), request)
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("status=%s, want INVALID_ARGUMENT: %v", status.Code(err), err)
	}
	if reviews.resolveCalls != 0 || len(artifacts.values) != 0 {
		t.Fatal("overflowing pointer produced durable writes")
	}
}

func TestResolveReviewRejectsNoncanonicalIdentifiersBeforeArtifactWrite(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*enginev1.ResolveReviewRequest)
	}{
		{name: "trimmed review ID", mutate: func(request *enginev1.ResolveReviewRequest) {
			request.ReviewId = " review-1"
		}},
		{name: "trimmed revision ID", mutate: func(request *enginev1.ResolveReviewRequest) {
			request.ExpectedRevisionId = "revision-1 "
		}},
		{name: "lowercase option code", mutate: func(request *enginev1.ResolveReviewRequest) {
			request.ResolutionCode = "personal"
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			reviews := &fakeReviewStore{value: openReview(), found: true}
			artifacts := &fakeArtifactStore{}
			service := &Service{Reviews: reviews, Evidence: reviews, Artifacts: artifacts}
			request := resolveRequest("intent-noncanonical", "PERSONAL", "")
			test.mutate(request)

			_, err := service.ResolveReview(context.Background(), request)
			if status.Code(err) != codes.InvalidArgument {
				t.Fatalf("status=%s, want INVALID_ARGUMENT: %v", status.Code(err), err)
			}
			if reviews.resolveCalls != 0 || len(artifacts.values) != 0 {
				t.Fatal("noncanonical identifier produced durable writes")
			}
		})
	}
}

func TestResolveReviewUsesUnicodeCodePointNoteLimit(t *testing.T) {
	reviews := &fakeReviewStore{value: openReview(), found: true}
	service := &Service{
		Reviews: reviews, Evidence: reviews, Artifacts: &fakeArtifactStore{},
	}
	if _, err := service.ResolveReview(
		context.Background(),
		resolveRequest("intent-unicode-ok", "PERSONAL", strings.Repeat("가", 4000)),
	); err != nil {
		t.Fatalf("4000 Unicode code points were rejected: %v", err)
	}

	reviews = &fakeReviewStore{value: openReview(), found: true}
	service = &Service{
		Reviews: reviews, Evidence: reviews, Artifacts: &fakeArtifactStore{},
	}
	if _, err := service.ResolveReview(
		context.Background(),
		resolveRequest("intent-unicode-long", "PERSONAL", strings.Repeat("가", 4001)),
	); status.Code(err) != codes.InvalidArgument {
		t.Fatalf("status = %s, want INVALID_ARGUMENT: %v", status.Code(err), err)
	}
	if reviews.resolveCalls != 0 {
		t.Fatal("overlong Unicode note reached persistence")
	}
}

func TestResolveReviewRejectsConflictingIntentReuse(t *testing.T) {
	value := openReview()
	revisionID := stableUUID("review-resolution", testSubjectID, value.ID, "intent-reused")
	value.Pointer.CurrentRevisionID = revisionID
	value.Pointer.Version = 4
	value.Revision.ID = revisionID
	value.Revision.Status = "RESOLVED"
	value.Revision.SupersedesID = "revision-1"
	value.Revision.ActorType = "USER"
	value.Revision.ActorID = testSubjectID
	value.Revision.ResolutionCode = "PERSONAL"
	value.Revision.ResolutionNote = "original"
	value.Revision.CanonicalArtifactDigest = "a" + string(make([]byte, 63))
	reviews := &fakeReviewStore{value: value, found: true}
	service := &Service{Reviews: reviews, Evidence: reviews, Artifacts: &fakeArtifactStore{}}

	_, err := service.ResolveReview(context.Background(), resolveRequest("intent-reused", "PERSONAL", "different"))
	if status.Code(err) != codes.AlreadyExists {
		t.Fatalf("status = %s, want ALREADY_EXISTS: %v", status.Code(err), err)
	}
}

func TestResolveReviewRejectsReplayWhenDurableV2VerificationFails(t *testing.T) {
	reviews := &fakeReviewStore{value: openReview(), found: true}
	artifacts := &fakeArtifactStore{}
	service := &Service{
		Reviews: reviews, Evidence: reviews, Artifacts: artifacts,
	}
	request := resolveRequest("intent-v2-drift", "PERSONAL", "사용자 확인")
	if _, err := service.ResolveReview(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	reviews.resolveErr = reviewstore.ErrImmutableIdentityMismatch

	if _, err := service.ResolveReview(context.Background(), request); status.Code(err) != codes.Internal {
		t.Fatalf("status = %s, want INTERNAL: %v", status.Code(err), err)
	}
	if reviews.resolveCalls != 2 || len(artifacts.values) != 1 {
		t.Fatal("mismatched V2 replay produced new durable writes")
	}
}

func TestResolveReviewVerifiesConcurrentExactResolutionAsReplay(t *testing.T) {
	reviews := &fakeReviewStore{
		value: openReview(), found: true,
		resolveErrOnce: reviewstore.ErrImmutableIdentityMismatch,
		commitOnError:  true,
	}
	artifacts := &fakeArtifactStore{}
	service := &Service{
		Reviews: reviews, Evidence: reviews, Artifacts: artifacts,
		Now: func() time.Time { return time.Date(2027, 2, 3, 4, 5, 6, 0, time.UTC) },
	}

	response, err := service.ResolveReview(
		context.Background(),
		resolveRequest("intent-concurrent", "PERSONAL", "사용자 확인"),
	)
	if err != nil {
		t.Fatal(err)
	}
	if !response.Replayed || reviews.resolveCalls != 2 || len(artifacts.values) != 1 {
		t.Fatalf("concurrent exact resolution was not verified as a replay: response=%#v resolves=%d artifacts=%d",
			response, reviews.resolveCalls, len(artifacts.values))
	}
}

func TestGetReviewScopesLookupToAuthenticatedSubject(t *testing.T) {
	occurredAt := time.Date(2027, 1, 1, 2, 3, 4, 0, time.UTC)
	accountLabel := "주 거래소"
	assetSymbol := "ETH"
	assetDecimals := uint8(18)
	reviews := &fakeReviewStore{
		value: openReview(), found: true, evidenceSet: true,
		evidence: []readmodelstore.ReviewEvidence{{
			Ordinal: 0, FragmentID: "fragment-1", ObservationID: "observation-1",
			Domain: "CEX", Kind: "FILL", NativeID: "trade-1", OccurredAt: &occurredAt,
			AccountLocator: "upbit/account", AccountLabel: &accountLabel,
			AssetSymbol: &assetSymbol, AssetLocator: "upbit/ETH",
			AssetDecimals: &assetDecimals, Quantity: "1.250000000000000000",
			OriginKind: "SOURCE_RECORD", OriginLinkID: "record-1",
		}},
	}
	service := &Service{Reviews: reviews, Evidence: reviews}
	response, err := service.GetReview(context.Background(), &enginev1.GetReviewRequest{
		Context: requestContext(""), ReviewId: "review-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if reviews.lastSubjectID != testSubjectID || response.Review.GetId() != "review-1" {
		t.Fatalf("lookup escaped session subject: subject=%q response=%#v", reviews.lastSubjectID, response)
	}
	observation := response.Review.GetObservations()[0]
	if reviews.evidenceCalls != 1 ||
		observation.GetNativeId() != "trade-1" ||
		observation.GetQuantity() != "1.250000000000000000" ||
		observation.GetAssetSymbol() != "ETH" ||
		!observation.GetHasAssetDecimals() ||
		observation.GetAssetDecimals() != 18 ||
		observation.GetOccurredAt().AsTime() != occurredAt {
		t.Fatalf("bounded evidence projection was not returned: %#v", observation)
	}
}

func TestGetReviewFailsClosedForIncompleteOrDuplicateEvidenceProjection(t *testing.T) {
	for name, evidence := range map[string][]readmodelstore.ReviewEvidence{
		"missing": nil,
		"duplicate": {
			{FragmentID: "fragment-1", ObservationID: "observation-1"},
			{FragmentID: "fragment-1", ObservationID: "observation-1"},
		},
	} {
		t.Run(name, func(t *testing.T) {
			reviews := &fakeReviewStore{
				value: openReview(), found: true, evidenceSet: true, evidence: evidence,
			}
			service := &Service{Reviews: reviews, Evidence: reviews}
			_, err := service.GetReview(context.Background(), &enginev1.GetReviewRequest{
				Context: requestContext(""), ReviewId: "review-1",
			})
			if status.Code(err) != codes.Internal {
				t.Fatalf("status=%s, want INTERNAL: %v", status.Code(err), err)
			}
		})
	}

	value := openReview()
	value.Revision.Observations = nil
	reviews := &fakeReviewStore{value: value, found: true}
	service := &Service{Reviews: reviews, Evidence: reviews}
	_, err := service.GetReview(context.Background(), &enginev1.GetReviewRequest{
		Context: requestContext(""), ReviewId: "review-1",
	})
	if status.Code(err) != codes.Internal {
		t.Fatalf("evidence-free review status=%s, want INTERNAL: %v", status.Code(err), err)
	}
}

func TestResolveReviewRejectsIncompleteEvidenceBeforeDurableWrites(t *testing.T) {
	reviews := &fakeReviewStore{
		value: openReview(), found: true, evidenceSet: true,
	}
	artifacts := &fakeArtifactStore{}
	service := &Service{Reviews: reviews, Evidence: reviews, Artifacts: artifacts}
	_, err := service.ResolveReview(
		context.Background(),
		resolveRequest("intent-missing-evidence", "PERSONAL", ""),
	)
	if status.Code(err) != codes.Internal {
		t.Fatalf("status=%s, want INTERNAL: %v", status.Code(err), err)
	}
	if reviews.resolveCalls != 0 || len(artifacts.values) != 0 {
		t.Fatal("incomplete evidence produced durable writes")
	}
}

func TestResolveReviewMapsStoreStaleError(t *testing.T) {
	reviews := &fakeReviewStore{value: openReview(), found: true, resolveErr: reviewstore.ErrStaleCurrentRevision}
	service := &Service{Reviews: reviews, Evidence: reviews, Artifacts: &fakeArtifactStore{}}
	_, err := service.ResolveReview(context.Background(), resolveRequest("intent-race", "PERSONAL", ""))
	if !errors.Is(reviews.resolveErr, reviewstore.ErrStaleCurrentRevision) || status.Code(err) != codes.Aborted {
		t.Fatalf("status = %s, want ABORTED: %v", status.Code(err), err)
	}
}
