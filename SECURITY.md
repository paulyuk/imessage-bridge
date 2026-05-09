# Security policy

## Reporting a vulnerability

Email the maintainer (or open a private security advisory on GitHub). Do not open public issues for vulnerabilities.

---

## Binding rule: identity-only auth

This project uses **Azure AD identity** for all Azure access. Always.

> ❌ **Never** use:
> - Service Principals (with client secret OR certificate)
> - SAS connection strings
> - Shared Access Keys
> - PATs (personal access tokens)
> - `AZURE_CLIENT_SECRET` or any other long-lived secret in env vars / files / config / GitHub Secrets
>
> ✅ **Only** use:
> - `az login` (Azure AD user identity, OAuth) — the default
> - Managed Identity (when the workload runs in Azure)
> - Workload Identity Federation (when an external workload federates to AAD without secrets)
> - Azure Arc-enabled servers + managed identity

If a future requirement seems to need an SP, **stop and ask**. The answer is almost always one of the three identity-backed paths above.

### Why

- **No rotation work.** Identity tokens refresh automatically; you don't manage anything.
- **Real audit trail.** Every send/receive ties to a real person or a managed identity in AAD sign-in logs — not a faceless SP.
- **Instant revocation.** `az logout` or one role-assignment delete kills access immediately.
- **No secret exfiltration risk.** There's nothing to leak.

---

## RBAC posture

- **Producer:** `Azure Service Bus Data Sender` on the queue. **Send only**, no receive.
- **Agent (Mac):** `Azure Service Bus Data Receiver` on the queue. **Receive only**, no send.
- **Two distinct Azure AD users**, one role each. True least privilege.
- Roles scoped to the **queue**, not the namespace, so adding more queues later doesn't broaden access.

Verify your current grants:
```bash
SCOPE=$(az servicebus queue show -g $RG --namespace-name $NS -n $QUEUE --query id -o tsv)
az role assignment list --scope $SCOPE -o table
```

---

## Secret handling

- `config.json` contains **no secrets** — only namespace FQDN, queue name, and ops settings. It's gitignored anyway, out of habit.
- `~/.azure/` (CLI token cache) is managed by Azure CLI. Don't `git add` it. Don't ship it. Don't put it in container images.
- The repo has **no `.env` files**, **no GitHub Secrets** for Azure auth, **no Key Vault references** (we don't need one).

## PII in commits

- Phone numbers, email addresses, and key-shaped patterns are **flagged** by CI on PRs (planned).
- Real recipient phone numbers are fine **at runtime** — that's the whole point of the bridge.
- Use **555-prefix fictional numbers** in docs, README, and tests (e.g. `+14255551234`, `+15555550100`).
- Use **`@example.com`** for emails in docs/tests.

## GitOps

- Authentication: `gh auth login` (OAuth web flow) only. **No PATs.**
- Branch: always `main`, never `master`.
- Direct push to `main` is allowed for solo dev; PRs once contributors join.

## Threat model summary

| Threat                                       | Mitigation                                               |
|----------------------------------------------|----------------------------------------------------------|
| Stolen credential leaks long-lived access    | No long-lived credentials exist                          |
| Producer compromised → reads recipient list  | Producer has Sender-only role; cannot enumerate queue    |
| Agent compromised → forges outbound spam     | Agent has Receiver-only role; cannot enqueue             |
| Mac exposed to internet                      | Not required — only outbound to Service Bus              |
| Repo leak                                    | Repo contains zero secrets, zero PII, zero AAD identifiers |
| Lost laptop                                  | Revoke role assignment + `az logout` from another device |

## Upgrade triggers

Stop using `az login` user identity and move to a managed identity / federated workload when:
- The workload moves into an Azure compute service (VM, Container App, AKS, Function) → Managed Identity
- The workload runs in GitHub Actions, GitLab CI, or another federation-capable system → Workload Identity Federation
- The host is brought into Azure Arc → Managed Identity via Arc

**Never** "just make a Service Principal real quick." It always becomes a long-lived secret.
