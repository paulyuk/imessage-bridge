---
name: "doctor"
description: "Run a comprehensive health check of the imessage-bridge install (producer or Mac agent). Detects environment, config, auth, RBAC, daemon state, and log freshness."
domain: "imessage-bridge, ops, diagnostics"
trigger_phrases:
  - "doctor"
  - "health check"
  - "is it working"
  - "what's wrong with the bridge"
  - "diagnose the bridge"
  - "is the daemon healthy"
confidence: "high"
license: MIT
---

# Doctor — health check the bridge install

Runs a full diagnostic of either side of the bridge (producer host or Mac agent host) and reports what's wrong with actionable fix suggestions.

## When to use this skill

User says any of:
- "is the bridge working?" / "is it healthy?"
- "doctor" / "health check" / "diagnose"
- "why isn't a message getting through?"
- "what state is the daemon in?"
- "I just deployed — sanity check it"

Also run this proactively:
- After `./mac/launchd/install.sh`
- After `git pull` + `npm install`
- After any `config.json` change
- After `az login` on a new identity
- Whenever a message takes longer than expected

## The command

If you cloned the repo:

```bash
./scripts/doctor.sh
```

If you installed via npm:

```bash
npx imessage-bridge@alpha doctor
# (this delegates to the same scripts/doctor.sh shipped in the package)
```

Either way it runs in <10 seconds and exits non-zero on failure so it composes with CI / cron.

> **npm-only note:** `scripts/doctor.sh` includes a `npm test` check that needs the cloned repo's source. If you're using the npm package without a clone, that section will warn — that's expected and safe to ignore. The env / config / auth / RBAC / launchd checks all still work.

## What it checks

| Section | Check |
|---|---|
| **Environment** | `node` ≥ 22 (Active LTS); `npm` available |
| **Config** | `config.json` exists, valid JSON, `namespace_fqdn` is not the placeholder, `queue` is set |
| **Azure auth** | `az` CLI installed; logged in; can mint a fresh AAD token; current identity has `Service Bus Data Sender` or `Receiver` role on the queue |
| **Tests** | `npm test` passes (mocked Service Bus + osascript) |
| **Mac only — launchd** | `com.imessage-bridge.agent` exists and `state = running`; `logs/agent.log` written within the last hour |
| **Linux only — producer** | Skips daemon checks; reminds about smoke-test command |

## Exit codes (for scripting)

| Code | Meaning |
|---|---|
| `0` | All checks passed — system is healthy |
| `1` | One or more **failures** — bridge will not work as-is |
| `2` | Only **warnings** — bridge will likely work but operator should review |

## Verbose mode

```bash
VERBOSE=1 ./scripts/doctor.sh
```

Prints the actual command output for each passing check (useful when you want to confirm exactly which subscription / role / namespace is being detected).

## Common output patterns

### Healthy Mac

```
── Environment ──   ✅ node ≥22 (Active LTS)   ✅ npm available
── Config ──        ✅ config.json is valid JSON
                    ✅ namespace_fqdn = my-bridge.servicebus.windows.net
── Azure auth ──    ✅ az is logged in
                    ✅ have Azure Service Bus Data Receiver on imsg-queue
── Tests ──         ✅ all node tests pass
── Mac agent ──     ✅ com.imessage-bridge.agent state = running
                    ✅ logs/agent.log written 3m ago (idle long-poll is normal)
── Summary ──       ✅ healthy
```

### Daemon not installed

```
── Mac agent (launchd) ──
  ⚠️  com.imessage-bridge.agent not installed
     fix: ./mac/launchd/install.sh
```

→ Run `./mac/launchd/install.sh`.

### Wrong identity / missing RBAC role

```
── Azure auth ──
  ⚠️  no Service Bus Data Sender/Receiver role on imsg-queue (current identity)
     fix: az role assignment create --assignee $ME --role "Azure Service Bus Data Sender" --scope <SCOPE>
```

→ Either you're logged in as the wrong user (`az account show`) or the role hasn't been assigned. Role propagation takes up to ~5 minutes.

### Stale log on Mac (potential silent agent)

```
── Mac agent (launchd) ──
  ✅ com.imessage-bridge.agent state = running
  ⚠️  logs/agent.log is stale (last write 142m ago)
     the agent may be silent; check logs/agent.launchd.log for errors
```

→ Process is alive but not logging — likely an AMQP reconnect storm or a stuck consumer. Inspect `logs/agent.launchd.log`, then restart with:
```bash
launchctl kickstart -k gui/$(id -u)/com.imessage-bridge.agent
```

## When doctor is not enough

If doctor returns ✅ healthy but messages still don't deliver:

1. Run [`logs`](../logs/SKILL.md) on the **producer** side — confirm `enqueued <uuid> -> +1...`
2. Run [`logs`](../logs/SKILL.md) on the **Mac** side — look for that same uuid
3. Check Messages.app on the Mac is actually signed into iMessage (some macOS updates silently sign you out)
4. Check the recipient's number is iMessage-registered (try sending from Messages.app manually first)

## Anti-patterns — do not

- ❌ Use `doctor.sh` as a substitute for reading [`TROUBLESHOOTING.md`](../../TROUBLESHOOTING.md) on novel failures
- ❌ Modify `scripts/doctor.sh` to skip a failing check just to make it green — fix the underlying issue
- ❌ Assume `✅ healthy` means the recipient definitely got a message — only the recipient's phone proves that
