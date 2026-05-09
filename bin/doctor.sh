#!/usr/bin/env bash
# imessage-bridge doctor — health check for either the producer (Linux/cloud)
# or the Mac agent host. Detects which side it's on and runs the right checks.
#
# Exit codes:
#   0  all checks passed
#   1  one or more checks failed
#   2  a check is inconclusive and needs human attention
#
# Run with:
#   ./bin/doctor.sh
#
# Always safe to re-run.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

# ---------- pretty output -----------------------------------------------------
PASS="✅"
FAIL="❌"
WARN="⚠️ "
INFO="ℹ️ "

fails=0
warns=0

check() {  # check "label" "command-string"
  local label="$1" cmd="$2"
  local out rc
  out="$(eval "$cmd" 2>&1)"; rc=$?
  if [[ $rc -eq 0 ]]; then
    echo "  ${PASS} ${label}"
    [[ -n "${VERBOSE:-}" && -n "$out" ]] && echo "       $out"
    return 0
  else
    echo "  ${FAIL} ${label}"
    [[ -n "$out" ]] && echo "       $out" | head -3 | sed 's/^/       /'
    fails=$((fails+1))
    return 1
  fi
}

warn() {  # warn "label" "explanation"
  echo "  ${WARN}$1"
  [[ -n "${2:-}" ]] && echo "     $2"
  warns=$((warns+1))
}

note() {  # note "info text"
  echo "  ${INFO}$1"
}

section() { echo; echo "── $1 ──"; }

# ---------- 1. shared checks --------------------------------------------------
section "Environment"
check "uv installed"              "command -v uv >/dev/null"
check "Python 3.10+"              "uv python find '>=3.10' >/dev/null 2>&1 || python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)'"

section "Config"
if [[ ! -f config.json ]]; then
  echo "  ${FAIL} config.json missing"
  echo "       fix: cp config.example.json config.json && \$EDITOR config.json"
  fails=$((fails+1))
else
  check "config.json is valid JSON" "python3 -c 'import json; json.load(open(\"config.json\"))'"
  fqdn=$(python3 -c 'import json; print(json.load(open("config.json")).get("namespace_fqdn",""))' 2>/dev/null || echo "")
  queue=$(python3 -c 'import json; print(json.load(open("config.json")).get("queue",""))' 2>/dev/null || echo "")
  if [[ "$fqdn" == "REPLACE-ME.servicebus.windows.net" || -z "$fqdn" ]]; then
    echo "  ${FAIL} config.json namespace_fqdn is unset (REPLACE-ME)"
    fails=$((fails+1))
  else
    echo "  ${PASS} namespace_fqdn = $fqdn"
  fi
  if [[ -z "$queue" ]]; then
    echo "  ${FAIL} config.json queue is empty"
    fails=$((fails+1))
  else
    echo "  ${PASS} queue = $queue"
  fi
fi

section "Azure auth"
if ! command -v az >/dev/null; then
  echo "  ${FAIL} az CLI not installed"
  echo "       https://learn.microsoft.com/cli/azure/install-azure-cli"
  fails=$((fails+1))
else
  check "az CLI installed"          "command -v az >/dev/null"
  check "az is logged in"           "az account show --only-show-errors -o none"
  check "can acquire AAD token"     "az account get-access-token --only-show-errors -o none"
  if [[ -n "${fqdn:-}" && -n "${queue:-}" && "$fqdn" != "REPLACE-ME.servicebus.windows.net" ]]; then
    ns="${fqdn%%.servicebus.windows.net}"
    me=$(az ad signed-in-user show --query id -o tsv 2>/dev/null || echo "")
    if [[ -n "$me" ]]; then
      # Find the queue scope and check assignments. We don't know the RG, so
      # search across the subscription for the namespace.
      scope=$(az servicebus queue show --ids \
        "$(az resource list --resource-type Microsoft.ServiceBus/namespaces --query "[?name=='$ns'].id|[0]" -o tsv 2>/dev/null)/queues/$queue" \
        --query id -o tsv 2>/dev/null || echo "")
      if [[ -n "$scope" ]]; then
        roles=$(az role assignment list --assignee "$me" --scope "$scope" --query "[].roleDefinitionName" -o tsv 2>/dev/null || echo "")
        if echo "$roles" | grep -q "Service Bus Data Sender"; then
          echo "  ${PASS} have Azure Service Bus Data Sender on $queue"
        elif echo "$roles" | grep -q "Service Bus Data Receiver"; then
          echo "  ${PASS} have Azure Service Bus Data Receiver on $queue"
        else
          warn "no Service Bus Data Sender/Receiver role on $queue (current identity)" \
               "fix: az role assignment create --assignee \$ME --role \"Azure Service Bus Data Sender\" --scope $scope"
        fi
      else
        warn "could not resolve namespace '$ns' in current subscription" \
             "may take up to 5 minutes after a fresh role assignment; or check 'az account show'"
      fi
    fi
  fi
fi

section "Tests"
if [[ -d tests ]]; then
  if uv run pytest -q --no-header -x >/tmp/imsg-doctor-pytest.log 2>&1; then
    echo "  ${PASS} all pytest tests pass"
  else
    echo "  ${FAIL} pytest failed (see /tmp/imsg-doctor-pytest.log)"
    fails=$((fails+1))
  fi
fi

# ---------- 2. host-specific checks ------------------------------------------
case "$(uname -s)" in
  Darwin)
    section "Mac agent (launchd)"
    label="com.imessage-bridge.agent"
    plist="$HOME/Library/LaunchAgents/${label}.plist"
    if [[ ! -f "$plist" ]]; then
      warn "$label not installed" "fix: ./mac/launchd/install.sh"
    else
      state=$(launchctl print "gui/$(id -u)/${label}" 2>/dev/null | awk '/^[[:space:]]*state[[:space:]]*=/ {print $3; exit}')
      if [[ "$state" == "running" ]]; then
        echo "  ${PASS} ${label} state = running"
      else
        echo "  ${FAIL} ${label} state = ${state:-unknown}"
        fails=$((fails+1))
      fi
    fi

    if [[ -f logs/agent.log ]]; then
      age=$(( $(date +%s) - $(stat -f %m logs/agent.log 2>/dev/null || stat -c %Y logs/agent.log) ))
      # AMQP long-poll keeps the log quiet between messages — a 1-hour
      # threshold is generous but still catches a truly stuck agent.
      if [[ $age -lt 3600 ]]; then
        if [[ $age -lt 60 ]]; then
          echo "  ${PASS} logs/agent.log written ${age}s ago"
        else
          echo "  ${PASS} logs/agent.log written $((age/60))m ago (idle long-poll is normal)"
        fi
      else
        warn "logs/agent.log is stale (last write $((age/60))m ago)" \
             "the agent may be silent; check logs/agent.launchd.log for errors"
      fi
    else
      warn "logs/agent.log does not exist yet" "the agent has not started successfully"
    fi

    note "Messages.app Automation permission cannot be checked from a script."
    note "If sends fail with 'Not authorized to send Apple events to Messages',"
    note "run \`uv run mac/agent.py\` once in a Terminal and click Allow."
    ;;

  Linux)
    section "Producer host"
    note "Linux/cloud producer detected — no daemon to check."
    note "Smoke-test by enqueuing one message:"
    note "  uv run producer/cli.py --to \"+15555550100\" --body \"smoke test\""
    ;;

  *)
    note "Unknown host OS ($(uname -s)) — skipping host-specific checks."
    ;;
esac

# ---------- summary -----------------------------------------------------------
echo
echo "── Summary ──"
if [[ $fails -eq 0 && $warns -eq 0 ]]; then
  echo "  ${PASS} healthy"
  exit 0
elif [[ $fails -eq 0 ]]; then
  echo "  ${WARN}${warns} warning(s) — see TROUBLESHOOTING.md"
  exit 2
else
  echo "  ${FAIL}${fails} failure(s), ${warns} warning(s) — see TROUBLESHOOTING.md"
  exit 1
fi
