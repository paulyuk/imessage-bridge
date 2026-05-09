/**
 * Tiny dependency-free logger.
 * Writes to stderr (captured by launchd) AND a structured app log file.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Logger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
};

export function createLogger(logPath: string): Logger {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
  } catch {
    /* ignore */
  }

  const fmt = (level: string, args: unknown[]): string => {
    const ts = new Date().toISOString().replace("T", " ").replace("Z", "");
    const msg = args
      .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
      .join(" ");
    return `${ts} ${level} ${msg}\n`;
  };

  const write = (level: string, args: unknown[]): void => {
    const line = fmt(level, args);
    process.stderr.write(line);
    try {
      appendFileSync(logPath, line);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`(logger: failed to write ${logPath}: ${msg})\n`);
    }
  };

  return {
    info: (...a) => write("INFO", a),
    warn: (...a) => write("WARN", a),
    error: (...a) => write("ERROR", a),
    debug: (...a) => {
      if (process.env.IMSG_DEBUG) write("DEBUG", a);
    },
  };
}
