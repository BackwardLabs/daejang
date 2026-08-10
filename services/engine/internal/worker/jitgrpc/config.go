package jitgrpc

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const (
	evidenceProfile = "EVM_ACCOUNT_FULL"
	maxConfigBytes  = 1 << 20
)

var (
	chainIDPattern    = regexp.MustCompile(`^eip155:[1-9][0-9]*$`)
	evmAddressPattern = regexp.MustCompile(`^0x[0-9a-f]{40}$`)
	blockHashPattern  = regexp.MustCompile(`^0x[0-9a-f]{64}$`)
	digestPattern     = regexp.MustCompile(`^[0-9a-f]{64}$`)
	idPattern         = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]*$`)
)

// Config is deployment-owned bridge configuration. Coverage mappings are
// immutable facts produced from the same read-only index snapshot consumed by
// jitd. Etherscan-backed mappings may safely cover a requested sub-period;
// replay still enforces the request's ownership dates.
type Config struct {
	Endpoint       string        `json:"endpoint"`
	RequestTimeout string        `json:"requestTimeout"`
	PollInterval   string        `json:"pollInterval"`
	AwaitTimeout   string        `json:"awaitTimeout"`
	TLS            TLSConfig     `json:"tls"`
	Chains         []ChainConfig `json:"chains"`
}

type TLSConfig struct {
	CAFile     string `json:"caFile"`
	CertFile   string `json:"certFile"`
	KeyFile    string `json:"keyFile"`
	ServerName string `json:"serverName"`
}

type ChainConfig struct {
	ChainID         string            `json:"chainId"`
	ChainStore      string            `json:"chainStore"`
	GenesisHash     string            `json:"genesisHash"`
	EvidenceProfile string            `json:"evidenceProfile"`
	ProfileHash     string            `json:"profileHash"`
	Coverage        []CoverageMapping `json:"coverage"`
}

type CoverageMapping struct {
	CoverageStart   string `json:"coverageStart"`
	CoverageEnd     string `json:"coverageEnd"`
	IndexSnapshotID string `json:"indexSnapshotId"`
	FromBlock       uint64 `json:"fromBlock"`
	ToBlock         uint64 `json:"toBlock"`
}

type runtimeConfig struct {
	Config
	requestTimeout time.Duration
	pollInterval   time.Duration
	awaitTimeout   time.Duration
	endpoint       *url.URL
	chains         map[string]chainRuntime
}

type chainRuntime struct {
	ChainConfig
	coverage map[string]coverageRuntime
}

type coverageRuntime struct {
	CoverageMapping
	start time.Time
	end   time.Time
}

func Load(path string) (Config, error) {
	path = filepath.Clean(strings.TrimSpace(path))
	if path == "." || !filepath.IsAbs(path) {
		return Config{}, errors.New("DAEJANG_JIT_BRIDGE_CONFIG must be an absolute path")
	}
	file, err := os.Open(path)
	if err != nil {
		return Config{}, fmt.Errorf("open JIT bridge config: %w", err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return Config{}, fmt.Errorf("stat JIT bridge config: %w", err)
	}
	if !info.Mode().IsRegular() || info.Size() > maxConfigBytes {
		return Config{}, errors.New("JIT bridge config must be a regular file no larger than 1 MiB")
	}
	decoder := json.NewDecoder(io.LimitReader(file, maxConfigBytes))
	decoder.DisallowUnknownFields()
	var config Config
	if err := decoder.Decode(&config); err != nil {
		return Config{}, fmt.Errorf("decode JIT bridge config: %w", err)
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return Config{}, err
	}
	return config, nil
}

func ensureJSONEOF(decoder *json.Decoder) error {
	var trailing any
	if err := decoder.Decode(&trailing); err == io.EOF {
		return nil
	} else if err != nil {
		return fmt.Errorf("decode trailing JIT bridge config: %w", err)
	}
	return errors.New("JIT bridge config contains multiple JSON values")
}

func validate(config Config) (runtimeConfig, error) {
	endpoint, err := validateEndpoint(config)
	if err != nil {
		return runtimeConfig{}, err
	}
	requestTimeout, err := parseDurationDefault(config.RequestTimeout, 10*time.Second, "requestTimeout")
	if err != nil {
		return runtimeConfig{}, err
	}
	pollInterval, err := parseDurationDefault(config.PollInterval, time.Second, "pollInterval")
	if err != nil {
		return runtimeConfig{}, err
	}
	awaitTimeout, err := parseDurationDefault(config.AwaitTimeout, 15*time.Minute, "awaitTimeout")
	if err != nil {
		return runtimeConfig{}, err
	}
	if len(config.Chains) == 0 {
		return runtimeConfig{}, errors.New("at least one JIT chain configuration is required")
	}
	result := runtimeConfig{
		Config: config, requestTimeout: requestTimeout, pollInterval: pollInterval,
		awaitTimeout: awaitTimeout, endpoint: endpoint, chains: make(map[string]chainRuntime, len(config.Chains)),
	}
	for _, chain := range config.Chains {
		if err := validateChain(chain); err != nil {
			return runtimeConfig{}, err
		}
		if _, duplicate := result.chains[chain.ChainID]; duplicate {
			return runtimeConfig{}, fmt.Errorf("duplicate JIT chain %q", chain.ChainID)
		}
		runtime := chainRuntime{ChainConfig: chain, coverage: make(map[string]coverageRuntime, len(chain.Coverage))}
		for _, mapping := range chain.Coverage {
			parsed, err := validateCoverage(chain.ChainID, mapping)
			if err != nil {
				return runtimeConfig{}, err
			}
			key := coverageKey(parsed.start, parsed.end)
			if _, duplicate := runtime.coverage[key]; duplicate {
				return runtimeConfig{}, fmt.Errorf("duplicate coverage mapping for chain %s and range %s..%s", chain.ChainID, mapping.CoverageStart, mapping.CoverageEnd)
			}
			runtime.coverage[key] = parsed
		}
		result.chains[chain.ChainID] = runtime
	}
	return result, nil
}

func validateEndpoint(config Config) (*url.URL, error) {
	endpoint, err := url.Parse(strings.TrimSpace(config.Endpoint))
	if err != nil || endpoint.Scheme == "" {
		return nil, errors.New("JIT endpoint must be an absolute unix:// or tcp:// URL")
	}
	switch endpoint.Scheme {
	case "unix":
		if endpoint.Host != "" || !filepath.IsAbs(endpoint.Path) {
			return nil, errors.New("unix JIT endpoint must contain an absolute socket path and no host")
		}
		if config.TLS != (TLSConfig{}) {
			return nil, errors.New("TLS settings are not accepted for a Unix JIT endpoint")
		}
	case "tcp":
		if endpoint.Path != "" || endpoint.RawQuery != "" || endpoint.Fragment != "" {
			return nil, errors.New("tcp JIT endpoint may contain only host and port")
		}
		if _, _, err := net.SplitHostPort(endpoint.Host); err != nil {
			return nil, fmt.Errorf("tcp JIT endpoint requires host:port: %w", err)
		}
		if config.TLS.CAFile == "" || config.TLS.CertFile == "" || config.TLS.KeyFile == "" {
			return nil, errors.New("remote TCP JIT endpoint requires CA, client certificate, and client key files")
		}
	default:
		return nil, fmt.Errorf("unsupported JIT endpoint scheme %q", endpoint.Scheme)
	}
	return endpoint, nil
}

func validateChain(chain ChainConfig) error {
	if !chainIDPattern.MatchString(chain.ChainID) {
		return fmt.Errorf("invalid JIT chain ID %q", chain.ChainID)
	}
	if strings.TrimSpace(chain.ChainStore) == "" || !blockHashPattern.MatchString(chain.GenesisHash) {
		return fmt.Errorf("chain %s requires chainStore and a normalized genesisHash", chain.ChainID)
	}
	if chain.EvidenceProfile != evidenceProfile || !digestPattern.MatchString(chain.ProfileHash) {
		return fmt.Errorf("chain %s has unsupported evidence profile or invalid profile hash", chain.ChainID)
	}
	if len(chain.Coverage) == 0 {
		return fmt.Errorf("chain %s requires at least one coverage mapping", chain.ChainID)
	}
	return nil
}

func validateCoverage(chainID string, mapping CoverageMapping) (coverageRuntime, error) {
	start, err := time.Parse(time.DateOnly, mapping.CoverageStart)
	if err != nil {
		return coverageRuntime{}, fmt.Errorf("chain %s coverageStart must use YYYY-MM-DD", chainID)
	}
	end, err := time.Parse(time.DateOnly, mapping.CoverageEnd)
	if err != nil {
		return coverageRuntime{}, fmt.Errorf("chain %s coverageEnd must use YYYY-MM-DD", chainID)
	}
	if end.Before(start) || mapping.FromBlock > mapping.ToBlock {
		return coverageRuntime{}, fmt.Errorf("chain %s coverage date or block range is reversed", chainID)
	}
	if !idPattern.MatchString(mapping.IndexSnapshotID) {
		return coverageRuntime{}, fmt.Errorf("chain %s coverage mapping has invalid indexSnapshotId", chainID)
	}
	return coverageRuntime{CoverageMapping: mapping, start: start.UTC(), end: end.UTC()}, nil
}

func parseDurationDefault(value string, fallback time.Duration, field string) (time.Duration, error) {
	if strings.TrimSpace(value) == "" {
		return fallback, nil
	}
	duration, err := time.ParseDuration(value)
	if err != nil || duration <= 0 {
		return 0, fmt.Errorf("%s must be a positive duration", field)
	}
	return duration, nil
}

func coverageKey(start, end time.Time) string {
	return start.Format(time.DateOnly) + "/" + end.Format(time.DateOnly)
}

func normalizeDate(value time.Time) time.Time {
	return time.Date(value.Year(), value.Month(), value.Day(), 0, 0, 0, 0, time.UTC)
}
