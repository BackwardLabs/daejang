#!/bin/sh
#
# Deploys ReviewProofRegistryV2 to the disposable local chain and writes the
# coordinates the ReviewRoom API needs to start.
#
# The API verifies the registry on chain before it serves anything: it reads the
# runtime code at the configured address and compares the hash. That address and
# hash only exist after a deployment, so they cannot be written into a Compose
# file ahead of time. This runs once, then hands the values to the API through a
# shared file.
#
# Local end-to-end runs must never point at the deployed production registry.
# Anchoring test proofs there would write to the real proof stream.

set -eu

rpc_url=${E2E_RPC_URL:?E2E_RPC_URL is required}
out_file=${REGISTRY_ENV_FILE:-/run/reviewroom-chain/chain.env}
chain_id=${E2E_CHAIN_ID:-31337}
deployment_id=${E2E_DEPLOYMENT_ID:-local-canonical-v2}

echo "waiting for the local chain at $rpc_url"
attempt=0
until cast chain-id --rpc-url "$rpc_url" >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    echo "local chain did not answer after 60 attempts" >&2
    exit 1
  fi
  sleep 1
done

actual_chain_id=$(cast chain-id --rpc-url "$rpc_url")
if [ "$actual_chain_id" != "$chain_id" ]; then
  echo "chain id is $actual_chain_id, expected $chain_id" >&2
  exit 1
fi

# The attester key is generated per run and funded from the disposable chain, so
# no private key is committed and no shared key is reused between runs. Read the
# JSON form: the human-readable output goes to stderr and would be parsed from
# whatever else landed there. Nothing here echoes the key.
wallet=$(cast wallet new --json)
attester_key=$(
  printf '%s' "$wallet" | sed -n 's/.*"private_key":"\([^"]*\)".*/\1/p'
)
attester_address=$(
  printf '%s' "$wallet" | sed -n 's/.*"address":"\([^"]*\)".*/\1/p'
)
[ -n "$attester_key" ] && [ -n "$attester_address" ] || {
  echo "could not generate an attester key" >&2
  exit 1
}
cast rpc --rpc-url "$rpc_url" anvil_setBalance "$attester_address" 0xde0b6b3a7640000 >/dev/null

# Deploy the already-compiled artifact instead of calling `forge create`, which
# recompiles and writes into the contracts directory. That directory is mounted
# read-only so an end-to-end run cannot modify the checkout it was given.
artifact=${REGISTRY_ARTIFACT:-out/ReviewProofRegistryV2.sol/ReviewProofRegistryV2.json}
[ -r "$artifact" ] || {
  echo "missing $artifact; run 'npm run build:contracts' first" >&2
  exit 1
}
bytecode=$(sed -n 's/.*"bytecode":{"object":"\(0x[^"]*\)".*/\1/p' "$artifact")
[ -n "$bytecode" ] || {
  echo "could not read creation bytecode from $artifact" >&2
  exit 1
}
constructor_args=$(
  cast abi-encode 'constructor(address)' "$attester_address" | sed 's/^0x//'
)

echo "deploying ReviewProofRegistryV2 as $attester_address"
deploy_output=$(
  cast send --json \
    --rpc-url "$rpc_url" \
    --private-key "$attester_key" \
    --create "${bytecode}${constructor_args}"
)
registry_address=$(
  printf '%s' "$deploy_output" | sed -n 's/.*"contractAddress":"\([^"]*\)".*/\1/p'
)
[ -n "$registry_address" ] && [ "$registry_address" != "null" ] || {
  echo "deployment did not report an address" >&2
  exit 1
}

# The API refuses to start unless the attester is allowed and the registry is
# unpaused, so authorize the key this run just created.
cast send "$registry_address" 'setAttester(address,bool)' "$attester_address" true \
  --rpc-url "$rpc_url" --private-key "$attester_key" >/dev/null

runtime_code=$(cast code "$registry_address" --rpc-url "$rpc_url")
[ -n "$runtime_code" ] && [ "$runtime_code" != "0x" ] || {
  echo "registry has no runtime code" >&2
  exit 1
}
code_hash=$(cast keccak "$runtime_code")
deployment_block=$(cast block-number --rpc-url "$rpc_url")

mkdir -p "$(dirname "$out_file")"
cat > "$out_file" <<EOF
CHAIN_RPC_URL=$rpc_url
CHAIN_ID=$chain_id
REVIEW_PROOF_REGISTRY_ADDRESS=$registry_address
REVIEW_PROOF_REGISTRY_CODE_HASH=$code_hash
REVIEW_PROOF_REGISTRY_DEPLOYMENT_ID=$deployment_id
REVIEW_PROOF_REGISTRY_DEPLOYMENT_BLOCK=$deployment_block
ANCHOR_PRIVATE_KEY=$attester_key
EOF

echo "registry $registry_address at block $deployment_block"
echo "wrote $out_file"
