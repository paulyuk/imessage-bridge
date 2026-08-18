/**
 * Wintergreen Signal listener — receives Signal work from Azure Storage Queues.
 * This intentionally does not share Service Bus clients or configuration.
 */

import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { DefaultAzureCredential } from "@azure/identity";
import type { TokenCredential } from "@azure/identity";
import { QueueClient } from "@azure/storage-queue";

import type { WintergreenConfig } from "./config.js";
import { createLogger } from "./log.js";
import type { Logger } from "./log.js";
import { isSignalE164, signalCliSend, validateSignalRecipient } from "./signal.js";

export const DEFAULT_WINTERGREEN_QUEUE_ENDPOINT =
  "https://stmff26vpp2mb7u.queue.core.windows.net";
export const DEFAULT_WINTERGREEN_QUEUE = "signal-queue";
export const DEFAULT_WINTERGREEN_MAX_DEQUEUE_COUNT = 5;
export const DEFAULT_WINTERGREEN_VISIBILITY_TIMEOUT_S = 60;

export type WintergreenQueueMessage = {
  messageId: string;
  popReceipt: string;
  messageText: string;
  dequeueCount: number;
};

export type WintergreenQueueClient = {
  receiveMessages: (options: {
    numberOfMessages: number;
    visibilityTimeout: number;
  }) => Promise<{ receivedMessageItems: WintergreenQueueMessage[] }>;
  deleteMessage: (messageId: string, popReceipt: string) => Promise<unknown>;
  sendMessage: (message: string) => Promise<unknown>;
  close?: () => Promise<void>;
};

export type WintergreenQueueClientFactory = (
  endpoint: string,
  queue: string,
  credential: TokenCredential,
) => WintergreenQueueClient;

export type WintergreenBridgeMessage = {
  id: string;
  to: string;
  body: string;
  ts: string;
};

type WintergreenPayload = {
  message: string;
  recipient: string;
  app: string;
  created_at: string;
};

export type WintergreenSender = (message: WintergreenBridgeMessage) => Promise<boolean>;

export type ResolvedWintergreenConfig = {
  endpoint: string;
  queue: string;
  poisonQueue: string;
  maxDequeueCount: number;
  visibilityTimeout: number;
};

function isStorageQueueEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      /^[a-z0-9-]+\.queue\.core\.windows\.net$/i.test(url.hostname)
    );
  } catch {
    return false;
  }
}

function isStorageQueueName(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(value);
}

function isWholeNumber(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

export function resolveWintergreenConfig(config: WintergreenConfig): ResolvedWintergreenConfig {
  const hasEndpoint = config.wintergreen_queue_endpoint !== undefined;
  const hasQueue = config.wintergreen_queue !== undefined;
  if (hasEndpoint !== hasQueue) {
    throw new Error(
      "config.wintergreen_queue_endpoint and config.wintergreen_queue must be configured together, or both omitted to use Wintergreen defaults",
    );
  }
  const endpoint = config.wintergreen_queue_endpoint ?? DEFAULT_WINTERGREEN_QUEUE_ENDPOINT;
  const queue = config.wintergreen_queue ?? DEFAULT_WINTERGREEN_QUEUE;
  const poisonQueue = config.wintergreen_poison_queue ?? `${queue}-poison`;
  const maxDequeueCount =
    config.wintergreen_max_dequeue_count ?? DEFAULT_WINTERGREEN_MAX_DEQUEUE_COUNT;
  const visibilityTimeout =
    config.wintergreen_visibility_timeout_s ?? DEFAULT_WINTERGREEN_VISIBILITY_TIMEOUT_S;

  if (!isStorageQueueEndpoint(endpoint)) {
    throw new Error(
      "config.wintergreen_queue_endpoint must be an https://<account>.queue.core.windows.net Storage Queue endpoint",
    );
  }
  if (!isStorageQueueName(queue)) {
    throw new Error("config.wintergreen_queue must be a valid Azure Storage Queue name");
  }
  if (!isStorageQueueName(poisonQueue) || poisonQueue === queue) {
    throw new Error(
      "config.wintergreen_poison_queue must be a distinct valid Azure Storage Queue name",
    );
  }
  if (!isWholeNumber(maxDequeueCount) || maxDequeueCount < 1) {
    throw new Error("config.wintergreen_max_dequeue_count must be a positive integer");
  }
  if (!isWholeNumber(visibilityTimeout) || visibilityTimeout < 1 || visibilityTimeout > 604_800) {
    throw new Error(
      "config.wintergreen_visibility_timeout_s must be an integer between 1 and 604800",
    );
  }
  return { endpoint, queue, poisonQueue, maxDequeueCount, visibilityTimeout };
}

function isStrictBase64(value: string): boolean {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return false;
  }
  const decoded = Buffer.from(value, "base64");
  return decoded.length > 0 && decoded.toString("base64") === value;
}

function parseObject(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("payload must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Azure Storage queues may contain plain JSON or base64-encoded JSON produced
 * by another client. Prefer plain JSON so JSON text that happens to be base64
 * is not decoded unexpectedly.
 */
export function decodeWintergreenPayload(raw: string): Record<string, unknown> {
  try {
    return parseObject(raw);
  } catch (plainError) {
    if (!isStrictBase64(raw)) {
      const message = plainError instanceof Error ? plainError.message : String(plainError);
      throw new Error(`payload is neither JSON nor base64 JSON: ${message}`);
    }
    try {
      return parseObject(Buffer.from(raw, "base64").toString("utf8"));
    } catch (encodedError) {
      const message = encodedError instanceof Error ? encodedError.message : String(encodedError);
      throw new Error(`base64 payload is not JSON: ${message}`);
    }
  }
}

function payloadField(payload: Record<string, unknown>, field: keyof WintergreenPayload): string {
  const value = payload[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`payload.${field} must be a non-empty string`);
  }
  return value;
}

export function translateWintergreenPayload(
  payload: Record<string, unknown>,
): WintergreenBridgeMessage {
  const message = payloadField(payload, "message");
  const recipient = payloadField(payload, "recipient");
  const app = payloadField(payload, "app");
  const createdAt = payloadField(payload, "created_at");
  if (app !== "wintergreen") {
    throw new Error("payload.app must be exactly \"wintergreen\"");
  }
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new Error("payload.created_at must be a valid timestamp");
  }
  const recipientError = validateSignalRecipient(recipient);
  if (recipientError) {
    throw new Error(recipientError);
  }
  const id = `wintergreen-${createHash("sha256")
    .update(JSON.stringify({ message, recipient, app, created_at: createdAt }))
    .digest("hex")
    .slice(0, 16)}`;
  return { id, to: recipient, body: message, ts: createdAt };
}

function poisonBody(
  message: WintergreenQueueMessage,
  failureCategory: "invalid-payload" | "delivery-failed",
  detail: string,
): string {
  return JSON.stringify({
    source_message_id: message.messageId,
    dequeue_count: message.dequeueCount,
    failure_category: failureCategory,
    failure_detail: detail,
    raw_body: message.messageText,
  });
}

async function moveToPoison(
  message: WintergreenQueueMessage,
  source: WintergreenQueueClient,
  poison: WintergreenQueueClient,
  failureCategory: "invalid-payload" | "delivery-failed",
  detail: string,
  logger: Logger,
): Promise<void> {
  try {
    await poison.sendMessage(poisonBody(message, failureCategory, detail));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.error(`failed to enqueue poison message ${message.messageId}: ${detail}`);
    return;
  }
  try {
    await source.deleteMessage(message.messageId, message.popReceipt);
    logger.warn(`moved ${message.messageId} to Wintergreen poison queue: ${failureCategory}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.error(`poisoned ${message.messageId}, but failed to delete source: ${detail}`);
  }
}

export type ProcessWintergreenMessageArgs = {
  message: WintergreenQueueMessage;
  source: WintergreenQueueClient;
  poison: WintergreenQueueClient;
  sender: WintergreenSender;
  maxDequeueCount: number;
  logger: Logger;
};

export async function processWintergreenMessage(
  args: ProcessWintergreenMessageArgs,
): Promise<void> {
  const { message, source, poison, sender, maxDequeueCount, logger } = args;
  let bridge: WintergreenBridgeMessage;
  try {
    bridge = translateWintergreenPayload(decodeWintergreenPayload(message.messageText));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.error(`invalid Wintergreen payload ${message.messageId}: ${detail}`);
    await moveToPoison(message, source, poison, "invalid-payload", detail, logger);
    return;
  }

  try {
    const sent = await sender(bridge);
    if (!sent) {
      throw new Error("sender returned false");
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.error(`Wintergreen sender failed for ${bridge.id}: ${detail}`);
    if (message.dequeueCount >= maxDequeueCount) {
      await moveToPoison(message, source, poison, "delivery-failed", detail, logger);
    } else {
      logger.warn(
        `leaving ${bridge.id} for retry (${message.dequeueCount}/${maxDequeueCount})`,
      );
    }
    return;
  }

  try {
    await source.deleteMessage(message.messageId, message.popReceipt);
    logger.info(`sent Wintergreen ${bridge.id} -> ${bridge.to}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.error(`sent ${bridge.id}, but failed to delete source message: ${detail}`);
  }
}

export type RunWintergreenAgentArgs = {
  config: WintergreenConfig;
  credential?: TokenCredential;
  queueClientFactory?: WintergreenQueueClientFactory;
  sender?: WintergreenSender;
  logger?: Logger;
};

export async function runWintergreenAgent(args: RunWintergreenAgentArgs): Promise<number> {
  const { config, credential, queueClientFactory, sender, logger } = args;
  if (!config.signal_account) {
    throw new Error("config.signal_account is required for wintergreen-agent");
  }
  if (!isSignalE164(config.signal_account)) {
    throw new Error("config.signal_account must be an E.164 number");
  }
  const resolved = resolveWintergreenConfig(config);
  const log = logger ?? createLogger(config.wintergreen_log_path ?? "./logs/wintergreen-agent.log");
  const credentialToUse = credential ?? new DefaultAzureCredential();
  const make: WintergreenQueueClientFactory =
    queueClientFactory ??
    ((endpoint, queue, cred) =>
      new QueueClient(`${endpoint}/${queue}`, cred) as unknown as WintergreenQueueClient);
  const source = make(resolved.endpoint, resolved.queue, credentialToUse);
  const poison = make(resolved.endpoint, resolved.poisonQueue, credentialToUse);
  const send: WintergreenSender =
    sender ??
    ((message) =>
      signalCliSend({
        account: config.signal_account!,
        to: message.to,
        body: message.body,
        command: config.signal_cli_path ?? process.env.IMSG_SIGNAL_CLI,
        logger: log,
      }));

  let stop = false;
  const stopOnSignal = (signal: string): void => {
    log.info(`received ${signal}, shutting down Wintergreen listener`);
    stop = true;
  };
  process.on("SIGINT", () => stopOnSignal("SIGINT"));
  process.on("SIGTERM", () => stopOnSignal("SIGTERM"));

  log.info(
    `starting Wintergreen listener — endpoint=${resolved.endpoint} queue=${resolved.queue} poison=${resolved.poisonQueue}`,
  );
  try {
    while (!stop) {
      try {
        const received = await source.receiveMessages({
          numberOfMessages: 1,
          visibilityTimeout: resolved.visibilityTimeout,
        });
        for (const message of received.receivedMessageItems) {
          if (stop) break;
          await processWintergreenMessage({
            message,
            source,
            poison,
            sender: send,
            maxDequeueCount: resolved.maxDequeueCount,
            logger: log,
          });
        }
        if (received.receivedMessageItems.length === 0) {
          await sleep((config.poll_interval_s ?? 3) * 1000);
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        log.error(`Wintergreen queue receive failed: ${detail}`);
        await sleep((config.poll_interval_s ?? 3) * 1000);
      }
    }
  } finally {
    await source.close?.();
    await poison.close?.();
  }
  log.info("Wintergreen listener stopped");
  return 0;
}
