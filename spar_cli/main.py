"""`spark` — laptop-side helper for the DGX Spark.

Day to day: `spark mosh` (shell) / `spark mosh --tmux [name]` for long sessions (survives sleep and roaming), `spark ssh` / `spark tmux` as the plain-ssh fallback, `spark tunnel install` once so agents on the box can drive this laptop's Chrome, and `spark auth aws|claude|mcp|drive` for sign-ins that the headless box can't do itself.

Every verb shells out to the system ssh/scp/rsync so Tailscale SSH, agent forwarding and known_hosts behave exactly as they do in a terminal. Failures propagate: a non-zero exit from the remote is a non-zero exit here.
"""

from __future__ import annotations

import configparser
import hashlib
import json
import os
import platform
import shlex
import subprocess
import sys
import tempfile
from datetime import UTC, datetime
from pathlib import Path

import typer

from spar_cli import config as cfg

app = typer.Typer(no_args_is_help=True, add_completion=False, help=__doc__)


def _run(
    cmd: list[str], *, check: bool = True, capture: bool = False, stdin: str | None = None, cwd: Path | None = None
) -> subprocess.CompletedProcess[str]:
    typer.secho("$ " + " ".join(shlex.quote(c) for c in cmd), fg="bright_black", err=True)
    return subprocess.run(cmd, check=check, text=True, capture_output=capture, input=stdin, cwd=cwd)


def _conn_opts(c: cfg.Config) -> list[str]:
    """Port and key, shared by ssh/scp/rsync so every verb takes the same route onto the box."""
    opts = ["-o", "IdentitiesOnly=yes"]
    if c.identity_file:
        opts += ["-i", str(Path(c.identity_file).expanduser())]
    return opts


# Client-side liveness: a connection whose far end vanished (laptop slept, wifi moved) is torn down
# after ~45s instead of sitting there looking alive until you type into it.
KEEPALIVE_OPTS = ["-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"]


def _ssh_base(c: cfg.Config) -> list[str]:
    return ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-p", str(c.port), *_conn_opts(c), c.target]


def _scp(c: cfg.Config) -> list[str]:
    # scp spells the port -P, not -p (-p means preserve times).
    return ["scp", "-q", "-P", str(c.port), *_conn_opts(c)]


def _rsync(c: cfg.Config) -> list[str]:
    # rsync reaches the remote through -e, so the port and key have to be spelled into that inner command.
    inner = " ".join(["ssh", "-p", str(c.port), *_conn_opts(c)])
    return ["rsync", "-e", inner]


REMOTE_PATH = 'export PATH="$HOME/.local/bin:$HOME/.local/node/bin:$HOME/.pulumi/bin:$PATH"; '


def _bash(script: str, *, login: bool = False) -> str:
    """Wrap a POSIX script so the remote runs it under bash. ssh joins its argv with spaces and hands the result to the user's LOGIN shell — which is fish here, where `(...)` is command substitution and `VAR=x` is a syntax error. Quoting the whole thing as one word keeps it intact."""
    return f"bash -{'l' if login else ''}c " + shlex.quote(script)


def _remote(c: cfg.Config, script: str, *, capture: bool = False) -> subprocess.CompletedProcess[str]:
    # ~/.bashrc bails for non-interactive shells, so the bootstrap PATH is set explicitly rather than trusted to -l.
    return _run([*_ssh_base(c), _bash(REMOTE_PATH + script, login=True)], capture=capture)


# --------------------------------------------------------------------------- session


def _ensure_terminfo(c: cfg.Config) -> None:
    """Terminals like Ghostty (TERM=xterm-ghostty) aren't in Ubuntu's terminfo db, so tmux on the Spark refuses to start ("missing or unsuitable terminal"). Compile the local entry into the remote user's ~/.terminfo once; a no-op when it is already there."""
    term = os.environ.get("TERM", "")
    if not term or term.startswith("xterm-256color") or term == "screen":
        return
    entry = subprocess.run(["infocmp", "-x", term], check=False, text=True, capture_output=True)
    if entry.returncode != 0:
        return
    check = f"[ -e ~/.terminfo/{term[0]}/{shlex.quote(term)} ] || (mkdir -p ~/.terminfo && tic -x -)"
    subprocess.run([*_ssh_base(c), _bash(check)], input=entry.stdout, text=True, check=False)


def _interactive_ssh(c: cfg.Config, remote_command: str | None, *, tunnel: bool) -> None:
    """Replace this process with an interactive ssh. `tunnel` adds an inline Chrome reverse forward -- only the fallback for when the `spark tunnel` launchd agent isn't installed, since an inline forward dies with this session and only the first session can bind it."""
    _ensure_terminfo(c)
    cmd = ["ssh", "-t", "-o", "LogLevel=ERROR", *KEEPALIVE_OPTS, "-p", str(c.port), *_conn_opts(c), c.target]
    if tunnel:
        # The OAuth callback port is deliberately NOT forwarded here -- see `spark auth mcp`.
        cmd += ["-R", f"{c.chrome_port}:127.0.0.1:{c.chrome_port}"]
    if remote_command:
        cmd.append(remote_command)
    os.execvp(cmd[0], cmd)


def _interactive_ssh_opening_url(
    c: cfg.Config, remote_command: str, url_pattern: str, *, local_forwards: tuple[int, ...] = ()
) -> None:
    """Run an interactive remote command, and open the first URL matching `url_pattern` in THIS
    machine's browser as soon as it is printed.

    Login flows on the box try to open a browser there, and the box has none, so all they can do is
    print a URL for you to copy. This owns the ssh session, so it watches the output go by instead.
    It runs under a real pty, so the session stays fully interactive: if the flow falls back to
    asking for a pasted code, the prompt works as normal.
    """
    import pty
    import re

    _ensure_terminfo(c)
    forwards = [arg for port in local_forwards for arg in ("-L", f"{port}:127.0.0.1:{port}")]
    cmd = ["ssh", "-t", "-o", "LogLevel=ERROR", "-p", str(c.port), *_conn_opts(c), *forwards, c.target, remote_command]
    # A URL can arrive split across reads, so match against a rolling tail of the output. Stop at
    # whitespace AND at control bytes: the URL may be wrapped in colour or OSC-8 hyperlink escapes.
    rx = re.compile(url_pattern + r"[^\s\x1b\x07]*")
    opener = os.environ.get("SPARK_URL_OPENER") or ("open" if platform.system() == "Darwin" else "xdg-open")
    state = {"opened": False, "tail": ""}

    def read(fd: int) -> bytes:
        data = os.read(fd, 4096)
        if not state["opened"]:
            state["tail"] = (state["tail"] + data.decode("utf-8", "replace"))[-8192:]
            match = rx.search(state["tail"])
            if match:
                state["opened"] = True
                subprocess.run([opener, match.group(0)], check=False, capture_output=True)
        return data

    status = pty.spawn(cmd, read)
    raise typer.Exit(os.waitstatus_to_exitcode(status))


@app.command()
def ssh(no_chrome: bool = typer.Option(False, help="don't start the debug Chrome / tunnel")) -> None:
    """Plain interactive login shell on the Spark. Also makes sure the laptop's debug Chrome and the tunnel to it are up, so agents on the box can drive a browser. Anything that must outlive the connection belongs in `spark tmux`."""
    c = cfg.load()
    inline = False if no_chrome else _ensure_browser_path(c)
    _interactive_ssh(c, None, tunnel=inline)


# The fixed shape of a working session, so anything driving tmux from outside (the Raycast
# extension in raycast/) can address panes by name instead of guessing: window LAYOUT_WINDOW,
# pane 1 running Claude Code, pane 2 a shell beside it, both in the configured project.
LAYOUT_WINDOW = "claude"
SHELLS = "fish bash zsh sh"


def _layout_script(session: str, window: str, cwd: str) -> str:
    """Idempotent: creates whatever is missing and touches nothing that exists. `cwd` is relative to the remote $HOME. Claude is only started
    when pane 1 is sitting at a bare shell prompt -- never typed into a running program."""
    s, w, d = shlex.quote(session), shlex.quote(window), shlex.quote(cwd)
    return (
        f'S={s}; W={w}; D="$HOME"/{d}; '
        'tmux has-session -t "$S" 2>/dev/null || tmux new-session -d -s "$S" -n "$W" -c "$D"; '
        # No window by that name yet: adopt one that already has Claude in pane 1 (a session built by
        # hand, auto-named after whatever ran first) before resorting to a new one.
        'if ! tmux list-windows -t "$S" -F "#W" | grep -qx "$W"; then '
        '  i=$(tmux list-panes -s -t "$S" -F "#I #P #{pane_current_command}" | awk \'$2==1 && $3=="claude" {print $1; exit}\'); '
        '  if [ -n "$i" ]; then tmux rename-window -t "$S:$i" "$W"; else tmux new-window -t "$S" -n "$W" -c "$D"; fi; '
        "fi; "
        # The name is the contract; stop tmux renaming it after the foreground command.
        'tmux set-option -w -t "$S:$W" automatic-rename off; '
        '[ "$(tmux list-panes -t "$S:$W" | wc -l)" -ge 2 ] || tmux split-window -h -t "$S:$W" -c "$D"; '
        'cmd=$(tmux display-message -p -t "$S:$W.1" "#{pane_current_command}"); '
        f'case " {SHELLS} " in *" $cmd "*) tmux send-keys -t "$S:$W.1" claude Enter;; esac; '
        'tmux select-window -t "$S:$W"; '
        'echo "$S: window $W, pane 1 $(tmux display-message -p -t "$S:$W.1" "#{pane_current_command}"), pane 2 $(tmux display-message -p -t "$S:$W.2" "#{pane_current_command}")"'
    )


def _ensure_layout(c: cfg.Config, session: str) -> None:
    _remote(c, _layout_script(session, LAYOUT_WINDOW, c.claude_project))


@app.command()
def layout(session: str = typer.Argument(None, help="session (default from config)")) -> None:
    """Make a tmux session on the Spark match the fixed shape the Raycast extension assumes: window `claude` with Claude Code in pane 1 and a shell in pane 2, both in `claude_project`. Idempotent -- run against a live session it changes nothing; run against nothing it builds the whole thing. `spark mosh`/`spark tmux` do this before attaching."""
    c = cfg.load()
    _ensure_layout(c, session or c.tmux_session)


@app.command()
def tmux(
    session: str = typer.Argument(None, help="session name (default from config: main)"),
    no_chrome: bool = typer.Option(False, help="don't start the debug Chrome / tunnel"),
    no_layout: bool = typer.Option(False, help="attach as-is, don't build the `spark layout` shape"),
) -> None:
    """Attach to a named tmux session on the Spark, creating it if missing. Sessions survive dropped ssh connections, so Claude and dev servers run here (e.g. `spark tmux main`, `spark tmux fe`). The session gets the `spark layout` shape first (window `claude`: Claude in pane 1, shell in pane 2) unless --no-layout."""
    c = cfg.load()
    name = session or c.tmux_session
    inline = False if no_chrome else _ensure_browser_path(c)
    if not no_layout:
        _ensure_layout(c, name)
    _interactive_ssh(c, f"tmux new-session -A -s {shlex.quote(name)}", tunnel=inline)


@app.command()
def mosh(
    session: str = typer.Argument(None, help="tmux session to attach-or-create (implies --tmux)"),
    tmux: bool = typer.Option(
        False, "--tmux", help="land in a tmux session: the config default (main), or the one named"
    ),
    no_chrome: bool = typer.Option(False, help="don't start the debug Chrome / tunnel"),
    no_layout: bool = typer.Option(False, help="attach as-is, don't build the `spark layout` shape"),
) -> None:
    """A login shell on the Spark over mosh: survives sleep, wifi changes and roaming instead of dying with the TCP connection. `--tmux` lands in the default session (main) instead; `spark mosh --tmux fe` (or just `spark mosh fe`) attaches-or-creates session `fe`. mosh can't forward ports, so the Chrome path comes from the `spark tunnel` agent -- this refuses to fall back to nothing silently.

    mosh has no scrollback of its own, so anything long-lived belongs in tmux. Inside tmux, `prefix N` prompts for a new session and `prefix s` switches between them. A tmux session gets the `spark layout` shape before attaching (window `claude`: Claude in pane 1, shell in pane 2) unless --no-layout, so the Raycast extension can always find its way around.
    """
    c = cfg.load()
    if not no_chrome and _ensure_browser_path(c):
        typer.secho(
            "mosh can't carry the Chrome forward and the tunnel agent isn't installed: run `spark tunnel install` (or pass --no-chrome).",
            fg="red",
            err=True,
        )
        raise typer.Exit(1)
    _ensure_terminfo(c)
    inner = " ".join(["ssh", "-p", str(c.port), *_conn_opts(c)])
    cmd = ["mosh", f"--ssh={inner}", c.target]
    if tmux or session:
        name = session or c.tmux_session
        if not no_layout:
            _ensure_layout(c, name)
        cmd += ["--", "tmux", "new-session", "-A", "-s", name]
    os.execvp(cmd[0], cmd)


@app.command()
def run(command: list[str] = typer.Argument(..., help="command to run on the Spark")) -> None:
    """Run one command on the Spark (login shell, so the bootstrap PATH applies) and stream its output. A single argument is passed to bash verbatim, so pipes and redirects work: `spark run 'ls ~/src | wc -l'`. Several arguments are treated as argv and quoted individually."""
    c = cfg.load()
    script = command[0] if len(command) == 1 else " ".join(shlex.quote(a) for a in command)
    raise typer.Exit(_remote(c, script, capture=False).returncode)


@app.command()
def status() -> None:
    """Reachability + toolchain + running tmux sessions on the Spark."""
    c = cfg.load()
    script = (
        "hostname; uptime; echo; "
        "for b in claude uv node gh gt aws pulumi docker ast-grep; do printf '%-9s ' $b; command -v $b || echo MISSING; done; echo; "
        "tmux ls 2>/dev/null || echo 'no tmux sessions'; echo; "
        "tail -n 3 $(ls -t ~/bootstrap*.log 2>/dev/null | head -1) 2>/dev/null"
    )
    _remote(c, script)


# --------------------------------------------------------------------------- auth

auth_app = typer.Typer(
    no_args_is_help=True, help="Authenticate a service on the Spark: `spark auth aws`, `spark auth claude`."
)
app.add_typer(auth_app, name="auth")


def _persist_remote_env(c: cfg.Config, env: dict[str, str]) -> None:
    """Persist env vars on the Spark for every shell. ssh forwards none of these, fish never reads ~/.profile, and a tmux server started earlier holds its own environment — so all three need writing. Each value is a default: something already exported in the session still wins."""
    header = "# written by `spark auth` — regenerated, don't edit"
    fish = "\n".join(f"set -q {k}; or set -gx {k} {shlex.quote(v)}" for k, v in env.items())
    posix = "\n".join(f'export {k}="${{{k}:-{v}}}"' for k, v in env.items())
    tmux = " ".join(f"tmux setenv -g {k} {shlex.quote(v)} 2>/dev/null;" for k in env for v in [env[k]])
    _remote(
        c,
        "mkdir -p ~/.config/fish/conf.d ~/.config; "
        f"printf '%s\\n%s\\n' {shlex.quote(header)} {shlex.quote(fish)} > ~/.config/fish/conf.d/spark-env.fish; "
        f"printf '%s\\n%s\\n' {shlex.quote(header)} {shlex.quote(posix)} > ~/.config/spark-env.sh; "
        "grep -q spark-env.sh ~/.profile || "
        "printf '\\n[ -f ~/.config/spark-env.sh ] && . ~/.config/spark-env.sh\\n' >> ~/.profile; "
        f"{tmux} true",
    )


def _aws_config_sections(text: str) -> tuple[str, dict[str, str]]:
    """Split an AWS config file into (preamble, {"[header]": raw section text}), keeping each section's text verbatim -- comments and ordering included -- so a merge never rewrites what it doesn't own."""
    preamble: list[str] = []
    sections: dict[str, list[str]] = {}
    current: list[str] = preamble
    for line in text.splitlines(keepends=True):
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            current = sections.setdefault(" ".join(stripped.split()), [])
        current.append(line)
    return "".join(preamble), {name: "".join(lines) for name, lines in sections.items()}


def _merge_aws_config(local: str, remote: str) -> tuple[str, list[str]]:
    """This machine's sections, in its order, then the sections only the box has. Returns (merged text, kept box-only headers)."""
    local_pre, local_secs = _aws_config_sections(local)
    _, remote_secs = _aws_config_sections(remote)
    kept = [name for name in remote_secs if name not in local_secs]
    parts = [local_pre, *local_secs.values()]
    for name in kept:
        body = remote_secs[name]
        parts.append(body if body.endswith("\n") else body + "\n")
    text = ""
    for part in parts:
        if text and not text.endswith("\n\n") and part.strip():
            text += "\n" if text.endswith("\n") else "\n\n"
        text += part
    return text, kept


def _sso_token_cache_name(profile: str) -> str:
    """The cache file the AWS CLI reads for this profile's sign-in: `sha1(<sso_session name>).json`, or
    `sha1(<sso_start_url>).json` for a legacy profile without an `sso-session`. Reading THAT file is the
    only honest report. Scanning the whole cache directory (the old behaviour) picked up dead tokens from
    earlier sign-ins and reported "signed in; renews automatically" off a July file while the live token
    had already lost its refresh ability -- which is how the box kept dying unnoticed in 2026-10."""
    parser = configparser.ConfigParser()
    parser.read(Path.home() / ".aws" / "config")
    section = "default" if profile == "default" else f"profile {profile}"
    if not parser.has_section(section):
        raise SystemExit(f"profile {profile!r} is not in ~/.aws/config")
    key = parser[section].get("sso_session") or parser[section].get("sso_start_url")
    if not key:
        raise SystemExit(
            f"profile {profile!r} has neither sso_session nor sso_start_url; `spark auth aws` only manages SSO profiles"
        )
    return hashlib.sha1(key.encode()).hexdigest() + ".json"


def _aws_report(c: cfg.Config, profiles: list[str]) -> bool:
    """Verify each profile ON THE BOX and print which role it resolves to, plus how long the shared
    SSO sign-in has left. The sign-in is what matters for long jobs: while it is alive the CLI
    re-mints role credentials silently, so a job only dies when the sign-in itself lapses. Returns
    True only if every profile resolved."""
    probe = " ".join(shlex.quote(p) for p in profiles)
    token_file = '"$HOME/.aws/sso/cache/' + _sso_token_cache_name(profiles[0]) + '"'  # name is hex + .json
    script = (
        f"for p in {probe}; do "
        'if out=$(aws sts get-caller-identity --profile "$p" --query Arn --output text 2>&1); '
        'then printf \'OK|%s|%s\\n\' "$p" "$out"; '
        'else printf \'ERR|%s|%s\\n\' "$p" "$(printf \'%s\' "$out" | tail -1)"; fi; done; '
        # Only the token file the CLI itself resolves for this profile; never a directory-wide grep.
        f"f={token_file}; exp=''; "
        '[ -f "$f" ] && exp=$(grep -ho \'"expiresAt": *"[^"]*"\' "$f" | sed \'s/.*"\\([^"]*\\)".*/\\1/\'); '
        "printf 'EXP|%s\\n' \"$exp\"; "
        "[ -f \"$f\" ] && grep -q '\"refreshToken\"' \"$f\" && echo 'REFRESH|yes' || echo 'REFRESH|no'"
    )
    out = _remote(c, script, capture=True).stdout
    ok = True
    expiry = ""
    refreshes = False
    for line in out.splitlines():
        kind, _, rest = line.partition("|")
        if kind == "EXP":
            expiry = rest.strip()
            continue
        if kind == "REFRESH":
            refreshes = rest.strip() == "yes"
            continue
        name, _, detail = rest.partition("|")
        if kind == "OK":
            # arn:aws:sts::<acct>:assumed-role/AWSReservedSSO_<PermissionSet>_<hash>/<user>
            role = detail.split("assumed-role/")[-1].split("/")[0]
            role = role.removeprefix("AWSReservedSSO_").rsplit("_", 1)[0]
            typer.secho(f"  {name:<34} {role}", fg="green")
        elif kind == "ERR":
            ok = False
            typer.secho(f"  {name:<34} FAILED: {detail}", fg="red")
    # The cache's `expiresAt` is the short-lived ACCESS token (about an hour), not the sign-in. With
    # a refresh token beside it the CLI swaps it silently for as long as the Identity Center sign-in
    # session lives -- and that session's end is not recorded anywhere in the cache (it lives in
    # Identity Center's settings). So report what is actually knowable, not a fake countdown.
    if not expiry:
        ok = False
        typer.secho("  SSO: no token cached on the box", fg="red")
    elif refreshes:
        typer.secho(
            "  SSO: signed in; access token renews automatically until your Identity Center sign-in "
            "session ends (its length is set in Identity Center, and isn't visible from here)",
            fg="green",
        )
    else:
        left = (datetime.fromisoformat(expiry) - datetime.now(tz=UTC)).total_seconds() / 3600
        colour = "green" if left > 1 else ("yellow" if left > 0 else "red")
        typer.secho(
            f"  SSO: access token has {left:.1f}h left and no refresh token -- re-run when it lapses", fg=colour
        )
    return ok


@auth_app.command("aws")
def auth_aws(
    profile: str = typer.Option(None, help="SSO profile to log in with locally (default: aws_profile from config)"),
    region: str = typer.Option(None, help="AWS_REGION to set on the Spark (default: aws_region from config)"),
    skip_login: bool = typer.Option(False, help="only copy the existing cache, don't run aws sso login"),
    check: bool = typer.Option(
        False,
        "--check",
        help="report which role each profile resolves to on the box and whether the SSO sign-in is live; no login, no copy",
    ),
) -> None:
    """Log in to AWS SSO here (browser flow, one click), then push the SSO token cache + ~/.aws/config to the Spark so boto3 there is authenticated without a device code, and persist AWS_PROFILE/AWS_REGION there for every shell. ONE sign-in covers both machines.

    Sharing the sign-in is safe and deliberate. Identity Center does not rotate or invalidate a refresh token on use (verified 2026-09-26, and again 2026-10-10: the box renewed its copy 17h after the laptop had renewed the same one). What ends a sign-in on BOTH machines at once is the Identity Center portal-session lifetime, which no local file records -- `aws-sso-state` probes for it (see dotfiles/aws-sso-state.sh). A 2026-10-09 rewrite had the box mint its own sign-in via device code on a "competing lineage" theory; that doubled the logins, added a device-code step, and fixed nothing, so it was reverted.

    With `aws_batch_profile` set, one sign-in covers both profiles (they share an `sso-session`), and both are verified on the box. AWS_PROFILE stays the interactive profile; long jobs opt in with AWS_PROFILE=<batch profile>. `--check` is the pre-flight for a multi-hour run.
    """
    c = cfg.load()
    profile = profile or c.aws_profile or os.environ.get("AWS_PROFILE", "")
    region = region or c.aws_region
    if not profile:
        raise typer.BadParameter("no SSO profile: pass --profile, set aws_profile in the config, or export AWS_PROFILE")
    profiles = [profile] + ([c.aws_batch_profile] if c.aws_batch_profile else [])

    if not check:
        aws_dir = Path.home() / ".aws"
        if not skip_login:
            _run(["aws", "sso", "login", "--profile", profile])
        _remote(c, "mkdir -p ~/.aws/sso/cache && chmod 700 ~/.aws")
        # This machine's profiles are MERGED into the box's config, not copied over it: sections defined
        # here win, sections that exist only on the box (e.g. a Roles Anywhere profile whose cert paths
        # exist only there) are kept verbatim. The box's previous config is kept as config.spark-auth-bak.
        fetched = _run([*_ssh_base(c), _bash("cat ~/.aws/config 2>/dev/null || true")], capture=True)
        merged, kept = _merge_aws_config((aws_dir / "config").read_text(), fetched.stdout)
        _run(
            [
                *_ssh_base(c),
                _bash("[ -f ~/.aws/config ] && cp -p ~/.aws/config ~/.aws/config.spark-auth-bak; cat > ~/.aws/config"),
            ],
            stdin=merged,
        )
        if kept:
            typer.secho(f"kept box-only AWS sections: {', '.join(kept)}", fg="bright_black", err=True)
        # --update, no --delete: a token the box refreshed is newer than ours and must survive, and cache
        # files for other sessions on the box aren't ours to remove. Agents on the box are hook-blocked
        # from `aws sso login` (~/.claude/hooks/block_sso_login.py); this push is how the box gets signed in.
        _run([*_rsync(c), "-a", "--update", f"{aws_dir}/sso/cache/", f"{c.target}:~/.aws/sso/cache/"])
        _persist_remote_env(c, {"AWS_PROFILE": profile, "AWS_REGION": region})

    typer.echo("On the Spark:")
    if not _aws_report(c, profiles):
        if c.aws_batch_profile:
            typer.echo(
                f"  If {c.aws_batch_profile} is 'not found' on the box, run `spark auth aws` without --check: the "
                "profile only reaches the box when your config is copied. If it's found but denied, its "
                "permission set isn't assigned to you on that account yet (Identity Center -> AWS accounts)."
            )
        raise typer.Exit(1)
    if not check:
        typer.secho(
            "Spark is authenticated. Open a new shell/tmux pane for AWS_PROFILE to apply, and restart any running "
            "gateway there — cached boto3 clients don't rebind.",
            fg="green",
        )


@auth_app.command("mcp")
def auth_mcp(
    extra: list[int] = typer.Option([], "--port", help="forward an additional callback port (repeatable)"),
) -> None:
    """Hold open the OAuth callback forward so `/mcp` authentication on the box can complete, then close it.

    Claude Code serves its callback on localhost:54545. Running headless that listener is on the BOX's loopback, while the browser finishing the flow redirects to THIS machine's — two different machines both called localhost, so the flow never closes.

    This is a separate, short-lived command rather than part of every session on purpose: a Claude Code running locally uses the same port, so a permanent forward would stop it binding, or would silently tunnel a LOCAL login to the box. Hold the forward only while you need it.
    """
    c = cfg.load()
    typer.secho(
        f"Forwarding {', '.join(str(p) for p in dict.fromkeys([c.oauth_port, c.mcp_remote_port, *extra]))} to the box. Leave this running.",
        fg="green",
    )
    typer.echo("  1. On the box:  /mcp  ->  authenticate")
    typer.echo("  2. Open the URL it prints in this Mac's browser and approve")
    typer.echo("  3. Ctrl-C here once it reports success\n")
    typer.secho("While this runs, MCP auth for a LOCAL Claude Code will not work.", fg="yellow")
    ports = [c.oauth_port, c.mcp_remote_port, *extra]
    forwards: list[str] = []
    for p in dict.fromkeys(ports):
        forwards += ["-L", f"{p}:127.0.0.1:{p}"]
    cmd = ["ssh", "-N", "-o", "ExitOnForwardFailure=yes", "-p", str(c.port), *_conn_opts(c), *forwards, c.target]
    try:
        _run(cmd, check=False)
    except KeyboardInterrupt:
        typer.echo("\nforward closed")


# rclone's local OAuth listener. The login runs ON the box, so its listener is on the box's loopback;
# forwarding the port for the length of the login lets this Mac's browser complete the redirect.
RCLONE_AUTH_PORT = 53682
RCLONE_AUTH_URL = r"http://127\.0\.0\.1:53682/auth\?"


@auth_app.command("drive")
def auth_drive(
    remote: str = typer.Option("gdrive", help="rclone remote name to (re)create on the box"),
    client_id: str = typer.Option(
        None, help="your own Google OAuth client id (Desktop app); the secret is prompted for, hidden"
    ),
) -> None:
    """Sign the box's rclone into Google Drive, read-only. Opens the consent page in this Mac's browser; the token lands only on the Spark (~/.config/rclone/rclone.conf), which then pulls files straight from Google -- nothing routes through this laptop.

    Pass --client-id to use your own OAuth client. rclone's built-in client is shared by every rclone user, heavily throttled, and being retired during 2026 -- once it is, remotes created without --client-id stop working until re-created with one. Re-running replaces the remote in place; `spark drive pull` then resumes where it stopped.
    """
    c = cfg.load()
    params = "scope=drive.readonly"
    if client_id:
        # Prompted rather than taken as a flag so it never lands in shell history.
        secret = typer.prompt("OAuth client secret", hide_input=True)
        params += f" client_id={shlex.quote(client_id)} client_secret={shlex.quote(secret)}"
    script = REMOTE_PATH + f"rclone config create {shlex.quote(remote)} drive {params}"
    _interactive_ssh_opening_url(c, _bash(script, login=True), RCLONE_AUTH_URL, local_forwards=(RCLONE_AUTH_PORT,))


# The authorize URL `claude auth login` prints; opened locally by `spark auth claude`.
CLAUDE_AUTH_URL = r"https://claude\.com/cai/oauth/authorize\?"

KEYCHAIN_SERVICE = "Claude Code-credentials"


@auth_app.command("claude")
def auth_claude(
    copy: bool = typer.Option(
        False,
        "--copy",
        help="copy this Mac's Claude Code OAuth credentials (macOS Keychain) to the Spark instead of logging in there",
    ),
) -> None:
    """Sign the Spark's Claude Code into your Anthropic subscription. Default: run `claude auth login` there over ssh and open its sign-in URL in THIS machine's browser automatically; the Spark gets its own token. `--copy` pushes the laptop's token instead: no browser step, but both machines then refresh the same token and can log each other out."""
    c = cfg.load()
    if not copy:
        _interactive_ssh_opening_url(c, REMOTE_PATH + "claude auth login", CLAUDE_AUTH_URL)
        return
    if platform.system() != "Darwin":
        raise typer.BadParameter("--copy reads the macOS Keychain; on Linux copy ~/.claude/.credentials.json by hand")
    creds = subprocess.run(
        ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], check=True, text=True, capture_output=True
    ).stdout.strip()
    json.loads(creds)  # refuse to ship something that isn't the credentials blob
    _run(
        [*_ssh_base(c), _bash("umask 077 && mkdir -p ~/.claude && cat > ~/.claude/.credentials.json")],
        capture=False,
        stdin=creds,
    )
    _remote(c, "claude auth status")


# --------------------------------------------------------------------------- clipboard

# Writes the clipboard's image to a file, or exits non-zero when the clipboard holds no image.
# `the clipboard as «class PNGf»` is the PNG flavour; TIFF ends up here from some apps, so the
# handler tries PNG first and falls back rather than failing on a screenshot from the wrong source.
_CLIPBOARD_PNG = """
on writeData(theData, thePath)
    set fh to open for access POSIX file thePath with write permission
    set eof fh to 0
    write theData to fh
    close access fh
end writeData
try
    writeData(the clipboard as «class PNGf», "%s")
on error
    try
        writeData(the clipboard as «class TIFF», "%s")
    on error
        error "no image on the clipboard" number 1
    end try
end try
"""


# What the clipboard holds while an upload is in flight, or when it fails. Short and plainly not
# a path, so a premature or failed paste is obvious in the prompt and quick to delete.
PASTE_UPLOADING = "UPLOADING"
PASTE_ERROR_UPLOAD = "ERROR: image upload failed"
PASTE_ERROR_NO_IMAGE = "ERROR: no image on the clipboard"


def _clip(text: str) -> None:
    subprocess.run(["pbcopy"], input=text, text=True, check=True)


def _notify(title: str, body: str) -> None:
    """Bound to a hotkey there is no terminal to print to, so say it with a notification instead."""
    subprocess.run(
        ["osascript", "-e", f"display notification {json.dumps(body)} with title {json.dumps(title)}"],
        check=False,
        capture_output=True,
    )


@app.command()
def paste(
    keep: bool = typer.Option(False, help="keep the local temp copy instead of deleting it"),
    notify: bool = typer.Option(
        False, "--notify", help="post a macOS notification (for hotkey use, where there is no terminal to read)"
    ),
    retain_days: int = typer.Option(14, help="delete uploads older than this many days on each run"),
) -> None:
    """Put the image on this Mac's clipboard onto the box and copy its REMOTE path back to your clipboard.

    Terminals transmit only text, and Claude Code reads images from the clipboard of the machine it runs on — which, over ssh, is the box's headless one. So pasting a screenshot into a remote Claude session cannot work. Claude does read an image from a path, though: run this, then press Cmd-V in the remote prompt to paste the path.
    """
    c = cfg.load()
    if platform.system() != "Darwin":
        raise typer.BadParameter("clipboard capture is macOS-only")
    stamp = datetime.now(tz=UTC).strftime("%Y%m%d-%H%M%S")
    local = Path(tempfile.gettempdir()) / f"clip-{stamp}.png"
    script = _CLIPBOARD_PNG % (local, local)
    if subprocess.run(["osascript", "-e", script], capture_output=True, text=True, check=False).returncode != 0:
        _clip(PASTE_ERROR_NO_IMAGE)
        if notify:
            _notify("No image on the clipboard", "Copy a screenshot first.")
        raise typer.BadParameter("no image on the clipboard (copy a screenshot first)")

    # A paste cannot block -- Cmd-V reads whatever is on the clipboard at that instant. So the
    # clipboard only ever holds the truth: a placeholder while the upload runs, the path once the
    # file has LANDED, an error if it never will. Claiming it before the transfer also stops a
    # quick local paste returning the stale screenshot during the second or two an upload takes.
    _clip(PASTE_UPLOADING)
    try:
        remote_dir = f"{_remote_home(c)}/clipboard"
        remote = f"{remote_dir}/{local.name}"
        # Prune old uploads in the same round trip; nothing else writes this directory.
        _remote(
            c,
            f"mkdir -p {shlex.quote(remote_dir)}; "
            f"find {shlex.quote(remote_dir)} -name 'clip-*.png' -mtime +{retain_days} -delete 2>/dev/null; true",
        )
        # rsync exits 0 only once the whole file is on the box, so the path is published after this.
        _run([*_rsync(c), "-az", str(local), f"{c.target}:{remote}"])
    except subprocess.CalledProcessError:
        _clip(PASTE_ERROR_UPLOAD)
        if notify:
            _notify("Upload failed", "Nothing landed on the box; your clipboard says ERROR.")
        raise
    _clip(remote)
    if not keep:
        local.unlink(missing_ok=True)
    if notify:
        _notify("Image uploaded", "Path copied — Cmd-V into the remote prompt")
    typer.secho(f"{remote}  (copied to your clipboard — Cmd-V into the remote prompt)", fg="green")


# --------------------------------------------------------------------------- chrome


def _chrome_up(c: cfg.Config) -> bool:
    import urllib.request

    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{c.chrome_port}/json/version", timeout=1):
            return True
    except OSError:
        return False


def _launch_chrome(c: cfg.Config, url: str | None) -> None:
    binary = (
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        if platform.system() == "Darwin"
        else "google-chrome"
    )
    cmd = [
        binary,
        f"--remote-debugging-port={c.chrome_port}",
        f"--user-data-dir={c.chrome_profile}",
        "--no-first-run",
        "--no-default-browser-check",
        url or f"http://{c.host}:3001",
    ]
    subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)


@app.command()
def chrome(
    url: str = typer.Argument(None, help="initial URL; default = the Spark's dev server over the tailnet"),
) -> None:
    """Launch a laptop Chrome with remote debugging on the configured port and a dedicated profile (Chrome >= 136 refuses debugging on the default profile). `spark ssh`/`tmux`/`mosh` do this for you when it isn't running. Dev servers run ON the Spark, so pages are reached by its tailnet address, not localhost."""
    c = cfg.load()
    _launch_chrome(c, url)
    typer.echo(f"Chrome listening on 127.0.0.1:{c.chrome_port}; the `spark tunnel` agent carries it to the Spark.")


# --------------------------------------------------------------------------- tunnel
#
# The Chrome reverse forward used to ride on whichever `spark ssh` opened first, so closing that tab
# -- or the laptop sleeping -- took the browser away from every agent on the box, and a dead
# session kept the remote port bound so the next one couldn't take it (silently, under
# LogLevel=ERROR). A dedicated `ssh -N` owned by launchd fixes both: it is nobody's terminal, it
# exits within ~45s of the link dying (ServerAlive), and launchd restarts it. ExitOnForwardFailure
# makes a still-held remote port a retry instead of a zombie tunnel that forwards nothing.

TUNNEL_LABEL = "com.spar-cli.chrome-tunnel"
TUNNEL_PLIST = Path.home() / "Library" / "LaunchAgents" / f"{TUNNEL_LABEL}.plist"
TUNNEL_LOG = Path.home() / "Library" / "Logs" / "spark-chrome-tunnel.log"

tunnel_app = typer.Typer(
    no_args_is_help=True,
    help="The persistent Chrome debug tunnel (a launchd agent) that lets agents on the Spark drive this laptop's Chrome.",
)
app.add_typer(tunnel_app, name="tunnel")


def _tunnel_argv(c: cfg.Config) -> list[str]:
    return [
        "/usr/bin/ssh",
        "-N",
        "-o",
        "BatchMode=yes",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ConnectTimeout=10",
        *KEEPALIVE_OPTS,
        "-p",
        str(c.port),
        *_conn_opts(c),
        "-R",
        f"{c.chrome_port}:127.0.0.1:{c.chrome_port}",
        c.target,
    ]


def _launchd_domain() -> str:
    return f"gui/{os.getuid()}"


def _tunnel_running() -> bool:
    out = subprocess.run(
        ["launchctl", "print", f"{_launchd_domain()}/{TUNNEL_LABEL}"], check=False, text=True, capture_output=True
    )
    return out.returncode == 0 and "state = running" in out.stdout


def _ensure_browser_path(c: cfg.Config) -> bool:
    """Make sure a Spark agent can reach a browser: start the debug Chrome if it isn't answering, and the tunnel agent if it's installed but stopped. Returns True when the caller must fall back to an inline -R (no agent installed, or not macOS)."""
    if not _chrome_up(c):
        _launch_chrome(c, None)
        typer.secho(f"started the debug Chrome on 127.0.0.1:{c.chrome_port}", fg="bright_black", err=True)
    if platform.system() != "Darwin" or not TUNNEL_PLIST.exists():
        return True
    if not _tunnel_running():
        # kickstart without -k: starts it if stopped, never kills a healthy tunnel.
        subprocess.run(
            ["launchctl", "kickstart", f"{_launchd_domain()}/{TUNNEL_LABEL}"], check=True, capture_output=True
        )
    return False


@tunnel_app.command("install")
def tunnel_install() -> None:
    """Install (or refresh) the launchd agent. Runs at login and restarts after sleep / network changes. Re-run after changing host, port or key in the config."""
    import plistlib

    if platform.system() != "Darwin":
        typer.secho(
            "launchd is macOS-only; elsewhere use `spark ssh` (inline forward) or a systemd user unit.",
            fg="red",
            err=True,
        )
        raise typer.Exit(1)
    c = cfg.load()
    TUNNEL_PLIST.parent.mkdir(parents=True, exist_ok=True)
    TUNNEL_LOG.parent.mkdir(parents=True, exist_ok=True)
    plist = {
        "Label": TUNNEL_LABEL,
        "ProgramArguments": _tunnel_argv(c),
        "RunAtLoad": True,
        "KeepAlive": True,
        # Retry pace while the Spark is unreachable or a dead session still holds the remote port.
        "ThrottleInterval": 15,
        "StandardOutPath": str(TUNNEL_LOG),
        "StandardErrorPath": str(TUNNEL_LOG),
    }
    domain = _launchd_domain()
    # bootout of a not-loaded agent is an expected "no such process"; the bootstrap below is what must succeed.
    subprocess.run(["launchctl", "bootout", f"{domain}/{TUNNEL_LABEL}"], check=False, capture_output=True)
    TUNNEL_PLIST.write_bytes(plistlib.dumps(plist))
    _run(["launchctl", "bootstrap", domain, str(TUNNEL_PLIST)])
    typer.secho(f"installed {TUNNEL_PLIST.name}; log: {TUNNEL_LOG}", fg="green")


@tunnel_app.command("status")
def tunnel_status() -> None:
    """Check every hop an agent's browser call takes: laptop Chrome, the tunnel agent, and 127.0.0.1:<port> as seen FROM the Spark."""
    c = cfg.load()
    ok = True
    chrome_ok = _chrome_up(c)
    typer.secho(
        f"laptop Chrome on :{c.chrome_port}: {'up' if chrome_ok else 'NOT RUNNING (spark chrome)'}",
        fg="green" if chrome_ok else "red",
    )
    ok &= chrome_ok
    if platform.system() == "Darwin":
        installed = TUNNEL_PLIST.exists()
        running = installed and _tunnel_running()
        state = (
            "running"
            if running
            else ("installed but NOT running (see log)" if installed else "not installed (spark tunnel install)")
        )
        typer.secho(f"tunnel agent: {state}", fg="green" if running else "red")
        ok &= running
    probe = subprocess.run(
        [
            *_ssh_base(c),
            _bash(f"curl --silent -m 3 -o /dev/null -w '%{{http_code}}' http://127.0.0.1:{c.chrome_port}/json/version"),
        ],
        check=False,
        text=True,
        capture_output=True,
    )
    remote_ok = probe.stdout.strip() == "200"
    typer.secho(
        f"Spark -> 127.0.0.1:{c.chrome_port}: {'answers' if remote_ok else 'NO ANSWER'}",
        fg="green" if remote_ok else "red",
    )
    ok &= remote_ok
    if not ok:
        raise typer.Exit(1)


@tunnel_app.command("uninstall")
def tunnel_uninstall() -> None:
    """Stop the agent and remove its plist; `spark ssh` falls back to the inline forward."""
    subprocess.run(["launchctl", "bootout", f"{_launchd_domain()}/{TUNNEL_LABEL}"], check=False, capture_output=True)
    TUNNEL_PLIST.unlink(missing_ok=True)
    typer.secho("tunnel agent removed", fg="green")


# --------------------------------------------------------------------------- files


def _rehome(path: str, local_home: str, remote_home: str) -> str:
    """Map a path the user typed onto the box's filesystem.

    Your shell expands `~` to YOUR home before this CLI ever sees the argument, so `~/src/x`
    arrives as `/Users/<you>/src/x` -- a path that exists only on the laptop. Anything under the
    laptop's home therefore means the same place under the box's home. A literal `~` (quoted, so
    the shell left it alone) is resolved here too, because every remote use is shlex-quoted and a
    quoted `~` would otherwise be taken as a directory literally named "~".
    """
    if path == "~" or path.startswith("~/"):
        return remote_home + path[1:]
    if path == local_home or path.startswith(local_home + "/"):
        return remote_home + path[len(local_home) :]
    return path


@app.command()
def pull(src: str, dest: Path = typer.Argument(Path("."), help="local path")) -> None:
    """rsync a remote file/dir from the Spark. `~` and paths under your laptop's home are re-homed to the box's, so `spark pull ~/src/x .` does what it looks like."""
    c = cfg.load()
    src = _rehome(src, str(Path.home()), _remote_home(c))
    _run([*_rsync(c), "-az", "--progress", f"{c.target}:{src}", str(dest)])


# Architecture-specific or regenerable: rebuilt on the Spark (`uv run sync`, `npm install`), never copied.
SYNC_EXCLUDES = [
    ".venv",
    "venv",
    "node_modules",
    "__pycache__",
    ".pytest_cache",
    ".ruff_cache",
    ".mypy_cache",
    ".ty_cache",
    ".next",
    ".turbo",
    "*.pyc",
    ".DS_Store",
    # Fleet worktrees (`uv run worktree new`) are throwaway checkouts, each with its own venv — 34 GB of them on one laptop.
    ".claude/worktrees",
    # Local emulator state and build output.
    "localstack-data",
    "dist",
]


@app.command()
def push(
    source: Path = typer.Argument(..., help="local file or directory"),
    target: str = typer.Argument(
        None, help="remote path; default = the same path relative to $HOME (~/src/foo -> ~/src/foo)"
    ),
    delete: bool = typer.Option(
        False,
        help="also delete remote files missing locally (off by default; repos already cloned there would otherwise be clobbered mid-work)",
    ),
    no_exclude: bool = typer.Option(False, help="copy venvs/node_modules/caches too (normally rebuilt on the Spark)"),
    dry_run: bool = typer.Option(False, help="show what would transfer"),
) -> None:
    """Mirror a local path onto the Spark (resumable; caches and venvs excluded), then re-point any copied symlinks that target the laptop's absolute home at the Spark's home. `spark push ~/src` moves everything. The inverse is `spark pull`; `spark sync <tool>` is for tool state, not paths."""
    c = cfg.load()
    source = source.expanduser().resolve()
    if not source.exists():
        raise typer.BadParameter(f"{source} does not exist")
    local_home = str(Path.home())
    remote_home = _remote_home(c)
    if target is None:
        if not source.is_relative_to(local_home):
            raise typer.BadParameter("source is outside $HOME; pass an explicit target")
        target = "~/" + source.relative_to(local_home).as_posix()
    target = _rehome(target, local_home, remote_home)
    # Trailing slash on a directory = copy its contents INTO target, so ~/src -> ~/src is a mirror, not ~/src/src.
    src_arg = f"{source}/" if source.is_dir() else str(source)
    cmd = [*_rsync(c), "-az", "--progress", "--partial", "--human-readable"]
    if not no_exclude:
        for pattern in SYNC_EXCLUDES:
            cmd += ["--exclude", pattern]
    if delete:
        cmd.append("--delete")
    if dry_run:
        cmd += ["--dry-run", "--itemize-changes"]
    _remote(c, f"mkdir -p {shlex.quote(target if source.is_dir() else str(Path(target).parent))}")
    cmd += [src_arg, f"{c.target}:{target}"]
    _run(cmd)
    if dry_run or not source.is_dir():
        return
    # rsync -a preserves symlinks verbatim, so `_fe -> /Users/<me>/src/...` is dangling on Linux until re-homed.
    fix = (
        f"find {shlex.quote(target)} -type l -lname {shlex.quote(local_home + '/*')} -print0 | "
        f'while IFS= read -r -d \'\' l; do t=$(readlink "$l"); ln -sfn "{remote_home}${{t#{local_home}}}" "$l"; echo "relinked $l"; done'
    )
    _remote(c, fix)
    typer.secho(f"{source} -> spark:{target}. Rebuild per-repo envs there: `uv run sync` / `npm install`.", fg="green")


# --------------------------------------------------------------------------- sync <tool>

# --------------------------------------------------------------------------- drive

drive_app = typer.Typer(
    no_args_is_help=True,
    help="Pull Google Drive folders straight onto the Spark with rclone (sign in first: `spark auth drive`).",
)
app.add_typer(drive_app, name="drive")

DRIVE_LOG_DIR = ".cache/spark-drive"


def _drive_folder_id(ref: str) -> str:
    """A folder id from a Drive URL (.../folders/<id>?usp=...) or a bare id."""
    import re

    m = re.search(r"/folders/([A-Za-z0-9_-]+)", ref)
    folder = m.group(1) if m else ref
    if not re.fullmatch(r"[A-Za-z0-9_-]{10,}", folder):
        typer.secho(f"not a Drive folder URL or id: {ref}", fg="red", err=True)
        raise typer.Exit(2)
    return folder


def _remote_path(path: str) -> str:
    """A destination for double-quoting in a remote script. Same mapping as push/pull (`_rehome`): the local shell has usually already expanded `~` to /Users/<you>, so anything under this laptop's home lands under the box's $HOME, which the remote shell expands."""
    return _rehome(path, str(Path.home()), "$HOME")


@drive_app.command("pull")
def drive_pull(
    folder: str = typer.Argument(..., help="Drive folder URL or id (a folder shared with you works)"),
    dest: str = typer.Argument(
        ..., help="destination directory ON THE SPARK, e.g. ~/spark-ml/ivans-ft/pierce_assurely"
    ),
    remote: str = typer.Option("gdrive", help="rclone remote (see `spark auth drive`)"),
    transfers: int = typer.Option(8, help="parallel file transfers"),
    dry_run: bool = typer.Option(False, "--dry-run", help="list what would be copied, copy nothing"),
) -> None:
    """Copy a Drive folder onto the Spark in a detached tmux session, so it survives this terminal closing. `rclone copy` is idempotent: re-running resumes and fetches only what's missing or changed. Watch it with `spark drive status`."""
    c = cfg.load()
    fid = _drive_folder_id(folder)
    session = f"drive-{fid[:8]}"
    log = f"$HOME/{DRIVE_LOG_DIR}/{fid}.log"
    rdest = _remote_path(dest)
    rc = [
        "rclone", "copy", f"{remote}:", f'"{rdest}"', f"--drive-root-folder-id={fid}",
        f"--transfers={transfers}", "--checkers=16", "--stats=30s", "--stats-one-line",
        "--log-level=INFO", f'--log-file="{log}"',
    ]  # fmt: skip
    if dry_run:
        rc.append("--dry-run")
    # The tmux session ends when rclone does; the exit code is appended so `status` can tell done from failed.
    job = REMOTE_PATH + f'{" ".join(rc)}; echo "rclone exited $?" >> "{log}"'
    script = (
        f'mkdir -p "$HOME/{DRIVE_LOG_DIR}" "{rdest}" || exit 1; '
        f"rclone about {shlex.quote(remote + ':')} >/dev/null "
        f"|| {{ echo 'rclone remote {remote} is not signed in: run spark auth drive' >&2; exit 3; }}; "
        f"tmux has-session -t {session} 2>/dev/null && {{ echo 'already running: {session}'; exit 0; }}; "
        f"tmux new-session -d -s {session} {shlex.quote(_bash(job))} && "
        f'echo "started tmux session {session}; log {log}"'
    )
    # The remote script already printed why it stopped; pass its exit code on without a traceback.
    result = _run([*_ssh_base(c), _bash(REMOTE_PATH + script, login=True)], check=False)
    raise typer.Exit(result.returncode)


@drive_app.command("status")
def drive_status(lines: int = typer.Option(3, help="log lines per job")) -> None:
    """Every pull's progress: running or finished (with rclone's exit code) and its latest stats lines."""
    c = cfg.load()
    script = (
        f'found=0; for f in "$HOME/{DRIVE_LOG_DIR}"/*.log; do [ -e "$f" ] || continue; found=1; '
        'id=$(basename "$f" .log); s="drive-${id:0:8}"; '
        'if tmux has-session -t "$s" 2>/dev/null; then st=running; '
        'else st=$(grep -o "rclone exited [0-9]*" "$f" | tail -1); st=${st:-stopped}; fi; '
        'echo "== $id  [$st]"; '
        f'grep -E ", ETA |ERROR|rclone exited" "$f" | tail -{lines}; done; '
        '[ "$found" = 1 ] || echo "no drive pulls yet"'
    )
    _remote(c, script)


sync_app = typer.Typer(
    no_args_is_help=True,
    help="Keep a tool's state in step between the laptop and the Spark: `spark sync claude`, `spark sync dotfiles` (sparkbar + its sampler service, tmux-osc52, starship.toml). One subcommand per tool — editors and other agents get their own as they are needed. For plain files and directories use `spark push` / `spark pull` instead.",
)
app.add_typer(sync_app, name="sync")


CLAUDE_FILES = ["CLAUDE.md", "settings.json", "keybindings.json", "RTK.md"]
# The chrome-devtools MCP on the Spark talks to the laptop's Chrome through the `spark tunnel` reverse forward.
CHROME_DEVTOOLS_MCP = (
    "claude mcp remove --scope user chrome-devtools >/dev/null 2>&1; "
    "claude mcp add --scope user chrome-devtools -- "
    "npx -y chrome-devtools-mcp@latest --browser-url=http://127.0.0.1:{port}"
)


def _remote_home(c: cfg.Config) -> str:
    # Plain bash (no login shell) so nothing in ~/.profile can pollute the captured value.
    return _run([*_ssh_base(c), _bash('printf %s "$HOME"')], capture=True).stdout.strip()


def _spark_settings_overrides(text: str) -> str:
    """Spark-only tweaks to the laptop settings.json. The chrome-devtools PLUGIN launches its own Chrome, which the Spark doesn't have; there a user-scope `chrome-devtools` MCP server with `--browser-url=http://127.0.0.1:9222` (the `spark tunnel` forward to the laptop's `spark chrome`) takes its place, so the plugin is disabled to avoid two servers with one name."""
    settings = json.loads(text)
    plugins = settings.setdefault("enabledPlugins", {})
    for key in list(plugins):
        if key.startswith("chrome-devtools-mcp@"):
            plugins[key] = False
    return json.dumps(settings, indent=2) + "\n"


def _memory_dir_name(project_path: str) -> str:
    # Claude Code keys ~/.claude/projects/<dir> by the absolute project path with '/' -> '-'.
    return project_path.replace("/", "-")


def _merge_memory(c: cfg.Config, local_mem: Path, remote_mem: str) -> None:
    """Merge the project memory dir both ways, whichever direction the sync runs.

    It used to be mirrored with --delete, which is only safe while one machine is the sole writer.
    Agents on BOTH machines write memories, so the dirs drift (observed 2026-09-26: 113 notes on the
    box, 98 here), and a mirror in either direction silently deleted the other side's notes. Now:
    notes are copied both ways, --update so the newer copy of a note wins and nothing is ever
    deleted; the MEMORY.md index -- which both sides append to -- is merged as a union of lines
    (this side's order first, then lines only the other side has). Removing a memory is therefore
    a deliberate act on both machines, never a side effect of syncing.
    """
    local_mem.mkdir(parents=True, exist_ok=True)
    _remote(c, f"mkdir -p {shlex.quote(remote_mem)}")
    notes = [*_rsync(c), "-az", "--update", "--exclude=MEMORY.md"]
    _run([*notes, f"{local_mem}/", f"{c.target}:{remote_mem}/"])
    _run([*notes, f"{c.target}:{remote_mem}/", f"{local_mem}/"])

    index = local_mem / "MEMORY.md"
    ours = index.read_text().splitlines() if index.exists() else []
    fetched = _run([*_ssh_base(c), _bash(f"cat {shlex.quote(remote_mem)}/MEMORY.md 2>/dev/null || true")], capture=True)
    seen = set(ours)
    theirs_only = [line for line in fetched.stdout.splitlines() if line.strip() and line not in seen]
    merged = "\n".join([*ours, *theirs_only]) + "\n"
    index.write_text(merged)
    _run([*_ssh_base(c), _bash(f"cat > {shlex.quote(remote_mem)}/MEMORY.md")], stdin=merged)
    if theirs_only:
        typer.secho(f"MEMORY.md: merged {len(theirs_only)} index line(s) from the box", fg="bright_black", err=True)


@sync_app.command("claude")
def sync_claude(
    project: str = typer.Option(
        None, help="project path relative to $HOME on both machines (default: claude_project from config)"
    ),
    direction: str = typer.Option("push", help="push (laptop -> Spark) or pull (Spark -> laptop)"),
    init: bool = typer.Option(
        False, "--init", help="also do the one-time Spark-side setup (register the chrome-devtools MCP), then push"
    ),
) -> None:
    """Copy Claude Code's state between the machines: the global config files, the project's memory dir, and every past session (transcripts plus their subagent/tool-result/workflow sidecars, so the resume list is populated). The project dir is re-keyed for the other machine's absolute path."""
    c = cfg.load()
    project = project or c.claude_project
    if direction not in {"push", "pull"}:
        raise typer.BadParameter("direction must be push or pull")
    if init and direction != "push":
        raise typer.BadParameter("--init sets up the Spark, so it only makes sense with --direction push")
    local_home = str(Path.home())
    remote_home = _remote_home(c)
    local_proj = Path(local_home) / ".claude" / "projects" / _memory_dir_name(f"{local_home}/{project}")
    remote_proj = f"{remote_home}/.claude/projects/{_memory_dir_name(f'{remote_home}/{project}')}"
    local_mem = local_proj / "memory"
    remote_mem = f"{remote_proj}/memory"
    # A session is its *.jsonl plus a same-named dir of subagent transcripts, offloaded tool results and
    # workflow runs, which a resumed session can still reference. memory/ is excluded because it is merged
    # separately (_merge_memory). Never --delete here: each machine keeps its own sessions alongside the other's.
    transcripts = [*_rsync(c), "-az", "--progress", "--partial", "--exclude=memory/"]

    if direction == "push":
        _remote(c, f"mkdir -p {shlex.quote(remote_mem)} ~/.claude")
        if init:
            _remote(c, CHROME_DEVTOOLS_MCP.format(port=c.chrome_port))
        _run([*transcripts, f"{local_proj}/", f"{c.target}:{remote_proj}/"])
        for name in CLAUDE_FILES:
            path = Path(local_home) / ".claude" / name
            if not path.exists():
                continue
            # settings.json carries absolute paths (additionalDirectories, plugin roots); re-home them for the Spark.
            text = path.read_text().replace(local_home, remote_home)
            if name == "settings.json":
                text = _spark_settings_overrides(text)
            staged = Path(tempfile.gettempdir()) / f"spark-claude-{name}"
            staged.write_text(text)
            _run([*_scp(c), str(staged), f"{c.target}:~/.claude/{name}"])
        _merge_memory(c, local_mem, remote_mem)
    else:
        local_mem.mkdir(parents=True, exist_ok=True)
        for name in CLAUDE_FILES:
            _run([*_scp(c), f"{c.target}:~/.claude/{name}", str(Path(local_home) / ".claude" / name)], check=False)
        _merge_memory(c, local_mem, remote_mem)
        _run([*transcripts, f"{c.target}:{remote_proj}/", f"{local_proj}/"])
    typer.secho(f"claude config, memory and sessions {direction}ed ({local_proj} <-> {remote_proj})", fg="green")


DOTFILES = Path(__file__).resolve().parent.parent / "dotfiles"
# Helpers the box's tmux calls, installed to ~/.local/bin exactly as the bootstrap does (same source files, same names).
DOTFILE_BINS = {"sparkbar.sh": "sparkbar", "tmux-osc52.sh": "tmux-osc52", "aws-sso-state.sh": "aws-sso-state"}
# Read by the shared starship.toml, so it has to exist on the laptop too.
LAPTOP_BINS = {"aws-sso-state.sh": "aws-sso-state"}
# The bootstrap copies tmux.conf only when the box has none; sync pushes it unconditionally and re-sources it.
TMUX_CONF = "tmux.conf"
# Sampler for sparkbar's history; runs under the systemd user manager so it keeps sampling while no tmux client is attached.
SAMPLER_UNIT = "sparkbar-sampler.service"
STARSHIP_LINK = "~/.config/starship.toml"


@sync_app.command("dotfiles")
def sync_dotfiles() -> None:
    """Push the shell-chrome files to the Spark: `dotfiles/sparkbar.sh` and `dotfiles/tmux-osc52.sh` into the box's `~/.local/bin` (what the bootstrap installs, re-run without the rest of the bootstrap), and the laptop's starship.toml onto the box's; `aws-sso-state` is also installed into the LAPTOP's `~/.local/bin`, because the shared starship.toml calls it on both machines. starship.toml is a symlink into the `conf` checkout on BOTH machines, so each side is resolved with `readlink -f` and the real file is copied -- this pushes the laptop's WORKING TREE, not a commit; conf is dirty on both machines by design, and the two status indicators (sparkbar's cloud, starship's cloud) must agree, so they move together. Also pushes `dotfiles/tmux.conf` to `~/.tmux.conf` (the bootstrap only seeds it when absent) and re-sources it in the running server, then refreshes the status line so the new sparkbar shows on the next tick."""
    c = cfg.load()
    for src, name in DOTFILE_BINS.items():
        path = DOTFILES / src
        if not path.exists():
            raise typer.BadParameter(f"{path} missing -- is this an editable install of the spar-cli checkout?")
    local_starship = Path(STARSHIP_LINK).expanduser()
    if not local_starship.exists():
        raise typer.BadParameter(f"{local_starship} not found on the laptop")
    local_starship = local_starship.resolve()
    remote_starship = _run([*_ssh_base(c), _bash(f"readlink -f {STARSHIP_LINK}")], capture=True).stdout.strip()
    if not remote_starship:
        raise typer.BadParameter(f"{STARSHIP_LINK} not found on the Spark -- link it to the conf checkout first")

    local_bin = Path.home() / ".local" / "bin"
    local_bin.mkdir(parents=True, exist_ok=True)
    for src, name in LAPTOP_BINS.items():
        _run(["install", "-m", "755", str(DOTFILES / src), str(local_bin / name)])
    _remote(c, "mkdir -p ~/.local/bin")
    for src, name in DOTFILE_BINS.items():
        # scp onto the live path, then install-style mode: tmux re-reads the script each tick, so no restart.
        _run([*_scp(c), str(DOTFILES / src), f"{c.target}:~/.local/bin/{name}"])
    _remote(c, "chmod 755 " + " ".join(f"~/.local/bin/{n}" for n in DOTFILE_BINS.values()))
    _run([*_scp(c), str(local_starship), f"{c.target}:{remote_starship}"])
    _run([*_scp(c), str(DOTFILES / TMUX_CONF), f"{c.target}:~/.tmux.conf"])
    _remote(c, "mkdir -p ~/.config/systemd/user")
    _run([*_scp(c), str(DOTFILES / SAMPLER_UNIT), f"{c.target}:~/.config/systemd/user/{SAMPLER_UNIT}"])
    # Restart (not just enable) so a changed sparkbar.sh is what the loop runs from now on.
    _remote(
        c,
        f"systemctl --user daemon-reload && systemctl --user enable --now {SAMPLER_UNIT} && systemctl --user restart {SAMPLER_UNIT}",
    )
    _remote(c, "tmux source-file ~/.tmux.conf 2>/dev/null; tmux refresh-client -S 2>/dev/null; true")
    typer.secho(
        f"dotfiles pushed: {', '.join(DOTFILE_BINS.values())} -> ~/.local/bin, {SAMPLER_UNIT} (restarted), {local_starship} -> {remote_starship}",
        fg="green",
    )


# --------------------------------------------------------------------------- raycast

raycast_app = typer.Typer(
    no_args_is_help=True,
    help="The Raycast extension in raycast/: jump to Claude, send it a message, open its agents view, start sessions, switch panes and repos -- all against the `spark layout` shape of the tmux session.",
)
app.add_typer(raycast_app, name="raycast")

RAYCAST_DIR = Path(__file__).resolve().parent.parent / "raycast"
# A second ssh alias, not the one in `spark`'s own options: multiplexed over a persistent master so a
# tmux command round-trips in ~40ms instead of a fresh handshake. Kept apart from `Host spark` so
# Zed/Rune/mosh sessions never share the socket.
CTL_HOST = "spark-ctl"
SSH_BLOCK_BEGIN = "# >>> spark raycast (regenerated by `spark raycast install`) >>>"
SSH_BLOCK_END = "# <<< spark raycast <<<"
GHOSTTY_CONFIG = Path.home() / "Library" / "Application Support" / "com.mitchellh.ghostty" / "config"
GHOSTTY_LINE = "macos-applescript = true"


def _ssh_control_block(c: cfg.Config) -> str:
    lines = [
        SSH_BLOCK_BEGIN,
        f"Host {CTL_HOST}",
        f"    Hostname {c.host}",
        f"    Port {c.port}",
        "    IdentitiesOnly yes",
        "    BatchMode yes",
        "    ConnectTimeout 5",
        "    ControlMaster auto",
        "    ControlPath ~/.ssh/cm-%r@%h:%p",
        "    ControlPersist 4h",
        *(f"    {o.replace('=', ' ')}" for o in KEEPALIVE_OPTS[1::2]),
    ]
    if c.user:
        lines.insert(2, f"    User {c.user}")
    if c.identity_file:
        lines.insert(3, f"    IdentityFile {c.identity_file}")
    return "\n".join([*lines, SSH_BLOCK_END]) + "\n"


def _replace_block(text: str, begin: str, end: str, block: str) -> str:
    start, stop = text.find(begin), text.find(end)
    if start >= 0 and stop > start:
        return text[:start] + block + text[stop + len(end) + 1 :]
    return text.rstrip("\n") + ("\n\n" if text.strip() else "") + block


def _register_raycast_extension() -> None:
    """`ray build` only writes files; the running Raycast app learns about a local extension from `ray develop`,
    which registers it and then sits watching for changes. The registration outlives the process, so run it
    until it reports the build, then stop it."""
    cmd = ["npx", "ray", "develop", "-I"]
    typer.secho("$ " + " ".join(cmd), fg="bright_black", err=True)
    proc = subprocess.Popen(cmd, cwd=RAYCAST_DIR, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    assert proc.stdout is not None
    built = False
    try:
        for line in proc.stdout:
            typer.echo(line.rstrip(), err=True)
            if "built extension successfully" in line:
                built = True
                break
            if "error" in line.lower() and "warn" not in line.lower():
                break
    finally:
        proc.terminate()
        proc.wait(timeout=10)
    if not built:
        raise typer.BadParameter("ray develop did not report a successful build -- see the output above")


@raycast_app.command("install")
def raycast_install() -> None:
    """Set up everything the extension needs, idempotently: (1) the `spark-ctl` alias in ~/.ssh/config with ControlMaster, regenerated from the spark config; (2) `macos-applescript = true` in the Ghostty config, so Raycast can focus the mosh tab -- Ghostty must be restarted once after this; (3) `npm install` + `ray develop` in raycast/ until it reports the build, which registers the extension with the running Raycast (plain `ray build` writes files Raycast never notices). Re-run after editing the extension or changing host/port."""
    c = cfg.load()
    ssh_config = Path.home() / ".ssh" / "config"
    old = ssh_config.read_text() if ssh_config.exists() else ""
    ssh_config.parent.mkdir(mode=0o700, exist_ok=True)
    ssh_config.write_text(_replace_block(old, SSH_BLOCK_BEGIN, SSH_BLOCK_END, _ssh_control_block(c)))
    typer.secho(f"~/.ssh/config: Host {CTL_HOST} -> {c.target}:{c.port} (ControlMaster)", fg="green")

    restart = False
    if GHOSTTY_CONFIG.exists():
        text = GHOSTTY_CONFIG.read_text()
        if not any(line.split("#")[0].strip() == GHOSTTY_LINE for line in text.splitlines()):
            GHOSTTY_CONFIG.write_text(
                text.rstrip("\n")
                + f"\n\n# Raycast drives tabs via AppleScript (`spark raycast install`).\n{GHOSTTY_LINE}\n"
            )
            restart = True
        typer.secho(
            f"{GHOSTTY_CONFIG}: {GHOSTTY_LINE}" + (" (added -- restart Ghostty)" if restart else ""), fg="green"
        )
    else:
        typer.secho(f"{GHOSTTY_CONFIG} not found: add `{GHOSTTY_LINE}` to your Ghostty config by hand", fg="yellow")

    if not (RAYCAST_DIR / "package.json").exists():
        raise typer.BadParameter(f"{RAYCAST_DIR} missing -- is this an editable install of the spar-cli checkout?")
    _run(["npm", "install", "--no-audit", "--no-fund"], cwd=RAYCAST_DIR)
    _register_raycast_extension()
    _run(["ssh", CTL_HOST, "true"], check=False)  # warm the control socket so the first Raycast call is fast
    typer.secho(
        "Raycast extension 'Spark' installed. Commands: Go to Claude, Send to Claude, Claude Agents Page, Search Claude Agents, New Claude Session, Go to Shell Pane, Go to Repo. "
        f"Its tmux session preference defaults to c1; set it to tmux_session ({c.tmux_session}) if they differ.",
        fg="green",
    )


# --------------------------------------------------------------------------- config


@app.command()
def init() -> None:
    """Write a default ~/.config/spark/config.toml to edit."""
    if cfg.CONFIG_PATH.exists():
        typer.echo(f"{cfg.CONFIG_PATH} already exists")
        raise typer.Exit(1)
    typer.echo(f"wrote {cfg.write_default()}")


if __name__ == "__main__":
    sys.exit(app())
