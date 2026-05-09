---
name: "install-mac"
description: "Install the imessage-bridge agent on a Mac as a permanent macOS LaunchAgent. The agent receives messages from the AMQP queue and sends them via Messages.app."
domain: "imessage-bridge, deployment, macos"
trigger_phrases:
  - "install on mac"
  - "install the mac agent"
  - "set up the consumer"
  - "make the bridge run permanently"
  - "install as daemon"
  - "install as launchagent"
confidence: "high"
license: MIT
---

# Install the agent on Mac (as a permanent LaunchAgent)

The Mac agent long-polls the AMQP queue and sends each message through `Messages.app` via `osascript`. It runs as a per-user macOS LaunchAgent (`com.imessage-bridge.agent`) — auto-start at login, auto-restart on crash, throttled to one launch per minute, background priority.

## When to use this skill

User says any of:
- "install on Mac" / "set up the Mac side"
- "make this run permanently" / "install as a daemon" / "install as launchd"
- "I'm done testing — make it auto-start"

## Prerequisites

| What | Why | Install |
|---|---|---|
| macOS (any modern version, ≥10.10) | Runtime | n/a |
| Messages.app signed into iMessage with the same Apple ID you'll use | The whole point | `Settings → Apple ID` |
| `uv` | Python tooling — never `pip` or `python3` directly | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| `az` CLI | OAuth login + RBAC | https://learn.microsoft.com/cli/azure/install-azure-cli |
| Azure subscription + Service Bus queue (provisioned once per project) | The broker | See [`infra/azure-quickstart.md`](../../infra/azure-quickstart.md) §1 |

## Steps

```bash
# 1. Clone, sync, configure
gh repo clone paulyuk/imessage-bridge && cd imessage-bridge
uv sync
cp config.example.json config.json
# Edit config.json: set namespace_fqdn + queue (same values as the producer used).

# 2. Log in as the Mac's Azure AD identity
az login

# 3. Grant this identity the Receiver role on the queue (one-time)
ME=$(az ad signed-in-user show --query id -o tsv)
SCOPE=$(az servicebus queue show -g <RG> --namespace-name <NS> -n <QUEUE> --query id -o tsv)
az role assignment create --assignee "$ME" --role "Azure Service Bus Data Receiver" --scope "$SCOPE"
# Wait up to ~5 minutes for propagation.

# 4. **Run once in the foreground** so macOS shows the Automation prompt
#    and you can click Allow for Messages.app:
uv run mac/agent.py
# Send a test message from another machine via the producer; watch the Mac
# pick it up and the iMessage actually deliver. Then ctrl-C to stop.
#
# ⚠️ Skipping this step makes launchd fail silently with
#    "Not authorized to send Apple events to Messages."

# 5. Install as a permanent LaunchAgent
./mac/launchd/install.sh
# The installer renders the plist template (com.imessage-bridge.agent.plist),
# plutil-lints it, copies to ~/Library/LaunchAgents/, and registers via the
# modern `launchctl bootstrap gui/$UID` API. Idempotent — safe to re-run
# after `git pull`.
```

## Verify it worked

```bash
./bin/doctor.sh
# expected on a Mac:
#   ✅ uv installed
#   ✅ Python 3.10+
#   ✅ config.json is valid JSON
#   ✅ az is logged in
#   ✅ have Azure Service Bus Data Receiver on imsg-queue
#   ✅ all pytest tests pass
#   ✅ com.imessage-bridge.agent state = running
#   ✅ logs/agent.log written Xm ago (idle long-poll is normal)
#   ✅ healthy
```

Or directly:
```bash
launchctl print gui/$(id -u)/com.imessage-bridge.agent | head -20
# look for:  state = running
```

## Cheat sheet (after install)

```bash
# Status
launchctl print gui/$(id -u)/com.imessage-bridge.agent | head -20

# Follow the application log
tail -F logs/agent.log

# Force a restart (e.g. after `git pull`)
launchctl kickstart -k gui/$(id -u)/com.imessage-bridge.agent
# Or: ./mac/launchd/install.sh   # also re-renders the plist

# Stop and remove entirely
./mac/launchd/uninstall.sh
```

## Common failures

| Symptom | Likely cause | Fix |
|---|---|---|
| `Not authorized to send Apple events to Messages` in `logs/agent.launchd.log` | Skipped step 4 | Run `uv run mac/agent.py` in a Terminal once, click **Allow**, then re-run `./mac/launchd/install.sh` |
| `state = unknown` from `launchctl print` | Plist not bootstrapped | Re-run `./mac/launchd/install.sh` |
| `Bootstrap failed: 5: Input/output error` | Plist file got removed before bootstrap (e.g. legacy migration script) | Re-run `./mac/launchd/install.sh` |
| Daemon keeps restarting (with 60s gaps in log) | Throttled crash loop — config missing, expired `az` token, or import error | `tail -50 logs/agent.launchd.log` to see the actual error |
| Agent log goes silent for hours | AMQP connection drift | The agent has built-in reconnect + backoff; if persistent, restart with `launchctl kickstart -k …` |

Full operational issues: [`TROUBLESHOOTING.md`](../../TROUBLESHOOTING.md) §macOS / §launchd.

## Anti-patterns — do not

- ❌ Skip the foreground run in step 4 — Messages.app Automation perm cannot be granted from a launchd-spawned process
- ❌ Use `launchctl load` / `launchctl unload` (deprecated since macOS 10.10) — use `bootstrap` / `bootout`
- ❌ Run the agent as root or via `sudo`
- ❌ Hand-edit the plist in `~/Library/LaunchAgents/` — re-run `./mac/launchd/install.sh` instead
