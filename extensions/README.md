# Extensions

Opt-in, optional sibling packages that swap out one piece of `imessage-bridge`
without changing the main package.

## How they work

- Each extension lives in its own directory with its own `package.json`,
  `node_modules`, and CLI binary.
- The main `npx imessage-bridge` CLI is **unchanged** by anything in this
  folder. Installing or running an extension does **not** add deps to the
  main package.
- To use one, clone the repo and follow the README in the extension's directory.
- A future `v0.3.x` may publish select extensions to npm as companion
  packages (e.g. `imessage-bridge-dapr`); for now they are source-only.

## Currently shipping

| Extension | What it swaps | Status |
|---|---|---|
| [`dapr/`](./dapr/) | Replaces direct Service Bus / AMQP with [Dapr pubsub](https://docs.dapr.io/reference/components-reference/supported-pubsub/), so the broker becomes pluggable: Redis, Service Bus, Kafka, RabbitMQ, AWS SNS/SQS, GCP Pub/Sub, … | alpha (source-only) |

## Roadmap

The following extensions have been requested but not started. **File an
issue at <https://github.com/paulyuk/imessage-bridge/issues> if you want
one prioritized.**

- `rabbitmq/` — direct AMQP 0.9.1 (no Dapr sidecar)
- `kafka/` — direct kafkajs producer/consumer
- `signal-cli/` — outbound to Signal instead of iMessage
- `nats/` — NATS JetStream

## Hard rules (apply to every extension)

- Identity-only auth (no SAS, no PATs, no client secrets) — see [`SECURITY.md`](../SECURITY.md).
- 555-prefix fictional numbers in all docs / tests.
- TypeScript on Node 22+ LTS, matching the main package — see [`AGENTS.md`](../AGENTS.md).
- The extension MUST NOT modify files in the main package's `src/`, `dist/`, or root `package.json`.
