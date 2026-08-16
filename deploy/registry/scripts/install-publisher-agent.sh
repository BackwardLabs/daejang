#!/bin/bash

set -Eeuo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
registry_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
template=$registry_dir/launchd/com.backwardlabs.daejang-image-publisher.plist.in
cleaner_template=$registry_dir/launchd/com.backwardlabs.daejang-image-cleaner.plist.in
label=com.backwardlabs.daejang-image-publisher
cleaner_label=com.backwardlabs.daejang-image-cleaner
user_id=$(id -u)
user_name=$(id -un)
user_home=$(dscl . -read "/Users/$user_name" NFSHomeDirectory | awk '{print $2}')
agent_dir=$user_home/Library/LaunchAgents
agent_file=$agent_dir/$label.plist
cleaner_agent_file=$agent_dir/$cleaner_label.plist
state_dir=/Users/Shared/DaejangRegistry/publisher
log_dir=/Users/Shared/DaejangRegistry/logs
publisher_script=$script_dir/publish-main-images.sh
cleaner_script=$script_dir/cleanup-images.sh
gh_config_dir=$user_home/.config/gh
docker_config=$user_home/.docker
cron_begin='# BEGIN DAEJANG IMAGE PUBLISHER'
cron_end='# END DAEJANG IMAGE PUBLISHER'
scheduler_file=$state_dir/scheduler
publisher_path=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/Applications/Docker.app/Contents/Resources/bin

escape_sed() {
  printf '%s' "$1" | sed 's/[&|]/\\&/g'
}

for required_path in "$template" "$cleaner_template" "$publisher_script" "$cleaner_script" "$gh_config_dir" "$docker_config"; do
  if [ ! -e "$required_path" ]; then
    echo "Required path does not exist: $required_path" >&2
    exit 2
  fi
done

mkdir -p -m 700 "$agent_dir" "$state_dir" "$log_dir"
agent_tmp=$(mktemp "$agent_dir/.$label.plist.XXXXXX")
cleaner_agent_tmp=$(mktemp "$agent_dir/.$cleaner_label.plist.XXXXXX")
trap 'find "$agent_tmp" "$cleaner_agent_tmp" -delete 2>/dev/null || true' EXIT HUP INT TERM

sed \
  -e "s|@PUBLISHER_SCRIPT@|$(escape_sed "$publisher_script")|g" \
  -e "s|@REGISTRY_DIR@|$(escape_sed "$registry_dir")|g" \
  -e "s|@GH_CONFIG_DIR@|$(escape_sed "$gh_config_dir")|g" \
  -e "s|@DOCKER_CONFIG@|$(escape_sed "$docker_config")|g" \
  -e "s|@STATE_DIR@|$(escape_sed "$state_dir")|g" \
  -e "s|@LOG_DIR@|$(escape_sed "$log_dir")|g" \
  "$template" > "$agent_tmp"

sed \
  -e "s|@CLEANER_SCRIPT@|$(escape_sed "$cleaner_script")|g" \
  -e "s|@REGISTRY_DIR@|$(escape_sed "$registry_dir")|g" \
  -e "s|@DOCKER_CONFIG@|$(escape_sed "$docker_config")|g" \
  -e "s|@STATE_DIR@|$(escape_sed "$state_dir")|g" \
  -e "s|@LOG_DIR@|$(escape_sed "$log_dir")|g" \
  "$cleaner_template" > "$cleaner_agent_tmp"

plutil -lint "$agent_tmp" >/dev/null
plutil -lint "$cleaner_agent_tmp" >/dev/null
chmod 600 "$agent_tmp" "$cleaner_agent_tmp"
mv "$agent_tmp" "$agent_file"
mv "$cleaner_agent_tmp" "$cleaner_agent_file"
trap - EXIT HUP INT TERM

launchctl bootout "user/$user_id/$label" 2>/dev/null || true
launchctl bootout "user/$user_id/$cleaner_label" 2>/dev/null || true
if launchctl bootstrap "user/$user_id" "$agent_file" 2>/dev/null && \
  launchctl bootstrap "user/$user_id" "$cleaner_agent_file" 2>/dev/null; then
  launchctl enable "user/$user_id/$label"
  launchctl enable "user/$user_id/$cleaner_label"
  launchctl kickstart -k "user/$user_id/$label"
  printf '%s\n' launchd > "$scheduler_file"
  chmod 600 "$scheduler_file"
  echo "Installed $label and $cleaner_label with launchd for $user_name."
  echo "Agents: $agent_file, $cleaner_agent_file"
else
  # Remote/background macOS sessions do not expose a GUI bootstrap domain.
  # A user crontab provides the same two-minute schedule without root access.
  launchctl bootout "user/$user_id/$label" 2>/dev/null || true
  launchctl bootout "user/$user_id/$cleaner_label" 2>/dev/null || true
  find "$agent_file" "$cleaner_agent_file" -delete
  cron_dir=$(mktemp -d "$state_dir/.cron.XXXXXX")
  cron_current=$cron_dir/current
  cron_filtered=$cron_dir/filtered
  cron_next=$cron_dir/next
  if ! crontab -l > "$cron_current" 2>/dev/null; then
    : > "$cron_current"
  fi
  awk -v begin="$cron_begin" -v end="$cron_end" '
    $0 == begin { skip = 1; next }
    $0 == end { skip = 0; next }
    !skip { print }
  ' "$cron_current" > "$cron_filtered"
  {
    cat "$cron_filtered"
    printf '%s\n' "$cron_begin"
    printf '%s\n' "*/2 * * * * /usr/bin/env PATH='$publisher_path' GH_CONFIG_DIR='$gh_config_dir' DOCKER_CONFIG='$docker_config' DAEJANG_PUBLISHER_STATE_DIR='$state_dir' '$publisher_script' >> '$log_dir/publisher.stdout.log' 2>> '$log_dir/publisher.stderr.log'"
    printf '%s\n' "15 4 * * * /usr/bin/env PATH='$publisher_path' DOCKER_CONFIG='$docker_config' DAEJANG_PUBLISHER_STATE_DIR='$state_dir' '$cleaner_script' >> '$log_dir/cleaner.stdout.log' 2>> '$log_dir/cleaner.stderr.log'"
    printf '%s\n' "$cron_end"
  } > "$cron_next"
  crontab "$cron_next"
  find "$cron_dir" -depth -delete
  printf '%s\n' cron > "$scheduler_file"
  chmod 600 "$scheduler_file"
  echo "Installed $label and daily image cleanup with the user crontab for $user_name."
  echo "launchd was unavailable in the current macOS Background session."
fi

echo "State: $state_dir/state.json"
echo "Logs:  $log_dir/publisher.stdout.log"
