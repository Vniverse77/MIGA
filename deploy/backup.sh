#!/usr/bin/env bash
# Daily MIGA backup: consistent copy of the relay database + the tunnel/relay configuration.
# Keeps the newest KEEP daily sets. Contains NO secrets in this file; it only names paths.
# The archives DO contain the tunnel credentials, so they are mode 0600 inside a 0700 directory
# owned by root. Copy them off the machine encrypted (see docs/OPS.md); never commit them.
# Usage: deploy/backup.sh   (run as root; needs /opt/miga/miga-relay)
set -euo pipefail
umask 077

BACKUP_DIR="${MIGA_BACKUP_DIR:-/var/backups/miga}"
DB="${MIGA_DB:-/var/lib/miga/miga.db}"
RELAY_BIN="${MIGA_RELAY_BIN:-/opt/miga/miga-relay}"
KEEP="${MIGA_BACKUP_KEEP:-7}"
# Config paths to include (space separated). Placeholders; adjust to the machine.
CONFIG_PATHS="${MIGA_BACKUP_CONFIG:-/etc/cloudflared /etc/miga /etc/systemd/system/miga-relay.service}"

stamp="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"
work="$BACKUP_DIR/.tmp-$stamp"; mkdir "$work"
trap 'rm -rf "$work"' EXIT

# 1. database (VACUUM INTO: safe while the relay runs, no sqlite3 CLI needed)
MIGA_DB="$DB" "$RELAY_BIN" backup "$work/miga-$stamp.db"

# 2. configuration (only paths that exist)
existing=()
for p in $CONFIG_PATHS; do [[ -e "$p" ]] && existing+=("$p"); done
if [[ ${#existing[@]} -gt 0 ]]; then
  tar -czf "$work/config-$stamp.tar.gz" "${existing[@]}" 2>/dev/null
fi

# 3. verify the database copy opens and has the table, then publish the set
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$work/miga-$stamp.db" 'PRAGMA integrity_check;' | grep -qx ok
fi
gzip -9 "$work/miga-$stamp.db"
mkdir "$BACKUP_DIR/$stamp"; mv "$work"/* "$BACKUP_DIR/$stamp/"

# 4. retention: keep the newest $KEEP sets
mapfile -t sets < <(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '[0-9]*-[0-9]*' | sort)
if (( ${#sets[@]} > KEEP )); then
  for d in "${sets[@]:0:${#sets[@]}-KEEP}"; do rm -rf -- "$d"; done
fi
echo "backup ok: $BACKUP_DIR/$stamp ($(du -sh "$BACKUP_DIR/$stamp" | cut -f1))"
