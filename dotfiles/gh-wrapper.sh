#!/usr/bin/env bash
# gh, minus the GNOME keyring. That keyring only unlocks at a graphical login; over ssh it is
# locked, so any gh command that touches it raises an unlock dialog on the physical monitor and
# blocks forever waiting for a password nobody can see. Hiding the session bus makes the keyring
# unreachable, so gh falls back to plaintext ~/.config/gh/hosts.yml (--insecure-storage).
# Unsetting the variable is NOT enough: the D-Bus client falls back to $XDG_RUNTIME_DIR/bus and
# finds the keyring anyway. A dead address makes the connection fail instantly instead.
# Every caller goes through here -- shells, scripts, and Claude Code -- which is why this is a
# wrapper on PATH rather than a shell alias.
export DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent/gh-no-keyring
exec "$HOME/.local/bin/gh.real" "$@"
