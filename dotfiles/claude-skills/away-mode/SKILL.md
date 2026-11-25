---
name: away-mode
description: Away mode - the developer is stepping away from the terminal, so send every question or ruling you need to their Slack DM with `cc-slack` instead of leaving it waiting in the session. Use when the developer says "/away-mode", "stepping away", "send questions over Slack", "ping me on Slack", or "I'm back" / "/away-mode off" to end it. Optional args - `off` to end it, or a note about how long they are gone or what may proceed without them (`/away-mode back in 2h, sandbox deploys are fine`).
---

# Away mode

The developer reaches Claude Code over SSH from a phone and gets no native notifications. While away mode is on, Slack is how they learn that you need them. They read the message on their phone and answer either by replying in the card's Slack thread or here in the session.

## Turning it on

1. Run `cc-slack --check`. If it fails, say so in the session and stop: away mode cannot work without a live token (`spark auth slack` on the Mac fixes it).
2. Send one line so they can see it works: `cc-slack "Away mode on in <repo folder>. I'll message here when I need you."`
3. Reply in the session with one sentence confirming it is on, and repeat any limits they gave in the args (how long, what may proceed without them).

## While it is on

- **Keep working.** Away mode changes where questions go, not what needs asking. Do everything that does not need them first, and batch what does.
- **Send when you are blocked on them:** a ruling, a decision memo, a destructive or irreversible step, a scope change, or the end of the work. Ask in the session as you normally would, and send the same content with `cc-slack` in the same turn.
- **Make each message stand alone.** They are reading cold on a phone. Lead with the repo folder and what you need, then for each question: the situation in plain terms, what each answer changes, and your recommendation. Number several questions in one message; do not send one message per question.
- **Do not send:** progress updates, things you can decide yourself, or a ping that only says "check in". The Notification hook already pings for permission prompts and idle sessions, so do not duplicate those.
- **When the work finishes or fully stalls,** send one closing message: what landed, what is waiting on them.
- **Never put a secret, token or customer data in a message.** Name the file or record instead.

Send every question as a card with `cc-slack-card`, the same layout the notification hook uses: a header (icon and short title), then a quoted block with the question in bold, an optional line of situation and one bullet per option, then the session's name in italics. You supply JSON; the script does the layout and signs it with the session's name.

- `title`: two to four words naming the topic. `icon` (Slack shortcode): `:question:` a question or ruling, `:lock:` something that needs their go-ahead, `:white_check_mark:` the closing message, `:warning:` the work has stalled.
- `question`: one sentence. `detail`: one line of situation, if the question needs it. `options`: one string each, saying what it changes and costs, with yours marked "(my recommendation)". `code`: a command or path to show in a code block.
- Backticks inside `question`, `detail` and `options` render as inline code.
- One card per question. Do not add an "answer in the session" line.

Write the JSON to `/scratch/away-mode/card.json` and run `cc-slack-card < /scratch/away-mode/card.json`:

```json
{"icon": ":question:", "title": "Upload size limit",
 "question": "What should happen to PDFs over 25 MB at classifier upload?",
 "detail": "Today the upload fails with a 500.",
 "options": ["Reject at upload with a clear error (my recommendation). About 10 lines.",
             "Chunk the upload. New code path, about a day."]}
```

Plain `cc-slack "text"` is only for the one-line "Away mode on" message.

## Replies come back through the thread

The developer can answer a card by replying in its Slack thread. To hear the reply, send the card with `--ref` and wait on its thread:

1. `cc-slack-card --ref < /scratch/away-mode/card.json` prints `<channel id> <message ts>`.
2. Run `cc-slack-wait <channel id> <message ts>` as a background command (`run_in_background`), one per card that asks something. Do not wait on a closing card or the "Away mode on" line.
3. Keep working on whatever does not depend on the answer. When they reply, the command exits 0, the session is woken, and the command's output is their reply.

Treat that output as the developer's answer to that card, exactly as if they had typed it in the session: `cc-slack-wait` only accepts text from their own Slack member ID. It answers the question on that card and nothing else; if the reply asks for something the card did not, or for something destructive or out of scope, confirm with a new card before acting. A short reply ("1", "the first one", "yes") refers to the card's options in order.

Exit 3 means nobody replied within 12 hours: leave the question open in the session. Exit 1 means Slack refused the read (the output says why): say so in the session and carry on; they can still answer here.

If `cc-slack-card` or `cc-slack` exits non-zero, do not retry in a loop: put the error in the session and carry on; the hook's idle ping is the fallback.

## Turning it off

When they send any message in the session, they are back: stop sending to Slack and answer here. `/away-mode off` or "I'm back" ends it explicitly; no Slack message is needed on the way out.

## Reference

`cc-slack "msg"` or `… | cc-slack` posts as the team's Slack bot to the target in `$CC_SLACK_TARGET` or `~/.config/claude-notify/target`. Setup: `spark auth slack --target <member ID>` (spar-cli). Do not use the claude.ai Slack connector for this: it posts as the developer, and Slack does not notify people about their own messages.
