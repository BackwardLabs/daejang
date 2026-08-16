#!/bin/bash

set -Eeuo pipefail

label=com.backwardlabs.daejang-image-publisher
cleaner_label=com.backwardlabs.daejang-image-cleaner
user_id=$(id -u)
state_file=${DAEJANG_PUBLISHER_STATE_DIR:-/Users/Shared/DaejangRegistry/publisher}/state.json
scheduler_file=${DAEJANG_PUBLISHER_STATE_DIR:-/Users/Shared/DaejangRegistry/publisher}/scheduler
cron_begin='# BEGIN DAEJANG IMAGE PUBLISHER'

if launchctl print "user/$user_id/$label" 2>/dev/null; then
  :
elif crontab -l 2>/dev/null | grep -Fqx "$cron_begin"; then
  echo "$label is scheduled by the user crontab every two minutes."
else
  echo "$label is not loaded or present in the user crontab." >&2
  exit 1
fi
if [ -s "$scheduler_file" ]; then
  echo "Scheduler: $(sed -n '1p' "$scheduler_file")"
fi
if launchctl print "user/$user_id/$cleaner_label" >/dev/null 2>&1; then
  echo "$cleaner_label runs every day at 04:15."
elif crontab -l 2>/dev/null | grep -Fq "15 4 * * *"; then
  echo "$cleaner_label runs every day at 04:15 from the user crontab."
else
  echo "$cleaner_label is not scheduled." >&2
  exit 1
fi
if [ -s "$state_file" ]; then
  echo
  jq '{schemaVersion, repositories}' "$state_file"
fi
