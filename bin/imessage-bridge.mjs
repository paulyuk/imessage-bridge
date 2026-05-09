#!/usr/bin/env node
/**
 * imessage-bridge CLI — single binary, multiple subcommands.
 *
 * Usage:
 *   imessage-bridge send --to "+15555550100" --body "hello"
 *   imessage-bridge doctor
 *   imessage-bridge --version
 *   imessage-bridge --help
 *
 * Run via `npx imessage-bridge ...` once published, or
 * `npx github:paulyuk/imessage-bridge ...` directly from GitHub.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

import { loadConfig } from "../src/config.mjs";
import { sendMessage } from "../src/producer.mjs";
import { runAgent } from "../src/agent.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(__dirname, "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

const HELP = `imessage-bridge — send iMessages from anywhere over AMQP 1.0

usage:
  imessage-bridge <command> [options]

commands:
  send         enqueue one message onto the broker
  agent        run the Mac receiver loop (long-poll → Messages.app)
  doctor       run the bridge health check (delegates to bin/doctor.sh)
  help         show this message

send options:
  --to <E.164>     recipient phone (e.g. +15555550100) [required]
  --body <text>    message body                         [required]
  --config <path>  path to config.json (default: ./config.json or $IMSG_CONFIG)

agent options:
  --config <path>  path to config.json (default: ./config.json or $IMSG_CONFIG)

global options:
  --version, -v    print version and exit
  --help, -h       show this message

examples:
  imessage-bridge send --to "+15555550100" --body "hi from the bridge 🐩"
  imessage-bridge agent           # run forever; ctrl-C to stop
  imessage-bridge doctor

  IMSG_CONFIG=~/.config/imessage-bridge.json imessage-bridge send --to "+1..." --body "..."
  IMSG_DEBUG=1 imessage-bridge agent     # extra-verbose logging

docs: https://github.com/paulyuk/imessage-bridge
`;

async function cmdSend(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      to: { type: "string" },
      body: { type: "string" },
      config: { type: "string" },
    },
    strict: true,
  });
  if (!values.to || !values.body) {
    console.error("error: --to and --body are required\n\n" + HELP);
    process.exit(2);
  }
  const config = loadConfig(values.config);
  const id = await sendMessage({ config, to: values.to, body: values.body });
  console.log(`enqueued ${id} -> ${values.to}`);
}

function cmdDoctor() {
  const repoRoot = join(__dirname, "..");
  const doctor = join(repoRoot, "bin", "doctor.sh");
  const res = spawnSync(doctor, [], { stdio: "inherit", cwd: repoRoot });
  process.exit(res.status ?? 1);
}

async function cmdAgent(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: "string" },
    },
    strict: true,
  });
  const config = loadConfig(values.config);
  const code = await runAgent({ config });
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
    case "doctor":
      cmdDoctor();
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
