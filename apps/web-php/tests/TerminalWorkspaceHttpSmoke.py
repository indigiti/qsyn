#!/usr/bin/env python3
"""Private opt-in file-only terminal workspace HTTP acceptance.

Never uses a broker account, database, live server or remote credential.
"""
import json
import os
from pathlib import Path
import tempfile

from IdentityHttpSmoke import (
    FAKE_PASSWORD, await_server, client, fixture,
    open_port, php_server, request,
)

ENDPOINT = "/qsyn/api/v1/terminal/workspace"
AUTH = "/qsyn/api/v1/auth/"


def sign_in(origin, tenant, user):
    opener, _ = client()
    code, state, _ = request(opener, origin, AUTH + "state")
    assert code == 200, (code, state)
    code, signed, _ = request(opener, origin, AUTH + "login", "POST", {
        "tenant": tenant, "username": user, "password": FAKE_PASSWORD,
    }, state["csrf"])
    assert code == 200 and signed["authenticated"], (code, signed)
    return opener, signed["csrf"]


def run() -> None:
    with tempfile.TemporaryDirectory(prefix="qsyn-terminal-files-") as temp:
        root = Path(temp) / "private"
        sessions = Path(temp) / "sessions"
        root.mkdir(mode=0o700)
        sessions.mkdir(mode=0o700)
        env = {
            **os.environ, "QSYN_ENV": "test", "QSYN_ALLOW_HTTP_TEST": "1",
            "QSYN_IDENTITY_ENABLED": "1", "QSYN_TERMINAL_FILE_SYNC_ENABLED": "1",
            "QSYN_IDENTITY_STORAGE_DIR": str(root),
        }
        for tenant, user, role in [
            ("tenant-one", "alice", "member"),
            ("tenant-one", "bob", "viewer"),
            ("tenant-two", "alice", "member"),
        ]:
            fixture(env, root, "create", tenant, user, FAKE_PASSWORD, role)
        port = open_port()
        origin = f"http://127.0.0.1:{port}"
        proc = php_server(env, sessions, port)
        try:
            await_server(origin)
            guest, _ = client()
            assert request(guest, origin, ENDPOINT)[0] == 401
            alice, csrf = sign_in(origin, "tenant-one", "alice")
            bob, bob_csrf = sign_in(origin, "tenant-one", "bob")
            other, other_csrf = sign_in(origin, "tenant-two", "alice")
            a_status, a, headers = request(alice, origin, ENDPOINT)
            assert a_status == 200 and a["revision"] == 0, (a_status, a)
            assert a["mode"] == "simulated"
            assert a["storage"] == "private_file_development_only"
            assert a["can_write"] is True and a["csrf"] == csrf
            assert "no-store" in headers.get("Cache-Control", "")
            assert a["workspace"]["schema"] == "QSYN-TERMINAL-BROWSER-WORKSPACES/1"
            assert request(bob, origin, ENDPOINT)[1]["can_write"] is False
            assert request(other, origin, ENDPOINT)[1]["revision"] == 0

            desired = {
                "schema": "QSYN-TERMINAL-BROWSER-WORKSPACES/1",
                "watchlist": ["QSYN-DEMO", "QSYN-BANKNIFTY-STRADDLE"],
                "layouts": [{
                    "name": "Alice demo",
                    "panes": [{"id": "primary", "symbol": "QSYN-DEMO"},
                              {"id": "secondary", "symbol": "QSYN-BANKNIFTY-STRADDLE"}],
                    "chartStates": {"primary": {
                        "symbol": "QSYN-DEMO", "exchange": "QSYN", "interval": "1m",
                        "chart": {"viewport": 100, "drawings": [{"type": "line", "px": 12}]},
                    }},
                }],
            }
            body = {"expected_revision": 0, "workspace": desired}
            def post(opener, payload, token, browser_origin=None):
                return request(opener, origin, ENDPOINT, "POST", payload, token, browser_origin)

            assert post(guest, body, csrf)[0] == 401
            assert post(bob, body, bob_csrf)[0] == 403
            assert post(alice, body, None)[0] == 403
            assert post(alice, body, csrf, "http://attacker.example")[0] == 403
            assert post(alice, {**body, "owner_user_id": "somebody"}, csrf)[0] == 422
            assert post(alice, {**body, "tenant_id": "tenant-two"}, csrf)[0] == 422
            bad_symbol = json.loads(json.dumps(body))
            bad_symbol["workspace"]["watchlist"] = ["NSE:RELIANCE"]
            assert post(alice, bad_symbol, csrf)[0] == 422
            injected_state = json.loads(json.dumps(body))
            injected_state["workspace"]["layouts"][0]["chartStates"]["primary"]["access_token"] = "FAKE_SECRET"
            assert post(alice, injected_state, csrf)[0] == 422
            wrong_exp = json.loads(json.dumps(body))
            wrong_exp["workspace"]["layouts"][0]["panes"][1]["symbol"] = "NSE:WRONG"
            assert post(alice, wrong_exp, csrf)[0] == 422
            code, saved, _ = post(alice, body, csrf)
            assert code == 200 and saved["revision"] == 1, (code, saved)
            assert saved["workspace"]["layouts"][0]["name"] == "Alice demo"
            assert post(alice, body, csrf)[0] == 409
            assert request(alice, origin, ENDPOINT)[1]["revision"] == 1
            for foreign in [bob, other]:
                code, res, _ = request(foreign, origin, ENDPOINT)
                assert code == 200 and res["revision"] == 0 and res["workspace"]["layouts"] == [], res
                assert "Alice demo" not in json.dumps(res)

            bob_code, bob_write, _ = post(bob, body, bob_csrf)
            assert bob_code == 403, bob_write
            other_code, other_write, _ = post(other, body, other_csrf)
            assert other_code == 200 and other_write["revision"] == 1
            assert request(alice, origin, ENDPOINT)[1]["workspace"] == saved["workspace"]
            assert request(bob, origin, ENDPOINT)[1]["revision"] == 0
            store_files = list((root / "terminal_demo_workspaces").glob("tw_*.json"))
            assert len(store_files) == 2
            for file in store_files:
                assert file.stat().st_mode & 0o777 == 0o600
                raw = file.read_text()
                assert "FAKE_SECRET" not in raw and FAKE_PASSWORD not in raw
            audit_files = list((root / "mock_audit_events").glob("e_*.json"))
            assert any('"workspace.save"' in f.read_text() for f in audit_files)
            assert all(f.stat().st_mode & 0o777 == 0o600 for f in audit_files)
            assert request(alice, origin, ENDPOINT, "PUT")[0] == 405
            # A disabled mock identity immediately loses scoped workspace access.
            fixture(env, root, "revoke", "tenant-one", "alice", FAKE_PASSWORD)
            assert request(alice, origin, ENDPOINT)[0] == 401
            print("PASS private scoped files: tenant/owner isolation, viewer, CSRF, origin, CAS, audit, revocation, private modes")
        finally:
            proc.terminate()
            proc.communicate(timeout=5)

        # Sync stays off even with development identity enabled.
        off_env = {**env, "QSYN_TERMINAL_FILE_SYNC_ENABLED": "0"}
        off_port = open_port()
        off_origin = f"http://127.0.0.1:{off_port}"
        off = php_server(off_env, sessions, off_port)
        try:
            await_server(off_origin)
            anon, _ = client()
            code, payload, _ = request(anon, off_origin, ENDPOINT)
            assert code == 503 and payload["error"] == "private_terminal_workspace_disabled"
            print("PASS feature disabled by default")
        finally:
            off.terminate()
            off.communicate(timeout=5)


if __name__ == "__main__":
    run()
