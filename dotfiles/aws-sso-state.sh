#!/usr/bin/env bash
# aws-sso-state -- the ONE source of truth for "is AWS SSO signed in", read by both the tmux
# status bar (sparkbar) and the shell prompt (conf/starship.toml) so the two clouds always agree.
# Prints exactly one word:
#   ok       the cached access token is live
#   idle     it has lapsed (it only lives ~1h past the last AWS call) and a renewal probe is in
#            flight -- the CLI/boto3 renew lapsed tokens silently via the refresh token, so this is
#            NOT a sign-out; it resolves to ok or expired within seconds
#   expired  nothing left to renew with, or the renewal probe FAILED: sign in again from the laptop
#            with `spark auth aws` (never `aws sso login` on the Spark -- it is hook-blocked there)
#   none     no SSO token cache at all
#
# Why a probe: the token file carries the access-token expiry and the client-registration expiry,
# but the refresh token is also bounded by the Identity Center PORTAL SESSION, a server-side
# lifetime that is in no local file. 2026-10-10: both machines sat on "renewable" for hours after
# the portal session had ended, an agent asked for a re-login against an amber icon, and the icon
# was the one that was wrong. So when the token is lapsed we try ONE real call
# (`sts get-caller-identity`, read-only): if it succeeds, the call itself renewed the token and the
# next read says ok; if it fails, that is recorded against this token file's mtime and nothing is
# retried until a new sign-in writes a new file. Zero recurring cost on a live token, one STS call
# per idle hour otherwise, and the probe is detached so a prompt never waits on the network.
set -u

CACHE_DIR="$HOME/.aws/sso/cache"
STATE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/aws-sso-state"
RESULT="$STATE_DIR/probe"     # "<ok|fail> <epoch> <token-file-mtime>"
LOCK="$STATE_DIR/probe.lock"  # mkdir-atomic; a probe older than this many seconds is presumed dead
LOCK_STALE=120

mtime() {
  stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null
}

# The profile the probe signs the STS call with: $AWS_PROFILE if the caller has one, else the
# first profile in ~/.aws/config that uses an sso-session. tmux's environment predates the login
# shell's, so the status bar usually takes the second path.
probe_profile() {
  if [ -n "${AWS_PROFILE:-}" ]; then printf '%s' "$AWS_PROFILE"; return; fi
  awk '/^\[profile /{p=$2; sub(/\]$/,"",p)} /^sso_session/{if(p){print p; exit}}' "$HOME/.aws/config" 2>/dev/null
}

launch_probe() {
  local f=$1 tok_mtime=$2 profile aws_bin
  profile=$(probe_profile)
  [ -n "$profile" ] || return
  aws_bin=$(command -v aws 2>/dev/null || ls /opt/homebrew/bin/aws "$HOME"/.local/bin/aws /usr/local/bin/aws 2>/dev/null | head -1)
  [ -n "$aws_bin" ] || return
  mkdir -p "$STATE_DIR"
  if [ -d "$LOCK" ]; then
    local age=$(( $(date +%s) - $(mtime "$LOCK") ))
    [ "$age" -gt "$LOCK_STALE" ] || return  # a probe is already running
    rmdir "$LOCK" 2>/dev/null
  fi
  mkdir "$LOCK" 2>/dev/null || return
  # Fully detached: no stdio ties to the prompt or the status bar, which would otherwise block
  # until the network call returned.
  (
    if "$aws_bin" sts get-caller-identity --profile "$profile" >/dev/null 2>&1; then r=ok; else r=fail; fi
    printf '%s %s %s\n' "$r" "$(date +%s)" "$tok_mtime" > "$RESULT.tmp" && mv -f "$RESULT.tmp" "$RESULT"
    rmdir "$LOCK" 2>/dev/null
  ) >/dev/null 2>&1 </dev/null &
  disown 2>/dev/null || true
}

main() {
  local f exp reg now tok_mtime r_result r_mtime
  # Newest token file only: a stale sibling from an older sign-in must not vote. `xargs -r` so an
  # empty cache does not run grep with no operands (it would read the terminal and hang the prompt).
  f=$(ls -t "$CACHE_DIR"/*.json 2>/dev/null | xargs -r grep -l '"accessToken"' 2>/dev/null | head -1)
  [ -n "$f" ] || { printf 'none'; return; }
  now=$(date -u +%Y-%m-%dT%H:%M:%S)
  exp=$(grep -ho '"expiresAt": *"[^"]*"' "$f" | sed 's/.*"\([^"]*\)".*/\1/'); exp=${exp:0:19}
  if [ -n "$exp" ] && [[ "$exp" > "$now" ]]; then printf 'ok'; return; fi
  reg=$(grep -ho '"registrationExpiresAt": *"[^"]*"' "$f" | sed 's/.*"\([^"]*\)".*/\1/'); reg=${reg:0:19}
  if ! grep -q '"refreshToken"' "$f" || [ -z "$reg" ] || ! [[ "$reg" > "$now" ]]; then printf 'expired'; return; fi

  # Lapsed but locally renewable: trust a recorded verdict for THIS token file, else probe.
  tok_mtime=$(mtime "$f")
  if [ -r "$RESULT" ]; then
    read -r r_result _ r_mtime < "$RESULT"
    if [ "$r_mtime" = "$tok_mtime" ]; then
      # A successful probe rewrites the token file (new mtime), so an "ok" verdict against an
      # unchanged file means the refresh succeeded without the CLI persisting it; treat as idle
      # and let the next probe settle it.
      [ "$r_result" = fail ] && { printf 'expired'; return; }
    fi
  fi
  launch_probe "$f" "$tok_mtime"
  printf 'idle'
}

main
