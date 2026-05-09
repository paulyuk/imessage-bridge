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

The producer is a tiny Python CLI that enqueues messages onto an AMQP 1.0 queue (Azure Service Bus by default). It does **not** receive messages and does **not** need inbound network access.

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
| `uv` | Python tooling — never `pip` or `python3` directly | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| `az` CLI | OAuth login + RBAC | https://learn.microsoft.com/cli/azure/install-azure-cli |
| `gh` CLI (optional) | Cloning + future PRs | https://cli.github.com/ |
| An Azure subscription with a Service Bus queue already provisioned | The broker | See [`infra/azure-quickstart.md`](../../infra/azure-quickstart.md) §1 — runs once per project, not per host |

## Steps

```bash
# 1. Clone (use the upstream public repo, not the fork)
gh repo clone paulyuk/imessage-bridge && cd imessage-bridge
#    or:  git clone https://github.com/paulyuk/imessage-bridge.git && cd imessage-bridge

# 2. Sync deps via uv
uv sync

# 3. Configure
cp config.example.json config.json
# Edit config.json:
#   "namespace_fqdn": "<your-namespace>.servicebus.windows.net"
#   "queue":          "imsg-queue"
#   "signature":      "🐩"   (optional — set to "" to disable mascot suffix)

# 4. Log in as the producer's Azure AD identity
az login --use-device-code     # outputs a code; visit https://microsoft.com/devicelogin

# 5. Grant this identity the Sender role on the queue (one-time)
ME=$(az ad signed-in-user show --query id -o tsv)
SCOPE=$(az servicebus queue show -g <RG> --namespace-name <NS> -n <QUEUE> --query id -o tsv)
az role assignment create --assignee "$ME" --role "Azure Service Bus Data Sender" --scope "$SCOPE"
# Role assignments take up to ~5 minutes to propagate.

# 6. Smoke test
uv run producer/cli.py --to "+15555550100" --body "smoke test from $(hostname)"
# expected: enqueued <uuid> -> +15555550100
```

## Verify it worked

```bash
./bin/doctor.sh
# expected (Linux host):
#   ✅ uv installed
#   ✅ Python 3.10+
#   ✅ config.json is valid JSON
#   ✅ namespace_fqdn = ...
#   ✅ az is logged in
#   ✅ have Azure Service Bus Data Sender on imsg-queue
#   ✅ all pytest tests pass
#   ℹ️  Linux/cloud producer detected — no daemon to check.
#   ✅ healthy
```

## Optional: shell alias for daily use

```bash
echo 'alias imsg="cd ~/path/to/imessage-bridge && uv run producer/cli.py"' >> ~/.bashrc
# then anywhere:
imsg --to "+15555550100" --body "hi"
```

## Common failures

| Symptom | Likely cause | Fix |
|---|---|---|
| `DefaultAzureCredential failed to retrieve a token` | Not logged in | `az login --use-device-code` |
| `Unauthorized` / 401 on send | Missing/un-propagated Sender role | Re-check role assignment; wait 5min |
| `name 'producer' is not defined` after import | Old Python syntax — repo requires 3.10+ | `uv python install 3.12 && uv sync` |
| `config.json: No such file` | Skipped step 3 | `cp config.example.json config.json` |

Full operational issues: [`TROUBLESHOOTING.md`](../../TROUBLESHOOTING.md).

## Anti-patterns — do not

- ❌ `pip install` / `python3 producer/cli.py` — always use `uv` (see [`AGENTS.md`](../../AGENTS.md))
- ❌ Use Service Principal + client secret, SAS connection string, or PAT — identity-only ([`SECURITY.md`](../../SECURITY.md))
- ❌ Commit `config.json` — it's gitignored for a reason
