---
name: "install-producer"
description: "Install the imessage-bridge producer on a Linux/cloud/openclaw host. The producer enqueues messages over AMQP 1.0 to Azure Service Bus."
domain: "imessage-bridge, deployment"
trigger_phrases:
  - "install producer"
  - "install on linux"
  - "install on openclaw"
  - "install on cromebox"
  - "set up producer"
  - "set up the sender"
confidence: "high"
license: MIT
---

# Install the producer (Linux / cloud / openclaw)

The producer is a tiny CLI that enqueues messages onto an AMQP 1.0 queue (Azure Service Bus by default). It does **not** receive messages and does **not** need inbound network access. The recommended install is the published npm package — no clone, no build step.

## When to use this skill

User says any of:
- "install the producer on my Linux box / Cromebox / cloud VM / openclaw machine"
- "I want to send iMessages from my Linux server"
- "set up the sender side"
- "wire openclaw / n8n / a Linux automation into iMessage"

## Prerequisites

| What | Why | Install |
|---|---|---|
| Linux (Debian/Ubuntu/Arch/RHEL etc.) or any POSIX host | Runtime | n/a |
| Node.js ≥ 22 LTS (recommend 24) | Runtime for the published CLI | `nvm install 24 && nvm use 24` (or `brew install node`, or https://nodejs.org/) |
| `az` CLI | OAuth login + RBAC | https://learn.microsoft.com/cli/azure/install-azure-cli |
| An Azure subscription with a Service Bus queue already provisioned | The broker | See [`infra/azure-quickstart.md`](../../infra/azure-quickstart.md) §1 — runs once per project, not per host |

## Steps (npm path — recommended)

```bash
# 1. Install the CLI globally (or skip and use `npx imessage-bridge@alpha …` ad-hoc)
npm i -g imessage-bridge@alpha
imessage-bridge --version    # should print 0.2.0-alpha.1 or newer

# 2. Drop a config.json wherever you'll run it from
cat > config.json <<'JSON'
{
  "namespace_fqdn": "<your-namespace>.servicebus.windows.net",
  "queue": "imsg-queue",
  "signature": "🐩"
}
JSON
# Or set IMSG_CONFIG=/absolute/path/config.json to keep it elsewhere.

# 3. Log in as the producer's Azure AD identity
az login --use-device-code     # outputs a code; visit https://microsoft.com/devicelogin

# 4. Grant this identity the Sender role on the queue (one-time)
ME=$(az ad signed-in-user show --query id -o tsv)
SCOPE=$(az servicebus queue show -g <RG> --namespace-name <NS> -n <QUEUE> --query id -o tsv)
az role assignment create --assignee "$ME" --role "Azure Service Bus Data Sender" --scope "$SCOPE"
# Role assignments take up to ~5 minutes to propagate.

# 5. Smoke test
imessage-bridge send --to "+15555550100" --body "smoke test from $(hostname)"
# expected: enqueued <uuid> -> +15555550100
```

## Alternate: install from source (contributors)

If you're hacking on the project itself, clone and run from the repo:

```bash
gh repo clone paulyuk/imessage-bridge && cd imessage-bridge
npm install
cp config.example.json config.json && $EDITOR config.json
az login --use-device-code
npm run dev -- send --to "+15555550100" --body "smoke test"
# or after a build:
npm run build && ./dist/cli.js send --to "+15555550100" --body "smoke test"
```

The cloned source and the published `imessage-bridge@alpha` package run the same code — same wire format, same config, same RBAC.

## Verify it worked

```bash
imessage-bridge doctor
# expected (Linux host):
#   ✅ node ≥22 (Active LTS)
#   ✅ config.json is valid JSON
#   ✅ namespace_fqdn = ...
#   ✅ az is logged in
#   ✅ have Azure Service Bus Data Sender on imsg-queue
#   ℹ️  Linux/cloud producer detected — no daemon to check.
#   ✅ healthy
```

> Note: `doctor` invokes `scripts/doctor.sh` which is intended to run from a cloned repo (it `npm test`s the local source). If you installed via `npm i -g`, the env/auth/RBAC checks still work; the test step will warn — that's expected for npm-only users.

## Optional: shell alias for daily use

```bash
alias imsg='imessage-bridge send'
imsg --to "+15555550100" --body "hi"
```

## Common failures

| Symptom | Likely cause | Fix |
|---|---|---|
| `DefaultAzureCredential failed to retrieve a token` | Not logged in | `az login --use-device-code` |
| `Unauthorized` / 401 on send | Missing/un-propagated Sender role | Re-check role assignment; wait 5min |
| `config.json: No such file` | Skipped step 2 | Create `config.json` in cwd, or set `IMSG_CONFIG=/path/to/config.json` |
| `command not found: imessage-bridge` | Not installed globally | Use `npx imessage-bridge@alpha …` or run `npm i -g imessage-bridge@alpha` |
| Wrong Node version error | Node <22 | `nvm install 24 && nvm use 24` |

Full operational issues: [`TROUBLESHOOTING.md`](../../TROUBLESHOOTING.md).

## Anti-patterns — do not

- ❌ Use Service Principal + client secret, SAS connection string, or PAT — identity-only ([`SECURITY.md`](../../SECURITY.md))
- ❌ Commit `config.json` — it's gitignored for a reason
- ❌ Pin yourself to Node 18 or 20 — use Active LTS (24) or Maintenance LTS (22 minimum)
