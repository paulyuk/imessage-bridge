/**
 * Mac agent — long-poll Service Bus and dispatch each message to Messages.app.
 *
 * Direct port of mac/agent.py. The Python version used a worker-thread queue
 * pattern because the SDK was sync-blocking; @azure/service-bus is fully
 * async/promise-based, so we just await each step inline. Same semantics:
 *   - peek-lock receive (durable until completed/abandoned)
 *   - dead-letter on bad payload or missing fields
 *   - complete on osascript success
 *   - abandon (re-deliverable) on osascript failure
 *   - exponential backoff with jitter on AMQP connection errors
 *   - optional health-alert webhook after N consecutive disconnects
 *
 * Auth: OAuth via DefaultAzureCredential (run `az login` once on the Mac).
 */

import { setTimeout as sleep } from "node:timers/promises";
import { DefaultAzureCredential } from "@azure/identity";
import { ServiceBusClient } from "@azure/service-bus";

import { createLogger } from "./log.mjs";
import { osascriptSend } from "./messages.mjs";

/**
 * @param {number} attempt  zero-based attempt counter
 * @param {{base?: number, capMs?: number}} [opts]
 * @returns {number} milliseconds to wait
 */
export function exponentialBackoff(attempt, { base = 1000, capMs = 60_000 } = {}) {
  const exp = Math.min(capMs, base * 2 ** attempt);
  const jitter = Math.random() * exp * 0.2;
  return Math.min(exp + jitter, capMs);
}

/**
 * Try to POST a small JSON alert to a webhook (config.health_endpoint).
 * Best-effort: never throws.
 *
 * @param {string|undefined} endpoint
 * @param {{reason: string, details?: string}} payload
 * @param {import("./log.mjs").Logger} [logger]
 */
export async function postHealthAlert(endpoint, payload, logger) {
  if (!endpoint) return;
  try {
    await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ service: "imessage-mac-agent", ...payload }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    logger?.warn(`failed to post health alert: ${e.message ?? e}`);
  }
}

/**
 * Process a single received message: parse → validate → osascript → settle.
 * Pure-ish — relies on injected receiver + sender so it's testable.
 *
 * @param {any} msg                       the ServiceBusReceivedMessage
 * @param {{
 *   receiver: any,
 *   sender: (to: string, body: string) => Promise<boolean>,
 *   logger: import("./log.mjs").Logger,
 * }} ctx
 */
export async function processOne(msg, { receiver, sender, logger }) {
  /** @type {{id?: string, to?: string, body?: string} | null} */
  let payload = null;
  try {
    const raw =
      typeof msg.body === "string"
        ? msg.body
        : Buffer.isBuffer(msg.body)
          ? msg.body.toString("utf8")
          : JSON.stringify(msg.body);
    payload = JSON.parse(raw);
  } catch (e) {
    logger.error(`bad payload, dead-lettering: ${e.message ?? e}`);
    try {
      await receiver.deadLetterMessage(msg, { deadLetterReason: "bad-payload" });
    } catch (settleErr) {
      logger.error(`failed to dead-letter: ${settleErr.message ?? settleErr}`);
    }
    return;
  }

  const { id = "?", to, body } = payload ?? {};
  if (!to || !body) {
    logger.error(`missing to/body in ${id}, dead-lettering`);
    try {
      await receiver.deadLetterMessage(msg, { deadLetterReason: "missing-fields" });
    } catch (settleErr) {
      logger.error(`failed to dead-letter: ${settleErr.message ?? settleErr}`);
    }
    return;
  }

  logger.info(`sending ${id} -> ${to}`);
  const ok = await sender(to, body);
  try {
    if (ok) {
      await receiver.completeMessage(msg);
      logger.info(`sent ${id}`);
    } else {
      await receiver.abandonMessage(msg);
      logger.warn(`abandoned ${id} for retry`);
    }
  } catch (settleErr) {
    logger.error(`failed to settle ${id}: ${settleErr.message ?? settleErr}`);
  }
}

/**
 * Run the agent. Blocks until SIGINT/SIGTERM or unrecoverable error.
 *
 * @param {{
 *   config: import("./config.mjs").BridgeConfig & {
 *     health_endpoint?: string,
 *     poll_interval_s?: number,
 *     disconnect_alert_threshold?: number,
 *     log_path?: string,
 *   },
 *   credential?: import("@azure/identity").TokenCredential,
 *   clientFactory?: (fqdn: string, cred: any) => ServiceBusClient,
 *   sender?: (to: string, body: string) => Promise<boolean>,
 *   logger?: import("./log.mjs").Logger,
 * }} opts
 * @returns {Promise<number>}  exit code
 */
export async function runAgent({ config, credential, clientFactory, sender, logger }) {
  const log = logger ?? createLogger(config.log_path ?? "./logs/agent.log");
  const fqdn = config.namespace_fqdn;
  const queue = config.queue;
  const pollMs = (config.poll_interval_s ?? 3) * 1000;
  const alertThreshold = config.disconnect_alert_threshold ?? 3;
  const send =
    sender ?? ((to, body) => osascriptSend({ to, body, logger: log }));

  log.info(`starting agent — fqdn=${fqdn} queue=${queue}`);

  let stop = false;
  const onSig = (sig) => {
    log.info(`received ${sig}, shutting down`);
    stop = true;
  };
  process.on("SIGINT", () => onSig("SIGINT"));
  process.on("SIGTERM", () => onSig("SIGTERM"));

  let disconnectCount = 0;
  let reconnectAttempt = 0;

  while (!stop) {
    /** @type {ServiceBusClient | null} */
    let client = null;
    try {
      const cred = credential ?? new DefaultAzureCredential();
      log.info(`creating ServiceBusClient (attempt=${reconnectAttempt})`);
      const make = clientFactory ?? ((f, c) => new ServiceBusClient(f, c));
      client = make(fqdn, cred);
      const receiver = client.createReceiver(queue, { receiveMode: "peekLock" });
      log.info("connected to service bus, listening...");
      reconnectAttempt = 0;

      try {
        while (!stop) {
          /** @type {any[]} */
          const msgs = await receiver.receiveMessages(5, { maxWaitTimeInMs: 10_000 });
          if (!msgs || msgs.length === 0) {
            await sleep(pollMs);
            continue;
          }
          // Process sequentially. osascript on Messages.app does NOT like
          // concurrent sends from the same script context; serial keeps
          // delivery order intact and avoids "buddy busy" failures.
          for (const m of msgs) {
            if (stop) break;
            await processOne(m, { receiver, sender: send, logger: log });
          }
        }
      } finally {
        try {
          await receiver.close();
        } catch (e) {
          log.warn(`receiver.close error: ${e.message ?? e}`);
        }
      }
    } catch (e) {
      disconnectCount += 1;
      log.error(`agent encountered error, will attempt reconnect: ${e.message ?? e}`);
      if (disconnectCount >= alertThreshold) {
        log.warn(
          `disconnect_count=${disconnectCount} exceeds threshold ${alertThreshold} — posting health alert`,
        );
        await postHealthAlert(
          config.health_endpoint,
          { reason: "repeated-disconnects", details: `count=${disconnectCount}` },
          log,
        );
      }
      const wait = exponentialBackoff(reconnectAttempt);
      log.info(`waiting ${(wait / 1000).toFixed(1)}s before reconnect (attempt=${reconnectAttempt})`);
      await sleep(wait);
      reconnectAttempt += 1;
    } finally {
      if (client) {
        try {
          await client.close();
        } catch (e) {
          log.warn(`client.close error: ${e.message ?? e}`);
        }
      }
    }
  }

  log.info("agent stopped");
  return 0;
}
