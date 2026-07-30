package observationread

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestClassifyCEXObservationRecords(t *testing.T) {
	tests := []struct {
		name          string
		sourceCase    string
		kind          string
		activityClass string
		eventType     string
		flowShape     string
	}{
		{name: "buy", sourceCase: "BUY", kind: "FILL", eventType: "TRADE", flowShape: "EXCHANGE"},
		{name: "sell", sourceCase: "SELL", kind: "FILL", eventType: "TRADE", flowShape: "EXCHANGE"},
		{name: "deposit", sourceCase: "DEPOSIT", kind: "DEPOSIT", eventType: "TRANSFER", flowShape: "UNKNOWN"},
		{name: "withdrawal", sourceCase: "WITHDRAWAL", kind: "WITHDRAWAL", eventType: "TRANSFER", flowShape: "UNKNOWN"},
		{name: "fallback deposit", kind: "DEPOSIT", eventType: "TRANSFER", flowShape: "UNKNOWN"},
		{name: "unknown", kind: "FEE", eventType: "OTHER", flowShape: "UNKNOWN"},
		{name: "fiat deposit", kind: "DEPOSIT", activityClass: "FIAT_DEPOSIT", eventType: "TRANSFER", flowShape: "FIAT_IN"},
		{name: "fiat withdrawal", kind: "WITHDRAWAL", activityClass: "FIAT_WITHDRAWAL", eventType: "TRANSFER", flowShape: "FIAT_OUT"},
		{name: "deposit interest", kind: "DEPOSIT", activityClass: "DEPOSIT_INTEREST", eventType: "REWARD", flowShape: "DEPOSIT_INTEREST"},
		{name: "airdrop", kind: "DEPOSIT", activityClass: "AIRDROP", eventType: "REWARD", flowShape: "AIRDROP"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			eventType, flowShape := classify(test.sourceCase, test.kind, test.activityClass)
			if eventType != test.eventType || flowShape != test.flowShape {
				t.Fatalf("classify(%q, %q) = (%q, %q), want (%q, %q)", test.sourceCase, test.kind, eventType, flowShape, test.eventType, test.flowShape)
			}
		})
	}
}

func TestStoreExternalDatabaseExcludesMaterializedObservation(t *testing.T) {
	databaseURL := os.Getenv("DAEJANG_OBSERVATION_READ_TEST_OWNER_DATABASE_URL")
	subjectID := os.Getenv("DAEJANG_OBSERVATION_READ_TEST_SUBJECT_ID")
	if databaseURL == "" || subjectID == "" {
		t.Skip("external owner observation read test is not configured")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	store := &Store{db: tx}
	before, err := store.CountUnmaterialized(ctx, subjectID, 2025)
	if err != nil {
		t.Fatal(err)
	}
	var fragmentID, observationID, runID, recordID, accountID, assetID, artifactDigest string
	var occurredAt time.Time
	err = tx.QueryRow(ctx, currentObservationsSQL+`
		SELECT observation.fragment_id,observation.observation_id,observation.origin_run_id,
			observation.origin_link_id,observation.account_id,observation.asset_id,
			observation.occurred_at,fragment.artifact_digest
		FROM current_observations AS observation
		JOIN subject_evidence.published_fragment AS fragment
		  ON fragment.subject_id=$1 AND fragment.fragment_id=observation.fragment_id
		WHERE observation.kind='DEPOSIT' LIMIT 1`, subjectID, int32(2025)).Scan(
		&fragmentID, &observationID, &runID, &recordID, &accountID, &assetID, &occurredAt, &artifactDigest)
	if err != nil {
		t.Fatal(err)
	}
	digestValue := strings.Repeat("a", 64)
	ids := map[string]string{
		"ledger": "observation-read-test-ledger", "assertion": "observation-read-test-assertion",
		"hypothesis": "observation-read-test-hypothesis", "decision": "observation-read-test-decision",
		"event": "observation-read-test-event", "revision": "observation-read-test-revision", "leg": "observation-read-test-leg",
	}
	statements := []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO ledger.ledger_revision(subject_id,ledger_revision_id,generation_id,input_digest,schema_digest,policy_name,policy_version,policy_artifact_digest,producer_name,producer_version,producer_artifact_digest,canonical_artifact_digest,status,created_at,completed_at,row_digest) VALUES($1,$2,'test-generation',$3,$3,'test-policy','v1',$4,'test-engine','v1',$4,$4,'PARTIAL',$5,$5,$3)`, []any{subjectID, ids["ledger"], digestValue, artifactDigest, occurredAt}},
		{`INSERT INTO ledger.assertion(subject_id,ledger_revision_id,assertion_id,kind,state,operation,asserted_by_type,asserted_by_id,resolver_name,resolver_version,resolver_artifact_digest,created_at,row_digest) VALUES($1,$2,$3,'ACCOUNT_OWNERSHIP','ACCEPTED','ASSERT','SYSTEM','observation-read-test','test-resolver','v1',$4,$5,$6)`, []any{subjectID, ids["ledger"], ids["assertion"], artifactDigest, occurredAt, digestValue}},
		{`INSERT INTO ledger.hypothesis(subject_id,ledger_revision_id,hypothesis_id,event_type,flow_shape,engine_name,engine_version,engine_artifact_digest,created_at,row_digest) VALUES($1,$2,$3,'TRANSFER','EXTERNAL_IN','test-engine','v1',$4,$5,$6)`, []any{subjectID, ids["ledger"], ids["hypothesis"], artifactDigest, occurredAt, digestValue}},
		{`INSERT INTO ledger.interpretation_decision(subject_id,hypothesis_id,decision_id,outcome,actor_type,actor_id,policy_name,policy_version,policy_artifact_digest,reason,decided_at,row_digest) VALUES($1,$2,$3,'ACCEPT','SYSTEM','observation-read-test','test-policy','v1',$4,'integration test',$5,$6)`, []any{subjectID, ids["hypothesis"], ids["decision"], artifactDigest, occurredAt, digestValue}},
		{`INSERT INTO ledger.interpreted_event(subject_id,event_id,created_at) VALUES($1,$2,$3)`, []any{subjectID, ids["event"], occurredAt}},
		{`INSERT INTO ledger.event_revision(subject_id,ledger_revision_id,event_id,revision_id,revision_number,hypothesis_id,decision_id,resolution,interpretation_support,effective_at,resolved_at,row_digest) VALUES($1,$2,$3,$4,1,$5,$6,'PARTIAL','DETECTED_ONLY',$7,$7,$8)`, []any{subjectID, ids["ledger"], ids["event"], ids["revision"], ids["hypothesis"], ids["decision"], occurredAt, digestValue}},
		{`UPDATE ledger.interpreted_event SET current_revision_id=$3,pointer_version=1 WHERE subject_id=$1 AND event_id=$2`, []any{subjectID, ids["event"], ids["revision"]}},
		{`INSERT INTO ledger.flow_leg(subject_id,event_id,revision_id,leg_id,kind,status,scope,row_digest) VALUES($1,$2,$3,$4,'PRINCIPAL','CONFIRMED','SUBJECT_ASSET',$5)`, []any{subjectID, ids["event"], ids["revision"], ids["leg"], digestValue}},
		{`INSERT INTO ledger.asset_posting(subject_id,event_id,revision_id,leg_id,account_id,asset_id,ownership_assertion_id,occurred_at,direction,quantity,role,row_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'IN','1','PRINCIPAL',$9)`, []any{subjectID, ids["event"], ids["revision"], ids["leg"], accountID, assetID, ids["assertion"], occurredAt, digestValue}},
		{`INSERT INTO ledger.posting_observation(subject_id,event_id,revision_id,leg_id,ordinal,observation_fragment_id,observation_id) VALUES($1,$2,$3,$4,0,$5,$6)`, []any{subjectID, ids["event"], ids["revision"], ids["leg"], fragmentID, observationID}},
	}
	for _, statement := range statements {
		if _, err := tx.Exec(ctx, statement.sql, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	after, err := store.CountUnmaterialized(ctx, subjectID, 2025)
	if err != nil {
		t.Fatal(err)
	}
	if after != before-1 {
		t.Fatalf("materialized observation was not excluded: before=%d after=%d run=%s record=%s", before, after, runID, recordID)
	}
	events, err := store.ListUnmaterialized(ctx, subjectID, 2025, 200)
	if err != nil {
		t.Fatal(err)
	}
	excludedID := "observation-event:" + digest(fragmentID + "\x00" + runID + "\x00" + recordID)[:32]
	for _, event := range events {
		if event.EventID == excludedID {
			t.Fatalf("materialized observation event remained in projection: %s", excludedID)
		}
	}
}

func TestStoreExternalDatabase(t *testing.T) {
	databaseURL := os.Getenv("DAEJANG_OBSERVATION_READ_TEST_DATABASE_URL")
	subjectID := os.Getenv("DAEJANG_OBSERVATION_READ_TEST_SUBJECT_ID")
	if databaseURL == "" || subjectID == "" {
		t.Skip("external observation read test is not configured")
	}
	runtime, err := Open(context.Background(), databaseURL, "daejang-observation-read-external-test")
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Close()
	count, err := runtime.Store.CountUnmaterialized(context.Background(), subjectID, 2025)
	if err != nil {
		t.Fatal(err)
	}
	if count == 0 {
		t.Fatal("published observations were not visible through the read projection")
	}
	events, err := runtime.Store.ListUnmaterialized(context.Background(), subjectID, 2025, 200)
	if err != nil {
		t.Fatal(err)
	}
	if int64(len(events)) != count {
		t.Fatalf("listed events = %d, counted records = %d", len(events), count)
	}
	for _, event := range events {
		if event.Resolution != "PARTIAL" || event.InterpretationSupport != "OBSERVATION_ONLY" || len(event.Postings) == 0 {
			t.Fatalf("unsafe observation projection: %#v", event)
		}
	}
	t.Logf("external observation projection: events=%d", len(events))
}
