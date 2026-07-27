package query

import (
	"context"
	"encoding/base64"
	"testing"
	"time"

	"github.com/BackwardLabs/daejang-db/pkg/readmodelstore"
	enginev1 "github.com/BackwardLabs/daejang/services/engine/gen/go/giwa/engine/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const queryTestSubjectID = "11111111-1111-4111-8111-111111111111"

type fakeReadStore struct {
	page        readmodelstore.OpenReviewPage
	lastSubject string
	lastCursor  *readmodelstore.OpenReviewCursor
	lastLimit   int32
}

func (f *fakeReadStore) Dashboard(context.Context, string, int32) (readmodelstore.Dashboard, error) {
	return readmodelstore.Dashboard{}, nil
}

func (f *fakeReadStore) ListLedgerEvents(context.Context, string, int32, int32) ([]readmodelstore.LedgerEvent, error) {
	return nil, nil
}

func (f *fakeReadStore) ListOpenReviewsPage(
	_ context.Context,
	subject string,
	cursor *readmodelstore.OpenReviewCursor,
	limit int32,
) (readmodelstore.OpenReviewPage, error) {
	f.lastSubject = subject
	f.lastCursor = cursor
	f.lastLimit = limit
	return f.page, nil
}

func queryTestContext() *enginev1.RequestContext {
	return &enginev1.RequestContext{
		RequestId: "request-1",
		Actor: &enginev1.ActorContext{
			UserId:    queryTestSubjectID,
			SessionId: "session-1",
		},
	}
}

func TestListReviewsReturnsAndConsumesOpaqueKeysetCursor(t *testing.T) {
	createdAt := time.Date(2027, 2, 3, 4, 5, 6, 789, time.UTC)
	reads := &fakeReadStore{page: readmodelstore.OpenReviewPage{
		Reviews: []readmodelstore.Review{{
			ID: "review-2", ExecutionID: "execution-2", RevisionID: "revision-2",
			PointerVersion: 3, Status: "OPEN", ReasonCodes: []string{"NEEDS_CONTEXT"},
			CreatedAt: createdAt,
		}},
		Next:    &readmodelstore.OpenReviewCursor{CreatedAt: createdAt, ReviewID: "review-2"},
		HasMore: true,
	}}
	service := &Service{Reads: reads}
	first, err := service.ListReviews(context.Background(), &enginev1.ListReviewsRequest{
		Context: queryTestContext(),
		Limit:   25,
	})
	if err != nil {
		t.Fatal(err)
	}
	if reads.lastSubject != queryTestSubjectID || reads.lastCursor != nil || reads.lastLimit != 25 {
		t.Fatalf("unexpected first page input: subject=%q cursor=%#v limit=%d", reads.lastSubject, reads.lastCursor, reads.lastLimit)
	}
	if len(first.GetItems()) != 1 || first.GetItems()[0].GetId() != "review-2" || first.GetNextPageToken() == "" {
		t.Fatalf("unexpected first page response: %#v", first)
	}

	reads.page = readmodelstore.OpenReviewPage{}
	second, err := service.ListReviews(context.Background(), &enginev1.ListReviewsRequest{
		Context:   queryTestContext(),
		Limit:     25,
		PageToken: first.GetNextPageToken(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if reads.lastCursor == nil ||
		reads.lastCursor.ReviewID != "review-2" ||
		!reads.lastCursor.CreatedAt.Equal(createdAt) {
		t.Fatalf("cursor did not round-trip: %#v", reads.lastCursor)
	}
	if second.GetNextPageToken() != "" {
		t.Fatalf("terminal page returned a cursor: %#v", second)
	}
}

func TestListReviewsRejectsInvalidPageInputBeforeDatabaseQuery(t *testing.T) {
	nulReviewIDToken := base64.RawURLEncoding.EncodeToString([]byte(
		`{"v":1,"createdAt":"2027-01-01T00:00:00Z","reviewId":"x\u0000y"}`,
	))
	zeroTimeToken := base64.RawURLEncoding.EncodeToString([]byte(
		`{"v":1,"createdAt":"0001-01-01T00:00:00Z","reviewId":"review-1"}`,
	))
	for name, request := range map[string]*enginev1.ListReviewsRequest{
		"invalid token": {
			Context: queryTestContext(), PageToken: "not-base64!",
		},
		"NUL review ID": {
			Context: queryTestContext(), PageToken: nulReviewIDToken,
		},
		"zero time": {
			Context: queryTestContext(), PageToken: zeroTimeToken,
		},
		"oversized limit": {
			Context: queryTestContext(), Limit: 201,
		},
	} {
		t.Run(name, func(t *testing.T) {
			reads := &fakeReadStore{}
			service := &Service{Reads: reads}
			_, err := service.ListReviews(context.Background(), request)
			if status.Code(err) != codes.InvalidArgument {
				t.Fatalf("status=%s, want INVALID_ARGUMENT: %v", status.Code(err), err)
			}
			if reads.lastSubject != "" {
				t.Fatalf("database was queried for invalid input: %#v", reads)
			}
		})
	}
}
