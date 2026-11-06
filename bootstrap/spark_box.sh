#!/usr/bin/env bash
# Box tier: the once-per-machine steps that need sudo, plus adding other people's accounts.
# Run through `spark bootstrap --box` (which pushes this kit to ~/.local/share/spar-cli and runs it
# under a tty so sudo can ask for your password). Idempotent: every step checks before it acts.
#
#   CHECK_ONLY=1               report what is and isn't done; no sudo, changes nothing
#                              (what `spark bootstrap --all` runs for someone who isn't an admin)
#   ADD_USER=<name>            also create that account (no password: key login only), put it in the
#                              docker group and enable linger so its systemd user units keep running
#   PUBKEY='ssh-ed25519 ...'   and authorize that key for ADD_USER
set -euo pipefail

KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECK_ONLY="${CHECK_ONLY:-}"
ADD_USER="${ADD_USER:-}"
PUBKEY="${PUBKEY:-}"
ME="$(id -un)"
MISSING=0

step() { printf '\n==> %s\n' "$*"; }
ok() { printf '  ok    %s\n' "$*"; }
todo() { printf '  TODO  %s\n' "$*"; MISSING=$((MISSING + 1)); }
did() { printf '  done  %s\n' "$*"; }
in_group() { id -nG "$1" 2>/dev/null | tr ' ' '\n' | grep -qx "$2"; }

if [ -z "$CHECK_ONLY" ]; then
  if ! in_group "$ME" sudo && ! in_group "$ME" admin && ! in_group "$ME" wheel; then
    echo "$ME is not an admin on $(hostname): the box tier needs sudo. Ask the box's owner to run it." >&2
    exit 3
  fi
  step "sudo (asks for your password once)"
  sudo -v
fi

# ---- packages -------------------------------------------------------------------------------
step packages
for pkg in fish mosh; do
  if dpkg -s "$pkg" >/dev/null 2>&1; then
    ok "$pkg"
  elif [ -n "$CHECK_ONLY" ]; then
    todo "$pkg not installed"
  else
    [ -n "${APT_UPDATED:-}" ] || { sudo apt-get update -qq; APT_UPDATED=1; }
    sudo apt-get install -y -qq "$pkg" && did "$pkg installed"
  fi
done

# ---- OpenSSH on 2222 (independent of Tailscale SSH) --------------------------------------------
# README "The extra SSH port" explains the three traps; the socket drop-in avoids all of them.
step "ssh on port 2222"
DROPIN=/etc/systemd/system/ssh.socket.d/10-extra-port.conf
listening_2222() { ss -Hltn 'sport = :2222' | grep -q '0.0.0.0:2222'; }
if listening_2222; then
  ok "OpenSSH answers on 0.0.0.0:2222"
elif [ -n "$CHECK_ONLY" ]; then
  todo "nothing listening on 0.0.0.0:2222"
elif ! systemctl list-unit-files ssh.socket --no-legend 2>/dev/null | grep -q ssh.socket; then
  todo "sshd is not socket-activated here; add 'Port 22' + 'Port 2222' to /etc/ssh/sshd_config and restart ssh by hand"
else
  sudo install -d -m 755 "$(dirname "$DROPIN")"
  sudo install -m 644 -o root -g root "$KIT/dotfiles/ssh-extra-port.conf" "$DROPIN"
  sudo systemctl daemon-reload
  if sudo systemctl restart ssh.socket && sleep 1 && listening_2222; then
    did "ssh.socket now listens on 2222"
  else
    echo "  ssh.socket restart failed or 2222 still not listening. Usual cause: a stale standalone sshd" >&2
    echo "  holding :22 from before socket activation -- find it with: pgrep -af '[s]shd'" >&2
    exit 1
  fi
fi

# ---- sshd keepalives: a dead client's forwards are released in ~1 min, not hours -------------
step "sshd keepalives"
KEEPALIVE=/etc/ssh/sshd_config.d/20-keepalive.conf
WANT=$'ClientAliveInterval 15\nClientAliveCountMax 4'
if [ "$(cat "$KEEPALIVE" 2>/dev/null)" = "$WANT" ]; then
  ok "$KEEPALIVE"
elif [ -n "$CHECK_ONLY" ]; then
  todo "$KEEPALIVE missing"
else
  printf '%s\n' "$WANT" | sudo tee "$KEEPALIVE" >/dev/null && did "$KEEPALIVE (read per connection, no restart)"
fi

# ---- never suspend ------------------------------------------------------------------------------
step "sleep targets masked"
TARGETS="sleep.target suspend.target hibernate.target hybrid-sleep.target"
unmasked=""
for t in $TARGETS; do [ "$(systemctl is-enabled "$t" 2>/dev/null)" = masked ] || unmasked="$unmasked $t"; done
if [ -z "$unmasked" ]; then
  ok "all four masked"
elif [ -n "$CHECK_ONLY" ]; then
  todo "not masked:$unmasked"
else
  # shellcheck disable=SC2086
  sudo systemctl mask $TARGETS >/dev/null && did "masked$unmasked"
fi

# ---- per-account bits that need sudo: docker group, linger -------------------------------------
account() {
  local who="$1"
  if getent group docker >/dev/null; then
    if in_group "$who" docker; then ok "$who in docker group"
    elif [ -n "$CHECK_ONLY" ]; then todo "$who not in the docker group"
    else sudo usermod -aG docker "$who" && did "$who added to docker (takes effect on next login)"; fi
  fi
  # Linger keeps the account's systemd user units (sparkbar sampler, atuin) running with nobody logged in.
  if [ "$(loginctl show-user "$who" -p Linger --value 2>/dev/null)" = yes ]; then ok "$who linger"
  elif [ -n "$CHECK_ONLY" ]; then todo "$who has no linger (user services stop when you log out)"
  else sudo loginctl enable-linger "$who" && did "$who linger enabled"; fi
}
step "account: $ME"
account "$ME"

# ---- another person's account -----------------------------------------------------------------
if [ -n "$ADD_USER" ] && [ -z "$CHECK_ONLY" ]; then
  step "account: $ADD_USER"
  [[ "$ADD_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || { echo "  not a valid account name: $ADD_USER" >&2; exit 1; }
  if id "$ADD_USER" >/dev/null 2>&1; then
    ok "$ADD_USER exists"
  else
    sudo adduser --disabled-password --gecos "" "$ADD_USER" >/dev/null && did "$ADD_USER created (no password: key login only)"
  fi
  account "$ADD_USER"
  if [ -n "$PUBKEY" ]; then
    home="$(getent passwd "$ADD_USER" | cut -d: -f6)"
    group="$(id -gn "$ADD_USER")"
    auth="$home/.ssh/authorized_keys"
    sudo install -d -m 700 -o "$ADD_USER" -g "$group" "$home/.ssh"
    if sudo grep -qxF "$PUBKEY" "$auth" 2>/dev/null; then
      ok "key already authorized"
    else
      printf '%s\n' "$PUBKEY" | sudo tee -a "$auth" >/dev/null && did "key authorized in $auth"
    fi
    sudo chown "$ADD_USER:$group" "$auth" && sudo chmod 600 "$auth"
  fi
fi

step "not automated (do by hand if you need them)"
echo "  - amd64 images on arm64: docker run --privileged --rm tonistiigi/binfmt --install amd64"
echo "  - the gdm login screen suspends after 20 idle minutes unless overridden in its dconf profile"

if [ -n "$CHECK_ONLY" ] && [ "$MISSING" -gt 0 ]; then
  printf '\n%s box step(s) not done. They need sudo: ask the box admin to run `spark bootstrap --box`.\n' "$MISSING"
fi
step DONE
