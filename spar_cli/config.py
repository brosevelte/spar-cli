"""Per-user config for the spark CLI, at ~/.config/spark/config.toml.

Nothing about a particular person or box is baked into the code: the box's address and the account
on it come from this file, so the same checkout serves everyone with an account on the machine.

One laptop can know several boxes. Top-level keys are shared defaults; each `[boxes.<name>]` table
overrides them for one box, and `default` names the box used when none is picked:

    default = "mine"
    identity_file = "~/.ssh/spark"

    [boxes.mine]
    host = "100.72.79.55"
    user = "carter"

    [boxes.grahams]
    host = "100.80.1.2"
    user = "carter"

Pick a box per command with `spark -h grahams <verb>` (or SPARK_BOX=grahams); `spark box use` moves
the default. A file with only top-level keys (the original single-box format) still works: it is
one box, named "default". `spark box add` rewrites the file, so hand-written comments do not survive
it (the first rewrite keeps the original as config.toml.bak).
"""

from __future__ import annotations

import getpass
import json
import os
import re
import tomllib
from dataclasses import dataclass, fields
from pathlib import Path

CONFIG_PATH = Path(os.environ.get("SPARK_CONFIG", Path.home() / ".config" / "spark" / "config.toml"))

DEFAULTS: dict[str, object] = {
    # Required. Tailnet IP or MagicDNS name of the box.
    "host": "",
    # Account on the box. Empty means "same name as my local account".
    "user": "",
    # 2222 is OpenSSH reached directly, authenticated by key. Port 22 may be Tailscale SSH, whose
    # `check` policy expires on a schedule and then stalls clients that cannot show a browser prompt.
    "port": 2222,
    "identity_file": "~/.ssh/spark",
    "tmux_session": "main",
    # The debug Chrome on THIS laptop. One Chrome serves every box.
    "chrome_port": 9222,
    # Where that Chrome appears on the BOX's loopback. The box's 127.0.0.1 is shared by every account
    # on it, so two users on one box need different ports here or one drives the other's browser.
    # 0 = not chosen yet: `spark bootstrap` picks 9222 + (uid - 1000) and saves it.
    "remote_chrome_port": 0,
    # Claude Code serves its OAuth callback on this port. Running headless, it listens on the
    # BOX's localhost while your browser redirects to your laptop's -- so interactive sessions
    # forward it, and MCP `/mcp` authentication completes without copying anything by hand.
    "oauth_port": 54545,
    # mcp-remote (the stdio bridge some MCP servers use, e.g. Linear) runs its OWN callback
    # server. Pin it by passing the port as the last argument to mcp-remote in the server config.
    "mcp_remote_port": 3334,
    "chrome_profile": str(Path.home() / ".spark-chrome"),
    # `spark auth aws`: SSO profile to log in with and push. Empty uses the ambient AWS_PROFILE.
    "aws_profile": "",
    "aws_region": "us-east-1",
    # Second profile for long-running jobs: read-only on prod, longer role session, sharing the
    # same SSO sign-in as aws_profile. Empty = only the interactive profile is managed.
    "aws_batch_profile": "",
    # `spark sync claude`: project path relative to $HOME, identical on both machines.
    "claude_project": "src/ultron-framework",
}

# What a single-box (legacy) file's top level holds that belongs to that box rather than to all of them.
BOX_KEYS = ("host", "user", "port", "tmux_session", "remote_chrome_port", "claude_project")
LEGACY_NAME = "default"
NAME_RX = re.compile(r"^[A-Za-z0-9_-]+$")

# Set from `spark -h <name>` / SPARK_BOX before any command runs.
SELECTED: str | None = None


@dataclass(frozen=True)
class Config:
    name: str
    host: str
    user: str
    port: int
    identity_file: str
    tmux_session: str
    chrome_port: int
    remote_chrome_port: int
    oauth_port: int
    mcp_remote_port: int
    chrome_profile: str
    aws_profile: str
    aws_region: str
    aws_batch_profile: str
    claude_project: str

    @property
    def target(self) -> str:
        return f"{self.user}@{self.host}"

    @property
    def box_chrome_port(self) -> int:
        """The laptop Chrome's port as seen from the box."""
        return self.remote_chrome_port or self.chrome_port


def read_raw() -> dict:
    if not CONFIG_PATH.exists():
        return {}
    with CONFIG_PATH.open("rb") as fh:
        return tomllib.load(fh)


def box_names(raw: dict | None = None) -> list[str]:
    raw = read_raw() if raw is None else raw
    boxes = raw.get("boxes") or {}
    if boxes:
        return list(boxes)
    return [LEGACY_NAME] if raw.get("host") else []


def default_name(raw: dict) -> str | None:
    names = box_names(raw)
    if raw.get("default") in names:
        return raw["default"]
    return names[0] if len(names) == 1 else None


def load(name: str | None = None) -> Config:
    raw = read_raw()
    names = box_names(raw)
    if not names:
        raise SystemExit("No box configured. Register one: spark box add <name> --host <tailnet-ip> --user <account>")
    name = name or SELECTED or default_name(raw)
    if name is None:
        raise SystemExit(
            f"Several boxes and no default ({', '.join(names)}): pick one with `spark -h <name>` or `spark box use <name>`."
        )
    if name not in names:
        raise SystemExit(
            f"No box named {name!r}. Known: {', '.join(names)}. Add it with `spark box add {name} --host ...`."
        )
    data = dict(DEFAULTS)
    data.update({k: v for k, v in raw.items() if k not in ("boxes", "default")})
    data.update((raw.get("boxes") or {}).get(name, {}))
    known = {f.name for f in fields(Config)}
    data = {k: v for k, v in data.items() if k in known}
    data["name"] = name
    if not data.get("user"):
        data["user"] = getpass.getuser()
    if not data.get("host"):
        raise SystemExit(f"Box {name!r} has no host. Set it: spark box add {name} --host <tailnet-ip>")
    return Config(**data)  # type: ignore[arg-type]


# --------------------------------------------------------------------------- writing


def _fmt(value: object) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    return json.dumps(str(value))  # a JSON string is a valid TOML basic string


def _dump(raw: dict) -> str:
    lines = [
        "# spark CLI config -- rewritten by `spark box ...`. Top-level keys are shared by every box;",
        "# a [boxes.<name>] table overrides them for that box. `spark box list` shows what's here.",
        "",
    ]
    if "default" in raw:
        lines.append(f"default = {_fmt(raw['default'])}")
    for key, value in raw.items():
        if key not in ("default", "boxes"):
            lines.append(f"{key} = {_fmt(value)}")
    for name, table in (raw.get("boxes") or {}).items():
        lines += ["", f"[boxes.{name}]"]
        lines += [f"{k} = {_fmt(v)}" for k, v in table.items()]
    return "\n".join(lines) + "\n"


def write_raw(raw: dict) -> Path:
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    backup = CONFIG_PATH.with_name(CONFIG_PATH.name + ".bak")
    if CONFIG_PATH.exists() and not backup.exists():
        backup.write_text(CONFIG_PATH.read_text())
    CONFIG_PATH.write_text(_dump(raw))
    return CONFIG_PATH


def _migrate_legacy(raw: dict, name_for_legacy: str) -> dict:
    """Move a single-box file's box-specific top-level keys into [boxes.<name_for_legacy>]."""
    if raw.get("boxes") or not raw.get("host"):
        return raw
    box = {k: raw.pop(k) for k in BOX_KEYS if k in raw}
    raw["boxes"] = {name_for_legacy: box}
    raw.setdefault("default", name_for_legacy)
    return raw


def upsert_box(name: str, values: dict[str, object], *, make_default: bool = False) -> Path:
    if not NAME_RX.match(name):
        raise SystemExit(f"Box names are letters, digits, - and _ (got {name!r}).")
    raw = read_raw()
    # A legacy box at the same address IS this box: it takes the new name instead of becoming "default".
    legacy_same = raw.get("host") and not raw.get("boxes") and values.get("host") in (None, raw.get("host"))
    raw = _migrate_legacy(raw, name if legacy_same else LEGACY_NAME)
    if legacy_same:
        raw["default"] = name
    boxes = raw.setdefault("boxes", {})
    boxes.setdefault(name, {}).update({k: v for k, v in values.items() if v is not None})
    if make_default or "default" not in raw or raw["default"] not in boxes:
        raw["default"] = name
    return write_raw(raw)


def set_box_value(name: str, key: str, value: object) -> Path:
    raw = read_raw()
    if not raw.get("boxes") and name == LEGACY_NAME:
        raw[key] = value
        return write_raw(raw)
    raw.setdefault("boxes", {}).setdefault(name, {})[key] = value
    return write_raw(raw)


def set_default(name: str) -> Path:
    raw = read_raw()
    if name not in box_names(raw):
        raise SystemExit(f"No box named {name!r}. Known: {', '.join(box_names(raw)) or 'none'}.")
    raw = _migrate_legacy(raw, LEGACY_NAME)
    raw["default"] = name
    return write_raw(raw)


def remove_box(name: str) -> Path:
    raw = _migrate_legacy(read_raw(), LEGACY_NAME)
    if name not in (raw.get("boxes") or {}):
        raise SystemExit(f"No box named {name!r}.")
    del raw["boxes"][name]
    if raw.get("default") == name:
        remaining = list(raw["boxes"])
        if remaining:
            raw["default"] = remaining[0]
        else:
            raw.pop("default")
    return write_raw(raw)


def write_default() -> Path:
    """`spark init`: the shared defaults, commented, with no box yet -- `spark box add` adds one."""
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        "# spark CLI config. Shared defaults below; register a box with",
        "#   spark box add <name> --host <tailnet-ip> --user <account-on-the-box>",
        "",
    ]
    for key, value in DEFAULTS.items():
        if key not in BOX_KEYS:
            lines.append(f"{key} = {_fmt(value)}")
    CONFIG_PATH.write_text("\n".join(lines) + "\n")
    return CONFIG_PATH
