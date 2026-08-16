#!/bin/sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=load-env.sh
. "$script_dir/load-env.sh" "${1:-.env}"
# shellcheck source=tailscale-common.sh
. "$script_dir/tailscale-common.sh"

tailscale_cli=$(find_tailscale_cli)
dns_name=$(tailscale_dns_name "$tailscale_cli")
target="http://127.0.0.1:$REGISTRY_LOOPBACK_PORT"
serve_status=$("$tailscale_cli" serve status --json)

if printf '%s' "$serve_status" | jq -e 'length > 0' >/dev/null; then
  if printf '%s' "$serve_status" | grep -Fq "$target"; then
    echo "Tailscale Serve is already connected: https://$dns_name"
    exit 0
  fi

  echo "Tailscale Serve already has another configuration; refusing to overwrite it." >&2
  "$tailscale_cli" serve status >&2
  exit 2
fi

"$tailscale_cli" serve --bg --https=443 "$target"

echo "Registry endpoint: https://$dns_name"
echo "Client login: docker login $dns_name"
