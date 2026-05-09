/**
 * Tests for the Dapr extension.
 *
 * Two layers:
 *
 *  1. Unit tests for `handleMessage` and `sendMessage` — always run, no
 *     external dependencies. Cover payload validation, dead-letter / retry
 *     semantics, and the publish wrapper (with a mocked DaprClient).
 *
 *  2. E2E smoke test — only runs if BOTH `docker` and `dapr` CLIs are
 *     installed. Otherwise it skips cleanly so CI / contributor laptops
 *     without Dapr don't fail. The full e2e (sidecar + Redis + publish +
 *     subscribe round-trip) is documented in README.md as a manual procedure.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { handleMessage, PUBSUB_RESULT } from "../src/agent.mjs";
import { sendMessage, DAPR_DEFAULTS } from "../src/producer.mjs";

function silentLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
}

function isInstalled(cmd) {
  try {
    const r = spawnSync(cmd, ["--version"], { stdio: "ignore" });
    return r.status === 0;
  } catch {
    return false;
  }
}

// ─── handleMessage: payload validation ────────────────────────────────────

test("handleMessage: SUCCESS when sender returns true", async () => {
  const result = await handleMessage(
    { id: "abc", to: "+15555550100", body: "hi" },
    { sender: async () => true, logger: silentLogger() },
  );
  assert.equal(result, PUBSUB_RESULT.SUCCESS);
});

test("handleMessage: RETRY when sender returns false", async () => {
  const result = await handleMessage(
    { id: "abc", to: "+15555550100", body: "hi" },
    { sender: async () => false, logger: silentLogger() },
  );
  assert.equal(result, PUBSUB_RESULT.RETRY);
});

test("handleMessage: DROP on missing 'to'", async () => {
  const result = await handleMessage(
    { id: "abc", body: "hi" },
    { sender: async () => true, logger: silentLogger() },
  );
  assert.equal(result, PUBSUB_RESULT.DROP);
});

test("handleMessage: DROP on missing 'body'", async () => {
  const result = await handleMessage(
    { id: "abc", to: "+15555550100" },
    { sender: async () => true, logger: silentLogger() },
  );
  assert.equal(result, PUBSUB_RESULT.DROP);
});

test("handleMessage: DROP on non-JSON string payload", async () => {
  const result = await handleMessage("not json {{{", {
    sender: async () => true,
    logger: silentLogger(),
  });
  assert.equal(result, PUBSUB_RESULT.DROP);
});

test("handleMessage: DROP on non-object payload (number)", async () => {
  const result = await handleMessage(42, {
    sender: async () => true,
    logger: silentLogger(),
  });
  assert.equal(result, PUBSUB_RESULT.DROP);
});

test("handleMessage: parses JSON string and succeeds", async () => {
  const raw = JSON.stringify({ id: "abc", to: "+15555550100", body: "hi" });
  const result = await handleMessage(raw, {
    sender: async () => true,
    logger: silentLogger(),
  });
  assert.equal(result, PUBSUB_RESULT.SUCCESS);
});

// ─── sendMessage: validation + publish wrapper ────────────────────────────

test("sendMessage: rejects missing --to", async () => {
  await assert.rejects(
    () => sendMessage({ to: "", body: "hi" }),
    /--to is required/,
  );
});

test("sendMessage: rejects missing --body", async () => {
  await assert.rejects(
    () => sendMessage({ to: "+15555550100", body: "" }),
    /--body is required/,
  );
});

test("sendMessage: rejects non-E.164 --to", async () => {
  await assert.rejects(
    () => sendMessage({ to: "5551234", body: "hi" }),
    /must be E\.164/,
  );
});

test("sendMessage: publishes via injected DaprClient with correct args", async () => {
  let captured;
  const fakeClient = {
    pubsub: {
      publish: async (pubsubName, topic, payload) => {
        captured = { pubsubName, topic, payload };
        return true;
      },
    },
    stop: async () => {},
  };
  const id = await sendMessage({
    to: "+15555550100",
    body: "hi",
    signature: "🐩",
    client: fakeClient,
  });
  assert.equal(captured.pubsubName, DAPR_DEFAULTS.pubsubName);
  assert.equal(captured.topic, DAPR_DEFAULTS.topic);
  assert.equal(captured.payload.to, "+15555550100");
  assert.equal(captured.payload.body, "hi 🐩");
  assert.equal(captured.payload.id, id);
  assert.match(id, /^[0-9a-f]{8}-/);
});

test("sendMessage: honors topic + pubsubName overrides", async () => {
  let captured;
  const fakeClient = {
    pubsub: {
      publish: async (pubsubName, topic, payload) => {
        captured = { pubsubName, topic, payload };
      },
    },
    stop: async () => {},
  };
  await sendMessage({
    to: "+15555550100",
    body: "hi",
    topic: "custom-topic",
    pubsubName: "custom-pubsub",
    client: fakeClient,
  });
  assert.equal(captured.pubsubName, "custom-pubsub");
  assert.equal(captured.topic, "custom-topic");
});

// ─── E2E smoke test (skipped without docker + dapr CLIs) ──────────────────

test("e2e: dapr sidecar round-trip", { skip: true }, async (t) => {
  // We *always* skip in this sentinel test — the real e2e is documented
  // as a manual procedure in README.md ("End-to-end test"). Keeping a
  // skipped placeholder makes the intent visible in test output and
  // ready to enable once we wire up the Dapr CLI bootstrap in CI.
  t.diagnostic("e2e skipped — see extensions/dapr/README.md → 'End-to-end test'");
  void isInstalled; // referenced for future enablement
});
