#!/usr/bin/env python3
"""Pure stdlib offline Upstox JSON catalog regression; no provider login."""
import gzip
import json
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "apps/web-php/tools/upstox-instrument-inspect.py"


def contract(type_, key, strike=24500, expiry="2026-10-29"):
    return {
        "segment": "NSE_FO", "underlying_symbol": "NIFTY",
        "instrument_type": type_, "expiry": expiry,
        "strike_price": strike, "lot_size": 65,
        "instrument_key": key,
        "trading_symbol": f"NIFTY {strike} {type_} 29 OCT 26",
    }


def launch(path, *args):
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--file", str(path),
         "--underlying", "NIFTY", "--asof", "2026-10-10", *args],
        capture_output=True, text=True, timeout=15,
    )


def run():
    rows = [
        contract("CE", "NSE_FO|101"),
        contract("PE", "NSE_FO|102"),
        contract("CE", "NSE_FO|111", 24550, "2026-11-26"),
        contract("PE", "NSE_FO|102", 24500, "2026-09-24"),  # expired ignored
        contract("CE", "NSE_FO|201", 24550) | {"underlying_symbol": "BANKNIFTY"},
        {"segment": "NSE_EQ", "instrument_key": "NSE_EQ|101"},
    ]
    with tempfile.TemporaryDirectory(prefix="qsyn-upstox-catalog-") as temp:
        root = pathlib.Path(temp)
        normal = root / "instruments.json"
        zipped = root / "instruments.json.gz"
        normal.write_text(json.dumps(rows), encoding="utf-8")
        with gzip.open(zipped, "wt", encoding="utf-8") as writer:
            json.dump(rows, writer)
        for path in (normal, zipped):
            a = launch(path)
            assert a.returncode == 0, a.stderr
            data = json.loads(a.stdout)
            assert data["available_expiries"] == ["2026-10-29", "2026-11-26"]
            assert data["contracts"] == []
            assert data["feed_authorized"] is False
            assert data["trading_enabled"] is False
            b = launch(path, "--expiry", "2026-10-29")
            assert b.returncode == 0, b.stderr
            matches = json.loads(b.stdout)["contracts"]
            assert {r["type"] for r in matches} == {"CE", "PE"}
            assert all(r["lot_size"] == 65 for r in matches)
            assert all(r["instrument_key"].startswith("NSE_FO|") for r in matches)

        invalid = launch(normal, "--expiry", "2025-10-29")
        assert invalid.returncode != 0
        corrupted = root / "corrupted.json"
        corrupted.write_text(json.dumps(rows)[:-2], encoding="utf-8")
        assert launch(corrupted).returncode != 0
        duplicate = root / "duplicate.json"
        duplicate.write_text(json.dumps(rows + [contract("CE", "NSE_FO|999")]), encoding="utf-8")
        assert launch(duplicate, "--expiry", "2026-10-29").returncode != 0
        print("PASS: streaming Upstox JSON/GZIP BOD filtering, real expiry/strike keys, corruption and conflict rejection")


if __name__ == "__main__":
    run()
