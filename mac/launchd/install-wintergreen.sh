#!/usr/bin/env bash
# Install the Wintergreen Azure Storage Queue Signal listener as a LaunchAgent.
set -euo pipefail

LABEL="com.imessage-bridge.wintergreen-agent"
PLIST_FILE="${LABEL}.plist"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
TEMPLATE="${SCRIPT_DIR}/${PLIST_FILE}"

NODE_BIN="$(command -v node || true)"
if [[ -z "${NODE_BIN}" ]]; then
  echo "❌ node not found on PATH. Install Node ≥22 (Active LTS)." >&2
  exit 1
fi
NODE_MAJOR="$("${NODE_BIN}" -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
if [[ "${NODE_MAJOR}" -lt 22 ]]; then
  echo "❌ node version too old: $("${NODE_BIN}" --version) — require ≥22 (Active LTS)" >&2
  exit 1
fi

SIGNAL_CLI_BIN="$(command -v signal-cli || true)"
if [[ -z "${SIGNAL_CLI_BIN}" || ! -x "${SIGNAL_CLI_BIN}" ]]; then
  echo "❌ signal-cli not found on PATH. Install it with: brew install signal-cli" >&2
  exit 1
fi

ENTRY="${REPO_ROOT}/dist/cli.js"
if [[ ! -f "${ENTRY}" ]]; then
  echo "ℹ️  dist/cli.js missing — building TypeScript …" >&2
  (cd "${REPO_ROOT}" && npm install --silent && npm run build --silent)
fi

CONFIG="${REPO_ROOT}/config.json"
if [[ ! -f "${CONFIG}" ]]; then
  echo "❌ ${CONFIG} not found. Create it from config.example.json." >&2
  exit 1
fi
if ! "${NODE_BIN}" -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.exit(c.signal_account ? 0 : 1)' "${CONFIG}"; then
  echo "❌ config.json is missing \"signal_account\" for Wintergreen Signal delivery." >&2
  exit 1
fi

mkdir -p "${REPO_ROOT}/logs" "${HOME}/Library/LaunchAgents"
DEST="${HOME}/Library/LaunchAgents/${PLIST_FILE}"
TMP="${REPO_ROOT}/.launchd.${LABEL}.$$.plist"
trap 'rm -f "${TMP}"' EXIT
sed \
  -e "s|__NODE__|${NODE_BIN}|g" \
  -e "s|__REPO__|${REPO_ROOT}|g" \
  -e "s|__HOME__|${HOME}|g" \
  -e "s|__SIGNAL_CLI__|${SIGNAL_CLI_BIN}|g" \
  "${TEMPLATE}" >"${TMP}"
/usr/bin/plutil -lint "${TMP}" >/dev/null
mv "${TMP}" "${DEST}"
trap - EXIT

DOMAIN="gui/$(id -u)"
SERVICE="${DOMAIN}/${LABEL}"
launchctl bootout "${SERVICE}" 2>/dev/null || true
launchctl bootstrap "${DOMAIN}" "${DEST}"
launchctl enable "${SERVICE}"
launchctl kickstart -k "${SERVICE}"
echo "✅ installed and started: ${LABEL}"
echo "   logs: ${REPO_ROOT}/logs/wintergreen-agent.log"
