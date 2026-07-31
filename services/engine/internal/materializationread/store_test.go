package materializationread

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
)

type fakeRow struct {
	values []any
	err    error
}

func (r fakeRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	for index, value := range r.values {
		switch target := dest[index].(type) {
		case *string:
			*target = value.(string)
		case *int64:
			*target = value.(int64)
		}
	}
	return nil
}

type fakeQueryer struct {
	rows []fakeRow
}

func (q *fakeQueryer) QueryRow(context.Context, string, ...any) pgx.Row {
	if len(q.rows) == 0 {
		return fakeRow{err: errors.New("unexpected query")}
	}
	row := q.rows[0]
	q.rows = q.rows[1:]
	return row
}

func TestGetReturnsUnavailableWithoutDurableCoordinates(t *testing.T) {
	store := &Store{}
	got, err := store.Get(context.Background(), "subject", "", "fragment")
	if err != nil || got.State != StateUnavailable {
		t.Fatalf("unexpected result: %#v err=%v", got, err)
	}
}

func TestGetReturnsUnavailableWhenPublicationDoesNotExist(t *testing.T) {
	store := &Store{evidence: &fakeQueryer{rows: []fakeRow{{err: pgx.ErrNoRows}}}}
	got, err := store.Get(context.Background(), "subject", "run", "fragment")
	if err != nil || got.State != StateUnavailable {
		t.Fatalf("unexpected result: %#v err=%v", got, err)
	}
}

func TestGetDistinguishesPendingAndClassificationReview(t *testing.T) {
	tests := []struct {
		name      string
		state     string
		lastError string
		want      string
	}{
		{name: "ready", state: "READY", want: StatePending},
		{name: "leased", state: "LEASED", want: StatePending},
		{name: "review", state: "READY", lastError: classificationReviewPrefix + " execution=tx", want: StateReviewRequired},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store := &Store{evidence: &fakeQueryer{rows: []fakeRow{{values: []any{test.state, test.lastError}}}}}
			got, err := store.Get(context.Background(), "subject", "run", "fragment")
			if err != nil || got.State != test.want {
				t.Fatalf("unexpected result: %#v err=%v", got, err)
			}
		})
	}
}

func TestGetDistinguishesPublishedWithAndWithoutPostingRows(t *testing.T) {
	tests := []struct {
		name  string
		count int64
		want  string
	}{
		{name: "no posting", count: 0, want: StateNoPosting},
		{name: "posted", count: 3, want: StatePosted},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store := &Store{
				evidence: &fakeQueryer{rows: []fakeRow{{values: []any{"PUBLISHED", ""}}}},
				ledger:   &fakeQueryer{rows: []fakeRow{{values: []any{test.count}}}},
			}
			got, err := store.Get(context.Background(), "subject", "run", "fragment")
			if err != nil || got.State != test.want || got.PostingCount != test.count {
				t.Fatalf("unexpected result: %#v err=%v", got, err)
			}
		})
	}
}
