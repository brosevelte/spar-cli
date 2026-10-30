# spar-cli

`spark` — a laptop-side CLI for working on a shared Linux box over Tailscale (built for a DGX Spark, but nothing in it is Spark-specific). It wraps the ssh/scp/rsync incantations you'd otherwise retype, and carries the fixes for the things that quietly break when your dev machine is at the other end of a tailnet: shell environment that ssh refuses to forward, terminal capabilities the remote doesn't know about, and auth that expires while you're asleep.

Everything shells out to the system `ssh`/`scp`/`rsync`, so your keys, `known_hosts` and agent behave exactly as they do in a terminal. Failures propagate — a non-zero exit on the remote is a non-zero exit here.

## Install

```bash
uv tool install --editable .   # puts `spark` on PATH, tracking this checkout
spark init                     # writes ~/.config/spark/config.toml
```

Then edit the config — `host` is the only required field:

```toml
host = "100.x.y.z"            # tailnet IP or MagicDNS name
user = ""                     # account on the box; empty = your local username
port = 2222                   # see "Two ways in" below
identity_file = "~/.ssh/spark"
tmux_session = "main"
chrome_port = 9222
aws_profile = ""              # for `spark auth aws`; empty = ambient AWS_PROFILE
aws_region = "us-east-1"
aws_batch_profile = ""        # e.g. "long-exec-ro"; read-only profile for long jobs
claude_project = "src/ultron-framework"   # for `spark sync claude`
```

Config is per-user, so several people can share one box, each with their own account and keys.

Once per laptop, after the config:

```bash
brew install mosh           # for `spark mosh`
spark tunnel install        # the Chrome forward for agents on the box, as a launchd agent
```

## Day to day

| you want | use | why |
|---|---|---|
| a long working session (Claude, dev servers, builds) | **`spark mosh --tmux [name]`** | tmux over mosh. Survives the laptop sleeping, wifi changes and roaming, and echoes locally so typing doesn't lag. Coming back after hours just resumes; a plain ssh session would be dead |
| the same over plain ssh (mosh blocked, or you need `-L` forwards) | `spark tmux [name]` | same tmux session, over TCP. Keepalives notice a dead link in ~45s instead of leaving a frozen-looking window |
| a quick throwaway shell | `spark ssh` | no tmux |
| one command | `spark run '<cmd>'` | streams output, exit code propagates |
| to check an agent can use the browser | `spark tunnel status` | tests every hop, laptop Chrome → tunnel → box |
| AWS before a long job | `spark auth aws --check` | both profiles, exits 1 if either is dead |

All three session verbs start the laptop's debug Chrome and the tunnel if either is down, so agents on the box can always drive a browser (see "Browser testing from the box").

## Two ways in, and why the default is port 2222

If the box runs **Tailscale SSH**, port 22 on its tailnet address is served by `tailscaled`, not `sshd`. That's convenient — it authenticates by tailnet identity, no keys — but on a tailnet whose policy uses `action: "check"`, access expires on a schedule (12h by default) and must be renewed through a browser URL. Clients that can't render that prompt just hang at `Trying none...` forever. On a *corporate* tailnet you can't fix that by editing the ACL.

So the CLI defaults to a second port served by plain OpenSSH with key auth, which no tailnet policy can expire:

| path | auth | fails when |
|---|---|---|
| `host:22` | Tailscale SSH, tailnet identity | the `check` window lapses |
| `host:2222` | OpenSSH + your key | never, while you hold the key |
| `<LAN IP>:22` | OpenSSH + your key | you're off the LAN |

Set `port = 22` in the config if your box has no Tailscale SSH and you want the normal thing.

## Verbs

| verb | what it does |
|---|---|
| `spark ssh` | plain interactive login shell. Starts the debug Chrome and the tunnel agent if they're down, so agents on the box can always drive a browser. Open as many as you like — but anything that must outlive the connection belongs in `spark tmux` |
| `spark mosh [--tmux] [name]` | a login shell over mosh: survives sleep, wifi changes and roaming. `--tmux` lands in the default session (`main`); `spark mosh --tmux fe` (or `spark mosh fe`) attaches-or-creates session `fe`. mosh can't forward ports, so it requires the `spark tunnel` agent for Chrome (and says so rather than silently going without). Inside tmux, `prefix N` prompts for a new session and `prefix s` switches between them |
| `spark tunnel install\|status\|uninstall` | the Chrome debug forward as a launchd agent: one `ssh -N -R 9222` that belongs to no terminal, notices a dead link in ~45s and is restarted by launchd. `status` checks every hop — laptop Chrome, the agent, and `127.0.0.1:9222` as seen from the Spark. Without it, `spark ssh`/`tmux` fall back to an inline forward that dies with that session |
| `spark tmux [name]` | attach-or-create a named tmux session (`main` by default). Survives dropped connections, so Claude, dev servers and long builds live here: `spark tmux main`, `spark tmux fe` |
| `spark run <cmd>` | run one command remotely and stream the output. A single argument goes to bash verbatim, so pipes and redirects work: `spark run 'ls ~/src \| wc -l'`. Several arguments are treated as argv and quoted individually |
| `spark status` | reachability, toolchain presence, running tmux sessions, bootstrap log tail |
| `spark auth aws [--check]` | `aws sso login` locally (normal browser flow), push the SSO token cache and `~/.aws/config`, and persist `AWS_PROFILE`/`AWS_REGION` remotely — no device-code flow on the box. With `aws_batch_profile` set, **one sign-in covers both profiles** (they share an `sso-session`) and both are verified on the box, printing the role each resolves to and whether the SSO sign-in is live (the ~1h access token renews itself from a refresh token, so there is no countdown to show — the real limit is Identity Center's session length). The batch profile's permission set must be assigned to you in Identity Center, or it reports `ForbiddenException: No access`. `AWS_PROFILE` stays the interactive profile; long jobs opt in with `AWS_PROFILE=<batch>`. `--check` does no login and no copy, and exits 1 if any profile fails — the pre-flight for a multi-hour run. Your config is **merged** into the box's, not copied over it: sections defined on the laptop win, sections only the box has (e.g. a Roles Anywhere profile whose cert paths exist only there) are kept verbatim, and the box's previous file is saved as `~/.aws/config.spark-auth-bak`. The token cache goes across with `--update`, so a newer token on the box is never replaced by an older one |
| `spark auth drive` | sign the box's rclone into Google Drive (read-only). The consent page opens in your Mac's browser; the token lives only on the Spark |
| `spark auth mcp` | hold open the OAuth callback forward (`localhost:54545`) so `/mcp` authentication on the box can complete in your browser. **Short-lived on purpose** — a Claude Code running locally uses the same port, so a permanent forward would stop it binding, or would silently tunnel a *local* login to the box. Ctrl-C when done |
| `spark auth claude [--copy]` | sign the remote Claude Code into your subscription. Default runs `claude auth login` there and **opens its sign-in URL in your local browser automatically** — the box has no browser, so the CLI watches the session output under a pty and opens the URL the moment it's printed, while keeping the session interactive in case it asks for a pasted code. The box gets its own token. `--copy` pushes this Mac's Keychain token instead — no browser, but both machines then refresh one token and can log each other out |
| `spark sync dotfiles` | push the shell chrome to the box: `dotfiles/sparkbar.sh`, `dotfiles/tmux-osc52.sh` and `dotfiles/aws-sso-state.sh` into `~/.local/bin`, and `dotfiles/sparkbar-sampler.service` into `~/.config/systemd/user` (enabled and restarted, so the loop runs the new script) (what the bootstrap installs; `aws-sso-state` also lands in the laptop's `~/.local/bin` since the shared prompt calls it), plus the laptop's `starship.toml` onto the box's (both are symlinks into the `conf` checkout; each side is `readlink -f`-resolved and the working-tree file is copied, not a commit). Also `dotfiles/tmux.conf` → `~/.tmux.conf`, re-sourced in the running server. Run it after editing any of these |
| `spark layout [name]` | give a tmux session the fixed shape everything else assumes: window `claude` with Claude Code in pane 1 and a shell in pane 2, both in `claude_project`. Idempotent: a session built by hand is adopted (the window holding Claude is renamed, auto-rename switched off), nothing running is touched, Claude is only started into a bare shell prompt. `spark mosh <name>` / `spark tmux` run it before attaching (`--no-layout` skips). See "Raycast" |
| `spark raycast install` | one-shot, idempotent setup for the Raycast extension in `raycast/`: the `spark-ctl` ssh alias (ControlMaster, regenerated from the config), `macos-applescript = true` in the Ghostty config, then `npm install` + `ray develop` (run until it reports the build, then stopped: that is what registers a local extension with the running Raycast; the registration persists). Re-run after editing the extension or changing host/port |
| `spark sync claude [--init] [--direction pull]` | keep Claude Code in step: global config, the project memory dir (**merged**, never mirrored — agents on both machines write memories, so notes copy both ways with the newer copy winning, nothing is deleted, and `MEMORY.md` is combined line by line). Past sessions are not copied — atuin syncs them continuously (`atuin threads search`, Ctrl+E for `atuin resume`), so this is a new-box step. `--init` also does one-time remote setup (registers the chrome-devtools MCP) |
| `spark push <src> [dest]` | mirror a local path up. Target defaults to the same path under `$HOME`. Resumable; excludes venvs/node_modules/caches/worktrees unless `--no-exclude`; never deletes without `--delete`; re-homes copied `/Users/...` symlinks to the remote `$HOME` |
| `spark pull <src> [dest]` | the inverse, for a file or directory |
| `spark drive pull <folder-url> <dest-on-spark> [--dry-run]` / `spark drive status` | copy a Drive folder straight onto the Spark (Google → box, never via the laptop) in a detached tmux session `drive-<id>`. Re-running resumes; `status` shows each pull's progress and exit code |
| `spark chrome [url]` | launch a local Chrome with remote debugging on a dedicated profile (Chrome ≥136 refuses it on the default profile). `spark ssh`/`tmux`/`mosh` start it for you; the `spark tunnel` forward lets the remote chrome-devtools MCP drive *your* browser |
| `spark paste [--notify] [--retain-days 14] [--keep]` | put the image on your Mac's clipboard onto the box and copy its REMOTE path back to your clipboard — see "Images" below |
| `spark init` | write the config template |

### Things the verbs quietly handle

- **`COLORTERM` isn't forwarded by ssh.** Without it, TUIs fall back to the fixed xterm-256 palette and ignore your terminal theme — diffs come out in garish primary red/green. The bootstrap sets it remotely.
- **Your terminal's terminfo may not exist on the box.** `spark ssh`/`tmux` compile the local entry into the remote `~/.terminfo` on demand, which is what stops tmux refusing to start with *"missing or unsuitable terminal: xterm-ghostty"*.
- **ssh hands the remote *login shell* one flattened string.** If that shell is fish, `VAR=x` is a syntax error and `(...)` is command substitution. Every remote script is wrapped in `bash -lc '<one quoted word>'`.
- **OAuth callbacks are a two-machine problem.** Claude Code serves its callback on `localhost:54545`; headless, that listener is on the *box's* loopback while the browser finishing the flow redirects to *yours*. `spark auth mcp` bridges them for as long as you leave it running. Anthropic tracks a configurable callback host as [#69326](https://github.com/anthropics/claude-code/issues/69326).
- **`~/.bashrc` returns early for non-interactive shells**, so PATH also goes in `~/.profile`, and the CLI sets it explicitly rather than trusting `-l`.
- **A slept laptop leaves zombie connections.** Every ssh the CLI opens sets `ServerAliveInterval 15` / `ServerAliveCountMax 3` (so does `Host spark` in the conf repo's ssh-config), and the box's sshd should set `ClientAlive*` (see "Steps that need sudo") — otherwise a dead session keeps its port forwards bound for hours and the next one can't take them.
- **Copy from tmux over mosh.** mosh forwards an OSC 52 clipboard write only when its selection field is exactly `c`; tmux's own copies send it empty and were silently dropped. `dotfiles/tmux-osc52.sh` is tmux's `copy-command` and re-sends them in the accepted form. Copies from apps in a pane (Claude Code, vim) already say `c`. Don't "fix" it with a `terminal-overrides` `Ms=` — tmux reuses Ms for pane passthrough, and every variant either stops tmux emitting or doubles the field to `cc`, which mosh also drops.

## Setting up a fresh box

Toolchain, no sudo, idempotent — safe to re-run:

```bash
spark push bootstrap/spark_bootstrap.sh '~/spark_bootstrap.sh'
spark run 'nohup bash ~/spark_bootstrap.sh > ~/bootstrap.log 2>&1 &'
```

Installs uv, node 22, Claude Code, gh (behind a keyring-free wrapper), aws cli v2, pulumi, git-lfs, graphite, ast-grep, fern, rclone; registers the chrome-devtools MCP; writes the PATH/`COLORTERM` block; installs `dotfiles/tmux.conf` if you have none, and always refreshes the helpers it calls (`sparkbar`, holman/spark, `tmux-osc52`). With `CONF_REPO=git@github.com:you/conf.git` it also clones your dotfiles repo and links the shell-agnostic parts (gitconfig, git ignore, gh, graphite). Org-specific repo wiring runs only if the repo exists, so on any other machine it's just a toolchain installer. Override paths with `FW=`, `FE=`, `MEM=`, `CONF_DIR=`.

Fish + prompt + plugins (needs `sudo apt install -y fish` first, the only sudo step):

```bash
spark push bootstrap/spark_fish.sh '~/spark_fish.sh' && spark run 'bash ~/spark_fish.sh'
```

Installs starship, fzf, fd, bat and atuin under `~/.local/bin`, links `config.fish`/`fish_plugins`/`starship.toml`/functions/completions from your conf repo, installs fisher and its plugins, and points tmux's `default-command` at fish. `chsh -s "$(command -v fish)"` is yours to run if you want plain ssh to be fish too.

Move tooling checkouts out of `~/src` (which should hold project repos only) and re-point every symlink:

```bash
bash bootstrap/relocate.sh ~/tools     # REPOS="conf spar-cli" by default
```

Symlinks are found by their *target*, so broken ones are still caught. Skipping this after moving `conf` silently breaks your shell, prompt and git identity.

### Steps that need sudo

Done once per box by a human:

- `sudo usermod -aG docker <user>`, then re-login.
- `docker run --privileged --rm tonistiigi/binfmt --install amd64` — if your images are `linux/amd64` on an arm64 box. The QEMU equivalent of Rosetta.
- `sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target`, plus a gdm dconf override — the *login screen* suspends the machine after 20 idle minutes otherwise, even with your own power settings changed.
- `sudo apt install -y fish mosh`.
- The extra SSH port, below.
- sshd keepalives, so a dead client's forwards are released in about a minute rather than hours (sshd reads config per connection, so no restart):
  ```bash
  echo -e "ClientAliveInterval 15\nClientAliveCountMax 4" | sudo tee /etc/ssh/sshd_config.d/20-keepalive.conf
  ```

## The extra SSH port

`dotfiles/ssh-extra-port.conf` adds port 2222 so OpenSSH is reachable independently of Tailscale SSH:

```bash
spark push dotfiles/ssh-extra-port.conf '~/ssh-extra-port.conf'
```
```bash
sudo mkdir -p /etc/systemd/system/ssh.socket.d
sudo install -m 644 -o root -g root ~/ssh-extra-port.conf /etc/systemd/system/ssh.socket.d/10-extra-port.conf
sudo systemctl daemon-reload && sudo systemctl restart ssh.socket
```

Three traps, all of which cost real time:

1. **sshd is socket-activated on Ubuntu 24.04** (`ssh.socket` active, `ssh.service` inactive *by design* — `systemctl is-enabled ssh` reporting "disabled" is a red herring). A `Port` line in `sshd_config` is **ignored**; ports come from the socket unit.
2. **A stale standalone `sshd -D [listener]`** from before socket activation will hold `:22` and make the restart fail with *"Address already in use"*. Find it with `pgrep -af '[s]shd'` and kill that PID.
3. **A bare `ListenStream=2222` binds IPv6 only.** Tailscale addresses are IPv4, so connections get refused. List `0.0.0.0:2222` and `[::]:2222` explicitly, as the base unit does for 22.

Then authorize your key:

```bash
ssh-copy-id -p 2222 user@host
```

## mosh from the Mac

`spark mosh` is a login shell over mosh, and `spark mosh --tmux [name]` is `spark tmux` over mosh — the same thing the phone does. The ssh leg (port 2222, your key) only bootstraps `mosh-server`; the session itself is UDP 60000–61000 on the tailnet, which survives sleep and roaming. mosh has no scrollback of its own, so long-lived work belongs in `--tmux`. If it fails with *"did not make a successful connection"*, the UDP leg is being blocked — check the macOS firewall allows `mosh-client`.

### When mosh buffers keystrokes: the Wi-Fi fixes

mosh echoes locally, so if typed characters arrive in bursts the link itself is stalling. Clean `ping` times do not rule the network out — the stalls below are periodic and fall between short samples. Before blaming the network, run `tmux list-clients` on the box: a second attached client (a phone, or an orphaned `mosh-server` from a session you closed) makes tmux size the window to it and redraw twice. Detach it with `tmux detach-client -t <tty>`, or attach from the laptop with `tmux attach -d` so the laptop always wins.

The box has an ethernet port but, as of October 2026, runs on Wi-Fi (MediaTek mt7925, `mt7925e` driver, connection `S13` on `wlP9s9`). Three things were wrong with that link, each fixed separately — all three were needed, and each one alone looked like "the network is fine now" until the next one surfaced.

| symptom | cause | fix (applied) |
|---|---|---|
| 90–700 ms round trips to the router from the box, with -39 dBm signal and an idle link | **Wi-Fi power save** on the adapter — it sleeps between beacons and every packet waits for a wake-up | `sudo iw dev wlP9s9 set power_save off` (immediate) and `sudo nmcli con mod S13 802-11-wireless.powersave 2` (persistent). 2026-10-01. Round trips went to ~3 ms |
| every **5 minutes**, the box falls off the network for 15–20 s, then everything arrives at once | NetworkManager's roaming **background scan** (wpa_supplicant `bgscan simple`, 300 s when signal is good). On most adapters a scan costs milliseconds per channel; the mt7925 freezes transmit for the whole sweep. Seen as `scan started` → `scan finished` 16 s apart in `iw event -t`, exactly bracketing the stall | pin the connection to the access point so there is nothing to roam to: `sudo nmcli con mod S13 802-11-wireless.bssid 66:83:e7:a0:d9:05 && sudo nmcli con up S13`. 2026-10-02. **Undo** (new router, or the box moves) with `802-11-wireless.bssid ""` |
| 60–95 ms spikes about **once per second**, from the *laptop* to the router, with the box's own pings clean | **AWDL** on the Mac (AirDrop / Handoff / Continuity) hopping the radio off-channel | temporary: `sudo ifconfig awdl0 down` (macOS re-enables it within minutes). Durable: turn AirDrop off in Control Center, and Handoff in System Settings → General → AirDrop & Handoff if the spikes return |

To tell which one you have, ping the router from each end and watch for the pattern — `ping -i 0.1 192.168.0.1` on the box, `ping -i 0.2 192.168.0.1` on the Mac — and on the box run `iw event -t` in another pane to see scans as they happen. The hourly `dhcp4 … new lease` lines in `journalctl -u NetworkManager` are routine lease renewals, not reconnects; `iw dev wlP9s9 station dump | grep 'connected time'` is the number that resets on a real drop.

The durable fix for all of the box's share is an ethernet cable. A direct laptop↔box cable (no run to the router) works: give each end a static address on a private subnet with no gateway, e.g. `sudo nmcli con mod "Wired connection 3" ipv4.method manual ipv4.addresses 10.10.0.2/24 ipv4.never-default yes ipv6.method link-local` on the box and `networksetup -setmanual "Ethernet Adapter (en4)" 10.10.0.1 255.255.255.0` on the Mac. Internet stays on Wi-Fi, and Tailscale discovers the direct path on its own so `spark mosh` uses the cable without a config change. `never-default` and the missing router on the Mac side are what stop one machine trying to route the internet through the other.

## Connecting from an iPhone (Blink)

Blink is the practical mobile client, and mosh makes it genuinely usable — the session survives lock/unlock, wifi↔cellular handoff and dead zones, and it echoes locally so typing doesn't lag on a bad link.

1. **Install the Tailscale app** and sign in, so the phone is a tailnet peer.
2. **Install mosh on the box**: `sudo apt install -y mosh`. Without `mosh-server`, Blink's mosh connection dies immediately after the SSH handshake.
3. **Generate a key in Blink**: Settings → Keys & Certificates → **+** → New Key → ED25519, name it `spark`. Blink keeps keys in its own keychain, *not* in a `~/.ssh` directory.
4. **Add the host** in Blink's `~/.ssh/config`:
   ```
   Host spark
       Hostname 100.x.y.z
       User <you>
       Port 2222
       IdentityFile spark
   ```
   `IdentityFile spark` is a bare key **name**, not a path — Blink resolves it from its keychain. Getting this wrong is the usual reason it silently falls back to asking for a password.
5. **Authorize the key**: `ssh-copy-id spark` (one last password prompt). Blink's `ssh-copy-id` takes a host alias and has no `-i` flag, so the host block must already carry the port and identity.
6. **Connect with mosh**: `mosh spark`.

Do **not** copy your laptop's `ssh-config` to the phone wholesale. `ForwardX11 yes` and `SetEnv DISPLAY=...` are meaningless on iOS, and an `IdentityFile ~/.ssh/id_ed25519` path won't resolve against Blink's keychain.

If it hangs at `Authenticating... Trying none...`, that's Tailscale SSH's `check` policy expiring, not a broken key — use port 2222.

## Dotfiles

- **`dotfiles/tmux.conf`** — copied to `~/.tmux.conf` by the bootstrap when you have none. Status bar on top, transparent (`bg=default`), carrying the box's vitals from `sparkbar` (`prefix + S` hides it); `focus-events on` (Claude Code asks for it), `escape-time 0` so ESC isn't sluggish over ssh, OSC 52 clipboard to the laptop (including over mosh, via `tmux-osc52`), 100k scrollback, mouse on, bar cursor (`cursor-style bar` + the `cstyle` terminal feature so the shape reaches the outer terminal). Copy-mode styling is overridden because tmux's stock `mode-style` is `bg=yellow` — with the mouse enabled, a stray drag paints a neon block across the screen that looks like a rendering bug.
- **`dotfiles/sparkbar.sh`** → `~/.local/bin/sparkbar` — the status bar: NET, CPU, MEM, GPU sparklines (drawn by [holman/spark](https://github.com/holman/spark)) plus an AWS cloud driven by `aws-sso-state` (below). `SPARKBAR_ORDER` / `SPARKBAR_SAMPLES` override order and history length.
- **`dotfiles/aws-sso-state.sh`** → `~/.local/bin/aws-sso-state` on BOTH machines — the one answer to "is AWS SSO signed in", read by sparkbar's cloud and by the prompt's cloud in `conf/starship.toml` so they never disagree. Prints `ok` (access token live), `idle` (lapsed, a renewal probe is in flight — not signed out, settles in seconds), `expired` (the probe failed or nothing is left to renew with: `spark auth aws` from the laptop; never `aws sso login` on the Spark, it is hook-blocked), or `none`. The probe exists because the refresh token is also bounded by the Identity Center *portal session*, which no local file records — on 2026-10-10 both machines showed "renewable" for hours after the session had ended. It is one read-only `sts get-caller-identity` per lapse, detached so the prompt never waits on the network; a failure is remembered against that token file and never retried, since only a new sign-in (a new file) can change the answer. Percentages use a fixed 0–100 scale so a tall bar always means real load; network autoscales. Fixed-width fields so the bar doesn't twitch.
- **`dotfiles/tmux-osc52.sh`** → `~/.local/bin/tmux-osc52` — tmux's `copy-command`; see "Copy from tmux over mosh" above.
- **`dotfiles/gh-wrapper.sh`** → `~/.local/bin/gh` — runs the real `gh.real` without a D-Bus session, because on a box with a desktop session gh otherwise tries the locked GNOME keyring, raises an unlock dialog on the physical monitor and hangs forever. Log in once with `gh auth login --insecure-storage`.
- **`dotfiles/find-mcp-auth-url.py`** — digs the pending MCP OAuth URL out of Claude Code's logs when the TUI won't show it.
- **`dotfiles/ssh-extra-port.conf`** — the systemd socket drop-in above.
- **`dotfiles/glyphtest.sh`** — renders candidate prompt glyph sets in your terminal's font, flush and spaced, so you can pick one by eye. Mixing a plain-text glyph with Nerd Font icons gives mismatched advance widths and they visually collide.

## Raycast: driving the mosh → tmux session from the launcher

`raycast/` is a small Raycast extension ("Spark") for getting at the persistent session without touching the keyboard chord for it. None of its commands are Ghostty operations: each is a tmux command on the box, plus one AppleScript call that brings the Ghostty tab holding the Spark session to the front (matched by title, `[spark-` by default). tmux is what gives the layout names, so the extension depends on the `spark layout` shape — session `c1` (a preference), window `claude`, pane 1 Claude Code, pane 2 a shell.

| command | what it does |
|---|---|
| Go to Claude | focus the mosh tab, select window `claude`, pane 1 |
| Claude Agents Page | press the agents-view key (↓, a preference) in pane 1 — Claude Code's own "↓ to manage" view |
| Search Claude Agents | list from `claude agents --json --all` on the box, newest first, state and age as accessories. Enter opens the job in a new tmux window (`claude --resume <session>`); other actions open the agents page, copy the session id or the resume command |
| Search Claude Sessions | past Claude sessions from BOTH machines via atuin's synced thread capture, searched locally on the Mac (full text). A session the agent view lists opens in pane 1 through the view's own Ctrl+F find; anything else (Mac sessions, plain `claude` sessions) copies `atuin resume <id>`. Every keystroke is gated on re-reading the pane (`raycast/src/agentview.ts`): in the wrong mode, text + Enter dispatches a new session and Esc quits the view |
| New Claude Session | bring pane 1 back to the agents list with an empty "describe a task for a new session" prompt and focus it. It types nothing: you write the task there, with `@` completions, and Enter dispatches it. Sessions start in the agent view's directory |
| Go to Shell Pane | select pane 2 and focus |
| Go to Repo | pick a repo; a literal `cd` typed into pane 2 (deterministic where `z fra` depends on frecency) |

Setup is `spark raycast install`, then restart Ghostty once (the AppleScript flag only takes effect on launch). Latency is what makes this usable: the extension talks to the box through the `spark-ctl` alias, multiplexed over one persistent master connection (`ControlMaster auto`, 4h persist), so a command round-trips in ~40ms instead of a ~500ms handshake. The alias is separate from `Host spark` on purpose — Zed, Rune and mosh never share the socket. The remote login shell is fish, whose quoting isn't POSIX, so the extension never puts a script on ssh's command line: it pipes it to `bash -ls` on stdin.

Preferences (Raycast → Extensions → Spark): ssh alias, tmux session (default `c1`), window (`claude`), Ghostty tab match (`[spark-`), repos directory (`~/src`), agents-view key (`Down`), atuin binary (`/opt/homebrew/bin/atuin`). If your `tmux_session` in the spark config isn't `c1`, set the session preference to match.

## Images: pasting screenshots into a remote Claude session

Pasting an image into Claude Code over ssh **cannot work**, and no config fixes it. Terminals transmit only text, and Claude Code reads images from the clipboard of the machine it runs on — over ssh that's the box's headless clipboard, not your Mac's.

Claude does read an image from a path, so:

```bash
spark paste          # after copying a screenshot (Cmd-Shift-Ctrl-4, or Cmd-C on an image)
```

It pulls the image off the Mac clipboard via AppleScript, uploads it to `~/clipboard/` on the box, and puts the **remote path** on your clipboard. Then Cmd-V into the remote Claude prompt and it reads the file. Handles both the PNG and TIFF clipboard flavours, since different apps put different ones there, and prunes uploads older than `--retain-days` (14) on each run.

A paste can't block — `Cmd-V` reads whatever is on the clipboard at that instant — so the clipboard only ever holds the truth:

| clipboard | means |
|---|---|
| `UPLOADING` | transfer in flight; delete it and paste again in a second |
| `/home/<you>/clipboard/clip-….png` | the file has **landed** — rsync exits 0 only once it's all on the box, and the path isn't published before that |
| `ERROR: image upload failed` | nothing arrived (box unreachable, ssh down, rsync failed) |
| `ERROR: no image on the clipboard` | copy a screenshot first |

The command (and the `--notify` notification) also prints the upload's pixel size, e.g. `4604x1920`, read from the PNG header. That is the file's real resolution: nothing on this path resizes. If a clip looks like Lego when you `viu` it on the box, that is the viewer, not the file — mosh re-renders the screen server-side and drops kitty/iTerm/sixel graphics escapes, so any image viewer under mosh (with or without tmux) falls back to half-block cells. Claude reads the file from the path, never the terminal render, so it sees the full image. Inline images only work over plain `spark ssh` (tmux has `allow-passthrough on` for that); over mosh, trust the printed size.

Short and plainly not a path, so a premature or failed paste is obvious and quick to delete — rather than a path to a missing file, which Claude would fail to read. The placeholder also stops a quick *local* paste returning the stale screenshot during the second or two a large upload takes.

Bind it to a hotkey — `conf/skhdrc` has `Cmd-Shift-Opt-5` (capture a region *and* ship it, via `screencapture -i -c`) and `Cmd-Shift-Opt-V` (ship whatever image is already on the clipboard). skhd runs commands with a minimal PATH and never reads your shell config, so the binding needs the absolute path to `spark`.

## Browser testing from the box

Agents on the box (the chrome-devtools MCP, registered user-scope with `--browser-url=http://127.0.0.1:9222`) drive a Chrome running on **your laptop**, through a reverse forward of port 9222.

- **`spark tunnel install`** makes that forward a launchd agent: one `ssh -N -o ExitOnForwardFailure=yes -R 9222:…` that belongs to no terminal and is restarted after sleep or a network change. Log: `~/Library/Logs/spark-chrome-tunnel.log`. Without it, `spark ssh`/`tmux` add an inline `-R` that dies with that session, and only the first session can bind it — the old "chrome forwarding is broken" failure. `spark mosh` refuses to start without the agent, since mosh can't forward ports.
- **`spark chrome`** launches the debug Chrome on a dedicated profile (`~/.spark-chrome`); the session verbs do it automatically when nothing answers on 9222.
- **`spark tunnel status`** checks laptop Chrome → agent → `127.0.0.1:9222` as seen from the box, and names the hop that's down.
- **The browser is on the laptop, so `localhost` in it is the laptop.** A page an agent opens must use the box's tailnet address — `http://<tailnet-ip>:<port>` — and the dev server must bind `0.0.0.0` (vite: `--host 0.0.0.0`). A vite an agent started on its own port bound to loopback is unreachable from the browser, and looks exactly like a broken tunnel.

## Google Drive → the box

For bulk files (a 20 GB document pile), have the box pull straight from Google instead of downloading to the laptop and pushing up:

```bash
spark auth drive                                             # once: read-only rclone sign-in, consent page opens on the Mac
spark drive pull '<folder URL>' ~/data/pile --dry-run        # what would be copied
spark drive pull '<folder URL>' ~/data/pile                  # runs in tmux session drive-<id> on the box
spark drive status                                           # progress, and rclone's exit code when done
```

A folder merely *shared with you* works — the URL's folder id becomes rclone's root. `rclone copy` is idempotent, so re-running after an interruption only fetches what's missing. The token lives only on the box, in `~/.config/rclone/rclone.conf`; logs are in `~/.cache/spark-drive/`. **Use your own OAuth client.** rclone's built-in one is shared by every rclone user, throttled hard, and being retired during 2026 — remotes made with it will stop working. One-time, in the Google Cloud console under your Workspace org:

1. Create a project (e.g. `spark-rclone`), then **APIs & Services → Library → Google Drive API → Enable**.
2. **Google Auth Platform → Branding/Audience**: app name + support email, audience **Internal**. Internal is the important choice: Workspace-only, no Google verification, and refresh tokens don't expire — an *External* app left in "Testing" silently kills its tokens after 7 days, mid-download.
3. **Data Access → Add scope** `https://www.googleapis.com/auth/drive.readonly`.
4. **Clients → Create client → Desktop app**. Copy the client id and secret.

Then `spark auth drive --client-id <id>` (the secret is prompted for, hidden). It replaces the remote in place; re-run `spark drive pull` and it resumes. If a Workspace admin blocks third-party apps, an Internal app in your own org is also the usual way through.

## Running a dev server on the box

Start it inside tmux so it survives disconnects:

```bash
spark tmux fe
# then, on the box:
cd ~/src/<frontend> && PORT=3001 API_BASE_URL=https://... npm run dev
```

Reach it from the laptop browser at `http://<tailnet-ip>:3001`. In dev, express binds `0.0.0.0` and mounts vite in `middlewareMode` with `allowedHosts: true`, so one port serves app, API and HMR with no host-check to appease. A second standalone vite on 5174 binds loopback only and isn't needed.

Plain HTTP over an IP is an **insecure context**, so `crypto.randomUUID`, clipboard and camera APIs are unavailable. If you need a secure context, forward the port instead — `ssh -L 3001:localhost:3001 …` — and browse `http://localhost:3001`, which counts as secure even over plain HTTP.

## House rules for a shared box

- **Never `pkill -f <pattern>`.** It matches your own remote command line (it will kill the shell doing the killing) and it cannot tell your process from someone else's identically-named one. Kill a PID you recorded, or ask. Use a bracket class — `pgrep -af '[n]ode'` — when you only mean to *look*.
- **One heavy job at a time.** Full test suites run `pytest -n 14`; two of those saturate a machine somebody may be demoing from.
- Things that "write to your global gitconfig" write to the conf repo when `~/.gitconfig` is a symlink into it. Use `git lfs install --local` rather than the global form.
