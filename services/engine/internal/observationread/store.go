package observationread

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/BackwardLabs/daejang-db/pkg/readmodelstore"
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
		return errors.New("observation read runtime is closed")
	}
	return r.pool.Ping(ctx)
}

func (s *Store) CountUnmaterialized(ctx context.Context, subjectID string, taxYear int32) (int64, error) {
	if subjectID == "" || taxYear < 2009 {
		return 0, errors.New("valid subject and tax year are required")
	}
	var count int64
	err := s.db.QueryRow(ctx, currentObservationsSQL+` SELECT count(DISTINCT (fragment_id,origin_run_id,origin_link_id)) FROM current_observations`, subjectID, taxYear).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("count unmaterialized observations: %w", err)
	}
	return count, nil
}

func (s *Store) ListUnmaterialized(ctx context.Context, subjectID string, taxYear, limit int32) ([]readmodelstore.LedgerEvent, error) {
	if subjectID == "" || taxYear < 2009 || limit < 1 || limit > 200 {
		return nil, errors.New("valid subject, tax year, and limit are required")
	}
	rows, err := s.db.Query(ctx, currentObservationsSQL+`
		, selected_records AS (
			SELECT fragment_id,origin_run_id,origin_link_id,max(occurred_at) AS occurred_at
			FROM current_observations GROUP BY fragment_id,origin_run_id,origin_link_id
			ORDER BY occurred_at DESC,fragment_id,origin_run_id,origin_link_id LIMIT $3
		)
		SELECT observation.fragment_id,observation.origin_run_id,observation.origin_link_id,
			observation.observation_id,observation.kind,observation.account_id,observation.asset_id,
			observation.quantity,observation.occurred_at,
			COALESCE(asset.symbol,''),asset.decimals,COALESCE(asset.venue,''),
			COALESCE(activity.activity_class,'UNSPECIFIED')
		FROM current_observations AS observation
		JOIN selected_records USING(fragment_id,origin_run_id,origin_link_id)
		LEFT JOIN subject_evidence.asset AS asset
		  ON asset.subject_id=$1
		 AND asset.fragment_id=observation.fragment_id
		 AND asset.asset_id=observation.asset_id
		LEFT JOIN subject_evidence.observation_activity_v1 AS activity
		  ON activity.subject_id=$1
		 AND activity.fragment_id=observation.fragment_id
		 AND activity.observation_id=observation.observation_id
		ORDER BY selected_records.occurred_at DESC,observation.fragment_id,observation.origin_run_id,observation.origin_link_id,observation.local_index`, subjectID, taxYear, limit)
	if err != nil {
		return nil, fmt.Errorf("list unmaterialized observations: %w", err)
	}
	defer rows.Close()
	type key struct{ fragment, run, record string }
	index := map[key]int{}
	result := []readmodelstore.LedgerEvent{}
	for rows.Next() {
		var fragment, run, record, observationID, kind, accountID, assetID, quantity string
		var assetSymbol, assetVenue, activityClass string
		var assetDecimals *int16
		var occurredAt time.Time
		if err := rows.Scan(&fragment, &run, &record, &observationID, &kind, &accountID, &assetID, &quantity, &occurredAt, &assetSymbol, &assetDecimals, &assetVenue, &activityClass); err != nil {
			return nil, err
		}
		k := key{fragment, run, record}
		position, exists := index[k]
		if !exists {
			eventType, flowShape := classify("", kind, activityClass)
			id := "observation-event:" + digest(fragment + "\x00" + run + "\x00" + record)[:32]
			position = len(result)
			index[k] = position
			result = append(result, readmodelstore.LedgerEvent{EventID: id, RevisionID: id + ":v1", RevisionNumber: 1, EventType: eventType, FlowShape: flowShape, Resolution: "PARTIAL", InterpretationSupport: "OBSERVATION_ONLY", EffectiveAt: occurredAt.UTC()})
		}
		direction := "IN"
		absolute := quantity
		if strings.HasPrefix(quantity, "-") {
			direction = "OUT"
			absolute = strings.TrimPrefix(quantity, "-")
		}
		role := "PRINCIPAL"
		if kind == "FEE" {
			role = "FEE"
		}
		posting := readmodelstore.Posting{LegID: observationID, AccountID: accountID, AssetID: assetID, AssetSymbol: assetSymbol, AssetVenue: assetVenue, OccurredAt: occurredAt.UTC(), Direction: direction, Quantity: absolute, Role: role}
		if assetDecimals != nil {
			decimals := uint8(*assetDecimals)
			posting.AssetDecimals = &decimals
		}
		result[position].Postings = append(result[position].Postings, posting)
	}
	return result, rows.Err()
}

const currentObservationsSQL = `
	WITH latest_fragments AS (
		SELECT DISTINCT ON (subject_id,fragment_series_id) subject_id,fragment_id
		FROM subject_evidence.published_fragment
		WHERE subject_id=$1 AND producer_kind='SOURCE'
		ORDER BY subject_id,fragment_series_id,revision_number DESC,fragment_id DESC
	), current_observations AS (
		SELECT observation.fragment_id,observation.observation_id,observation.kind,
			observation.account_id,observation.asset_id,observation.quantity,observation.occurred_at,
			observation.origin_run_id,observation.origin_link_id,observation.local_index
		FROM subject_evidence.observation AS observation
		JOIN latest_fragments AS fragment ON fragment.subject_id=observation.subject_id AND fragment.fragment_id=observation.fragment_id
		WHERE observation.subject_id=$1 AND observation.domain='CEX'
		  AND EXTRACT(YEAR FROM observation.occurred_at AT TIME ZONE 'Asia/Seoul')=$2
		  AND NOT EXISTS (
			SELECT 1 FROM ledger.posting_observation AS posting
			WHERE posting.subject_id=observation.subject_id
			  AND posting.observation_fragment_id=observation.fragment_id
			  AND posting.observation_id=observation.observation_id
		  )
	)`

func classify(sourceCase, kind, activityClass string) (string, string) {
	switch activityClass {
	case "DEPOSIT_INTEREST":
		return "REWARD", "DEPOSIT_INTEREST"
	case "FIAT_DEPOSIT":
		return "TRANSFER", "FIAT_IN"
	case "FIAT_WITHDRAWAL":
		return "TRANSFER", "FIAT_OUT"
	case "AIRDROP":
		return "REWARD", "AIRDROP"
	}
	switch sourceCase {
	case "BUY", "SELL":
		return "TRADE", "EXCHANGE"
	case "DEPOSIT":
		return "TRANSFER", "UNKNOWN"
	case "WITHDRAWAL":
		return "TRANSFER", "UNKNOWN"
	}
	switch kind {
	case "FILL":
		return "TRADE", "EXCHANGE"
	case "DEPOSIT":
		return "TRANSFER", "UNKNOWN"
	case "WITHDRAWAL":
		return "TRANSFER", "UNKNOWN"
	}
	return "OTHER", "UNKNOWN"
}
func digest(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}
