#!/bin/sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=load-env.sh
. "$script_dir/load-env.sh" "${1:-.env}"
# shellcheck source=tailscale-common.sh
. "$script_dir/tailscale-common.sh"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required to update Docker's client configuration." >&2
  exit 2
fi

tailscale_cli=$(find_tailscale_cli)
registry_host=$(tailscale_dns_name "$tailscale_cli")
docker_config_dir=${DOCKER_CONFIG:-$HOME/.docker}
docker_config_file=$docker_config_dir/config.json

if [ ! -s "$docker_config_file" ]; then
  echo "No Docker client configuration exists for the current user."
  exit 0
fi

next_file=$(mktemp "$docker_config_dir/.config.json.XXXXXX")
trap 'rm -f "$next_file"' EXIT HUP INT TERM

jq --arg host "$registry_host" 'del(.auths[$host])' \
  "$docker_config_file" > "$next_file"
chmod 600 "$next_file"
mv "$next_file" "$docker_config_file"

echo "Removed Registry credentials for $registry_host."
