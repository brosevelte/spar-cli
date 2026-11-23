#!/usr/bin/env python3
"""Install the Claude Code side of Slack pings on THIS machine: the Notification hook that pipes
into cc-slack, and the /away-mode skill. Run on both the Mac and the box by `spark auth slack`,
`spark sync dotfiles` and `spark bootstrap --user`; stdlib only, so the box's system python3 runs it.

    claude-notify-install.py <dir holding claude-skills/>

settings.json is merged, never overwritten: other keys and other hooks (the box's PreToolUse block)
are left alone. An existing Notification entry whose command ends in `cc-slack` is replaced in
place, and any duplicates of it are dropped -- two entries would deliver every ping twice. A
settings.json that isn't valid JSON is an error and nothing is changed. When the merged result
equals what is there, the file is not rewritten at all.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

HOOK = {
    "matcher": "permission_prompt|idle_prompt|elicitation_dialog|agent_needs_input",
    "hooks": [
        {
            "type": "command",
            "command": (
                'jq -r \'"Claude Code needs you in " + (.cwd | split("/") | last) + ": " '
                '+ (.message // "waiting for input")\' | "$HOME"/.local/bin/cc-slack'
            ),
        }
    ],
}
SKILLS = ("away-mode",)


def _is_ours(entry: object) -> bool:
    if not isinstance(entry, dict):
        return False
    return any(
        isinstance(h, dict) and str(h.get("command", "")).rstrip().endswith("cc-slack") for h in entry.get("hooks", [])
    )


def merge(settings: dict) -> dict:
    hooks = settings.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        raise TypeError("settings.json: `hooks` is not an object")
    notif = hooks.get("Notification", [])
    if not isinstance(notif, list):
        raise TypeError("settings.json: `hooks.Notification` is not a list")
    out, placed = [], False
    for entry in notif:
        if _is_ours(entry):
            if not placed:
                out.append(HOOK)
                placed = True
            continue
        out.append(entry)
    if not placed:
        out.append(HOOK)
    hooks["Notification"] = out
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
        return f"hook already installed in {path} (unchanged)"
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".settings.", suffix=".json")
    with os.fdopen(fd, "w") as fh:
        json.dump(merged, fh, indent=2)
        fh.write("\n")
    if path.exists():
        os.chmod(tmp, path.stat().st_mode & 0o777)
    os.replace(tmp, path)
    return f"hook installed in {path}"


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
        print("claude-notify: WARNING jq is not installed -- the hook needs it, no pings until it is", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
