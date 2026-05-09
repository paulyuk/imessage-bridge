/**
 * Producer (Dapr variant) — publish an iMessage job onto a Dapr pubsub topic.
 *
 * The pubsub broker is decided by Dapr component config (see
 * ../components/pubsub.yaml). Default ships with local Redis. Swap the YAML
 * to switch to Service Bus, Kafka, RabbitMQ, AWS SNS/SQS, GCP Pub/Sub, etc.
 *
 * Payload shape MUST match the main producer's: { id, to, body, ts }.
 * We import buildPayload directly from the main package so the two stay in lock-step.
 */

import { DaprClient, CommunicationProtocolEnum } from "@dapr/dapr";

import { buildPayload } from "../../../src/producer.mjs";

const DEFAULT_PUBSUB_NAME = "imsg-pubsub";
const DEFAULT_TOPIC = "imsg-jobs";
const DEFAULT_DAPR_HOST = "127.0.0.1";
const DEFAULT_DAPR_PORT = "3500";

/**
 * @typedef {Object} DaprSendOpts
 * @property {string}  to                  E.164 phone (e.g. "+15555550100")
 * @property {string}  body                message body
 * @property {string}  [signature]         optional suffix appended like main producer
 * @property {string}  [topic]             override topic name (default "imsg-jobs")
 * @property {string}  [pubsubName]        override component name (default "imsg-pubsub")
 * @property {string}  [daprHost]          sidecar host (default 127.0.0.1)
 * @property {string}  [daprPort]          sidecar HTTP port (default 3500)
 * @property {DaprClient} [client]         injectable for tests
 */

/**
 * Publish one message via the Dapr sidecar.
 *
 * @param {DaprSendOpts} opts
 * @returns {Promise<string>}  the message id (uuid)
 */
export async function sendMessage({
  to,
  body,
  signature,
  topic = DEFAULT_TOPIC,
  pubsubName = DEFAULT_PUBSUB_NAME,
  daprHost = process.env.DAPR_HOST ?? DEFAULT_DAPR_HOST,
  daprPort = process.env.DAPR_HTTP_PORT ?? DEFAULT_DAPR_PORT,
  client,
}) {
  if (!to) throw new Error("--to is required (E.164, e.g. +14255551234)");
  if (!body) throw new Error("--body is required");
  if (!/^\+\d{6,16}$/.test(to)) {
    throw new Error(`--to must be E.164 (e.g. +14255551234), got: ${to}`);
  }

  const payload = buildPayload({ to, body, signature });
  const dapr =
    client ??
    new DaprClient({
      daprHost,
      daprPort,
      communicationProtocol: CommunicationProtocolEnum.HTTP,
    });

  await dapr.pubsub.publish(pubsubName, topic, payload);

  // DaprClient.stop() is the documented graceful close; guard for older shapes.
  try {
    if (typeof dapr.stop === "function") await dapr.stop();
  } catch {
    /* ignore — best-effort */
  }

  return payload.id;
}

export const DAPR_DEFAULTS = Object.freeze({
  pubsubName: DEFAULT_PUBSUB_NAME,
  topic: DEFAULT_TOPIC,
  daprHost: DEFAULT_DAPR_HOST,
  daprPort: DEFAULT_DAPR_PORT,
});
