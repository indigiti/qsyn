#!/usr/bin/env python3
"""Contract/regression tests for the fail-closed QSYN Rust footprint guard."""
import importlib.util
from pathlib import Path
import os
import shutil
import stat
import tempfile
import unittest
from zipfile import ZIP_DEFLATED, ZipFile

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("qsyn_guard", HERE / "rust_footprint_guard.py")
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)

class FootprintGuardTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="qsyn-guard-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        project = HERE.parent
        cargo = self.root / "services/stream-rust"
        (cargo / "src/bin").mkdir(parents=True)
        shutil.copyfile(project / "services/stream-rust/Cargo.toml", cargo / "Cargo.toml")
        (cargo / "src/main.rs").write_text("fn main() {}\n")
        for mode in guard.OPERATOR_MODES:
            (cargo / "src/bin" / (mode + ".rs")).write_text("fn main() {}\n")
        workflows = self.root / ".github/workflows"
        workflows.mkdir(parents=True)
        shutil.copyfile(project / ".github/workflows/release.yml",
                        workflows / "release.yml")

    def assert_denied(self, operation, code):
        with self.assertRaisesRegex(guard.GuardFailure, code):
            operation()

    def test_current_allowlist_passes(self):
        guard.check_source(self.root)

    def test_unreviewed_new_rust_target_fails(self):
        (self.root / "services/stream-rust/src/bin/another.rs").write_text("fn main() {}\n")
        self.assert_denied(lambda: guard.check_source(self.root),
                           "RUST_BIN_ALLOWLIST_CHANGED")

    def test_extra_explicit_binary_target_fails(self):
        cargo = self.root / "services/stream-rust/Cargo.toml"
        cargo.write_text(cargo.read_text() + '\n[[bin]]\nname="unplanned"\npath="src/main.rs"\n')
        self.assert_denied(lambda: guard.check_source(self.root),
                           "RUST_EXTRA_EXPLICIT_BIN_TARGET")

    def test_release_profile_or_build_expansion_fails(self):
        cargo = self.root / "services/stream-rust/Cargo.toml"
        cargo.write_text(cargo.read_text().replace("strip = true", "strip = false"))
        self.assert_denied(lambda: guard.check_source(self.root),
                           "RUST_RELEASE_STRIP_DISABLED")
        cargo.write_text(cargo.read_text().replace("strip = false", "strip = true"))
        workflow = self.root / ".github/workflows/release.yml"
        workflow.write_text(workflow.read_text() + "\n      cargo build --release --bins\n")
        self.assert_denied(lambda: guard.check_source(self.root),
                           "RUST_RELEASE_BUILD_COUNT_CHANGED")

    def stage(self):
        root = self.root / "staging"
        bindir = root / guard.BIN_DIR
        bindir.mkdir(parents=True, exist_ok=True)
        stream = bindir / "qsyn-stream"
        stream.write_bytes(b"\x7fELF" + b"small-fixture")
        stream.chmod(0o755)
        for mode in guard.OPERATOR_MODES:
            wrapper = bindir / mode
            wrapper.write_bytes(guard.launcher(mode))
            wrapper.chmod(0o755)
        (root / "public").mkdir()
        (root / "public/index.php").write_text("<?php // fixture")
        return root

    def test_only_one_elf_and_exact_launchers(self):
        root = self.stage()
        guard.check_staging(root)
        (root / guard.BIN_DIR / "qsyn-extra").write_bytes(b"\x7fELF")
        self.assert_denied(lambda: guard.check_staging(root),
                           "RUST_DEPLOYED_ENTRYPOINTS_CHANGED")
        (root / guard.BIN_DIR / "qsyn-extra").unlink()
        wrapper = root / guard.BIN_DIR / guard.OPERATOR_MODES[0]
        wrapper.write_text("#!/bin/sh\ntrue\n")
        self.assert_denied(lambda: guard.check_staging(root),
                           "RUST_WRAPPER_NOT_EXACT")

    def test_non_executable_wrapper_and_oversize_elf_fail(self):
        root = self.stage()
        wrapper = root / guard.BIN_DIR / guard.OPERATOR_MODES[0]
        wrapper.chmod(0o644)
        self.assert_denied(lambda: guard.check_staging(root),
                           "RUST_WRAPPER_NOT_EXECUTABLE")
        wrapper.chmod(0o755)
        stream = root / guard.RUNTIME
        with stream.open("wb") as handle:
            handle.write(b"\x7fELF")
            handle.truncate(guard.MAX_ELF_BYTES + 1)
        self.assert_denied(lambda: guard.check_staging(root),
                           "RUST_ELF_SIZE_BUDGET_EXCEEDED")

    def test_download_artifact_permission_normalization(self):
        root = self.stage()
        for path in (root / guard.BIN_DIR).iterdir():
            path.chmod(0o644)
        self.assert_denied(lambda: guard.check_staging(root),
                           "RUST_ELF_NOT_EXECUTABLE")
        # The extracted copy must retain strict ELF count, launcher bytes,
        # size and placement checks even though ZIP extraction strips modes.
        guard.check_staging(root, enforce_executable=False)

    def test_zip_entry_security_and_artifact_cap(self):
        root = self.stage()
        artifact = self.root / "release.zip"
        with ZipFile(artifact, "w", ZIP_DEFLATED, compresslevel=9) as archive:
            for p in root.rglob("*"):
                if p.is_file():
                    archive.write(p, p.relative_to(root))
        guard.check_artifact(artifact)
        old_cap = guard.MAX_ARTIFACT_ZIP_BYTES
        try:
            guard.MAX_ARTIFACT_ZIP_BYTES = 20
            self.assert_denied(lambda: guard.check_artifact(artifact),
                               "RUST_ARTIFACT_ZIP_BUDGET_EXCEEDED")
        finally:
            guard.MAX_ARTIFACT_ZIP_BYTES = old_cap
        with ZipFile(artifact, "a") as archive:
            archive.writestr("../malicious", "bad")
        self.assert_denied(lambda: guard.check_artifact(artifact),
                           "RUST_ARTIFACT_UNSAFE_PATH")

if __name__ == "__main__":
    unittest.main()
