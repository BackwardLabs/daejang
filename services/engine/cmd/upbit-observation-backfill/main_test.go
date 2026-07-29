package main

import (
	"testing"

	"github.com/BackwardLabs/daejang/services/engine/internal/upbitnormalizer"
)

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
