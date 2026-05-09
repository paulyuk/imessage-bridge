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

The producer is a tiny CLI that enqueues messages onto an AMQP 1.0 queue (Azure Service Bus by default). It does **not** receive messages and does **not** need inbound network access. The recommended install is the published npm package — no clone, no virtualenv.

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
| Node.js ≥ 18 | Runtime for the published CLI | https://nodejs.org/ (or `nvm install 20`, `apt install nodejs`, `brew install node`) |
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

If you're hacking on the project itself, clone and use the original Python entry-point:

```bash
gh repo clone paulyuk/imessage-bridge && cd imessage-bridge
uv sync
cp config.example.json config.json && $EDITOR config.json
az login --use-device-code
uv run producer/cli.py --to "+15555550100" --body "smoke test"
```

The Node CLI (`bin/imessage-bridge.mjs`) and the Python CLI (`producer/cli.py`) are interchangeable — same wire format, same config, same RBAC.

## Verify it worked

```bash
imessage-bridge doctor
# expected (Linux host):
#   ✅ Node 18+
#   ✅ config.json is valid JSON
#   ✅ namespace_fqdn = ...
#   ✅ az is logged in
#   ✅ have Azure Service Bus Data Sender on imsg-queue
#   ℹ️  Linux/cloud producer detected — no daemon to check.
#   ✅ healthy
```

> Note: `doctor` invokes `bin/doctor.sh` which expects the cloned repo (it shells out to `uv run pytest`). If you installed via `npm i -g`, the env/auth/RBAC checks still work; the pytest step will warn — that's expected for npm-only users.

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

Full operational issues: [`TROUBLESHOOTING.md`](../../TROUBLESHOOTING.md).

## Anti-patterns — do not

- ❌ Use Service Principal + client secret, SAS connection string, or PAT — identity-only ([`SECURITY.md`](../../SECURITY.md))
- ❌ Commit `config.json` — it's gitignored for a reason
- ❌ `pip install` / `python3 producer/cli.py` if you're hacking on Python — always use `uv` (see [`AGENTS.md`](../../AGENTS.md))
