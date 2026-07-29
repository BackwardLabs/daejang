package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/BackwardLabs/daejang-db/pkg/artifactstore"
	"github.com/BackwardLabs/daejang-db/pkg/evidencestore"
	"github.com/BackwardLabs/daejang-db/pkg/reportstore"
	"github.com/BackwardLabs/daejang/services/engine/internal/upbitnormalizer"
	"github.com/jackc/pgx/v5/pgxpool"
)

type sourceRevision struct {
	FragmentID       string
	FragmentSeriesID string
	RevisionNumber   uint64
	GenerationID     string
	ProducerName     string
	ProducerVersion  string
	ArtifactDigest   string
	OriginalDigest   string
	OriginalLocator  string
	InternalDigest   string
	InternalLocator  string
	CoverageStart    time.Time
	CoverageEnd      time.Time
}

func main() {
	databaseURL := os.Getenv("DAEJANG_SOURCE_DATABASE_URL")
	artifactRoot := os.Getenv("DAEJANG_PRIVATE_OBJECT_ROOT")
	artifactTemp := os.Getenv("DAEJANG_PRIVATE_OBJECT_TEMP")
	subjectID := os.Getenv("DAEJANG_BACKFILL_SUBJECT_ID")
	fragmentID := os.Getenv("DAEJANG_BACKFILL_FRAGMENT_ID")
	if databaseURL == "" || artifactRoot == "" || artifactTemp == "" || subjectID == "" || fragmentID == "" {
		log.Fatal("DAEJANG_SOURCE_DATABASE_URL, DAEJANG_PRIVATE_OBJECT_ROOT, DAEJANG_PRIVATE_OBJECT_TEMP, DAEJANG_BACKFILL_SUBJECT_ID, and DAEJANG_BACKFILL_FRAGMENT_ID are required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		log.Fatal(err)
	}
	defer pool.Close()
	revision, err := loadSourceRevision(ctx, pool, subjectID, fragmentID)
	if err != nil {
		log.Fatal(err)
	}
	artifacts, err := artifactstore.Open(ctx, artifactstore.Options{DatabaseURL: databaseURL, ApplicationName: "daejang-upbit-observation-backfill-artifacts", ArtifactRoot: artifactRoot, ArtifactTemp: artifactTemp})
	if err != nil {
		log.Fatal(err)
	}
	defer artifacts.Close()
	evidence, err := evidencestore.OpenSourceEvidenceWriter(ctx, evidencestore.Options{DatabaseURL: databaseURL, ApplicationName: "daejang-upbit-observation-backfill-evidence", ArtifactRoot: artifactRoot, ArtifactTemp: artifactTemp})
	if err != nil {
		log.Fatal(err)
	}
	defer evidence.Close()
	internalObject, found, err := artifacts.Store.GetSubjectEvidenceArtifact(ctx, subjectID, revision.FragmentID, revision.InternalDigest)
	if err != nil {
		log.Fatal(err)
	}
	if !found {
		log.Fatal("published internal evidence artifact was not found")
	}
	prepared, err := upbitnormalizer.Prepare(upbitnormalizer.Input{
		SubjectID: subjectID, CoverageStart: revision.CoverageStart, CoverageEnd: revision.CoverageEnd,
		OriginalArtifact: artifactstore.Ref{Algorithm: "sha256", Digest: revision.OriginalDigest, Locator: revision.OriginalLocator},
		InternalArtifact: artifactstore.Ref{Algorithm: "sha256", Digest: revision.InternalDigest, Locator: revision.InternalLocator},
		InternalEvidence: internalObject.Bytes,
	})
	if err != nil {
		log.Fatal(err)
	}
	root, err := artifacts.Store.Put(ctx, prepared.RootArtifact, artifactstore.PutOptions{MediaType: "application/json", Retention: artifactstore.RetentionSubjectPrivate, Privacy: artifactstore.PrivacySubjectPrivate})
	if err != nil {
		log.Fatal(err)
	}
	if root.Digest != prepared.ResultDigest {
		log.Fatal("normalizer root digest mismatch")
	}
	newFragmentID, publishSuccessor := targetFragment(subjectID, revision)
	if publishSuccessor {
		identity := revision.FragmentID + "\x00" + upbitnormalizer.ProducerVersion
		producerRunID := stableUUID(subjectID, "upbit-observation-run\x00"+identity)
		_, err = evidence.Store.PublishSourceEvidence(ctx, evidencestore.PublishSourceEvidenceParams{
			SubjectID: subjectID, FragmentID: newFragmentID, FragmentSeriesID: revision.FragmentSeriesID,
			RevisionNumber: revision.RevisionNumber + 1, SupersedesFragmentID: revision.FragmentID,
			ProducerRunID: producerRunID, GenerationID: revision.GenerationID,
			ArtifactDigest: root.Digest, ResultDigest: prepared.ResultDigest, SchemaDigest: upbitnormalizer.SchemaDigest,
			ProducerName: upbitnormalizer.ProducerName, ProducerVersion: upbitnormalizer.ProducerVersion,
			TerminalStatus: prepared.TerminalStatus, Evidence: prepared.Evidence,
		})
		if err != nil {
			log.Fatal(err)
		}
	} else if revision.ArtifactDigest != prepared.ResultDigest {
		log.Fatal("existing normalized fragment digest does not match deterministic result")
	}
	if err := publishCoverageReports(ctx, databaseURL, artifacts.Store, subjectID, newFragmentID, prepared); err != nil {
		log.Fatal(err)
	}
	log.Printf("Upbit observation backfill published: records=%d normalized=%d observations=%d status=%s", prepared.RecordCount, prepared.NormalizedCount, len(prepared.Evidence.Observations), prepared.TerminalStatus)
}

type coverageManifest struct {
	SchemaVersion      string `json:"schemaVersion"`
	SubjectID          string `json:"subjectId"`
	FragmentID         string `json:"fragmentId"`
	TaxYear            int32  `json:"taxYear"`
	TransactionCount   int64  `json:"transactionCount"`
	CompleteCount      int64  `json:"completeCount"`
	ExceptionCount     int64  `json:"exceptionCount"`
	SourceResultDigest string `json:"sourceResultDigest"`
}

const coverageReportVersion = "v2"

func publishCoverageReports(ctx context.Context, databaseURL string, artifacts *artifactstore.Store, subjectID, fragmentID string, prepared upbitnormalizer.Result) error {
	runtime, err := reportstore.Open(ctx, reportstore.Options{DatabaseURL: databaseURL, ApplicationName: "daejang-upbit-observation-backfill-reports"})
	if err != nil {
		return err
	}
	defer runtime.Close()
	type coverageCount struct{ complete, exception int64 }
	counts := map[int32]coverageCount{}
	for _, record := range prepared.CoverageRecords {
		count := counts[record.TaxYear]
		if record.Status == "NORMALIZED" {
			count.complete++
		} else {
			count.exception++
		}
		counts[record.TaxYear] = count
	}
	for year, count := range counts {
		complete, exception := count.complete, count.exception
		manifest := coverageManifest{SchemaVersion: "daejang.source-coverage-report.v1", SubjectID: subjectID, FragmentID: fragmentID, TaxYear: int32(year), TransactionCount: complete + exception, CompleteCount: complete, ExceptionCount: exception, SourceResultDigest: prepared.ResultDigest}
		raw, err := json.Marshal(manifest)
		if err != nil {
			return err
		}
		resultDigest := sha256Hex(raw)
		stored, err := artifacts.Put(ctx, raw, artifactstore.PutOptions{MediaType: "application/json", Retention: artifactstore.RetentionSubjectPrivate, Privacy: artifactstore.PrivacySubjectPrivate})
		if err != nil {
			return fmt.Errorf("store %d source coverage manifest: %w", year, err)
		}
		if stored.Digest != resultDigest {
			return fmt.Errorf("store %d source coverage manifest: digest mismatch", year)
		}
		inputDigest := sha256Hex([]byte(subjectID + "\x00" + fragmentID + "\x00" + fmt.Sprint(year) + "\x00" + prepared.ResultDigest + "\x00" + coverageReportVersion))
		_, err = runtime.Store.Commit(ctx, reportstore.CommitParams{
			ID: stableUUID(subjectID, "source-coverage-report\x00"+inputDigest), SubjectID: subjectID, TaxYear: year, Status: "PARTIAL",
			InputDigest: inputDigest, ResultDigest: resultDigest, SchemaDigest: upbitnormalizer.SchemaDigest,
			TransactionCount: complete + exception, CompleteCount: complete, ExceptionCount: exception,
			ProfitAmount: "UNKNOWN", Denomination: "KRW", ProducerName: "daejang-source-coverage-report", ProducerVersion: coverageReportVersion,
			ManifestDigest: resultDigest, RowDigest: sha256Hex(append([]byte("report-row\x00"), raw...)), IssuedAt: time.Now().UTC(),
		})
		if err != nil {
			return fmt.Errorf("commit %d source coverage report: %w", year, err)
		}
	}
	return nil
}

func loadSourceRevision(ctx context.Context, pool *pgxpool.Pool, subjectID, fragmentID string) (sourceRevision, error) {
	var v sourceRevision
	err := pool.QueryRow(ctx, `
		WITH requested AS (
			SELECT fragment_series_id FROM subject_evidence.published_fragment
			WHERE subject_id=$1 AND fragment_id=$2 AND producer_kind='SOURCE'
		)
		SELECT fragment.fragment_id,fragment.fragment_series_id,fragment.revision_number,fragment.generation_id,
			fragment.producer_name,fragment.producer_version,fragment.artifact_digest,
			source.artifact_digest,source.locator,run.producer_artifact_digest,
			internal.locator,source.coverage_from,source.coverage_to
		FROM subject_evidence.published_fragment AS fragment
		JOIN subject_evidence.source_artifact AS source
		  ON source.subject_id=fragment.subject_id AND source.fragment_id=fragment.fragment_id
		JOIN subject_evidence.source_extraction_run AS run
		  ON run.subject_id=source.subject_id AND run.fragment_id=source.fragment_id
		 AND run.source_artifact_id=source.source_artifact_id
		JOIN artifact.artifact_object AS internal
		  ON internal.algorithm='sha256' AND internal.digest=run.producer_artifact_digest
		JOIN requested ON requested.fragment_series_id=fragment.fragment_series_id
		WHERE fragment.subject_id=$1
		  AND fragment.producer_kind='SOURCE' AND source.system_name='UPBIT'
		ORDER BY fragment.revision_number DESC,fragment.fragment_id DESC,run.completed_at DESC LIMIT 1`, subjectID, fragmentID).Scan(
		&v.FragmentID, &v.FragmentSeriesID, &v.RevisionNumber, &v.GenerationID, &v.ProducerName, &v.ProducerVersion,
		&v.ArtifactDigest, &v.OriginalDigest, &v.OriginalLocator,
		&v.InternalDigest, &v.InternalLocator, &v.CoverageStart, &v.CoverageEnd)
	if err != nil {
		return sourceRevision{}, fmt.Errorf("load published Upbit source revision: %w", err)
	}
	return v, nil
}

func targetFragment(subjectID string, revision sourceRevision) (string, bool) {
	if revision.ProducerName == upbitnormalizer.ProducerName && revision.ProducerVersion == upbitnormalizer.ProducerVersion {
		return revision.FragmentID, false
	}
	identity := revision.FragmentID + "\x00" + upbitnormalizer.ProducerVersion
	return stableUUID(subjectID, "upbit-observation-fragment\x00"+identity), true
}

func stableUUID(subjectID, identity string) string {
	sum := sha256.Sum256([]byte(subjectID + "\x00" + identity))
	value := sum[:16]
	value[6] = (value[6] & 0x0f) | 0x50
	value[8] = (value[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", value[0:4], value[4:6], value[6:8], value[8:10], value[10:16])
}

func sha256Hex(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}
