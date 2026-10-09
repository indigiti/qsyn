#!/usr/bin/env python3
"""Integration test: browser-facing PHP diagnostics -> real Rust executable.

Standard library only. Starts both services bound to loopback, never a public port.
"""
import json
import os
from pathlib import Path
import socket
import subprocess
import time
from urllib.error import URLError
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[3]
PHP_ROOT = ROOT / "apps/web-php"
RUST = Path(os.environ.get(
    "QSYN_RUST_BINARY", str(ROOT / "services/stream-rust/target/debug/qsyn-stream")
)).resolve()


def available_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def probe(port: int) -> dict:
    with urlopen(f"http://127.0.0.1:{port}/qsyn/api/v1/diagnostics/rust", timeout=3) as r:
        assert r.status == 200
        return json.load(r)


def until(port: int, expected: str, demo_ws: str | None = None) -> dict:
    end = time.monotonic() + 8
    latest = {}
    while time.monotonic() < end:
        try:
            latest = probe(port)
            if latest.get("status") == expected and (
                demo_ws is None or latest.get("websocket") == demo_ws
            ):
                return latest
        except (OSError, ValueError, URLError):
            pass
        time.sleep(.12)
    raise AssertionError(f"Expected {expected} and {demo_ws}, got {latest}")


def stop(p: subprocess.Popen) -> None:
    p.terminate()
    try:
        p.wait(timeout=3)
    except subprocess.TimeoutExpired:
        p.kill()
        p.wait(timeout=3)
    if p.stdout:
        p.stdout.close()
    if p.stderr:
        p.stderr.close()


if __name__ == "__main__":
    assert RUST.is_file(), f"Missing executable: {RUST}"
    php_port = available_port()
    php = subprocess.Popen(
        ["php", "-S", f"127.0.0.1:{php_port}", "-t", str(PHP_ROOT / "public"), str(PHP_ROOT / "dev-router.php")],
        cwd=ROOT,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        offline = until(php_port, "offline")
        assert offline["http"] == "unreachable"
        assert offline["websocket"] == "not_tested"
        print("PASS: browser diagnostics reports offline when Rust is not running")

        for demo_enabled, expected in [(False, "demo_disabled"), (True, "demo_enabled")]:
            env = os.environ.copy()
            env["QSYN_BIND"] = "127.0.0.1:1299"
            if demo_enabled:
                env["QSYN_ENABLE_DEMO_WS"] = "1"
            else:
                env.pop("QSYN_ENABLE_DEMO_WS", None)
            rust = subprocess.Popen([str(RUST)], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                actual = until(php_port, "online", expected)
                assert actual["service"] == "qsyn-stream"
                assert actual["http"] == "healthy"
                assert actual["trading_enabled"] is False
                assert actual["upstox_connected"] is False
                print(f"PASS: browser PHP to Rust reports online, WebSocket: {expected}")
            finally:
                stop(rust)
            until(php_port, "offline")

        print("PASS: browser-based Rust diagnostics fully validated")
    finally:
        stop(php)
