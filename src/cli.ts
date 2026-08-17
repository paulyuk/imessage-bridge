#!/usr/bin/env node
/**
 * imessage-bridge CLI dispatcher.
 *
 * Subcommands:
 *   send  --to <e164> --body <text> [--config <path>]
 *   agent [--config <path>]
 *   help | --help | -h
 *   version | --version | -v
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { loadConfig } from "./config.js";
import type { BridgeConfig } from "./config.js";
import { sendMessage } from "./producer.js";
import { runAgent } from "./agent.js";
import type { Sender } from "./agent.js";
import { createLogger } from "./log.js";
import { isSignalE164, signalCliSend, validateSignalRecipient } from "./signal.js";

type ParsedFlags = {
  to?: string;
  body?: string;
  config?: string;
  positional: string[];
};

export type CliDependencies = {
  loadConfig?: typeof loadConfig;
  sendMessage?: typeof sendMessage;
  runAgent?: typeof runAgent;
};

export function validateSignalQueue(config: BridgeConfig): string | undefined {
  if (!config.signal_queue) {
    return 'config.signal_queue is required (e.g. "signal-queue")';
  }
  if (config.signal_queue === config.queue) {
    return "config.signal_queue must differ from config.queue; Signal requires a dedicated queue";
  }
  return undefined;
}

function parseFlags(argv: string[]): ParsedFlags {
  const out: ParsedFlags = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--to") {
      out.to = argv[++i];
    } else if (a === "--body") {
      out.body = argv[++i];
    } else if (a === "--config") {
      out.config = argv[++i];
    } else if (a.startsWith("--to=")) {
      out.to = a.slice(5);
    } else if (a.startsWith("--body=")) {
      out.body = a.slice(7);
    } else if (a.startsWith("--config=")) {
      out.config = a.slice(9);
    } else {
      out.positional.push(a);
    }
  }
  return out;
}

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function helpText(): string {
  return [
      "imessage-bridge — deliver iMessage and Signal messages via Azure Service Bus queues.",
      "",
      "Usage:",
      "  imessage-bridge send  --to <+E164> --body <text> [--config <path>]",
      "  imessage-bridge signal-send --to <+E164> --body <text> [--config <path>]",
      "  imessage-bridge agent [--config <path>]",
      "  imessage-bridge signal-agent [--config <path>]",
      "  imessage-bridge help | --help | -h",
      "  imessage-bridge version | --version | -v",
      "",
      "Environment:",
      "  IMSG_CONFIG     path to config.json (default: ./config.json)",
      "",
      "Examples:",
      "  imessage-bridge send --to +14255551234 --body 'hello from anywhere'",
      "  imessage-bridge signal-send --to +15555550100 --body 'hello over Signal'",
      "  imessage-bridge agent",
      "  imessage-bridge signal-agent   # requires config.signal_queue + config.signal_account",
      "",
    ].join("\n");
}

function printHelp(): void {
  process.stdout.write(helpText());
}

export async function main(argv: string[], dependencies: CliDependencies = {}): Promise<number> {
  const [cmd, ...rest] = argv;

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    return 0;
  }

  if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    process.stdout.write(`${readVersion()}\n`);
    return 0;
  }

  const flags = parseFlags(rest);
  const config = (dependencies.loadConfig ?? loadConfig)(flags.config);

  if (cmd === "send" || cmd === "signal-send") {
    if (!flags.to || !flags.body) {
      process.stderr.write(
        `error: ${cmd} requires --to <+E164> and --body <text>\n` +
          "  example: imessage-bridge send --to +14255551234 --body 'hi'\n",
      );
      return 2;
    }
    if (cmd === "signal-send" && !isSignalE164(flags.to)) {
      process.stderr.write("error: signal-send requires an E.164 --to destination\n");
      return 2;
    }
    let targetConfig = config;
    if (cmd === "signal-send") {
      const queueError = validateSignalQueue(config);
      if (queueError) {
        process.stderr.write(`error: ${queueError}\n`);
        return 2;
      }
      targetConfig = { ...config, queue: config.signal_queue! };
    }
    const id = await (dependencies.sendMessage ?? sendMessage)({
      config: targetConfig,
      to: flags.to,
      body: flags.body,
    });
    process.stdout.write(`enqueued ${id} -> ${flags.to}\n`);
    return 0;
  }

  if (cmd === "agent") {
    return await (dependencies.runAgent ?? runAgent)({ config });
  }

  if (cmd === "signal-agent") {
    const queueError = validateSignalQueue(config);
    if (queueError) {
      process.stderr.write(`error: ${queueError}\n`);
      return 2;
    }
    if (!config.signal_account) {
      process.stderr.write(
        "error: config.signal_account is required for signal-agent (e.g. \"+15555550100\")\n" +
          "  fix: add \"signal_account\" to config.json\n",
      );
      return 2;
    }
    if (!isSignalE164(config.signal_account)) {
      process.stderr.write(
        'error: config.signal_account must be an E.164 number (e.g. "+14255551234")\n',
      );
      return 2;
    }
    const signalLogPath = config.signal_log_path ?? "./logs/signal-agent.log";
    const signalConfig: BridgeConfig = {
      ...config,
      queue: config.signal_queue!,
      log_path: signalLogPath,
      // Signal intentionally accepts every valid destination from its dedicated
      // queue; iMessage's optional allowlist must never cross this boundary.
      allowed_recipients: undefined,
    };
    const account = config.signal_account;
    const logger = createLogger(signalLogPath);
    const command = config.signal_cli_path ?? process.env.IMSG_SIGNAL_CLI;
    const sender: Sender = (to, body) =>
      signalCliSend({ account, to, body, command, logger });
    return await (dependencies.runAgent ?? runAgent)({
      config: signalConfig,
      sender,
      logger,
      recipientValidator: validateSignalRecipient,
    });
  }

  process.stderr.write(`unknown command: ${cmd}\n`);
  printHelp();
  return 2;
}

const invokedPath = process.argv[1];
if (invokedPath && resolve(fileURLToPath(import.meta.url)) === resolve(invokedPath)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`error: ${msg}\n`);
      process.exit(1);
    },
  );
}
