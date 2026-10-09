#!/usr/bin/env python3
"""Local-only black-box smoke checks for the QSYN Rust executable.

No third-party modules, broker credentials, live feeds or public ports.
Build first: cargo build --manifest-path services/stream-rust/Cargo.toml
Run: python3 services/stream-rust/tests/smoke_service.py
"""
from __future__ import annotations

import base64
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import time
from urllib.error import HTTPError, URLError
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
BINARY = Path(os.environ.get("QSYN_RUST_BINARY", str(ROOT / "target/debug/qsyn-stream"))).resolve()


def unused_local_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def http_status(url: str) -> tuple[int, bytes]:
    try:
        with urlopen(url, timeout=2) as response:
            return response.status, response.read()
    except HTTPError as exc:
        return exc.code, exc.read()


def await_health(port: int, process: subprocess.Popen) -> dict:
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise AssertionError(f"Rust process exited unexpectedly: {process.returncode}")
        try:
            status, payload = http_status(f"http://127.0.0.1:{port}/health")
            assert status == 200, status
            return json.loads(payload)
        except (OSError, ValueError, URLError):
            time.sleep(0.1)
    raise AssertionError("Rust health endpoint did not become available")


def open_websocket(port: int) -> tuple[socket.socket, object, int]:
    sock = socket.create_connection(("127.0.0.1", port), timeout=5)
    sock.settimeout(5)
    key = base64.b64encode(secrets.token_bytes(16)).decode("ascii")
    request = (
        "GET /ws/demo HTTP/1.1\r\n"
        f"Host: 127.0.0.1:{port}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        "\r\n"
    )
    sock.sendall(request.encode("ascii"))
    reader = sock.makefile("rb")
    status_line = reader.readline().decode("ascii").strip()
    while True:
        line = reader.readline()
        if line in (b"\r\n", b"\n", b""):
            break
    status = int(status_line.split()[1])
    return sock, reader, status


def exact_read(reader: object, n: int) -> bytes:
    result = reader.read(n)
    assert result is not None and len(result) == n, "WebSocket frame truncated"
    return result


def read_server_message(reader: object) -> dict:
    header = exact_read(reader, 2)
    opcode = header[0] & 0x0F
    assert opcode == 1, f"Expected a text frame, got opcode {opcode}"
    assert (header[1] & 0x80) == 0, "Server-to-client frame must not be masked"
    length = header[1] & 0x7F
    if length == 126:
        length = int.from_bytes(exact_read(reader, 2), "big")
    elif length == 127:
        length = int.from_bytes(exact_read(reader, 8), "big")
    assert length < 16_384, "Unexpectedly large demo event"
    return json.loads(exact_read(reader, length))


def run_instance(enable_demo: bool) -> None:
    port = unused_local_port()
    env = os.environ.copy()
    env["QSYN_BIND"] = f"127.0.0.1:{port}"
    if enable_demo:
        env["QSYN_ENABLE_DEMO_WS"] = "1"
    else:
        env.pop("QSYN_ENABLE_DEMO_WS", None)

    # Rust must never be exposed publicly by this smoke test.
    process = subprocess.Popen([str(BINARY)], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        health = await_health(port, process)
        assert health == {
            "status": "ok",
            "component": "qsyn-stream",
            "mode": "foundation",
            "upstox_connected": False,
            "trading_enabled": False,
        }, f"Unexpected Rust health response: {health}"

        assert http_status(f"http://127.0.0.1:{port}/unknown")[0] == 404
        sock, reader, status = open_websocket(port)
        try:
            if not enable_demo:
                assert status == 404, f"Demo WS should be disabled by default, got {status}"
                print("PASS: /health responds, trading disabled, demo WebSocket denied by default")
                return
            assert status == 101, f"Expected WebSocket 101 upgrade, got {status}"
            first, second = read_server_message(reader), read_server_message(reader)
            for tick in (first, second):
                assert tick["type"] == "demo_quote"
                assert tick["symbol"] == "QSYN-DEMO"
                assert tick["source"] == "simulated"
                assert isinstance(tick["price"], float) and tick["price"] > 0
                assert abs(time.time() - tick["timestamp"]) < 30, tick["timestamp"]
            assert first["price"] != second["price"], "Price must update between messages"
            print("PASS: WebSocket HTTP 101 upgrade and two correctly labeled simulated quotes")
        finally:
            reader.close()
            sock.close()
    finally:
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=3)
        if process.stderr:
            process.stderr.close()


if __name__ == "__main__":
    if not BINARY.is_file():
        raise SystemExit(f"Missing Rust executable: {BINARY}. Run cargo build first.")
    run_instance(enable_demo=False)
    run_instance(enable_demo=True)
    print("PASS: QSYN Rust executable smoke tests complete")
