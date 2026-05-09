/**
 * Producer — enqueue an iMessage job onto Azure Service Bus over AMQP 1.0.
 *
 * Auth: OAuth via DefaultAzureCredential (run `az login` once).
 * Mirrors producer/cli.py. Identity-only — no SAS, no PATs, no client secrets.
 */

import { randomUUID } from "node:crypto";
import { DefaultAzureCredential } from "@azure/identity";
import { ServiceBusClient } from "@azure/service-bus";

/**
 * @typedef {import("./config.mjs").BridgeConfig} BridgeConfig
 */

/**
 * Build the JSON payload for a send. Pure — exported for tests.
 *
 * @param {{to: string, body: string, signature?: string, now?: () => Date}} args
 * @returns {{id: string, to: string, body: string, ts: string}}
 */
export function buildPayload({ to, body, signature, now }) {
  const sig = (signature ?? "").trim();
  let finalBody = body;
  if (sig && !finalBody.trim().endsWith(sig)) {
    finalBody = finalBody.replace(/\s+$/, "") + " " + sig;
  }
  const clock = now ?? (() => new Date());
  return {
    id: randomUUID(),
    to,
    body: finalBody,
    ts: clock().toISOString(),
  };
}

/**
 * Send one message. Returns the message_id printed by the CLI.
 *
 * @param {{
 *   config: BridgeConfig,
 *   to: string,
 *   body: string,
 *   credential?: import("@azure/identity").TokenCredential,
 *   clientFactory?: (fqdn: string, cred: any) => ServiceBusClient,
 * }} opts
 * @returns {Promise<string>}  the message_id
 */
export async function sendMessage({ config, to, body, credential, clientFactory }) {
  if (!to) throw new Error("--to is required (E.164, e.g. +14255551234)");
  if (!body) throw new Error("--body is required");
  if (!/^\+\d{6,16}$/.test(to)) {
    throw new Error(`--to must be E.164 (e.g. +14255551234), got: ${to}`);
  }

  const payload = buildPayload({ to, body, signature: config.signature });
  const cred = credential ?? new DefaultAzureCredential();
  const make = clientFactory ?? ((fqdn, c) => new ServiceBusClient(fqdn, c));
  const client = make(config.namespace_fqdn, cred);

  try {
    const sender = client.createSender(config.queue);
    try {
      await sender.sendMessages({
        body: JSON.stringify(payload),
        messageId: payload.id,
        contentType: "application/json",
      });
    } finally {
      await sender.close();
    }
  } finally {
    await client.close();
  }

  return payload.id;
}
