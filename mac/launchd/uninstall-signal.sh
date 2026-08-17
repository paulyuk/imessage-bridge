#!/usr/bin/env bash
# Stop and remove the Signal sibling consumer LaunchAgent.
# Idempotent: safe to run even if it's not currently installed.
set -euo pipefail

LABEL="com.imessage-bridge.signal-agent"
PLIST_FILE="${LABEL}.plist"
DEST="${HOME}/Library/LaunchAgents/${PLIST_FILE}"
DOMAIN="gui/$(id -u)"
SERVICE="${DOMAIN}/${LABEL}"

launchctl bootout "${SERVICE}" 2>/dev/null || true

if [[ -f "${DEST}" ]]; then
  rm -f "${DEST}"
  echo "✅ removed: ${DEST}"
else
  echo "ℹ️  no plist at ${DEST} — nothing to remove"
fi

echo "✅ ${LABEL} uninstalled"
