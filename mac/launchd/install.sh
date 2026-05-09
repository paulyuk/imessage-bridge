#!/usr/bin/env bash
# Install (or reinstall) the iMessage bridge as a macOS LaunchAgent.
#
# Idempotent: safe to run repeatedly. If the agent is already installed it will
# be unloaded, the plist regenerated from the template, and the agent reloaded.
#
# Usage:
#   mac/launchd/install.sh           # install + start
#
# What it does:
#   1. Detects absolute paths for node, $HOME, and the repo root.
#   2. Substitutes them into mac/launchd/com.imessage-bridge.agent.plist.
#   3. Copies the result to ~/Library/LaunchAgents/.
#   4. Registers it with `launchctl bootstrap gui/$UID` (modern API).
#   5. Kickstarts it so you don't have to wait for the next login.
#
# Requires: macOS, Node ≥18 (https://nodejs.org/ or `brew install node`).

set -euo pipefail

LABEL="com.imessage-bridge.agent"
PLIST_FILE="${LABEL}.plist"

# --- Locate the repo (the directory above mac/launchd/) ---------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
TEMPLATE="${SCRIPT_DIR}/${PLIST_FILE}"

if [[ ! -f "${TEMPLATE}" ]]; then
  echo "❌ template not found: ${TEMPLATE}" >&2
  exit 1
fi

# --- Required: node ≥22 (Active LTS) on PATH ---------------------------------
NODE_BIN="$(command -v node || true)"
if [[ -z "${NODE_BIN}" ]]; then
  echo "❌ node not found on PATH. Install Node ≥22 (Active LTS):" >&2
  echo "   brew install node            # macOS, Homebrew" >&2
  echo "   or:  https://nodejs.org/" >&2
  exit 1
fi
NODE_MAJOR="$("${NODE_BIN}" -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
if [[ "${NODE_MAJOR}" -lt 22 ]]; then
  echo "❌ node version too old: $("${NODE_BIN}" --version) — require ≥22 (Active LTS)" >&2
  exit 1
fi

# --- Required: built CLI (dist/cli.js) ---------------------------------------
ENTRY="${REPO_ROOT}/dist/cli.js"
if [[ ! -f "${ENTRY}" ]]; then
  echo "ℹ️  dist/cli.js missing — building TypeScript …" >&2
  ( cd "${REPO_ROOT}" && npm install --silent && npm run build --silent ) || {
    echo "❌ build failed. Try manually: cd ${REPO_ROOT} && npm install && npm run build" >&2
    exit 1
  }
fi

# --- Required: config.json exists -----------------------------------------
if [[ ! -f "${REPO_ROOT}/config.json" ]]; then
  echo "❌ ${REPO_ROOT}/config.json not found." >&2
  echo "   Run: cp config.example.json config.json && \$EDITOR config.json" >&2
  exit 1
fi

# --- Render the plist ------------------------------------------------------
mkdir -p "${REPO_ROOT}/logs"
DEST_DIR="${HOME}/Library/LaunchAgents"
DEST="${DEST_DIR}/${PLIST_FILE}"
mkdir -p "${DEST_DIR}"

# Use a repo-local scratch file so a partial write can't leave a broken plist behind.
TMP="${REPO_ROOT}/.launchd.${LABEL}.$$.plist"
trap 'rm -f "${TMP}"' EXIT

sed \
  -e "s|__NODE__|${NODE_BIN}|g" \
  -e "s|__REPO__|${REPO_ROOT}|g" \
  -e "s|__HOME__|${HOME}|g" \
  "${TEMPLATE}" >"${TMP}"

# Validate the rendered plist before installing it.
if ! /usr/bin/plutil -lint "${TMP}" >/dev/null; then
  echo "❌ rendered plist failed plutil -lint:" >&2
  /usr/bin/plutil -lint "${TMP}" >&2
  exit 1
fi

mv "${TMP}" "${DEST}"
trap - EXIT

# --- (Re)register with launchd --------------------------------------------
DOMAIN="gui/$(id -u)"
SERVICE="${DOMAIN}/${LABEL}"

# bootout is idempotent enough for our needs — ignore failure if not loaded.
launchctl bootout "${SERVICE}" 2>/dev/null || true
launchctl bootstrap "${DOMAIN}" "${DEST}"
launchctl enable   "${SERVICE}"
launchctl kickstart -k "${SERVICE}"

echo "✅ installed and started: ${LABEL}"
echo "   plist:    ${DEST}"
echo "   node:     ${NODE_BIN} ($("${NODE_BIN}" --version))"
echo "   logs:     ${REPO_ROOT}/logs/agent.log"
echo "             ${REPO_ROOT}/logs/agent.launchd.log  (early-startup errors)"
echo
echo "Useful commands:"
echo "   launchctl print ${SERVICE} | head -40       # status"
echo "   tail -F ${REPO_ROOT}/logs/agent.log         # follow app log"
echo "   mac/launchd/uninstall.sh                    # stop + remove"
