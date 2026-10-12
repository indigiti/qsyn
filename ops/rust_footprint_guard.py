#!/usr/bin/env python3
"""Fail-closed QSYN release footprint guard; standard-library-only, no network.

Commands: source [repo-root], staging [staging-root], artifact [artifact.zip].
Raise the approved budget only with a measured before/after release, a security
review of native entrypoints and the required repository review.
"""
import argparse
import os
from pathlib import Path, PurePosixPath
import stat
import sys
import tempfile
import tomllib
from zipfile import ZIP_DEFLATED, ZipFile

OPERATOR_MODES = (
    "qsyn-history-import",
    "qsyn-market-archive",
    "qsyn-openalgo-feed",
    "qsyn-private-chart",
    "qsyn-private-history",
    "qsyn-private-index-history",
    "qsyn-upstox-history",
    "qsyn-upstox-index-history",
    "qsyn-upstox-index-worker",
    "qsyn-upstox-worker",
)
RUNTIME = "private/app/bin/qsyn-stream"
BIN_DIR = "private/app/bin/"
MAX_ELF_BYTES = 6_500_000  # measured baseline: 5,430,976
MAX_PAYLOAD_ZIP_BYTES = 4_400_000  # measured estimated baseline: ~3,602,159
MAX_ARTIFACT_ZIP_BYTES = 4_500_000  # GitHub upload baseline: 3,661,122

class GuardFailure(Exception):
    pass

def require(condition, code):
    if not condition:
        raise GuardFailure(code)

def launcher(mode):
    return ('#!/bin/sh\nexec "$(dirname "$0")/qsyn-stream" mode "'
            + mode + '" "$@"\n').encode("ascii")

def check_source(root):
    root = Path(root)
    cargo = root / "services/stream-rust"
    manifest = tomllib.loads((cargo / "Cargo.toml").read_text(encoding="utf-8"))
    package = manifest.get("package", {})
    profile = manifest.get("profile", {}).get("release", {})
    require(package.get("name") == "qsyn-stream", "RUST_CRATE_RENAMED")
    require(package.get("autobins", True) is True, "RUST_AUTOBINS_DISABLED")
    require(not manifest.get("bin"), "RUST_EXTRA_EXPLICIT_BIN_TARGET")
    require(not package.get("build") and not (cargo / "build.rs").exists(),
            "RUST_BUILD_SCRIPT_REQUIRES_ARCHITECTURE_REVIEW")
    require(profile.get("strip") is True, "RUST_RELEASE_STRIP_DISABLED")
    require(profile.get("lto") in ("thin", "fat"), "RUST_RELEASE_LTO_DISABLED")
    require(profile.get("codegen-units") in (1, 2, 3, 4),
            "RUST_RELEASE_CODEGEN_UNITS_EXCEEDED")
    require(profile.get("debug", False) is False, "RUST_RELEASE_DEBUG_ENABLED")
    require(profile.get("opt-level", 3) == 3, "RUST_RELEASE_OPT_LEVEL_CHANGED")
    require((cargo / "src/main.rs").is_file(), "RUST_RUNTIME_MAIN_MISSING")
    bin_root = cargo / "src/bin"
    found = {p.relative_to(bin_root).as_posix() for p in bin_root.rglob("*")
             if p.is_file() or p.is_symlink()}
    expected = {name + ".rs" for name in OPERATOR_MODES}
    require(found == expected, "RUST_BIN_ALLOWLIST_CHANGED:"
            + ",".join(sorted(found ^ expected)))
    workflow = (root / ".github/workflows/release.yml").read_text(encoding="utf-8")
    builds = [line.strip() for line in workflow.splitlines()
              if line.lstrip().startswith("cargo build --release")]
    require(len(builds) == 1, "RUST_RELEASE_BUILD_COUNT_CHANGED")
    require(builds[0].split().count("--bin") == 1
            and "--bin qsyn-stream" in builds[0]
            and "--bins" not in builds[0]
            and "--all-targets" not in builds[0], "RUST_RELEASE_MUST_BUILD_ONE_ELF")
    print("PASS: approved 10 source modes, one release ELF build, optimized release profile")

def check_entries(entries, enforce_executable=True):
    """entries: normalized relative paths -> (raw bytes, unix file mode)."""
    bins = {name for name in entries if name.startswith(BIN_DIR)}
    expected = {RUNTIME} | {BIN_DIR + name for name in OPERATOR_MODES}
    require(bins == expected, "RUST_DEPLOYED_ENTRYPOINTS_CHANGED:"
            + ",".join(sorted(bins ^ expected)))
    elfs = [name for name, (blob, _) in entries.items()
            if blob.startswith(b"\x7fELF")]
    require(elfs == [RUNTIME], "RUST_RELEASE_MUST_CONTAIN_ONE_ELF:"
            + ",".join(elfs))
    runtime_blob, runtime_mode = entries[RUNTIME]
    require(0 < len(runtime_blob) <= MAX_ELF_BYTES, "RUST_ELF_SIZE_BUDGET_EXCEEDED")
    if enforce_executable:
        require(runtime_mode & 0o111, "RUST_ELF_NOT_EXECUTABLE")
    for name in OPERATOR_MODES:
        blob, mode = entries[BIN_DIR + name]
        require(blob == launcher(name), "RUST_WRAPPER_NOT_EXACT:" + name)
        if enforce_executable:
            require(mode & 0o111, "RUST_WRAPPER_NOT_EXECUTABLE:" + name)
    require(not any(name.startswith("public/") and blob.startswith(b"\x7fELF")
                    for name, (blob, _) in entries.items()), "RUST_ELF_IN_PUBLIC_WEBROOT")
    print(f"PASS: exactly one private ELF ({len(runtime_blob):,} bytes), "
          f"{len(OPERATOR_MODES)} fixed executable launchers")

def check_staging(root, enforce_executable=True):
    root = Path(root)
    require(root.is_dir(), "STAGING_ROOT_MISSING")
    entries = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise GuardFailure("RUST_RELEASE_SYMLINK_FORBIDDEN:" + str(path))
        if path.is_file():
            relative = path.relative_to(root).as_posix()
            entries[relative] = (path.read_bytes(), path.stat().st_mode)
    # actions/download-artifact resets file permissions to 0644 on extract.
    # The pre-upload staging pass must still require 0755 executable entries.
    check_entries(entries, enforce_executable=enforce_executable)
    with tempfile.TemporaryDirectory(prefix="qsyn-footprint-") as temp:
        archive = Path(temp) / "payload.zip"
        with ZipFile(archive, "w", ZIP_DEFLATED, compresslevel=9) as output:
            for path in sorted(root.rglob("*")):
                if path.is_file():
                    output.write(path, path.relative_to(root).as_posix())
        actual = archive.stat().st_size
    require(actual <= MAX_PAYLOAD_ZIP_BYTES,
            f"RUST_PAYLOAD_ZIP_BUDGET_EXCEEDED:{actual}>{MAX_PAYLOAD_ZIP_BYTES}")
    print(f"PASS: estimated level-9 deployment ZIP {actual:,} <= "
          f"{MAX_PAYLOAD_ZIP_BYTES:,} bytes")

def check_artifact(path):
    path = Path(path)
    require(path.is_file(), "ARTIFACT_ZIP_NOT_FOUND")
    actual = path.stat().st_size
    require(actual <= MAX_ARTIFACT_ZIP_BYTES,
            f"RUST_ARTIFACT_ZIP_BUDGET_EXCEEDED:{actual}>{MAX_ARTIFACT_ZIP_BYTES}")
    with ZipFile(path) as archive:
        infos = [info for info in archive.infolist() if not info.is_dir()]
        names = [info.filename for info in infos]
        require(len(names) == len(set(names)), "RUST_ARTIFACT_DUPLICATE_ENTRIES")
        require(all(not PurePosixPath(name).is_absolute()
                    and ".." not in PurePosixPath(name).parts
                    for name in names), "RUST_ARTIFACT_UNSAFE_PATH")
        entries = {}
        for info in infos:
            unix_mode = info.external_attr >> 16
            require(not stat.S_ISLNK(unix_mode), "RUST_ARTIFACT_SYMLINK")
            entries[info.filename] = (archive.read(info), unix_mode)
    check_entries(entries)
    print(f"PASS: GitHub artifact {actual:,} <= "
          f"{MAX_ARTIFACT_ZIP_BYTES:,} bytes")

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("source", "staging", "extracted", "artifact"))
    parser.add_argument("path", type=Path, nargs="?")
    args = parser.parse_args()
    path = args.path or (Path(__file__).resolve().parents[1]
                         if args.mode == "source" else None)
    require(path is not None, "REQUIRED_PATH_MISSING")
    {"source": check_source, "staging": check_staging,
     "extracted": lambda directory: check_staging(directory, enforce_executable=False),
     "artifact": check_artifact}[args.mode](path)

if __name__ == "__main__":
    try:
        main()
    except (GuardFailure, OSError, ValueError) as error:
        print(f"QSYN_RUST_FOOTPRINT_GUARD_FAILED: {error}", file=sys.stderr)
        sys.exit(1)
