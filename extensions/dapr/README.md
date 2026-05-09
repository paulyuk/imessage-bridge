# `imessage-bridge-dapr` — Dapr pubsub variant

> Status: **alpha, source-only.** Clone this repo and run from `extensions/dapr/`.
> A companion npm package (`imessage-bridge-dapr`) is planned for v0.3.x.

## Why this exists

The main `imessage-bridge` talks directly to Azure Service Bus over AMQP 1.0.
That's great if you're on Azure, but locks you to one broker. This extension
keeps the same `osascript` agent on the Mac but swaps the pubsub layer for
[**Dapr**](https://dapr.io/) — so the broker becomes a config swap. Local
Redis for development, Service Bus / Kafka / RabbitMQ / AWS / GCP / … in
production, with **zero code changes** in this directory. Just point
[`components/pubsub.yaml`](./components/pubsub.yaml) at a different broker.

## Prerequisites

- Node ≥ 18
- [Docker](https://docs.docker.com/get-docker/) (for the local Redis container)
- [Dapr CLI](https://docs.dapr.io/getting-started/install-dapr-cli/) +
  Dapr runtime ([`dapr init`](https://docs.dapr.io/getting-started/install-dapr-selfhost/))
- macOS with Messages.app set up (only required to actually deliver iMessages —
  the publish + subscribe round-trip works on any OS if you set
  `IMSG_OSASCRIPT_MOCK=1`)

## Quickstart (local Redis)

This mirrors Dapr's own [pubsub quickstart](https://docs.dapr.io/getting-started/quickstarts/pubsub-quickstart/).

```bash
cd extensions/dapr
npm install
docker compose up -d redis            # starts redis:6379

# Terminal 1 — agent under the Dapr sidecar:
dapr run \
  --app-id imsg-bridge \
  --app-port 3000 \
  --dapr-http-port 3500 \
  --resources-path ./components \
  -- node src/cli.mjs agent

# Terminal 2 — publish a message:
node src/cli.mjs send --to "+15555550100" --body "hi from dapr 🐩"
```

The agent will pick up the message from the `imsg-jobs` topic and dispatch
it to Messages.app via the same `osascript` helper the main agent uses.
Logs land in `./logs/agent.log`, same format as the main agent.

To smoke-test the publish/subscribe loop **without** Messages.app:

```bash
IMSG_OSASCRIPT_MOCK=1 dapr run --resources-path ./components -- node src/cli.mjs agent
```

The agent logs `[mock-osascript] would send to ...` instead of calling AppleScript.

## Cloud configurations

To swap brokers, replace [`components/pubsub.yaml`](./components/pubsub.yaml)
with the appropriate one from the Dapr docs below. **The
`metadata.name: imsg-pubsub` MUST stay the same** so `producer.mjs` and
`agent.mjs` don't need code changes.

| Broker | Component `type` | Dapr docs |
|---|---|---|
| Azure Service Bus Queues | `pubsub.azure.servicebus.queues` | <https://docs.dapr.io/reference/components-reference/supported-pubsub/setup-azure-servicebus-queues/> |
| Azure Cache for Redis | `pubsub.redis` | <https://docs.dapr.io/reference/components-reference/supported-pubsub/setup-redis-pubsub/> |
| Apache Kafka (any cloud) | `pubsub.kafka` | <https://docs.dapr.io/reference/components-reference/supported-pubsub/setup-apache-kafka/> |
| AWS SNS/SQS | `pubsub.aws.snssqs` | <https://docs.dapr.io/reference/components-reference/supported-pubsub/setup-aws-snssqs/> |
| GCP Pub/Sub | `pubsub.gcp.pubsub` | <https://docs.dapr.io/reference/components-reference/supported-pubsub/setup-gcp-pubsub/> |
| RabbitMQ | `pubsub.rabbitmq` | <https://docs.dapr.io/reference/components-reference/supported-pubsub/setup-rabbitmq/> |

The full list of 15+ brokers is at
<https://docs.dapr.io/reference/components-reference/supported-pubsub/>.

## Identity-only auth (binding rule)

For cloud brokers, **never** put a connection string, SAS key, or service
principal secret in the component YAML. Use Dapr's
[secret store + managed identity](https://docs.dapr.io/operations/components/component-secrets/)
pattern instead:

- **Azure Service Bus / Redis** → workload uses **Azure Managed Identity**;
  Dapr resolves it via the Azure auth profile in the component metadata.
- **AWS SNS/SQS** → IAM role for service account (IRSA on EKS) or
  EC2/ECS instance role. No long-lived access keys.
- **GCP Pub/Sub** → Workload Identity. No service-account JSON files.

This matches the main project's [`SECURITY.md`](../../SECURITY.md) — identity-only,
zero long-lived secrets in the repo.

## Config knobs

`./dapr-config.json` (optional, gitignored) overrides defaults:

```json
{
  "pubsub_name": "imsg-pubsub",
  "topic": "imsg-jobs",
  "dapr_host": "127.0.0.1",
  "dapr_port": 3500,
  "app_host": "127.0.0.1",
  "app_port": 3000,
  "log_path": "./logs/agent.log"
}
```

Or via env: `DAPR_HOST`, `DAPR_HTTP_PORT`, `APP_HOST`, `APP_PORT`,
`IMSG_OSASCRIPT_MOCK`.

The optional `signature` suffix is read from the main `./config.json` (the
same file the main `imessage-bridge` uses) so message bodies are formatted
identically across the two transports.

## Test

```bash
npm test
```

Runs 12 unit tests against `handleMessage` and `sendMessage` (with a mocked
`DaprClient`) + 1 skipped e2e placeholder. No Docker or Dapr CLI required for
the unit suite.

### End-to-end test (manual, for now)

The e2e test is documented but not yet automated, because spinning up a Dapr
sidecar inside `node:test` is brittle. Manual procedure:

```bash
# 1. start Redis
docker compose up -d redis

# 2. start the agent in mock mode (Terminal 1)
IMSG_OSASCRIPT_MOCK=1 dapr run \
  --app-id imsg-bridge \
  --app-port 3000 \
  --dapr-http-port 3500 \
  --resources-path ./components \
  -- node src/cli.mjs agent

# 3. publish 3 messages (Terminal 2)
for i in 1 2 3; do
  node src/cli.mjs send --to "+15555550100" --body "test $i"
done

# 4. confirm 3 [mock-osascript] lines appear in logs/agent.log
grep -c '\[mock-osascript\] would send' logs/agent.log   # should print 3

# 5. cleanup
docker compose down
```

Filed as a follow-up: automate this in `test/pubsub.test.mjs` once we have
a stable way to bootstrap `dapr run` from inside the test process.

## What this DOESN'T do (yet)

- Does **not** replace the main `npx imessage-bridge` CLI. The main package
  still talks directly to Service Bus.
- Does **not** auto-install the Dapr CLI for you. See
  <https://docs.dapr.io/getting-started/install-dapr-cli/>.
- Does **not** ship a launchd daemon installer. The
  [`mac/launchd/`](../../mac/launchd/) installer in the main package wraps
  the **main** Node agent, not the Dapr one. Wrapping `dapr run …` in
  launchd is on the v0.3.x roadmap.
- Does **not** publish to npm. `package.json` has `"private": true` to
  prevent accidental release. v0.3.x will flip this and ship as the
  companion package `imessage-bridge-dapr`.
