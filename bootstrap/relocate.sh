#!/usr/bin/env bash
# Move the conf and spar-cli checkouts out of ~/src and re-point every symlink that referenced them.
# ~/src is for project repos; these two are tooling. conf is symlinked into ~/.config and ~/.gitconfig
# in 16 places, so moving it without relinking silently breaks the shell, the prompt and git identity.
#
#   bash relocate.sh ~/tools        # destination dir, created if missing
set -euo pipefail

DEST="${1:?usage: relocate.sh <destination-dir>   e.g. relocate.sh ~/tools}"
mkdir -p "$DEST"
DEST="$(cd "$DEST" && pwd)"

REPOS="${REPOS:-conf spar-cli}"
for repo in $REPOS; do
  src="$HOME/src/$repo"
  if [ -d "$DEST/$repo" ]; then
    echo "  already at $DEST/$repo"
  elif [ -d "$src" ]; then
    mv "$src" "$DEST/$repo"
    echo "  moved $src -> $DEST/$repo"
  else
    echo "  $src not present, skipping"
  fi
done

# Re-point every symlink whose target was under the old location. Links are found by their TARGET,
# not by walking the (now missing) directory, so broken ones are still caught.
echo "relinking:"
while IFS= read -r -d '' link; do
  target="$(readlink "$link")"
  moved=""
  for repo in $REPOS; do
    case "$target" in
      "$HOME/src/$repo"/*) ln -sfn "$DEST/$repo${target#"$HOME/src/$repo"}" "$link"; moved=1 ;;
    esac
  done
  [ -n "$moved" ] || continue
  echo "  $link -> $(readlink "$link")"
done < <(find "$HOME/.config" "$HOME/.gitconfig" "$HOME/.claude" -maxdepth 4 -type l -print0 2>/dev/null)

echo
echo "verifying (nothing should print below):"
find "$HOME/.config" "$HOME/.gitconfig" -maxdepth 4 -type l ! -exec test -e {} \; -print 2>/dev/null
git config --global user.email >/dev/null && echo "  git identity OK: $(git config --global user.email)"
echo
echo "Done. Re-run the laptop-side install if the CLI moved: uv tool install --editable $DEST/spar-cli"
