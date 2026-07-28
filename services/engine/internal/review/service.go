package review

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/BackwardLabs/daejang-db/pkg/artifactstore"
	"github.com/BackwardLabs/daejang-db/pkg/readmodelstore"
	"github.com/BackwardLabs/daejang-db/pkg/reviewstore"
	enginev1 "github.com/BackwardLabs/daejang/services/engine/gen/go/giwa/engine/v1"
	"github.com/BackwardLabs/daejang/services/engine/internal/source"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"
)

const resolutionArtifactMediaType = "application/vnd.giwa.review-resolution.v1+json"

var recalculationScope = []string{"EVENT", "VALUATION"}
var resolutionCodePattern = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,63}$`)

type Store interface {
	Get(context.Context, string, string) (reviewstore.Review, bool, error)
	ResolveV2(context.Context, reviewstore.ResolveV2Params) (reviewstore.ResolveV2Result, error)
}

type ArtifactStore interface {
	Put(context.Context, []byte, artifactstore.PutOptions) (artifactstore.Ref, error)
}

type EvidenceStore interface {
	GetReviewEvidence(context.Context, string, string) ([]readmodelstore.ReviewEvidence, error)
}

type Service struct {
	enginev1.UnimplementedReviewServiceServer
	Reviews   Store
	Evidence  EvidenceStore
	Artifacts ArtifactStore
	Now       func() time.Time
}

type resolutionArtifact struct {
	Schema                 string   `json:"schema"`
	SubjectID              string   `json:"subjectId"`
	ReviewID               string   `json:"reviewId"`
	ExpectedRevisionID     string   `json:"expectedRevisionId"`
	ExpectedPointerVersion int64    `json:"expectedPointerVersion"`
	ResolutionCode         string   `json:"resolutionCode"`
	ResolutionNote         string   `json:"resolutionNote,omitempty"`
	ActorType              string   `json:"actorType"`
	ActorID                string   `json:"actorId"`
	IntentKey              string   `json:"intentKey"`
	RecalculationScope     []string `json:"recalculationScope"`
}

func (s *Service) GetReview(ctx context.Context, request *enginev1.GetReviewRequest) (*enginev1.GetReviewResponse, error) {
	subjectID, err := source.ValidateRequestContext(request.GetContext(), false)
	if err != nil {
		return nil, err
	}
	reviewID := request.GetReviewId()
	if !validCanonicalReviewID(reviewID) {
		return nil, status.Error(codes.InvalidArgument, "review_id is required")
	}
	value, found, err := s.Reviews.Get(ctx, subjectID, reviewID)
	if err != nil {
		return nil, status.Error(codes.Internal, "review lookup failed")
	}
	if !found {
		return nil, status.Error(codes.NotFound, "review not found")
	}
	detail, err := s.toProtoWithEvidence(ctx, subjectID, value)
	if err != nil {
		return nil, err
	}
	return &enginev1.GetReviewResponse{Review: detail}, nil
}

func (s *Service) ResolveReview(ctx context.Context, request *enginev1.ResolveReviewRequest) (*enginev1.ResolveReviewResponse, error) {
	subjectID, err := source.ValidateRequestContext(request.GetContext(), true)
	if err != nil {
		return nil, err
	}
	reviewID := request.GetReviewId()
	expectedRevisionID := request.GetExpectedRevisionId()
	resolutionCode := request.GetResolutionCode()
	resolutionNote := request.GetResolutionNote()
	if !validCanonicalReviewID(reviewID) ||
		!validCanonicalReviewID(expectedRevisionID) ||
		request.GetExpectedPointerVersion() < 1 ||
		request.GetExpectedPointerVersion() == math.MaxInt64 ||
		!resolutionCodePattern.MatchString(resolutionCode) ||
		strings.ContainsRune(resolutionNote, '\x00') {
		return nil, status.Error(codes.InvalidArgument, "review, expected revision and pointer, and resolution code are required")
	}
	if utf8.RuneCountInString(resolutionNote) > 4000 {
		return nil, status.Error(codes.InvalidArgument, "resolution note is too long")
	}

	current, found, err := s.Reviews.Get(ctx, subjectID, reviewID)
	if err != nil {
		return nil, status.Error(codes.Internal, "review lookup failed")
	}
	if !found {
		return nil, status.Error(codes.NotFound, "review not found")
	}

	intentKey := request.GetContext().GetIdempotencyKey()
	revisionID := stableUUID("review-resolution", subjectID, reviewID, intentKey)
	outboxEventID := stableUUID("review-resolved-outbox", subjectID, reviewID, intentKey)
	artifactBytes, artifactDigest, err := encodeResolutionArtifact(resolutionArtifact{
		Schema:                 "giwa.review-resolution.v1",
		SubjectID:              subjectID,
		ReviewID:               reviewID,
		ExpectedRevisionID:     expectedRevisionID,
		ExpectedPointerVersion: request.GetExpectedPointerVersion(),
		ResolutionCode:         resolutionCode,
		ResolutionNote:         resolutionNote,
		ActorType:              "USER",
		ActorID:                subjectID,
		IntentKey:              intentKey,
		RecalculationScope:     recalculationScope,
	})
	if err != nil {
		return nil, status.Error(codes.Internal, "review resolution encoding failed")
	}
	resolveParams := func(createdAt time.Time) reviewstore.ResolveV2Params {
		return reviewstore.ResolveV2Params{
			ResolveParams: reviewstore.ResolveParams{
				SubjectID:                 subjectID,
				ReviewID:                  reviewID,
				RevisionID:                revisionID,
				ExpectedCurrentRevisionID: expectedRevisionID,
				ExpectedPointerVersion:    request.GetExpectedPointerVersion(),
				ResolutionCode:            resolutionCode,
				ResolutionNote:            resolutionNote,
				ActorType:                 "USER",
				ActorID:                   subjectID,
				CanonicalArtifactDigest:   artifactDigest,
				RecalculationScope:        append([]string(nil), recalculationScope...),
				CreatedAt:                 createdAt,
				OutboxEventID:             outboxEventID,
			},
		}
	}
	if isReplay(current, revisionID, artifactDigest, expectedRevisionID, request.GetExpectedPointerVersion(), resolutionCode, resolutionNote, subjectID) {
		replay, err := s.Reviews.ResolveV2(ctx, resolveParams(current.Revision.CreatedAt))
		if err != nil || !replay.Replayed {
			return nil, status.Error(codes.Internal, "review resolution V2 replay verification failed")
		}
		detail, err := s.toProtoWithEvidence(ctx, subjectID, current)
		if err != nil {
			return nil, err
		}
		return &enginev1.ResolveReviewResponse{Review: detail, Replayed: true}, nil
	}
	if current.Pointer.CurrentRevisionID == revisionID {
		return nil, status.Error(codes.AlreadyExists, "intent key was already used for a different review resolution")
	}
	if current.Pointer.CurrentRevisionID != expectedRevisionID || current.Pointer.Version != request.GetExpectedPointerVersion() {
		return nil, status.Error(codes.Aborted, "review revision is stale")
	}
	if current.Revision.Status != "OPEN" {
		return nil, status.Error(codes.FailedPrecondition, "review is not open")
	}
	option, validOption := findOption(current.Revision.Options, resolutionCode)
	if !validOption {
		return nil, status.Error(codes.InvalidArgument, "resolution code is not an allowed review option")
	}
	if option.RequiresEvidence && strings.TrimSpace(resolutionNote) == "" {
		return nil, status.Error(codes.InvalidArgument, "resolution note is required for this option")
	}
	if _, err := s.toProtoWithEvidence(ctx, subjectID, current); err != nil {
		return nil, err
	}

	artifactRef, err := s.Artifacts.Put(ctx, artifactBytes, artifactstore.PutOptions{
		MediaType: resolutionArtifactMediaType,
		Retention: artifactstore.RetentionSubjectPrivate,
		Privacy:   artifactstore.PrivacySubjectPrivate,
	})
	if err != nil {
		return nil, status.Error(codes.Internal, "review resolution artifact failed")
	}
	if artifactRef.Digest != artifactDigest {
		return nil, status.Error(codes.Internal, "review resolution artifact digest mismatch")
	}

	now := time.Now
	if s.Now != nil {
		now = s.Now
	}
	result, err := s.Reviews.ResolveV2(ctx, resolveParams(now().UTC()))
	if err != nil {
		if errors.Is(err, reviewstore.ErrImmutableIdentityMismatch) {
			latest, latestFound, latestErr := s.Reviews.Get(ctx, subjectID, reviewID)
			if latestErr != nil || !latestFound {
				return nil, status.Error(codes.Internal, "review resolution replay lookup failed")
			}
			if isReplay(latest, revisionID, artifactDigest, expectedRevisionID, request.GetExpectedPointerVersion(), resolutionCode, resolutionNote, subjectID) {
				replay, replayErr := s.Reviews.ResolveV2(ctx, resolveParams(latest.Revision.CreatedAt))
				if replayErr == nil && replay.Replayed {
					detail, detailErr := s.toProtoWithEvidence(ctx, subjectID, latest)
					if detailErr != nil {
						return nil, detailErr
					}
					return &enginev1.ResolveReviewResponse{Review: detail, Replayed: true}, nil
				}
				return nil, status.Error(codes.Internal, "review resolution V2 replay verification failed")
			}
		}
		return nil, mapStoreError(err)
	}
	resolved, found, err := s.Reviews.Get(ctx, subjectID, reviewID)
	if err != nil || !found {
		return nil, status.Error(codes.Internal, "resolved review lookup failed")
	}
	detail, err := s.toProtoWithEvidence(ctx, subjectID, resolved)
	if err != nil {
		return nil, err
	}
	return &enginev1.ResolveReviewResponse{Review: detail, Replayed: result.Replayed}, nil
}

func validCanonicalReviewID(value string) bool {
	if value == "" ||
		value != strings.TrimSpace(value) ||
		!utf8.ValidString(value) ||
		len(utf16.Encode([]rune(value))) > 256 {
		return false
	}
	return strings.IndexFunc(value, func(r rune) bool {
		return r < 0x20 || r == 0x7f
	}) == -1
}

func (s *Service) toProtoWithEvidence(
	ctx context.Context,
	subjectID string,
	value reviewstore.Review,
) (*enginev1.ReviewDetail, error) {
	if s.Evidence == nil {
		return nil, status.Error(codes.Internal, "review evidence store is unavailable")
	}
	evidence, err := s.Evidence.GetReviewEvidence(ctx, subjectID, value.ID)
	if err != nil {
		return nil, status.Error(codes.Internal, "review evidence lookup failed")
	}
	if !hasExactEvidenceCoverage(value.Revision.Observations, evidence) {
		return nil, status.Error(codes.Internal, "review evidence projection is incomplete")
	}
	return toProto(value, evidence), nil
}

func hasExactEvidenceCoverage(
	references []reviewstore.ObservationRef,
	evidence []readmodelstore.ReviewEvidence,
) bool {
	if len(references) == 0 {
		return false
	}
	expected := make(map[string]struct{}, len(references))
	for _, reference := range references {
		key := reference.FragmentID + "\x00" + reference.ObservationID
		if _, duplicate := expected[key]; duplicate {
			return false
		}
		expected[key] = struct{}{}
	}
	if len(evidence) != len(expected) {
		return false
	}
	seen := make(map[string]struct{}, len(evidence))
	for _, item := range evidence {
		key := item.FragmentID + "\x00" + item.ObservationID
		if _, found := expected[key]; !found {
			return false
		}
		if _, duplicate := seen[key]; duplicate {
			return false
		}
		seen[key] = struct{}{}
	}
	return len(seen) == len(expected)
}

func findOption(options []reviewstore.Option, code string) (reviewstore.Option, bool) {
	for _, option := range options {
		if option.Code == code {
			return option, true
		}
	}
	return reviewstore.Option{}, false
}

func encodeResolutionArtifact(value resolutionArtifact) ([]byte, string, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, "", err
	}
	digest := sha256.Sum256(encoded)
	return encoded, hex.EncodeToString(digest[:]), nil
}

func stableUUID(parts ...string) string {
	digest := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	bytes := digest[:16]
	bytes[6] = (bytes[6] & 0x0f) | 0x50
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	raw := hex.EncodeToString(bytes)
	return fmt.Sprintf("%s-%s-%s-%s-%s", raw[0:8], raw[8:12], raw[12:16], raw[16:20], raw[20:32])
}

func isReplay(
	value reviewstore.Review,
	revisionID, artifactDigest, expectedRevisionID string,
	expectedPointerVersion int64,
	resolutionCode, resolutionNote, actorID string,
) bool {
	return value.Pointer.CurrentRevisionID == revisionID &&
		value.Pointer.Version == expectedPointerVersion+1 &&
		value.Revision.ID == revisionID &&
		value.Revision.Status == "RESOLVED" &&
		value.Revision.SupersedesID == expectedRevisionID &&
		value.Revision.ResolutionCode == resolutionCode &&
		value.Revision.ResolutionNote == resolutionNote &&
		value.Revision.ActorType == "USER" &&
		value.Revision.ActorID == actorID &&
		value.Revision.CanonicalArtifactDigest == artifactDigest
}

func mapStoreError(err error) error {
	switch {
	case errors.Is(err, reviewstore.ErrReviewNotFound):
		return status.Error(codes.NotFound, "review not found")
	case errors.Is(err, reviewstore.ErrStaleCurrentRevision):
		return status.Error(codes.Aborted, "review revision is stale")
	case errors.Is(err, reviewstore.ErrReviewNotOpen):
		return status.Error(codes.FailedPrecondition, "review is not open")
	case errors.Is(err, reviewstore.ErrReviewSchemaModulePinMissing):
		return status.Error(codes.FailedPrecondition, "REVIEW_SCHEMA_MODULE_PIN_MISSING")
	case errors.Is(err, reviewstore.ErrInvalidResolutionOption):
		return status.Error(codes.InvalidArgument, "resolution code is not an allowed review option")
	case errors.Is(err, reviewstore.ErrImmutableIdentityMismatch):
		return status.Error(codes.AlreadyExists, "intent key was already used for a different review resolution")
	default:
		return status.Error(codes.Internal, "review resolution failed")
	}
}

func toProto(value reviewstore.Review, evidence []readmodelstore.ReviewEvidence) *enginev1.ReviewDetail {
	result := &enginev1.ReviewDetail{
		Id:             value.ID,
		ExecutionId:    value.ExecutionID,
		RevisionId:     value.Revision.ID,
		RevisionNumber: value.Revision.Number,
		PointerVersion: value.Pointer.Version,
		Status:         value.Revision.Status,
		InputDigest:    value.Revision.InputDigest,
		ReasonCodes:    append([]string(nil), value.Revision.ReasonCodes...),
		CreatedAt:      timestamppb.New(value.CreatedAt),
		ResolutionCode: value.Revision.ResolutionCode,
		ResolutionNote: value.Revision.ResolutionNote,
		Options:        make([]*enginev1.ReviewOption, 0, len(value.Revision.Options)),
		Observations:   make([]*enginev1.ReviewObservationReference, 0, len(value.Revision.Observations)),
	}
	if !value.Revision.CreatedAt.IsZero() {
		result.RevisionCreatedAt = timestamppb.New(value.Revision.CreatedAt)
	}
	for _, option := range value.Revision.Options {
		result.Options = append(result.Options, &enginev1.ReviewOption{
			Code: option.Code, Label: option.Label, RequiresEvidence: option.RequiresEvidence,
		})
	}
	evidenceByObservation := make(map[string]readmodelstore.ReviewEvidence, len(evidence))
	for _, item := range evidence {
		evidenceByObservation[item.FragmentID+"\x00"+item.ObservationID] = item
	}
	for _, observation := range value.Revision.Observations {
		item := &enginev1.ReviewObservationReference{
			FragmentId: observation.FragmentID, ObservationId: observation.ObservationID,
		}
		if projected, found := evidenceByObservation[observation.FragmentID+"\x00"+observation.ObservationID]; found {
			item.Ordinal = projected.Ordinal
			item.Domain = projected.Domain
			item.Kind = projected.Kind
			item.NativeId = projected.NativeID
			item.AccountLocator = projected.AccountLocator
			if projected.AccountLabel != nil {
				item.AccountLabel = *projected.AccountLabel
			}
			item.AccountChainId = projected.AccountChainID
			if projected.AssetSymbol != nil {
				item.AssetSymbol = *projected.AssetSymbol
			}
			item.AssetLocator = projected.AssetLocator
			if projected.AssetDecimals != nil {
				item.AssetDecimals = uint32(*projected.AssetDecimals)
				item.HasAssetDecimals = true
			}
			item.Quantity = projected.Quantity
			item.OriginKind = projected.OriginKind
			item.OriginLinkId = projected.OriginLinkID
			if projected.OccurredAt != nil {
				item.OccurredAt = timestamppb.New(*projected.OccurredAt)
			}
		}
		result.Observations = append(result.Observations, item)
	}
	return result
}
