#!/usr/bin/env python3
"""End-to-end private, session- and rights-scoped Rust chart grant issuance.

Fixtures only. Never connects Upstox, starts a public WSS, or stores broker keys.
"""
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import tempfile

from IdentityHttpSmoke import (
    FAKE_PASSWORD, await_server, client, fixture, open_port, php_server, request,
)
AUTH = "/qsyn/api/v1/auth/"
GRANT = "/qsyn/api/v1/terminal/private-chart-grant"
KEY = bytes([42] * 32)
INSTRUMENT = "NFO|EXAMPLE_CE"


def login(origin, tenant, username):
    opener, _ = client()
    status, state, _ = request(opener, origin, AUTH + "state")
    assert status == 200
    status, signed, _ = request(opener, origin, AUTH + "login", "POST", {
        "tenant": tenant, "username": username, "password": FAKE_PASSWORD,
    }, state["csrf"])
    assert status == 200 and signed["authenticated"] is True, (status, signed)
    return opener, signed["csrf"], signed["user"]


def run():
    with tempfile.TemporaryDirectory(prefix="qsyn-chart-grant-") as tmp:
        private = Path(tmp) / "private"
        sessions = Path(tmp) / "sessions"
        private.mkdir(mode=0o700)
        sessions.mkdir(mode=0o700)
        key_path = private / "chart-signing.key"
        rights_path = private / "chart-rights.json"
        key_path.write_bytes(KEY)
        key_path.chmod(0o600)
        env = {
            **os.environ,
            "QSYN_ENV": "test", "QSYN_ALLOW_HTTP_TEST": "1",
            "QSYN_IDENTITY_ENABLED": "1", "QSYN_PRIVATE_CHART_GRANTS_ENABLED": "1",
            "QSYN_IDENTITY_STORAGE_DIR": str(private),
            "QSYN_PRIVATE_CHART_SIGNING_KEY_FILE": str(key_path),
            "QSYN_PRIVATE_CHART_RIGHTS_FILE": str(rights_path),
            "QSYN_TRADING_ENABLED": "0",
            "QSYN_ENABLE_LIVE_TRADING": "0",
        }
        for t, u, role in [
            ("tenant-one", "alice", "member"),
            ("tenant-one", "bob", "viewer"),
            ("tenant-two", "alice", "member"),
        ]:
            fixture(env, private, "create", t, u, FAKE_PASSWORD, role)
        port = open_port()
        origin = f"http://127.0.0.1:{port}"
        proc = php_server(env, sessions, port)
        try:
            await_server(origin)
            guest, _ = client()
            alice, csrf, principal = login(origin, "tenant-one", "alice")
            bob, bob_csrf, _ = login(origin, "tenant-one", "bob")
            other, other_csrf, _ = login(origin, "tenant-two", "alice")
            import time
            now = int(time.time() * 1000)
            rights = {
                "schema": "QSYN-PRIVATE-CHART-ENTITLEMENT/1",
                "tenant": principal["tenant_id"], "account": "approved-upstox-a",
                "owner": principal["user_id"], "broker": "upstox",
                "instruments": [INSTRUMENT, "NFO|EXAMPLE_PE"],
                "license_id": "TEST-ONLY-NOT-A-LICENSE",
                "can_display_to_this_user": True,
                "broker_session_verified": True,
                "valid_until_ms": now + 180000,
            }
            rights_path.write_text(json.dumps(rights))
            rights_path.chmod(0o600)
            body = {"account_id": "approved-upstox-a", "instrument": INSTRUMENT}
            def post(opener, values=body, token=None, browser_origin=None):
                return request(opener, origin, GRANT, "POST", values, token, browser_origin)

            assert request(guest, origin, GRANT)[0] == 405
            assert post(guest, token=csrf)[0] == 401
            assert post(alice)[0] == 403
            assert post(alice, token=csrf, browser_origin="http://attacker.invalid")[0] == 403
            assert post(bob, token=bob_csrf)[0] == 403
            assert post(other, token=other_csrf)[0] == 403
            assert post(alice, {"account_id": "approved-upstox-b", "instrument": INSTRUMENT}, csrf)[0] == 403
            assert post(alice, {"account_id": "approved-upstox-a", "instrument": "NFO|OTHER"}, csrf)[0] == 403
            assert post(alice, {**body, "owner_user_id": principal["user_id"]}, csrf)[0] == 422

            code, answer, headers = post(alice, token=csrf)
            assert code == 200, (code, answer)
            assert "no-store" in headers.get("Cache-Control", "")
            assert answer["trading_enabled"] is False
            assert answer["public_redistribution_allowed"] is False
            token = answer["ticket"]
            assert len(token) < 2048 and token.count(".") == 1
            raw, mac = token.split(".")
            def unpad(text):
                return base64.urlsafe_b64decode(text + "=" * ((-len(text)) % 4))
            payload = unpad(raw)
            signature = unpad(mac)
            assert hmac.compare_digest(signature, hmac.new(KEY, payload, hashlib.sha256).digest())
            claim = json.loads(payload)
            assert list(claim) == [
                "version", "tenant", "account", "owner", "broker", "instrument",
                "license_id", "audience", "issued_ms", "expires_ms",
            ]
            assert claim["version"] == 1 and claim["audience"] == "qsyn-private-chart"
            assert claim["tenant"] == principal["tenant_id"] and claim["owner"] == principal["user_id"]
            assert claim["account"] == body["account_id"] and claim["instrument"] == INSTRUMENT
            assert claim["expires_ms"] - claim["issued_ms"] == 30000
            assert now - 5000 < claim["issued_ms"] <= int(time.time() * 1000) + 1000
            assert "password" not in json.dumps(answer).lower()
            print("PASS: private issuer matches Rust HMAC payload, scope, 30s TTL and same-origin authentication")

            # File-mode failures, licensing revocations and clock expiry deny issuance immediately.
            rights["can_display_to_this_user"] = False
            rights_path.write_text(json.dumps(rights))
            assert post(alice, token=csrf)[0] == 403
            rights["can_display_to_this_user"] = True
            rights["broker_session_verified"] = False
            rights_path.write_text(json.dumps(rights))
            assert post(alice, token=csrf)[0] == 403
            rights["broker_session_verified"] = True
            rights["valid_until_ms"] = now - 100
            rights_path.write_text(json.dumps(rights))
            assert post(alice, token=csrf)[0] == 403
            rights["valid_until_ms"] = now + 180000
            rights_path.write_text(json.dumps(rights))
            rights_path.chmod(0o644)
            assert post(alice, token=csrf)[0] == 403
            rights_path.chmod(0o600)
            key_path.chmod(0o644)
            assert post(alice, token=csrf)[0] == 503
            key_path.chmod(0o600)
            fixture(env, private, "revoke", "tenant-one", "alice", FAKE_PASSWORD)
            assert post(alice, token=csrf)[0] == 401
            print("PASS: entitlement, broker session, expiry, 0600 rights/key files, revocation")

        finally:
            proc.terminate()
            proc.communicate(timeout=5)
        # Separate server without opt-in must not issue grants.
        disabled_env = {**env, "QSYN_PRIVATE_CHART_GRANTS_ENABLED": "0"}
        port = open_port()
        off_origin = f"http://127.0.0.1:{port}"
        off = php_server(disabled_env, sessions, port)
        try:
            await_server(off_origin)
            anonymous, _ = client()
            code, body, _ = request(anonymous, off_origin, GRANT)
            assert code == 503 and body["error"] == "private_chart_grants_disabled"
            print("PASS: issuance is disabled by default")
        finally:
            off.terminate()
            off.communicate(timeout=5)


if __name__ == "__main__":
    run()
