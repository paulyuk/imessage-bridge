# Azure quickstart — identity-only auth (Service Bus Basic)

> **Binding rule:** This project uses Azure AD identities only. **Never** Service Principals, client secrets, certificates-as-secrets, SAS keys, or PATs. See [`SECURITY.md`](../SECURITY.md).

## 1. Create namespace + queue (Basic tier)

```bash
RG=imessage-bridge
NS=$RG-$(whoami)          # globally unique
QUEUE=imsg-queue
LOC=westus2

az group create -n $RG -l $LOC
az servicebus namespace create -g $RG -n $NS --sku Basic
az servicebus queue create  -g $RG --namespace-name $NS -n $QUEUE
```

**Why Basic?** Queues, AAD/RBAC, dead-letter, peek-lock — all supported. We don't use topics, sessions, or de-duplication. Cost: ~$0.05 per million ops, **no base fee**. At ~2 msgs/day, this is effectively free.

## 2. Grant RBAC — one role per machine, two identities

The producer machine and the agent machine each log in as **their own** Azure AD user (you, on each host). Each gets **only** the role that machine needs.

```bash
SCOPE=$(az servicebus queue show -g $RG --namespace-name $NS -n $QUEUE --query id -o tsv)
```

### On the producer machine (sends only)

```bash
az login --use-device-code            # log in as producer identity
ME=$(az ad signed-in-user show --query id -o tsv)
az role assignment create --assignee $ME --role "Azure Service Bus Data Sender" --scope $SCOPE
```

### On the Mac (receives only)

```bash
az login                              # log in as Mac identity (browser)
ME=$(az ad signed-in-user show --query id -o tsv)
az role assignment create --assignee $ME --role "Azure Service Bus Data Receiver" --scope $SCOPE
```

> Role assignments take **up to 5 minutes** to propagate.

## 3. Configure each host

```bash
cp config.example.json config.json
# edit:  "namespace_fqdn": "<NS>.servicebus.windows.net"
#        "queue":          "imsg-queue"
```

`config.json` is gitignored. There are no secrets in it — just the namespace FQDN and queue name.

## 4. Smoke test

On the producer host:
```bash
npx imessage-bridge@alpha send --to "+15555550100" --body "smoke test"
# expect: enqueued <uuid> -> +15555550100
```

On Mac:
```bash
npx imessage-bridge@alpha agent
# expect log line "sending <uuid>" then "sent <uuid>" within seconds
```

## 5. Optional: provision the Signal queue and RBAC

The Signal consumer must not share `imsg-queue`. Create a second queue and
scope a second Sender/Receiver pair to that **queue resource**, not to the
namespace. This keeps a Signal producer from enqueueing iMessage jobs and a
Signal Mac from receiving them.

```bash
SIGNAL_QUEUE=signal-queue
az servicebus queue create -g "$RG" --namespace-name "$NS" -n "$SIGNAL_QUEUE"

SIGNAL_SCOPE=$(az servicebus queue show -g "$RG" --namespace-name "$NS" \
  -n "$SIGNAL_QUEUE" --query id -o tsv)

# The Signal producer identity: can enqueue to signal-queue only.
az role assignment create --assignee <signal-producer-object-id> \
  --role "Azure Service Bus Data Sender" --scope "$SIGNAL_SCOPE"

# The Mac identity running signal-agent: can receive from signal-queue only.
az role assignment create --assignee <signal-mac-object-id> \
  --role "Azure Service Bus Data Receiver" --scope "$SIGNAL_SCOPE"
```

Use `signal-send --to <+E164> --body <text> [--config <path>]` with a producer
config containing `signal_queue: "signal-queue"` when enqueuing Signal jobs.
`signal-send` selects that dedicated queue; `send` remains iMessage-only and
uses `queue`. Role propagation can take up to five minutes.

The Signal account itself is local to the Mac and must be installed and linked
or registered manually with `signal-cli`; the bridge does not manage it. See
[INSTALL.md §6](../INSTALL.md#6-optional--run-the-signal-consumer) for the
account steps, foreground test, launchd lifecycle, logs, and recovery.

## Identity-only — what's *not* allowed

| Auth method                          | Allowed? | Why not                                  |
|--------------------------------------|----------|------------------------------------------|
| `az login` (user identity)           | ✅       | The default. OAuth, no secrets to manage |
| Managed Identity (in Azure)          | ✅       | No secrets, AAD-backed                   |
| Workload Identity Federation         | ✅       | Federated, no secrets                    |
| Azure Arc + managed identity         | ✅       | Brings non-Azure hosts under AAD         |
| Service Principal + client secret    | ❌       | Long-lived secret                        |
| Service Principal + client cert      | ❌       | Cert-as-secret on disk                   |
| SAS connection strings               | ❌       | Long-lived secret                        |
| `AZURE_CLIENT_SECRET` env var        | ❌       | Long-lived secret                        |

## Revocation

```bash
# Remove someone's access immediately
az role assignment delete --assignee <object-id> --scope $SCOPE

# Or revoke your own session
az logout
```

That's it. No keys to rotate, no certs to renew.
