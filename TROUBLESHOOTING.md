# TROUBLESHOOTING.md

Quick lookup for the failure modes you'll actually hit.

## Auth / Azure

### `DefaultAzureCredential failed to retrieve a token`

You haven't logged in, or the cached token expired and your shell can't refresh it.

```bash
az account show              # are you logged in?
az login                     # if not
az account get-access-token  # force refresh + verify
```

If you have multiple subscriptions, set the default:
```bash
az account set --subscription "<name-or-id>"
```

### `AccessDenied` / `Unauthorized` / 401 on send or receive

Your identity doesn't have the right RBAC role on the queue.

```bash
# Find your object id
ME=$(az ad signed-in-user show --query id -o tsv)

# What roles do you currently have on the namespace?
az role assignment list --assignee $ME --scope /subscriptions/.../namespaces/<NS> -o table

# Grant the role you need
SCOPE=$(az servicebus queue show -g <RG> --namespace-name <NS> -n <QUEUE> --query id -o tsv)
az role assignment create --assignee $ME --role "Azure Service Bus Data Sender" --scope $SCOPE
# (or "Azure Service Bus Data Receiver" for the agent)
```

Role assignments can take **up to 5 minutes** to propagate.

### `The token has an invalid signature` / `AADSTS500011`

Tenant mismatch. `az login` is in a different tenant than your Service Bus subscription.

```bash
az login --tenant <correct-tenant-id>
```

## Service Bus

### Producer says "enqueued" but agent never receives

1. Check the queue length:
   ```bash
   az servicebus queue show -g <RG> --namespace-name <NS> -n <QUEUE> --query "messageCount"
   ```
2. Make sure both producer and agent point at the same `namespace_fqdn` and `queue` in `config.json`.
3. Make sure the agent identity has the **Receiver** role (not just Sender).

### Messages stuck — keep getting redelivered

The agent is calling `abandon_message` because `osascript` fails. See the macOS permissions section below. For the daemon, check `logs/agent.launchd.log` first; it captures stdout/stderr from before Python logging starts.

### Messages going to dead-letter queue

The agent dead-letters on bad payloads (missing `to` or `body`). View dead-letter messages:

```bash
az servicebus queue show -g <RG> --namespace-name <NS> -n <QUEUE> \
  --query "countDetails.deadLetterMessageCount"
```

Drain DLQ for inspection (PowerShell / Service Bus Explorer / az ext servicebus).

## macOS / Messages.app

### `osascript: execution error: Not authorized to send Apple events to Messages`

Grant Automation permission:

> System Settings → Privacy & Security → Automation → **(the parent process)** → ✅ Messages

The "parent process" is whatever launched the agent:
- Foreground from Terminal → grant **Terminal** permission
- launchd → do the foreground run first, then restart with `./mac/launchd/install.sh`

### Agent runs but `Messages.app` doesn't open / isn't signed in

`Messages.app` must be running and signed into iMessage. Open it manually once and confirm you can send a normal iMessage.

### `buddy "+1425..." doesn't exist`

The recipient hasn't been resolved by Messages.app yet. Try sending them an iMessage manually first, then retry the agent. For non-iMessage recipients (SMS-only Android numbers), this bridge won't work — Messages.app needs an iMessage handle.

## launchd

### My daemon isn't working — start here

Read the launchd log first. It catches the failures that happen before the
agent's structured logger is ready: missing `config.json`, import errors,
expired `az` login, and macOS Automation denials.

```bash
tail -n 50 logs/agent.launchd.log
```

Then check the service state:

```bash
launchctl print gui/$(id -u)/com.imessage-bridge.agent | head -20
# look for: state = running
```

And follow the app log while you send a test message:

```bash
tail -F logs/agent.log
```

### Common daemon commands

```bash
./mac/launchd/install.sh                                         # install / re-render / restart
launchctl print gui/$(id -u)/com.imessage-bridge.agent | head -20  # status
launchctl kickstart -k gui/$(id -u)/com.imessage-bridge.agent      # restart now
launchctl enable gui/$(id -u)/com.imessage-bridge.agent            # re-enable if disabled
./mac/launchd/uninstall.sh                                       # stop + remove
```

The installer renders `mac/launchd/com.imessage-bridge.agent.plist` (a template),
validates it with `plutil -lint`, and registers via `launchctl bootstrap gui/$UID`
(the modern API; `load`/`unload` are deprecated since macOS 10.10).

### The #1 launchd gotcha: Automation permission

macOS only shows the **Automation** prompt during an interactive foreground run.
launchd cannot display it. If you skipped the foreground run, the daemon may be
running but every send fails with *"Not authorized to send Apple events to
Messages."*

```bash
uv run mac/agent.py
# click Allow on the Automation prompt, then ctrl-C
./mac/launchd/install.sh
```

You can audit the permission in:

> System Settings → Privacy & Security → Automation → (Terminal / uv / launchd) → ✅ Messages

### Plist won't load — "Service is disabled"

```bash
launchctl enable gui/$(id -u)/com.imessage-bridge.agent
launchctl kickstart -k gui/$(id -u)/com.imessage-bridge.agent
```

### Daemon keeps restarting (crash loop)

The plist throttles relaunches to once per 60 seconds, so this won't peg CPU,
but the agent still won't work until the root cause is fixed.

Common causes:
- **`config not found: config.json`** — `cp config.example.json config.json`
- **`Not authorized to send Apple events to Messages`** — do the foreground run
  above, click **Allow**, then reinstall.
- **`DefaultAzureCredential failed to retrieve a token`** — run `az login` from
  the same macOS user that owns the LaunchAgent.

### `uv: command not found` in launchd logs

The installer pins the absolute path to `uv` (`command -v uv` at install time)
into the plist, so this should not happen. If it does, you probably moved or
reinstalled `uv`. Just re-run `./mac/launchd/install.sh`.

## uv / Python

### `uv: command not found`

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
# add to PATH:
export PATH="$HOME/.local/bin:$PATH"
```

### `ModuleNotFoundError: No module named 'azure.servicebus'`

You ran the script with system `python3` instead of `uv run`. **Always use `uv run`.**

```bash
# wrong:
python3 mac/agent.py
# right:
uv run mac/agent.py
```

If you really need a shell with deps activated:
```bash
uv venv
source .venv/bin/activate
```

### Tests fail with import errors

```bash
uv sync --extra dev
uv run pytest
```

## Logs

| What                 | Where                                              |
|----------------------|----------------------------------------------------|
| Agent app log        | `./logs/agent.log` (path from `config.json`)       |
| launchd stdout+stderr | `./logs/agent.launchd.log` (early-startup errors) |
| `az` CLI debug       | `az --debug ...`                                   |

## Still stuck?

Open an issue on the upstream repo with:
- `uv --version`, `az --version`, `sw_vers` (macOS version)
- Last 30 lines of agent log
- Sanitized `config.json` (with FQDN/queue names, **never** post tokens)
