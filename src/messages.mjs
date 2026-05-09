/**
 * Send an iMessage via osascript → Messages.app.
 *
 * Mirrors mac/agent.py's _osascript_send:
 *   - escapes backslashes and double-quotes in body
 *   - runs `osascript -e <script>` with capture + 30s timeout
 *   - returns true on exit-0, false otherwise (logs stderr)
 *
 * Pure boundary so the agent can be tested without a real Mac
 * (caller can swap in a fake spawn).
 */

import { spawn } from "node:child_process";

/**
 * @param {string} to    E.164 phone or iMessage email handle
 * @param {string} body  message body (any unicode)
 * @returns {string}     the osascript program text
 */
export function buildOsascript(to, body) {
  const safe = body.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return [
    'tell application "Messages"',
    "  set targetService to 1st service whose service type = iMessage",
    `  set theBuddy to buddy "${to}" of targetService`,
    `  send "${safe}" to theBuddy`,
    "end tell",
  ].join("\n");
}

/**
 * Run osascript with the rendered program. Resolves to true on success.
 *
 * @param {{
 *   to: string,
 *   body: string,
 *   timeoutMs?: number,
 *   logger?: import("./log.mjs").Logger,
 *   spawnFn?: typeof spawn,
 * }} opts
 * @returns {Promise<boolean>}
 */
export function osascriptSend({ to, body, timeoutMs = 30_000, logger, spawnFn }) {
  const script = buildOsascript(to, body);
  const sp = spawnFn ?? spawn;

  return new Promise((resolve) => {
    const child = sp("osascript", ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
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

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      if (timedOut) return;
      logger?.error(`osascript spawn failed for ${to}: ${err.message}`);
      resolve(false);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return;
      if (code === 0) {
        resolve(true);
      } else {
        logger?.error(
          `osascript failed for ${to} (exit ${code}): ${stderr.trim() || "(no stderr)"}`,
        );
        resolve(false);
      }
    });
  });
}
