/**
 * Signal consumer sender tests — Node native test runner.
 * Mirrors the buildOsascript-style coverage in agent.test.ts, plus direct
 * spawn-injection coverage for signalCliSend (success / non-zero exit /
 * spawn error) since it isn't exercised elsewhere.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { buildSignalCliArgs, signalCliSend } from "./signal.js";
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
  assert.deepEqual(args, ["-a", "+15555550199", "send", "+15555550100", "-m", "hello world"]);
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
    assert.equal(command, "signal-cli");
    assert.deepEqual(args, ["-a", "+15555550199", "send", "+15555550100", "-m", "hi"]);
    queueMicrotask(() => fake.finish(0));
    return fake.child as never;
  }) as SpawnFn;

  const ok = await signalCliSend({
    account: "+15555550199",
    to: "+15555550100",
    body: "hi",
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
