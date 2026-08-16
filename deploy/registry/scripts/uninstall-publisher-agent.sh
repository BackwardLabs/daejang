#!/bin/bash

set -Eeuo pipefail

label=com.backwardlabs.daejang-image-publisher
cleaner_label=com.backwardlabs.daejang-image-cleaner
user_id=$(id -u)
user_name=$(id -un)
user_home=$(dscl . -read "/Users/$user_name" NFSHomeDirectory | awk '{print $2}')
agent_file=$user_home/Library/LaunchAgents/$label.plist
cleaner_agent_file=$user_home/Library/LaunchAgents/$cleaner_label.plist
state_dir=/Users/Shared/DaejangRegistry/publisher
cron_begin='# BEGIN DAEJANG IMAGE PUBLISHER'
cron_end='# END DAEJANG IMAGE PUBLISHER'

launchctl bootout "user/$user_id/$label" 2>/dev/null || true
launchctl bootout "user/$user_id/$cleaner_label" 2>/dev/null || true
for file in "$agent_file" "$cleaner_agent_file"; do
  if [ -f "$file" ]; then
    find "$file" -delete
  fi
done
cron_dir=$(mktemp -d /tmp/daejang-publisher-cron-remove.XXXXXX)
cron_current=$cron_dir/current
cron_next=$cron_dir/next
if crontab -l > "$cron_current" 2>/dev/null; then
  awk -v begin="$cron_begin" -v end="$cron_end" '
    $0 == begin { skip = 1; next }
    $0 == end { skip = 0; next }
    !skip { print }
  ' "$cron_current" > "$cron_next"
  crontab "$cron_next"
fi
find "$cron_dir" -depth -delete
if [ -f "$state_dir/scheduler" ]; then
  find "$state_dir/scheduler" -delete
fi
echo "Uninstalled $label and $cleaner_label. State and logs were retained."
