/**
 * Producer unit tests — Node native test runner.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildPayload, sendMessage } from "./producer.js";
import type { BridgeConfig } from "./config.js";

const validConfig: BridgeConfig = {
  namespace_fqdn: "test-ns.servicebus.windows.net",
  queue: "imsg-queue",
  signature: "🐩",
};

test("buildPayload: appends signature when configured and missing", () => {
  const p = buildPayload({ to: "+15555550100", body: "hello", signature: "🐩" });
  assert.equal(p.body, "hello 🐩");
  assert.equal(p.to, "+15555550100");
  assert.match(p.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test("buildPayload: prepends a configured prefix", () => {
  const p = buildPayload({
    to: "+15555550100",
    body: "hello",
    messagePrefix: "[m365]",
    signature: "⚡",
  });
  assert.equal(p.body, "[m365] hello ⚡");
});

test("buildPayload: does NOT double-append signature", () => {
  const p = buildPayload({ to: "+15555550100", body: "hello 🐩", signature: "🐩" });
  assert.equal(p.body, "hello 🐩");
});

test("buildPayload: empty signature leaves body untouched", () => {
  const p = buildPayload({ to: "+15555550100", body: "hello", signature: "" });
  assert.equal(p.body, "hello");
});

test("buildPayload: uses provided clock", () => {
  const fixed = new Date("2026-01-01T00:00:00Z");
  const p = buildPayload({ to: "+15555550100", body: "hi", now: () => fixed });
  assert.equal(p.ts, "2026-01-01T00:00:00.000Z");
});

test("sendMessage: rejects non-E.164 numbers", async () => {
  await assert.rejects(
    () =>
      sendMessage({
        config: validConfig,
        to: "(425) 555-1234",
        body: "hi",
      }),
    /E\.164/,
  );
});

test("sendMessage: rejects missing body", async () => {
  await assert.rejects(
    () =>
      sendMessage({
        config: validConfig,
        to: "+15555550100",
        body: "",
      }),
    /--body is required/,
  );
});

test("sendMessage: enqueues a JSON ServiceBusMessage with messageId", async () => {
  const sent: Array<{ messageId?: string; contentType?: string; body?: unknown }> = [];
  const fakeSender = {
    sendMessages: async (msg: { messageId?: string; contentType?: string; body?: unknown }) => {
      sent.push(msg);
    },
    close: async () => {},
  };
  const fakeClient = {
    createSender: () => fakeSender,
    close: async () => {},
  };
  const id = await sendMessage({
    config: validConfig,
    to: "+15555550100",
    body: "hello",
    credential: {} as never,
    clientFactory: () => fakeClient as never,
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.messageId, id);
  assert.equal(sent[0]!.contentType, "application/json");
  const payload = JSON.parse(sent[0]!.body as string) as { id: string; to: string; body: string };
  assert.equal(payload.id, id);
  assert.equal(payload.to, "+15555550100");
  assert.equal(payload.body, "hello 🐩");
});
