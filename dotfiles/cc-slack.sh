#!/usr/bin/env bash
# cc-slack: post a message to Slack as the team's "Claude Code" bot. Installed on the Mac and the box
# by `spark auth slack` (and `spark sync dotfiles`); called by Claude Code's Notification hook and by
# agents directly ("stepping away, send questions over Slack").
#
#   cc-slack "message"            # or pipe it: echo hi | cc-slack
#   cc-slack --check              # auth.test only: is the token live? exits 1 if not
#
# Token, first hit wins:
#   $CC_SLACK_TOKEN
#   macOS: the login Keychain, service "spar-cli-slack" (written by `spark auth slack`)
#   ~/.config/claude-notify/token (chmod 600). This is the box's store: its GNOME keyring only unlocks
#   at a graphical login, so over ssh it is locked and a lookup hangs on an invisible dialog (the same
#   reason dotfiles/gh-wrapper.sh hides it from gh).
# Target (a user ID U... for a DM, or a channel ID C... the bot was invited to):
#   $CC_SLACK_TARGET, else ~/.config/claude-notify/target.
#
# The token goes to curl on stdin (--config -), never on argv, so it doesn't show in `ps`.
set -euo pipefail

KEYCHAIN_SERVICE=spar-cli-slack
DIR="$HOME/.config/claude-notify"

token=${CC_SLACK_TOKEN:-}
if [ -z "$token" ] && [ "$(uname)" = Darwin ]; then
  token=$(security find-generic-password -s "$KEYCHAIN_SERVICE" -w 2>/dev/null || true)
fi
if [ -z "$token" ] && [ -r "$DIR/token" ]; then
  token=$(tr -d '[:space:]' <"$DIR/token")
fi
if [ -z "$token" ]; then
  echo "cc-slack: no token (run \`spark auth slack\` on the Mac)" >&2
  exit 2
fi

api() { # api <method> [curl args...]
  local method=$1
  shift
  printf 'header = "Authorization: Bearer %s"\n' "$token" |
    curl -sS --max-time 15 --config - "$@" "https://slack.com/api/$method"
}

if [ "${1:-}" = --check ]; then
  out=$(api auth.test -X POST)
  case $out in
  *'"ok":true'*)
    echo "cc-slack: token live ($(printf '%s' "$out" | sed -n 's/.*"user":"\([^"]*\)".*/bot \1/p'))"
    exit 0
    ;;
  *)
    echo "cc-slack: auth.test failed: $out" >&2
    exit 1
    ;;
  esac
fi

target=${CC_SLACK_TARGET:-}
if [ -z "$target" ] && [ -r "$DIR/target" ]; then
  target=$(tr -d '[:space:]' <"$DIR/target")
fi
if [ -z "$target" ]; then
  echo "cc-slack: no target (set CC_SLACK_TARGET, or \`spark auth slack --target U...\`)" >&2
  exit 2
fi

if [ $# -gt 0 ]; then text="$*"; else text=$(cat); fi
[ -n "$text" ] || { echo "cc-slack: empty message" >&2; exit 2; }

# $CC_SLACK_BLOCKS: optional Block Kit JSON array (cc-slack-card sets it). The text is then the fallback
# that phone push notifications show.
args=(--data-urlencode "channel=$target" --data-urlencode "text=$text")
if [ -n "${CC_SLACK_BLOCKS:-}" ]; then
  args+=(--data-urlencode "blocks=$CC_SLACK_BLOCKS")
fi
out=$(api chat.postMessage "${args[@]}")
case $out in
*'"ok":true'*) exit 0 ;;
*)
  echo "cc-slack: chat.postMessage failed: $out" >&2
  exit 1
  ;;
esac
