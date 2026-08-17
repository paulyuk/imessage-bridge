/**
 * Load and validate config.json.
 */

import { readFileSync, existsSync } from "node:fs";

export type BridgeConfig = {
  /** e.g. "my-bridge.servicebus.windows.net" */
  namespace_fqdn: string;
  /** e.g. "imsg-queue" */
  queue: string;
  /** Optional suffix appended to outgoing bodies (default 🐩 in example). */
  signature?: string;
  poll_interval_s?: number;
  log_path?: string;
  health_endpoint?: string;
  disconnect_alert_threshold?: number;
  /** Optional — queue name for the Signal sibling consumer (e.g. "signal-queue"). */
  signal_queue?: string;
  /** Optional — signal-cli account (E.164) the Signal consumer sends from. */
  signal_account?: string;
  /** Optional — log path override for the Signal consumer (default ./logs/signal-agent.log). */
  signal_log_path?: string;
};

export function loadConfig(path?: string): BridgeConfig {
  const cfgPath = path ?? process.env.IMSG_CONFIG ?? "config.json";
  if (!existsSync(cfgPath)) {
    throw new Error(
      `config not found: ${cfgPath}\n` +
        `  fix: cp config.example.json config.json && \\$EDITOR config.json`,
    );
  }
  const raw = readFileSync(cfgPath, "utf8");
  let cfg: BridgeConfig;
  try {
    cfg = JSON.parse(raw) as BridgeConfig;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`config is not valid JSON: ${cfgPath}\n  ${msg}`);
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
