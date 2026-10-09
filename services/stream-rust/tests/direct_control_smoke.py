#!/usr/bin/env python3
"""Verify qsyn-stream direct lifecycle without Supervisor or a shell.
Run ONLY on a disposable local port and temporary private state directory.
"""
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
BINARY = Path(os.environ.get("QSYN_RUST_BINARY", str(ROOT / "target/debug/qsyn-stream"))).resolve()


def free_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def invoke(env, action):
    result = subprocess.run(
        [str(BINARY), "ctl", action],
        check=False, capture_output=True, text=True, env=env, timeout=12,
    )
    payload = json.loads(result.stdout.strip())
    assert (result.returncode == 0) == payload["ok"], (action, result.returncode, payload)
    return payload


def expect_health(port):
    with urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as response:
        payload = json.load(response)
    assert payload["status"] == "ok", payload
    assert payload["component"] == "qsyn-stream", payload


def main():
    assert BINARY.is_file(), f"Build binary first: {BINARY}"
    with tempfile.TemporaryDirectory(prefix="qsyn-rust-direct-") as private:
        port = free_port()
        env = os.environ.copy()
        env["QSYN_BIND"] = f"127.0.0.1:{port}"
        env["QSYN_RUNTIME_DIR"] = private
        env.pop("QSYN_ENABLE_DEMO_WS", None)
        try:
            assert invoke(env, "status")["state"] == "stopped"
            assert invoke(env, "stop")["state"] == "already_stopped"
            assert invoke(env, "start")["state"] == "running"
            expect_health(port)
            assert invoke(env, "status")["state"] == "running"
            assert invoke(env, "start")["state"] == "already_running"
            assert invoke(env, "restart")["state"] == "running"
            expect_health(port)
            assert invoke(env, "stop")["state"] in ("stopped", "already_stopped")
            assert invoke(env, "status")["state"] == "stopped"
            error = subprocess.run(
                [str(BINARY), "ctl", "kill-all"], check=False,
                capture_output=True, text=True, env=env, timeout=3,
            )
            assert error.returncode != 0
            assert json.loads(error.stdout)["error"] == "invalid_action"
            print("PASS: Rust direct control start/status/idempotent/restart/stop and strict CLI actions")
        finally:
            try:
                invoke(env, "stop")
            except (OSError, ValueError, AssertionError, subprocess.TimeoutExpired):
                pass


if __name__ == "__main__":
    main()
