#!/bin/sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=load-env.sh
. "$script_dir/load-env.sh" "${1:-.env}"
# shellcheck source=tailscale-common.sh
. "$script_dir/tailscale-common.sh"

if [ ! -t 0 ]; then
  echo "Registry login requires an interactive terminal." >&2
  exit 2
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required to update Docker's client configuration." >&2
  exit 2
fi

tailscale_cli=$(find_tailscale_cli)
registry_host=$(tailscale_dns_name "$tailscale_cli")

printf 'Registry username: ' >&2
IFS= read -r registry_username
case "$registry_username" in
  ''|*[!A-Za-z0-9._-]*)
    echo "Username may contain only letters, numbers, dot, underscore, and hyphen." >&2
    exit 2
    ;;
esac

terminal_state=$(stty -g)
terminal_locked=0
password=

cleanup() {
  if [ "$terminal_locked" -eq 1 ]; then
    stty "$terminal_state"
  fi
  password=
  auth_value=
}
trap cleanup EXIT HUP INT TERM

printf 'Password: ' >&2
stty -echo
terminal_locked=1
IFS= read -r password
stty "$terminal_state"
terminal_locked=0
printf '\n' >&2

if [ -z "$password" ]; then
  echo "Password must not be empty." >&2
  exit 2
fi

auth_value=$(printf '%s' "$registry_username:$password" | base64 | tr -d '\n')
password=

http_code=$(
  printf 'header = "Authorization: Basic %s"\n' "$auth_value" |
    curl --config - --silent --show-error --output /dev/null \
      --write-out '%{http_code}' --max-time 15 \
      "https://$registry_host/v2/"
)

if [ "$http_code" != 200 ]; then
  echo "Registry authentication failed (HTTP $http_code). Credentials were not saved." >&2
  exit 1
fi

docker_config_dir=${DOCKER_CONFIG:-$HOME/.docker}
docker_config_file=$docker_config_dir/config.json
mkdir -p "$docker_config_dir"
chmod 700 "$docker_config_dir"
next_file=$(mktemp "$docker_config_dir/.config.json.XXXXXX")
trap 'cleanup; rm -f "$next_file"' EXIT HUP INT TERM

if [ -s "$docker_config_file" ]; then
  if ! jq empty "$docker_config_file" >/dev/null 2>&1; then
    echo "$docker_config_file is not valid JSON; refusing to overwrite it." >&2
    exit 1
  fi
  jq --arg host "$registry_host" --arg auth "$auth_value" \
    '(.auths //= {}) | .auths[$host] = {auth: $auth}' \
    "$docker_config_file" > "$next_file"
else
  jq -n --arg host "$registry_host" --arg auth "$auth_value" \
    '{auths: {($host): {auth: $auth}}}' > "$next_file"
fi

auth_value=
chmod 600 "$next_file"
mv "$next_file" "$docker_config_file"

echo "Registry credentials verified and saved for $registry_host."
echo "Docker config: $docker_config_file (mode 600)"
