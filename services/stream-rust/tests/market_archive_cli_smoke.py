#!/usr/bin/env python3
"""Offline market archive CLI integration, with deliberately torn WAL frames.

No broker, customer data, public network, database or daemon is used.
"""
import json
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import zlib

ROOT = Path(__file__).resolve().parents[3]
BINARY = Path(os.environ.get(
    "QSYN_MARKET_ARCHIVE_BINARY",
    ROOT / "services/stream-rust/target/release/qsyn-market-archive"
))


def frame(sequence, account, price):
    payload = json.dumps({
        "scope": {"tenant_id": "fixture", "account_id": account,
                  "source_id": "fake", "entitlement_id": "simulated"},
        "instrument_id": "NSE_FO:TEST", "timestamp_ms": 120000 + sequence,
        "sequence": sequence, "price": price, "mode": "simulated",
    }, separators=(",", ":")).encode()
    return b"QWL1" + struct.pack(
        "<QII", sequence, len(payload), zlib.crc32(payload)
    ) + payload


def run_binary(root, operation, repair=False):
    env = os.environ.copy()
    env["QSYN_ARCHIVE_REPAIR_APPROVED"] = "1" if repair else "0"
    return subprocess.run(
        [str(BINARY), operation, str(root)],
        text=True, capture_output=True, timeout=10, env=env,
    )


def run():
    with tempfile.TemporaryDirectory(prefix="qsyn-archive-smoke-") as folder:
        root = Path(folder)
        root.chmod(0o700)
        wal = root / "market-events-v1.wal"
        first = frame(1, "accountA", 101.5)
        second = frame(2, "accountB", 211.1)
        wal.write_bytes(first + second)
        wal.chmod(0o600)
        ok = run_binary(root, "audit")
        assert ok.returncode == 0, ok.stderr
        report = json.loads(ok.stdout)
        assert report["records"] == 2
        assert report["last_sequence"] == 2
        assert report["trading_enabled"] is False
        assert report["connected_to_broker"] is False
        assert "accountA" not in ok.stdout and "accountB" not in ok.stdout

        wal.write_bytes(first + second[:-3])
        reject = run_binary(root, "audit")
        assert reject.returncode != 0 and not reject.stdout
        unapproved = run_binary(root, "repair-torn-tail")
        assert unapproved.returncode != 0
        assert wal.stat().st_size > len(first)

        recovery = run_binary(root, "repair-torn-tail", repair=True)
        assert recovery.returncode == 0, recovery.stderr
        assert json.loads(recovery.stdout)["tail_repaired"] is True
        assert wal.stat().st_size == len(first)
        assert json.loads(run_binary(root, "audit").stdout)["records"] == 1

        corrupted = bytearray(first)
        corrupted[-3] ^= 0x11
        wal.write_bytes(corrupted)
        assert run_binary(root, "audit").returncode != 0
        assert run_binary(root, "repair-torn-tail", repair=True).returncode != 0
        print("PASS: offline WAL audit, fail-closed corrupted frames, opt-in torn-tail repair and private output")


if __name__ == "__main__":
    run()
