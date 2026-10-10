#!/usr/bin/env python3
"""Offline safety/contract tests for QSYN's read-only host inventory."""
from __future__ import annotations

import os
from pathlib import Path
import subprocess
import unittest


SCRIPT = Path(__file__).with_name("host-readiness.sh")


def run_probe(*args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["/bin/sh", str(SCRIPT), *args],
        text=True, capture_output=True, check=False,
        timeout=10, env=env,
    )


def parse_report(output: str) -> dict[str, str]:
    lines = output.splitlines()
    assert lines and all(line.count("=") == 1 for line in lines), lines
    result = dict(line.split("=", 1) for line in lines)
    assert len(result) == len(lines), "duplicate report keys"
    return result


class ReadOnlyHostReadinessTests(unittest.TestCase):
    def test_report_never_equates_detection_with_approval(self) -> None:
        result = run_probe()
        self.assertEqual(result.returncode, 0, result.stderr)
        report = parse_report(result.stdout)
        self.assertEqual(report["report_schema"], "QSYN-OPENALGO-HOST-READINESS/1")
        self.assertIn(report["python_312"], {"pass", "missing"})
        self.assertIn(report["python_venv"], {"pass", "missing", "not_checked"})
        self.assertIn(report["runtime_user"], {"root", "nonroot", "unknown"})
        for key in ("manager_authorization", "persistent_private_storage",
                    "http_tls_proxy", "websocket_upgrade",
                    "broker_egress", "reboot_recovery"):
            self.assertEqual(report[key], "UNVERIFIED")
        self.assertEqual(report["host_approved"], "NO")

    def test_no_secret_or_environment_echo(self) -> None:
        env = os.environ.copy()
        secret = "QSYN_NEVER_PRINT_PRIVATE_TOKEN_441122"
        env.update({
            "QSYN_TEST_BROKER_SECRET": secret,
            "BROKER_API_KEY": secret,
            "APP_KEY": secret,
            "FERNET_SALT": secret,
        })
        result = run_probe(env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(secret, result.stdout + result.stderr)
        self.assertNotIn("BROKER_API_KEY", result.stdout + result.stderr)

    def test_minimal_host_without_commands_still_reports_unverified(self) -> None:
        result = run_probe(env={"PATH": "/qsyn-intentionally-nonexistent"})
        self.assertEqual(result.returncode, 0, result.stderr)
        report = parse_report(result.stdout)
        self.assertEqual(report["python_312"], "missing")
        self.assertEqual(report["process_manager"], "none_detected")
        self.assertEqual(report["host_approved"], "NO")

    def test_reject_arguments_without_using_them(self) -> None:
        result = run_probe("--config", "/path/to/secret")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")
        self.assertNotIn("/path/to/secret", result.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
