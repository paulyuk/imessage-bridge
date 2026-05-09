# Agent Instructions — imessage-bridge

This document is binding for ALL agents (human, bot, AI) working in this repo.

## 🟦 Language: TypeScript on Node LTS

The project is **TypeScript** running on **Node.js ≥22 (Active LTS)**. Source lives in `src/`, tests are colocated as `*.test.ts`, build output goes to `dist/` (gitignored, included in the npm tarball at publish time).

### Rules
1. **All new code is TypeScript** — no plain `.js` / `.mjs` outside the build output.
2. **Strict mode on** (`tsconfig.json` ships with `strict: true`). Don't relax it; fix the type instead.
3. **Run tests via tsx**, not via a compile-then-run dance: `npm test`.
4. **Build before publish.** `prepublishOnly` runs `tsc`. The npm `bin` field points at `./dist/cli.js`.
5. **Use ESM imports with `.js` extensions** (NodeNext convention) — `import { x } from "./foo.js"` even though the source file is `foo.ts`. TypeScript and Node both expect this.

### Cheat sheet
| Task                | Command                                     |
|---------------------|---------------------------------------------|
| Install deps        | `npm install`                               |
| Run tests           | `npm test`                                  |
| Build (TS → JS)     | `npm run build`                             |
| Run the CLI locally | `npm run dev -- send --to "+15555550100" --body "hi"` |
| Type-check only     | `npm run typecheck`                         |
| Add a dep           | `npm install <pkg>`                         |
| Add a dev dep       | `npm install --save-dev <pkg>`              |

## 🔐 Auth: identity-only (binding rule)

This project uses **Microsoft Entra (Azure AD) identities only** for all Azure access.

**Never:**
- Service Principals (with secret OR cert)
- SAS connection strings, Shared Access Keys
- PATs
- `AZURE_CLIENT_SECRET` or any long-lived credential in env vars / files / GitHub Secrets

**Only:**
- `az login` (Entra user identity) — the default everywhere
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
- Squad validation runs on every PR.

## 🌳 Branches

- Default branch is `main`. Never use `master`.
- Feature branches: `feat/<short-name>`, fixes: `fix/<short-name>`.

## ✍️ Commit style

- Short imperative subject, optional body explaining why.
