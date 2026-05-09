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
