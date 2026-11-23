#!/usr/bin/env bash
# cc-slack-hook <kind>: Claude Code hooks -> one Slack ping, laid out by cc-slack-card. Reads the hook's
# JSON on stdin.
#
#   stash    remember what is being asked (PermissionRequest; PreToolUse on AskUserQuestion). Sends nothing:
#            Claude Code's own Notification fires a few seconds later, only if nobody answered at the keyboard,
#            and that notification carries no detail, so the detail is kept here for it.
#   notify   always ping (Notification: permission_prompt, elicitation_dialog, agent_needs_input)
#   idle     ping ONCE per idle stretch (Notification: idle_prompt, which repeats about every minute)
#   clear    the question was answered (PostToolUse on AskUserQuestion): forget it
#   reset    the developer typed something (UserPromptSubmit): forget everything, the next idle may ping again
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
mkdir -p "$dir"
chmod 700 "$dir"

case $kind in
stash)
  printf '%s\n' "$payload" >"$pending"
  exit 0
  ;;
clear)
  rm -f "$pending"
  exit 0
  ;;
reset)
  rm -f "$pending" "$marker"
  exit 0
  ;;
idle)
  [ -e "$marker" ] && exit 0
  ;;
notify) ;;
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
done <<<"$cards"

if [ "$kind" = idle ]; then
  : >"$marker"
fi
