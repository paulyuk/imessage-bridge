import { test } from "node:test";
import assert from "node:assert/strict";

import {
  decodeWintergreenPayload,
  processWintergreenMessage,
  resolveWintergreenConfig,
  runWintergreenAgent,
  translateWintergreenPayload,
} from "./wintergreen.js";
import type { WintergreenQueueClient, WintergreenQueueMessage } from "./wintergreen.js";
import type { Logger } from "./log.js";

const noopLog: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function message(
  body = JSON.stringify({
    message: "winter hello",
    recipient: "+15555550100",
    app: "wintergreen",
    created_at: "2026-08-17T00:00:00.000Z",
  }),
  dequeueCount = 1,
): WintergreenQueueMessage {
  return { messageId: "storage-message-1", popReceipt: "receipt-1", messageText: body, dequeueCount };
}

function queue(calls: string[], poisonBodies?: string[], poisonFails = false): WintergreenQueueClient {
  return {
    receiveMessages: async () => ({ receivedMessageItems: [] }),
    sendMessage: async (body) => {
      calls.push("poison");
      poisonBodies?.push(body);
      if (poisonFails) throw new Error("poison unavailable");
    },
    deleteMessage: async () => {
      calls.push("delete");
    },
  };
}

test("Wintergreen translates schema to a deterministic bridge sender message", () => {
  const payload = {
    message: "winter hello",
    recipient: "+15555550100",
    app: "wintergreen",
    created_at: "2026-08-17T00:00:00.000Z",
  };
  const first = translateWintergreenPayload(payload);
  const second = translateWintergreenPayload(payload);
  assert.deepEqual(first, second);
  assert.match(first.id, /^wintergreen-[a-f0-9]{16}$/);
  assert.equal(first.to, "+15555550100");
  assert.equal(first.body, "winter hello");
  assert.equal(first.ts, payload.created_at);
});

test("Wintergreen decodes both plain JSON and base64 JSON", () => {
  const payload = JSON.stringify({
    message: "hello",
    recipient: "+15555550100",
    app: "wintergreen",
    created_at: "2026-08-17T00:00:00.000Z",
  });
  assert.deepEqual(decodeWintergreenPayload(payload), JSON.parse(payload));
  assert.deepEqual(decodeWintergreenPayload(Buffer.from(payload).toString("base64")), JSON.parse(payload));
});

test("Wintergreen rejects Service Bus endpoint confusion and invalid poison configuration", () => {
  assert.throws(
    () =>
      resolveWintergreenConfig({
        wintergreen_queue_endpoint: "test.servicebus.windows.net",
        wintergreen_queue: "signal-queue",
      }),
    /Storage Queue endpoint/,
  );
  assert.throws(
    () =>
      resolveWintergreenConfig({
        wintergreen_queue_endpoint: "https://stmff26vpp2mb7u.queue.core.windows.net",
      }),
    /configured together/,
  );
  assert.throws(
    () =>
      resolveWintergreenConfig({
        wintergreen_queue_endpoint: "https://stmff26vpp2mb7u.queue.core.windows.net",
        wintergreen_queue: "signal-queue",
        wintergreen_poison_queue: "signal-queue",
      }),
    /distinct/,
  );
});

test("Wintergreen does not delete before a sender succeeds", async () => {
  const calls: string[] = [];
  await processWintergreenMessage({
    message: message(),
    source: queue(calls),
    poison: queue(calls),
    sender: async () => false,
    maxDequeueCount: 5,
    logger: noopLog,
  });
  assert.deepEqual(calls, []);
});

test("Wintergreen promotes a delivery failure at max dequeue count before deleting", async () => {
  const calls: string[] = [];
  const poisonBodies: string[] = [];
  await processWintergreenMessage({
    message: message(undefined, 5),
    source: queue(calls),
    poison: queue(calls, poisonBodies),
    sender: async () => false,
    maxDequeueCount: 5,
    logger: noopLog,
  });
  assert.deepEqual(calls, ["poison", "delete"]);
  assert.deepEqual(JSON.parse(poisonBodies[0]!), {
    source_message_id: "storage-message-1",
    dequeue_count: 5,
    failure_category: "delivery-failed",
    failure_detail: "sender returned false",
    raw_body: message().messageText,
  });
});

test("Wintergreen leaves source intact when poison enqueue fails", async () => {
  const calls: string[] = [];
  await processWintergreenMessage({
    message: message("not JSON"),
    source: queue(calls),
    poison: queue(calls, undefined, true),
    sender: async () => true,
    maxDequeueCount: 5,
    logger: noopLog,
  });
  assert.deepEqual(calls, ["poison"]);
});

test("Wintergreen immediately poisons malformed payloads without sending", async () => {
  const calls: string[] = [];
  let sent = false;
  await processWintergreenMessage({
    message: message("not JSON", 1),
    source: queue(calls),
    poison: queue(calls),
    sender: async () => {
      sent = true;
      return true;
    },
    maxDequeueCount: 5,
    logger: noopLog,
  });
  assert.equal(sent, false);
  assert.deepEqual(calls, ["poison", "delete"]);
});

test("Wintergreen immediately poisons a payload for a different app", async () => {
  const calls: string[] = [];
  const poisonBodies: string[] = [];
  await processWintergreenMessage({
    message: message(
      JSON.stringify({
        message: "hello",
        recipient: "+15555550100",
        app: "signal",
        created_at: "2026-08-17T00:00:00.000Z",
      }),
    ),
    source: queue(calls),
    poison: queue(calls, poisonBodies),
    sender: async () => true,
    maxDequeueCount: 5,
    logger: noopLog,
  });
  assert.deepEqual(calls, ["poison", "delete"]);
  assert.equal(JSON.parse(poisonBodies[0]!).failure_category, "invalid-payload");
  assert.match(JSON.parse(poisonBodies[0]!).failure_detail, /app must be exactly/);
});

test("Wintergreen translates and processes a valid Signal group recipient", async () => {
  const groupId = Buffer.alloc(16, 9).toString("base64");
  const calls: string[] = [];
  let sentTo: string | undefined;
  await processWintergreenMessage({
    message: message(
      JSON.stringify({
        message: "group hello",
        recipient: `group:${groupId}`,
        app: "wintergreen",
        created_at: "2026-08-17T00:00:00.000Z",
      }),
    ),
    source: queue(calls),
    poison: queue(calls),
    sender: async (bridge) => {
      sentTo = bridge.to;
      assert.equal(bridge.body, "group hello");
      return true;
    },
    maxDequeueCount: 5,
    logger: noopLog,
  });
  assert.equal(sentTo, `group:${groupId}`);
  assert.deepEqual(calls, ["delete"]);
});

test("Wintergreen rejects a group recipient as its sending account", async () => {
  const groupId = Buffer.alloc(16, 3).toString("base64");
  await assert.rejects(
    runWintergreenAgent({
      config: {
        signal_account: `group:${groupId}`,
      },
    }),
    /signal_account must be an E\.164 number/,
  );
});
