/**
 * Load and validate config.json.
 */

import { readFileSync, existsSync } from "node:fs";

export type BridgeConfig = {
  /** e.g. "my-bridge.servicebus.windows.net" */
  namespace_fqdn: string;
  /** e.g. "imsg-queue" */
  queue: string;
  /** Optional suffix appended to outgoing bodies. */
  signature?: string;
  /** Optional prefix prepended to outgoing bodies. */
  message_prefix?: string;
  /** Optional E.164 recipient allowlist for outbound messages. */
  allowed_recipients?: string[];
  /** Optional compiled local helper used for Messages automation. */
  automation_helper_path?: string;
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
  /** Optional absolute signal-cli executable path; LaunchAgent supplies this automatically. */
  signal_cli_path?: string;
};

/**
 * Storage Queue settings for the standalone Wintergreen listener. They are
 * deliberately separate from Service Bus namespace_fqdn/queue settings.
 */
export type WintergreenConfig = {
  wintergreen_queue_endpoint?: string;
  wintergreen_queue?: string;
  wintergreen_poison_queue?: string;
  wintergreen_max_dequeue_count?: number;
  wintergreen_visibility_timeout_s?: number;
  wintergreen_log_path?: string;
  poll_interval_s?: number;
  signal_account?: string;
  signal_cli_path?: string;
};

function readJsonConfig(path?: string): { cfgPath: string; cfg: Record<string, unknown> } {
  const cfgPath = path ?? process.env.IMSG_CONFIG ?? "config.json";
  if (!existsSync(cfgPath)) {
    throw new Error(
      `config not found: ${cfgPath}\n` +
        `  fix: cp config.example.json config.json && \\$EDITOR config.json`,
    );
  }
  const raw = readFileSync(cfgPath, "utf8");
  try {
    return { cfgPath, cfg: JSON.parse(raw) as Record<string, unknown> };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`config is not valid JSON: ${cfgPath}\n  ${msg}`);
  }
}

export function loadConfig(path?: string): BridgeConfig {
  const { cfgPath, cfg } = readJsonConfig(path);
  const bridgeConfig = cfg as BridgeConfig;
  if (
    !bridgeConfig.namespace_fqdn ||
    bridgeConfig.namespace_fqdn === "REPLACE-ME.servicebus.windows.net"
  ) {
    throw new Error(
      `config.namespace_fqdn is unset (still REPLACE-ME or empty)\n` +
        `  fix: edit ${cfgPath} and set namespace_fqdn to "<ns>.servicebus.windows.net"`,
    );
  }
  if (!bridgeConfig.queue) {
    throw new Error(`config.queue is required (e.g. "imsg-queue") — fix in ${cfgPath}`);
  }
  return bridgeConfig;
}

export function loadWintergreenConfig(path?: string): WintergreenConfig {
  const { cfg } = readJsonConfig(path);
  return cfg as WintergreenConfig;
}
