package main

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Sample struct {
	Key      TransactionKey `json:"key"`
	TaxYear  int32          `json:"taxYear"`
	LatestAt time.Time      `json:"latestAt"`
}

type SampleFilter struct {
	SubjectID       string
	ChainID         string
	TransactionHash string
	Limit           int
}

var readModelSubjectPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

const canonicalSampleSQL = `
	WITH action_observation AS (
		SELECT DISTINCT revision.subject_id,revision.event_id,revision.revision_id,
			revision.effective_at,reference.observation_fragment_id,reference.observation_id
		FROM ledger.interpreted_event AS event
		JOIN ledger.event_revision AS revision
		  ON revision.subject_id=event.subject_id
		 AND revision.event_id=event.event_id
		 AND revision.revision_id=event.current_revision_id
		JOIN ledger.action_proof_effect_observation AS reference
		  ON reference.subject_id=revision.subject_id
		 AND reference.action_proof_id=revision.action_proof_id
		WHERE revision.action_proof_id IS NOT NULL
	), coordinate AS (
		SELECT observation.subject_id,action.event_id,action.revision_id,action.effective_at,
			transaction.chain_id,transaction.transaction_hash::text AS transaction_hash
		FROM action_observation AS action
		JOIN subject_evidence.observation AS observation
		  ON observation.subject_id=action.subject_id
		 AND observation.fragment_id=action.observation_fragment_id
		 AND observation.observation_id=action.observation_id
		JOIN subject_evidence.account_transaction_link AS link
		  ON observation.origin_kind='TRANSACTION'
		 AND link.subject_id=observation.subject_id
		 AND link.fragment_id=observation.fragment_id
		 AND link.account_transaction_link_id=observation.origin_link_id
		JOIN chain_evidence.chain_transaction AS transaction
		  ON transaction.chain_transaction_id=link.chain_transaction_id
	)
	SELECT subject_id,chain_id,transaction_hash,
		EXTRACT(YEAR FROM max(effective_at))::integer AS tax_year,max(effective_at)
	FROM coordinate
	WHERE subject_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
	  AND ($1::text='' OR subject_id=$1)
	  AND ($2::text='' OR chain_id=$2)
	  AND ($3::text='' OR transaction_hash=$3)
	GROUP BY subject_id,chain_id,transaction_hash
	ORDER BY max(effective_at) DESC,subject_id,chain_id,transaction_hash
	LIMIT $4`

const canonicalSampleCountSQL = `
	WITH action_observation AS (
		SELECT DISTINCT revision.subject_id,reference.observation_fragment_id,reference.observation_id
		FROM ledger.interpreted_event AS event
		JOIN ledger.event_revision AS revision
		  ON revision.subject_id=event.subject_id
		 AND revision.event_id=event.event_id
		 AND revision.revision_id=event.current_revision_id
		JOIN ledger.action_proof_effect_observation AS reference
		  ON reference.subject_id=revision.subject_id
		 AND reference.action_proof_id=revision.action_proof_id
		WHERE revision.action_proof_id IS NOT NULL
	), coordinate AS (
		SELECT action.subject_id,transaction.chain_id,transaction.transaction_hash::text AS transaction_hash
		FROM action_observation AS action
		JOIN subject_evidence.observation AS observation
		  ON observation.subject_id=action.subject_id
		 AND observation.fragment_id=action.observation_fragment_id
		 AND observation.observation_id=action.observation_id
		JOIN subject_evidence.account_transaction_link AS link
		  ON observation.origin_kind='TRANSACTION'
		 AND link.subject_id=observation.subject_id
		 AND link.fragment_id=observation.fragment_id
		 AND link.account_transaction_link_id=observation.origin_link_id
		JOIN chain_evidence.chain_transaction AS transaction
		  ON transaction.chain_transaction_id=link.chain_transaction_id
	)
	SELECT chain_id,count(DISTINCT (subject_id,transaction_hash))
	FROM coordinate
	WHERE subject_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
	GROUP BY chain_id ORDER BY chain_id`

func DiscoverSamples(ctx context.Context, pool *pgxpool.Pool, filter SampleFilter) ([]Sample, error) {
	if filter.Limit < 1 || filter.Limit > 500 {
		return nil, errors.New("sample limit must be between 1 and 500")
	}
	if (filter.ChainID == "") != (filter.TransactionHash == "") {
		return nil, errors.New("chain ID and transaction hash must be supplied together")
	}
	rows, err := pool.Query(ctx, canonicalSampleSQL,
		strings.TrimSpace(filter.SubjectID), strings.ToLower(strings.TrimSpace(filter.ChainID)),
		strings.ToLower(strings.TrimSpace(filter.TransactionHash)), filter.Limit)
	if err != nil {
		return nil, fmt.Errorf("discover canonical ActionProof transaction samples: %w", err)
	}
	defer rows.Close()
	samples := make([]Sample, 0, filter.Limit)
	for rows.Next() {
		var sample Sample
		if err := rows.Scan(&sample.Key.SubjectID, &sample.Key.ChainID, &sample.Key.TransactionHash, &sample.TaxYear, &sample.LatestAt); err != nil {
			return nil, fmt.Errorf("scan canonical transaction sample: %w", err)
		}
		if !isReadModelSubject(sample.Key.SubjectID) {
			continue
		}
		sample.LatestAt = sample.LatestAt.UTC()
		samples = append(samples, sample)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate canonical transaction samples: %w", err)
	}
	return samples, nil
}

func isReadModelSubject(value string) bool { return readModelSubjectPattern.MatchString(value) }

func CountCanonicalSamplesByChain(ctx context.Context, pool *pgxpool.Pool) (map[string]int, error) {
	rows, err := pool.Query(ctx, canonicalSampleCountSQL)
	if err != nil {
		return nil, fmt.Errorf("count canonical ActionProof transaction samples: %w", err)
	}
	defer rows.Close()
	counts := map[string]int{}
	for rows.Next() {
		var chainID string
		var count int
		if err := rows.Scan(&chainID, &count); err != nil {
			return nil, fmt.Errorf("scan canonical transaction sample count: %w", err)
		}
		counts[chainID] = count
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate canonical transaction sample counts: %w", err)
	}
	return counts, nil
}
