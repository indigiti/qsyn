#!/usr/bin/env python3
"""Structural CLI-only public/private deployment gate regression."""
import os
from pathlib import Path
import subprocess
import tempfile

TOOL = Path(__file__).resolve().parents[1] / "tools/private-deployment-preflight.php"
NAMES = [
    "QSYN_IDENTITY_ENABLED", "QSYN_MOCK_ACCOUNTS_ENABLED",
    "QSYN_DASHBOARD_ENABLED", "QSYN_FIXTURE_BOOTSTRAP_ENABLED",
]


def invoke(env, mode):
    return subprocess.run(
        ["php", str(TOOL), mode],
        env=env, text=True, capture_output=True, timeout=15,
    )


def must_pass(env, mode):
    result = invoke(env, mode)
    assert result.returncode == 0, (mode, result.stdout, result.stderr)
    assert "PASS:" in result.stdout and "LIMIT:" in result.stdout
    assert "approved" not in result.stdout
    return result


def must_fail(env, mode):
    result = invoke(env, mode)
    assert result.returncode != 0, (mode, result.stdout, result.stderr)
    assert "FAIL:" in result.stderr
    return result


def run():
    baseline = os.environ.copy()
    for key in [*NAMES, "QSYN_IDENTITY_ALLOWED_HOST", "QSYN_IDENTITY_STORAGE_DIR",
                "QSYN_PUBLIC_STAGING_APP_ROOT", "QSYN_PRIVATE_APP_ROOT",
                "QSYN_PUBLIC_STAGING_DOCROOT", "QSYN_PRIVATE_PUBLIC_DOCROOT"]:
        baseline.pop(key, None)
    must_pass(baseline, "public-disabled")
    must_fail(baseline, "unknown")
    for flag in NAMES:
        must_fail({**baseline, flag: "1"}, "public-disabled")
        must_fail({**baseline, flag: "true"}, "public-disabled")
    with tempfile.TemporaryDirectory(prefix="qsyn-separate-app-preflight-") as root:
        parent = Path(root)
        public_app = parent / "public_app"
        public_web = public_app / "public_html"
        private_app = parent / "private_app"
        private_web = private_app / "public_html"
        store = private_app / "private_store"
        for directory in [public_app, public_web, private_app, private_web, store]:
            directory.mkdir(mode=0o700, exist_ok=True)

        env = {
            **baseline,
            "QSYN_ENV": "development",
            "QSYN_IDENTITY_ALLOWED_HOST": "preview.digiti.in",
            "QSYN_PUBLIC_STAGING_APP_ROOT": str(public_app),
            "QSYN_PRIVATE_APP_ROOT": str(private_app),
            "QSYN_PUBLIC_STAGING_DOCROOT": str(public_web),
            "QSYN_PRIVATE_PUBLIC_DOCROOT": str(private_web),
            "QSYN_IDENTITY_STORAGE_DIR": str(store),
        }
        out = must_pass(env, "private-preparation")
        assert str(parent) not in out.stdout
        assert str(parent) not in out.stderr

        for host in ["stage.digiti.in", "digiti.in", "www.digiti.in",
                     "localhost", "127.0.0.1", "bad path", ""]:
            must_fail({**env, "QSYN_IDENTITY_ALLOWED_HOST": host}, "private-preparation")
        for flag in NAMES:
            must_fail({**env, flag: "1"}, "private-preparation")
        must_fail({**env, "QSYN_ENV": "production"}, "private-preparation")

        # A private hostname aliased onto the original app is not separation.
        must_fail({**env, "QSYN_PRIVATE_APP_ROOT": str(public_app)}, "private-preparation")
        must_fail({**env, "QSYN_PRIVATE_PUBLIC_DOCROOT": str(public_web)}, "private-preparation")
        must_fail({**env, "QSYN_PRIVATE_PUBLIC_DOCROOT": str(store)}, "private-preparation")
        must_fail({**env, "QSYN_IDENTITY_STORAGE_DIR": str(public_web)}, "private-preparation")

        # Path guards catch symlinks and world/group accessible fixture stores.
        alias = parent / "private_store_symlink"
        alias.symlink_to(store, target_is_directory=True)
        must_fail({**env, "QSYN_IDENTITY_STORAGE_DIR": str(alias)}, "private-preparation")
        alias.unlink()
        store.chmod(0o750)
        must_fail(env, "private-preparation")
        store.chmod(0o700)
        must_pass(env, "private-preparation")

        # No unrecognized CLI modes or arguments.
        result = subprocess.run(
            ["php", str(TOOL), "private-preparation", "--enable"],
            env=env, text=True, capture_output=True, timeout=15)
        assert result.returncode != 0
    print("PASS: fail-closed public/private structural gates, safe separation, modes and flags")


if __name__ == "__main__":
    run()
