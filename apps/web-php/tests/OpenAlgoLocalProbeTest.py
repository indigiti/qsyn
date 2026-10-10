#!/usr/bin/env python3
"""Local fake-OpenAlgo contract test: no real broker credentials or network."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[3]
CLI = ROOT / "apps/web-php/tools/openalgo-local-probe.php"
PRIVATE_KEY = "test-only-qsyn-provider-key-12345678"


class FakeOpenAlgo(BaseHTTPRequestHandler):
    def do_POST(self):
        raw = self.rfile.read(min(8192, int(self.headers.get("Content-Length", "0"))))
        try:
            received = json.loads(raw)
        except Exception:
            received = {}
        if received.get("apikey") != PRIVATE_KEY:
            return self.reply(403, {"status": "error"})
        if self.path == "/api/v1/quotes":
            return self.reply(200, {
                "status": "success",
                "data": {"ltp": 215.4, "api_secret": PRIVATE_KEY, "untrusted": "<script>"},
            })
        if self.path == "/api/v1/optionchain":
            return self.reply(200, {
                "status": "success", "underlying_ltp": 24492.55, "chain": [{
                    "strike": 24500, "ce": {
                        "symbol": "NIFTY29OCT2624500CE", "ltp": 120.5, "lotsize": 65,
                        "broker_login": PRIVATE_KEY,
                    },
                    "pe": {"symbol": "NIFTY29OCT2624500PE",
                           "ltp": 142.2, "lotsize": 65},
                }],
            })
        return self.reply(404, {"status": "error"})

    def reply(self, status, result):
        body = json.dumps(result).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


def invoke(keypath, port, *args, enabled="1"):
    env = os.environ.copy()
    env["QSYN_MARKETDATA_PROBE_ENABLED"] = enabled
    env["QSYN_TRADING_ENABLED"] = "0"
    env["QSYN_OPENALGO_APIKEY_FILE"] = str(keypath)
    env["QSYN_OPENALGO_LOOPBACK_PORT"] = str(port)
    return subprocess.run(
        ["php", str(CLI), *args], cwd=ROOT, env=env,
        text=True, capture_output=True, timeout=15,
    )


def run():
    with tempfile.TemporaryDirectory(prefix="qsyn-provider-contract-") as tmp:
        private = Path(tmp) / "private"
        private.mkdir(mode=0o700)
        key = private / "openalgo-key.txt"
        key.write_text(PRIVATE_KEY + "\n", encoding="ascii")
        key.chmod(0o600)
        server = ThreadingHTTPServer(("127.0.0.1", 0), FakeOpenAlgo)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            port = server.server_port
            q = invoke(key, port, "quote", "NIFTY29OCT2624500CE", "NFO")
            assert q.returncode == 0, q.stderr
            data = json.loads(q.stdout)
            assert data["ltp"] == 215.4
            assert data["provider"] == "openalgo"
            assert data["source"] == "operator_loopback_probe"
            assert data["publishable_to_public_studio"] is False
            assert data["freshness_verified"] is False
            assert data["exchange_timestamp"] is None
            assert "apikey" not in q.stdout and PRIVATE_KEY not in q.stdout
            assert "<script>" not in q.stdout
            c = invoke(key, port, "chain", "NIFTY", "29OCT26")
            assert c.returncode == 0, c.stderr
            chain = json.loads(c.stdout)
            assert chain["chain"][0]["strike"] == 24500
            assert chain["chain"][0]["ce"]["lotsize"] == 65
            assert "broker_login" not in c.stdout and PRIVATE_KEY not in c.stdout
            assert chain["trading_enabled"] is False
            assert chain["publishable_to_public_studio"] is False

            for test in (
                invoke(key, port, "quote", "NIFTY29OCT2624500CE", "NFO", enabled="0"),
                invoke(key, port, "quote", "../etc/passwd", "NFO"),
                invoke(key, port, "quote", "NIFTY29OCT2624500CE", "MCX"),
                invoke(key, port, "chain", "NIFTY", "INVALID"),
                invoke(key, port, "chain", "SPX", "29OCT26"),
            ):
                assert test.returncode != 0 and not test.stdout, (test.stdout, test.stderr)
                assert PRIVATE_KEY not in test.stderr

            key.chmod(0o644)
            denied = invoke(key, port, "quote", "NIFTY29OCT2624500CE", "NFO")
            assert denied.returncode != 0 and not denied.stdout
            key.chmod(0o600)
            good = invoke(key, port, "quote", "NIFTY29OCT2624500CE", "NFO")
            assert good.returncode == 0

            # API probes have no side effects on the QSYN trading flag.
            assert json.loads(good.stdout)["trading_enabled"] is False
            print("PASS: OpenAlgo loopback-only sanitized quote/chain; opt-in, owner-only key, no broker leakage")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


if __name__ == "__main__":
    run()
