package lotread

import (
	"context"
	"math/big"
	"os"
	"testing"
)

// TestEventLineageReadsPersistedAllocations runs the lineage SQL against a real
// database so the joins and the remaining-quantity arithmetic stay honest. It
// is skipped unless a database and subject are configured.
func TestEventLineageReadsPersistedAllocations(t *testing.T) {
	databaseURL := os.Getenv("DAEJANG_LOT_LINEAGE_DATABASE_URL")
	subjectID := os.Getenv("DAEJANG_LOT_LINEAGE_SUBJECT_ID")
	if databaseURL == "" || subjectID == "" {
		t.Skip("lot lineage integration test is not configured")
	}
	ctx := context.Background()
	runtime, err := Open(ctx, databaseURL, "daejang-engine-lot-read-test")
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Close()

	var eventID, revisionID string
	err = runtime.pool.QueryRow(ctx, `
		SELECT allocation.from_event_id, allocation.from_revision_id
		FROM lot.lot_allocation AS allocation
		JOIN lot.current_run AS current
		  ON current.subject_id = allocation.subject_id AND current.run_id = allocation.run_id
		WHERE allocation.subject_id = $1 AND allocation.kind = 'DISPOSE'
		LIMIT 1`, subjectID).Scan(&eventID, &revisionID)
	if err != nil {
		t.Skipf("configured subject has no current-run disposal: %v", err)
	}

	lineage, err := runtime.Store.EventLineage(ctx, subjectID, eventID, revisionID, 500)
	if err != nil {
		t.Fatal(err)
	}
	if lineage.RunID == "" || len(lineage.Links) == 0 {
		t.Fatalf("expected the current run and at least one link for %s: %#v", eventID, lineage)
	}
	for _, link := range lineage.Links {
		switch link.Kind {
		case "ACQUIRE":
			quantity, ok := new(big.Int).SetString(link.Quantity, 10)
			if !ok {
				t.Fatalf("acquisition quantity is not canonical: %#v", link)
			}
			remaining, ok := new(big.Int).SetString(link.RemainingQuantity, 10)
			if !ok || remaining.Sign() < 0 || remaining.Cmp(quantity) > 0 {
				t.Fatalf("remaining quantity is outside the acquired lot: %#v", link)
			}
		case "DISPOSE":
			if link.SourceEventID == "" || link.SourceLegID == "" || link.SourceQuantity == "" {
				t.Fatalf("disposal link lost its acquisition coordinates: %#v", link)
			}
		default:
			t.Fatalf("unexpected lot link kind: %#v", link)
		}
		if link.BasisStatus == "KNOWN" && link.BasisAmount == "" && link.Kind == "DISPOSE" {
			t.Fatalf("known basis was reported without an amount: %#v", link)
		}
		if link.BasisStatus == "UNKNOWN" && link.BasisAmount != "" {
			t.Fatalf("unknown basis was reported with an amount: %#v", link)
		}
	}
}
