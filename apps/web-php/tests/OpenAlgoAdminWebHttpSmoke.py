#!/usr/bin/env python3
"""QSYN operator web OpenAlgo readiness: fake loopback server, no real keys."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

from IdentityHttpSmoke import (await_server, client, open_port, php_server, request)

ROOT = Path(__file__).resolve().parents[3]
URL = "/qsyn/api/v1/admin/openalgo/"
ADMIN = "/qsyn/api/v1/admin/rust/"
KEY = "qsyn-fake-application-key-for-web-readiness-55555"
PASSWORD = "web-operator-test-password-123456"

class OpenAlgoFake(BaseHTTPRequestHandler):
    broker = "upstox"
    success = True
    calls = []

    def do_POST(self):
        size = int(self.headers.get("Content-Length", "0"))
        data = json.loads(self.rfile.read(min(size, 1024)))
        OpenAlgoFake.calls.append((self.path, data))
        ok = self.path == "/api/v1/ping" and data == {"apikey": KEY} and self.success
        reply = ({"status": "success", "data": {
            "message": "pong", "broker": self.broker,
            "access_token": KEY,
        }} if ok else {"status": "error", "access_token": KEY})
        raw = json.dumps(reply).encode()
        self.send_response(200 if ok else 403)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, *_):
        pass

def write(path, value):
    path.write_text(value, encoding="utf-8")
    path.chmod(0o600)

def main():
    server = ThreadingHTTPServer(("127.0.0.1", 0), OpenAlgoFake)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix="qsyn-admin-openalgo-web-") as dirname:
            root = Path(dirname)
            private = root / "private"
            sessions = root / "sessions"
            private.mkdir(mode=0o700)
            sessions.mkdir(mode=0o700)
            key = private / "upstox-key.txt"
            reg = private / "openalgo-registry.json"
            links = private / "openalgo-login-urls.json"
            write(key, KEY + "\n")
            write(reg, json.dumps({
                "schema": "QSYN-PRIVATE-OPENALGO-REGISTRY/1",
                "accounts": [{
                    "account_id": "upstox-a", "tenant_id": "tenant-one",
                    "owner_user_id": "owner-one", "broker": "upstox",
                    "rest_port": server.server_port,
                    "ws_port": (8766 if server.server_port == 8765 else 8765),
                    "openalgo_apikey_file": str(key),
                }]
            }))
            write(links, json.dumps({
                "schema": "QSYN-OPENALGO-LOGIN-URLS/1",
                "accounts": [{
                    "account_id": "upstox-a",
                    "login_url": "https://openalgo.example.test/login",
                }]
            }))
            hashed = subprocess.check_output(
                ["php", "-r", "echo password_hash($argv[1], PASSWORD_DEFAULT);",
                 PASSWORD], text=True).strip()
            env = os.environ.copy()
            env.update({
                "QSYN_CONTROL_ENABLED": "1",
                "QSYN_ADMIN_PASSWORD_HASH": hashed,
                "QSYN_ALLOW_HTTP_TEST": "1",
                "QSYN_RUNTIME_DIR": str(private),
                "QSYN_TRADING_ENABLED": "0",
                "QSYN_ENABLE_LIVE_TRADING": "0",
            })
            port = open_port()
            origin = f"http://127.0.0.1:{port}"
            process = php_server(env, sessions, port)
            try:
                await_server(origin)
                anonymous, _ = client()
                assert request(anonymous, origin, URL+"accounts")[0] == 401
                assert request(anonymous, origin, URL+"inspect", "POST",
                    {"account_id": "upstox-a"}, "f"*64)[0] == 401
                assert request(anonymous, origin, URL+"connect", "POST",
                    {"account_id": "upstox-a"}, "f"*64)[0] == 401
                assert request(anonymous, origin, URL+"inspect", "GET")[0] == 405

                owner, _ = client()
                code, signin, _ = request(owner, origin, ADMIN+"login", "POST",
                                          {"password": PASSWORD})
                assert code == 200 and signin["authenticated"] is True, (code,signin)
                csrf = signin["csrf"]
                code, inventory, headers = request(owner,origin,URL+"accounts")
                assert code == 200, (code,inventory)
                assert "no-store" in headers["Cache-Control"]
                assert inventory["schema"]=="QSYN-OPENALGO-ADMIN-READINESS/1"
                assert len(inventory["accounts"])==1
                assert inventory["accounts"][0]=={
                    "account_id":"upstox-a","broker":"upstox",
                    "login_available":True,"session_state":"not_checked"}
                assert inventory["csrf"]==csrf
                assert "tenant-one" not in json.dumps(inventory)
                assert "owner-one" not in json.dumps(inventory)
                assert KEY not in json.dumps(inventory)
                assert not inventory["trading_enabled_in_qsyn"]
                assert not inventory["upstream_order_permissions_verified"]

                assert request(owner,origin,URL+"inspect","POST",
                              {"account_id":"upstox-a"})[0]==403
                assert request(owner,origin,URL+"inspect","POST",
                              {"account_id":"upstox-a"},"wrong")[0]==403
                assert request(owner,origin,URL+"inspect","POST",
                              {"account_id":"upstox-a"},csrf,
                              "http://untrusted.example")[0]==403
                assert request(owner,origin,URL+"inspect","POST",
                              {"account_id":"../../etc/passwd"},csrf)[0]==422
                assert request(owner,origin,URL+"inspect","POST",
                              {"account_id":"unowned"},csrf)[0]==404
                assert request(owner,origin,URL+"connect","POST",
                              {"account_id":"unowned"},csrf)[0]==404
                assert request(owner,origin,URL+"inspect","POST",
                              {"account_id":"upstox-a","tenant_id":"x"},csrf)[0]==422

                code, connected, _ = request(owner,origin,URL+"connect","POST",
                              {"account_id":"upstox-a"},csrf)
                assert code==200 and connected["login_url"]=="https://openalgo.example.test/login"
                assert connected["session_state"]=="awaiting_upstream_login"
                assert not OpenAlgoFake.calls, "Login handoff must not send broker requests"
                code, status, _ = request(owner,origin,URL+"inspect","POST",
                                          {"account_id":"upstox-a"},csrf)
                assert code==200 and status["openalgo_application_session_responding"]
                assert status["broker"]=="upstox"
                assert OpenAlgoFake.calls == [("/api/v1/ping",{"apikey":KEY})]
                for flag in ("broker_identity_verified",
                             "broker_oauth_callback_verified",
                             "market_entitlement_verified",
                             "live_feed_verified",
                             "trading_enabled_in_qsyn",
                             "upstream_order_permissions_verified"):
                    assert status[flag] is False,flag
                assert KEY not in json.dumps(status)
                assert "openalgo.example.test" not in json.dumps(status)

                OpenAlgoFake.broker="zerodha"
                code, wrong, _ = request(owner,origin,URL+"inspect","POST",
                                         {"account_id":"upstox-a"},csrf)
                assert code==200 and not wrong["openalgo_application_session_responding"]
                OpenAlgoFake.broker="upstox"
                OpenAlgoFake.success=False
                code, gone, _ = request(owner,origin,URL+"inspect","POST",
                                        {"account_id":"upstox-a"},csrf)
                assert code==200 and gone["session_state"]=="unavailable_or_expired"
                OpenAlgoFake.success=True

                links.chmod(0o644)
                assert request(owner,origin,URL+"accounts")[0]==503
                links.chmod(0o600)
                key.chmod(0o644)
                assert request(owner,origin,URL+"accounts")[0]==503
                key.chmod(0o600)

                assert request(owner,origin,ADMIN+"logout","POST",{},csrf)[0]==200
                assert request(owner,origin,URL+"accounts")[0]==401
                print("PASS protected web broker connect/verify, wrong-plugin, CSRF, origin, admin logout, 0600, no order")
            finally:
                process.terminate()
                process.communicate(timeout=5)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

if __name__=="__main__":
    main()
