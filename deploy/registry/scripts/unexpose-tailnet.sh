#!/bin/sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=load-env.sh
. "$script_dir/load-env.sh" "${1:-.env}"
# shellcheck source=tailscale-common.sh
. "$script_dir/tailscale-common.sh"

tailscale_cli=$(find_tailscale_cli)
target="http://127.0.0.1:$REGISTRY_LOOPBACK_PORT"
serve_status=$("$tailscale_cli" serve status --json)

if ! printf '%s' "$serve_status" | jq -e 'length > 0' >/dev/null; then
  exit 0
fi

if ! printf '%s' "$serve_status" | grep -Fq "$target"; then
  echo "Tailscale Serve is owned by another service; leaving it unchanged." >&2
  exit 2
fi

"$tailscale_cli" serve --https=443 off
echo "Tailscale Registry endpoint is disabled."
