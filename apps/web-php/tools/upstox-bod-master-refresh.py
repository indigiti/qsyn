#!/usr/bin/env python3
"""Import complete official Upstox NSE/BSE BOD JSON.GZ masters into private QSYN files.

Operator-only CLI. Does not configure brokers, start Rust, expose public prices,
or assert exchange display rights. Uses existing streaming JSON parser.
"""
from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import secrets
import shutil
import stat
import sys
import urllib.request

SOURCES = {
    "NSE": "https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz",
    "BSE": "https://assets.upstox.com/market-quote/instruments/exchange/BSE.json.gz",
}
TYPES = {"NSE_EQ", "NSE_INDEX", "NSE_FO", "NCD_FO", "NSE_COM",
         "BSE_EQ", "BSE_INDEX", "BSE_FO", "BCD_FO"}
MAX_COMPRESSED = 100_000_000
MAX_RECORDS = 2_000_000
KEY = re.compile(r"^(NSE_EQ|NSE_INDEX|NSE_FO|NCD_FO|NSE_COM|BSE_EQ|BSE_INDEX|BSE_FO|BCD_FO)\|[^\x00-\x1f\x7f]{1,100}$")
SIMPLE = re.compile(r"^[^\x00-\x1f\x7f]{1,180}$")


def safe_root(root: Path) -> Path:
    resolved = root.resolve(strict=True)
    if not resolved.is_dir() or root.is_symlink() or resolved.is_symlink():
        raise ValueError("private_runtime_directory_required")
    if any(name.lower() in {"public_html", "webroot", "www"} for name in resolved.parts):
        raise ValueError("public_runtime_forbidden")
    mode = resolved.stat().st_mode
    if mode & 0o077:
        raise ValueError("private_runtime_permissions_required")
    return resolved


def file_sha256(path: Path):
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def maybe_date(value):
    if isinstance(value, str):
        try:
            return dt.date.fromisoformat(value).isoformat()
        except ValueError:
            return None
    if isinstance(value, (int, float)) and not isinstance(value, bool) and 0 < value < 9999999999999:
        try:
            return dt.datetime.fromtimestamp(value / (1000 if value > 10**11 else 1),
                                             tz=dt.timezone.utc).date().isoformat()
        except (ValueError, OverflowError, OSError):
            return None
    return None


def normalize(row, exchange):
    if not isinstance(row, dict) or row.get("exchange") != exchange:
        return None
    segment, key = row.get("segment"), row.get("instrument_key")
    if segment not in TYPES or not isinstance(key, str) or not KEY.fullmatch(key):
        return None
    if not segment.startswith(exchange + "_") and not (exchange == "NSE" and segment == "NCD_FO") and not (exchange == "BSE" and segment == "BCD_FO"):
        return None
    if not key.startswith(segment + "|"):
        return None
    symbol = row.get("trading_symbol", row.get("tradingsymbol"))
    name = row.get("name", "")
    kind = row.get("instrument_type", "")
    if not isinstance(symbol, str) or not SIMPLE.fullmatch(symbol) or not isinstance(name, str) or len(name) > 180 or not isinstance(kind, str) or len(kind) > 20:
        return None
    lot = row.get("lot_size")
    strike = row.get("strike_price", row.get("strike"))
    underlying = row.get("underlying_symbol")
    return {
        "instrument_key": key, "exchange": exchange, "segment": segment,
        "trading_symbol": symbol, "name": name, "instrument_type": kind,
        "expiry": maybe_date(row.get("expiry")),
        "strike_price": float(strike) if isinstance(strike, (int, float)) and not isinstance(strike, bool) and 0 <= strike <= 10**12 else None,
        "lot_size": lot if isinstance(lot, int) and not isinstance(lot, bool) and 0 < lot < 10**8 else None,
        "underlying_symbol": underlying[:100] if isinstance(underlying, str) else None,
    }


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("bod_source_redirect_not_allowed")


def download(exchange: str, to: Path):
    url = SOURCES[exchange]
    opener = urllib.request.build_opener(NoRedirect)
    request = urllib.request.Request(url, headers={"Accept": "application/gzip", "User-Agent": "QSYN-BOD-Master/1"})
    with opener.open(request, timeout=45) as response, to.open("wb") as target:
        if response.status != 200 or response.geturl() != url:
            raise ValueError("bod_source_unavailable")
        size = 0
        while True:
            chunk = response.read(65536)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_COMPRESSED:
                raise ValueError("oversized_bod_source")
            target.write(chunk)
    if not to.stat().st_size:
        raise ValueError("empty_bod_source")


def import_files(root: Path, sources: dict[str, Path], today: dt.date):
    destination = root / "upstox-master"
    if destination.is_symlink():
        raise ValueError("master_directory_symlink")
    destination.mkdir(mode=0o700, exist_ok=True)
    if destination.stat().st_mode & 0o077:
        raise ValueError("master_directory_permissions")
    generation = "bod-" + today.isoformat() + "-" + secrets.token_hex(6)
    stage = destination / generation
    stage.mkdir(mode=0o700)
    counts = {}
    try:
        parser = runpy.run_path(str(Path(__file__).with_name("upstox-instrument-inspect.py")))["stream_json_array"]
        for exchange in ("NSE", "BSE"):
            source = sources[exchange]
            if source.is_symlink() or not source.is_file() or source.stat().st_size > MAX_COMPRESSED:
                raise ValueError("source_missing_or_oversized")
            output = stage / (exchange + ".ndjson")
            count = 0
            segments = {}
            with output.open("w", encoding="utf-8", newline="\n") as writer:
                os.chmod(output, 0o600)
                for row in parser(source):
                    value = normalize(row, exchange)
                    if value is None:
                        continue
                    writer.write(json.dumps(value, ensure_ascii=True, separators=(",", ":")) + "\n")
                    count += 1
                    if count > MAX_RECORDS:
                        raise ValueError("too_many_instruments")
                    segments[value["segment"]] = segments.get(value["segment"], 0) + 1
            if count == 0:
                raise ValueError("no_valid_" + exchange + "_instruments")
            counts[exchange] = {"total": count, "segments": segments,
                                "sha256": file_sha256(output)}
        # Publish only after both exchange files are fully written and validated.
        manifest = {
            "schema": "QSYN-UPSTOX-BOD-MASTER/1",
            "generation": generation, "imported_at_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
            "imported_day_ist": today.isoformat(), "source": "upstox_official_bod_json",
            "exchanges": counts, "data_state": "discovery_only", "trading_enabled": False,
            "history_verified": False, "live_feed_verified": False,
        }
        temp = destination / ("current-" + secrets.token_hex(8) + ".json")
        with temp.open("x", encoding="utf-8") as writer:
            os.chmod(temp, 0o600)
            json.dump(manifest, writer, separators=(",", ":"))
        os.replace(temp, destination / "current.json")
        # Keep the current snapshot plus two prior generations for rollback;
        # avoid unbounded private-disk growth under daily operator refresh.
        snapshots = sorted(
            (p for p in destination.iterdir()
             if p.is_dir() and not p.is_symlink()
             and re.fullmatch(r"bod-20[0-9]{2}-[0-9]{2}-[0-9]{2}-[a-f0-9]{12}", p.name)),
            key=lambda p: p.name, reverse=True,
        )
        keep = {generation}
        for old in snapshots:
            if old.name in keep:
                continue
            if len(keep) < 3:
                keep.add(old.name)
            else:
                shutil.rmtree(old)
        return manifest
    except BaseException:
        shutil.rmtree(stage)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", type=Path, default=os.environ.get("QSYN_RUNTIME_DIR"))
    parser.add_argument("--download", action="store_true",
                        help="Download both fixed official gzip URLs via HTTPS")
    parser.add_argument("--nse-file", type=Path, help="Local official NSE.json.gz")
    parser.add_argument("--bse-file", type=Path, help="Local official BSE.json.gz")
    parser.add_argument("--asof", type=dt.date.fromisoformat,
                        default=dt.datetime.now(dt.timezone(dt.timedelta(hours=5, minutes=30))).date())
    args = parser.parse_args()
    if args.runtime is None:
        parser.error("set QSYN_RUNTIME_DIR or --runtime to a private directory")
    if args.download == bool(args.nse_file or args.bse_file) or (
        not args.download and (args.nse_file is None or args.bse_file is None)):
        parser.error("choose --download OR both --nse-file and --bse-file")
    scratch = None
    try:
        root = safe_root(Path(args.runtime))
        sources = {"NSE": args.nse_file, "BSE": args.bse_file}
        # One operator refresh at a time. The lock never contains secrets.
        lock_dir = root / "upstox-master"
        if lock_dir.is_symlink():
            raise ValueError("master_directory_symlink")
        lock_dir.mkdir(mode=0o700, exist_ok=True)
        if lock_dir.stat().st_mode & 0o077:
            raise ValueError("master_directory_permissions")
        lock_path = lock_dir / ".refresh.lock"
        if lock_path.is_symlink():
            raise ValueError("master_lock_symlink")
        with lock_path.open("a+b") as lock:
            os.chmod(lock_path, 0o600)
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise ValueError("master_refresh_already_running") from None
            if args.download:
                import tempfile
                scratch = tempfile.TemporaryDirectory(prefix="qsyn-bod-")
                sources = {x: Path(scratch.name) / (x + ".json.gz") for x in SOURCES}
                for x, out in sources.items():
                    download(x, out)
            manifest = import_files(root, sources, args.asof)
        print(json.dumps(manifest, separators=(",", ":")))
        return 0
    except (OSError, ValueError, EOFError, UnicodeError, json.JSONDecodeError) as exc:
        print("QSYN master refresh rejected: " + type(exc).__name__ + ": " + str(exc), file=sys.stderr)
        return 1
    finally:
        if scratch is not None:
            scratch.cleanup()


if __name__ == "__main__":
    sys.exit(main())
