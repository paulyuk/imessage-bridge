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

The Mac agent long-polls the AMQP queue and sends each message through `Messages.app` via `osascript`. Two ways to run it:

1. **Foreground / quick** — `npx imessage-bridge@alpha agent` runs the receiver loop in the current terminal. Great for first-time Automation prompt + casual use. Combine with `tmux` / `screen` for a long-lived session without launchd.
2. **Permanent macOS LaunchAgent** — clone the repo and run `mac/launchd/install.sh`. This auto-starts at login, auto-restarts on crash, throttled to one launch per minute, background priority.

> 🛠 **Today the launchd installer wraps the original Python agent** (`uv run mac/agent.py`). The Node agent (`npx imessage-bridge@alpha agent`) is fully ported and tested with identical behavior; a Node-native launchd installer is the next milestone (v0.2.x). For now: launchd path = Python; npx path = Node. Same wire format, same config, same RBAC.

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
| Node.js ≥ 18 | Foreground `npx imessage-bridge@alpha agent` | https://nodejs.org/ or `brew install node` |
| `uv` | Required only for the launchd installer (Python agent) | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| `az` CLI | OAuth login + RBAC | https://learn.microsoft.com/cli/azure/install-azure-cli |
| Azure subscription + Service Bus queue (provisioned once per project) | The broker | See [`infra/azure-quickstart.md`](../../infra/azure-quickstart.md) §1 |

## Steps

```bash
# 1. Drop a config.json (the Node CLI reads ./config.json or $IMSG_CONFIG)
cat > ~/imessage-bridge.config.json <<'JSON'
{
  "namespace_fqdn": "<your-namespace>.servicebus.windows.net",
  "queue": "imsg-queue"
}
JSON
export IMSG_CONFIG=~/imessage-bridge.config.json

# 2. Log in as the Mac's Azure AD identity
az login

# 3. Grant this identity the Receiver role on the queue (one-time)
ME=$(az ad signed-in-user show --query id -o tsv)
SCOPE=$(az servicebus queue show -g <RG> --namespace-name <NS> -n <QUEUE> --query id -o tsv)
az role assignment create --assignee "$ME" --role "Azure Service Bus Data Receiver" --scope "$SCOPE"
# Wait up to ~5 minutes for propagation.

# 4. **Run once in the foreground** so macOS shows the Automation prompt
#    and you can click Allow for Messages.app:
npx imessage-bridge@alpha agent
# Send a test message from another machine via the producer; watch the Mac
# pick it up and the iMessage actually deliver. Then ctrl-C to stop.
#
# ⚠️ Skipping this step makes launchd fail silently with
#    "Not authorized to send Apple events to Messages."
```

### 5a. Quick & lazy — keep it foreground in `tmux`

If you don't want a launchd install, just keep the foreground agent alive:

```bash
tmux new -d -s imsg-bridge "IMSG_CONFIG=$IMSG_CONFIG npx imessage-bridge@alpha agent"
tmux attach -t imsg-bridge   # detach with ctrl-b d
```

### 5b. Permanent — install as a LaunchAgent (Python-backed today)

```bash
# Clone the repo (needed for the installer + plist template)
gh repo clone paulyuk/imessage-bridge && cd imessage-bridge
uv sync
cp config.example.json config.json   # or symlink your existing config
$EDITOR config.json                  # set namespace_fqdn + queue

./mac/launchd/install.sh
# The installer renders the plist template (com.imessage-bridge.agent.plist),
# plutil-lints it, copies to ~/Library/LaunchAgents/, and registers via the
# modern `launchctl bootstrap gui/$UID` API. Idempotent — safe to re-run
# after `git pull`.
```

## Verify it worked

```bash
# npm path:
npx imessage-bridge@alpha doctor

# from the cloned repo:
./bin/doctor.sh
# expected on a Mac:
#   ✅ uv installed
#   ✅ config.json is valid JSON
#   ✅ az is logged in
#   ✅ have Azure Service Bus Data Receiver on imsg-queue
#   ✅ com.imessage-bridge.agent state = running   (only if you did 5b)
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
| `Not authorized to send Apple events to Messages` in `logs/agent.launchd.log` | Skipped step 4 | Run `npx imessage-bridge@alpha agent` (or `uv run mac/agent.py` from a clone) in a Terminal once, click **Allow**, then re-run `./mac/launchd/install.sh` |
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
