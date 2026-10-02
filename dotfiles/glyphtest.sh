#!/usr/bin/env bash
# Render candidate status-cluster glyph sets in YOUR terminal font, flush and spaced.
# The overlap comes from mixing a plain-text glyph with Nerd Font icons: they have different
# advance widths. Sets D-F are all-Nerd-Font, so the metrics match.
#   bash dotfiles/glyphtest.sh   -> pick a row, tell Claude the letter and flush/spaced
g='\033[1;32m'; r='\033[1;31m'; z='\033[0m'

row() { # label  bolt  tmux  cloud
  printf "  %-3s flush: ${g}%b${z}${r}%b${z}${g}%b${z} 22:22:59   spaced: ${g}%b${z} ${r}%b${z} ${g}%b${z} 22:22:59\n" \
    "$1" "$2" "$3" "$4" "$2" "$3" "$4"
}

echo
echo "  (green = active, red = inactive, as in the prompt)"
echo
echo "  text bolt + nerd icons"
row A '⚡' '' ''   # window-restore
row B '⚡' '' ''   # columns
row C '⚡' '' ''   # codicon tmux
echo
echo "  all nerd icons (matched widths)"
row D '' '' ''   # fa bolt + window-restore
row E '' '' ''   # fa bolt + columns
row F '' '' ''   # fa bolt + th-large grid
row G '' '' ''   # fa bolt + codicon tmux + AWS logo
echo
echo "  current"
row now '⚡' '⧉' ''
echo
