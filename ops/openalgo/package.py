#!/usr/bin/env python3
"""Build a source-complete, isolated OpenAlgo staging package from a pinned checkout.

This script NEVER deploys, launches a broker, installs a service or changes /qsyn/.
It only packages tracked upstream source plus the locally built React dist.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile

LOCK_SCHEMA = "QSYN-OPENALGO-FOUNDATION-LOCK/1"
MANIFEST_SCHEMA = "QSYN-OPENALGO-FOUNDATION-ARTIFACT/1"


def run(*args: str, cwd: Path | None = None) -> bytes:
    return subprocess.check_output(args, cwd=cwd)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def reject_private_path(relative: PurePosixPath) -> None:
    parts = relative.parts
    if not parts or relative.is_absolute() or ".." in parts:
        raise ValueError("unsafe tracked path")
    if any(part in {".env", ".venv", "node_modules", "__pycache__", ".git"} for part in parts):
        raise ValueError("private/generated file tracked by upstream: " + str(relative))
    if relative.suffix in {".sqlite", ".sqlite3"} or (relative.suffix == ".db" and "test" not in parts):
        raise ValueError("database file unexpectedly tracked by upstream: " + str(relative))


def package(checkout: Path, output: Path, lock_path: Path) -> Path:
    checkout = checkout.resolve(strict=True)
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    if lock.get("schema") != LOCK_SCHEMA:
        raise ValueError("unknown lock schema")
    commit = lock["commit"]
    if len(commit) != 40 or any(c not in "0123456789abcdef" for c in commit):
        raise ValueError("upstream lock must specify a full SHA-1 git commit")
    if lock.get("application_base_path") != "/" or lock.get("integration_target") != "isolated-root-origin":
        raise ValueError("only isolated root-origin staging is supported")
    if lock.get("upstream") != "marketcalls/openalgo":
        raise ValueError("unexpected upstream repository")
    actual = run("git", "rev-parse", "HEAD", cwd=checkout).decode().strip()
    if actual != commit:
        raise ValueError("upstream checkout SHA does not match locked commit")

    package_file = checkout / "frontend" / "package.json"
    frontend = json.loads(package_file.read_text(encoding="utf-8"))
    chart_ver = frontend.get("dependencies", {}).get("openalgo-charts")
    if chart_ver != lock["frontend_openalgo_charts"]:
        raise ValueError("upstream chart dependency is not the reviewed, pinned version")
    license_file = checkout / lock["upstream_license_file"]
    if not license_file.is_file() or "GNU AFFERO GENERAL PUBLIC LICENSE" not in license_file.read_text(encoding="utf-8"):
        raise ValueError("upstream AGPL license not found")
    built = checkout / "frontend" / "dist"
    if not (built / "index.html").is_file() or not (built / "assets").is_dir():
        raise ValueError("upstream React app must be built with npm ci && npm run build")
    if not any((built / "assets").glob("*.js")):
        raise ValueError("no compiled React JavaScript bundles were produced")
    if not any((built / "assets").glob("*.css")):
        raise ValueError("no compiled React CSS bundles were produced")

    output = output.resolve()
    if output == checkout or checkout in output.parents or output in checkout.parents:
        raise ValueError("package output must be isolated from upstream checkout")
    if output.exists():
        raise ValueError("refusing to overwrite existing package directory")
    output.mkdir(parents=True)
    stage = output / "openalgo"
    stage.mkdir()
    tracked = run("git", "ls-files", "-z", cwd=checkout).split(b"\0")
    count = 0
    for name in tracked:
        if not name:
            continue
        relative = PurePosixPath(name.decode("utf-8"))
        # Always use freshly built assets, never a previously committed /dist.
        if relative.parts[:2] == ("frontend", "dist"):
            continue
        reject_private_path(relative)
        src = checkout.joinpath(*relative.parts)
        if src.is_symlink() or not src.is_file():
            raise ValueError("tracked source must be regular file: " + str(relative))
        dst = stage.joinpath(*relative.parts)
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        count += 1

    shutil.copytree(built, stage / "frontend" / "dist", symlinks=False)
    if not (stage / "License.md").exists() or not (stage / "app.py").exists():
        raise ValueError("native Flask application or corresponding source is missing")
    # Never copy .env, runtime token stores or any CI/broker-provided secrets.
    if any(p.name == ".env" for p in stage.rglob("*")):
        raise ValueError("environment secrets leaked into staged source")

    manifest = {
        "schema": MANIFEST_SCHEMA,
        "source_repository": "https://github.com/marketcalls/openalgo",
        "source_commit": actual,
        "upstream_license": "AGPL-3.0",
        "frontend_chart_library_version": chart_ver,
        "frontend_sha256": sha256(stage / "frontend" / "dist" / "index.html"),
        "upstream_lock_sha256": sha256(lock_path),
        "license_sha256": sha256(stage / "License.md"),
        "tracked_source_files": count,
        "deployment": "NOT_DEPLOYED",
        "allowed_public_base": "/",
        "broker_tokens_included": False,
        "runtime_setup": "operator_required",
    }
    (output / "OPENALGO-FOUNDATION-MANIFEST.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    archive = output / "qsyn-openalgo-foundation.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        tar.add(stage, arcname="openalgo", recursive=True)
        tar.add(output / "OPENALGO-FOUNDATION-MANIFEST.json", arcname="OPENALGO-FOUNDATION-MANIFEST.json")
    # Ensure archive is readable and includes the critical native app deliverables.
    with tarfile.open(archive, "r:gz") as tar:
        names = set(tar.getnames())
        for required in ["openalgo/app.py", "openalgo/License.md", "openalgo/frontend/dist/index.html",
                         "OPENALGO-FOUNDATION-MANIFEST.json"]:
            if required not in names:
                raise ValueError("archive is incomplete: " + required)
        if any(name.endswith("/.env") for name in names):
            raise ValueError("archive contains runtime credentials")
    print(json.dumps({"package": str(archive), "commit": actual, "tracked_files": count}))
    return archive


def main() -> None:
    parser = argparse.ArgumentParser(description="Build pinned, source-complete OpenAlgo foundation artifact")
    parser.add_argument("--checkout", type=Path, required=True, help="pinned upstream checkout")
    parser.add_argument("--output", type=Path, required=True, help="new output directory; never overwritten")
    parser.add_argument("--lock", type=Path, default=Path(__file__).with_name("upstream.lock.json"))
    args = parser.parse_args()
    package(args.checkout, args.output, args.lock)


if __name__ == "__main__":
    main()
