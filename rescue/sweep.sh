#!/usr/bin/env bash
# Snapshot every git working tree under the given roots into $OUT_DIR/code, WITHOUT changing any of them.
#
# Written 2026-09-29 after the Spark's power brick died with unpushed work (QRP, target
# acceptance/rejection) only on its SSD. Runs ON the box; rescue/spark_rescue.sh (laptop side)
# copies it over, runs it, and pulls the results back.
#
# Per working tree (main checkouts, `git worktree`s and submodules -- anything with a .git):
#   status.txt     branch, upstream, `git status`, worktree list
#   unpushed.txt   local branches with commits no remote-tracking ref has, and those commits
#   dirty.patch    `git diff HEAD --binary`: staged + unstaged tracked changes (apply with `git apply`)
#   wip.bundle     unpushed commits of every branch (restore with `git fetch <bundle> 'refs/*:refs/rescued/*'`)
#   untracked.tgz  untracked, NOT-ignored files up to $MAX_FILE_MB each; larger ones are listed in
#                  untracked-large.txt. Ignored files (.env, venvs, node_modules) are left out on
#                  purpose: secrets stay on the box, the rest is rebuildable.
#
# Read-only on the repos: no stash, checkout or ref writes. `git stash create` builds a commit
# object for the dirty state without touching the index, worktree or stash list; it is used only
# when PUSH_WIP=1, which also pushes each unpushed branch tip and dirty snapshot to
# refs/wip/spark/<tree>/<branch> on origin (hidden refs: not branches, no CI).
set -uo pipefail

OUT_DIR=${OUT_DIR:-$HOME/rescue}
MAX_FILE_MB=${MAX_FILE_MB:-50}
PUSH_WIP=${PUSH_WIP:-0}
ROOTS=("$@")
[ ${#ROOTS[@]} -gt 0 ] || ROOTS=("$HOME/src" "$HOME/tools" "$HOME/spark-ml")

OUT="$OUT_DIR/code"
mkdir -p "$OUT"
MANIFEST="$OUT/MANIFEST.txt"
: > "$MANIFEST"
failures=0

note() { printf '%s\n' "$*" | tee -a "$MANIFEST"; }
fail() { note "  FAILED: $*"; failures=$((failures + 1)); }

# Every .git: a directory for a main checkout, a file for worktrees and submodules.
mapfile -d '' GITS < <(find "${ROOTS[@]}" -maxdepth 7 \
  \( -name node_modules -o -name .venv -o -name .cache -o -name __pycache__ -o -name .mypy_cache \) -prune \
  -o -name .git -print0 2>/dev/null)

declare -A SEEN=()
declare -A BUNDLED=()   # per repository (git common dir): worktrees share branches, bundle them once
for g in "${GITS[@]}"; do
  tree=$(cd "$(dirname "$g")" && pwd -P)
  [ -n "${SEEN[$tree]:-}" ] && continue
  SEEN[$tree]=1
  git -C "$tree" rev-parse --is-inside-work-tree >/dev/null 2>&1 || continue

  rel=${tree#"$HOME"/}
  slug=${rel//\//__}
  dest="$OUT/$slug"
  mkdir -p "$dest"
  # A repo with no commits has no HEAD: every file is untracked, so only the tarball applies.
  has_head=1
  git -C "$tree" rev-parse -q --verify HEAD >/dev/null 2>&1 || has_head=0
  head=$(git -C "$tree" symbolic-ref -q --short HEAD 2>/dev/null \
    || git -C "$tree" rev-parse -q --short HEAD 2>/dev/null \
    || echo "no commits")
  common=$(cd "$tree" && cd "$(git rev-parse --git-common-dir)" && pwd -P)
  note "== $rel  [$head]"

  {
    echo "tree:     $tree"
    echo "branch:   $head"
    echo "upstream: $(git -C "$tree" rev-parse --abbrev-ref '@{u}' 2>/dev/null || echo none)"
    echo "HEAD:     $(git -C "$tree" rev-parse HEAD 2>/dev/null)"
    echo
    git -C "$tree" status --short --branch 2>&1
    echo
    git -C "$tree" worktree list 2>&1
  } > "$dest/status.txt"

  # Unpushed: reachable from a local branch, from no remote-tracking ref. Remote-tracking refs may be
  # stale (no fetch here -- the network may be the next thing to go), which can only OVER-report.
  unpushed_branches=()
  if [ -n "${BUNDLED[$common]:-}" ]; then
    note "  branches: already bundled with ${BUNDLED[$common]} (same repository)"
  else
    BUNDLED[$common]=$rel
    : > "$dest/unpushed.txt"
    while IFS= read -r b; do
      n=$(git -C "$tree" rev-list --count "refs/heads/$b" --not --remotes 2>/dev/null || echo 0)
      if [ "$n" -gt 0 ]; then
        unpushed_branches+=("$b")
        { echo "## $b  ($n unpushed)"; git -C "$tree" log --oneline "refs/heads/$b" --not --remotes; echo; } >> "$dest/unpushed.txt"
      fi
    done < <(git -C "$tree" for-each-ref --format='%(refname:short)' refs/heads/)
  fi

  if [ ${#unpushed_branches[@]} -gt 0 ]; then
    refs=()
    for b in "${unpushed_branches[@]}"; do refs+=("refs/heads/$b"); done
    if git -C "$tree" bundle create "$dest/wip.bundle" "${refs[@]}" --not --remotes >/dev/null 2>&1; then
      note "  unpushed: ${#unpushed_branches[@]} branch(es) -> wip.bundle $(du -h "$dest/wip.bundle" | cut -f1) (list in unpushed.txt)"
    else
      fail "bundle for ${unpushed_branches[*]}"
    fi
  fi

  [ -s "$dest/unpushed.txt" ] || rm -f "$dest/unpushed.txt"

  # Tracked changes, staged and unstaged, as one patch against HEAD.
  if [ "$has_head" = 1 ] && ! git -C "$tree" diff --quiet HEAD 2>/dev/null; then
    if git -C "$tree" diff HEAD --binary > "$dest/dirty.patch" 2>/dev/null; then
      note "  dirty: $(git -C "$tree" diff HEAD --shortstat 2>/dev/null | sed 's/^ *//') -> dirty.patch"
    else
      fail "diff"
    fi
  else
    rm -f "$dest/dirty.patch"
  fi

  # Untracked, not ignored. Split by size so one stray artifact can't stall the whole pull.
  #
  # Three filters on top of .gitignore, each learned from a dry run on a laptop with the same repos
  # (2026-09-29), which pulled 77,865 node_modules entries through the first version:
  #  1. Nested trees. A repo that keeps worktrees in an un-ignored dir (.worktrees/) sees each whole
  #     worktree -- node_modules included -- as untracked. Nested worktrees and submodules are swept
  #     as trees of their own, so anything under one is skipped here.
  #  2. Dependency/cache dirs, whatever .gitignore says: rebuildable, and huge.
  #  3. Secret-shaped files: .env* (examples excepted), keys, certs. Counted, never copied.
  nested=()
  while IFS= read -r -d '' n; do
    nd=$(dirname "$n"); nested+=("${nd#"$tree"/}")
  done < <(find "$tree" -mindepth 2 -maxdepth 6 \( -name node_modules -o -name .venv \) -prune -o -name .git -print0 2>/dev/null)
  skipped_nested=0 skipped_junk=0 skipped_secret=0
  small=$(mktemp)
  : > "$dest/untracked-large.txt"
  while IFS= read -r -d '' f; do
    inner=0
    for p in "${nested[@]}"; do [[ $f == "$p"/* ]] && { inner=1; break; }; done
    if [ "$inner" = 1 ]; then skipped_nested=$((skipped_nested + 1)); continue; fi
    if [[ "/$f" =~ /(node_modules|\.venv|venv|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.next|\.turbo)/ ]]; then
      skipped_junk=$((skipped_junk + 1)); continue
    fi
    base=${f##*/}
    case $base in
      *.example|*.sample|*.template) ;;
      .env|.env.*|*.pem|*.key|*.p12|*.pfx|id_rsa*|id_ed25519*|credentials|.netrc)
        skipped_secret=$((skipped_secret + 1)); continue ;;
    esac
    size=$(stat -c %s "$tree/$f" 2>/dev/null || stat -f %z "$tree/$f" 2>/dev/null || echo 0)   # GNU, then BSD
    if [ "$size" -le $((MAX_FILE_MB * 1024 * 1024)) ]; then
      printf '%s\0' "$f" >> "$small"
    else
      printf '%s\t%s MB\n' "$f" $((size / 1024 / 1024)) >> "$dest/untracked-large.txt"
    fi
  done < <(git -C "$tree" ls-files --others --exclude-standard -z 2>/dev/null)
  if [ -s "$small" ]; then
    if tar -C "$tree" --null -T "$small" -czf "$dest/untracked.tgz" 2>/dev/null; then
      note "  untracked: $(tr -cd '\0' < "$small" | wc -c | tr -d ' ') files -> untracked.tgz $(du -h "$dest/untracked.tgz" | cut -f1)"
    else
      fail "untracked tar"
    fi
  fi
  rm -f "$small"
  [ $((skipped_nested + skipped_junk + skipped_secret)) -gt 0 ] && \
    note "  skipped: $skipped_nested in nested trees, $skipped_junk in dependency/cache dirs, $skipped_secret secret-shaped"
  [ -s "$dest/untracked-large.txt" ] && note "  untracked >${MAX_FILE_MB}MB listed (not copied): $(wc -l < "$dest/untracked-large.txt")" || rm -f "$dest/untracked-large.txt"

  if [ "$PUSH_WIP" = 1 ] && git -C "$tree" remote get-url origin >/dev/null 2>&1; then
    for b in "${unpushed_branches[@]}"; do
      git -C "$tree" push -q origin "refs/heads/$b:refs/wip/spark/$slug/$b" 2>/dev/null \
        && note "  pushed refs/wip/spark/$slug/$b" || fail "push $b"
    done
    snap=$(git -C "$tree" stash create 2>/dev/null)
    if [ -n "$snap" ]; then
      git -C "$tree" push -q origin "$snap:refs/wip/spark/$slug/${head}-dirty" 2>/dev/null \
        && note "  pushed dirty snapshot refs/wip/spark/$slug/${head}-dirty" || fail "push dirty snapshot"
    fi
  fi
done

note ""
note "trees: ${#SEEN[@]}  failures: $failures  total size: $(du -sh "$OUT" | cut -f1)"
[ "$failures" -eq 0 ]
