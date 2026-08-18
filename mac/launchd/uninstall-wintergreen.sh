#!/usr/bin/env bash
# Stop and remove the Wintergreen Signal listener LaunchAgent.
set -euo pipefail

LABEL="com.imessage-bridge.wintergreen-agent"
DEST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
SERVICE="gui/$(id -u)/${LABEL}"

launchctl bootout "${SERVICE}" 2>/dev/null || true
if [[ -f "${DEST}" ]]; then
  rm -f "${DEST}"
  echo "✅ removed: ${DEST}"
else
  echo "ℹ️  no plist at ${DEST} — nothing to remove"
fi
