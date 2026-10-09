#!/usr/bin/env python3
"""Supervised QSYN binary publication smoke test.

Simulates Cloudways Supervisor environment, never starts a public listener,
and proves that a newly published inode triggers only the QSYN service's
unexpected-exit handoff. No real Supervisor or Cloudways action is invoked.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
SOURCE_BINARY = Path(
    os.environ.get("QSYN_RUST_BINARY", str(ROOT / "target/debug/qsyn-stream"))
).resolve()


def port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def healthy(port_number: int) -> dict:
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        try:
            with urlopen(f"http://127.0.0.1:{port_number}/health", timeout=1) as response:
                return json.load(response)
        except (OSError, ValueError):
            time.sleep(0.1)
    raise AssertionError("Rust health unavailable")


def start(binary: Path, runtime: Path, port_number: int, supervisor: bool, program: str = "qsyn-stream") -> subprocess.Popen:
    env = os.environ.copy()
    env["QSYN_BIND"] = f"127.0.0.1:{port_number}"
    env["QSYN_RUNTIME_DIR"] = str(runtime)
    env["QSYN_ENABLE_DEMO_WS"] = "1"
    env.pop("SUPERVISOR_ENABLED", None)
    env.pop("SUPERVISOR_PROCESS_NAME", None)
    if supervisor:
        env["SUPERVISOR_ENABLED"] = "1"
        env["SUPERVISOR_PROCESS_NAME"] = program
    return subprocess.Popen(
        [str(binary)], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )


def publish_another_inode(binary: Path) -> None:
    temporary = binary.with_name(binary.name + ".publish")
    shutil.copy2(binary, temporary)
    os.replace(temporary, binary)


def stop(process: subprocess.Popen) -> None:
    if process.poll() is None:
        process.terminate()
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=3)


def run() -> None:
    if not SOURCE_BINARY.is_file():
        raise AssertionError(f"Missing Rust binary {SOURCE_BINARY}")
    with tempfile.TemporaryDirectory(prefix="qsyn-binary-activation-") as folder:
        runtime = Path(folder) / "runtime"
        runtime.mkdir()
        binary = Path(folder) / "qsyn-stream"
        shutil.copy2(SOURCE_BINARY, binary)
        binary.chmod(0o750)
        bind_port = port()

        # No Supervisor: publication must not stop a foreground Rust service.
        foreground = start(binary, runtime, bind_port, supervisor=False)
        try:
            before = healthy(bind_port)
            assert before["auto_activation"] is False
            publish_another_inode(binary)
            time.sleep(6)
            assert foreground.poll() is None, "Foreground service stopped unexpectedly"
            assert healthy(bind_port)["status"] == "ok"
            print("PASS: non-Supervisor service ignores binary replacement")
        finally:
            stop(foreground)

        # A process with Supervisor markers belonging to a different service
        # must never perform a QSYN-owned restart, even after publication.
        foreign = start(binary, runtime, bind_port, supervisor=True, program="qnext")
        try:
            assert healthy(bind_port)["auto_activation"] is False
            publish_another_inode(binary)
            time.sleep(6)
            assert foreign.poll() is None, "Mismatched Supervisor program was stopped"
            assert healthy(bind_port)["status"] == "ok"
            print("PASS: mismatched Supervisor process ignores QSYN binary replacement")
        finally:
            stop(foreign)

        # Exact Supervisor program: the old inode exits with code 75 after
        # the new inode appears at the executable path.
        supervised = start(binary, runtime, bind_port, supervisor=True)
        try:
            before = healthy(bind_port)
            assert before["auto_activation"] is True
            assert before["runtime_version"] == "0.1.0"
            assert before["runtime_commit"] == os.environ.get("QSYN_SOURCE_SHA", "development")
            assert before["demo_ws_enabled"] is True
            publish_another_inode(binary)
            exit_code = supervised.wait(timeout=16)
            assert exit_code == 75, f"Expected Supervisor restart handoff (75), got {exit_code}"
            print("PASS: named Supervisor service exits 75 after atomic binary publication")
        finally:
            stop(supervised)

        # Simulate Supervisor autorestart=unexpected; a new binary must bind
        # the original localhost port and serve health plus the demo flag.
        relaunched = start(binary, runtime, bind_port, supervisor=True)
        try:
            after = healthy(bind_port)
            assert after["auto_activation"] is True
            assert after["status"] == "ok"
            assert after["demo_ws_enabled"] is True
            assert isinstance(after["uptime_seconds"], int)
            print("PASS: relaunched binary serves health and simulated WebSocket setting")
        finally:
            stop(relaunched)


if __name__ == "__main__":
    run()
