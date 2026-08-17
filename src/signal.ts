/**
 * Send a message via signal-cli — the Signal sibling to messages.ts's
 * osascript wrapper. Same spawn/timeout/stderr-capture shape so both
 * senders plug into agent.ts's `Sender` type identically.
 */

import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";

import type { Logger } from "./log.js";

const E164_DESTINATION = /^\+[1-9]\d{1,14}$/;
const MAX_STDERR_LOG_CHARS = 4_096;

/**
 * signal-cli accepts international telephone numbers only. Keeping this check
 * separate from the iMessage producer's legacy validation prevents a queue
 * payload from being interpreted as a command-line option.
 */
export function isSignalE164(value: string): boolean {
  return E164_DESTINATION.test(value);
}

export function validateSignalRecipient(to: string): string | undefined {
  return isSignalE164(to)
    ? undefined
    : "Signal recipient must be an E.164 number (for example +14255551234)";
}

export function buildSignalCliArgs(account: string, to: string, body: string): string[] {
  return ["-a", account, "send", "-m", body, "--", to];
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
  command?: string;
  timeoutMs?: number;
  logger?: Logger;
  spawnFn?: SpawnFn;
};

export function signalCliSend(opts: SignalCliSendOptions): Promise<boolean> {
  const { account, to, body, command = "signal-cli", timeoutMs = 30_000, logger, spawnFn } = opts;
  if (!isSignalE164(account)) {
    logger?.error("signal-cli account must be an E.164 number");
    return Promise.resolve(false);
  }
  if (!isSignalE164(to)) {
    logger?.error(`signal-cli recipient is not E.164: ${to}`);
    return Promise.resolve(false);
  }

  const args = buildSignalCliArgs(account, to, body);
  const sp: SpawnFn = spawnFn ?? (spawn as unknown as SpawnFn);

  return new Promise((resolve) => {
    let stderr = "";
    let finished = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (ok: boolean): void => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      resolve(ok);
    };

    let child: ChildProcessWithoutNullStreams;
    try {
      child = sp(command, args, { shell: false });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger?.error(`signal-cli spawn failed for ${to}: ${msg}`);
      finish(false);
      return;
    }

    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      logger?.error(`signal-cli timed out for ${to}`);
      finish(false);
    }, timeoutMs);

    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_LOG_CHARS) {
        stderr += chunk.toString("utf8").slice(0, MAX_STDERR_LOG_CHARS - stderr.length);
      }
    });

    child.on("error", (err: Error) => {
      logger?.error(`signal-cli spawn failed for ${to}: ${err.message}`);
      finish(false);
    });

    child.on("close", (code: number | null) => {
      if (code === 0) {
        finish(true);
      } else {
        logger?.error(
          `signal-cli failed for ${to} (exit ${code ?? "null"}): ${stderr.trim() || "(no stderr)"}`,
        );
        finish(false);
      }
    });
  });
}
