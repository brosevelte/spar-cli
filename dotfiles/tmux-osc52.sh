#!/usr/bin/env bash
# tmux copy-command: put the copied text on the CLIENT's clipboard with an OSC 52 that mosh accepts.
# Installed to ~/.local/bin/tmux-osc52 and wired up in tmux.conf.
#
# tmux's own copies (mouse drag, copy mode) go out as "ESC ]52;;<b64>" -- selection field empty.
# Ghostty takes that over ssh, but mosh 1.4 forwards OSC 52 only when the field is exactly "c",
# so every copy from a mosh session vanished. Overriding the terminal's Ms can't fix it: tmux
# reuses Ms to pass through pane copies (Claude Code, vim) that already say "c", and any format
# that forces "c" either doubles it ("cc", also dropped) or stops tmux emitting at all. So tmux's
# Ms is left alone and its own copies are written here, straight to the client terminal.
set -euo pipefail
data=$(base64 -w0)
tty=$(tmux display-message -p '#{client_tty}')
printf '\033]52;c;%s\a' "$data" > "$tty"
