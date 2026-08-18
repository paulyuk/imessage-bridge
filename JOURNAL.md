# JOURNAL.md — Build Story

> How this project was built, the steering moments that shaped it, and why things are the way they are.
> Maintained by **Scribe** (Historian / Build Journalist). Update after milestones.

---

## 2026-08-17 — Wintergreen Storage Queue Listener Isolated

| Time | Steering Command | What Happened | Level-Up 🆙 |
|------|-----------------|---------------|-------------|
| 17:17 PDT | *"Keep Wintergreen separate and operationally bounded"* | Added the Wintergreen listener as an independent Azure Storage Queue consumer. It may share the `signal-queue` string with the Service Bus Signal consumer, but its Storage endpoint and `wintergreen_*` configuration form a distinct queue identity. It translates the Wintergreen boundary payload into Signal delivery, permits E.164 and group recipients without an allowlist, and manually promotes exhausted deliveries to a poison queue. | 🆙 Broker separation is explicit even where queue labels overlap, preventing configuration or daemon cross-wiring. |
| 17:17 PDT | *"Document the safe operating path"* | The current docs recommend queue-scoped, least-privilege RBAC and leave all Azure account, role, and resource actions to operators. A dedicated macOS LaunchAgent, logs, and installer isolate Wintergreen from the existing Signal daemon. | 🆙 The consumer can be deployed and recovered independently without automating sensitive cloud or account actions. |

---

## 2026-08-17 — Signal Consumer Hardened for Release

| Time | Steering Command | What Happened | Level-Up 🆙 |
|------|-----------------|---------------|-------------|
| 16:32 PDT | *"Implement/publish Signal"* | The existing Signal scaffold was hardened into a separately routed consumer: `signal-send` now targets only `signal_queue`, and both Signal commands reject a queue shared with iMessage. Signal validates E.164 destinations but intentionally does not inherit iMessage's allowlist or self-only restriction. | 🆙 Queue identity is now the channel boundary, preventing a producer or consumer from crossing between iMessage and Signal. |
| 16:32 PDT | *"Prepare the Mac release path"* | The Signal LaunchAgent was pinned to the installed `signal-cli` path. Signal account setup/linking and Azure queue/RBAC provisioning remain explicit manual operations, preserving local account control and identity-only Azure access. | 🆙 The deployment path is operationally complete without automating sensitive account or cloud-resource choices. |
| 16:32 PDT | *"Publish"* | Release validation could not publish or push: the public GitHub identity was unavailable in this environment, while only a different cached Microsoft-associated identity was present. No push occurred. | 🆙 Authentication state is treated as a release gate rather than silently publishing under the wrong identity. |

---

## 2026-08-17 — Deploy Runbook + Signal Sibling Consumer

### What Happened

A deploy-today inspection turned into real scaffolding: `DEPLOY-MAC-MINI.md` is
a new, portable, PII-free checklist covering Azure Service Bus/RBAC
provisioning, Mac local setup, the Messages.app Automation gotcha, launchd
install, and a smoke test — so a fresh `git pull` on the receiving Mac is all
that's needed to get moving. Along the way, `scripts/doctor.sh` was found
still checking for the deleted Python-era stack (`uv`, `python3`,
`producer/cli.py`) — a real bug left over from the TypeScript migration — and
was fixed. A Signal (`signal-cli`) sibling consumer was also scaffolded:
`src/signal.ts` (mirroring `messages.ts`'s `osascriptSend`), a new
`signal-agent` CLI subcommand, `signal_queue`/`signal_account` config fields,
and a second launchd plist + install/uninstall pair.

### Why

The bridge's `runAgent()` was already broker/channel-agnostic — it just needs
a `Sender` function and a queue name. Adding Signal support didn't need any
changes to the reconnect/backoff/dead-letter/health-alert core; it only
needed a new sender and a second, separately-scoped queue.

### Steering Moment

The user asked for research only at first ("do not deploy or make changes
yet"), then — after seeing the findings — asked for something portable they
could actually sync to the Mac mini, with one hard constraint: **no PII**
(hostnames, tenant/subscription IDs, personal paths) in anything committed
to `main`. That constraint caught a real issue during the commit itself: the
sandbox's auto-detected git identity embedded its hostname
(`...@<hostname>.local`); it was corrected to match the repo's existing
author convention before pushing.

### Impact

Both consumers now share one proven reliability pattern via one unmodified
core loop, differing only in sender + queue. Basic Service Bus tier was
confirmed sufficient for both (Entra ID/RBAC, queues, dead-letter,
peek-lock; 10,000 queues/namespace headroom). Actual Azure resource
provisioning is intentionally left as a manual step — namespace/queue names
and subscription choice are the user's call, not something to commit.

---

## 2026-05-08 — Mac Agent Becomes a LaunchAgent

### What Happened

The Mac consumer can now run permanently as a per-user macOS LaunchAgent. The docs now lead users through the happy path: run once in the foreground for Messages automation permission, install with `mac/launchd/install.sh`, verify with `launchctl`, and check logs when something feels off.

### Why

A bridge that only works while a terminal window is open is fragile. launchd gives users auto-start and auto-restart without exposing the Mac to the internet or adding secrets.

### Trade-offs

We chose a templated plist plus installer over hand-editing paths, `launchctl bootstrap` over deprecated `load`, plist environment variables over a wrapper script, `ThrottleInterval=60` to tame crash loops, and split logs so early startup failures are visible.

### Impact

Users get a calmer setup story and a daemon that survives login, restarts, and routine upgrades.

---

## 2026-05-08 — Project Bootstrapped

**Squad:** The Default Squad · **Vibe:** friendly · **Theme:** Community Builders

### The Team

Architect, Coder, Tester, DevRel, Prompter, GitOps, Evaluator, Researcher, Scribe

### What Happened

Project initialized with the **The Default Squad** squad preset via `npx snap-squad init`. The full `.squad/` directory, hook chain (AGENTS.md, CLAUDE.md, copilot-instructions.md), and this journal were generated automatically.

### Steering Moment

The builder chose **default** — default generalist squad — reliable, well-rounded, good for any project. This shapes everything that follows: who reviews code, how decisions get made, what gets tested first.

### What's Next

- [ ] First real feature or task
- [ ] Builder configures project context in `.squad/team.md`
- [ ] First decision logged to `.squad/decisions.md`

---

## How to Use This Journal

> *Scribe's guide for the builder and future contributors.*

This isn't a changelog. It's the **story of how the project was built** — the decisions, the pivots, the moments where the builder steered the squad in a new direction.

### What to capture

| Entry Type | When | Example |
|-----------|------|---------|
| **Steering Moment** | Builder redirects the squad | "Switched from REST to GraphQL after seeing the query complexity" |
| **Key Decision** | Trade-off was made | "Chose SQLite over Postgres — this is a CLI tool, not a service" |
| **Evolution** | Architecture shifted | "Split monolith into 3 modules after hitting circular deps" |
| **Milestone** | Something shipped | "v0.1.0 published to npm — first public release" |
| **Lesson Learned** | Something surprised you | "Vitest runs 10x faster than Jest for this project — switching permanently" |

### Template for new entries

```markdown
## YYYY-MM-DD — Title

### What Happened

(What was built, changed, or decided)

### Why

(The reasoning — what alternatives existed, what trade-offs were made)

### Steering Moment

(How the builder directed the work — what prompt, feedback, or redirection shaped the outcome)

### Impact

(What this changes going forward)
```

### Rules

1. **Write for future-you.** Six months from now, this journal explains *why* the code looks the way it does.
2. **Capture the steering, not the typing.** The git log shows what changed. The journal shows *why it changed*.
3. **Be honest about pivots.** The best journals include "we tried X, it didn't work, here's why we switched to Y."
4. **Update after milestones, not after every commit.** Quality over quantity.

---

*The code shows what was built. The journal shows why.*
