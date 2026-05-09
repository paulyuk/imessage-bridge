/**
 * Mac agent (Dapr variant) — subscribe to a Dapr pubsub topic and dispatch
 * each message to Messages.app via the existing osascript helper.
 *
 * Same delivery semantics as the main agent:
 *   - DROP (deadletter) on bad payload / missing fields
 *   - RETRY on osascript failure (Dapr will redeliver)
 *   - SUCCESS on osascript exit-0
 *
 * Reuses `osascriptSend` from the main package so we don't fork the
 * Messages.app integration. Logs land in the same logs/agent.log format
 * via the shared `createLogger`.
 */

import { DaprServer, CommunicationProtocolEnum } from "@dapr/dapr";

import { createLogger } from "../../../src/log.mjs";
import { osascriptSend } from "../../../src/messages.mjs";

const DEFAULT_PUBSUB_NAME = "imsg-pubsub";
const DEFAULT_TOPIC = "imsg-jobs";
const DEFAULT_APP_HOST = "127.0.0.1";
const DEFAULT_APP_PORT = "3000";
const DEFAULT_DAPR_HOST = "127.0.0.1";
const DEFAULT_DAPR_PORT = "3500";

/**
 * Dapr SDK uses string sentinels for return semantics in modern versions.
 * Define here so tests don't need to import Dapr internals.
 */
export const PUBSUB_RESULT = Object.freeze({
  SUCCESS: "SUCCESS",
  RETRY: "RETRY",
  DROP: "DROP",
});

/**
 * Pure handler — exported for unit tests.
 * Returns one of PUBSUB_RESULT.* based on payload validity + sender outcome.
 *
 * @param {unknown} raw                         the deserialized message body
 * @param {{
 *   sender: (to: string, body: string) => Promise<boolean>,
 *   logger: import("../../../src/log.mjs").Logger,
 * }} ctx
 * @returns {Promise<"SUCCESS"|"RETRY"|"DROP">}
 */
export async function handleMessage(raw, { sender, logger }) {
  // Dapr typically delivers parsed JSON in `data`; tolerate string fallback.
  let payload = raw;
  if (typeof raw === "string") {
    try {
      payload = JSON.parse(raw);
    } catch (e) {
      logger.error(`bad payload (not JSON), dropping: ${e.message ?? e}`);
      return PUBSUB_RESULT.DROP;
    }
  }
  if (!payload || typeof payload !== "object") {
    logger.error("bad payload (not object), dropping");
    return PUBSUB_RESULT.DROP;
  }
  const { id = "?", to, body } = /** @type {any} */ (payload);
  if (!to || !body) {
    logger.error(`missing to/body in ${id}, dropping`);
    return PUBSUB_RESULT.DROP;
  }

  logger.info(`sending ${id} -> ${to}`);
  const ok = await sender(to, body);
  if (ok) {
    logger.info(`sent ${id}`);
    return PUBSUB_RESULT.SUCCESS;
  }
  logger.warn(`osascript failed for ${id}, requesting retry`);
  return PUBSUB_RESULT.RETRY;
}

/**
 * Run the Dapr-subscribe agent. Blocks until SIGINT/SIGTERM.
 *
 * @param {{
 *   topic?: string,
 *   pubsubName?: string,
 *   appHost?: string,
 *   appPort?: string,
 *   daprHost?: string,
 *   daprPort?: string,
 *   logPath?: string,
 *   sender?: (to: string, body: string) => Promise<boolean>,
 *   logger?: import("../../../src/log.mjs").Logger,
 *   serverFactory?: (opts: any) => DaprServer,
 * }} opts
 * @returns {Promise<number>}
 */
export async function runAgent({
  topic = DEFAULT_TOPIC,
  pubsubName = DEFAULT_PUBSUB_NAME,
  appHost = process.env.APP_HOST ?? DEFAULT_APP_HOST,
  appPort = process.env.APP_PORT ?? DEFAULT_APP_PORT,
  daprHost = process.env.DAPR_HOST ?? DEFAULT_DAPR_HOST,
  daprPort = process.env.DAPR_HTTP_PORT ?? DEFAULT_DAPR_PORT,
  logPath = "./logs/agent.log",
  sender,
  logger,
  serverFactory,
} = {}) {
  const log = logger ?? createLogger(logPath);

  // IMSG_OSASCRIPT_MOCK=1 short-circuits Messages.app for e2e tests.
  // The main src/messages.mjs intentionally stays Mac-only; we wrap here
  // so the extension can be tested without modifying the main package.
  const send =
    sender ??
    (async (to, body) => {
      if (process.env.IMSG_OSASCRIPT_MOCK === "1") {
        log.info(`[mock-osascript] would send to ${to}: ${body}`);
        return true;
      }
      return osascriptSend({ to, body, logger: log });
    });

  const factory =
    serverFactory ??
    ((o) =>
      new DaprServer({
        serverHost: o.appHost,
        serverPort: o.appPort,
        communicationProtocol: CommunicationProtocolEnum.HTTP,
        clientOptions: { daprHost: o.daprHost, daprPort: o.daprPort },
      }));

  const server = factory({ appHost, appPort, daprHost, daprPort });

  log.info(
    `starting dapr agent — pubsub=${pubsubName} topic=${topic} app=${appHost}:${appPort} dapr=${daprHost}:${daprPort}`,
  );

  await server.pubsub.subscribe(pubsubName, topic, async (raw) =>
    handleMessage(raw, { sender: send, logger: log }),
  );

  await server.start();
  log.info("dapr agent listening");

  let stop = false;
  const shutdown = async (sig) => {
    if (stop) return;
    stop = true;
    log.info(`received ${sig}, shutting down`);
    try {
      await server.stop();
    } catch (e) {
      log.warn(`server.stop error: ${e.message ?? e}`);
    }
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Block forever until shutdown flips `stop`.
  await new Promise((resolve) => {
    const tick = setInterval(() => {
      if (stop) {
        clearInterval(tick);
        resolve();
      }
    }, 250);
  });

  log.info("dapr agent stopped");
  return 0;
}
