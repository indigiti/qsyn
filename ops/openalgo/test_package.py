#!/usr/bin/env python3
"""Offline regression tests for source pinning and secret-free OpenAlgo packaging."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from package import package


def git(repo: Path, *args: str) -> str:
    return subprocess.check_output(["git", "-C", str(repo), *args], text=True).strip()


class OpenAlgoPackageTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.repo = self.base / "upstream"
        self.repo.mkdir()
        subprocess.check_call(["git", "init", "-q", str(self.repo)])
        git(self.repo, "config", "user.email", "ci@example.invalid")
        git(self.repo, "config", "user.name", "QSYN CI")
        (self.repo / "frontend").mkdir()
        (self.repo / "app.py").write_text("app = object()\n", encoding="utf-8")
        (self.repo / "License.md").write_text("GNU AFFERO GENERAL PUBLIC LICENSE\n", encoding="utf-8")
        (self.repo / ".sample.env").write_text("APP_KEY=PLACEHOLDER\n", encoding="utf-8")
        (self.repo / "frontend" / "package.json").write_text(
            json.dumps({"dependencies": {"openalgo-charts": "2.6.0"}}), encoding="utf-8"
        )
        git(self.repo, "add", ".")
        git(self.repo, "commit", "-qm", "minimal upstream fixture")
        self.commit = git(self.repo, "rev-parse", "HEAD")
        self.lock = self.base / "upstream.lock.json"
        self.update_lock(self.commit)
        built = self.repo / "frontend" / "dist"
        (built / "assets").mkdir(parents=True)
        (built / "index.html").write_text("<html>OpenAlgo React</html>\n", encoding="utf-8")
        (built / "assets" / "app-x.js").write_text("console.log('test')\n", encoding="utf-8")
        (built / "assets" / "app-x.css").write_text("body{}\n", encoding="utf-8")
        (self.repo / ".env").write_text("BROKER_API_SECRET=must-never-ship\n", encoding="utf-8")

    def update_lock(self, commit: str) -> None:
        self.lock.write_text(json.dumps({
            "schema": "QSYN-OPENALGO-FOUNDATION-LOCK/1",
            "upstream": "marketcalls/openalgo",
            "commit": commit,
            "frontend_openalgo_charts": "2.6.0",
            "upstream_license_file": "License.md",
            "application_base_path": "/",
            "integration_target": "isolated-root-origin"
        }), encoding="utf-8")

    def test_package_contains_native_app_and_no_untracked_secrets(self) -> None:
        import tarfile
        output = self.base / "output"
        archive = package(self.repo, output, self.lock)
        with tarfile.open(archive, "r:gz") as tar:
            names = set(tar.getnames())
            self.assertIn("openalgo/app.py", names)
            self.assertIn("openalgo/frontend/dist/assets/app-x.js", names)
            self.assertIn("openalgo/License.md", names)
            self.assertNotIn("openalgo/.env", names)
            self.assertIn("openalgo/.sample.env", names)
        manifest = json.loads((output / "OPENALGO-FOUNDATION-MANIFEST.json").read_text())
        self.assertEqual(manifest["source_commit"], self.commit)
        self.assertEqual(manifest["deployment"], "NOT_DEPLOYED")
        self.assertEqual(manifest["frontend_chart_library_version"], "2.6.0")
        self.assertFalse(manifest["broker_tokens_included"])

    def test_pin_mismatch_rejected(self) -> None:
        self.update_lock("f" * 40)
        with self.assertRaisesRegex(ValueError, "does not match locked"):
            package(self.repo, self.base / "out-mismatch", self.lock)

    def test_tracked_private_env_rejected(self) -> None:
        git(self.repo, "add", ".env")
        git(self.repo, "commit", "-qm", "accidental secret")
        self.update_lock(git(self.repo, "rev-parse", "HEAD"))
        with self.assertRaisesRegex(ValueError, "private/generated"):
            package(self.repo, self.base / "out-leak", self.lock)

    def test_missing_ui_build_rejected(self) -> None:
        (self.repo / "frontend" / "dist" / "index.html").unlink()
        with self.assertRaisesRegex(ValueError, "must be built"):
            package(self.repo, self.base / "out-no-ui", self.lock)


if __name__ == "__main__":
    unittest.main(verbosity=2)
