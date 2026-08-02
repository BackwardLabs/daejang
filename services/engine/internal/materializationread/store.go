package materializationread

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	StateUnavailable    = "UNAVAILABLE"
	StatePending        = "PENDING"
	StateReviewRequired = "REVIEW_REQUIRED"
	StatePosted         = "POSTED"
	StateNoPosting      = "NO_POSTING"
)

const classificationReviewPrefix = "EVM classification review required:"

type Snapshot struct {
	State        string
	PostingCount int64
}

type rowQueryer interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

type Store struct {
	evidence rowQueryer
	ledger   rowQueryer
}

type Runtime struct {
	Store        *Store
	evidencePool *pgxpool.Pool
	ledgerPool   *pgxpool.Pool
}

func Open(ctx context.Context, evidenceDatabaseURL, ledgerDatabaseURL, applicationName string) (*Runtime, error) {
	evidencePool, err := openPool(ctx, evidenceDatabaseURL, applicationName+"-evidence")
	if err != nil {
		return nil, fmt.Errorf("open materialization evidence read pool: %w", err)
	}
	ledgerPool, err := openPool(ctx, ledgerDatabaseURL, applicationName+"-ledger")
	if err != nil {
		evidencePool.Close()
		return nil, fmt.Errorf("open materialization ledger read pool: %w", err)
	}
	return &Runtime{
		Store:        &Store{evidence: evidencePool, ledger: ledgerPool},
		evidencePool: evidencePool,
		ledgerPool:   ledgerPool,
	}, nil
}

func openPool(ctx context.Context, databaseURL, applicationName string) (*pgxpool.Pool, error) {
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, err
	}
	config.ConnConfig.RuntimeParams["application_name"] = applicationName
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return pool, nil
}

func (r *Runtime) Close() {
	if r == nil {
		return
	}
	if r.evidencePool != nil {
		r.evidencePool.Close()
	}
	if r.ledgerPool != nil {
		r.ledgerPool.Close()
	}
}

func (r *Runtime) Ping(ctx context.Context) error {
	if r == nil || r.evidencePool == nil || r.ledgerPool == nil {
		return errors.New("materialization read runtime is closed")
	}
	if err := r.evidencePool.Ping(ctx); err != nil {
		return err
	}
	return r.ledgerPool.Ping(ctx)
}

func (s *Store) Get(ctx context.Context, subjectID, jitRunID, fragmentID string) (Snapshot, error) {
	if strings.TrimSpace(subjectID) == "" || strings.TrimSpace(jitRunID) == "" || strings.TrimSpace(fragmentID) == "" {
		return Snapshot{State: StateUnavailable}, nil
	}

	var outboxState, lastError string
	err := s.evidence.QueryRow(ctx, `
		SELECT state,last_error
		FROM subject_evidence.publication_outbox
		WHERE subject_id=$1
		  AND producer_kind='JIT'
		  AND producer_run_id=$2
		  AND fragment_id=$3`, subjectID, jitRunID, fragmentID).Scan(&outboxState, &lastError)
	if errors.Is(err, pgx.ErrNoRows) {
		return Snapshot{State: StateUnavailable}, nil
	}
	if err != nil {
		return Snapshot{}, fmt.Errorf("read JIT publication state: %w", err)
	}

	if outboxState == "READY" && strings.HasPrefix(lastError, classificationReviewPrefix) {
		return Snapshot{State: StateReviewRequired}, nil
	}
	if outboxState != "PUBLISHED" {
		return Snapshot{State: StatePending}, nil
	}

	var postingCount int64
	if err := s.ledger.QueryRow(ctx, `
		WITH source_events AS (
			SELECT DISTINCT event_id
			FROM ledger.posting_observation
			WHERE subject_id=$1 AND observation_fragment_id=$2
		)
		SELECT count(DISTINCT (posting.event_id,posting.revision_id,posting.leg_id))
		FROM source_events
		JOIN ledger.interpreted_event AS event
		  ON event.subject_id=$1
		 AND event.event_id=source_events.event_id
		JOIN ledger.asset_posting AS posting
		  ON posting.subject_id=event.subject_id
		 AND posting.event_id=event.event_id
		 AND posting.revision_id=event.current_revision_id`, subjectID, fragmentID).Scan(&postingCount); err != nil {
		return Snapshot{}, fmt.Errorf("count materialized Posting rows: %w", err)
	}
	if postingCount == 0 {
		return Snapshot{State: StateNoPosting}, nil
	}
	return Snapshot{State: StatePosted, PostingCount: postingCount}, nil
}
