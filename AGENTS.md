# Agent Instructions — imessage-bridge

This document is binding for ALL agents (human, bot, AI) working in this repo.

## 🐍 Python: ALWAYS use `uv`

We do not use `python3` or `pip` directly. Ever. We use [uv](https://github.com/astral-sh/uv).

### Why
- Faster, lockfile-driven, reproducible.
- One tool for venvs, installs, runs, and locks.
- Because we're rad.

### Rules
1. **Never** call `python3 some_script.py` — call `uv run some_script.py`.
2. **Never** call `pip install x` — call `uv pip install x` (or add to pyproject/requirements and `uv sync`).
3. **Never** call `python3 -m venv` — call `uv venv`.
4. **CI, launchd, scripts, docs, examples** — all must reference `uv`.
5. If you find `python3` or `pip` invoked directly anywhere in this repo (code, docs, plists, workflows), open a fix immediately.

### Cheat sheet
| Task                    | Command                                     |
|-------------------------|---------------------------------------------|
| Create venv             | `uv venv`                                   |
| Install requirements    | `uv pip install -r mac/requirements.txt`    |
| Run a script            | `uv run mac/agent.py`                       |
| Run tests               | `uv run pytest`                             |
| Add a dep               | `uv add azure-servicebus`                   |
| Sync from lockfile      | `uv sync`                                   |

## 🔐 Auth: identity-only (binding rule)

This project uses **Azure AD identities only** for all Azure access.

**Never:**
- Service Principals (with secret OR cert)
- SAS connection strings, Shared Access Keys
- PATs
- `AZURE_CLIENT_SECRET` or any long-lived credential in env vars / files / GitHub Secrets

**Only:**
- `az login` (Azure AD user identity) — the default everywhere
- Managed Identity (workloads in Azure)
- Workload Identity Federation (external workloads)
- Azure Arc + managed identity

If an agent thinks it needs an SP, it must **stop and ask the user**. The answer is one of the four allowed options.

Full rationale: [`SECURITY.md`](./SECURITY.md).

## 🔐 Secrets & PII

- No secrets in the repo. No GitHub Secrets for Azure auth (we don't need any).
- Repo content (code, docs, configs): PII is flagged in CI and requires review before merge.
- Runtime payloads (real phone numbers, message bodies): allowed and expected — that's the whole point.
- Use **555-prefix fictional numbers** in docs/tests (`+14255551234`, `+15555550100`).

## 🐩 Squad

- This repo hooks into the Brady Gaster Squad (`.squad/`).
- DevRel agent owns README, CONTRIBUTING, INSTALL, TROUBLESHOOTING.
- All PRs trigger squad validation + Signal notification (via `SQUAD_SIGNAL_HOOK` secret).

## 🌳 Branches

- Default branch is `main`. Never use `master`.
- Feature branches: `feat/<short-name>`, fixes: `fix/<short-name>`.

## ✍️ Commit style

- Short imperative subject, optional body explaining why.
