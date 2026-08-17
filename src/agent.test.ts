/**
 * Agent unit tests — payload parsing, send dispatch, settle, dead-letter, backoff.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { exponentialBackoff, processOne } from "./agent.js";
import type { Sender } from "./agent.js";
import { buildOsascript } from "./messages.js";
import type { Logger } from "./log.js";
import type { ServiceBusReceivedMessage } from "@azure/service-bus";

const noopLog: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

type Call = { action: string; opts?: unknown };

function makeReceiver(): {
  calls: Call[];
  completeMessage: (m: ServiceBusReceivedMessage) => Promise<void>;
  abandonMessage: (m: ServiceBusReceivedMessage) => Promise<void>;
  deadLetterMessage: (m: ServiceBusReceivedMessage, opts?: unknown) => Promise<void>;
} {
  const calls: Call[] = [];
  return {
    calls,
    completeMessage: async () => {
      calls.push({ action: "complete" });
    },
    abandonMessage: async () => {
      calls.push({ action: "abandon" });
    },
    deadLetterMessage: async (_m, opts) => {
      calls.push({ action: "deadletter", opts });
    },
  };
}

const okSender: Sender = async () => true;
const failSender: Sender = async () => false;

test("processOne: parses good payload, calls sender, completes on success", async () => {
  const receiver = makeReceiver();
  const sender: Sender = async (to, body) => {
    assert.equal(to, "+15555550100");
    assert.equal(body, "hello");
    return true;
  };
  const msg = {
    body: JSON.stringify({ id: "abc", to: "+15555550100", body: "hello" }),
  } as unknown as ServiceBusReceivedMessage;
  await processOne(msg, { receiver, sender, logger: noopLog });
  assert.deepEqual(receiver.calls.map((c) => c.action), ["complete"]);
});

test("processOne: applies configured prefix and signature", async () => {
  const receiver = makeReceiver();
  const sender: Sender = async (_to, body) => {
    assert.equal(body, "[m365] hello ⚡");
    return true;
  };
  const msg = {
    body: JSON.stringify({ id: "abc", to: "+15555550100", body: "hello" }),
  } as unknown as ServiceBusReceivedMessage;
  await processOne(msg, {
    receiver,
    sender,
    logger: noopLog,
    messagePrefix: "[m365]",
    signature: "⚡",
  });
  assert.deepEqual(receiver.calls.map((c) => c.action), ["complete"]);
});

test("processOne: dead-letters a recipient outside the allowlist", async () => {
  const receiver = makeReceiver();
  let senderCalled = false;
  const sender: Sender = async () => {
    senderCalled = true;
    return true;
  };
  const msg = {
    body: JSON.stringify({ id: "abc", to: "+15555550100", body: "hello" }),
  } as unknown as ServiceBusReceivedMessage;
  await processOne(msg, {
    receiver,
    sender,
    logger: noopLog,
    allowedRecipients: ["+15555550101"],
  });
  assert.equal(senderCalled, false);
  assert.deepEqual(receiver.calls.map((c) => c.action), ["deadletter"]);
  assert.equal(
    (receiver.calls[0]!.opts as { deadLetterReason: string }).deadLetterReason,
    "recipient-not-allowed",
  );
});

test("processOne: abandons on osascript failure (transient)", async () => {
  const receiver = makeReceiver();
  const msg = {
    body: JSON.stringify({ id: "abc", to: "+15555550100", body: "hello" }),
  } as unknown as ServiceBusReceivedMessage;
  await processOne(msg, { receiver, sender: failSender, logger: noopLog });
  assert.deepEqual(receiver.calls.map((c) => c.action), ["abandon"]);
});

test("processOne: dead-letters on bad JSON", async () => {
  const receiver = makeReceiver();
  let senderCalled = false;
  const sender: Sender = async () => {
    senderCalled = true;
    return true;
  };
  const msg = { body: "not json {{" } as unknown as ServiceBusReceivedMessage;
  await processOne(msg, { receiver, sender, logger: noopLog });
  assert.equal(senderCalled, false);
  assert.deepEqual(receiver.calls.map((c) => c.action), ["deadletter"]);
  assert.equal((receiver.calls[0]!.opts as { deadLetterReason: string }).deadLetterReason, "bad-payload");
});

test("processOne: dead-letters on missing 'to'", async () => {
  const receiver = makeReceiver();
  const msg = {
    body: JSON.stringify({ id: "abc", body: "hi" }),
  } as unknown as ServiceBusReceivedMessage;
  await processOne(msg, { receiver, sender: okSender, logger: noopLog });
  assert.deepEqual(receiver.calls.map((c) => c.action), ["deadletter"]);
  assert.equal((receiver.calls[0]!.opts as { deadLetterReason: string }).deadLetterReason, "missing-fields");
});

test("processOne: dead-letters on missing 'body'", async () => {
  const receiver = makeReceiver();
  const msg = {
    body: JSON.stringify({ id: "abc", to: "+15555550100" }),
  } as unknown as ServiceBusReceivedMessage;
  await processOne(msg, { receiver, sender: okSender, logger: noopLog });
  assert.deepEqual(receiver.calls.map((c) => c.action), ["deadletter"]);
});

test("processOne: handles Buffer body", async () => {
  const receiver = makeReceiver();
  const msg = {
    body: Buffer.from(JSON.stringify({ id: "abc", to: "+15555550100", body: "hi" })),
  } as unknown as ServiceBusReceivedMessage;
  await processOne(msg, { receiver, sender: okSender, logger: noopLog });
  assert.deepEqual(receiver.calls.map((c) => c.action), ["complete"]);
});

test("exponentialBackoff: grows then caps at capMs", () => {
  const w0 = exponentialBackoff(0, { base: 1000, capMs: 60_000 });
  const w3 = exponentialBackoff(3, { base: 1000, capMs: 60_000 });
  const w20 = exponentialBackoff(20, { base: 1000, capMs: 60_000 });
  assert.ok(w0 >= 1000 && w0 <= 1200);
  assert.ok(w3 >= 8000 && w3 <= 9600);
  assert.equal(w20, 60_000);
});

test("buildOsascript: escapes double quotes and backslashes", () => {
  const s = buildOsascript("+15555550100", 'she said "hi" and \\backslash');
  assert.match(s, /tell application "Messages"/);
  assert.match(s, /buddy "\+15555550100"/);
  assert.match(s, /\\"hi\\"/);
  assert.match(s, /\\\\backslash/);
});

test("buildOsascript: includes the body verbatim (modulo escapes)", () => {
  const s = buildOsascript("+15555550100", "hello world");
  assert.match(s, /send "hello world" to theBuddy/);
});
