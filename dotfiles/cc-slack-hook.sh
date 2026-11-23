#!/usr/bin/env bash
# cc-slack-hook <kind>: Claude Code hooks -> one Slack ping, laid out by cc-slack-card. Reads the hook's
# JSON on stdin.
#
#   stash    remember what is being asked (PermissionRequest; PreToolUse on AskUserQuestion). Sends nothing:
#            Claude Code's own Notification fires a few seconds later, only if nobody answered at the keyboard,
#            and that notification carries no detail, so the detail is kept here for it.
#   notify   ping ONCE per request (Notification: permission_prompt, elicitation_dialog, agent_needs_input)
#   idle     ping ONCE per message the developer typed (Notification: idle_prompt, which repeats about every
#            minute, and again after every wake by a background agent)
#   clear    the question was answered (PostToolUse on AskUserQuestion): forget it
#   reset    a prompt was submitted, by the developer or by a wake (UserPromptSubmit): forget the pending request
#
# State: per-session files in ~/.cache/claude-notify/ (<session>.pending = the stashed hook payload,
# <session>.idle = "already pinged for this idle stretch"). The idle marker is written only after the ping
# is accepted, so a failed send is retried on the next idle notification.
set -euo pipefail

kind=${1:?usage: cc-slack-hook stash|notify|idle|clear|reset}
payload=$(cat)
session=$(jq -r '.session_id // "unknown"' <<<"$payload")
dir="${XDG_CACHE_HOME:-$HOME/.cache}/claude-notify"
pending="$dir/$session.pending"
marker="$dir/$session.idle"
asked="$dir/$session.asked"
mkdir -p "$dir"
chmod 700 "$dir"

# Every send and every dropped repeat is logged, so "what is pinging me?" is answered by reading
# ~/.cache/claude-notify/sent.log, not by guessing.
log() { printf '%s %s %s %s\n' "$(date '+%F %T')" "${session:0:8}" "$kind" "$*" >>"$dir/sent.log"; }

case $kind in
stash)
  # A new request: it may ping even if the last one already did.
  printf '%s\n' "$payload" >"$pending"
  rm -f "$asked"
  exit 0
  ;;
clear)
  rm -f "$pending" "$asked"
  exit 0
  ;;
reset)
  # UserPromptSubmit also fires when a background agent or task wakes the session, so it must not
  # re-arm the idle ping: `idle` decides that itself from who typed last.
  rm -f "$pending" "$asked"
  exit 0
  ;;
idle)
  # One idle ping per message the developer typed. An orchestrator session is woken by its own agents
  # all night and goes idle after each wake; those are not new reasons to ping. The transcript marks
  # each prompt's origin, so compare the last human-typed prompt with the one we last pinged for.
  transcript=$(jq -r '.transcript_path // ""' <<<"$payload")
  last_human=""
  if [ -n "$transcript" ] && [ -r "$transcript" ]; then
    last_human=$(grep -F '"origin":{"kind":"human"' "$transcript" | tail -n 1 |
      jq -r 'select(.origin.kind == "human") | .promptId // .timestamp // ""')
  fi
  if [ -e "$marker" ] && [ "$(cat "$marker")" = "$last_human" ]; then
    log "dropped: already pinged since the developer last typed"
    exit 0
  fi
  ;;
notify)
  # Claude Code can repeat its notification while the same prompt waits. One ping per request: after a
  # send, stay quiet until a new request is stashed, the developer types, or 30 minutes pass.
  if [ -n "$(find "$asked" -mmin -30 2>/dev/null)" ]; then
    log "dropped: already pinged for this request"
    exit 0
  fi
  ;;
*)
  echo "cc-slack-hook: unknown kind '$kind' (stash|notify|idle|clear|reset)" >&2
  exit 2
  ;;
esac

transcript=$(jq -r '.transcript_path // ""' <<<"$payload")

# Cards, one JSON object per line: the stashed request if there is a recent one (2 minutes), one card per
# question; else Claude Code's own notification text.
cards=""
if [ -n "$(find "$pending" -mmin -2 2>/dev/null)" ]; then
  cards=$(jq -c --arg transcript "$transcript" '
    if .tool_name == "AskUserQuestion" then
      .tool_input.questions[]
      | {icon: ":question:", title: (.header // "Question"), question: .question,
         options: [.options[]? | .label + (if (.description // "") != "" then ": " + .description else "" end)],
         transcript_path: $transcript}
    else
      {icon: ":lock:", title: ("Permission needed: " + (.tool_name // "a tool")),
       code: (.tool_input.command // .tool_input.file_path // (.tool_input | tojson)),
       detail: (.tool_input.description // ""), transcript_path: $transcript}
    end' "$pending")
  rm -f "$pending"
fi
if [ -z "$cards" ]; then
  icon=":bell:"
  [ "$kind" = idle ] && icon=":hourglass_flowing_sand:"
  cards=$(jq -c --arg icon "$icon" --arg transcript "$transcript" \
    '{icon: $icon, title: (.message // "Claude is waiting for your input"), transcript_path: $transcript}' <<<"$payload")
fi

while IFS= read -r card; do
  printf '%s\n' "$card" | "$HOME/.local/bin/cc-slack-card"
  log "sent: $(jq -r '.title' <<<"$card")"
done <<<"$cards"

if [ "$kind" = idle ]; then
  printf '%s' "$last_human" >"$marker"
else
  : >"$asked"
fi
