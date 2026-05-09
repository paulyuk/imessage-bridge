"""Producer — enqueue an iMessage job onto Azure Service Bus.

Auth: OAuth via DefaultAzureCredential (run `az login` once).
Usage: uv run producer/cli.py --to "+1425..." --body "Hello"
"""
import argparse
import json
import sys
import uuid
from datetime import datetime, timezone

from azure.identity import DefaultAzureCredential
from azure.servicebus import ServiceBusClient, ServiceBusMessage


def main() -> int:
    parser = argparse.ArgumentParser(description="Enqueue an iMessage job.")
    parser.add_argument("--to", required=True, help="Recipient (E.164, e.g. +14255551234)")
    parser.add_argument("--body", required=True, help="Message body")
    parser.add_argument("--config", default="config.json")
    args = parser.parse_args()

    cfg = json.load(open(args.config))
    fqdn = cfg["namespace_fqdn"]
    queue = cfg["queue"]

    # Optional signature appended to outgoing messages (project mascot 🐩 by
    # default). Set "signature": "" in config.json to disable.
    sig = (cfg.get("signature") or "").strip()
    body = args.body
    if sig and not body.strip().endswith(sig):
        body = body.rstrip() + " " + sig

    payload = {
        "id": str(uuid.uuid4()),
        "to": args.to,
        "body": body,
        "ts": datetime.now(timezone.utc).isoformat(),
    }

    credential = DefaultAzureCredential()
    with ServiceBusClient(fully_qualified_namespace=fqdn, credential=credential) as client:
        with client.get_queue_sender(queue_name=queue) as sender:
            sender.send_messages(ServiceBusMessage(json.dumps(payload), message_id=payload["id"]))

    print(f"enqueued {payload['id']} -> {args.to}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
