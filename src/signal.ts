/**
 * Send a message via signal-cli — the Signal sibling to messages.ts's
 * osascript wrapper. Same spawn/timeout/stderr-capture shape so both
 * senders plug into agent.ts's `Sender` type identically.
 */

import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";

import type { Logger } from "./log.js";

export function buildSignalCliArgs(account: string, to: string, body: string): string[] {
  return ["-a", account, "send", to, "-m", body];
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options?: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export type SignalCliSendOptions = {
  account: string;
  to: string;
  body: string;
  timeoutMs?: number;
  logger?: Logger;
  spawnFn?: SpawnFn;
};

export function signalCliSend(opts: SignalCliSendOptions): Promise<boolean> {
  const { account, to, body, timeoutMs = 30_000, logger, spawnFn } = opts;
  const args = buildSignalCliArgs(account, to, body);
  const sp: SpawnFn = spawnFn ?? (spawn as unknown as SpawnFn);

  return new Promise((resolve) => {
    const child = sp("signal-cli", args);
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      logger?.error(`signal-cli timed out for ${to}`);
      resolve(false);
    }, timeoutMs);

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err: Error) => {
      clearTimeout(timer);
      if (timedOut) return;
      logger?.error(`signal-cli spawn failed for ${to}: ${err.message}`);
      resolve(false);
    });

    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (timedOut) return;
      if (code === 0) {
        resolve(true);
      } else {
        logger?.error(
          `signal-cli failed for ${to} (exit ${code ?? "null"}): ${stderr.trim() || "(no stderr)"}`,
        );
        resolve(false);
      }
    });
  });
}
