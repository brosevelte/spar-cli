#!/usr/bin/env bash
# One-shot, user-local (no sudo) toolchain bootstrap for the DGX Spark.
# Idempotent: every step skips itself if the tool is already on PATH.
# Logs to ~/bootstrap.log; run with: nohup bash spark_bootstrap.sh > ~/bootstrap.log 2>&1 &
set -euo pipefail

export PATH="$HOME/.local/bin:$HOME/.local/node/bin:$HOME/.pulumi/bin:$PATH"
mkdir -p "$HOME/.local/bin" "$HOME/tmp"
SELF_DOTFILES_EARLY="$(cd "$(dirname "${BASH_SOURCE[0]}")/../dotfiles" 2>/dev/null && pwd)"
cd "$HOME/tmp"

step() { printf '\n==> %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

# Latest release asset for a GitHub repo, matched by substring.
gh_asset() {
  curl -fsSL "https://api.github.com/repos/$1/releases/latest" |
    awk -F'"' -v pat="$2" '/browser_download_url/ && $4 ~ pat {print $4; exit}'
}

# ---- uv -------------------------------------------------------------------
step uv
if ! have uv; then curl -LsSf https://astral.sh/uv/install.sh | sh; fi
# ultron-framework pins required-version; match it so `uv run sync` accepts the binary
uv self update 0.11.14 >/dev/null 2>&1 || true
uv --version

# ---- node 22 (tarball, user-local) ------------------------------------------
step node
if ! have node; then
  NODE_TARBALL=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | awk '/linux-arm64.tar.xz/{print $2}')
  curl -fsSL "https://nodejs.org/dist/latest-v22.x/${NODE_TARBALL}" -o node.tar.xz
  rm -rf "$HOME/.local/node" && mkdir -p "$HOME/.local/node"
  tar -xJf node.tar.xz -C "$HOME/.local/node" --strip-components=1
  rm node.tar.xz
fi
node --version; npm --version

# ---- claude code (native installer) ----------------------------------------
step claude
if ! have claude; then curl -fsSL https://claude.ai/install.sh | bash; fi
claude --version || true

# ---- gh ---------------------------------------------------------------------
step gh
if ! have gh; then
  GH_TAG=$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest | awk -F'"' '/"tag_name"/{print $4}')
  GH_VER=${GH_TAG#v}
  curl -fsSL "https://github.com/cli/cli/releases/download/${GH_TAG}/gh_${GH_VER}_linux_arm64.tar.gz" -o gh.tgz
  tar -xzf gh.tgz
  cp "gh_${GH_VER}_linux_arm64/bin/gh" "$HOME/.local/bin/gh"
  rm -rf gh.tgz "gh_${GH_VER}_linux_arm64"
fi
gh --version | head -1
# Keep gh away from the GNOME keyring, which is locked over ssh: any gh command that touches it
# raises an unlock dialog on the physical monitor and hangs forever. See dotfiles/gh-wrapper.sh.
if [ ! -e "$HOME/.local/bin/gh.real" ] && [ -f "$SELF_DOTFILES_EARLY/gh-wrapper.sh" ]; then
  mv "$HOME/.local/bin/gh" "$HOME/.local/bin/gh.real"
  cp "$SELF_DOTFILES_EARLY/gh-wrapper.sh" "$HOME/.local/bin/gh"
  chmod +x "$HOME/.local/bin/gh"
  echo "  gh wrapped (no keyring); log in with: gh auth login --web --insecure-storage"
fi

# ---- aws cli v2 -------------------------------------------------------------
step aws
if ! have aws; then
  curl -fsSL https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip -o awscliv2.zip
  python3 -c 'import zipfile; zipfile.ZipFile("awscliv2.zip").extractall(".")'
  chmod +x aws/install aws/dist/aws aws/dist/aws_completer
  ./aws/install -i "$HOME/.local/aws-cli" -b "$HOME/.local/bin"
  rm -rf awscliv2.zip aws
fi
aws --version

# ---- pulumi -----------------------------------------------------------------
step pulumi
if ! have pulumi; then curl -fsSL https://get.pulumi.com | sh; fi
pulumi version

# ---- git-lfs -----------------------------------------------------------------
# replit-avengetron tracks .zip/.mov through LFS and its .githooks/post-checkout shells out to
# git-lfs, so without the binary every checkout/merge/commit ends in a hook error.
step git-lfs
if ! have git-lfs; then
  curl -fsSL "$(gh_asset git-lfs/git-lfs 'linux-arm64-v')" -o lfs.tgz
  tar -xzf lfs.tgz && cp git-lfs-*/git-lfs "$HOME/.local/bin/git-lfs"
  rm -rf lfs.tgz git-lfs-3.*
fi
git-lfs --version

# ---- npm globals: graphite, ast-grep ------------------------------------------
step npm-globals
have gt || npm install -g @withgraphite/graphite-cli@stable
have ast-grep || npm install -g @ast-grep/cli
# `build deploy` generates the Python SDK through Fern before packaging the lambdas, so without this
# every deploy dies at the SDK step -- and the traceback points at Docker, which is not the cause.
have fern || npm install -g fern-api
gt --version; ast-grep --version; fern --version

# ---- chrome-devtools MCP -> laptop Chrome over the `spark ssh` reverse tunnel ----
step chrome-devtools-mcp
claude mcp remove --scope user chrome-devtools >/dev/null 2>&1 || true
claude mcp add --scope user chrome-devtools -- npx -y chrome-devtools-mcp@latest --browser-url=http://127.0.0.1:9222

# ---- shell PATH -------------------------------------------------------------
step bashrc
BASHRC_MARK="# >>> spark bootstrap >>>"
# Both files: ~/.bashrc returns early for non-interactive shells, so `ssh host bash -lc` only sees ~/.profile.
for rc in "$HOME/.bashrc" "$HOME/.profile"; do
  if ! grep -q "$BASHRC_MARK" "$rc"; then
    cat >> "$rc" <<'EOF'
# >>> spark bootstrap >>>
export PATH="$HOME/.local/bin:$HOME/.local/node/bin:$HOME/.pulumi/bin:$PATH"
# ssh forwards TERM but not COLORTERM; without it TUIs drop to the xterm-256 palette and ignore the theme.
export COLORTERM="${COLORTERM:-truecolor}"
# Frontend dev server against the live platform API, reachable at http://<host>:3001 over the tailnet
# (express binds 0.0.0.0 and mounts vite in middlewareMode). Run it in `spark tmux fe`. The env is set
# here rather than in a package.json script so it survives branch switches.
runfe() { cd "$HOME/src/replit-avengetron" && PORT=3001 API_BASE_URL=https://api.equalpartsplatform.io npm run dev; }
# <<< spark bootstrap <<<
EOF
  fi
done

# ---- rclone (Google Drive -> box, for `spark drive`) -------------------------
step rclone
if ! have rclone; then
  curl -fsSL https://downloads.rclone.org/rclone-current-linux-arm64.zip -o rclone.zip
  unzip -qo rclone.zip && cp rclone-*-linux-arm64/rclone "$HOME/.local/bin/rclone"
  rm -rf rclone.zip rclone-*-linux-arm64
fi
rclone version | head -1

# ---- tmux config + the helpers it calls ----------------------------------------
# The config only when the user has none: status bar on top with machine vitals, focus-events for
# Claude Code, 0ms escape-time, OSC 52 clipboard to the laptop. The helpers it calls are always
# refreshed: sparkbar (status-right) and its sampler service, aws-sso-state (its AWS cloud, shared with the prompt),
# holman/spark (draws its sparklines) and tmux-osc52
# (copy-command; the only OSC 52 form mosh forwards -- see dotfiles/tmux-osc52.sh).
step tmux-conf
SELF_DOTFILES="$(cd "$(dirname "${BASH_SOURCE[0]}")/../dotfiles" 2>/dev/null && pwd)"
if [ ! -e "$HOME/.tmux.conf" ] && [ -f "$SELF_DOTFILES/tmux.conf" ]; then
  cp "$SELF_DOTFILES/tmux.conf" "$HOME/.tmux.conf"
  echo "  installed ~/.tmux.conf"
else
  echo "  ~/.tmux.conf exists or source missing; skipping"
fi
if [ -d "$SELF_DOTFILES" ]; then
  install -m 755 "$SELF_DOTFILES/sparkbar.sh" "$HOME/.local/bin/sparkbar"
  install -m 755 "$SELF_DOTFILES/tmux-osc52.sh" "$HOME/.local/bin/tmux-osc52"
  install -m 755 "$SELF_DOTFILES/aws-sso-state.sh" "$HOME/.local/bin/aws-sso-state"
  # sparkbar's sampler: keeps vitals history rolling while no tmux client is attached.
  mkdir -p "$HOME/.config/systemd/user"
  install -m 644 "$SELF_DOTFILES/sparkbar-sampler.service" "$HOME/.config/systemd/user/sparkbar-sampler.service"
  systemctl --user daemon-reload && systemctl --user enable --now sparkbar-sampler.service && systemctl --user restart sparkbar-sampler.service
fi
if [ ! -x "$HOME/.local/bin/spark" ]; then
  curl -fsSL https://raw.githubusercontent.com/holman/spark/master/spark -o "$HOME/.local/bin/spark"
  chmod +x "$HOME/.local/bin/spark"
fi

# ---- personal conf repo (optional) -------------------------------------------
# CONF_REPO=git@github.com:<you>/conf.git links the shell-agnostic subset; fish/starship/zed/Brewfile are Mac-only and skipped.
step conf
if [ -n "${CONF_REPO:-}" ]; then
  CONF_DIR="${CONF_DIR:-$HOME/tools/conf}"
  mkdir -p "$(dirname "$CONF_DIR")"
  [ -d "$CONF_DIR" ] || git clone -q "$CONF_REPO" "$CONF_DIR"
  link() { mkdir -p "$(dirname "$2")"; [ -L "$2" ] || { [ -e "$2" ] && mv "$2" "$2.bak"; ln -s "$CONF_DIR/$1" "$2"; }; echo "  $2 -> $CONF_DIR/$1"; }
  link gitconfig        "$HOME/.gitconfig"
  link git-ignore       "$HOME/.config/git/ignore"
  link gh-config.yml    "$HOME/.config/gh/config.yml"
  link graphite-aliases "$HOME/.config/graphite/aliases"
else
  echo "  CONF_REPO unset; skipping"
fi

# ---- repo wiring ---------------------------------------------------------------
# Everything below is specific to this org's checkout layout and is skipped when the repo is absent,
# so the script is still a plain toolchain installer on any other machine. Override with FW=.
step repos
FW="${FW:-$HOME/src/ultron-framework}"
if [ ! -d "$FW" ]; then
  echo "  $FW not present; skipping repo wiring, SDK sync and frontend install"
  step DONE
  printf 'bootstrap complete %s\n' "$(date -u +%FT%TZ)"
  exit 0
fi
cd "$FW"
git submodule update --init --recursive
FE="${FE:-$HOME/src/replit-avengetron}"
[ -L _fe ] || [ ! -d "$FE" ] || ln -s "$FE" _fe
MEM="${MEM:-$HOME/src/ultron-memory/knowledge/internal/engineering}"
[ -L _memory ] || [ ! -d "$MEM" ] || ln -s "$MEM" _memory
step "uv run sync (this is the slow one)"
uv run sync
step "avengetron npm install"
# @ultron/* come from CodeArtifact; auth_codeartifact.sh writes the gitignored .npmrc but npm runs root `preinstall`
# AFTER fetching (npm 7+ quirk), so it has to run explicitly first. Needs AWS creds — `spark auth aws` from the laptop.
cd "$FE" 2>/dev/null || { step DONE; exit 0; }
if aws sts get-caller-identity >/dev/null 2>&1; then
  bash auth_codeartifact.sh && npm install --no-audit --no-fund
else
  echo "  AWS not authenticated on this box; skipping npm install. Run: spark auth aws, then bash auth_codeartifact.sh && npm install"
fi

step DONE
printf 'bootstrap complete %s\n' "$(date -u +%FT%TZ)"
