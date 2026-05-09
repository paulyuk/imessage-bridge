"""Tests for producer.cli — uses mocked Service Bus client.

Run with: uv run pytest
"""
import json
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest


@pytest.fixture
def fake_config(tmp_path):
    cfg = {
        "namespace_fqdn": "test-ns.servicebus.windows.net",
        "queue": "test-queue",
        "model": "gpt-5.4-mini",
        "model_version": "latest",
        "poll_interval_s": 1,
        "log_path": str(tmp_path / "agent.log"),
    }
    p = tmp_path / "config.json"
    p.write_text(json.dumps(cfg))
    return p


def test_producer_enqueues_message(fake_config, monkeypatch, capsys):
    from producer import cli

    fake_sender = MagicMock()
    fake_client = MagicMock()
    fake_client.__enter__.return_value = fake_client
    fake_client.get_queue_sender.return_value.__enter__.return_value = fake_sender

    monkeypatch.setattr(cli, "ServiceBusClient", lambda **kw: fake_client)
    monkeypatch.setattr(cli, "DefaultAzureCredential", lambda: MagicMock())
    monkeypatch.setattr(
        sys, "argv",
        ["cli.py", "--to", "+14255551234", "--body", "hello", "--config", str(fake_config)],
    )

    rc = cli.main()
    assert rc == 0
    fake_sender.send_messages.assert_called_once()
    sent = fake_sender.send_messages.call_args[0][0]
    assert sent.message_id is not None

    out = capsys.readouterr().out
    assert "enqueued" in out
    assert "+14255551234" in out


def test_producer_appends_signature_when_configured(tmp_path, monkeypatch):
    cfg = {
        "namespace_fqdn": "test-ns.servicebus.windows.net",
        "queue": "test-queue",
        "signature": "🐩",
    }
    p = tmp_path / "config.json"
    p.write_text(json.dumps(cfg))

    from producer import cli

    fake_sender = MagicMock()
    fake_client = MagicMock()
    fake_client.__enter__.return_value = fake_client
    fake_client.get_queue_sender.return_value.__enter__.return_value = fake_sender

    monkeypatch.setattr(cli, "ServiceBusClient", lambda **kw: fake_client)
    monkeypatch.setattr(cli, "DefaultAzureCredential", lambda: MagicMock())
    monkeypatch.setattr(
        sys, "argv",
        ["cli.py", "--to", "+14255551234", "--body", "hello", "--config", str(p)],
    )

    cli.main()
    sent = fake_sender.send_messages.call_args[0][0]
    payload = json.loads(b"".join(sent.body).decode("utf-8"))
    assert payload["body"].endswith("🐩")
    assert payload["body"] == "hello 🐩"


def test_producer_requires_to_and_body(fake_config, monkeypatch):
    from producer import cli

    monkeypatch.setattr(sys, "argv", ["cli.py", "--config", str(fake_config)])
    with pytest.raises(SystemExit):
        cli.main()
