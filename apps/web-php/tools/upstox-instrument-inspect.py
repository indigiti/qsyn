#!/usr/bin/env python3
"""Offline, bounded Upstox BOD instrument JSON(.gz) catalog inspection.

Never downloads instruments, authenticates, starts a feed, or publishes a symbol
to QSYN's public demo. Supply a locally obtained provider JSON file (preferred
over the deprecated CSV format); keep exchange licensing outside this script.
"""
import argparse
import datetime as dt
import gzip
import json
import os
import re
import sys
from pathlib import Path


def stream_json_array(path):
    opener = gzip.open if path.name.endswith(".gz") else open
    with opener(path, "rt", encoding="utf-8") as handle:
        buf = ""
        started = False
        closed = False
        decoder = json.JSONDecoder()
        count = 0
        while True:
            chunk = handle.read(32768)
            if chunk:
                buf += chunk
            elif not buf and not closed:
                raise ValueError("truncated_instrument_catalog")
            while True:
                buf = buf.lstrip()
                if not started:
                    if not buf and chunk:
                        break
                    if not buf or buf[0] != "[":
                        raise ValueError("expected_json_array")
                    buf = buf[1:]
                    started = True
                    continue
                if buf.startswith("]"):
                    closed = True
                    if buf[1:].strip():
                        raise ValueError("trailing_catalog_data")
                    buf = ""
                    break
                if not buf:
                    break
                if buf[0] == ",":
                    buf = buf[1:]
                    continue
                try:
                    record, consumed = decoder.raw_decode(buf)
                except json.JSONDecodeError:
                    if len(buf) > 131072 or not chunk:
                        raise ValueError("malformed_or_oversized_catalog_entry") from None
                    break
                if not isinstance(record, dict):
                    raise ValueError("invalid_instrument_record")
                buf = buf[consumed:]
                count += 1
                if count > 2_000_000:
                    raise ValueError("catalog_record_limit")
                yield record
            if not chunk:
                if not closed or buf.strip():
                    raise ValueError("truncated_or_invalid_catalog")
                break


def instruments(path, underlying, selected_expiry, today):
    if not path.is_file() or path.is_symlink() or path.stat().st_size > 160_000_000:
        raise ValueError("missing_or_oversized_catalog")
    if re.fullmatch(r"[A-Z]{3,12}", underlying) is None \
            or underlying not in {"NIFTY", "BANKNIFTY", "FINNIFTY"}:
        raise ValueError("unsupported_underlying")
    found = {}
    expiries = set()
    for row in stream_json_array(path):
        if row.get("segment") != "NSE_FO" \
                or row.get("underlying_symbol") != underlying \
                or row.get("instrument_type") not in ("CE", "PE"):
            continue
        expiry = row.get("expiry")
        try:
            parsed = dt.date.fromisoformat(expiry)
        except (TypeError, ValueError):
            continue
        if parsed < today:
            continue
        expiries.add(expiry)
        if selected_expiry and expiry != selected_expiry:
            continue
        strike = row.get("strike_price")
        lot = row.get("lot_size")
        key = row.get("instrument_key")
        symbol = row.get("trading_symbol")
        if not isinstance(strike, (int, float)) or strike <= 0 \
                or not isinstance(lot, int) or not (1 <= lot <= 100000) \
                or not isinstance(key, str) or re.fullmatch(r"NSE_FO\|[A-Za-z0-9_-]{1,90}", key) is None \
                or not isinstance(symbol, str) or len(symbol) > 120:
            raise ValueError("malformed_matching_instrument")
        index = (expiry, strike, row["instrument_type"])
        if index in found:
            if found[index]["instrument_key"] != key:
                raise ValueError("conflicting_instrument_contract")
            continue
        if len(found) >= 30000:
            raise ValueError("too_many_matched_contracts")
        found[index] = {
            "expiry": expiry, "strike": strike, "type": row["instrument_type"],
            "instrument_key": key, "trading_symbol": symbol, "lot_size": lot,
        }
    return sorted(expiries), sorted(found.values(),
                                 key=lambda r: (r["expiry"], r["strike"], r["type"]))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--file", required=True, type=Path)
    parser.add_argument("--underlying", required=True)
    parser.add_argument("--expiry", help="YYYY-MM-DD; omit to list expiries only")
    parser.add_argument("--asof", type=dt.date.fromisoformat,
                        default=dt.datetime.now(dt.timezone(dt.timedelta(hours=5, minutes=30))).date())
    args = parser.parse_args()
    try:
        if args.expiry:
            day = dt.date.fromisoformat(args.expiry)
            if day < args.asof:
                raise ValueError("expired_contract")
        expiries, rows = instruments(args.file, args.underlying, args.expiry, args.asof)
        if args.expiry and not rows:
            raise ValueError("no_contracts_for_selected_expiry")
        print(json.dumps({
            "schema": "QSYN-UPSTOX-INSTRUMENT-INSPECTION/1",
            "source": "operator_supplied_local_bod_json", "underlying": args.underlying,
            "asof_ist_date": args.asof.isoformat(),
            "catalog_file_age_hours": round(max(0, __import__("time").time()
                                                - args.file.stat().st_mtime) / 3600, 2),
            "catalog_freshness_attested": False,
            "feed_authorized": False, "trading_enabled": False,
            "available_expiries": expiries[:24],
            "contracts": rows if args.expiry else [],
        }, separators=(",", ":")))
        return 0
    except (OSError, ValueError, EOFError) as error:
        print("QSYN instrument catalog rejected: " + str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
