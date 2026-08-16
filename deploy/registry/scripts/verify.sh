#!/bin/sh

set -eu

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <env-file> <local|tailnet>" >&2
  exit 2
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=load-env.sh
. "$script_dir/load-env.sh" "$1"
# shellcheck source=tailscale-common.sh
. "$script_dir/tailscale-common.sh"
mode=$2

case "$mode" in
  local) endpoint="http://127.0.0.1:$REGISTRY_LOOPBACK_PORT/v2/" ;;
  tailnet)
    tailscale_cli=$(find_tailscale_cli)
    registry_host=$(tailscale_dns_name "$tailscale_cli")
    endpoint="https://$registry_host/v2/"
    ;;
  *) echo "Mode must be local or tailnet." >&2; exit 2 ;;
esac

headers_file=$(mktemp)
trap 'rm -f "$headers_file"' EXIT HUP INT TERM

status=$(curl --silent --show-error --output /dev/null --dump-header "$headers_file" \
  --write-out '%{http_code}' --max-time 15 "$endpoint" || true)

if [ "$status" != "401" ]; then
  echo "Expected unauthenticated HTTP 401 from $endpoint, got ${status:-no response}." >&2
  exit 1
fi

if ! grep -Eiq '^Www-Authenticate: Basic realm="Daejang Registry"' "$headers_file"; then
  echo "The Registry did not return the expected Basic authentication challenge." >&2
  exit 1
fi

echo "OK: $endpoint is reachable and rejects unauthenticated requests."
if [ "$mode" = tailnet ]; then
  echo "Next client check: docker login $registry_host"
fi
