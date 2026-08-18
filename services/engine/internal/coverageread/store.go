// Package coverageread reads the coverage a JIT discovery actually delivered
// for a finished EVM wallet sync job: the per-chain block/time window from
// subject_evidence.transaction_discovery_run and the uncovered segments from
// subject_evidence.discovery_coverage_segment, joined through the job's output
// fragment. It is a read-only sibling of materializationread and uses the same
// source artifact connection.
package coverageread

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Coverage struct {
	ChainID              string
	FromBlock            int64
	ToBlock              int64
	FromTime             time.Time
	ToTime               time.Time
	Status               string
	LimitationReasonCode string
	GapSegmentCount      int64
}

type Store struct {
	pool *pgxpool.Pool
}

type Runtime struct {
	Store *Store
	pool  *pgxpool.Pool
}

func Open(ctx context.Context, databaseURL, applicationName string) (*Runtime, error) {
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse coverage read DSN: %w", err)
	}
	config.ConnConfig.RuntimeParams["application_name"] = applicationName
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, fmt.Errorf("open coverage read pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping coverage read pool: %w", err)
	}
	return &Runtime{Store: &Store{pool: pool}, pool: pool}, nil
}

func (r *Runtime) Close() {
	if r != nil && r.pool != nil {
		r.pool.Close()
	}
}

func (r *Runtime) Ping(ctx context.Context) error {
	if r == nil || r.pool == nil {
		return errors.New("coverage read runtime is closed")
	}
	return r.pool.Ping(ctx)
}

// List returns the delivered coverage rows for one committed evidence
// fragment, ordered by chain then run id so repeated calls are stable.
func (s *Store) List(ctx context.Context, subjectID, fragmentID string) ([]Coverage, error) {
	if strings.TrimSpace(subjectID) == "" || strings.TrimSpace(fragmentID) == "" {
		return nil, nil
	}
	rows, err := s.pool.Query(ctx, `
		SELECT run.chain_id,
		       run.from_block_number::bigint,
		       run.to_block_number::bigint,
		       run.from_block_time,
		       run.to_block_time,
		       run.status,
		       COALESCE(run.limitation_reason_code, ''),
		       (SELECT count(*)
		          FROM subject_evidence.discovery_coverage_segment AS segment
		         WHERE segment.subject_id = run.subject_id
		           AND segment.fragment_id = run.fragment_id
		           AND segment.discovery_run_id = run.discovery_run_id
		           AND segment.status = 'ERROR')
		FROM subject_evidence.transaction_discovery_run AS run
		WHERE run.subject_id = $1 AND run.fragment_id = $2
		ORDER BY run.chain_id, run.discovery_run_id`, subjectID, fragmentID)
	if err != nil {
		return nil, fmt.Errorf("read delivered coverage: %w", err)
	}
	defer rows.Close()
	var result []Coverage
	for rows.Next() {
		var value Coverage
		if err := rows.Scan(&value.ChainID, &value.FromBlock, &value.ToBlock, &value.FromTime, &value.ToTime,
			&value.Status, &value.LimitationReasonCode, &value.GapSegmentCount); err != nil {
			return nil, fmt.Errorf("scan delivered coverage: %w", err)
		}
		result = append(result, value)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate delivered coverage: %w", err)
	}
	return result, nil
}
