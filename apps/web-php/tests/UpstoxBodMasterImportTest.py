#!/usr/bin/env python3
"""Offline integration proof for NSE/BSE master import. No network needed."""
import datetime as dt
import gzip
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

SCRIPT = Path(__file__).resolve().parents[1] / "tools" / "upstox-bod-master-refresh.py"


def row(exchange, segment, key, symbol, kind="EQ", **extra):
    return {"exchange": exchange, "segment": segment, "instrument_key": key,
            "trading_symbol": symbol, "name": symbol + " LTD",
            "instrument_type": kind, "lot_size": 1, **extra}


def write_bod(path, values):
    with gzip.open(path, "wt", encoding="utf-8") as writer:
        json.dump(values, writer)


def run(root, nse, bse):
    return subprocess.run([sys.executable, str(SCRIPT), "--runtime", str(root),
                           "--nse-file", str(nse), "--bse-file", str(bse),
                           "--asof", "2026-10-25"],
                          capture_output=True, text=True, timeout=30)


def main():
    with tempfile.TemporaryDirectory(prefix="qsyn-master-test-") as d:
        root = Path(d)
        os.chmod(root, 0o700)
        nse, bse = root / "NSE.json.gz", root / "BSE.json.gz"
        write_bod(nse, [
            row("NSE", "NSE_EQ", "NSE_EQ|INE002A01018", "RELIANCE"),
            row("NSE", "NSE_INDEX", "NSE_INDEX|Nifty 50", "NIFTY 50", "INDEX"),
            row("NSE", "NSE_FO", "NSE_FO|1234", "NIFTY 24500 CE", "CE",
                expiry=1793577599000, strike_price=24500),
            row("NSE", "NSE_FO", "BSE_FO|not_nse", "SPOOFED", "FUT"),
            row("BSE", "BSE_EQ", "BSE_EQ|bad", "WRONG EXCHANGE"),
        ])
        write_bod(bse, [
            row("BSE", "BSE_EQ", "BSE_EQ|INE002A01018", "RELIANCE"),
            row("BSE", "BSE_INDEX", "BSE_INDEX|SENSEX", "SENSEX", "INDEX"),
            row("BSE", "BSE_FO", "BSE_FO|5566", "SENSEX CE", "CE"),
        ])
        first = run(root, nse, bse)
        assert first.returncode == 0, first.stderr
        report = json.loads(first.stdout)
        assert report["exchanges"]["NSE"]["total"] == 3, report
        assert report["exchanges"]["BSE"]["total"] == 3, report
        assert report["history_verified"] is False
        assert report["live_feed_verified"] is False
        store = root / "upstox-master"
        current = (store / "current.json").read_text()
        generation = report["generation"]
        assert (store / generation / "NSE.ndjson").is_file()
        instruments = [json.loads(line) for line in
                       (store / generation / "NSE.ndjson").read_text().splitlines()]
        assert instruments[2]["expiry"] == dt.datetime.fromtimestamp(
            1793577599, dt.timezone.utc).date().isoformat()
        assert (store / "current.json").stat().st_mode & 0o077 == 0

        # Failed refresh must never publish a partial NSE-only catalog.
        write_bod(bse, [{"exchange": "BSE", "segment": "BSE_EQ"}])
        error = run(root, nse, bse)
        assert error.returncode != 0, error.stdout
        assert (store / "current.json").read_text() == current, "partial refresh published"
        assert len(list(store.glob("bod-*"))) == 1, "partial generation retained"
        write_bod(bse, [row("BSE", "BSE_EQ", "BSE_EQ|INE002A01018", "RELIANCE")])
        for _ in range(4):
            updated = run(root, nse, bse)
            assert updated.returncode == 0, updated.stderr
        assert len(list(store.glob("bod-*"))) == 3, "unbounded daily catalog retention"
        assert json.loads((store / "current.json").read_text())["generation"] != generation
        os.chmod(root, 0o755)
        assert run(root, nse, bse).returncode != 0, "unsafe runtime accepted"
    print("PASS: private atomic streaming NSE/BSE BOD import and fail-closed catalog")


if __name__ == "__main__":
    main()
