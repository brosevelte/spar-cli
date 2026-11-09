#!/usr/bin/env bash
# gcp-auth-state -- the ONE answer to "is gcloud signed in", read by both the tmux status bar
# (sparkbar) and the shell prompt (conf/starship.toml) so the two GCP lights always agree. The GCP
# twin of aws-sso-state, with the same four words:
#   ok       a cached access token is live (or, for ADC alone, a probe in the last 50 min worked)
#   idle     the access token lapsed (they live 1h) and a renewal probe is in flight -- gcloud and
#            the client libraries renew silently from the refresh token, so this is NOT a sign-out;
#            it settles to ok or expired within seconds
#   expired  the renewal probe FAILED (revoked, or Workspace demands a reauth): sign in again from
#            the laptop with `spark auth gcp`
#   none     no gcloud account and no application-default credentials
#
# What it looks at, in order:
#   1. the active gcloud account (`gcloud auth login`), which is what `gcloud`/`bq`/`gsutil` use.
#      gcloud caches its access token and expiry in access_tokens.db, so a live token costs one
#      sqlite read and no network. Once it lapses, ONE detached `gcloud auth print-access-token`
#      settles it: success writes a fresh token (next read: ok); failure is recorded against
#      credentials.db's mtime and not retried until a new sign-in changes that file.
#   2. failing that, application-default credentials (ADC, what the Python/Go client libraries
#      use). Those libraries cache nothing on disk, so there is no expiry to read: a probe is run
#      at most every 50 minutes and its verdict reused in between.
# Every probe is detached so a prompt never waits on the network.
set -u

CFG="${CLOUDSDK_CONFIG:-$HOME/.config/gcloud}"
STATE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/gcp-auth-state"
LOCK="$STATE_DIR/probe.lock"  # mkdir-atomic; a probe older than LOCK_STALE seconds is presumed dead
LOCK_STALE=120
ADC_TTL=3000

mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null; }

gcloud_bin() {
  command -v gcloud 2>/dev/null ||
    ls "$HOME"/.local/bin/gcloud "$HOME"/google-cloud-sdk/bin/gcloud /opt/homebrew/bin/gcloud \
      /opt/homebrew/share/google-cloud-sdk/bin/gcloud /usr/local/bin/gcloud 2>/dev/null | head -1
}

# `account = x` under [core] of the active configuration; CLOUDSDK_CORE_ACCOUNT wins, as in gcloud.
active_account() {
  if [ -n "${CLOUDSDK_CORE_ACCOUNT:-}" ]; then printf '%s' "$CLOUDSDK_CORE_ACCOUNT"; return; fi
  local name
  name="${CLOUDSDK_ACTIVE_CONFIG_NAME:-$(cat "$CFG/active_config" 2>/dev/null || echo default)}"
  awk -F' *= *' '/^\[/{core=($0=="[core]")} core && $1=="account"{print $2; exit}' \
    "$CFG/configurations/config_$name" 2>/dev/null
}

sql() { sqlite3 -readonly "$1" "$2" 2>/dev/null; }

# probe <name> <stamp> <command...>: run the command detached, record "<ok|fail> <epoch> <stamp>".
probe() {
  local name=$1 stamp=$2; shift 2
  mkdir -p "$STATE_DIR"
  if [ -d "$LOCK" ]; then
    [ $(( $(date +%s) - $(mtime "$LOCK") )) -gt "$LOCK_STALE" ] || return  # one already running
    rmdir "$LOCK" 2>/dev/null
  fi
  mkdir "$LOCK" 2>/dev/null || return
  (
    if "$@" >/dev/null 2>&1; then r=ok; else r=fail; fi
    printf '%s %s %s\n' "$r" "$(date +%s)" "$stamp" > "$STATE_DIR/$name.tmp" && mv -f "$STATE_DIR/$name.tmp" "$STATE_DIR/$name"
    rmdir "$LOCK" 2>/dev/null
  ) >/dev/null 2>&1 </dev/null &
  disown 2>/dev/null || true
}

main() {
  local account gc now exp stamp result at seen adc
  [ -d "$CFG" ] || { printf 'none'; return; }
  command -v sqlite3 >/dev/null 2>&1 || { printf 'none'; return; }
  gc=$(gcloud_bin)
  now=$(date -u '+%Y-%m-%d %H:%M:%S')
  account=$(active_account)

  if [ -n "$account" ] && [ -n "$(sql "$CFG/credentials.db" "select 1 from credentials where account_id='${account//\'/}'")" ]; then
    exp=$(sql "$CFG/access_tokens.db" "select token_expiry from access_tokens where account_id='${account//\'/}'")
    exp=${exp:0:19}
    if [ -n "$exp" ] && [[ "$exp" > "$now" ]]; then printf 'ok'; return; fi
    stamp=$(mtime "$CFG/credentials.db")
    if [ -r "$STATE_DIR/cli" ]; then
      read -r result _ seen < "$STATE_DIR/cli"
      [ "$seen" = "$stamp" ] && [ "$result" = fail ] && { printf 'expired'; return; }
    fi
    [ -n "$gc" ] && probe cli "$stamp" "$gc" auth print-access-token --account="$account" --quiet
    printf 'idle'
    return
  fi

  adc="${GOOGLE_APPLICATION_CREDENTIALS:-$CFG/application_default_credentials.json}"
  [ -r "$adc" ] || { printf 'none'; return; }
  stamp=$(mtime "$adc")
  if [ -r "$STATE_DIR/adc" ]; then
    read -r result at seen < "$STATE_DIR/adc"
    if [ "$seen" = "$stamp" ]; then
      [ "$result" = fail ] && { printf 'expired'; return; }
      if [ $(( $(date +%s) - at )) -lt "$ADC_TTL" ]; then printf 'ok'; return; fi
      # Verdict is stale but was good: keep showing ok while the re-probe runs.
      [ -n "$gc" ] && probe adc "$stamp" "$gc" auth application-default print-access-token --quiet
      printf 'ok'
      return
    fi
  fi
  [ -n "$gc" ] && probe adc "$stamp" "$gc" auth application-default print-access-token --quiet
  printf 'idle'
}

main
