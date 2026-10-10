#!/usr/bin/env python3
"""Offline Phase 1.12 regression, disposable PHP loopback only."""
import copy
import datetime as dt
import io
import json
import os
import pathlib
import socket
import tempfile
import urllib.error
from IdentityHttpSmoke import await_server, open_port, php_server
from PrivateBaselineProbe import run_probe, verify_pair, target_for_baseline


class DeniedEdge:
    def open(self, req, timeout=None):
        raise urllib.error.HTTPError(req.full_url, 403, "Denied",
            {"Content-Type": "text/html"}, io.BytesIO(b"denied"))


def reject(fn):
    try:
        fn()
    except (ValueError, AssertionError):
        return
    raise AssertionError("Unsafe baseline passed")


def run():
    reject(lambda: target_for_baseline("https://stage.digiti.in/qsyn"))
    reject(lambda: target_for_baseline("http://private.digiti.in/qsyn"))
    reject(lambda: target_for_baseline("https://127.0.0.1/qsyn"))
    reject(lambda: target_for_baseline("https://user:pass@private.digiti.in/qsyn"))
    with tempfile.TemporaryDirectory() as root:
        env = os.environ.copy()
        for key in ("QSYN_IDENTITY_ENABLED", "QSYN_MOCK_ACCOUNTS_ENABLED",
                    "QSYN_DASHBOARD_ENABLED", "QSYN_FIXTURE_BOOTSTRAP_ENABLED"):
            env[key] = "0"
        env["QSYN_ENV"] = "test"
        port = open_port()
        origin = f"http://127.0.0.1:{port}"
        sessions = pathlib.Path(root) / "sessions"
        sessions.mkdir(mode=0o700)
        proc = php_server(env, sessions, port)
        try:
            await_server(origin)
            inside = run_probe(origin + "/qsyn", "inside", "allowed-lab",
                               allow_loopback_ci=True)
            outside = run_probe(origin + "/qsyn", "outside", "denied-lab",
                                allow_loopback_ci=True, opener=DeniedEdge())
            assert inside["observations"]["identity"] == "denied"
            assert inside["observations"]["demo_bars"] == "simulated"
            reject(lambda: verify_pair(inside, outside))
            ok = verify_pair(inside, outside, allow_loopback_ci=True)
            assert ok["enable_accounts"] is False
            assert ok["private_access_approval"] is False
            reject(lambda: run_probe(origin + "/qsyn", "inside", "a",
                                     allow_loopback_ci=True))
            bad = copy.deepcopy(inside)
            bad["observations"]["identity"] = "allowed"
            reject(lambda: verify_pair(bad, outside, allow_loopback_ci=True))
            bad = copy.deepcopy(inside)
            bad["observations"]["rust"] = "online_trading"
            reject(lambda: verify_pair(bad, outside, allow_loopback_ci=True))
            bad = copy.deepcopy(outside)
            bad["observations"]["dashboard"] = "edge_denial_404"
            reject(lambda: verify_pair(inside, bad, allow_loopback_ci=True))
            bad = copy.deepcopy(outside)
            bad["target_sha256"] = "f" * 64
            reject(lambda: verify_pair(inside, bad, allow_loopback_ci=True))
            bad = copy.deepcopy(outside)
            bad["vantage"] = "allowed-lab"
            reject(lambda: verify_pair(inside, bad, allow_loopback_ci=True))
            bad = copy.deepcopy(outside)
            bad["observed_at"] = (dt.datetime.now(dt.timezone.utc) -
                                  dt.timedelta(hours=25)).isoformat()
            reject(lambda: verify_pair(inside, bad, allow_loopback_ci=True))
            bad = copy.deepcopy(inside)
            bad["localhost_simulation"] = "no"
            reject(lambda: verify_pair(bad, outside, allow_loopback_ci=True))
            assert "cookie" not in json.dumps(inside).lower()
            assert "csrf" not in json.dumps(inside).lower()
        finally:
            proc.terminate()
            try:
                proc.communicate(timeout=5)
            except Exception:
                proc.kill()
                proc.communicate()
    print("PASS: disabled-feature pre-activation, two-vantage consistency and rejection cases")


if __name__ == "__main__":
    run()
