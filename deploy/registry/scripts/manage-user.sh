#!/bin/sh

set -eu

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <env-file> <username>" >&2
  exit 2
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=load-env.sh
. "$script_dir/load-env.sh" "$1"
username=$2
runtime_group=$(id -gn)

case "$username" in
  ''|*[!A-Za-z0-9._-]*)
    echo "Username may contain only letters, numbers, dot, underscore, and hyphen." >&2
    exit 2
    ;;
esac

mkdir -p "$REGISTRY_AUTH_DIR"
chgrp "$runtime_group" "$REGISTRY_AUTH_DIR"
chmod 750 "$REGISTRY_AUTH_DIR"
touch "$REGISTRY_AUTH_DIR/htpasswd"
chgrp "$runtime_group" "$REGISTRY_AUTH_DIR/htpasswd"
chmod 640 "$REGISTRY_AUTH_DIR/htpasswd"

if [ ! -t 0 ]; then
  echo "Password input requires an interactive terminal." >&2
  exit 2
fi

entry_file=$(mktemp "$REGISTRY_AUTH_DIR/.htpasswd-entry.XXXXXX")
next_file=$(mktemp "$REGISTRY_AUTH_DIR/.htpasswd-next.XXXXXX")
terminal_state=$(stty -g)
terminal_locked=0

cleanup() {
  if [ "$terminal_locked" -eq 1 ]; then
    stty "$terminal_state"
  fi
  rm -f "$entry_file" "$next_file"
}
trap cleanup EXIT HUP INT TERM

echo "Enter the password twice. The plaintext password is not saved."
printf 'New password: ' >&2
stty -echo
terminal_locked=1
IFS= read -r password_one
printf '\nRepeat password: ' >&2
IFS= read -r password_two
stty "$terminal_state"
terminal_locked=0
printf '\n' >&2

if [ -z "$password_one" ]; then
  echo "Password must not be empty." >&2
  exit 2
fi

if [ "$password_one" != "$password_two" ]; then
  echo "Passwords do not match." >&2
  exit 2
fi

printf '%s\n' "$password_one" | docker run --rm -i \
  --entrypoint htpasswd \
  httpd:2.4-alpine \
  -Bin "$username" > "$entry_file"
password_one=
password_two=

if ! grep -Eq "^${username}:\\\$2[aby]\\\$" "$entry_file"; then
  echo "Failed to generate a bcrypt htpasswd entry." >&2
  exit 1
fi

awk -F: -v user="$username" '$1 != user && NF > 1' \
  "$REGISTRY_AUTH_DIR/htpasswd" > "$next_file"
sed -n '/[^[:space:]]/p' "$entry_file" >> "$next_file"

chgrp "$runtime_group" "$next_file"
chmod 640 "$next_file"
mv "$next_file" "$REGISTRY_AUTH_DIR/htpasswd"

chmod 640 "$REGISTRY_AUTH_DIR/htpasswd"

if docker-compose --env-file "$1" -f "$script_dir/../compose.yaml" ps --status running registry 2>/dev/null | grep -q registry; then
  docker-compose --env-file "$1" -f "$script_dir/../compose.yaml" restart registry
fi

echo "Registry user '$username' is ready."
