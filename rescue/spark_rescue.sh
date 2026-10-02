#!/usr/bin/env bash
# Laptop side: get work off the Spark, most valuable first, in stages that are each safe to re-run.
#
#   rescue/spark_rescue.sh                         # sessions -> code -> inventory
#   rescue/spark_rescue.sh --push-wip              # ...and push unpushed/dirty work to refs/wip/spark/*
#   rescue/spark_rescue.sh --stage data --data spark-ml/ivans-ft/labels --data spark-ml/ivans-ft/train
#
# Stages (default: sessions code inventory; `data` runs only when --data paths are given):
#   sessions   Claude Code transcripts + sidecars (subagents, tool results, workflows) + memory for the
#              ultron-framework project, and ~/.claude/plans. Small; the record of what every agent did.
#   code       runs rescue/sweep.sh on the box (read-only snapshot of every repo/worktree/submodule),
#              then pulls the snapshots. See sweep.sh for what is captured.
#   inventory  sizes under ~/spark-ml and any dirs named like ocr/gold/silver/label, so the data
#              stage can be pointed at the right paths. Pulls nothing.
#   data       each --data PATH (relative to the box's $HOME), rsynced as-is minus venvs/caches/.env.
#
# Every copy is `rsync --partial`: if the box drops mid-run, re-run the same command and it resumes.
# Nothing on the box is modified except the snapshot dir ~/rescue that sweep.sh writes.
set -uo pipefail

HOST=${SPARK_HOST:-spark}                                   # ssh alias: port 2222 + key, see conf/ssh-config
LAND=${LAND:-$HOME/spark_transfer/exfil}                    # landing zone on this laptop
PROJECT_DIR=${PROJECT_DIR:--home-brosevelte-src-ultron-framework}   # ~/.claude/projects/<this> on the box
# Repos whose worktrees hold work worth saving (Carter 2026-09-29). Each is swept with every worktree
# and submodule under it. Others (ultron-forms, ultron-memory, react-platform) add seconds, not minutes,
# if ever wanted: SWEEP_ROOTS="src/ultron-framework src/replit-avengetron src/ultron-forms" ...
SWEEP_ROOTS=${SWEEP_ROOTS:-src/ultron-framework src/replit-avengetron}
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

stages=()
data=()
push_wip=0
while [ $# -gt 0 ]; do
  case $1 in
    --stage) stages+=("$2"); shift 2 ;;
    --data) data+=("$2"); shift 2 ;;
    --push-wip) push_wip=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ ${#stages[@]} -gt 0 ] || stages=(sessions code inventory)
[ ${#data[@]} -gt 0 ] && [[ " ${stages[*]} " != *" data "* ]] && stages+=(data)

mkdir -p "$LAND"
LOG="$LAND/rescue.log"
say() { printf '%s  %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$LOG"; }
RSYNC=(rsync -a --partial --info=progress2 --human-readable)
rsync --info=progress2 --version >/dev/null 2>&1 || RSYNC=(rsync -a --partial -h --progress)   # macOS openrsync

ssh -o ConnectTimeout=8 -o BatchMode=yes "$HOST" true 2>/dev/null || { say "box unreachable over ssh ($HOST)"; exit 1; }
say "connected to $HOST; landing in $LAND; stages: ${stages[*]}"

# The box has a known hard-power-off under sustained GPU load; capping clocks keeps a heavy
# process that restarts on boot from taking it down mid-copy. Needs root, so it only runs if sudo
# works without a password -- otherwise it prints the command to run at the console.
if ssh "$HOST" 'sudo -n nvidia-smi -lgc 300,2200' >/dev/null 2>&1; then
  say "GPU clocks capped (nvidia-smi -lgc 300,2200)"
else
  say "GPU clock cap NOT applied (needs sudo): run on the box  sudo nvidia-smi -lgc 300,2200"
fi

failed=0
for stage in "${stages[@]}"; do
  case $stage in
    sessions)
      say "== sessions"
      mkdir -p "$LAND/claude/projects/$PROJECT_DIR" "$LAND/claude/plans"
      "${RSYNC[@]}" "$HOST:.claude/projects/$PROJECT_DIR/" "$LAND/claude/projects/$PROJECT_DIR/" || { say "sessions: FAILED"; failed=1; }
      "${RSYNC[@]}" "$HOST:.claude/plans/" "$LAND/claude/plans/" 2>/dev/null || say "plans: none or failed (non-critical)"
      say "sessions: $(find "$LAND/claude/projects/$PROJECT_DIR" -maxdepth 1 -name '*.jsonl' | wc -l | tr -d ' ') transcripts, $(du -sh "$LAND/claude" | cut -f1)"
      ;;
    code)
      say "== code (push_wip=$push_wip)"
      scp -q "$HERE/sweep.sh" "$HOST:rescue-sweep.sh" || { say "code: copy of sweep.sh FAILED"; failed=1; continue; }
      # `env` rather than a bare VAR=x prefix: the box's login shell is fish. Roots are relative to
      # the remote $HOME, which is the cwd of an ssh command.
      if ssh "$HOST" "env PUSH_WIP=$push_wip bash rescue-sweep.sh $SWEEP_ROOTS" 2>&1 | tee -a "$LOG"; then
        say "sweep: clean"
      else
        say "sweep: finished WITH FAILURES (see MANIFEST); pulling what it produced"
        failed=1
      fi
      mkdir -p "$LAND/code"
      "${RSYNC[@]}" "$HOST:rescue/code/" "$LAND/code/" || { say "code pull: FAILED"; failed=1; }
      ;;
    inventory)
      say "== inventory (nothing pulled)"
      ssh "$HOST" 'bash -c "cd ~ && du -xh --max-depth=3 spark-ml 2>/dev/null | sort -rh | head -40; echo; echo \"-- dirs named like ocr/gold/silver/label:\"; find spark-ml src -maxdepth 6 -type d \( -iname \"*ocr*\" -o -iname \"*gold*\" -o -iname \"*silver*\" -o -iname \"*label*\" \) -not -path \"*/node_modules/*\" -not -path \"*/.venv/*\" 2>/dev/null | while read d; do printf \"%8s  %s\n\" \"\$(du -sh \"\$d\" | cut -f1)\" \"\$d\"; done"' | tee "$LAND/inventory.txt"
      ;;
    data)
      for p in "${data[@]}"; do
        say "== data: $p"
        mkdir -p "$LAND/data/$(dirname "$p")"
        "${RSYNC[@]}" --exclude='.venv/' --exclude='node_modules/' --exclude='__pycache__/' \
          --exclude='.env' --exclude='.env.*' --exclude='*.key' \
          "$HOST:$p" "$LAND/data/$(dirname "$p")/" || { say "data $p: FAILED"; failed=1; }
      done
      ;;
    *) say "unknown stage: $stage"; failed=1 ;;
  esac
done

say "done; failures=$failed; log: $LOG"
exit $failed
