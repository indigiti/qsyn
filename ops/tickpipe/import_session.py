#!/usr/bin/env python3
"""Import finalized TickPipe v0.2 trade parts into an offline QSYN replay bundle."""
import argparse
import json
import math
import os
import re
import stat
import tempfile
from datetime import date, datetime, timezone
from pathlib import Path

COLUMNS = ["ts", "exch_ts", "ticker", "seq", "price", "qty", "volume"]
MAX_ROWS = 2_000_000
NS = 1_000_000_000


def build(rows, symbol, day_start):
    ticks, gaps = [], []
    bars = {1: {}, 60: {}}
    prev_ts = prev_seq = None
    count = 0
    for ts, exch_ts, ticker, seq, price, qty, volume in rows:
        count += 1
        if count > MAX_ROWS:
            raise ValueError("too many source rows for a single import")
        if not isinstance(ts, int) or not day_start <= ts < day_start + 86400 * NS:
            raise ValueError("receive timestamp outside the selected UTC date")
        if (not isinstance(seq, int) or seq < 0 or
                (prev_ts is not None and (ts <= prev_ts or seq <= prev_seq))):
            raise ValueError("duplicate, overlapping, unordered or mixed recording parts")
        if prev_seq is not None and seq != prev_seq + 1:
            gaps.append([prev_seq + 1, seq - 1])
        prev_ts, prev_seq = ts, seq
        if ticker != symbol:
            continue
        if (not isinstance(price, (int, float)) or not math.isfinite(price) or price <= 0
                or not isinstance(qty, int) or qty < 0
                or (volume is not None and (not isinstance(volume, int) or volume < 0))
                or (exch_ts is not None and (not isinstance(exch_ts, int) or exch_ts < 0))):
            raise ValueError("invalid snapshot")
        # Decimal strings preserve integer precision across JSON/JavaScript.
        ticks.append([str(ts), None if exch_ts is None else str(exch_ts), str(seq),
                      price, str(qty), None if volume is None else str(volume)])
        for interval, series in bars.items():
            bucket = ts // NS // interval * interval
            if bucket not in series:
                series[bucket] = dict(time=bucket, open=price, high=price, low=price, close=price)
            else:
                bar = series[bucket]
                bar.update(high=max(bar["high"], price), low=min(bar["low"], price), close=price)
    if not ticks:
        raise ValueError("no snapshots for the selected symbol")
    return {
        "schema": "QSYN-TICKPIPE-REPLAY/1",
        "source": "openalgo_snapshot",
        "mode": "offline_only",
        "candle_clock": "receive_time_utc",
        "capture_completeness": "unknown",
        "symbol": symbol,
        "sequence_gaps": [[str(a), str(b)] for a, b in gaps],
        "tick_columns": COLUMNS[:2] + COLUMNS[3:],
        "ticks": ticks,
        "candles": {str(k): list(v.values()) for k, v in bars.items()},
    }


def read_parts(folder):
    import polars as pl

    parts = sorted(folder.glob("part-*.parquet"))
    if not parts or len(parts) > 4096:
        raise ValueError("missing parts or too many parts")
    count = 0
    for part in parts:
        if part.is_symlink() or not part.is_file():
            raise ValueError("parts must be regular files")
        lazy = pl.scan_parquet(part)
        schema = lazy.collect_schema()
        for field in ("ts", "exch_ts"):
            if schema[field] != pl.Datetime("ns"):
                raise ValueError("expected TickPipe nanosecond Parquet timestamps")
        count += lazy.select(pl.len()).collect().item()
        if count > MAX_ROWS:
            raise ValueError("too many source rows for a single import")
        yield from lazy.select(COLUMNS).with_columns(
            pl.col("ts", "exch_ts").cast(pl.Int64)
        ).collect().iter_rows()


def publish(root, name, bundle):
    root.mkdir(mode=0o700, parents=False, exist_ok=True)
    if (root.is_symlink() or not root.is_dir() or root.stat().st_uid != os.getuid()
            or stat.S_IMODE(root.stat().st_mode) & 0o077):
        raise ValueError("output directory must be owner-only")
    if any(p.lower() in {"public", "public_html", "webroot", "www", "htdocs"} for p in root.resolve().parts):
        raise ValueError("output directory must be outside the web root")
    target = root / name
    payload = json.dumps(bundle, allow_nan=False, separators=(",", ":")).encode() + b"\n"
    fd, staged = tempfile.mkstemp(dir=root)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.link(staged, target)
        except FileExistsError:
            info = target.lstat()
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                    or stat.S_IMODE(info.st_mode) & 0o077 or info.st_size != len(payload)
                    or target.read_bytes() != payload):
                raise ValueError("conflicting bundle exists; refusing to overwrite") from None
    finally:
        os.unlink(staged)
    return target


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--recording", type=Path, required=True)
    p.add_argument("--date", type=date.fromisoformat, required=True, help="UTC partition date")
    p.add_argument("--symbol", required=True, help="OpenAlgo EXCHANGE:SYMBOL")
    p.add_argument("--output", type=Path, required=True, help="private offline directory")
    args = p.parse_args()
    if not re.fullmatch(r"[A-Z0-9_]{1,16}:[A-Z0-9_&.-]{1,64}", args.symbol):
        p.error("invalid OpenAlgo symbol")
    start = int(datetime.combine(args.date, datetime.min.time(), timezone.utc).timestamp()) * NS
    folder = args.recording / "trades" / f"date={args.date}"
    try:
        bundle = build(read_parts(folder), args.symbol, start)
        bundle["date_utc"] = args.date.isoformat()
        name = f"{args.date}-{args.symbol.replace(':', '-')}.json"
        target = publish(args.output, name, bundle)
    except (ValueError, KeyError, OSError, ImportError) as error:
        p.exit(1, f"Import rejected: {error}\n")
    print(f"{target.name}: {len(bundle['ticks'])} snapshot rows imported")


if __name__ == "__main__":
    main()
