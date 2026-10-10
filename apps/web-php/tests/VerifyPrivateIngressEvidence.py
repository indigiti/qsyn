#!/usr/bin/env python3
"""Review inside/outside QSYN private ingress evidence. No network calls.

This checks consistency, not authenticity of a vantage or the firewall.
An operator must separately establish independent network locations and
approve the actual restricted test host.
"""
import argparse
import datetime as dt
import json
import re
import sys

from PrivateIngressProbe import SCHEMA


def verify_pair(inside, outside, *, allow_loopback_ci=False, now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    for receipt, side in [(inside, "inside"), (outside, "outside")]:
        if receipt.get("schema") != SCHEMA or receipt.get("side") != side \
                or receipt.get("result") != "pass":
            raise ValueError("Unrecognized or failed evidence receipt")
        target = receipt.get("target_sha256")
        if not isinstance(target, str) or not re.fullmatch(r"[a-f0-9]{64}", target):
            raise ValueError("Invalid target fingerprint")
        if receipt.get("localhost_simulation") is not False and not allow_loopback_ci:
            raise ValueError("Local simulation cannot establish private-stage network security")
        try:
            time = dt.datetime.fromisoformat(receipt["observed_at"])
        except (TypeError, ValueError, KeyError) as error:
            raise ValueError("Invalid evidence timestamp") from error
        if time.tzinfo is None or not (dt.timedelta(0) <= now - time <= dt.timedelta(hours=24)):
            raise ValueError("Evidence is future-dated, stale or timezone-free")
    if inside["target_sha256"] != outside["target_sha256"]:
        raise ValueError("Inside and outside tested different private targets")
    if inside.get("vantage") == outside.get("vantage") \
            or not isinstance(inside.get("vantage"), str) or not isinstance(outside.get("vantage"), str):
        raise ValueError("Independent vantage identifiers required")
    expected_inside = {
        "health": "http_200", "auth_shell": "anonymous_mock_only",
        "dashboard": "simulated_csp", "anonymous_accounts": "http_401",
        "anonymous_bars": "http_401", "cookie_security": "checked",
    }
    if inside.get("observations") != expected_inside:
        raise ValueError("Inside acceptance responses incomplete")
    outside_observed = outside.get("observations")
    if not isinstance(outside_observed, dict) \
            or set(outside_observed) != {"health", "dashboard", "auth"}:
        raise ValueError("Outside reachability observations incomplete")
    allowed = {"connection_blocked", "edge_denial_401", "edge_denial_403"}
    if any(item not in allowed for item in outside_observed.values()):
        raise ValueError("Outside private endpoint was not definitively blocked")
    return {
        "evidence": "consistent",
        "target_sha256": inside["target_sha256"],
        "independent_vantages_claimed": True,
        "requires_operator_network_attestation": True,
        "private_access_approval": False,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inside", required=True)
    parser.add_argument("--outside", required=True)
    parser.add_argument("--allow-loopback-ci", action="store_true",
                        help="Only for unit testing; cannot qualify production/private staging")
    args = parser.parse_args(argv)
    try:
        with open(args.inside, encoding="utf-8") as handle:
            inside = json.load(handle)
        with open(args.outside, encoding="utf-8") as handle:
            outside = json.load(handle)
        result = verify_pair(inside, outside, allow_loopback_ci=args.allow_loopback_ci)
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
        print("FAIL: private network evidence is incomplete, stale or inconsistent", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    print("NOTE: source networks are not attested by this script; do not enable Phase 1 features on public staging")
    return 0


if __name__ == "__main__":
    sys.exit(main())
