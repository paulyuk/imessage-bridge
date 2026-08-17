/**
 * Mac agent — long-poll Service Bus and dispatch each message to Messages.app.
 * Peek-lock receive; complete on success; abandon on osascript failure;
 * dead-letter on bad payload. Exponential backoff on AMQP errors.
 */

import { setTimeout as sleep } from "node:timers/promises";
import { DefaultAzureCredential } from "@azure/identity";
import type { TokenCredential } from "@azure/identity";
import { ServiceBusClient } from "@azure/service-bus";
import type { ServiceBusReceivedMessage, ServiceBusReceiver } from "@azure/service-bus";

import type { BridgeConfig } from "./config.js";
import { createLogger } from "./log.js";
import type { Logger } from "./log.js";
import { decorateMessage, osascriptSend } from "./messages.js";

export type BackoffOptions = { base?: number; capMs?: number };

export function exponentialBackoff(attempt: number, opts: BackoffOptions = {}): number {
  const base = opts.base ?? 1000;
  const capMs = opts.capMs ?? 60_000;
  const exp = Math.min(capMs, base * 2 ** attempt);
  const jitter = Math.random() * exp * 0.2;
  return Math.min(exp + jitter, capMs);
}

export type HealthAlertPayload = { reason: string; details?: string };

export async function postHealthAlert(
  endpoint: string | undefined,
  payload: HealthAlertPayload,
  logger?: Logger,
): Promise<void> {
  if (!endpoint) return;
  try {
    await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ service: "imessage-mac-agent", ...payload }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger?.warn(`failed to post health alert: ${msg}`);
  }
}

export type Sender = (to: string, body: string) => Promise<boolean>;

export type ProcessOneCtx = {
  receiver: Pick<
    ServiceBusReceiver,
    "completeMessage" | "abandonMessage" | "deadLetterMessage"
  >;
  sender: Sender;
  logger: Logger;
  messagePrefix?: string;
  signature?: string;
  allowedRecipients?: string[];
};

export async function processOne(
  msg: ServiceBusReceivedMessage,
  ctx: ProcessOneCtx,
): Promise<void> {
  const { receiver, sender, logger, messagePrefix, signature, allowedRecipients } = ctx;

  let payload: { id?: string; to?: string; body?: string } | null = null;
  try {
    let raw: string;
    if (typeof msg.body === "string") {
      raw = msg.body;
    } else if (Buffer.isBuffer(msg.body)) {
      raw = msg.body.toString("utf8");
    } else {
      raw = JSON.stringify(msg.body);
    }
    payload = JSON.parse(raw) as { id?: string; to?: string; body?: string };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    logger.error(`bad payload, dead-lettering: ${errMsg}`);
    try {
      await receiver.deadLetterMessage(msg, {
        deadLetterReason: "bad-payload",
        deadLetterErrorDescription: errMsg,
      });
    } catch (settleErr) {
      const sm = settleErr instanceof Error ? settleErr.message : String(settleErr);
      logger.error(`failed to dead-letter: ${sm}`);
    }
    return;
  }

  const id = payload?.id ?? "?";
  const to = payload?.to;
  const body = payload?.body;
  if (!to || !body) {
    logger.error(`missing to/body in ${id}, dead-lettering`);
    try {
      await receiver.deadLetterMessage(msg, {
        deadLetterReason: "missing-fields",
        deadLetterErrorDescription: `payload missing 'to' or 'body' (id=${id})`,
      });
    } catch (settleErr) {
      const sm = settleErr instanceof Error ? settleErr.message : String(settleErr);
      logger.error(`failed to dead-letter: ${sm}`);
    }
    return;
  }
  if (allowedRecipients?.length && !allowedRecipients.includes(to)) {
    logger.error(`recipient ${to} is not allowed, dead-lettering ${id}`);
    try {
      await receiver.deadLetterMessage(msg, {
        deadLetterReason: "recipient-not-allowed",
        deadLetterErrorDescription: `recipient ${to} is not in allowed_recipients (id=${id})`,
      });
    } catch (settleErr) {
      const sm = settleErr instanceof Error ? settleErr.message : String(settleErr);
      logger.error(`failed to dead-letter: ${sm}`);
    }
    return;
  }

  logger.info(`sending ${id} -> ${to}`);
  const ok = await sender(to, decorateMessage(body, { prefix: messagePrefix, signature }));
  try {
    if (ok) {
      await receiver.completeMessage(msg);
      logger.info(`sent ${id}`);
    } else {
      await receiver.abandonMessage(msg);
      logger.warn(`abandoned ${id} for retry`);
    }
  } catch (settleErr) {
    const sm = settleErr instanceof Error ? settleErr.message : String(settleErr);
    logger.error(`failed to settle ${id}: ${sm}`);
  }
}

export type RunAgentArgs = {
  config: BridgeConfig;
  credential?: TokenCredential;
  clientFactory?: (fqdn: string, cred: TokenCredential) => ServiceBusClient;
  sender?: Sender;
  logger?: Logger;
};

export async function runAgent(args: RunAgentArgs): Promise<number> {
  const { config, credential, clientFactory, sender, logger } = args;
  const log = logger ?? createLogger(config.log_path ?? "./logs/agent.log");
  const fqdn = config.namespace_fqdn;
  const queue = config.queue;
  const pollMs = (config.poll_interval_s ?? 3) * 1000;
  const alertThreshold = config.disconnect_alert_threshold ?? 3;
  const send: Sender =
    sender ??
    ((to, body) =>
      osascriptSend({
        to,
        body,
        helperPath: config.automation_helper_path,
        logger: log,
      }));

  log.info(`starting agent — fqdn=${fqdn} queue=${queue}`);

  let stop = false;
  const onSig = (sig: string): void => {
    log.info(`received ${sig}, shutting down`);
    stop = true;
  };
  process.on("SIGINT", () => onSig("SIGINT"));
  process.on("SIGTERM", () => onSig("SIGTERM"));

  let disconnectCount = 0;
  let reconnectAttempt = 0;

  while (!stop) {
    let client: ServiceBusClient | null = null;
    try {
      const cred: TokenCredential = credential ?? new DefaultAzureCredential();
      log.info(`creating ServiceBusClient (attempt=${reconnectAttempt})`);
      const make = clientFactory ?? ((f: string, c: TokenCredential) => new ServiceBusClient(f, c));
      client = make(fqdn, cred);
      const receiver = client.createReceiver(queue, { receiveMode: "peekLock" });
      log.info("connected to service bus, listening...");
      reconnectAttempt = 0;

      try {
        while (!stop) {
          const msgs: ServiceBusReceivedMessage[] = await receiver.receiveMessages(5, {
            maxWaitTimeInMs: 10_000,
          });
          if (!msgs || msgs.length === 0) {
            await sleep(pollMs);
            continue;
          }
          for (const m of msgs) {
            if (stop) break;
            await processOne(m, {
              receiver,
              sender: send,
              logger: log,
              messagePrefix: config.message_prefix,
              signature: config.signature,
              allowedRecipients: config.allowed_recipients,
            });
          }
        }
      } finally {
        try {
          await receiver.close();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          log.warn(`receiver.close error: ${msg}`);
        }
      }
    } catch (e) {
      disconnectCount += 1;
      const errMsg = e instanceof Error ? e.message : String(e);
      log.error(`agent encountered error, will attempt reconnect: ${errMsg}`);
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
          const msg = e instanceof Error ? e.message : String(e);
          log.warn(`client.close error: ${msg}`);
        }
      }
    }
  }

  log.info("agent stopped");
  return 0;
}
