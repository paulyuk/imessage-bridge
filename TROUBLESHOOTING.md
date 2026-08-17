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

The agent is calling `abandonMessage` because `osascript` fails. See the macOS permissions section below. For the daemon, check `logs/agent.launchd.log` first; it captures stdout/stderr from before the agent's structured logger initializes.

### Messages going to dead-letter queue

The agent dead-letters on bad payloads (missing `to` or `body`). View dead-letter messages:

```bash
az servicebus queue show -g <RG> --namespace-name <NS> -n <QUEUE> \
  --query "countDetails.deadLetterMessageCount"
```

Drain DLQ for inspection (PowerShell / Service Bus Explorer / az ext servicebus).

## Signal consumer

### `signal-cli not found on PATH` / `signal-cli spawn failed`

The Signal LaunchAgent starts `signal-cli` from the macOS user's PATH. Install
it for the same user that owns the LaunchAgent, then reinstall the agent so
the current environment is used:

```bash
brew install signal-cli
command -v signal-cli
./mac/launchd/install-signal.sh
```

If `command -v` succeeds in a terminal but the daemon still cannot find it,
read `logs/signal-agent.launchd.log`. The supplied Signal plist includes
common Homebrew locations (`/opt/homebrew/bin` and `/usr/local/bin`); a custom
installation must put `signal-cli` on that LaunchAgent PATH.

### `signal-cli failed ...` / account is not registered or linked

The bridge does not create or link Signal accounts. Stop the LaunchAgent, then
complete the account setup manually as the same macOS user:

```bash
./mac/launchd/uninstall-signal.sh
signal-cli link
```

For an existing account, scan the device-link URI with Signal's Linked devices
flow. If you intentionally need a new account instead, use signal-cli's
documented registration and verification steps in
[INSTALL.md §6](./INSTALL.md#6-optional--run-the-signal-consumer). Do **not**
use `register` to link an existing account: it can unregister an existing
client on that number. Reinstall only after linking or registration succeeds:

```bash
./mac/launchd/install-signal.sh
```

### Producer says `enqueued`, but Signal does not send

1. Confirm the producer used `signal-send`, not `send`. `signal-send` reads
   `signal_queue` and enqueues to the dedicated Signal queue (for example
   `signal-queue`); `send` remains the iMessage-only route and reads `queue`.
2. Confirm the Mac's `signal_queue` has the exact same name and the Mac
   identity has **Azure Service Bus Data Receiver** on that queue. The producer
   needs **Azure Service Bus Data Sender** on that same queue.
3. Check the Signal consumer, not the iMessage consumer:

   ```bash
   launchctl print gui/$(id -u)/com.imessage-bridge.signal-agent | head -20
   tail -F logs/signal-agent.log
   tail -n 50 logs/signal-agent.launchd.log
   ```

4. The Signal consumer accepts only valid E.164 destinations such as
   `+15555550100`. Signal usernames and local-format phone numbers are
   rejected before they reach `signal-cli`.
5. The Signal consumer has no Signal-specific recipient allowlist or
   self-only restriction. `signal-agent` intentionally ignores the iMessage
   `allowed_recipients` setting.

### Signal message keeps retrying

The agent abandons a Signal job when `signal-cli` returns a non-zero exit code,
so Service Bus retries it. Read the exact signal-cli stderr captured in
`logs/signal-agent.log`, correct the local account/destination problem, and
allow the next delivery attempt. Because a send can succeed before the
subsequent Service Bus completion fails, delivery is at-least-once; do not
assume retries are globally exactly-once.

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

### Signal LaunchAgent commands

The Signal consumer has a distinct label, installer, and log files. These
commands do not alter the iMessage agent:

```bash
./mac/launchd/install-signal.sh
launchctl print gui/$(id -u)/com.imessage-bridge.signal-agent | head -20
launchctl kickstart -k gui/$(id -u)/com.imessage-bridge.signal-agent
tail -F logs/signal-agent.log
tail -n 50 logs/signal-agent.launchd.log
./mac/launchd/uninstall-signal.sh
```

Use the `launchctl print` state plus
`connected to service bus, listening...` in `logs/signal-agent.log` as the
basic health check. See [Signal consumer](#signal-consumer) for account,
queue, and delivery failures.

### The #1 launchd gotcha: Automation permission

macOS only shows the **Automation** prompt during an interactive foreground run.
launchd cannot display it. If you skipped the foreground run, the daemon may be
running but every send fails with *"Not authorized to send Apple events to
Messages."*

```bash
npx imessage-bridge@alpha agent
# click Allow on the Automation prompt, then ctrl-C
./mac/launchd/install.sh
```

You can audit the permission in:

> System Settings → Privacy & Security → Automation → (Terminal / node / launchd) → ✅ Messages

### Automation permission is **per-binary**

This is the gotcha that bites everyone exactly once. macOS scopes the
Automation grant to the **specific binary** that called `osascript`. If you
swap the agent runtime — e.g. you upgraded Node via nvm and the binary path
changed — **the new binary needs its own grant**.

Symptom: the daemon says `connected to service bus, listening...` and then
goes silent. The first message it tries to deliver triggers a fresh macOS
Automation prompt and the daemon hangs in `osascript` until you click Allow.
On a launchd-spawned process there's no prompt, so it just hangs forever
(then eventually times out and abandons the message).

Fix when you swap binaries:
```bash
# stop the daemon
./mac/launchd/uninstall.sh
# run once interactively so macOS prompts the new binary
npx imessage-bridge@alpha agent
# click Allow on the new Automation prompt, then ctrl-C
# reinstall — daemon now uses the freshly-permitted binary
./mac/launchd/install.sh
```

You'll see entries in **System Settings → Privacy & Security → Automation**
for each binary that has called `osascript`. Each one needs its own ✅ Messages
checkbox.

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
- **Daemon connects then goes silent** — see [Automation permission is per-binary](#automation-permission-is-per-binary) above. Most common cause is a fresh `node` binary (e.g. after nvm upgrade) that hasn't been granted Automation perm.

### `node: command not found` in launchd logs

The installer pins the absolute path to `node` (`command -v node` at install
time) into the plist, so this should not happen. If it does, you probably
moved or reinstalled Node (or switched nvm versions). Just re-run
`./mac/launchd/install.sh` to re-pin the current path.

## Node / npm

### `node: command not found` after install

You installed Node but your shell doesn't see it. Restart the shell (or `source ~/.zshrc`). If you used nvm, make sure the version is active: `nvm use 24`.

### `npm error notarget No matching version found for imessage-bridge@alpha`

npm cache lag — the alpha tag was just bumped. Force a fresh fetch:

```bash
npm cache clean --force
npx -y imessage-bridge@alpha --version
```

### Wrong Node version error

The package requires Node ≥22 (LTS). Check yours:

```bash
node --version
# if <22:
nvm install 24 && nvm use 24
```

## Logs

| What                 | Where                                              |
|----------------------|----------------------------------------------------|
| Agent app log        | `./logs/agent.log` (path from `config.json`)       |
| launchd stdout+stderr | `./logs/agent.launchd.log` (early-startup errors) |
| Signal app log       | `./logs/signal-agent.log` (or `signal_log_path`) |
| Signal launchd stdout+stderr | `./logs/signal-agent.launchd.log` |
| `az` CLI debug       | `az --debug ...`                                   |

## Still stuck?

Open an issue on the upstream repo with:
- `node --version`, `npm --version`, `az --version`, `sw_vers` (macOS version)
- Last 30 lines of agent log
- Sanitized `config.json` (with FQDN/queue names, **never** post tokens)
