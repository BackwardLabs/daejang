#!/bin/sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=load-env.sh
. "$script_dir/load-env.sh" "${1:-.env}"
# shellcheck source=tailscale-common.sh
. "$script_dir/tailscale-common.sh"

tailscale_cli=$(find_tailscale_cli)
"$tailscale_cli" serve status
