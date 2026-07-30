package main

import (
	"encoding/base64"
	"testing"

	"github.com/BackwardLabs/daejang/services/engine/internal/upbitnormalizer"
)

func TestLoadPrivateArtifactKeysCombinesCurrentAndRotationKeys(t *testing.T) {
	current := make([]byte, 32)
	legacy := make([]byte, 32)
	legacy[0] = 1
	t.Setenv("PRIVATE_OBJECT_ENCRYPTION_KEY_ID", "current")
	t.Setenv("PRIVATE_OBJECT_ENCRYPTION_KEY", base64.StdEncoding.EncodeToString(current))
	t.Setenv("PRIVATE_OBJECT_DECRYPTION_KEYS", `{"legacy":"`+base64.StdEncoding.EncodeToString(legacy)+`"}`)

	keys, err := loadPrivateArtifactKeys()
	if err != nil {
		t.Fatal(err)
	}
	if len(keys) != 2 || len(keys["current"]) != 32 || keys["legacy"][0] != 1 {
		t.Fatalf("unexpected private artifact keyring: %#v", keys)
	}
}

func TestLoadPrivateArtifactKeysFailsClosedWithoutKeys(t *testing.T) {
	t.Setenv("PRIVATE_OBJECT_ENCRYPTION_KEY_ID", "")
	t.Setenv("PRIVATE_OBJECT_ENCRYPTION_KEY", "")
	t.Setenv("PRIVATE_OBJECT_DECRYPTION_KEYS", "")
	if _, err := loadPrivateArtifactKeys(); err == nil {
		t.Fatal("missing backfill decryption keys were accepted")
	}
}

func TestCoverageReportVersionChangesWhenAggregationContractChanges(t *testing.T) {
	if coverageReportVersion != "v2" {
		t.Fatalf("coverage report version = %q, want v2", coverageReportVersion)
	}
}

func TestTargetFragmentDoesNotCreateARevisionFromItsOwnCurrentOutput(t *testing.T) {
	revision := sourceRevision{FragmentID: "fragment-v2", ProducerName: upbitnormalizer.ProducerName, ProducerVersion: upbitnormalizer.ProducerVersion}
	target, publish := targetFragment("subject-1", revision)
	if publish || target != "fragment-v2" {
		t.Fatalf("current normalizer output would create another revision: target=%q publish=%t", target, publish)
	}
}

func TestTargetFragmentCreatesDeterministicSuccessorForOlderProducer(t *testing.T) {
	revision := sourceRevision{FragmentID: "fragment-v1", ProducerName: "older-normalizer", ProducerVersion: "v0"}
	first, publish := targetFragment("subject-1", revision)
	second, secondPublish := targetFragment("subject-1", revision)
	if !publish || !secondPublish || first == "fragment-v1" || first != second {
		t.Fatalf("successor identity is not deterministic: first=%q second=%q publish=%t/%t", first, second, publish, secondPublish)
	}
}
