#!/usr/bin/env python3
"""Operator-only Upstox readiness contract with a fake local OpenAlgo; no real provider."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "apps/web-php/tools/openalgo-upstox-readiness.php"
KEY = "fake-app-key-for-qsyn-openalgo-readiness-0042"

class FakeHandler(BaseHTTPRequestHandler):
    response_broker = "upstox"
    succeed = True

    def do_POST(self):
        size = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(min(size, 1000)))
        ok = (self.path == "/api/v1/ping" and
              payload == {"apikey": KEY} and self.succeed)
        body = json.dumps(
            {"status": "success", "data": {
                "broker": self.response_broker, "message": "pong",
                "private_access_token": KEY,
            }} if ok else {"status": "error", "private_access_token": KEY}
        ).encode()
        self.send_response(200 if ok else 403)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass

def main():
    server = ThreadingHTTPServer(("127.0.0.1", 0), FakeHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix="qsyn-upstox-readiness-") as directory:
            root = Path(directory)
            root.chmod(0o700)
            key = root / "application-key"
            reg = root / "broker-registry.json"
            links = root / "login-urls.json"

            def write(path, value):
                path.write_text(value, encoding="utf-8")
                path.chmod(0o600)

            def config(broker="upstox"):
                return {"schema": "QSYN-PRIVATE-OPENALGO-REGISTRY/1",
                        "accounts": [{
                            "account_id": "upstox-a", "tenant_id": "tenant-a",
                            "owner_user_id": "owner-a", "broker": broker,
                            "rest_port": server.server_port,
                            "ws_port": 8765 if server.server_port != 8765 else 8766,
                            "openalgo_apikey_file": str(key),
                        }]}

            def mapping(url="https://openalgo.example.test/login"):
                return {"schema": "QSYN-OPENALGO-LOGIN-URLS/1",
                        "accounts": [{"account_id": "upstox-a", "login_url": url}]}

            write(key, KEY + "\n")
            write(reg, json.dumps(config()))
            write(links, json.dumps(mapping()))

            base = os.environ.copy()
            base.update({
                "QSYN_PRIVATE_BROKER_GATEWAY": "1",
                "QSYN_TRADING_ENABLED": "0",
                "QSYN_ENABLE_LIVE_TRADING": "0",
                "QSYN_OPENALGO_REGISTRY_FILE": str(reg),
                "QSYN_OPENALGO_LOGIN_URLS_FILE": str(links),
            })

            def invoke(*cmd, env=None):
                run = subprocess.run(
                    ["php", str(SCRIPT), *(cmd or
                        ("inspect", "tenant-a", "owner-a", "upstox-a"))],
                    cwd=ROOT, env=env or base, text=True,
                    capture_output=True, timeout=9)
                assert KEY not in run.stdout + run.stderr
                assert str(root) not in run.stdout + run.stderr
                return run

            ok = invoke()
            assert ok.returncode == 0, (ok.stdout, ok.stderr)
            status = json.loads(ok.stdout)
            assert status["schema"] == "QSYN-OPENALGO-UPSTOX-OPERATOR-READINESS/1"
            assert status["openalgo_application_session_responding"] is True
            assert status["broker"] == "upstox"
            assert status["oauth_callback_path"] == "/upstox/callback"
            for field in ("upstox_account_identity_verified",
                          "broker_oauth_callback_verified",
                          "exchange_display_rights_verified",
                          "live_feed_verified", "openalgo_trading_permissions_verified",
                          "cloudways_host_approved", "ready_for_live_market_data",
                          "trading_enabled_in_qsyn"):
                assert status[field] is False, field

            FakeHandler.response_broker = "zerodha"
            wrong_plugin = invoke()
            assert wrong_plugin.returncode == 3, wrong_plugin
            assert json.loads(wrong_plugin.stdout)["session_state"] == "unavailable_or_expired"
            FakeHandler.response_broker = "upstox"

            FakeHandler.succeed = False
            denied = invoke()
            assert denied.returncode == 3 and json.loads(denied.stdout)[
                "openalgo_application_session_responding"] is False
            FakeHandler.succeed = True

            for args in [
                ("inspect", "tenant-other", "owner-a", "upstox-a"),
                ("inspect", "tenant-a", "owner-other", "upstox-a"),
                ("inspect", "tenant-a", "owner-a", "unknown"),
                ("ping", "tenant-a", "owner-a", "upstox-a"),
            ]:
                rejected = invoke(*args)
                assert rejected.returncode == 2 and not rejected.stdout

            for env_update in [
                {"QSYN_PRIVATE_BROKER_GATEWAY": "0"},
                {"QSYN_TRADING_ENABLED": "1"},
                {"QSYN_ENABLE_LIVE_TRADING": "1"},
                {"QSYN_OPENALGO_LOGIN_URLS_FILE": ""},
            ]:
                blocked = invoke(env={**base, **env_update})
                assert blocked.returncode == 2 and not blocked.stdout

            for bad in ("http://openalgo.example.test/login",
                        "https://user@openalgo.example.test/login",
                        "https://openalgo.example.test:5000/login",
                        "https://openalgo.example.test/login?key=secret",
                        "https://openalgo.example.test/qsyn/login"):
                write(links, json.dumps(mapping(bad)))
                assert invoke().returncode == 2, bad
            write(links, json.dumps(mapping()))

            links.chmod(0o644)
            assert invoke().returncode == 2
            links.chmod(0o600)
            key.chmod(0o644)
            assert invoke().returncode == 2
            key.chmod(0o600)
            write(reg, json.dumps(config("zerodha")))
            assert invoke().returncode == 2
            write(reg, json.dumps(config()))

            print("PASS operator Upstox readiness: valid local ping, plugin mismatch, private scope, URL, flags, no secrets/orders")
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

if __name__ == "__main__":
    main()
