#!/usr/bin/env bash
# cc-slack-hook <kind>: Claude Code hooks -> one Slack ping, laid out by cc-slack-card. Reads the hook's
# JSON on stdin.
#
#   stash    remember what is being asked (PermissionRequest; PreToolUse on AskUserQuestion). Sends nothing:
#            Claude Code's own Notification fires a few seconds later, only if nobody answered at the keyboard,
#            and that notification carries no detail, so the detail is kept here for it.
#   ask      PermissionRequest: stash, then wait for a Slack thread reply and answer the prompt with it
#   notify   ping ONCE per request (Notification: permission_prompt, elicitation_dialog, agent_needs_input)
#   idle     ping ONCE per message the developer typed (Notification: idle_prompt, which repeats about every
#            minute, and again after every wake by a background agent)
#   clear    a tool ran (PostToolUse, every tool): its request is answered, stop any hook waiting on it
#   reset    a prompt was submitted, by the developer or by a wake (UserPromptSubmit): forget the pending request
#
# State: per-session files in ~/.cache/claude-notify/ (<session>.pending = the stashed hook payload,
# <session>.idle = "already pinged for this idle stretch"). The idle marker is written only after the ping
# is accepted, so a failed send is retried on the next idle notification.
set -euo pipefail

kind=${1:?usage: cc-slack-hook stash|ask|notify|idle|clear|reset}
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
# One permission request's id: the same request hashed by `ask` (from its own payload) and by `notify`
# (from the stashed copy), so the card's thread reference reaches the hook that is waiting on it.
reqid() { jq -cS '{tool_name, tool_input}' | sha1sum | cut -c1-12; }

log() { printf '%s %s %s %s\n' "$(date '+%F %T')" "${session:0:8}" "$kind" "$*" >>"$dir/sent.log"; }

case $kind in
stash)
  # A new request: it may ping even if the last one already did.
  printf '%s\n' "$payload" >"$pending"
  rm -f "$asked"
  exit 0
  ;;
ask)
  # PermissionRequest: stash the request like `stash`, then stay alive so a Slack thread reply can answer
  # the prompt. Nothing is sent from here: Claude Code's Notification fires about 6 seconds later if
  # nobody answered at the keyboard, `notify` sends the card and writes its thread reference to
  # <session>.<request id>.ref, and this hook then waits on that thread.
  #   yes / y / ok / approve / allow  -> allow
  #   no / n / deny / reject / stop   -> deny
  #   anything else                   -> deny, with the reply passed to Claude as the reason
  # No reply, or Slack cannot be read: exit with no output, which is no decision, so the prompt simply
  # stays where it is at the keyboard. The reason goes to sent.log.
  #
  # Claude Code does not stop this hook when the prompt is answered at the keyboard, so `clear` (the
  # tool ran) and `reset` (a new prompt) drop a .cancel file next to this request's .wait file, and the
  # loops below stop on it. Without that, every keyboard-answered prompt would leave a poller running.
  printf '%s\n' "$payload" >"$pending"
  rm -f "$asked"
  req="$dir/$session.$(reqid <<<"$payload")"
  ref="$req.ref"
  rm -f "$ref" "$req.cancel"
  : >"$req.wait"
  trap 'rm -f "$req.wait" "$req.cancel" "$ref"' EXIT
  deadline=$(($(date +%s) + ${CC_SLACK_ASK_TIMEOUT:-14400}))
  while [ ! -s "$ref" ]; do
    [ ! -e "$req.cancel" ] || exit 0
    [ "$(date +%s)" -lt "$deadline" ] || exit 0
    sleep 1
  done
  read -r channel ts <"$ref"
  say() { # one line in the card's thread; a failure to post it must not change the decision
    "$HOME/.local/bin/cc-slack" --api chat.postMessage --data-urlencode "channel=$channel" \
      --data-urlencode "thread_ts=$ts" --data-urlencode "text=$1" >/dev/null ||
      log "could not post in the thread: $1"
  }
  while :; do
    if [ -e "$req.cancel" ]; then
      log "answered directly"
      say ":keyboard: Answered directly"
      exit 0
    fi
    rc=0
    reply=$("$HOME/.local/bin/cc-slack-wait" "$channel" "$ts" 0 2>"$req.err") || rc=$?
    [ "$rc" -ne 0 ] || break
    if [ "$rc" -ne 3 ]; then # 3 = no reply yet; anything else is Slack refusing the read
      log "no decision from Slack (cc-slack-wait exit $rc: $(head -c 300 "$req.err"))"
      rm -f "$req.err"
      exit 0
    fi
    rm -f "$req.err"
    if [ "$(date +%s)" -ge "$deadline" ]; then
      log "no reply from Slack before the deadline"
      exit 0
    fi
    sleep 4
  done
  word=$(head -n 1 <<<"$reply" | tr '[:upper:]' '[:lower:]' | tr -d '[:punct:][:space:]')
  case $word in
  yes | y | ok | okay | approve | approved | allow | allowed | go | doit)
    decision='{"behavior":"allow"}'
    note=":white_check_mark: Approved"
    ;;
  no | n | deny | denied | reject | rejected | stop | dont)
    decision='{"behavior":"deny","message":"The developer denied this from Slack."}'
    note=":no_entry: Denied"
    ;;
  *)
    decision=$(jq -cn --arg r "$reply" \
      '{behavior: "deny", message: ("The developer did not approve this. They replied from Slack: " + $r)}')
    note=":no_entry: Denied, and your reply was passed to Claude"
    ;;
  esac
  log "decided from Slack: $note"
  say "$note"
  jq -cn --argjson d "$decision" '{hookSpecificOutput: {hookEventName: "PermissionRequest", decision: $d}}'
  exit 0
  ;;
clear)
  # PostToolUse, every tool: this tool ran, so its request (if a hook is still waiting on it) is answered.
  req="$dir/$session.$(reqid <<<"$payload")"
  if [ -e "$req.wait" ]; then
    : >"$req.cancel"
    rm -f "$pending" "$asked"
  fi
  if [ "$(jq -r '.tool_name // ""' <<<"$payload")" = AskUserQuestion ]; then
    rm -f "$pending" "$asked"
  fi
  exit 0
  ;;
reset)
  for w in "$dir/$session".*.wait; do
    [ -e "$w" ] && : >"${w%.wait}.cancel"
  done
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
  echo "cc-slack-hook: unknown kind '$kind' (stash|ask|notify|idle|clear|reset)" >&2
  exit 2
  ;;
esac

transcript=$(jq -r '.transcript_path // ""' <<<"$payload")

# Cards, one JSON object per line: the stashed request if there is a recent one (2 minutes), one card per
# question; else Claude Code's own notification text.
cards=""
refid=""
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
       detail: ([(.tool_input.description // empty), "Reply `yes` or `no` in this thread, or answer in the terminal."] | join(" · ")),
       transcript_path: $transcript}
    end' "$pending")
  if [ "$(jq -r '.tool_name // ""' "$pending")" != AskUserQuestion ]; then
    refid=$(reqid <"$pending")
  fi
  rm -f "$pending"
fi
if [ -z "$cards" ]; then
  icon=":bell:"
  [ "$kind" = idle ] && icon=":hourglass_flowing_sand:"
  cards=$(jq -c --arg icon "$icon" --arg transcript "$transcript" \
    '{icon: $icon, title: (.message // "Claude is waiting for your input"), transcript_path: $transcript}' <<<"$payload")
fi

while IFS= read -r card; do
  if [ -n "$refid" ]; then
    # A permission card: hand its thread reference to the `ask` hook waiting on this request.
    printf '%s\n' "$card" | "$HOME/.local/bin/cc-slack-card" --ref >"$dir/$session.$refid.ref.tmp"
    mv "$dir/$session.$refid.ref.tmp" "$dir/$session.$refid.ref"
  else
    printf '%s\n' "$card" | "$HOME/.local/bin/cc-slack-card"
  fi
  log "sent: $(jq -r '.title' <<<"$card")"
done <<<"$cards"

if [ "$kind" = idle ]; then
  printf '%s' "$last_human" >"$marker"
else
  : >"$asked"
fi
