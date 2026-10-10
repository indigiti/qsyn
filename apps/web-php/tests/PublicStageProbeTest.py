#!/usr/bin/env python3
"""Local regression for the read-only public exposure / runtime check."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile

from IdentityHttpSmoke import await_server, open_port, php_server
from PublicStageProbe import origin_and_path

ROOT = Path(__file__).resolve().parents[3]
PROBE = ROOT / "apps/web-php/tests/PublicStageProbe.py"


def run_probe(url, *, expected=None):
    args = [sys.executable, str(PROBE), "--url", url, "--allow-loopback"]
    if expected:
        args += ["--expected-commit", expected]
    return subprocess.run(args, cwd=ROOT, capture_output=True, text=True, timeout=30)


def local_php(env, sessions):
    port = open_port()
    origin = f"http://127.0.0.1:{port}"
    server = php_server(env, sessions, port)
    await_server(origin)
    return server, origin


def stop(server):
    server.terminate()
    try:
        server.communicate(timeout=5)
    except subprocess.TimeoutExpired:
        server.kill()
        server.communicate()


def run():
    try:
        origin_and_path("https://stage.digiti.in/qsyn", False)
        for bad in ["http://stage.digiti.in/qsyn", "https://stage.digiti.in.evil.test/qsyn/x",
                    "https://user:secret@stage.digiti.in/qsyn",
                    "https://stage.digiti.in/qsyn?token=secret"]:
            try:
                origin_and_path(bad, False)
            except ValueError:
                continue
            raise AssertionError("Unsafe probe target accepted")
    except Exception as error:
        raise AssertionError(f"Probe URL validation failed: {error}") from error

    with tempfile.TemporaryDirectory(prefix="qsyn-public-negative-") as tmp:
        sessions = Path(tmp) / "sessions"
        private = Path(tmp) / "private"
        sessions.mkdir(mode=0o700)
        private.mkdir(mode=0o700)
        disabled = os.environ.copy()
        for key in ["QSYN_IDENTITY_ENABLED", "QSYN_MOCK_ACCOUNTS_ENABLED",
                    "QSYN_DASHBOARD_ENABLED", "QSYN_IDENTITY_STORAGE_DIR",
                    "QSYN_ALLOW_HTTP_TEST"]:
            disabled.pop(key, None)
        disabled["QSYN_ENV"] = "test"
        server, origin = local_php(disabled, sessions)
        try:
            probe = run_probe(origin + "/qsyn")
            assert probe.returncode == 0, (probe.stdout, probe.stderr)
            assert "public Phase 1 account features are inaccessible" in probe.stdout
            # Local Rust does not run in this test, so a specific deployment
            # commit must fail rather than reporting an unverified success.
            mismatch = run_probe(origin + "/qsyn", expected="a" * 40)
            assert mismatch.returncode != 0, mismatch.stdout
        finally:
            stop(server)

        open_identity = {
            **disabled, "QSYN_ALLOW_HTTP_TEST": "1",
            "QSYN_IDENTITY_ENABLED": "1",
            "QSYN_IDENTITY_STORAGE_DIR": str(private),
        }
        server, origin = local_php(open_identity, sessions)
        try:
            probe = run_probe(origin + "/qsyn")
            assert probe.returncode != 0, (probe.stdout, probe.stderr)
            assert "publicly reachable" in probe.stderr
        finally:
            stop(server)

        enabled_ui = {
            **open_identity, "QSYN_MOCK_ACCOUNTS_ENABLED": "1",
            "QSYN_DASHBOARD_ENABLED": "1",
        }
        server, origin = local_php(enabled_ui, sessions)
        try:
            probe = run_probe(origin + "/qsyn")
            assert probe.returncode != 0, (probe.stdout, probe.stderr)
        finally:
            stop(server)

    print("PASS: read-only public probe detects disabled gate, exposed login/UI and runtime mismatch")


if __name__ == "__main__":
    run()
