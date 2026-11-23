---
name: away-mode
description: Away mode - the developer is stepping away from the terminal, so send every question or ruling you need to their Slack DM with `cc-slack` instead of leaving it waiting in the session. Use when the developer says "/away-mode", "stepping away", "send questions over Slack", "ping me on Slack", or "I'm back" / "/away-mode off" to end it. Optional args - `off` to end it, or a note about how long they are gone or what may proceed without them (`/away-mode back in 2h, sandbox deploys are fine`).
---

# Away mode

The developer reaches Claude Code over SSH from a phone and gets no native notifications. While away mode is on, Slack is how they learn that you need them. They read the message on their phone and answer here in the session: Slack is one-way, so never wait for a reply in Slack.

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

Message shape (plain text; Slack renders `*bold*` and backticks):

```
*ultron-framework* needs a ruling (1 of 1)
The classifier upload fails for PDFs over 25 MB. Options:
A) reject at upload with a clear error (10 lines, my recommendation)
B) chunk the upload (new code path, about a day)
Answer in the session; I'm continuing with the tests meanwhile.
```

Send long text on stdin so quoting cannot mangle it: write the message to `/scratch/away-mode/msg.txt` and run `cc-slack < /scratch/away-mode/msg.txt`.

If `cc-slack` exits non-zero, do not retry in a loop: put the error in the session and carry on; the hook's idle ping is the fallback.

## Turning it off

When they send any message in the session, they are back: stop sending to Slack and answer here. `/away-mode off` or "I'm back" ends it explicitly; no Slack message is needed on the way out.

## Reference

`cc-slack "msg"` or `… | cc-slack` posts as the team's Slack bot to the target in `$CC_SLACK_TARGET` or `~/.config/claude-notify/target`. Setup: `spark auth slack --target <member ID>` (spar-cli). Do not use the claude.ai Slack connector for this: it posts as the developer, and Slack does not notify people about their own messages.
