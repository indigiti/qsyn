#!/usr/bin/env python3
"""QSYN Phase 1.12: read-only private pre-activation network acceptance.

Anonymous GET only. Inspect from a genuinely authorized network first while
ALL mock-account switches remain disabled. Inspect the same hostname from an
independently denied network. Receipts are untrusted observations, not proof
of VPN/IP ACL configuration, PHP-FPM flags, or operator authorization.

This program never enables accounts, changes configuration or logs in.
"""
import argparse
import datetime as dt
import hashlib
import ipaddress
import json
import re
import sys
import urllib.parse

from PrivateIngressProbe import inspect, private_target, test_outside

SCHEMA = "qsyn-private-baseline-v1"
DENIALS = {401, 403, 404, 503}
VANTAGE = re.compile(r"[A-Za-z0-9_.-]{3,64}\Z")
TARGET = re.compile(r"[0-9a-f]{64}\Z")
EXPECTED_OUTSIDE = {"health", "dashboard", "auth"}
OUTSIDE_DENIALS = {"connection_blocked", "edge_denial_401", "edge_denial_403"}
FIELDS = {
    "schema", "target_sha256", "side", "vantage", "observed_at",
    "result", "observations", "localhost_simulation",
}


def target_for_baseline(url, allow_loopback_ci=False):
    origin, prefix, digest = private_target(url, allow_loopback_ci)
    host = (urllib.parse.urlsplit(origin).hostname or "").lower().rstrip(".")
    if not allow_loopback_ci:
        if host in {"stage.digiti.in", "digiti.in", "www.digiti.in",
                    "localhost", "127.0.0.1", "::1"} or "." not in host:
            raise ValueError("Public or non-qualified host is not a private test target")
        try:
            ipaddress.ip_address(host)
        except ValueError:
            pass
        else:
            raise ValueError("Require an exact private HTTPS hostname, not a raw IP")
    return origin, prefix, digest


def inside_baseline(opener, origin):
    health = inspect(opener, origin, "/api/v1/health")
    if health.get("status") != 200 or not isinstance(health.get("json"), dict) \
            or health["json"].get("status") != "ok":
        raise AssertionError("Private baseline health check failed")

    demo = inspect(opener, origin, "/api/v1/demo/bars")
    if demo.get("status") != 200 or not isinstance(demo.get("json"), dict) \
            or demo["json"].get("mode") != "simulated" \
            or not isinstance(demo["json"].get("bars"), list) \
            or not demo["json"]["bars"]:
        raise AssertionError("Private baseline must expose synthetic-only bars")

    rust = inspect(opener, origin, "/api/v1/diagnostics/rust")
    if rust.get("status") != 200 or not isinstance(rust.get("json"), dict):
        raise AssertionError("Private baseline lacks a readable Rust diagnostic")
    runtime = rust["json"]
    state = runtime.get("status")
    if state not in {"online", "offline", "unavailable"}:
        raise AssertionError("Unexpected private Rust runtime state")
    if runtime.get("trading_enabled") is True or runtime.get("upstox_connected") is True:
        raise AssertionError("Real execution or Upstox connectivity must remain off")
    if state == "online" and (runtime.get("trading_enabled") is not False
                              or runtime.get("upstox_connected") is not False):
        raise AssertionError("Online Rust must affirmatively deny trading and Upstox")

    for route in ("/api/v1/auth/state", "/api/v1/accounts/list", "/app"):
        reply = inspect(opener, origin, route)
        if reply.get("status") not in DENIALS:
            raise AssertionError("Mock account route is not disabled")
        if "qsyn_user_session=" in (reply.get("cookie") or "").lower():
            raise AssertionError("Disabled route issued a mock user session")
        body = reply.get("json")
        if isinstance(body, dict) and (body.get("authenticated") is True
                                       or "csrf" in body or "accounts" in body):
            raise AssertionError("Disabled route exposed private account material")

    return {
        "health": "http_200", "demo_bars": "simulated",
        "rust": "online_demo_only" if state == "online" else "offline_or_unavailable",
        "identity": "denied", "accounts": "denied",
        "dashboard": "denied", "session": "not_issued",
    }


def run_probe(url, side, vantage, *, allow_loopback_ci=False, opener=None):
    if side not in {"inside", "outside"} or not isinstance(vantage, str) \
            or not VANTAGE.fullmatch(vantage):
        raise ValueError("Invalid side or non-secret vantage ID")
    origin, _, fingerprint = target_for_baseline(url, allow_loopback_ci)
    if opener is None:
        import urllib.request
        from PublicStageProbe import NoRedirect
        opener = urllib.request.build_opener(NoRedirect())
    observed = inside_baseline(opener, origin) if side == "inside" else test_outside(opener, origin)
    return {
        "schema": SCHEMA, "target_sha256": fingerprint, "side": side,
        "vantage": vantage, "observed_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "result": "pass", "observations": observed,
        "localhost_simulation": bool(allow_loopback_ci),
    }


def verify_pair(inside, outside, *, allow_loopback_ci=False, now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    for receipt, side in ((inside, "inside"), (outside, "outside")):
        if not isinstance(receipt, dict) or set(receipt) != FIELDS \
                or receipt.get("schema") != SCHEMA or receipt.get("side") != side \
                or receipt.get("result") != "pass" \
                or not isinstance(receipt.get("vantage"), str) \
                or not VANTAGE.fullmatch(receipt["vantage"]) \
                or not isinstance(receipt.get("target_sha256"), str) \
                or not TARGET.fullmatch(receipt["target_sha256"]):
            raise ValueError("Invalid or incomplete baseline receipt")
        if receipt.get("localhost_simulation") not in (True, False) \
                or (receipt["localhost_simulation"] and not allow_loopback_ci):
            raise ValueError("Loopback evidence is ineligible for private deployment")
        try:
            observed = dt.datetime.fromisoformat(receipt["observed_at"])
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError("Invalid evidence timestamp") from error
        if observed.tzinfo is None or not (dt.timedelta() <= now - observed <= dt.timedelta(hours=24)):
            raise ValueError("Baseline receipt is stale, future-dated or lacks timezone")
    if inside["target_sha256"] != outside["target_sha256"] \
            or inside["vantage"] == outside["vantage"] \
            or inside["localhost_simulation"] != outside["localhost_simulation"]:
        raise ValueError("Mixed targets, identical networks or incompatible receipts")

    expected_inside = {
        "health": "http_200", "demo_bars": "simulated",
        "identity": "denied", "accounts": "denied",
        "dashboard": "denied", "session": "not_issued",
    }
    observed = inside.get("observations")
    if not isinstance(observed, dict) or set(observed) != {*expected_inside, "rust"} \
            or any(observed.get(key) != value for key, value in expected_inside.items()) \
            or observed.get("rust") not in {"online_demo_only", "offline_or_unavailable"}:
        raise ValueError("Inside baseline is incomplete or not fail-closed")
    denied = outside.get("observations")
    if not isinstance(denied, dict) or set(denied) != EXPECTED_OUTSIDE \
            or any(value not in OUTSIDE_DENIALS for value in denied.values()):
        raise ValueError("Outside private ingress denial is incomplete")

    return {
        "schema": SCHEMA,
        "phase": "pre_activation",
        "evidence": "consistent_not_attested",
        "target_sha256": inside["target_sha256"],
        "requires_operator_network_attestation": True,
        "requires_php_fpm_verification": True,
        "private_access_approval": False,
        "enable_accounts": False,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    probe = commands.add_parser("probe", help="Anonymous GET observations only")
    probe.add_argument("--url", required=True)
    probe.add_argument("--side", required=True, choices=("inside", "outside"))
    probe.add_argument("--vantage", required=True)
    probe.add_argument("--output", required=True)
    # CI-only test switch is never accepted as real deployment evidence.
    probe.add_argument("--allow-loopback-ci", action="store_true")
    verify = commands.add_parser("verify", help="Compare two observation receipts offline")
    verify.add_argument("--inside", required=True)
    verify.add_argument("--outside", required=True)
    verify.add_argument("--allow-loopback-ci", action="store_true")
    args = parser.parse_args(argv)
    try:
        if args.command == "probe":
            receipt = run_probe(args.url, args.side, args.vantage,
                                allow_loopback_ci=args.allow_loopback_ci)
            with open(args.output, "x", encoding="utf-8") as handle:
                json.dump(receipt, handle, indent=2, sort_keys=True)
                handle.write("\n")
            print("PASS: anonymous pre-activation observations recorded; not ingress approval")
        else:
            with open(args.inside, encoding="utf-8") as handle:
                inside = json.load(handle)
            with open(args.outside, encoding="utf-8") as handle:
                outside = json.load(handle)
            print(json.dumps(verify_pair(inside, outside,
                                         allow_loopback_ci=args.allow_loopback_ci),
                             sort_keys=True))
            print("LIMIT: operator must verify source networks, actual ingress ACL, PHP-FPM and rollback")
    except (OSError, TypeError, ValueError, AssertionError, json.JSONDecodeError):
        print("FAIL: private pre-activation baseline incomplete or inconsistent", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
