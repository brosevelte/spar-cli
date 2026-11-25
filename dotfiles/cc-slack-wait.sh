#!/usr/bin/env bash
# cc-slack-wait <channel id> <message ts> [timeout seconds]: block until the developer replies in the
# thread under a message cc-slack sent, then print the reply text and exit 0.
#
#   read -r channel ts < <(cc-slack-card --ref < card.json)
#   cc-slack-wait "$channel" "$ts"            # run in the background: its exit wakes the session
#
# A reply counts only if a person wrote it (no bot_id) and, when the target is a member ID (U...), only
# if that member wrote it: the reply becomes an instruction to an agent, so nobody else's text is taken.
# Several replies arriving together are printed in order, one per line.
#
# Exit codes: 0 a reply was printed; 3 timed out with no reply (default 12 hours); 1 Slack refused the
# call (the response is printed; `missing_scope` means the bot lacks im:history, or channels:history /
# groups:history for a channel target); 2 bad usage.
# Needs the bot scope im:history for a DM target.
set -euo pipefail

channel=${1:?usage: cc-slack-wait <channel id> <message ts> [timeout seconds]}
ts=${2:?usage: cc-slack-wait <channel id> <message ts> [timeout seconds]}
timeout=${3:-43200}
interval=${CC_SLACK_WAIT_INTERVAL:-5}

target=${CC_SLACK_TARGET:-}
if [ -z "$target" ] && [ -r "$HOME/.config/claude-notify/target" ]; then
  target=$(tr -d '[:space:]' <"$HOME/.config/claude-notify/target")
fi

deadline=$(($(date +%s) + timeout))
while :; do
  out=$("$HOME/.local/bin/cc-slack" --api conversations.replies -G \
    --data-urlencode "channel=$channel" --data-urlencode "ts=$ts" --data-urlencode "limit=50")
  if [ "$(jq -r '.ok' <<<"$out")" != true ]; then
    echo "cc-slack-wait: conversations.replies failed: $out" >&2
    exit 1
  fi
  reply=$(jq -r --arg ts "$ts" --arg target "$target" '
    [ .messages[]
      | select(.ts != $ts and (.bot_id // "") == "")
      | select(($target | startswith("U") | not) or .user == $target)
      | .text ] | join("\n")' <<<"$out")
  if [ -n "$reply" ]; then
    printf '%s\n' "$reply"
    exit 0
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "cc-slack-wait: no reply within ${timeout}s" >&2
    exit 3
  fi
  sleep "$interval"
done
