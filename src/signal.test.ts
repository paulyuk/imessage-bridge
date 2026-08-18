/**
 * Signal consumer sender tests — Node native test runner.
 * Mirrors the buildOsascript-style coverage in agent.test.ts, plus direct
 * spawn-injection coverage for signalCliSend (success / non-zero exit /
 * spawn error) since it isn't exercised elsewhere.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  buildSignalCliArgs,
  isSignalE164,
  isSignalGroup,
  signalCliSend,
  validateSignalRecipient,
} from "./signal.js";
import type { SpawnFn } from "./signal.js";
import type { Logger } from "./log.js";

const noopLog: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

test("buildSignalCliArgs: shapes the signal-cli argv", () => {
  const args = buildSignalCliArgs("+15555550199", "+15555550100", "hello world");
  assert.deepEqual(args, [
    "-a",
    "+15555550199",
    "send",
    "-m",
    "hello world",
    "--",
    "+15555550100",
  ]);
});

test("Signal E.164 validation rejects option-like and malformed destinations", () => {
  assert.equal(isSignalE164("+15555550100"), true);
  assert.equal(isSignalE164("--account"), false);
  assert.equal(isSignalE164("15555550100"), false);
  assert.equal(validateSignalRecipient("+15555550100"), undefined);
  assert.match(validateSignalRecipient("--version") ?? "", /E\.164 or group/);
});

test("Signal group recipient routes through signal-cli's group form", () => {
  const groupId = Buffer.alloc(16, 7).toString("base64");
  const recipient = `group:${groupId}`;
  assert.equal(isSignalGroup(recipient), true);
  assert.equal(validateSignalRecipient(recipient), undefined);
  assert.deepEqual(buildSignalCliArgs("+15555550199", recipient, "group hello"), [
    "-a",
    "+15555550199",
    "send",
    "-m",
    "group hello",
    "-g",
    groupId,
  ]);
  assert.equal(isSignalGroup("group:--version"), false);
});

function makeFakeChild(): {
  child: EventEmitter & { stderr: EventEmitter; kill: (sig: string) => void };
  emitStderr: (chunk: string) => void;
  finish: (code: number | null) => void;
  killed: boolean;
} {
  const child = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter;
    kill: (sig: string) => void;
  };
  child.stderr = new EventEmitter();
  const state = { killed: false };
  child.kill = () => {
    state.killed = true;
  };
  return {
    child,
    emitStderr: (chunk: string) => child.stderr.emit("data", Buffer.from(chunk)),
    finish: (code: number | null) => child.emit("close", code),
    get killed() {
      return state.killed;
    },
  } as unknown as ReturnType<typeof makeFakeChild>;
}

test("signalCliSend: resolves true on exit code 0", async () => {
  const fake = makeFakeChild();
  const spawnFn: SpawnFn = ((command: string, args: readonly string[]) => {
    assert.equal(command, "/opt/homebrew/bin/signal-cli");
    assert.deepEqual(args, ["-a", "+15555550199", "send", "-m", "hi", "--", "+15555550100"]);
    queueMicrotask(() => fake.finish(0));
    return fake.child as never;
  }) as SpawnFn;

  const ok = await signalCliSend({
    account: "+15555550199",
    to: "+15555550100",
    body: "hi",
    command: "/opt/homebrew/bin/signal-cli",
    logger: noopLog,
    spawnFn,
  });
  assert.equal(ok, true);
});

test("signalCliSend: resolves false on non-zero exit code", async () => {
  const fake = makeFakeChild();
  const spawnFn: SpawnFn = (() => {
    queueMicrotask(() => {
      fake.emitStderr("boom");
      fake.finish(1);
    });
    return fake.child as never;
  }) as SpawnFn;

  const ok = await signalCliSend({
    account: "+15555550199",
    to: "+15555550100",
    body: "hi",
    logger: noopLog,
    spawnFn,
  });
  assert.equal(ok, false);
});

test("signalCliSend: resolves false when the process errors (e.g. binary missing)", async () => {
  const fake = makeFakeChild();
  const spawnFn: SpawnFn = (() => {
    queueMicrotask(() => fake.child.emit("error", new Error("ENOENT")));
    return fake.child as never;
  }) as SpawnFn;

  const ok = await signalCliSend({
    account: "+15555550199",
    to: "+15555550100",
    body: "hi",
    logger: noopLog,
    spawnFn,
  });
  assert.equal(ok, false);
});

test("signalCliSend: rejects malformed destinations without spawning", async () => {
  let spawned = false;
  const spawnFn: SpawnFn = (() => {
    spawned = true;
    throw new Error("should not spawn");
  }) as SpawnFn;

  const ok = await signalCliSend({
    account: "+15555550199",
    to: "--version",
    body: "hi",
    logger: noopLog,
    spawnFn,
  });
  assert.equal(ok, false);
  assert.equal(spawned, false);
});

test("signalCliSend: resolves false when spawn throws synchronously", async () => {
  const spawnFn: SpawnFn = (() => {
    throw new Error("bad spawn options");
  }) as SpawnFn;

  const ok = await signalCliSend({
    account: "+15555550199",
    to: "+15555550100",
    body: "hi",
    logger: noopLog,
    spawnFn,
  });
  assert.equal(ok, false);
});

test("signalCliSend: kills and resolves false on timeout", async () => {
  const fake = makeFakeChild();
  const spawnFn: SpawnFn = (() => fake.child as never) as SpawnFn;

  const ok = await signalCliSend({
    account: "+15555550199",
    to: "+15555550100",
    body: "hi",
    timeoutMs: 1,
    logger: noopLog,
    spawnFn,
  });
  assert.equal(ok, false);
  assert.equal(fake.killed, true);
});
