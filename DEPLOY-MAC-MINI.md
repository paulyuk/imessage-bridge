# DEPLOY-MAC-MINI.md — deploy checklist for the receiving Mac

A consolidated, portable checklist for standing up the iMessage bridge
consumer (and, optionally, the Signal sibling consumer) on the Mac that will
run as the long-lived receiver. Pull this file with the rest of the repo —
`git clone` / `git pull` — no other setup docs needed to get started end to
end. It complements, and doesn't replace, [`INSTALL.md`](./INSTALL.md),
[`infra/azure-quickstart.md`](./infra/azure-quickstart.md), and
[`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md).

> 🔐 **No secrets, no PII in this file or in `config.json`.** Everything
> below uses placeholders (`<...>`) — substitute your own values locally,
> never commit them. See [`SECURITY.md`](./SECURITY.md) and `AGENTS.md`'s PII
> rules (555-prefixed fictional numbers only in anything committed).

## A. Azure — provision once

- [ ] Decide the **subscription/tenant** to provision into. If it's a
      work/corp tenant, confirm you (or an admin) can create role
      assignments at the resource scope — some tenants restrict
      `az role assignment create` to admins.
- [ ] Pick a resource group, region, and a **globally unique** namespace
      name:
  ```bash
  RG=<resource-group>              # e.g. imessage-bridge
  NS=<globally-unique-namespace>   # e.g. $RG-$(whoami)
  QUEUE=imsg-queue
  LOC=<region>                     # e.g. westus2

  az group create -n "$RG" -l "$LOC"
  az servicebus namespace create -g "$RG" -n "$NS" --sku Basic
  az servicebus queue create -g "$RG" --namespace-name "$NS" -n "$QUEUE"
  ```
  **Basic tier is sufficient** — Microsoft Entra ID/RBAC, queues,
  dead-letter, and peek-lock are all supported on Basic; up to 10,000
  queues per namespace (plenty of headroom for a second `signal-queue`
  later). No topics/sessions/dedup are needed by this bridge.
- [ ] Grant the two least-privilege roles, scoped to the **queue** (not the
      namespace):
  ```bash
  SCOPE=$(az servicebus queue show -g "$RG" --namespace-name "$NS" -n "$QUEUE" --query id -o tsv)

  # producer machine (sends only) — log in as that machine's identity first
  az role assignment create --assignee <producer-object-id> \
    --role "Azure Service Bus Data Sender" --scope "$SCOPE"

  # Mac agent (receives only) — log in as the Mac's identity first
  az role assignment create --assignee <mac-object-id> \
    --role "Azure Service Bus Data Receiver" --scope "$SCOPE"
  ```
  Role assignments can take **up to 5 minutes** to propagate.

## B. Mac — local environment

- [ ] Node.js **≥22** (Active LTS; 24 recommended) on `PATH`.
- [ ] Clone the repo (needed for the launchd installer + `npm test`):
  ```bash
  gh repo clone paulyuk/imessage-bridge && cd imessage-bridge
  npm install
  npm run build           # produces dist/cli.js
  ```
- [ ] Create `config.json` (gitignored — no secrets in it, just FQDN/queue):
  ```bash
  cp config.example.json config.json
  $EDITOR config.json     # set namespace_fqdn + queue from step A
  ```
- [ ] `az login` **on this Mac**, as the identity that was granted
      **Azure Service Bus Data Receiver** in step A.
- [ ] `Messages.app` installed, running, and signed into iMessage with the
      Apple ID you intend to send from.

## C. Messages.app Automation permission (do this before launchd)

- [ ] Run the agent in the **foreground first** — launchd cannot show the
      macOS Automation consent prompt:
  ```bash
  npx imessage-bridge@alpha agent      # or: node dist/cli.js agent
  ```
- [ ] Send one test message from the producer host, watch it arrive, then
      click **Allow** on the Automation prompt (usually attributed to
      Terminal / node), then `Ctrl-C`.
- [ ] Remember: the grant is **per-binary**. If the Node binary path
      changes later (e.g. `nvm install` a new version), redo this step —
      see `TROUBLESHOOTING.md`'s "Automation permission is per-binary".

## D. launchd — install the permanent daemon

```bash
./mac/launchd/install.sh
```

This is idempotent: detects `node`, builds `dist/cli.js` if missing,
requires `config.json` to already exist, renders
`mac/launchd/com.imessage-bridge.agent.plist`, validates with
`plutil -lint`, and registers via the modern `launchctl bootstrap gui/$UID`
API (not the deprecated `load`/`unload`).

- [ ] Verify: `launchctl print gui/$(id -u)/com.imessage-bridge.agent | head -20`
      → look for `state = running`
- [ ] Tail logs: `logs/agent.log` (structured app log) and
      `logs/agent.launchd.log` (launchd stdout/stderr — catches failures
      that happen before the app logger starts: missing config, import
      errors, Automation denials)

## E. Testing

```bash
npm test        # 16 Node native-test-runner cases, fully mocked/offline
```

No Azure or Mac permissions are required to run the test suite — it's a
useful sanity check right after cloning, before touching Azure at all.

## F. End-to-end smoke test

```bash
# from the producer host:
npx imessage-bridge@alpha send --to "+15555550100" --body "smoke test"
# expect: enqueued <uuid> -> +15555550100

# on the Mac (if not already running under launchd):
tail -F logs/agent.log
# expect within a few seconds: "sending <uuid> -> ..." then "sent <uuid>"
```

## G. Optional — Signal sibling consumer

The optional Signal consumer has the same Service Bus receive behavior
(peek-lock, complete/abandon/dead-letter, reconnect backoff, and health alert
webhook) as the iMessage agent, but calls local
[`signal-cli`](https://github.com/AsamK/signal-cli). It is an independent
consumer, not an iMessage fallback.

### G.1 Install and manually prepare the Signal account

- [ ] Install `signal-cli` on the Mac that will run the consumer:
  ```bash
  brew install signal-cli
  command -v signal-cli
  ```
  The Homebrew formula is a macOS option; upstream releases are available from
  the [`signal-cli` project](https://github.com/AsamK/signal-cli/releases/latest).
  Keep it current: upstream warns that an old release can become incompatible
  with Signal service changes.

- [ ] Choose one manual account path. The bridge does **not** run registration,
      verification, linking, or send account credentials anywhere. Use a local
      E.164 account value in place of `<signal-account-e164>`; do not replace
      the placeholder in this committed file.

  - **Link an existing Signal account** (recommended):
    ```bash
    signal-cli link
    ```
    `signal-cli` prints a device-link URI. In the existing Signal mobile app,
    open its Linked devices flow and scan that URI. Complete this while logged
    into the same macOS user that will run the LaunchAgent, because
    `signal-cli` keeps its local account data in that user's home directory.

  - **Register a new Signal account** (SMS verification):
    ```bash
    signal-cli -a "<signal-account-e164>" register
    signal-cli -a "<signal-account-e164>" verify "<verification-code>"
    ```
    Do not use `register` to link an existing account: signal-cli documents
    that registration can unregister an existing client associated with the
    number. A registration may require a CAPTCHA or a voice-code flow; follow
    the current upstream signal-cli guidance if prompted.

### G.2 Provision a dedicated queue and least-privilege roles

- [ ] Create the **separate** Signal queue. Do not share `imsg-queue`; routing
      is by queue, not by a channel field in the message.
  ```bash
  SIGNAL_QUEUE=signal-queue
  az servicebus queue create -g "$RG" --namespace-name "$NS" -n "$SIGNAL_QUEUE"

  SIGNAL_SCOPE=$(az servicebus queue show -g "$RG" --namespace-name "$NS" \
    -n "$SIGNAL_QUEUE" --query id -o tsv)
  ```
- [ ] Grant only the required queue-scoped role to each Signal identity:
  ```bash
  # Signal producer: enqueue to signal-queue only.
  az role assignment create --assignee <signal-producer-object-id> \
    --role "Azure Service Bus Data Sender" --scope "$SIGNAL_SCOPE"

  # Signal Mac: receive from signal-queue only.
  az role assignment create --assignee <signal-mac-object-id> \
    --role "Azure Service Bus Data Receiver" --scope "$SIGNAL_SCOPE"
  ```
  Do not grant either identity a namespace-level role, and do not reuse the
  iMessage producer or receiver role just because both consumers use Service
  Bus. Allow up to five minutes for role propagation.

### G.3 Configure the Mac and the Signal producer

- [ ] Add `signal_queue` and `signal_account` to the Mac's `config.json`:
  ```json
  {
    "namespace_fqdn": "<ns>.servicebus.windows.net",
    "queue": "imsg-queue",
    "signal_queue": "signal-queue",
    "signal_account": "<signal-account-e164>",
    "signal_log_path": "./logs/signal-agent.log"
  }
  ```

- [ ] Create a separate Signal producer config on the machine that enqueues
      Signal jobs:
  ```bash
  cat > signal-producer.config.json <<'JSON'
  {
    "namespace_fqdn": "<ns>.servicebus.windows.net",
    "queue": "imsg-queue",
    "signal_queue": "signal-queue"
  }
  JSON
  ```

  Use `signal-send` for this config: it reads `signal_queue` and enqueues only
  to `signal-queue`. `send` remains the iMessage-only producer route and
  continues to read `queue`.

  The Signal consumer has no Signal-specific recipient allowlist and is not
  self-only: it can send to any valid E.164 destination. The Signal consumer
  requires E.164 destinations (for example, `+15555550100`) and does not
  accept Signal usernames. `signal-agent` intentionally does not inherit the
  iMessage `allowed_recipients` setting.

### G.4 Foreground-test, then install launchd

- [ ] Run the Signal consumer in the foreground on the Mac. It requires the
      Signal account setup above and the Mac's **Signal Receiver** role:
  ```bash
  node dist/cli.js signal-agent --config config.json
  ```
- [ ] In a separate terminal on the Signal producer, enqueue a fictional smoke
      test using that producer's queue-specific config. This example requires a
      cloned, built checkout on the producer too:
  ```bash
  npm run build
  node dist/cli.js signal-send --config signal-producer.config.json \
    --to "+15555550100" --body "Signal bridge smoke test"
  ```
  Watch the foreground consumer for `sending` followed by `sent`, then stop it
  with ctrl-C. A successful delivery is completed in Service Bus only after
  `signal-cli` exits successfully. A failed send is abandoned and retried, so
  downstream delivery should be treated as at-least-once.

- [ ] Install the Signal consumer as its own LaunchAgent (same identity model
      as the iMessage agent; see
      `mac/launchd/com.imessage-bridge.signal-agent.plist`):
  ```bash
  ./mac/launchd/install-signal.sh
  launchctl print gui/$(id -u)/com.imessage-bridge.signal-agent | head -20
  ```
  Look for `state = running`. The installer is idempotent; re-run it after a
  Node or signal-cli path change.

### G.5 Health, logs, and removal

```bash
tail -F logs/signal-agent.log
tail -n 50 logs/signal-agent.launchd.log
./mac/launchd/uninstall-signal.sh
```

- `logs/signal-agent.log` is the structured application log. Healthy startup
  includes `connected to service bus, listening...`; signal-cli delivery
  failures are logged here.
- `logs/signal-agent.launchd.log` is launchd stdout/stderr and is the first
  place to look for missing config, a missing `signal-cli` binary, or startup
  failures before structured logging begins.
- `uninstall-signal.sh` stops and removes **only** the Signal LaunchAgent; it
  does not unlink the Signal account, delete its local data, or alter Service
  Bus resources.

Both consumers can run on the same Mac (or different machines) independently:
separate queues, roles, configs, LaunchAgents, and logs, sharing only the
generic receive/retry/settle implementation.

## H. Wintergreen Storage Queue Signal listener

> **Separate from Service Bus.** `wintergreen-agent` consumes Azure Storage
> Queue. `signal-agent` remains the existing Service Bus consumer and must not
> be repointed at the Wintergreen endpoint.

Wintergreen is a separate consumer of Azure Storage Queue endpoint
`https://stmff26vpp2mb7u.queue.core.windows.net` and queue `signal-queue`.
That queue string is also used by the Service Bus Signal consumer, but the two
systems are unrelated. Treat the broker endpoint plus queue name as the queue
identity.

### H.1 Required configuration and input translation

The listener must use a separate configuration namespace:

```json
{
  "wintergreen_queue_endpoint": "https://stmff26vpp2mb7u.queue.core.windows.net",
  "wintergreen_queue": "signal-queue",
  "wintergreen_poison_queue": "signal-queue-poison",
  "wintergreen_max_dequeue_count": "<operator-selected-positive-integer>"
}
```

- `wintergreen_poison_queue` is optional and defaults to
  `<wintergreen_queue>-poison`.
- `wintergreen_max_dequeue_count` defaults to `5` and must be a positive
  integer.
- `wintergreen_visibility_timeout_s` is optional and defaults to `60` seconds.
  It controls the explicit receive visibility timeout.
- This configuration does not use a connection string, account key, SAS,
  SQL credential, or service principal.
- The local sender also requires `signal_account` to name an E.164 Signal
  account. `signal_cli_path` is optional when `signal-cli` is already on PATH.

The input contract is:

```json
{
  "message": "text to deliver",
  "recipient": "+15555550100 or group:<base64>",
  "app": "source-system",
  "created_at": "2026-08-17T00:00:00Z"
}
```

Translate `message` to the Signal body and `recipient` to the Signal target.
Accept only E.164 recipients or `group:<base64>` group recipients. Preserve
`app` and `created_at` for validation and observability. Both must be non-empty,
and `created_at` must be a valid timestamp. The Wintergreen listener has no
allowlist and no self-only rule. It must not inherit the Service Bus iMessage
or Signal consumer settings.

### H.2 Identity, queue scope, and least privilege

Use `DefaultAzureCredential` only. The existing Mac mini dedicated service
principal is assigned the processor role below. Do not create a new service
principal, secret, SAS, key, SQL resource, or `Storage Account Contributor` for
this listener.

The required queue-scoped resource ID is:

```text
/subscriptions/ca5ce512-88e1-44b1-97c6-22caf84fb2b0/resourceGroups/rg-wintergreen/providers/Microsoft.Storage/storageAccounts/stmff26vpp2mb7u/queueServices/default/queues/signal-queue
```

At that scope, the desired assignments are:

| Identity | Desired role | Purpose |
|---|---|---|
| Existing Mac mini dedicated service principal | `Storage Queue Data Message Processor` | Receive, update visibility, and delete Wintergreen work |
| Wintergreen Function identity | `Storage Queue Data Message Sender` | Enqueue Wintergreen work only |

The user and Wintergreen Function identity currently have the broader
`Storage Queue Data Contributor` role at the `stmff26vpp2mb7u` account scope.
Tighten those account-scoped grants to the queue-scoped roles above after
confirming no other workload requires the broader access. Do not grant
`Storage Account Contributor`, keys, SAS, or SQL access.

This repository does not automate Storage account discovery, queue creation,
RBAC assignment, account changes, or role removal. Those are operator actions
outside this runbook.

### H.3 Delivery, foreground operation, and LaunchAgent

The listener must implement at-least-once delivery:

1. Receive a message with explicit visibility control.
2. Translate and send it to Signal.
3. Delete it only after a successful send.
4. On a transient receive or send error, preserve it for retry.
5. When its dequeue count reaches `wintergreen_max_dequeue_count`, copy it to
   `wintergreen_poison_queue`, then delete the source only after that copy
   succeeds.

Run the listener in the foreground first:

```bash
npm run build
node dist/cli.js wintergreen-agent --config config.json
```

It writes its structured application log to
`./logs/wintergreen-agent.log` by default, configurable with
`wintergreen_log_path`. Verify a fictional E.164 or group test payload before
installing the daemon.

Install the distinct LaunchAgent, then verify its state and logs:

```bash
./mac/launchd/install-wintergreen.sh
launchctl print gui/$(id -u)/com.imessage-bridge.wintergreen-agent | head -20
tail -F logs/wintergreen-agent.log
tail -n 50 logs/wintergreen-agent.launchd.log
```

The installer requires Node 22+, `signal-cli`, and `config.json` with
`signal_account`; it builds only when `dist/cli.js` is absent. To stop and
remove only this daemon, run:

```bash
./mac/launchd/uninstall-wintergreen.sh
```

The Wintergreen service has its own label, configuration source, app log, and
launchd stdout/stderr log. Do not reuse `com.imessage-bridge.signal-agent` or
its Service Bus installer and logs.
