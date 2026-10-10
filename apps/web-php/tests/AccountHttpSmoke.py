#!/usr/bin/env python3
"""Phase 1.3 session-isolated mock broker HTTP API acceptance (localhost only)."""
import os
from pathlib import Path
import tempfile

from IdentityHttpSmoke import (
    FAKE_PASSWORD, await_server, client, fixture, open_port, php_server, request
)

AUTH = "/qsyn/api/v1/auth/"
ACCOUNTS = "/qsyn/api/v1/accounts/"


def login(origin, tenant, username):
    opener, jar = client()
    code, initial, _ = request(opener, origin, AUTH + "state")
    assert code == 200 and not initial["authenticated"], (code, initial)
    code, signed, _ = request(opener, origin, AUTH + "login", "POST", {
        "tenant": tenant, "username": username, "password": FAKE_PASSWORD
    }, initial["csrf"])
    assert code == 200 and signed["authenticated"] is True, (code, signed)
    return opener, signed["csrf"], jar


def post(opener, origin, endpoint, data, csrf, other_origin=None):
    return request(opener, origin, ACCOUNTS + endpoint, "POST", data, csrf, other_origin)


def run():
    with tempfile.TemporaryDirectory(prefix="qsyn-accounts-http-") as tmp:
        directory = Path(tmp) / "private"
        sessions = Path(tmp) / "sessions"
        directory.mkdir(mode=0o700)
        sessions.mkdir(mode=0o700)
        env = {
            **os.environ, "QSYN_ENV": "test",
            "QSYN_ALLOW_HTTP_TEST": "1", "QSYN_IDENTITY_ENABLED": "1",
            "QSYN_MOCK_ACCOUNTS_ENABLED": "1",
            "QSYN_IDENTITY_STORAGE_DIR": str(directory),
        }
        for tenant, username, role in [
            ("tenant-one", "alice", "member"),
            ("tenant-one", "bob", "viewer"),
            ("tenant-two", "alice", "member"),
        ]:
            fixture(env, directory, "create", tenant, username, FAKE_PASSWORD, role)

        port = open_port()
        origin = "http://127.0.0.1:" + str(port)
        proc = php_server(env, sessions, port)
        try:
            await_server(origin)
            # Dashboard has an independent opt-in even with accounts enabled.
            assert request(client()[0], origin, '/qsyn/app')[0] == 404
            guest, _ = client()
            assert request(guest, origin, ACCOUNTS + "list")[0] == 401
            assert request(guest, origin, ACCOUNTS + "get?id=bad")[0] == 401
            assert request(guest, origin, ACCOUNTS + "bars")[0] == 401
            assert post(guest, origin, "link", {}, "x" * 64)[0] == 401

            alice, csrf, _ = login(origin, "tenant-one", "alice")
            bob, bob_csrf, _ = login(origin, "tenant-one", "bob")
            other, other_csrf, _ = login(origin, "tenant-two", "alice")

            assert request(bob, origin, ACCOUNTS + "list")[1]["accounts"] == []
            assert request(bob, origin, ACCOUNTS + "bars")[0] == 409
            assert request(other, origin, ACCOUNTS + "bars")[0] == 409
            assert post(bob, origin, "link", {}, bob_csrf)[0] == 403
            assert request(other, origin, ACCOUNTS + "list")[1]["accounts"] == []

            def create(code, reference, label):
                status, result, _ = post(alice, origin, "link", {
                    "broker_code": code, "mock_reference": reference, "display_label": label
                }, csrf)
                assert status == 201, (status, result)
                return result["account"]

            a = create("upstox", "mock-upstox-a", "Upstox A")
            b = create("upstox", "mock-upstox-b", "Upstox B")
            d = create("dhan", "mock-dhan-c", "Dhan mock")

            assert len({a["account_id"], b["account_id"], d["account_id"]}) == 3
            assert all(x["execution_allowed"] is False
                       and x["feed_entitlements"] == ["simulated"] for x in (a, b, d))
            assert "access_token" not in str(a) and "api_key" not in str(a)
            assert request(alice, origin, ACCOUNTS + "list")[1]["selection"] == {
                "account_id": None, "revision": 0
            }
            assert len(request(alice, origin, ACCOUNTS + "list")[1]["accounts"]) == 3

            for foreign, foreign_csrf in ((bob, bob_csrf), (other, other_csrf)):
                assert request(foreign, origin, ACCOUNTS + "get?id=" + a["account_id"])[0] == 404
                assert request(foreign, origin, ACCOUNTS + "list")[1]["accounts"] == []
                assert post(foreign, origin, "rename", {
                    "account_id": a["account_id"], "display_label": "stolen",
                    "expected_revision": 1
                }, foreign_csrf)[0] in (403, 404)
                assert post(foreign, origin, "select", {
                    "account_id": a["account_id"], "expected_revision": 0
                }, foreign_csrf)[0] in (403, 404)

            malformed = {"broker_code": "upstox",
                         "mock_reference": "not-a-mock", "display_label": "Invalid"}
            assert post(alice, origin, "link", malformed, csrf)[0] == 422
            assert post(alice, origin, "link", {
                "broker_code": "upstox", "mock_reference": "mock-upstox-a",
                "display_label": "Duplicate",
            }, csrf)[0] == 409
            assert post(alice, origin, "link", {
                "broker_code": "upstox", "mock_reference": "mock-extra",
                "display_label": "Forged", "owner_user_id": "someone-else",
            }, csrf)[0] == 422

            valid_rename = {
                "account_id": b["account_id"], "display_label": "Upstox B renamed",
                "expected_revision": 1
            }
            assert post(alice, origin, "rename", valid_rename, None)[0] == 403
            assert post(alice, origin, "rename", valid_rename, csrf,
                        "http://attacker.example")[0] == 403
            status, renamed, _ = post(alice, origin, "rename", valid_rename, csrf)
            assert status == 200 and renamed["account"]["revision"] == 2, (status, renamed)
            assert post(alice, origin, "rename", valid_rename, csrf)[0] == 409

            status, chosen, _ = post(alice, origin, "select", {
                "account_id": a["account_id"], "expected_revision": 0
            }, csrf)
            assert status == 200 and chosen["selection"]["revision"] == 1
            status, preview_a, _ = request(alice, origin, ACCOUNTS + "bars")
            assert status == 200 and preview_a["account_id"] == a["account_id"], preview_a
            assert preview_a["source"] == "account-scoped-mock-fixture"
            assert preview_a["trading_enabled"] is False and len(preview_a["bars"]) == 120
            assert request(bob, origin, ACCOUNTS + "bars")[0] == 409
            assert request(other, origin, ACCOUNTS + "bars")[0] == 409
            assert post(alice, origin, "select", {
                "account_id": b["account_id"], "expected_revision": 0
            }, csrf)[0] == 409
            assert post(alice, origin, "select", {
                "account_id": b["account_id"], "expected_revision": 1
            }, csrf)[0] == 200
            assert request(alice, origin, ACCOUNTS + "list")[1]["selection"] == {
                "account_id": b["account_id"], "revision": 2
            }

            status, disc, _ = post(alice, origin, "disconnect", {
                "account_id": b["account_id"], "expected_revision": 2
            }, csrf)
            assert status == 200 and disc["account"]["auth_status"] == "disconnected"
            assert disc["selection"] == {"account_id": None, "revision": 2}
            assert request(alice, origin, ACCOUNTS + "bars")[0] == 409
            assert post(alice, origin, "select", {
                "account_id": b["account_id"], "expected_revision": 2
            }, csrf)[0] == 409
            assert post(alice, origin, "disconnect", {
                "account_id": b["account_id"], "expected_revision": 2
            }, csrf)[0] == 409
            current = request(alice, origin, ACCOUNTS + "list")[1]
            assert len(current["accounts"]) == 3
            assert next(x for x in current["accounts"]
                        if x["account_id"] == a["account_id"])["auth_status"] == "mock_connected"
            assert next(x for x in current["accounts"]
                        if x["account_id"] == d["account_id"])["auth_status"] == "mock_connected"
            assert post(alice, origin, "select", {
                "account_id": d["account_id"], "expected_revision": 2
            }, csrf)[0] == 200
            status, preview_d, _ = request(alice, origin, ACCOUNTS + "bars")
            assert status == 200 and preview_d["account_id"] == d["account_id"]
            assert preview_d["bars"] != preview_a["bars"]

            assert request(other, origin, ACCOUNTS + "list")[1]["accounts"] == []
            assert post(alice, origin, "disconnect", {
                "account_id": "aaaaaaaa-bbbb-5ccc-8ddd-eeeeeeeeeeee",
                "expected_revision": 1
            }, csrf)[0] == 404
            assert request(alice, origin, AUTH + "me")[0] == 200
            print("PASS: HTTP mock accounts owner/tenant isolation, role, CSRF, CAS and selection")

            assert request(alice, origin, ACCOUNTS + "list", "POST", {},)[0] == 405
            assert request(guest, origin, AUTH + "me")[0] == 401
        finally:
            proc.terminate()
            try:
                proc.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.communicate()

        off = php_server({**env, "QSYN_MOCK_ACCOUNTS_ENABLED": "0"},
                         sessions, off_port := open_port())
        try:
            off_origin = "http://127.0.0.1:" + str(off_port)
            await_server(off_origin)
            assert request(client()[0], off_origin, ACCOUNTS + "list")[0] == 503
            print("PASS: mock broker account APIs disabled independently by default")
        finally:
            off.terminate()
            try:
                off.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                off.kill()
                off.communicate()


if __name__ == "__main__":
    run()
