"""Tests for mac.agent — covers payload parsing & osascript dispatch.

Run with: uv run pytest
"""
import json
import os
import subprocess
from unittest.mock import MagicMock, patch

import pytest


@pytest.fixture
def agent_module(tmp_path, monkeypatch):
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
    monkeypatch.setenv("IMSG_CONFIG", str(p))
    # ensure fresh import picks up env var
    import importlib
    import mac.agent as agent
    importlib.reload(agent)
    return agent


def test__osascript_send_success(agent_module):
    with patch("subprocess.run") as run:
        run.return_value = MagicMock(returncode=0)
        ok = agent_module._osascript_send("+14255551234", "hello")
        assert ok is True
        run.assert_called_once()
        assert run.call_args.args[0][0] == "osascript"


def test__osascript_send_failure(agent_module):
    with patch("subprocess.run") as run:
        run.side_effect = subprocess.CalledProcessError(1, "osascript", stderr=b"buddy not found")
        ok = agent_module._osascript_send("+14255550000", "hello")
        assert ok is False


def test__osascript_send_escapes_quotes(agent_module):
    with patch("subprocess.run") as run:
        run.return_value = MagicMock(returncode=0)
        agent_module._osascript_send("+14255551234", 'she said "hi"')
        script = run.call_args.args[0][2]
        assert '\\"hi\\"' in script
