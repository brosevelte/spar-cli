"""Per-user config for the spark CLI, at ~/.config/spark/config.toml.

Nothing about a particular person or box is baked into the code: the box's address and the account
on it come from this file, so the same checkout serves everyone with an account on the machine.
`spark init` writes a commented template.
"""

from __future__ import annotations

import getpass
import os
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
    "chrome_port": 9222,
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


@dataclass(frozen=True)
class Config:
    host: str
    user: str
    port: int
    identity_file: str
    tmux_session: str
    chrome_port: int
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


def load() -> Config:
    data = dict(DEFAULTS)
    if CONFIG_PATH.exists():
        with CONFIG_PATH.open("rb") as fh:
            data.update(tomllib.load(fh))
    known = {f.name for f in fields(Config)}
    data = {k: v for k, v in data.items() if k in known}
    if not data.get("user"):
        data["user"] = getpass.getuser()
    if not data.get("host"):
        raise SystemExit(f"No host configured. Run `spark init`, then set `host` in {CONFIG_PATH}.")
    return Config(**data)  # type: ignore[arg-type]


def write_default() -> Path:
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    lines = ["# spark CLI config. `host` is required; everything else has a working default.", ""]
    for key, value in DEFAULTS.items():
        rendered = f'"{value}"' if isinstance(value, str) else str(value)
        lines.append(f"{key} = {rendered}")
    CONFIG_PATH.write_text("\n".join(lines) + "\n")
    return CONFIG_PATH
