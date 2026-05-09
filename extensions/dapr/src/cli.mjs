#!/usr/bin/env node
/**
 * imessage-bridge-dapr CLI — same shape as the main `imessage-bridge` binary.
 *
 * Usage:
 *   imessage-bridge-dapr send --to "+15555550100" --body "hello"
 *   imessage-bridge-dapr agent
 *   imessage-bridge-dapr --version
 *   imessage-bridge-dapr --help
 *
 * Reads ./config.json for shared options (signature). Extension-specific knobs
 * live in ./dapr-config.json or env vars (DAPR_*).
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import { loadConfig } from "../../../src/config.mjs";

import { sendMessage, DAPR_DEFAULTS } from "./producer.mjs";
import { runAgent } from "./agent.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(__dirname, "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

const HELP = `imessage-bridge-dapr — Dapr pubsub variant of imessage-bridge

usage:
  imessage-bridge-dapr <command> [options]

commands:
  send         publish one message to the configured Dapr topic
  agent        subscribe and dispatch to Messages.app via osascript
  help         show this message

send options:
  --to <E.164>     recipient phone (e.g. +15555550100) [required]
  --body <text>    message body                         [required]
  --config <path>  path to config.json (for signature)  (default: ./config.json)
  --topic <name>   topic override                       (default: ${DAPR_DEFAULTS.topic})
  --pubsub <name>  pubsub component name override       (default: ${DAPR_DEFAULTS.pubsubName})

agent options:
  --topic <name>   topic override                       (default: ${DAPR_DEFAULTS.topic})
  --pubsub <name>  pubsub component name override       (default: ${DAPR_DEFAULTS.pubsubName})

env:
  DAPR_HOST           sidecar host (default 127.0.0.1)
  DAPR_HTTP_PORT      sidecar HTTP port (default 3500)
  APP_HOST            agent server host (default 127.0.0.1)
  APP_PORT            agent server port (default 3000)
  IMSG_OSASCRIPT_MOCK 1 = skip real Messages.app calls (for tests)

global options:
  --version, -v    print version and exit
  --help, -h       show this message

examples:
  # one-time setup:
  cd extensions/dapr && npm install
  docker compose up -d redis

  # in one shell, run the agent under the Dapr sidecar:
  dapr run --resources-path ./components -- node src/cli.mjs agent

  # in another shell, send a message:
  node src/cli.mjs send --to "+15555550100" --body "hi from dapr 🐩"

docs: https://github.com/paulyuk/imessage-bridge/tree/main/extensions/dapr
`;

function loadDaprConfig() {
  const path = join(process.cwd(), "dapr-config.json");
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`dapr-config.json is not valid JSON: ${e.message}`);
  }
}

function maybeLoadSignature(cfgPath) {
  // signature is the only main-config field we need. Tolerate missing
  // config.json so users can run send/agent without setting up Service Bus.
  try {
    return loadConfig(cfgPath).signature;
  } catch {
    return undefined;
  }
}

async function cmdSend(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      to: { type: "string" },
      body: { type: "string" },
      config: { type: "string" },
      topic: { type: "string" },
      pubsub: { type: "string" },
    },
    strict: true,
  });
  if (!values.to || !values.body) {
    console.error("error: --to and --body are required\n\n" + HELP);
    process.exit(2);
  }
  const dcfg = loadDaprConfig();
  const signature = maybeLoadSignature(values.config);
  const id = await sendMessage({
    to: values.to,
    body: values.body,
    signature,
    topic: values.topic ?? dcfg.topic,
    pubsubName: values.pubsub ?? dcfg.pubsub_name,
    daprHost: dcfg.dapr_host,
    daprPort: dcfg.dapr_port ? String(dcfg.dapr_port) : undefined,
  });
  console.log(`published ${id} -> ${values.to}`);
}

async function cmdAgent(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      topic: { type: "string" },
      pubsub: { type: "string" },
      "log-path": { type: "string" },
    },
    strict: true,
  });
  const dcfg = loadDaprConfig();
  const code = await runAgent({
    topic: values.topic ?? dcfg.topic,
    pubsubName: values.pubsub ?? dcfg.pubsub_name,
    appHost: dcfg.app_host,
    appPort: dcfg.app_port ? String(dcfg.app_port) : undefined,
    daprHost: dcfg.dapr_host,
    daprPort: dcfg.dapr_port ? String(dcfg.dapr_port) : undefined,
    logPath: values["log-path"] ?? dcfg.log_path,
  });
  process.exit(code);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help" || argv[0] === "help") {
    console.log(HELP);
    return;
  }
  if (argv[0] === "-v" || argv[0] === "--version") {
    console.log(pkg.version);
    return;
  }
  const [sub, ...rest] = argv;
  switch (sub) {
    case "send":
      await cmdSend(rest);
      break;
    case "agent":
      await cmdAgent(rest);
      break;
    default:
      console.error(`unknown command: ${sub}\n\n` + HELP);
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(`✗ ${err.message ?? err}`);
  process.exit(1);
});
