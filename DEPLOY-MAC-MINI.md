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

The repo also ships a Signal consumer built on the same reliability
pattern (peek-lock receive, complete/abandon/dead-letter, exponential
backoff, health-alert webhook) as the iMessage agent, driven by
[`signal-cli`](https://github.com/AsamK/signal-cli) instead of `osascript`.

- [ ] Install `signal-cli` (e.g. `brew install signal-cli` on macOS) and
      confirm it's linked/registered to the Signal account you'll send from:
  ```bash
  signal-cli -a <your-signal-account> receive   # sanity check it's registered
  ```
- [ ] Provision a **second, separate queue** (keeps RBAC queue-scoped and
      avoids channel-branching logic in the shared payload path):
  ```bash
  SIGNAL_QUEUE=signal-queue
  az servicebus queue create -g "$RG" --namespace-name "$NS" -n "$SIGNAL_QUEUE"
  ```
  Grant the same two roles (Sender on the producer, Receiver on the Mac)
  scoped to this queue.
- [ ] Add `signal_queue` and `signal_account` to `config.json`:
  ```json
  {
    "namespace_fqdn": "<ns>.servicebus.windows.net",
    "queue": "imsg-queue",
    "signal_queue": "signal-queue",
    "signal_account": "<your-signal-account>"
  }
  ```
- [ ] Foreground-test, then install as its own LaunchAgent (same
      per-machine identity model as the iMessage agent — see
      `mac/launchd/com.imessage-bridge.signal-agent.plist`):
  ```bash
  npx imessage-bridge@alpha signal-agent    # or: node dist/cli.js signal-agent (foreground test)
  ./mac/launchd/install-signal.sh           # persistent daemon
  ```

Both consumers can run on the same Mac (or different machines) independently
— they're separate queues, separate identities, separate launchd services,
sharing only the generic `runAgent()` reconnect/backoff/settle logic.
