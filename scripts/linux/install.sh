#!/usr/bin/env bash
# Install Minions-ai for the current user: binary on PATH, app icon and menu entry.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
data="${XDG_DATA_HOME:-$HOME/.local/share}"
bin="${XDG_BIN_HOME:-$HOME/.local/bin}"

install -d "$bin" "$data/applications" "$data/icons/hicolor/512x512/apps"
install -m 755 "$here/minions-ai" "$bin/minions-ai"
install -m 644 "$here/icons/minions-ai-512.png" "$data/icons/hicolor/512x512/apps/minions-ai.png"
sed "s|^Exec=.*|Exec=$bin/minions-ai|; s|^TryExec=.*|TryExec=$bin/minions-ai|" \
  "$here/minions-ai.desktop" > "$data/applications/minions-ai.desktop"
chmod 644 "$data/applications/minions-ai.desktop"

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$data/applications" >/dev/null 2>&1 || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -q "$data/icons/hicolor" 2>/dev/null || true
fi

echo "Installed Minions-ai: $bin/minions-ai"
echo "Open it from your application menu, or run: minions-ai"
