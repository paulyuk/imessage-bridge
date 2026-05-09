/**
 * Producer — enqueue an iMessage job onto Azure Service Bus over AMQP 1.0.
 * Auth: OAuth via DefaultAzureCredential. Identity-only, no SAS, no PATs.
 */

import { randomUUID } from "node:crypto";
import { DefaultAzureCredential } from "@azure/identity";
import type { TokenCredential } from "@azure/identity";
import { ServiceBusClient } from "@azure/service-bus";

import type { BridgeConfig } from "./config.js";

export type Payload = {
  id: string;
  to: string;
  body: string;
  ts: string;
};

export type BuildPayloadArgs = {
  to: string;
  body: string;
  signature?: string;
  now?: () => Date;
};

export function buildPayload(args: BuildPayloadArgs): Payload {
  const sig = (args.signature ?? "").trim();
  let finalBody = args.body;
  if (sig && !finalBody.trim().endsWith(sig)) {
    finalBody = finalBody.replace(/\s+$/, "") + " " + sig;
  }
  const clock = args.now ?? (() => new Date());
  return {
    id: randomUUID(),
    to: args.to,
    body: finalBody,
    ts: clock().toISOString(),
  };
}

export type ClientFactory = (fqdn: string, cred: TokenCredential) => ServiceBusClient;

export type SendMessageArgs = {
  config: BridgeConfig;
  to: string;
  body: string;
  credential?: TokenCredential;
  clientFactory?: ClientFactory;
};

export async function sendMessage(opts: SendMessageArgs): Promise<string> {
  const { config, to, body, credential, clientFactory } = opts;

  if (!to) throw new Error("--to is required (E.164, e.g. +14255551234)");
  if (!body) throw new Error("--body is required");
  if (!/^\+\d{6,16}$/.test(to)) {
    throw new Error(`--to must be E.164 (e.g. +14255551234), got: ${to}`);
  }

  const payload = buildPayload({ to, body, signature: config.signature });
  const cred: TokenCredential = credential ?? new DefaultAzureCredential();
  const make: ClientFactory = clientFactory ?? ((fqdn, c) => new ServiceBusClient(fqdn, c));
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
