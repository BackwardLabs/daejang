// Package lotread reads the provenance lot lineage that the tax engine
// persists for a subject. It reports only rows that exist; an absent lot run
// or allocation is returned as empty, never as an inferred basis.
package lotread

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type queryer interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

type Store struct{ db queryer }
type Runtime struct {
	Store *Store
	pool  *pgxpool.Pool
}

// Link is one lot edge attached to a posting leg of the requested Event
// revision. ACQUIRE rows describe the lot the leg created, DISPOSE rows
// describe an acquisition the leg consumed.
type Link struct {
	Kind              string
	LegID             string
	LotID             string
	Quantity          string
	BasisStatus       string
	BasisAmount       string
	BasisDenomination string
	SourceEventID     string
	SourceLegID       string
	SourceOccurredAt  *time.Time
	SourceQuantity    string
	RemainingQuantity string
}

// Lineage is the current lot run for a subject together with the links that
// belong to the requested Event revision.
type Lineage struct {
	RunID    string
	Coverage string
	Links    []Link
}

func Open(ctx context.Context, databaseURL, applicationName string) (*Runtime, error) {
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
	return &Runtime{Store: &Store{db: pool}, pool: pool}, nil
}

func (r *Runtime) Close() {
	if r != nil && r.pool != nil {
		r.pool.Close()
	}
}

func (r *Runtime) Ping(ctx context.Context) error {
	if r == nil || r.pool == nil {
		return errors.New("lot read runtime is closed")
	}
	return r.pool.Ping(ctx)
}

// eventLinksSQL projects ACQUIRE and DISPOSE allocations of the current run.
// CARRY allocations, which inherit a basis across a continuity relation, are
// not projected yet, so callers must scope their wording to acquisitions and
// disposals rather than claiming a leg has no lot at all.
const eventLinksSQL = `
	WITH run AS (
		SELECT run_id FROM lot.current_run WHERE subject_id = $1
	), acquire AS (
		SELECT 'ACQUIRE'::text AS kind, allocation.to_leg_id AS leg_id, allocation.lot_id,
			allocation.quantity, allocation.basis_status,
			COALESCE(basis.amount, '') AS basis_amount,
			COALESCE(basis.denomination_asset_id, '') AS basis_denomination,
			''::text AS source_event_id, ''::text AS source_leg_id,
			NULL::timestamptz AS source_occurred_at, ''::text AS source_quantity,
			(allocation.quantity::numeric - COALESCE(consumed.total, 0))::text AS remaining_quantity
		FROM lot.lot_allocation AS allocation
		LEFT JOIN ledger.valuation AS basis
		  ON basis.subject_id = allocation.subject_id AND basis.valuation_id = allocation.basis_valuation_id
		LEFT JOIN LATERAL (
			SELECT sum(child.quantity::numeric) AS total FROM lot.lot_allocation AS child
			WHERE child.subject_id = allocation.subject_id AND child.run_id = allocation.run_id
			  AND child.parent_allocation_id = allocation.allocation_id
		) AS consumed ON true
		WHERE allocation.subject_id = $1 AND allocation.run_id = (SELECT run_id FROM run)
		  AND allocation.kind = 'ACQUIRE'
		  AND allocation.to_event_id = $2 AND allocation.to_revision_id = $3
	), dispose AS (
		SELECT 'DISPOSE'::text, allocation.from_leg_id, allocation.lot_id,
			allocation.quantity, source.basis_status,
			COALESCE(basis.amount, ''), COALESCE(basis.denomination_asset_id, ''),
			source.to_event_id, source.to_leg_id, posting.occurred_at, source.quantity, ''::text
		FROM lot.lot_allocation AS allocation
		JOIN lot.lot_allocation AS source
		  ON source.subject_id = allocation.subject_id AND source.run_id = allocation.run_id
		 AND source.allocation_id = allocation.parent_allocation_id
		LEFT JOIN ledger.valuation AS basis
		  ON basis.subject_id = source.subject_id AND basis.valuation_id = source.basis_valuation_id
		LEFT JOIN ledger.asset_posting AS posting
		  ON posting.subject_id = source.subject_id AND posting.event_id = source.to_event_id
		 AND posting.revision_id = source.to_revision_id AND posting.leg_id = source.to_leg_id
		WHERE allocation.subject_id = $1 AND allocation.run_id = (SELECT run_id FROM run)
		  AND allocation.kind = 'DISPOSE'
		  AND allocation.from_event_id = $2 AND allocation.from_revision_id = $3
	)
	SELECT * FROM acquire UNION ALL SELECT * FROM dispose ORDER BY 2, 3 LIMIT $4`

// EventLineage returns the current-run lot links for one Event revision. A
// subject without a current lot run yields an empty lineage rather than an
// error, because a missing run is a real downstream state.
func (s *Store) EventLineage(ctx context.Context, subjectID, eventID, revisionID string, limit int32) (Lineage, error) {
	if subjectID == "" || eventID == "" || revisionID == "" {
		return Lineage{}, errors.New("subject, Event, and revision are required")
	}
	if limit < 1 || limit > 500 {
		return Lineage{}, errors.New("lot link limit must be between 1 and 500")
	}
	var lineage Lineage
	err := s.db.QueryRow(ctx,
		`SELECT run_id, coverage FROM lot.current_run WHERE subject_id = $1`, subjectID,
	).Scan(&lineage.RunID, &lineage.Coverage)
	if errors.Is(err, pgx.ErrNoRows) {
		return Lineage{}, nil
	}
	if err != nil {
		return Lineage{}, fmt.Errorf("read current lot run: %w", err)
	}
	rows, err := s.db.Query(ctx, eventLinksSQL, subjectID, eventID, revisionID, limit)
	if err != nil {
		return Lineage{}, fmt.Errorf("list Event lot links: %w", err)
	}
	defer rows.Close()
	lineage.Links = []Link{}
	for rows.Next() {
		var link Link
		if err := rows.Scan(&link.Kind, &link.LegID, &link.LotID, &link.Quantity, &link.BasisStatus,
			&link.BasisAmount, &link.BasisDenomination, &link.SourceEventID, &link.SourceLegID,
			&link.SourceOccurredAt, &link.SourceQuantity, &link.RemainingQuantity); err != nil {
			return Lineage{}, fmt.Errorf("scan Event lot link: %w", err)
		}
		lineage.Links = append(lineage.Links, link)
	}
	if err := rows.Err(); err != nil {
		return Lineage{}, fmt.Errorf("iterate Event lot links: %w", err)
	}
	return lineage, nil
}
