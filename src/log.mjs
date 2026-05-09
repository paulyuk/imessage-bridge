/**
 * Tiny dependency-free logger.
 *
 * Mirrors what the Python agent did via logging.basicConfig:
 *   - human-readable timestamps
 *   - level prefix
 *   - writes to BOTH stderr (captured by launchd → logs/agent.launchd.log)
 *     AND a structured app log file (logs/agent.log)
 *
 * Stays small on purpose — no winston/pino deps.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * @param {string} logPath  absolute or repo-relative path to the app log file
 */
export function createLogger(logPath) {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
  } catch {
    /* ignore — directory may already exist */
  }

  const fmt = (level, ...args) => {
    const ts = new Date().toISOString().replace("T", " ").replace("Z", "");
    const msg = args
      .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
      .join(" ");
    return `${ts} ${level} ${msg}\n`;
  };

  const write = (level, ...args) => {
    const line = fmt(level, ...args);
    process.stderr.write(line);
    try {
      appendFileSync(logPath, line);
    } catch (e) {
      // Don't crash the agent over a log write failure.
      process.stderr.write(
        `(logger: failed to write ${logPath}: ${e.message})\n`,
      );
    }
  };

  return {
    info: (...a) => write("INFO", ...a),
    warn: (...a) => write("WARN", ...a),
    error: (...a) => write("ERROR", ...a),
    debug: (...a) => {
      if (process.env.IMSG_DEBUG) write("DEBUG", ...a);
    },
  };
}

/** @typedef {ReturnType<typeof createLogger>} Logger */
