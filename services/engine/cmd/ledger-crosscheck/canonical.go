package main

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const canonicalTransactionSQL = `
	WITH target_observation AS (
		SELECT observation.subject_id,observation.fragment_id,observation.observation_id
		FROM subject_evidence.observation AS observation
		JOIN subject_evidence.account_transaction_link AS link
		  ON observation.origin_kind='TRANSACTION'
		 AND link.subject_id=observation.subject_id
		 AND link.fragment_id=observation.fragment_id
		 AND link.account_transaction_link_id=observation.origin_link_id
		JOIN chain_evidence.chain_transaction AS transaction
		  ON transaction.chain_transaction_id=link.chain_transaction_id
		WHERE observation.subject_id=$1
		  AND transaction.chain_id=$2
		  AND transaction.transaction_hash=$3
	), selected_revision AS (
		SELECT DISTINCT revision.subject_id,revision.event_id,revision.revision_id
		FROM ledger.interpreted_event AS event
		JOIN ledger.event_revision AS revision
		  ON revision.subject_id=event.subject_id
		 AND revision.event_id=event.event_id
		 AND revision.revision_id=event.current_revision_id
		WHERE revision.subject_id=$1 AND (
			EXISTS (
				SELECT 1
				FROM ledger.action_proof_effect_observation AS reference
				JOIN target_observation AS target
				  ON target.subject_id=reference.subject_id
				 AND target.fragment_id=reference.observation_fragment_id
				 AND target.observation_id=reference.observation_id
				WHERE reference.subject_id=revision.subject_id
				  AND reference.action_proof_id=revision.action_proof_id
			) OR EXISTS (
				SELECT 1
				FROM ledger.posting_observation AS reference
				JOIN target_observation AS target
				  ON target.subject_id=reference.subject_id
				 AND target.fragment_id=reference.observation_fragment_id
				 AND target.observation_id=reference.observation_id
				WHERE reference.subject_id=revision.subject_id
				  AND reference.event_id=revision.event_id
				  AND reference.revision_id=revision.revision_id
			)
		)
	)
	SELECT revision.event_id,revision.revision_id,COALESCE(revision.action_proof_id,''),
		COALESCE(proof.profile_id,''),COALESCE(proof.profile_version,''),COALESCE(proof.binding_id,''),
		COALESCE(classification.event_type,hypothesis.event_type),
		COALESCE(classification.flow_shape,hypothesis.flow_shape),
		COALESCE(classification.subtype,hypothesis.subtype,''),
		revision.resolution,revision.interpretation_support,
		COALESCE(review_state.status,''),
		posting.leg_id,posting.account_id,posting.asset_id,posting.direction,posting.quantity,posting.role,
		asset_meta.decimals,
		COALESCE(fair.amount,''),COALESCE(cost.amount,''),
		COALESCE(fair.denomination_asset_id,cost.denomination_asset_id,'')
	FROM selected_revision AS selected
	JOIN ledger.event_revision AS revision
	  ON revision.subject_id=selected.subject_id
	 AND revision.event_id=selected.event_id
	 AND revision.revision_id=selected.revision_id
	LEFT JOIN ledger.action_proof AS proof
	  ON proof.subject_id=revision.subject_id
	 AND proof.action_proof_id=revision.action_proof_id
	LEFT JOIN ledger.event_revision_classification AS classification
	  ON classification.subject_id=revision.subject_id
	 AND classification.event_id=revision.event_id
	 AND classification.revision_id=revision.revision_id
	LEFT JOIN ledger.hypothesis AS hypothesis
	  ON hypothesis.subject_id=revision.subject_id
	 AND hypothesis.hypothesis_id=revision.hypothesis_id
	LEFT JOIN LATERAL (
		SELECT review_revision.status
		FROM review.review_item AS item
		JOIN review.review_revision AS review_revision
		  ON review_revision.subject_id=item.subject_id
		 AND review_revision.review_id=item.review_id
		 AND review_revision.revision_id=item.current_revision_id
		WHERE item.subject_id=revision.subject_id
		  AND item.execution_id=revision.event_id
		ORDER BY (review_revision.status='OPEN') DESC,item.review_id
		LIMIT 1
	) AS review_state ON true
	LEFT JOIN ledger.asset_posting AS posting
	  ON posting.subject_id=revision.subject_id
	 AND posting.event_id=revision.event_id
	 AND posting.revision_id=revision.revision_id
	LEFT JOIN LATERAL (
		SELECT CASE WHEN count(DISTINCT asset.decimals)=1 THEN max(asset.decimals) END AS decimals
		FROM ledger.posting_observation AS reference
		JOIN subject_evidence.observation AS observation
		  ON observation.subject_id=reference.subject_id
		 AND observation.fragment_id=reference.observation_fragment_id
		 AND observation.observation_id=reference.observation_id
		JOIN subject_evidence.asset AS asset
		  ON asset.subject_id=observation.subject_id
		 AND asset.fragment_id=observation.fragment_id
		 AND asset.asset_id=observation.asset_id
		WHERE reference.subject_id=posting.subject_id
		  AND reference.event_id=posting.event_id
		  AND reference.revision_id=posting.revision_id
		  AND reference.leg_id=posting.leg_id
	) AS asset_meta ON true
	LEFT JOIN ledger.valuation AS fair
	  ON fair.subject_id=posting.subject_id
	 AND fair.event_id=posting.event_id
	 AND fair.revision_id=posting.revision_id
	 AND fair.leg_id=posting.leg_id
	 AND fair.kind='FAIR_VALUE'
	LEFT JOIN ledger.valuation AS cost
	  ON cost.subject_id=posting.subject_id
	 AND cost.event_id=posting.event_id
	 AND cost.revision_id=posting.revision_id
	 AND cost.leg_id=posting.leg_id
	 AND cost.kind='COST_BASIS'
	ORDER BY revision.event_id,posting.leg_id`

const canonicalLotLinksSQL = `
	WITH acquire AS (
		SELECT 'ACQUIRE'::text AS kind,allocation.to_leg_id AS leg_id,allocation.lot_id,
			allocation.quantity,allocation.basis_status,
			COALESCE(basis.amount,'') AS basis_amount,
			COALESCE(basis.denomination_asset_id,'') AS basis_denomination,
			''::text AS source_event_id,''::text AS source_leg_id,
			NULL::timestamptz AS source_occurred_at,''::text AS source_quantity,
			(allocation.quantity::numeric-COALESCE(consumed.total,0))::text AS remaining_quantity
		FROM lot.lot_allocation AS allocation
		LEFT JOIN ledger.valuation AS basis
		  ON basis.subject_id=allocation.subject_id
		 AND basis.valuation_id=allocation.basis_valuation_id
		LEFT JOIN LATERAL (
			SELECT sum(child.quantity::numeric) AS total
			FROM lot.lot_allocation AS child
			WHERE child.subject_id=allocation.subject_id
			  AND child.run_id=allocation.run_id
			  AND child.parent_allocation_id=allocation.allocation_id
		) AS consumed ON true
		WHERE allocation.subject_id=$1 AND allocation.run_id=$2
		  AND allocation.kind='ACQUIRE'
		  AND allocation.to_event_id=$3 AND allocation.to_revision_id=$4
	), dispose AS (
		SELECT 'DISPOSE'::text,allocation.from_leg_id,allocation.lot_id,
			allocation.quantity,source.basis_status,
			COALESCE(basis.amount,''),COALESCE(basis.denomination_asset_id,''),
			source.to_event_id,source.to_leg_id,posting.occurred_at,COALESCE(source.quantity,''),''::text
		FROM lot.lot_allocation AS allocation
		JOIN lot.lot_allocation AS source
		  ON source.subject_id=allocation.subject_id
		 AND source.run_id=allocation.run_id
		 AND source.allocation_id=allocation.parent_allocation_id
		LEFT JOIN ledger.valuation AS basis
		  ON basis.subject_id=source.subject_id
		 AND basis.valuation_id=source.basis_valuation_id
		LEFT JOIN ledger.asset_posting AS posting
		  ON posting.subject_id=source.subject_id
		 AND posting.event_id=source.to_event_id
		 AND posting.revision_id=source.to_revision_id
		 AND posting.leg_id=source.to_leg_id
		WHERE allocation.subject_id=$1 AND allocation.run_id=$2
		  AND allocation.kind='DISPOSE'
		  AND allocation.from_event_id=$3 AND allocation.from_revision_id=$4
	)
	SELECT * FROM acquire UNION ALL SELECT * FROM dispose ORDER BY 2,3 LIMIT 501`

func LoadCanonicalTransaction(ctx context.Context, pool *pgxpool.Pool, key TransactionKey) (CanonicalTransaction, error) {
	rows, err := pool.Query(ctx, canonicalTransactionSQL, key.SubjectID, key.ChainID, key.TransactionHash)
	if err != nil {
		return CanonicalTransaction{}, fmt.Errorf("read canonical transaction rows: %w", err)
	}
	defer rows.Close()
	transaction := CanonicalTransaction{Key: key, Events: []CanonicalEvent{}}
	positions := map[string]int{}
	for rows.Next() {
		var event CanonicalEvent
		var legID, accountID, assetID, direction, quantity, role *string
		var decimals *int16
		var fairValue, costBasis, denomination string
		if err := rows.Scan(
			&event.EventID, &event.RevisionID, &event.ActionProofID,
			&event.ActionProfileID, &event.ActionProfileVersion, &event.ActionBindingID,
			&event.EventType, &event.FlowShape, &event.Subtype, &event.Resolution,
			&event.InterpretationSupport, &event.ReviewState,
			&legID, &accountID, &assetID, &direction, &quantity, &role, &decimals,
			&fairValue, &costBasis, &denomination,
		); err != nil {
			return CanonicalTransaction{}, fmt.Errorf("scan canonical transaction row: %w", err)
		}
		position, found := positions[event.EventID]
		if !found {
			transaction.Events = append(transaction.Events, event)
			position = len(transaction.Events) - 1
			positions[event.EventID] = position
		}
		if legID != nil {
			posting := Posting{LegID: *legID, AccountID: *accountID, AssetID: *assetID, Direction: *direction, Quantity: *quantity, Role: *role, FairValue: fairValue, CostBasis: costBasis, Denomination: denomination}
			if decimals != nil {
				value := uint8(*decimals)
				posting.AssetDecimals = &value
			}
			transaction.Events[position].Postings = append(transaction.Events[position].Postings, posting)
		}
	}
	if err := rows.Err(); err != nil {
		return CanonicalTransaction{}, fmt.Errorf("iterate canonical transaction rows: %w", err)
	}
	if len(transaction.Events) == 0 {
		return CanonicalTransaction{}, errors.New("canonical transaction has no current Event rows")
	}
	for index := range transaction.Events {
		lineage, err := loadCanonicalLineage(ctx, pool, key.SubjectID, transaction.Events[index].EventID, transaction.Events[index].RevisionID)
		if err != nil {
			return CanonicalTransaction{}, err
		}
		transaction.Events[index].Lot = &lineage
	}
	return transaction, nil
}

func loadCanonicalLineage(ctx context.Context, pool *pgxpool.Pool, subjectID, eventID, revisionID string) (Lineage, error) {
	lineage := Lineage{Links: []LotLink{}}
	if err := pool.QueryRow(ctx, `SELECT run_id,coverage FROM lot.current_run WHERE subject_id=$1`, subjectID).Scan(&lineage.RunID, &lineage.Coverage); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return lineage, nil
		}
		return Lineage{}, fmt.Errorf("read canonical current lot run: %w", err)
	}
	rows, err := pool.Query(ctx, canonicalLotLinksSQL, subjectID, lineage.RunID, eventID, revisionID)
	if err != nil {
		return Lineage{}, fmt.Errorf("read canonical lot links: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var link LotLink
		if err := rows.Scan(&link.Kind, &link.LegID, &link.LotID, &link.Quantity, &link.BasisStatus, &link.BasisAmount, &link.BasisDenomination, &link.SourceEventID, &link.SourceLegID, &link.SourceOccurredAt, &link.SourceQuantity, &link.RemainingQuantity); err != nil {
			return Lineage{}, fmt.Errorf("scan canonical lot link: %w", err)
		}
		if link.SourceOccurredAt != nil {
			utc := link.SourceOccurredAt.UTC()
			link.SourceOccurredAt = &utc
		}
		lineage.Links = append(lineage.Links, link)
	}
	if err := rows.Err(); err != nil {
		return Lineage{}, fmt.Errorf("iterate canonical lot links: %w", err)
	}
	return lineage, nil
}
