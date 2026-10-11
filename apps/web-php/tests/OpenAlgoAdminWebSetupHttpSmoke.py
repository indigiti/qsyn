#!/usr/bin/env python3
"""First-time browser OpenAlgo config, owner-only private files, zero API key echo."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from IdentityHttpSmoke import await_server, client, open_port, php_server, request

API = "/qsyn/api/v1/admin/openalgo/"
ADMIN = "/qsyn/api/v1/admin/rust/"
PASSWORD = "web-setup-test-password-12345ABC"
APP_KEY = "fake_openalgo_app_key_for_test_only_50001"

class FakeOpenAlgo(BaseHTTPRequestHandler):
    requests = []
    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(min(length, 512)))
        FakeOpenAlgo.requests.append((self.path, body))
        output = json.dumps({"status": "success", "data": {
            "message": "pong", "broker": "upstox", "secret": APP_KEY
        }}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(output)))
        self.end_headers()
        self.wfile.write(output)
    def log_message(self, *_): pass

def main():
    fake = ThreadingHTTPServer(("127.0.0.1", 0), FakeOpenAlgo)
    worker = threading.Thread(target=fake.serve_forever, daemon=True)
    worker.start()
    try:
        with tempfile.TemporaryDirectory(prefix="qsyn-openalgo-web-setup-") as folder:
            runtime = Path(folder) / "private"
            sessions = Path(folder) / "sessions"
            runtime.mkdir(mode=0o700)
            sessions.mkdir(mode=0o700)
            hashed = subprocess.check_output(
                ["php", "-r", "echo password_hash($argv[1], PASSWORD_DEFAULT);",
                 PASSWORD], text=True).strip()
            env = {**os.environ,
                "QSYN_CONTROL_ENABLED": "1",
                "QSYN_ADMIN_PASSWORD_HASH": hashed,
                "QSYN_ALLOW_HTTP_TEST": "1",
                "QSYN_RUNTIME_DIR": str(runtime),
                "QSYN_TRADING_ENABLED": "0",
                "QSYN_ENABLE_LIVE_TRADING": "0",
            }
            for key in ["QSYN_OPENALGO_REGISTRY_FILE", "QSYN_OPENALGO_LOGIN_URLS_FILE"]:
                env.pop(key, None)
            origin_port = open_port()
            origin = f"http://127.0.0.1:{origin_port}"
            php = php_server(env, sessions, origin_port)
            try:
                await_server(origin)
                anon,_ = client()
                assert request(anon,origin,API+"accounts")[0] == 401
                assert request(anon,origin,API+"setup","POST",{}, "z"*64)[0] == 401
                owner,_ = client()
                status,login,_=request(owner,origin,ADMIN+"login","POST",{"password":PASSWORD})
                assert status == 200 and login["authenticated"], (status,login)
                csrf=login["csrf"]
                code,unconfigured,_=request(owner,origin,API+"accounts")
                assert code == 200, (code,unconfigured)
                assert unconfigured["configuration_state"] == "not_provisioned"
                assert unconfigured["setup_available"] is True
                assert unconfigured["setup_mode"] == "initial_web_setup"
                assert unconfigured["accounts"] == []

                def form(**overrides):
                    return {
                        "account_id": "upstox-a", "broker": "upstox",
                        "rest_port": fake.server_port,
                        "ws_port": (8766 if fake.server_port != 8765 else 8765),
                        "login_url": "https://openalgo.example.test/login",
                        "application_api_key": APP_KEY,
                        "confirmed": True,
                        **overrides,
                    }
                for payload in (
                    form(login_url="http://openalgo.example.test/login"),
                    form(login_url="https://user@openalgo.example.test/login"),
                    form(login_url="https://openalgo.example.test/login?secret=1"),
                    form(rest_port=22),
                    form(ws_port=fake.server_port),
                    form(application_api_key="short"),
                    form(application_api_key="A\nB" * 14),
                    form(confirmed=False),
                    form(broker="__unknown"),
                    form(account_id="../escape"),
                    dict(form(), tenant_id="attacker"),
                ):
                    code,body,_ = request(owner,origin,API+"setup","POST",payload,csrf)
                    assert code == 422, (code,body)
                    assert APP_KEY not in json.dumps(body)
                assert request(owner,origin,API+"setup","POST",form())[0] == 403
                assert request(owner,origin,API+"setup","POST",form(),"wrong")[0] == 403
                assert request(owner,origin,API+"setup","POST",form(),csrf,
                    "http://untrusted.example")[0] == 403
                assert not (runtime/"openalgo-registry.json").exists()
                code,saved,_=request(owner,origin,API+"setup","POST",form(),csrf)
                assert code == 201, (code,saved)
                assert saved["configuration_saved"] and saved["account_id"]=="upstox-a"
                assert APP_KEY not in json.dumps(saved)
                assert saved["native_openalgo_installed"] is False
                files=[
                    runtime/"openalgo-registry.json",
                    runtime/"openalgo-login-urls.json",
                    runtime/"openalgo-keys"/"upstox-a.key",
                ]
                for file in files:
                    assert file.is_file() and (file.stat().st_mode & 0o777)==0o600, file
                assert (runtime/"openalgo-keys").stat().st_mode & 0o777 == 0o700
                assert (runtime/"openalgo-keys"/"upstox-a.key").read_text().strip() == APP_KEY
                config=json.loads((runtime/"openalgo-registry.json").read_text())
                assert config["accounts"][0]["tenant_id"] == "operator-private"
                assert config["accounts"][0]["owner_user_id"] == "qsyn-admin"
                assert request(owner,origin,API+"setup","POST",form(),csrf)[0] == 409
                code,listed,_=request(owner,origin,API+"accounts")
                assert code == 200 and listed["configuration_state"]=="registered"
                assert listed["setup_available"] is False
                assert listed["accounts"][0]["account_id"]=="upstox-a"
                assert APP_KEY not in json.dumps(listed)
                code,ping,_=request(owner,origin,API+"inspect","POST",
                    {"account_id":"upstox-a"},csrf)
                assert code == 200 and ping["openalgo_application_session_responding"]
                assert len(FakeOpenAlgo.requests)==1
                assert FakeOpenAlgo.requests[0] == ("/api/v1/ping",{"apikey": APP_KEY})
                assert APP_KEY not in json.dumps(ping)
                for flag in ("broker_identity_verified","broker_oauth_callback_verified",
                             "market_entitlement_verified","live_feed_verified",
                             "upstream_order_permissions_verified","trading_enabled_in_qsyn"):
                    assert ping[flag] is False
                assert request(owner,origin,ADMIN+"logout","POST",{},csrf)[0] == 200
                assert request(owner,origin,API+"accounts")[0] == 401
                print("PASS OpenAlgo browser first-run setup: 200 state, HTTPS/CSRF/admin, 0600 files, replay blocked, read-only ping")
            finally:
                php.terminate()
                php.communicate(timeout=5)
    finally:
        fake.shutdown()
        fake.server_close()
        worker.join(timeout=5)

if __name__=="__main__":
    main()
