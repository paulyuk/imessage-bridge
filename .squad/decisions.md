# Decisions — The Default Squad

> Significant decisions made during development. Check before starting work.

## Active Decisions

### D-001: Squad initialized with The Default Squad preset
- **By:** snap-squad
- **Date:** 2026-05-08
- **Context:** Project initialized using snap-squad warm-start
- **Decision:** Using the "default" preset (friendly vibe, Community Builders theme)

### D-002: Use a templated LaunchAgent plist
- **By:** DevRel
- **Date:** 2026-05-08
- **Context:** The Mac daemon needs absolute paths for `uv`, the repo root, and the user's home directory. Asking users to hand-edit a plist is easy to get wrong.
- **Decision:** Keep `mac/launchd/com.imessage-bridge.agent.plist` as a template and have `mac/launchd/install.sh` render, lint, install, and restart it.

### D-003: Use modern per-user launchctl APIs
- **By:** DevRel
- **Date:** 2026-05-08
- **Context:** `launchctl load` and `launchctl unload` are deprecated and provide weaker feedback. The agent is a user daemon, not a system daemon.
- **Decision:** Use `launchctl bootstrap gui/$UID`, `bootout`, `enable`, and `kickstart -k` for install, reinstall, and restart flows.

### D-004: Avoid a wrapper script for launchd startup
- **By:** DevRel
- **Date:** 2026-05-08
- **Context:** A wrapper script was considered to set `PATH` and `HOME`, but it adds another file and another place for drift.
- **Decision:** Put `HOME` and `PATH` in the plist `EnvironmentVariables` so launchd can run `uv` directly.

### D-005: Throttle daemon crash loops
- **By:** DevRel
- **Date:** 2026-05-08
- **Context:** Missing config, expired Azure login, or Automation denial can make a permanent agent exit repeatedly.
- **Decision:** Set `ThrottleInterval=60` so launchd waits at least 60 seconds between relaunches and does not burn CPU.

### D-006: Split app logs from launchd stdout/stderr
- **By:** DevRel
- **Date:** 2026-05-08
- **Context:** Some failures happen before Python logging starts, especially config, import, and macOS Automation problems.
- **Decision:** Keep structured application logs in `logs/agent.log` and capture launchd stdout/stderr in `logs/agent.launchd.log`.

### D-007: Foreground run is required before daemon install
- **By:** DevRel
- **Date:** 2026-05-08
- **Context:** macOS cannot show the Messages Automation permission prompt from a launchd background process.
- **Decision:** Document the onboarding arc as foreground-test, install, verify, done; users must click Allow in the foreground run before relying on launchd.

### D-008: Signal sibling consumer reuses runAgent() unchanged, via a separate queue
- **By:** Copilot (deploy-inspection session)
- **Date:** 2026-08-17
- **Context:** Needed the cleanest way to add a Signal (`signal-cli`) consumer with the same Service Bus reliability pattern (peek-lock, exponential backoff, health-alert webhook) as the iMessage agent, without duplicating that logic.
- **Decision:** `agent.ts`'s `runAgent({ config, sender })` was already broker/channel-agnostic. Added `src/signal.ts` (`signalCliSend`, mirroring `messages.ts`'s `osascriptSend` shape) as a second `Sender`, wired via a new `signal-agent` CLI subcommand, driven by a **separate** `signal_queue` (not a shared/fan-out queue). Keeps RBAC queue-scoped (least privilege) and avoids channel-branching logic in the shared payload/dead-letter path. `runAgent()`'s core loop was not modified.

### D-009: Confirmed Basic Service Bus tier is sufficient for both consumers
- **By:** Copilot (deploy-inspection session)
- **Date:** 2026-08-17
- **Context:** Needed to verify whether Premium tier is required before deploying, and whether adding a second (Signal) queue changes that.
- **Decision:** Basic tier supports Microsoft Entra ID/RBAC, queues, dead-letter, and peek-lock — everything both consumers need — and allows up to 10,000 queues per namespace, trivial headroom for a second `signal-queue`. No topics/sessions/dedup required. Basic tier confirmed sufficient; no upgrade needed.

### D-010: Fixed stale `scripts/doctor.sh` Python-era references
- **By:** Copilot (deploy-inspection session)
- **Date:** 2026-08-17
- **Context:** `doctor.sh` was never updated after the TypeScript migration (commit `5befafc`) and still referenced deleted Python tooling (`uv`, `python3`, `producer/cli.py`, `mac/agent.py`), producing false-negative health checks.
- **Decision:** Replaced with Node/TypeScript equivalents (`node --version`, `node -e` for JSON/version checks, `npx imessage-bridge@alpha agent`/`send`) and added an optional Signal-consumer health section. Verified via manual runs with/without `signal_queue`/`signal_account` set.

### D-011: Isolate Signal routing at the CLI boundary
- **By:** Copilot (Signal hardening session)
- **Date:** 2026-08-17
- **Context:** The initial Signal scaffold used a dedicated consumer queue, but the producer route still needed to make channel selection explicit and reject configurations that could mix Signal and iMessage traffic.
- **Decision:** Add `signal-send` as the only Signal producer command; it enqueues solely to `signal_queue`. Both `signal-send` and `signal-agent` reject `signal_queue === queue`. Signal recipients must be E.164, but the Signal path intentionally does not inherit iMessage `allowed_recipients` or self-only policy.
