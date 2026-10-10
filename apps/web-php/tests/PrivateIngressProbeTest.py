#!/usr/bin/env python3
"""Disposable localhost acceptance fixtures; never probes live Cloudways."""
import copy
import datetime as dt
import io
import json
import os
from pathlib import Path
import socket
import tempfile
import urllib.error

from IdentityHttpSmoke import await_server, open_port, php_server
from PrivateIngressProbe import private_target, run_probe
from VerifyPrivateIngressEvidence import verify_pair

TEST_HOST = "127.0.0.1"


class DeniedAtEdge:
    """Test-only stand-in for an ingress ACL that denies every GET."""
    def open(self, req, timeout=None):
        raise urllib.error.HTTPError(req.full_url, 403, "Forbidden",
                                     {"Content-Type": "application/json"},
                                     io.BytesIO(b'{"error":"restricted"}'))


class NoDns:
    def open(self, req, timeout=None):
        raise urllib.error.URLError(socket.gaierror(-2, "mock DNS failure"))


def rejected(callable_fn):
    try:
        callable_fn()
    except (ValueError, AssertionError):
        return True
    return False


def run():
    assert rejected(lambda: private_target("https://stage.digiti.in/qsyn"))
    assert rejected(lambda: private_target("http://private.digiti.in/qsyn"))
    assert rejected(lambda: private_target("https://user:pass@private.digiti.in/qsyn"))
    assert rejected(lambda: private_target("https://private.digiti.in/qsyn?token=x"))
    with tempfile.TemporaryDirectory(prefix="qsyn-dual-vantage-") as tmp:
        path = Path(tmp)
        private = path / "private"
        sessions = path / "sessions"
        private.mkdir(mode=0o700)
        sessions.mkdir(mode=0o700)
        env = {
            **os.environ,
            "QSYN_ENV": "test", "QSYN_ALLOW_HTTP_TEST": "1",
            "QSYN_IDENTITY_ENABLED": "1",
            "QSYN_MOCK_ACCOUNTS_ENABLED": "1",
            "QSYN_DASHBOARD_ENABLED": "1",
            "QSYN_IDENTITY_STORAGE_DIR": str(private),
        }
        port = open_port()
        origin = f"http://{TEST_HOST}:{port}"
        server = php_server(env, sessions, port)
        try:
            await_server(origin)
            inside = run_probe(origin + "/qsyn", "inside", "allowed-net",
                               allow_loopback_ci=True)
            outside = run_probe(origin + "/qsyn", "outside", "denied-net",
                                allow_loopback_ci=True, opener=DeniedAtEdge())
            assert inside["observations"]["auth_shell"] == "anonymous_mock_only"
            assert inside["observations"]["cookie_security"] == "checked"
            assert all(value == "edge_denial_403"
                       for value in outside["observations"].values())
            assert rejected(lambda: run_probe(origin + "/qsyn", "outside", "denied-net",
                                              allow_loopback_ci=True))
            assert rejected(lambda: run_probe(origin + "/qsyn", "outside", "denied-net",
                                              allow_loopback_ci=True, opener=NoDns()))
            assert rejected(lambda: verify_pair(inside, outside))
            result = verify_pair(inside, outside, allow_loopback_ci=True)
            assert result["evidence"] == "consistent"
            assert result["private_access_approval"] is False
            assert result["requires_operator_network_attestation"] is True
            altered = copy.deepcopy(outside)
            altered["target_sha256"] = "f" * 64
            assert rejected(lambda: verify_pair(inside, altered, allow_loopback_ci=True))
            altered = copy.deepcopy(outside)
            altered["vantage"] = inside["vantage"]
            assert rejected(lambda: verify_pair(inside, altered, allow_loopback_ci=True))
            altered = copy.deepcopy(outside)
            altered["observations"]["health"] = "edge_denial_404"
            assert rejected(lambda: verify_pair(inside, altered, allow_loopback_ci=True))
            altered = copy.deepcopy(outside)
            altered["observed_at"] = (dt.datetime.now(dt.timezone.utc) -
                                       dt.timedelta(hours=26)).isoformat()
            assert rejected(lambda: verify_pair(inside, altered, allow_loopback_ci=True))
            altered = copy.deepcopy(inside)
            altered["observations"]["anonymous_accounts"] = "http_200"
            assert rejected(lambda: verify_pair(altered, outside, allow_loopback_ci=True))

            # Persist and reload safe structured evidence, ensuring neither
            # session cookies nor CSRF tokens have been serialized.
            for side, receipt in [("inside", inside), ("outside", outside)]:
                output = path / (side + ".json")
                output.write_text(json.dumps(receipt), encoding="utf-8")
                payload = output.read_text(encoding="utf-8")
                assert "QSYN_USER_SESSION" not in payload
                assert '"csrf":' not in payload
                assert json.loads(payload) == receipt
        finally:
            server.terminate()
            try:
                server.communicate(timeout=5)
            except Exception:
                server.kill()
                server.communicate()

    print("PASS: two-sided ingress evidence, blocked network, session shell, mismatches and secret redaction")


if __name__ == "__main__":
    run()
