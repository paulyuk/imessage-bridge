/**
 * Load and validate config.json.
 *
 * Mirrors producer/cli.py: namespace_fqdn + queue are required;
 * signature is optional (defaults to "🐩"); unknown keys ignored.
 */

import { readFileSync, existsSync } from "node:fs";

/**
 * @typedef {Object} BridgeConfig
 * @property {string} namespace_fqdn   - e.g. "my-bridge.servicebus.windows.net"
 * @property {string} queue            - e.g. "imsg-queue"
 * @property {string} [signature]      - optional suffix (default 🐩)
 * @property {number} [poll_interval_s]
 * @property {string} [log_path]
 */

/**
 * @param {string} [path]  Path to config.json, defaults to ./config.json or $IMSG_CONFIG.
 * @returns {BridgeConfig}
 */
export function loadConfig(path) {
  const cfgPath = path ?? process.env.IMSG_CONFIG ?? "config.json";
  if (!existsSync(cfgPath)) {
    throw new Error(
      `config not found: ${cfgPath}\n` +
        `  fix: cp config.example.json config.json && \\$EDITOR config.json`,
    );
  }
  const raw = readFileSync(cfgPath, "utf8");
  /** @type {BridgeConfig} */
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    throw new Error(`config is not valid JSON: ${cfgPath}\n  ${e.message}`);
  }
  if (!cfg.namespace_fqdn || cfg.namespace_fqdn === "REPLACE-ME.servicebus.windows.net") {
    throw new Error(
      `config.namespace_fqdn is unset (still REPLACE-ME or empty)\n` +
        `  fix: edit ${cfgPath} and set namespace_fqdn to "<ns>.servicebus.windows.net"`,
    );
  }
  if (!cfg.queue) {
    throw new Error(`config.queue is required (e.g. "imsg-queue") — fix in ${cfgPath}`);
  }
  return cfg;
}
