#!/bin/sh
# Installs the extension for the current user and enables it.
set -eu

cd "$(dirname "$0")"

uuid=$(python3 -c 'import json; print(json.load(open("metadata.json"))["uuid"])')
dest="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$uuid"

mkdir -p "$dest/icons"
cp metadata.json extension.js scan-helper.py "$dest/"
cp icons/fluxcast-symbolic.svg "$dest/icons/"
echo "Installed to $dest"

# GNOME Shell only notices a new extension after a re-login on Wayland, so
# add it to the enabled list directly; it starts on the next login.
enabled=$(gsettings get org.gnome.shell enabled-extensions)
case "$enabled" in
    *"'$uuid'"*) ;;
    "@as []") gsettings set org.gnome.shell enabled-extensions "['$uuid']" ;;
    *) gsettings set org.gnome.shell enabled-extensions "${enabled%]}, '$uuid']" ;;
esac
echo "Enabled $uuid. Log out and back in to load it."

if ! command -v fluxcast >/dev/null 2>&1 &&
    [ ! -f /opt/fluxcast/main.py ] && [ ! -f "$HOME/.local/opt/fluxcast/main.py" ]; then
    echo "Note: FluxCast was not found. Install it from https://github.com/IlyaP358/fluxcast"
fi
