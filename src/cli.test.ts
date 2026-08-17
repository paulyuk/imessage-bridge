import { test } from "node:test";
import assert from "node:assert/strict";

import { helpText, main, validateSignalQueue } from "./cli.js";
import type { CliDependencies } from "./cli.js";
import type { BridgeConfig } from "./config.js";

const config: BridgeConfig = {
  namespace_fqdn: "test-ns.servicebus.windows.net",
  queue: "imsg-queue",
  signal_queue: "signal-queue",
  signal_account: "+15555550199",
};

test("help includes both channel send commands and a fictional Signal example", () => {
  const help = helpText();
  assert.match(help, /iMessage and Signal/);
  assert.match(help, /signal-send --to <\+E164> --body <text> \[--config <path>\]/);
  assert.match(help, /signal-send --to \+15555550100 --body 'hello over Signal'/);
});

test("signal-send: enqueues to the dedicated Signal queue", async () => {
  let sentQueue: string | undefined;
  const dependencies: CliDependencies = {
    loadConfig: () => config,
    sendMessage: async ({ config: targetConfig }) => {
      sentQueue = targetConfig.queue;
      return "signal-job";
    },
  };

  const code = await main(
    ["signal-send", "--to", "+15555550100", "--body", "hello"],
    dependencies,
  );

  assert.equal(code, 0);
  assert.equal(sentQueue, "signal-queue");
});

test("send: continues to enqueue to the iMessage queue", async () => {
  let sentQueue: string | undefined;
  const dependencies: CliDependencies = {
    loadConfig: () => config,
    sendMessage: async ({ config: targetConfig }) => {
      sentQueue = targetConfig.queue;
      return "imessage-job";
    },
  };

  const code = await main(["send", "--to", "+15555550100", "--body", "hello"], dependencies);

  assert.equal(code, 0);
  assert.equal(sentQueue, "imsg-queue");
});

test("signal-send: rejects malformed Signal destinations before enqueueing", async () => {
  let called = false;
  const dependencies: CliDependencies = {
    loadConfig: () => config,
    sendMessage: async () => {
      called = true;
      return "unexpected";
    },
  };

  const code = await main(["signal-send", "--to", "--version", "--body", "hello"], dependencies);

  assert.equal(code, 2);
  assert.equal(called, false);
});

test("Signal commands reject a shared iMessage queue", async () => {
  const sharedQueueConfig: BridgeConfig = { ...config, signal_queue: config.queue };
  assert.match(validateSignalQueue(sharedQueueConfig) ?? "", /must differ/);

  let sent = false;
  let agentStarted = false;
  const dependencies: CliDependencies = {
    loadConfig: () => sharedQueueConfig,
    sendMessage: async () => {
      sent = true;
      return "unexpected";
    },
    runAgent: async () => {
      agentStarted = true;
      return 0;
    },
  };

  const sendCode = await main(
    ["signal-send", "--to", "+15555550100", "--body", "hello"],
    dependencies,
  );
  const agentCode = await main(["signal-agent"], dependencies);

  assert.equal(sendCode, 2);
  assert.equal(agentCode, 2);
  assert.equal(sent, false);
  assert.equal(agentStarted, false);
});
