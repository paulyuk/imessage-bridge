/**
 * Send an iMessage via osascript → Messages.app.
 */

import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";

import type { Logger } from "./log.js";

export function decorateMessage(
  body: string,
  options: { prefix?: string; signature?: string } = {},
): string {
  const prefix = options.prefix?.trim() ?? "";
  const signature = options.signature?.trim() ?? "";
  let decorated = body;

  if (prefix && !decorated.startsWith(prefix)) {
    decorated = `${prefix} ${decorated}`;
  }
  if (signature && !decorated.trimEnd().endsWith(signature)) {
    decorated = `${decorated.trimEnd()} ${signature}`;
  }

  return decorated;
}

export function buildOsascript(to: string, body: string): string {
  const safe = body.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return [
    'tell application "Messages"',
    "  set targetService to 1st service whose service type = iMessage",
    `  set theBuddy to buddy "${to}" of targetService`,
    `  send "${safe}" to theBuddy`,
    "end tell",
  ].join("\n");
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options?: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export type OsascriptSendOptions = {
  to: string;
  body: string;
  helperPath?: string;
  timeoutMs?: number;
  logger?: Logger;
  spawnFn?: SpawnFn;
};

export function osascriptSend(opts: OsascriptSendOptions): Promise<boolean> {
  const { to, body, helperPath, timeoutMs = 30_000, logger, spawnFn } = opts;
  const script = buildOsascript(to, body);
  const sp: SpawnFn = spawnFn ?? (spawn as unknown as SpawnFn);

  return new Promise((resolve) => {
    // default stdio is [pipe, pipe, pipe] which gives us null-free streams via
    // ChildProcessWithoutNullStreams. We don't write to stdin, so leaving it
    // open as a pipe is harmless.
    const child = helperPath
      ? sp(helperPath, [to, body])
      : sp("osascript", ["-e", script]);
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      logger?.error(`osascript timed out for ${to}`);
      resolve(false);
    }, timeoutMs);

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err: Error) => {
      clearTimeout(timer);
      if (timedOut) return;
      logger?.error(`osascript spawn failed for ${to}: ${err.message}`);
      resolve(false);
    });

    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (timedOut) return;
      if (code === 0) {
        resolve(true);
      } else {
        logger?.error(
          `osascript failed for ${to} (exit ${code ?? "null"}): ${stderr.trim() || "(no stderr)"}`,
        );
        resolve(false);
      }
    });
  });
}
