#!/usr/bin/env bash
# Fish shell + prompt + plugins on the Spark, from the personal conf repo. No sudo.
#
# PREREQUISITE (the one sudo step, run it yourself first):
#   sudo apt install -y fish
#
# Then: bash spark_fish.sh
# Idempotent: every step skips itself when the tool or symlink is already there.
set -euo pipefail

export PATH="$HOME/.local/bin:$HOME/.local/node/bin:$HOME/.pulumi/bin:$PATH"
# Tooling checkouts live outside ~/src (which is for project repos); override with CONF=.
CONF="${CONF:-$HOME/tools/conf}"
[ -d "$CONF" ] || CONF="$HOME/src/conf"
mkdir -p "$HOME/.local/bin" "$HOME/tmp"

step() { printf '\n==> %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

if ! have fish; then
  echo "fish is not installed. Run: sudo apt install -y fish" >&2
  exit 1
fi
[ -d "$CONF" ] || { echo "conf repo not found at $CONF" >&2; exit 1; }

# Latest release asset for a GitHub repo, matched by substring.
gh_asset() {
  curl -fsSL "https://api.github.com/repos/$1/releases/latest" |
    awk -F'"' -v pat="$2" '/browser_download_url/ && $4 ~ pat {print $4; exit}'
}

cd "$HOME/tmp"

# ---- starship (the prompt) ----------------------------------------------------
step starship
have starship || curl -fsSL https://starship.rs/install.sh | sh -s -- -b "$HOME/.local/bin" -y
starship --version | head -1

# ---- fzf: needed by the fzf.fish and fifc plugins -------------------------------
step fzf
if ! have fzf; then
  curl -fsSL "$(gh_asset junegunn/fzf 'linux_arm64\.tar\.gz')" -o fzf.tgz
  tar -xzf fzf.tgz -C "$HOME/.local/bin" fzf && rm fzf.tgz
fi
fzf --version

# ---- fd + bat: used by fifc previews and the cdg function -----------------------
step fd
if ! have fd; then
  curl -fsSL "$(gh_asset sharkdp/fd 'aarch64-unknown-linux-gnu\.tar\.gz')" -o fd.tgz
  tar -xzf fd.tgz --strip-components=1 -C "$HOME/.local/bin" --wildcards '*/fd' && rm fd.tgz
fi
fd --version

step bat
if ! have bat; then
  curl -fsSL "$(gh_asset sharkdp/bat 'aarch64-unknown-linux-gnu\.tar\.gz')" -o bat.tgz
  tar -xzf bat.tgz --strip-components=1 -C "$HOME/.local/bin" --wildcards '*/bat' && rm bat.tgz
fi
bat --version

# ---- atuin: shell history in SQLite, Ctrl+R search (bound in config.fish) -------------
# Local-only unless you run `atuin register`/`atuin login` yourself. `import auto` seeds it from
# fish's own history once; re-running is harmless (atuin dedupes the import).
step atuin
if ! have atuin; then
  curl -fsSL "$(gh_asset atuinsh/atuin '/atuin-aarch64-unknown-linux-gnu\.tar\.gz$')" -o atuin.tgz
  tar -xzf atuin.tgz --strip-components=1 -C "$HOME/.local/bin" --wildcards '*/atuin' && rm atuin.tgz
  SHELL="$(command -v fish)" atuin import auto
fi
atuin --version

# ---- atuin-server: self-hosted sync, tailnet-only ------------------------------------
# History is end-to-end encrypted client-side; the server only stores ciphertext. Binds the
# tailnet IP so nothing off the tailnet can reach it. Registration is closed once an account
# exists (flip open_registration in ~/.config/atuin/server.toml to add one).
step atuin-server
if ! have atuin-server; then
  curl -fsSL "$(gh_asset atuinsh/atuin '/atuin-server-aarch64-unknown-linux-gnu\.tar\.gz$')" -o atuin-server.tgz
  tar -xzf atuin-server.tgz --strip-components=1 -C "$HOME/.local/bin" --wildcards '*/atuin-server' && rm atuin-server.tgz
fi
mkdir -p "$HOME/.config/atuin" "$HOME/.local/share/atuin" "$HOME/.config/systemd/user"
if [ ! -f "$HOME/.config/atuin/server.toml" ]; then
  cat > "$HOME/.config/atuin/server.toml" <<TOML
host = "$(tailscale ip -4 | head -1)"
port = 8888
open_registration = true
db_uri = "sqlite://$HOME/.local/share/atuin/server.db"
TOML
fi
SPARK_CLI_DIR="${SPARK_CLI_DIR:-$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)}"
[ -f "$SPARK_CLI_DIR/dotfiles/atuin-server.service" ] && cp "$SPARK_CLI_DIR/dotfiles/atuin-server.service" "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable --now atuin-server.service
systemctl --user is-active atuin-server.service
# Point this box's client at its own server and capture agent threads. First account on a fresh
# server: `atuin register -u <name> -e <email>` here, then close open_registration and restart;
# other machines join with `atuin login` + the key from `atuin key`.
atuin config set sync_address "http://$(tailscale ip -4 | head -1):8888"
atuin config set auto_sync true
atuin config set sync.records true
atuin config set daemon.autostart true
atuin threads enable

# ---- link the portable parts of the conf repo ------------------------------------
# Deliberately NOT linked on Linux: ssh-config (its IdentityFile is the Mac's github key, and
# linking it breaks git over ssh here), zed-settings, claude-settings.json (pushed re-homed by
# `spark sync claude` instead). Those are macOS-shaped.
step conf-links
link() {
  local src="$CONF/$1" dest="$2"
  [ -e "$src" ] || { echo "  skip  $1 (missing in conf)"; return; }
  mkdir -p "$(dirname "$dest")"
  if [ -L "$dest" ] && [ "$(readlink -f "$dest")" = "$(readlink -f "$src")" ]; then
    echo "  ok    $dest"
    return
  fi
  [ -e "$dest" ] || [ -L "$dest" ] && mv "$dest" "$dest.bak" && echo "  bak   $dest.bak"
  ln -s "$src" "$dest"
  echo "  link  $dest"
}
link config.fish "$HOME/.config/fish/config.fish"
link fish_plugins "$HOME/.config/fish/fish_plugins"
link starship.toml "$HOME/.config/starship.toml"
for src in "$CONF"/fish-functions/*.fish; do
  link "fish-functions/$(basename "$src")" "$HOME/.config/fish/functions/$(basename "$src")"
done
for src in "$CONF"/fish-completions/*.fish; do
  link "fish-completions/$(basename "$src")" "$HOME/.config/fish/completions/$(basename "$src")"
done

# ---- fisher + the plugins listed in fish_plugins ----------------------------------
step fisher
fish -c 'functions -q fisher; or curl -sL https://raw.githubusercontent.com/jorgebucaran/fisher/main/functions/fisher.fish | source && fisher install jorgebucaran/fisher'
fish -c 'fisher update'

# ---- make tmux windows open fish ---------------------------------------------------
# `chsh -s (command -v fish)` is yours to run (it asks for your password) and makes plain ssh
# fish too; the tmux line below covers the sessions Claude and the dev servers live in.
step tmux-default-shell
TMUX_CONF="$HOME/.tmux.conf"
if [ -f "$TMUX_CONF" ] && ! grep -q "default-command" "$TMUX_CONF"; then
  printf '\n# Open fish in tmux windows without changing the login shell (config.fish sets PATH itself).\nif-shell "command -v fish" "set -g default-command '"'"'exec fish -l'"'"'"\n' >> "$TMUX_CONF"
  tmux source-file "$TMUX_CONF" 2>/dev/null || true
  echo "  added default-command to ~/.tmux.conf"
else
  echo "  already set or no ~/.tmux.conf"
fi

step DONE
echo "fish ready. New tmux windows use it; run 'chsh -s $(command -v fish)' to make plain ssh use it too."
