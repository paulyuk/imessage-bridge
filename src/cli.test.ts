import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const execFileAsync = promisify(execFile);

async function createConfig(contents: object): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "imessage-bridge-cli-"));
  const path = join(dir, "config.json");
  await writeFile(path, JSON.stringify(contents));
  return path;
}

async function runCli(...args: string[]) {
  return await execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args]);
}

test("signal-send: requires signal_queue", async () => {
  const config = await createConfig({
    namespace_fqdn: "test-ns.servicebus.windows.net",
    queue: "imsg-queue",
  });

  await assert.rejects(
    () => runCli("signal-send", "--config", config, "--to", "+15555550100", "--body", "hello"),
    (error: NodeJS.ErrnoException) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr ?? "", /config\.signal_queue is required/);
      return true;
    },
  );
});

test("signal-send: validates required message fields before connecting", async () => {
  const config = await createConfig({
    namespace_fqdn: "test-ns.servicebus.windows.net",
    queue: "imsg-queue",
    signal_queue: "signal-queue",
  });

  await assert.rejects(
    () => runCli("signal-send", "--config", config, "--to", "+15555550100"),
    (error: NodeJS.ErrnoException) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr ?? "", /signal-send requires --to <\+E164> and --body <text>/);
      return true;
    },
  );
});
