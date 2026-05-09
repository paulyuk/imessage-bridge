---
name: "send-message"
description: "Send an iMessage to a recipient via the imessage-bridge producer. Enqueues a message onto AMQP; the Mac agent delivers it through Messages.app."
domain: "imessage-bridge, runtime"
trigger_phrases:
  - "send a text to"
  - "send an iMessage"
  - "text my"
  - "imessage"
  - "send a message via the bridge"
  - "use openclaw to text"
confidence: "high"
license: MIT
---

# Send a message (text / iMessage) via the bridge

The bridge takes a recipient phone number and a message body, enqueues a JSON job onto the AMQP queue, and the Mac agent picks it up and sends through `Messages.app`. End-to-end latency is typically a few seconds.

## When to use this skill

User says any of:
- "send a text to my mom saying happy birthday"
- "imessage Pauly: I'll be late"
- "use the bridge to text +15555550100"
- "send a message via openclaw"

If the user gives a name (not a number), check for a contacts file (commonly `~/.openclaw/state/contacts.json` or `~/.config/imessage-bridge/contacts.json`). If no contacts file exists, **ask the user for the phone number** in E.164 format. Never guess a number.

## Prerequisites

- Producer is installed and configured on this host (see [`install-producer` skill](../install-producer/SKILL.md)).
- The recipient's phone number in **E.164 format** (`+` country code + national number, no spaces or dashes). Examples: `+14255551234`, `+15555550100`, `+447911123456`.
- The Mac agent is running on the receiving Mac (see [`install-mac` skill](../install-mac/SKILL.md)). If the Mac is offline the message will sit on the queue and deliver when the Mac reconnects.

## The command

```bash
uv run producer/cli.py --to "+15555550100" --body "your message here"
```

That's it. One command, two flags. The producer:
1. Loads `config.json` for the namespace + queue.
2. Acquires an OAuth token via `DefaultAzureCredential` (your `az login` cache).
3. Optionally appends the configured `signature` (default `🐩`) to the body.
4. Enqueues a `ServiceBusMessage` with a unique `message_id`.
5. Prints `enqueued <uuid> -> +15555550100`.

## Multi-line bodies

```bash
uv run producer/cli.py --to "+15555550100" --body "line one
line two
line three"
```

Or pipe from a file via process substitution:

```bash
uv run producer/cli.py --to "+15555550100" --body "$(< /tmp/digest.txt)"
```

## Verify the message landed

Two places to look:

```bash
# Producer side (output of the command):
# enqueued 3f1b...-... -> +15555550100   ← message_id, this is the audit trail

# Mac agent side (on the receiving Mac):
tail -F logs/agent.log
# look for:  sending <uuid> -> +15555550100
#            sent <uuid>
```

Or just check the recipient's phone — that's the ground truth.

## Common failures

| Symptom | Where it shows up | Fix |
|---|---|---|
| `enqueued ... -> ...` but never delivered | Mac agent silent | Run [`logs` skill](../logs/SKILL.md) on the Mac; likely the agent isn't running or has lost AMQP connection |
| `osascript failed: buddy "+1..." doesn't exist` in Mac log | Number not registered with iMessage / not in user's contacts | Recipient must have iMessage enabled on this number, OR add as contact in Messages.app first |
| `Unauthorized` / 401 from producer | Missing Sender role | See [`install-producer`](../install-producer/SKILL.md) step 5 |
| Multi-line body mangled into one line | Shell ate newlines | Quote the body with `"..."` not `'...'`, or use a file |
| Sender wants to disable the 🐩 signature | Default config behavior | In `config.json`: `"signature": ""` |

## Anti-patterns — do not

- ❌ Send to a number you didn't verify (footgun for users)
- ❌ Use the bridge to send marketing/spam — recipients have no way to opt out at the bridge level
- ❌ Hardcode phone numbers in scripts; pass via env var or contacts lookup
- ❌ Send to non-E.164 numbers (e.g. `(425) 555-1234`) — they will silently fail to resolve in Messages.app
- ❌ Send anything you wouldn't put in writing to that person — the message is real and immediate

## Related skills

- [`install-producer`](../install-producer/SKILL.md) — set up the sender side
- [`install-mac`](../install-mac/SKILL.md) — set up the receiving Mac
- [`doctor`](../doctor/SKILL.md) — health check both sides
- [`logs`](../logs/SKILL.md) — find what happened to a specific message
