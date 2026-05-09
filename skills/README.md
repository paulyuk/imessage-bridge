# skills/ — operational skills for imessage-bridge

These are agent-readable + human-readable runbooks for the most common things you'll do with this project. Drop them into any tool that consumes [`SKILL.md`](https://github.com/copilot-extensions) format — Copilot CLI, Cursor rules, Claude projects, internal LLMs, or an [openclaw](https://github.com/openclaw/openclaw) 🦞 runtime — and they'll route the right answer to the right question.

> **Inspiration:** This folder follows the [openclaw](https://github.com/openclaw/openclaw) skill convention (top-level `skills/`, one directory per skill, `SKILL.md` with frontmatter). If you're already running openclaw, you can symlink this directory straight in: `ln -s /path/to/imessage-bridge/skills ~/.openclaw/skills/imessage-bridge`.

> **Note:** This is the **operational** skills folder. Squad-internal / agent-meta skills (e.g. error-recovery, git-workflow, secret-handling) live under [`.copilot/skills/`](../.copilot/skills/).

## What's in here

| Skill | Triggered when the user says... | One-line summary |
|---|---|---|
| [`install-producer`](./install-producer/SKILL.md) | "install on linux" / "set up the sender" / "install on openclaw" | Get the producer CLI working on a Linux/cloud/openclaw host so it can enqueue messages over AMQP 1.0. |
| [`install-mac`](./install-mac/SKILL.md) | "install on mac" / "make this run permanently" / "install as daemon" | Install the consumer agent as a permanent macOS LaunchAgent that long-polls the queue and sends via Messages.app. |
| [`send-message`](./send-message/SKILL.md) | "send a text to..." / "imessage..." / "use the bridge to text..." | Run the producer once with a recipient and a body. Verify the round-trip. |
| [`doctor`](./doctor/SKILL.md) | "is the bridge healthy?" / "doctor" / "diagnose this" | Run `bin/doctor.sh` for a full environment + auth + RBAC + daemon health check with actionable fixes. |
| [`logs`](./logs/SKILL.md) | "show me the logs" / "did message X go through?" / "why won't the daemon start?" | Tail / grep / interpret the two log files (app + launchd stdout). |

## Format

Each skill is a directory with a single `SKILL.md`. The frontmatter declares:

```yaml
---
name: "<slug>"
description: "<one sentence>"
domain: "<comma-separated tags>"
trigger_phrases:
  - "phrases that should invoke this skill"
confidence: "high|medium|low"
license: MIT
---
```

The body follows a consistent shape:

1. **When to use this skill** — exact trigger phrases + proactive triggers
2. **Prerequisites** — what must already be true
3. **The command(s) / steps**
4. **Verify it worked** — what good looks like
5. **Common failures** — table mapping symptom → cause → fix
6. **Anti-patterns — do not** — what NOT to do

## Adding a new skill

```bash
mkdir -p skills/<slug>
$EDITOR skills/<slug>/SKILL.md   # follow the format above
# Add a row to the table in this README
```

Keep skills **small and composable**. A skill should fit on one screen for the human reading it. If it's growing, split it.
