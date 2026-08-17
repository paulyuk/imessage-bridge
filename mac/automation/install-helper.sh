#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="${SCRIPT_DIR}/MessageAutomation.swift"
DEST_DIR="${HOME}/Library/Application Support/iMessageBridge"
DEST="${DEST_DIR}/imessage-bridge-automation"

mkdir -p "${DEST_DIR}"
/usr/bin/xcrun swiftc -O -o "${DEST}" "${SOURCE}"
/usr/bin/codesign --force --sign - --identifier com.paulyuk.imessage-bridge.automation "${DEST}"
echo "Installed ${DEST}"
echo "Add this path to config.json as automation_helper_path:"
echo "  ${DEST}"
