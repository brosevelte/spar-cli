#!/usr/bin/env python3
"""Install the Claude Code side of Slack pings on THIS machine: the hooks that call cc-slack-hook,
and the /away-mode skill. Run on both the Mac and the box by `spark auth slack`, `spark sync
dotfiles` and `spark bootstrap --user`; stdlib only, so the box's system python3 runs it.

    claude-notify-install.py <dir holding claude-skills/>

settings.json is merged, never overwritten: other keys and other hook entries (the box's PreToolUse
"Bash" block) are left exactly as they are. An entry is ours if any of its commands contains
`cc-slack`; every run removes all of ours from the events below and appends the current set, so it
is idempotent and migrates older shapes away (the first version was one inline `jq -r ... | cc-slack`
Notification entry). A settings.json that isn't valid JSON is an error and nothing is changed. When
the merged result equals what is there, the file is not rewritten at all.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
from pathlib import Path


def _cmd(kind: str, timeout: int | None = None) -> dict:
    cmd: dict = {"type": "command", "command": f'"$HOME"/.local/bin/cc-slack-hook {kind}'}
    if timeout is not None:
        cmd["timeout"] = timeout
    return cmd


# event -> our entries, appended after whatever else the event holds. Copied from the box, where it
# was installed and tested by hand; see dotfiles/cc-slack-hook.sh for what each kind does.
HOOKS: dict[str, list[dict]] = {
    "PreToolUse": [{"matcher": "AskUserQuestion", "hooks": [_cmd("stash")]}],
    "PostToolUse": [{"matcher": "AskUserQuestion", "hooks": [_cmd("clear")]}],
    # `ask` stays alive up to 4 hours waiting for a Slack thread reply that answers the prompt, so it
    # needs more than the default 600-second hook timeout (a minute over the script's own deadline).
    "PermissionRequest": [{"hooks": [_cmd("ask", timeout=14460)]}],
    # No idle_prompt entry, on purpose: "Claude is waiting for your input" fires after every turn,
    # including every wake by a background agent, and was pure noise (Carter, 2026-11-23). A ping
    # means a question or a permission request; a session that has finished says so itself with a
    # card (see the away-mode skill). `cc-slack-hook idle` still exists for anyone who wants it back.
    "Notification": [
        {"matcher": "permission_prompt|elicitation_dialog|agent_needs_input", "hooks": [_cmd("notify")]},
    ],
    "UserPromptSubmit": [{"hooks": [_cmd("reset")]}],
}
SKILLS = ("away-mode",)


def _is_ours(entry: object) -> bool:
    if not isinstance(entry, dict) or not isinstance(entry.get("hooks"), list):
        return False
    return any(isinstance(h, dict) and "cc-slack" in str(h.get("command", "")) for h in entry["hooks"])


def merge(settings: dict) -> dict:
    hooks = settings.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        raise TypeError("settings.json: `hooks` is not an object")
    for event, ours in HOOKS.items():
        entries = hooks.get(event, [])
        if not isinstance(entries, list):
            raise TypeError(f"settings.json: `hooks.{event}` is not a list")
        hooks[event] = [e for e in entries if not _is_ours(e)] + json.loads(json.dumps(ours))
    return settings


def install_hook(path: Path) -> str:
    if path.exists():
        text = path.read_text()
        try:
            current = json.loads(text) if text.strip() else {}
        except json.JSONDecodeError as e:
            raise SystemExit(f"claude-notify: {path} is not valid JSON ({e}); fix it by hand -- nothing changed")
        if not isinstance(current, dict):
            raise SystemExit(f"claude-notify: {path} is not a JSON object -- nothing changed")
    else:
        current = {}
    before = json.dumps(current, sort_keys=True)
    try:
        merged = merge(json.loads(json.dumps(current)))
    except TypeError as e:
        raise SystemExit(f"claude-notify: {e} -- nothing changed") from None
    if json.dumps(merged, sort_keys=True) == before:
        return f"hooks already installed in {path} (unchanged)"
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".settings.", suffix=".json")
    with os.fdopen(fd, "w") as fh:
        json.dump(merged, fh, indent=2)
        fh.write("\n")
    if path.exists():
        os.chmod(tmp, path.stat().st_mode & 0o777)
    os.replace(tmp, path)
    return f"hooks installed in {path}"


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    src = Path(sys.argv[1])
    claude = Path.home() / ".claude"
    print("claude-notify: " + install_hook(claude / "settings.json"))
    for name in SKILLS:
        dest = claude / "skills" / name / "SKILL.md"
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src / "claude-skills" / name / "SKILL.md", dest)
        print(f"claude-notify: skill /{name} -> {dest}")
    if not shutil.which("jq"):
        print(
            "claude-notify: WARNING jq is not installed -- cc-slack-card and cc-slack-hook need it, no pings until it is",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
