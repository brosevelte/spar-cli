#!/usr/bin/env bash
# cc-slack-card: one Slack message in the standard "Claude Code needs you" layout, sent through cc-slack.
# Used by cc-slack-hook (permission prompts, questions, idle) and by agents in away mode, so every ping
# reads the same:
#
#   <icon> Title                     header
#   | *Question in bold*             quoted
#   | ```command```                  quoted, preformatted
#   | detail                         quoted
#   | • option                       quoted bullet list
#   _session name_                   italic
#
# Input: one JSON object on stdin. Only "title" is required.
#   {"icon": ":question:", "title": "Token source", "question": "How should devs get the token?",
#    "code": "rm -rf ./x", "detail": "one line of situation", "options": ["first", "second"],
#    "from": "session name"}
# Backticks inside question, detail and options render as inline code.
# "from" defaults to the session's name: the last title record in the transcript named by
# "transcript_path", else in the transcript of $CLAUDE_CODE_SESSION_ID, else the current folder.
#
#   echo '{"icon":":question:","title":"Upload limit","question":"Reject or chunk?","options":["Reject","Chunk"]}' | cc-slack-card
set -euo pipefail

card=$(cat)
jq -e '(.title // "") != ""' <<<"$card" >/dev/null || {
  echo 'cc-slack-card: the JSON on stdin needs a "title"' >&2
  exit 2
}

from=$(jq -r '.from // ""' <<<"$card")
if [ -z "$from" ]; then
  transcript=$(jq -r '.transcript_path // ""' <<<"$card")
  if [ -z "$transcript" ] && [ -n "${CLAUDE_CODE_SESSION_ID:-}" ]; then
    for f in "$HOME"/.claude/projects/*/"$CLAUDE_CODE_SESSION_ID".jsonl; do
      [ -r "$f" ] && transcript=$f
    done
  fi
  if [ -n "$transcript" ] && [ -r "$transcript" ]; then
    from=$(grep -E '"type":"(custom-title|agent-name|ai-title)"' "$transcript" | tail -n 1 |
      jq -r '.customTitle // .agentName // .aiTitle // ""')
  fi
  [ -n "$from" ] || from=$(basename "$PWD")
fi

blocks=$(jq -c --arg from "$from" '
  # text with `inline code` -> rich_text elements; odd-numbered pieces between backticks are code
  def inline($style):
    split("`") | to_entries
    | map(select(.value != "")
        | {type: "text", text: .value, style: (if .key % 2 == 1 then $style + {code: true} else $style end)}
        | if (.style | length) == 0 then del(.style) else . end);
  [ {type: "header", text: {type: "plain_text", emoji: true,
      text: (((.icon // ":bell:") + " " + .title) | .[0:150])}},
    {type: "rich_text", elements: (
      [ (if (.question // "") != "" then {type: "rich_text_quote", elements: (.question | inline({bold: true}))} else empty end),
        (if (.code // "") != "" then {type: "rich_text_preformatted", border: 1, elements: [{type: "text", text: (.code | .[0:2500])}]} else empty end),
        (if (.detail // "") != "" then {type: "rich_text_quote", elements: (.detail | inline({}))} else empty end),
        (if ((.options // []) | length) > 0 then {type: "rich_text_list", style: "bullet", indent: 0, border: 1,
            elements: [.options[] | {type: "rich_text_section", elements: inline({})}]} else empty end),
        {type: "rich_text_section", elements: [{type: "text", text: $from, style: {italic: true}}]} ])} ]' <<<"$card")

# Fallback text: what the phone's push notification shows.
text=$(jq -r --arg from "$from" '
  (.icon // ":bell:") + " " + .title
  + (if (.question // .code // .detail // "") != "" then ": " + ((.question // .code // .detail) | .[0:300]) else "" end)
  + " (" + $from + ")"' <<<"$card")

CC_SLACK_BLOCKS="$blocks" "$HOME/.local/bin/cc-slack" "$text"
