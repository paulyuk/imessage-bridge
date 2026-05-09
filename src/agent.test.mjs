/**
 * Agent unit tests — covers payload parsing, send dispatch, settle behavior,
 * dead-lettering, exponential backoff. Mocks the receiver + sender — does not
 * touch a real Service Bus or osascript.
 *
 * Run with:  node --test src/*.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { exponentialBackoff, processOne } from "./agent.mjs";
import { buildOsascript } from "./messages.mjs";

const noopLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function makeReceiver() {
  /** @type {{action: string, msg: any, opts?: any}[]} */
  const calls = [];
  return {
    calls,
    completeMessage: async (m) => calls.push({ action: "complete", msg: m }),
    abandonMessage: async (m) => calls.push({ action: "abandon", msg: m }),
    deadLetterMessage: async (m, opts) => calls.push({ action: "deadletter", msg: m, opts }),
  };
}

test("processOne: parses good payload, calls sender, completes on success", async () => {
  const receiver = makeReceiver();
  const sender = async (to, body) => {
    assert.equal(to, "+15555550100");
    assert.equal(body, "hello");
    return true;
  };
  const msg = { body: JSON.stringify({ id: "abc", to: "+15555550100", body: "hello" }) };
  await processOne(msg, { receiver, sender, logger: noopLog });
  assert.deepEqual(receiver.calls.map((c) => c.action), ["complete"]);
});

test("processOne: abandons on osascript failure (transient)", async () => {
  const receiver = makeReceiver();
  const sender = async () => false;
  const msg = { body: JSON.stringify({ id: "abc", to: "+15555550100", body: "hello" }) };
  await processOne(msg, { receiver, sender, logger: noopLog });
  assert.deepEqual(receiver.calls.map((c) => c.action), ["abandon"]);
});

test("processOne: dead-letters on bad JSON", async () => {
  const receiver = makeReceiver();
  let senderCalled = false;
  const sender = async () => {
    senderCalled = true;
    return true;
  };
  const msg = { body: "not json {{" };
  await processOne(msg, { receiver, sender, logger: noopLog });
  assert.equal(senderCalled, false);
  assert.deepEqual(receiver.calls.map((c) => c.action), ["deadletter"]);
  assert.equal(receiver.calls[0].opts.deadLetterReason, "bad-payload");
});

test("processOne: dead-letters on missing 'to'", async () => {
  const receiver = makeReceiver();
  const msg = { body: JSON.stringify({ id: "abc", body: "hi" /* no to */ }) };
  await processOne(msg, { receiver, sender: async () => true, logger: noopLog });
  assert.deepEqual(receiver.calls.map((c) => c.action), ["deadletter"]);
  assert.equal(receiver.calls[0].opts.deadLetterReason, "missing-fields");
});

test("processOne: dead-letters on missing 'body'", async () => {
  const receiver = makeReceiver();
  const msg = { body: JSON.stringify({ id: "abc", to: "+1555..." }) };
  await processOne(msg, { receiver, sender: async () => true, logger: noopLog });
  assert.deepEqual(receiver.calls.map((c) => c.action), ["deadletter"]);
});

test("processOne: handles Buffer body", async () => {
  const receiver = makeReceiver();
  const msg = {
    body: Buffer.from(JSON.stringify({ id: "abc", to: "+15555550100", body: "hi" })),
  };
  await processOne(msg, { receiver, sender: async () => true, logger: noopLog });
  assert.deepEqual(receiver.calls.map((c) => c.action), ["complete"]);
});

test("exponentialBackoff: grows then caps at capMs", () => {
  const w0 = exponentialBackoff(0, { base: 1000, capMs: 60_000 });
  const w3 = exponentialBackoff(3, { base: 1000, capMs: 60_000 });
  const w20 = exponentialBackoff(20, { base: 1000, capMs: 60_000 });
  assert.ok(w0 >= 1000 && w0 <= 1200);   // 1s + ≤20% jitter
  assert.ok(w3 >= 8000 && w3 <= 9600);    // 8s + ≤20% jitter
  assert.equal(w20, 60_000);              // capped
});

test("buildOsascript: escapes double quotes and backslashes", () => {
  const s = buildOsascript("+15555550100", 'she said "hi" and \\backslash');
  assert.match(s, /tell application "Messages"/);
  assert.match(s, /buddy "\+15555550100"/);
  assert.match(s, /\\"hi\\"/);                // doubled quote inside body
  assert.match(s, /\\\\backslash/);           // doubled backslash
});

test("buildOsascript: includes the body verbatim (modulo escapes)", () => {
  const s = buildOsascript("+15555550100", "hello world");
  assert.match(s, /send "hello world" to theBuddy/);
});
