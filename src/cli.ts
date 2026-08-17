#!/usr/bin/env node
/**
 * imessage-bridge CLI dispatcher.
 *
 * Subcommands:
 *   send | signal-send  --to <e164> --body <text> [--config <path>]
 *   agent [--config <path>]
 *   help | --help | -h
 *   version | --version | -v
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { loadConfig } from "./config.js";
import type { BridgeConfig } from "./config.js";
import { sendMessage } from "./producer.js";
import { runAgent } from "./agent.js";
import type { Sender } from "./agent.js";
import { signalCliSend } from "./signal.js";

type ParsedFlags = {
  to?: string;
  body?: string;
  config?: string;
  positional: string[];
};

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

function printHelp(): void {
  process.stdout.write(
    [
      "imessage-bridge — send iMessages from anywhere via an Azure Service Bus queue.",
      "",
      "Usage:",
      "  imessage-bridge send         --to <+E164> --body <text> [--config <path>]",
      "  imessage-bridge signal-send  --to <+E164> --body <text> [--config <path>]",
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
      "  imessage-bridge signal-send --to +14255551234 --body 'hello via Signal'",
      "  imessage-bridge agent",
      "  imessage-bridge signal-agent   # requires config.signal_queue + config.signal_account",
      "",
    ].join("\n"),
  );
}

async function main(argv: string[]): Promise<number> {
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
  const config = loadConfig(flags.config);

  if (cmd === "send") {
    if (!flags.to || !flags.body) {
      process.stderr.write(
        "error: send requires --to <+E164> and --body <text>\n" +
          "  example: imessage-bridge send --to +14255551234 --body 'hi'\n",
      );
      return 2;
    }
    const id = await sendMessage({ config, to: flags.to, body: flags.body });
    process.stdout.write(`enqueued ${id} -> ${flags.to}\n`);
    return 0;
  }

  if (cmd === "signal-send") {
    if (!config.signal_queue) {
      process.stderr.write(
        "error: config.signal_queue is required for signal-send (e.g. \"signal-queue\")\n" +
          "  fix: add \"signal_queue\" to config.json\n",
      );
      return 2;
    }
    if (!flags.to || !flags.body) {
      process.stderr.write(
        "error: signal-send requires --to <+E164> and --body <text>\n" +
          "  example: imessage-bridge signal-send --to +14255551234 --body 'hi'\n",
      );
      return 2;
    }
    const id = await sendMessage({
      config: { ...config, queue: config.signal_queue },
      to: flags.to,
      body: flags.body,
    });
    process.stdout.write(`enqueued ${id} -> ${flags.to} (signal)\n`);
    return 0;
  }

  if (cmd === "agent") {
    return await runAgent({ config });
  }

  if (cmd === "signal-agent") {
    if (!config.signal_queue) {
      process.stderr.write(
        "error: config.signal_queue is required for signal-agent (e.g. \"signal-queue\")\n" +
          "  fix: add \"signal_queue\" to config.json\n",
      );
      return 2;
    }
    if (!config.signal_account) {
      process.stderr.write(
        "error: config.signal_account is required for signal-agent (e.g. \"+15555550100\")\n" +
          "  fix: add \"signal_account\" to config.json\n",
      );
      return 2;
    }
    const signalConfig: BridgeConfig = {
      ...config,
      queue: config.signal_queue,
      log_path: config.signal_log_path ?? "./logs/signal-agent.log",
    };
    const account = config.signal_account;
    const sender: Sender = (to, body) => signalCliSend({ account, to, body });
    return await runAgent({ config: signalConfig, sender });
  }

  process.stderr.write(`unknown command: ${cmd}\n`);
  printHelp();
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${msg}\n`);
    process.exit(1);
  },
);
