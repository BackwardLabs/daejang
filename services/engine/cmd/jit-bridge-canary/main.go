package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/BackwardLabs/daejang/services/engine/internal/worker"
	"github.com/BackwardLabs/daejang/services/engine/internal/worker/jitgrpc"
)

type options struct {
	configPath string
	subjectID  string
	sourceID   string
	address    string
	chainIDs   string
	startDate  string
	endDate    string
	requestID  string
}

func main() {
	var value options
	flag.StringVar(&value.configPath, "config", os.Getenv("DAEJANG_JIT_BRIDGE_CONFIG"), "absolute JIT bridge config path")
	flag.StringVar(&value.subjectID, "subject", "", "pre-authorized canary subject")
	flag.StringVar(&value.sourceID, "source", "", "canary source identifier")
	flag.StringVar(&value.address, "address", "", "lowercase EVM address")
	flag.StringVar(&value.chainIDs, "chains", "", "comma-separated CAIP-2 chain IDs")
	flag.StringVar(&value.startDate, "start", "", "coverage start date (YYYY-MM-DD)")
	flag.StringVar(&value.endDate, "end", "", "coverage end date (YYYY-MM-DD)")
	flag.StringVar(&value.requestID, "request-id", "", "unique canary request identifier")
	flag.Parse()
	if err := run(value); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(value options) error {
	for name, field := range map[string]string{
		"config": value.configPath, "subject": value.subjectID, "source": value.sourceID,
		"address": value.address, "chains": value.chainIDs, "start": value.startDate,
		"end": value.endDate, "request-id": value.requestID,
	} {
		if strings.TrimSpace(field) == "" {
			return fmt.Errorf("-%s is required", name)
		}
	}
	start, err := time.Parse(time.DateOnly, value.startDate)
	if err != nil {
		return fmt.Errorf("parse start date: %w", err)
	}
	end, err := time.Parse(time.DateOnly, value.endDate)
	if err != nil {
		return fmt.Errorf("parse end date: %w", err)
	}
	chainIDs := strings.Split(value.chainIDs, ",")
	for index := range chainIDs {
		chainIDs[index] = strings.TrimSpace(chainIDs[index])
	}
	config, err := jitgrpc.Load(value.configPath)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()
	client, err := jitgrpc.Dial(ctx, config)
	if err != nil {
		return err
	}
	defer client.Close()
	run, err := client.Start(ctx, worker.EVMJITRequest{
		IdempotencyKey: value.requestID,
		SubjectID:      value.subjectID,
		SourceID:       value.sourceID,
		Address:        strings.ToLower(value.address),
		ChainIDs:       chainIDs,
		CoverageStart:  start.UTC(),
		CoverageEnd:    end.UTC(),
		Trigger:        "OPERATOR_CANARY",
	})
	if err != nil {
		return fmt.Errorf("start JIT canary: %w", err)
	}
	result, err := client.AwaitTerminal(ctx, run)
	if err != nil {
		return fmt.Errorf("await JIT canary %s: %w", run.ID, err)
	}
	if result.State != "SUCCEEDED" {
		return errors.New("JIT canary reached a non-success terminal state")
	}
	output := struct {
		RunID            string `json:"runId"`
		State            string `json:"state"`
		FragmentID       string `json:"fragmentId"`
		ProcessedRecords int64  `json:"processedRecords"`
	}{run.ID, result.State, result.FragmentID, result.ProcessedRecords}
	return json.NewEncoder(os.Stdout).Encode(output)
}
