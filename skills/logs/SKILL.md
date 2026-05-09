---
name: "logs"
description: "Find, tail, and search imessage-bridge logs. Two log files exist: structured app log (logs/agent.log) and launchd stdout/stderr (logs/agent.launchd.log)."
domain: "imessage-bridge, ops, diagnostics"
trigger_phrases:
  - "logs"
  - "show me the logs"
  - "tail the logs"
  - "what did the agent do"
  - "find that message"
  - "trace this uuid"
  - "why didn't my message send"
confidence: "high"
license: MIT
---

# Logs — find what happened

The bridge writes to **two** log files. Knowing which one to look at saves time.

| File | What | When to check |
|---|---|---|
| `logs/agent.log` | Structured Python `logging` output from the agent (every send attempt, every dead-letter, every reconnect). | "Did my message send?" "Why was it abandoned?" |
| `logs/agent.launchd.log` | Raw stdout/stderr of the launchd-spawned process — captures errors **before** Python logging initializes (config missing, import errors, Automation perm denials). | "The daemon won't start" "It crashes immediately" |

Both files are gitignored and live under `logs/` in the repo root.

## When to use this skill

User says any of:
- "tail the logs" / "show me the bridge logs"
- "did my message go through?" / "why didn't `<uuid>` send?"
- "the daemon isn't starting — show me the error"
- "what was the bridge doing at 3pm?"

## The commands

### Follow the app log (most common)

```bash
tail -F logs/agent.log
# Use ctrl-C to stop. -F (capital) reopens the file if it gets rotated.
```

Or with paging + follow:

```bash
less +F logs/agent.log
# ctrl-C exits follow mode; q quits less.
```

### Last 50 lines of the app log

```bash
tail -n 50 logs/agent.log
```

### Find what happened to a specific message

The producer prints `enqueued <uuid> -> +1…`. To trace that uuid through the agent:

```bash
UUID=3f1bcd2e-xxxx
grep "$UUID" logs/agent.log
# expected:
#   sending <uuid> -> +15555550100
#   sent <uuid>            ← success
# OR:
#   bad payload, dead-lettering: ...
#   abandoned <uuid> for retry
```

### Check the launchd log when the daemon won't start

```bash
tail -n 50 logs/agent.launchd.log
# Look for:
#   FileNotFoundError: config.json     → cp config.example.json config.json
#   ModuleNotFoundError                → uv sync
#   "Not authorized to send Apple events to Messages"
#                                      → run `uv run mac/agent.py` once in
#                                        Terminal, click Allow, then
#                                        re-run ./mac/launchd/install.sh
```

### Search for errors / warnings only

```bash
grep -E "ERROR|WARN" logs/agent.log | tail -n 30
```

### Count messages sent today

```bash
grep "$(date +%Y-%m-%d)" logs/agent.log | grep -c "^.*sent "
```

### Find the last successful send

```bash
grep "sent " logs/agent.log | tail -1
```

## Useful aliases (add to ~/.zshrc or ~/.bashrc)

```bash
alias bridgelog='tail -F ~/path/to/imessage-bridge/logs/agent.log'
alias bridgelaunchlog='tail -F ~/path/to/imessage-bridge/logs/agent.launchd.log'
alias bridgesent='grep "sent " ~/path/to/imessage-bridge/logs/agent.log | tail -10'
```

## Log rotation

The bridge does **not** rotate logs itself. For long-running deployments, set up a `newsyslog.conf` entry on Mac or a `logrotate` config on Linux:

```
# /etc/newsyslog.d/imessage-bridge.conf  (macOS)
/Users/<you>/path/to/imessage-bridge/logs/agent.log <you>:staff  644  7  10000  *  N
/Users/<you>/path/to/imessage-bridge/logs/agent.launchd.log <you>:staff  644  7  10000  *  N
```

This keeps 7 generations, rotates at 10MB.

## What the log lines mean

| Line | Meaning |
|---|---|
| `starting agent — fqdn=... queue=...` | Agent just (re)started; this is the first thing in a fresh log |
| `DefaultAzureCredential acquired a token from AzureCliCredential` | OAuth via cached `az login` worked |
| `sending <uuid> -> +1...` | About to call `osascript` for this message |
| `sent <uuid>` | `osascript` returned 0; message handed off to Messages.app |
| `osascript failed for +1...: <stderr>` | `osascript` returned non-zero; common: buddy doesn't exist, Automation perm not granted |
| `bad payload, dead-lettering: ...` | Message body wasn't valid JSON or was missing `to`/`body` |
| `abandoned <uuid> for retry` | Send failed transiently; Service Bus will redeliver |
| `Connection state changed: ...` | AMQP link state — usually noise; only investigate if it loops |
| `Link detached unexpectedly` | AMQP reconnect; the agent has built-in backoff and will recover |

## Anti-patterns — do not

- ❌ `cat logs/agent.log | grep ...` — pointless `cat`; just `grep ... logs/agent.log`
- ❌ Edit log files by hand
- ❌ Commit log files (they're gitignored — verify with `git status`)
- ❌ Share a raw log without sanitizing — it contains real recipient phone numbers and message bodies (PII)

## Related skills

- [`doctor`](../doctor/SKILL.md) — high-level health check
- [`send-message`](../send-message/SKILL.md) — emits the `<uuid>` you'll trace through the log
