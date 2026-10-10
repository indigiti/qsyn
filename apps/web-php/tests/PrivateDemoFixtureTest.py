#!/usr/bin/env python3
"""Offline fixture CLI + HTTP acceptance with disposable, loopback-only storage."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

from IdentityHttpSmoke import await_server, client, open_port, php_server, request

ROOT = Path(__file__).resolve().parents[3]
TOOL = ROOT / "apps/web-php/tools/private-demo-fixtures.php"
AUTH = "/qsyn/api/v1/auth/"
ACCOUNTS = "/qsyn/api/v1/accounts/"
PASSWORD = "CI-only-fixture-synthetic-secret-8732"


def run_fixture(env, args, secret=None):
    return subprocess.run(
        ["php", str(TOOL), *args], cwd=ROOT, env=env,
        input=secret, text=True, capture_output=True, timeout=20,
    )


def require_success(proc, action):
    assert proc.returncode == 0, (action, proc.stdout, proc.stderr)
    assert PASSWORD not in (proc.stdout + proc.stderr)


def signin(opener, origin, tenant, username):
    status, state, _ = request(opener, origin, AUTH + "state")
    assert status == 200 and state["authenticated"] is False, state
    status, login, _ = request(opener, origin, AUTH + "login", "POST", {
        "tenant": tenant, "username": username, "password": PASSWORD
    }, state["csrf"])
    assert status == 200 and login["authenticated"] is True, login
    return login["csrf"]


def run():
    with tempfile.TemporaryDirectory(prefix="qsyn-acceptance-fixtures-") as tmp:
        root = Path(tmp) / "identity-private"
        root.mkdir(mode=0o700)
        webroot = ROOT / "apps/web-php/public"
        session_dir = Path(tmp) / "sessions"
        session_dir.mkdir(mode=0o700)
        env = {
            **os.environ,
            "CI": "true", "QSYN_ENV": "test",
            "QSYN_ALLOW_HTTP_TEST": "1",
            "QSYN_FIXTURE_BOOTSTRAP_ENABLED": "1",
            "QSYN_FIXTURE_CI": "1",
            "QSYN_IDENTITY_STORAGE_DIR": str(root),
            "QSYN_PRIVATE_PUBLIC_DOCROOT": str(webroot),
            "QSYN_IDENTITY_ENABLED": "1",
            "QSYN_MOCK_ACCOUNTS_ENABLED": "1",
            "QSYN_DASHBOARD_ENABLED": "1",
        }
        # A missing explicit bootstrap gate must deny writes.
        denied = run_fixture({**env, "QSYN_FIXTURE_BOOTSTRAP_ENABLED": "0"},
                             ["seed", "tenant-one", "alice", "member"], PASSWORD + "\n")
        assert denied.returncode != 0
        assert list(root.iterdir()) == []

        # No creation in the public docroot or under a world-readable store.
        invalid = run_fixture({**env, "QSYN_IDENTITY_STORAGE_DIR": str(webroot)},
                              ["seed", "tenant-one", "alice", "member"], PASSWORD + "\n")
        assert invalid.returncode != 0
        root.chmod(0o755)
        invalid = run_fixture(env, ["seed", "tenant-one", "alice", "member"], PASSWORD + "\n")
        assert invalid.returncode != 0
        root.chmod(0o700)
        invalid = run_fixture({**env, "QSYN_ENV": "development",
                               "QSYN_PRIVATE_STAGING_CONFIRMED": "1",
                               "QSYN_IDENTITY_ALLOWED_HOST": "stage.digiti.in"},
                              ["seed", "tenant-one", "alice", "member"], PASSWORD + "\n")
        assert invalid.returncode != 0
        assert list(root.iterdir()) == []

        invalid = run_fixture(env, ["seed", "tenant-one", "bob", "viewer",
                                    "--with-mock-accounts"], PASSWORD + "\n")
        assert invalid.returncode != 0
        assert list(root.iterdir()) == []

        alice = run_fixture(env, ["seed", "tenant-one", "alice", "member",
                                  "--with-mock-accounts"], PASSWORD + "\n")
        require_success(alice, "create Alice")
        assert "mock_accounts=3" in alice.stdout
        bob = run_fixture(env, ["seed", "tenant-one", "bob", "viewer"], PASSWORD + "\n")
        require_success(bob, "create Bob viewer")
        another = run_fixture(env, ["seed", "tenant-two", "alice", "member",
                                    "--with-mock-accounts"], PASSWORD + "\n")
        require_success(another, "create Alice in another tenant")

        # Exact same identity must be rejected, not overwritten/reset.
        duplicate = run_fixture(env, ["seed", "tenant-one", "alice", "member"], PASSWORD + "\n")
        assert duplicate.returncode != 0
        assert "already exists" in duplicate.stderr
        raw = " ".join(file.read_text() for file in (root / "mock_users").glob("*.json"))
        assert PASSWORD not in raw
        assert len(list((root / "mock_users").glob("*.json"))) == 3
        assert len(list((root / "mock_broker_accounts").glob("*.json"))) == 6
        assert all((file.stat().st_mode & 0o777) == 0o600
                   for collection in ("mock_users", "mock_broker_accounts")
                   for file in (root / collection).glob("*.json"))

        port = open_port()
        origin = f"http://127.0.0.1:{port}"
        proc = php_server(env, session_dir, port)
        try:
            await_server(origin)
            alice_client, _ = client()
            csrf_alice = signin(alice_client, origin, "tenant-one", "alice")
            status, accounts, _ = request(alice_client, origin, ACCOUNTS + "list")
            assert status == 200
            assert len(accounts["accounts"]) == 3
            assert {x["broker_code"] for x in accounts["accounts"]} == {"upstox", "dhan"}
            assert all(x["execution_allowed"] is False and x["feed_entitlements"] == ["simulated"]
                       for x in accounts["accounts"])
            assert accounts["selection"]["account_id"] is None

            bob_client, _ = client()
            csrf_bob = signin(bob_client, origin, "tenant-one", "bob")
            assert request(bob_client, origin, ACCOUNTS + "list")[1]["accounts"] == []
            assert request(bob_client, origin, ACCOUNTS + "link", "POST", {
                "broker_code": "dhan", "mock_reference": "mock-denied",
                "display_label": "not allowed"
            }, csrf_bob)[0] == 403

            other_client, _ = client()
            signin(other_client, origin, "tenant-two", "alice")
            assert len(request(other_client, origin, ACCOUNTS + "list")[1]["accounts"]) == 3
            assert request(other_client, origin, ACCOUNTS + "get?id=" +
                           accounts["accounts"][0]["account_id"])[0] == 404

            first_id = accounts["accounts"][0]["account_id"]
            status, chosen, _ = request(alice_client, origin, ACCOUNTS + "select", "POST", {
                "account_id": first_id, "expected_revision": 0
            }, csrf_alice)
            assert status == 200 and chosen["selection"]["account_id"] == first_id
            assert request(alice_client, origin, ACCOUNTS + "bars")[0] == 200
            assert request(bob_client, origin, ACCOUNTS + "bars")[0] == 409
            assert request(other_client, origin, ACCOUNTS + "bars")[0] == 409

            disabled = run_fixture(env, ["revoke", "tenant-one", "alice"])
            require_success(disabled, "revoke Alice")
            assert request(alice_client, origin, ACCOUNTS + "list")[0] == 401
            assert request(alice_client, origin, ACCOUNTS + "bars")[0] == 401
            assert len(request(other_client, origin, ACCOUNTS + "list")[1]["accounts"]) == 3
            double_revoke = run_fixture(env, ["revoke", "tenant-one", "alice"])
            assert double_revoke.returncode != 0
        finally:
            proc.terminate()
            try:
                proc.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.communicate()

    print("PASS: offline fixture gating, secret-free seeding, tenant isolation and immediate session revocation")


if __name__ == "__main__":
    run()
