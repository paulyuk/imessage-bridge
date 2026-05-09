#!/usr/bin/env python3
"""Mac agent — long-poll Azure Service Bus and send via Messages.app.

Improvements in this version:
- Robust AMQP reconnect and credential refresh (recreate client on error)
- Exponential backoff with jitter on reconnect attempts
- Offload osascript sends to a short-lived worker thread and keep send/ack resolution in main thread
- Better logging and a simple health alert when repeated disconnects occur (optional http endpoint)

Auth: OAuth via DefaultAzureCredential (run `az login` once on the Mac).
Run with: uv run mac/agent.py
"""
import json
import logging
import os
import subprocess
import sys
import time
import threading
import queue
import random
from pathlib import Path
from typing import Dict, Any

from azure.identity import DefaultAzureCredential
from azure.servicebus import ServiceBusClient

# Optional: some SDKs raise these; we'll catch broadly and inspect when needed.
from azure.servicebus.exceptions import ServiceBusConnectionError, ServiceBusError

CFG_PATH = os.environ.get("IMSG_CONFIG", "config.json")
if not Path(CFG_PATH).exists():
    print(f"config not found: {CFG_PATH}", file=sys.stderr)
    sys.exit(2)

cfg = json.load(open(CFG_PATH))
FQDN = cfg["namespace_fqdn"]
QUEUE = cfg["queue"]
POLL = int(cfg.get("poll_interval_s", 3))
LOG_PATH = cfg.get("log_path", "./logs/agent.log")
HEALTH_ENDPOINT = cfg.get("health_endpoint")  # optional; POST when repeated disconnects

Path(LOG_PATH).parent.mkdir(parents=True, exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[logging.FileHandler(LOG_PATH), logging.StreamHandler()],
)
log = logging.getLogger("imsg-agent")

# Queues for offloading sends and returning results to main thread
send_queue: "queue.Queue[Dict[str, Any]]" = queue.Queue()
result_queue: "queue.Queue[Dict[str, Any]]" = queue.Queue()

# Mapping of internal_id -> (receiver, message)
pending_messages: Dict[str, Any] = {}
pending_lock = threading.Lock()

# Simple health counters
disconnect_count = 0
DISCONNECT_ALERT_THRESHOLD = int(cfg.get("disconnect_alert_threshold", 3))


def _osascript_send(to: str, body: str) -> bool:
    safe = body.replace("\\", "\\\\").replace('"', '\\"')
    script = (
        'tell application "Messages"\n'
        '  set targetService to 1st service whose service type = iMessage\n'
        f'  set theBuddy to buddy "{to}" of targetService\n'
        f'  send "{safe}" to theBuddy\n'
        "end tell"
    )
    try:
        # Keep capture_output to log detailed failures if they occur.
        subprocess.run(["osascript", "-e", script], check=True, capture_output=True, timeout=30)
        return True
    except subprocess.CalledProcessError as e:
        log.error("osascript failed for %s: %s", to, e.stderr.decode("utf-8", errors="replace"))
        return False
    except subprocess.TimeoutExpired:
        log.error("osascript timed out for %s", to)
        return False
    except Exception as e:
        log.exception("unexpected error running osascript for %s: %s", to, e)
        return False


def sender_worker():
    """Worker thread: take send jobs, run osascript, report results to result_queue."""
    while True:
        job = send_queue.get()
        if job is None:
            break
        internal_id = job["internal_id"]
        to = job["to"]
        body = job["body"]
        msg_id = job.get("msg_id", "?")

        success = _osascript_send(to, body)
        result_queue.put({"internal_id": internal_id, "success": success, "msg_id": msg_id})
        send_queue.task_done()


def post_health_alert(reason: str, details: str = ""):
    """If HEALTH_ENDPOINT is configured, POST a small alert JSON. Non-fatal if requests is missing."""
    if not HEALTH_ENDPOINT:
        return
    try:
        import requests

        payload = {"service": "imessage-mac-agent", "reason": reason, "details": details}
        requests.post(HEALTH_ENDPOINT, json=payload, timeout=5)
    except Exception as e:
        log.warning("failed to post health alert: %s", e)


def exponential_backoff(attempt: int, base: float = 1.0, cap: float = 60.0) -> float:
    """Compute exponential backoff with jitter."""
    exp = min(cap, base * (2 ** attempt))
    jitter = random.uniform(0, exp * 0.2)
    wait = exp + jitter
    return min(wait, cap)


def main() -> int:
    global disconnect_count

    log.info("starting agent — fqdn=%s queue=%s", FQDN, QUEUE)

    # Start a small sender worker thread. This keeps osascript off the receiver loop.
    worker = threading.Thread(target=sender_worker, daemon=True)
    worker.start()

    reconnect_attempt = 0
    while True:
        try:
            credential = DefaultAzureCredential()
            log.info("creating ServiceBusClient (attempt=%d)", reconnect_attempt)
            with ServiceBusClient(fully_qualified_namespace=FQDN, credential=credential) as client:
                reconnect_attempt = 0
                # Receiver context
                with client.get_queue_receiver(queue_name=QUEUE, max_wait_time=10) as receiver:
                    log.info("connected to service bus, listening...")
                    while True:
                        # First, handle any completed send results from worker(s)
                        try:
                            while True:
                                res = result_queue.get_nowait()
                                internal_id = res["internal_id"]
                                success = res["success"]
                                msg_id = res.get("msg_id", "?")
                                with pending_lock:
                                    entry = pending_messages.pop(internal_id, None)
                                if entry is None:
                                    log.warning("no pending message for %s", internal_id)
                                    continue
                                m = entry["message"]
                                # All SDK calls that mutate message state happen in main thread.
                                try:
                                    if success:
                                        receiver.complete_message(m)
                                        log.info("sent (async) %s", msg_id)
                                    else:
                                        receiver.abandon_message(m)
                                        log.warning("abandoned (async) %s for retry", msg_id)
                                except Exception as e:
                                    log.exception("failed to settle message %s: %s", msg_id, e)
                                result_queue.task_done()
                        except queue.Empty:
                            pass

                        try:
                            msgs = receiver.receive_messages(max_message_count=5, max_wait_time=10)
                        except ServiceBusConnectionError as e:
                            # Connection-level error: break to outer reconnect loop
                            log.exception("service bus connection error, will reconnect: %s", e)
                            raise
                        except Exception as e:
                            log.exception("unexpected receive error: %s", e)
                            # Treat as transient: break to recreate client
                            raise

                        if not msgs:
                            time.sleep(POLL)
                            continue

                        for m in msgs:
                            try:
                                payload = json.loads(b"".join(m.body).decode("utf-8"))
                            except Exception as e:
                                log.error("bad payload, dead-lettering: %s", e)
                                try:
                                    receiver.dead_letter_message(m, reason="bad-payload")
                                except Exception:
                                    log.exception("failed to dead-letter message")
                                continue

                            to = payload.get("to")
                            body = payload.get("body")
                            msg_id = payload.get("id", "?")

                            if not to or not body:
                                log.error("missing to/body in %s, dead-lettering", msg_id)
                                try:
                                    receiver.dead_letter_message(m, reason="missing-fields")
                                except Exception:
                                    log.exception("failed to dead-letter message")
                                continue

                            # Enqueue send job and track pending message
                            internal_id = f"{time.time()}-{random.randint(0,9999)}"
                            job = {"internal_id": internal_id, "to": to, "body": body, "msg_id": msg_id}
                            with pending_lock:
                                pending_messages[internal_id] = {"message": m, "enqueued_at": time.time()}
                            send_queue.put(job)
                            log.info("scheduled send %s -> %s (id=%s)", msg_id, to, internal_id)

        except KeyboardInterrupt:
            log.info("agent stopped by user")
            break
        except Exception as e:
            # Any exception here is treated as a broken connection: increment disconnect counter and backoff
            disconnect_count += 1
            log.exception("agent encountered error, will attempt reconnect: %s", e)
            if disconnect_count >= DISCONNECT_ALERT_THRESHOLD:
                log.warning("disconnect_count=%d exceeds threshold %d — posting health alert", disconnect_count, DISCONNECT_ALERT_THRESHOLD)
                post_health_alert("repeated-disconnects", details=f"count={disconnect_count}")
            wait = exponential_backoff(reconnect_attempt)
            log.info("waiting %.1fs before reconnect (attempt=%d)", wait, reconnect_attempt)
            time.sleep(wait)
            reconnect_attempt += 1
            continue

    # Clean up worker thread
    send_queue.put(None)
    worker.join(timeout=2)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        log.info("agent stopped")
        sys.exit(0)
