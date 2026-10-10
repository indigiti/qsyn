#!/usr/bin/env python3
"""QSYN private-ingress acceptance evidence; anonymous GET only, no credentials.

Run INSIDE from the approved VPN/allowlisted network, and OUTSIDE from a
separate denied network. The paired evidence is observational, not proof
that the source addresses were attested or that every network is blocked.
Never point this at the public stage.digiti.in host.
"""
import argparse
import datetime as dt
import hashlib
import http.client
import json
import re
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request

from PublicStageProbe import NoRedirect, origin_and_path, MAX_BODY

SCHEMA = "qsyn-private-ingress-v1"
BLOCKED_HTTP = {401, 403}
MAX_TEXT = 256 * 1024


def private_target(url, localhost_ci=False):
    base, prefix = origin_and_path(url, localhost_ci)
    parsed = urllib.parse.urlsplit(base)
    host = (parsed.hostname or "").lower()
    if host == "stage.digiti.in":
        raise ValueError("Refusing to assess the public QSYN staging hostname")
    if localhost_ci and host not in ("localhost", "127.0.0.1"):
        raise ValueError("Local CI override can only target loopback")
    return base, prefix, hashlib.sha256((base + prefix).encode()).hexdigest()


def inspect(opener, origin, suffix):
    req = urllib.request.Request(
        origin + "/qsyn" + suffix,
        method="GET",
        headers={"Accept": "application/json,text/html", "Cache-Control": "no-store"},
    )
    try:
        response = opener.open(req, timeout=7)
    except urllib.error.HTTPError as exc:
        response = exc
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError,
            http.client.HTTPException) as exc:
        reason = getattr(exc, "reason", exc)
        # Network refusal/timeout is an observation; a DNS failure is not
        # enough evidence that ingress ACLs are functioning.
        if isinstance(reason, socket.gaierror):
            return {"transport": "dns_failure", "status": None}
        if isinstance(reason, (ConnectionRefusedError, TimeoutError,
                               socket.timeout, ConnectionResetError)):
            return {"transport": "connection_blocked", "status": None}
        if isinstance(reason, OSError) and getattr(reason, "errno", None) in (61, 104, 110, 111, 113):
            return {"transport": "connection_blocked", "status": None}
        return {"transport": "unclassified_error", "status": None}
    with response:
        status = response.status
        content_type = response.headers.get("Content-Type", "")
        size = response.headers.get("Content-Length", "")
        if size:
            try:
                if int(size) > MAX_BODY:
                    raise AssertionError("Oversized response")
            except ValueError as exc:
                raise AssertionError("Malformed Content-Length") from exc
        raw = response.read(MAX_BODY + 1)
        if len(raw) > MAX_BODY:
            raise AssertionError("Oversized response")
        data = None
        if "application/json" in content_type.lower() and raw:
            try:
                data = json.loads(raw.decode("utf-8"))
            except (ValueError, UnicodeDecodeError) as exc:
                raise AssertionError("Invalid JSON response") from exc
        # Sensitive bodies, CSRF values, session tokens, and cookies never
        # leave the process in the saved evidence or terminal output.
        return {
            "transport": "http", "status": status, "content_type": content_type.lower(),
            "json": data, "body": raw.decode("utf-8", "replace") if "text/html" in content_type.lower() else None,
            "cookie": response.headers.get("Set-Cookie", ""),
            "csp": response.headers.get("Content-Security-Policy", ""),
        }


def test_inside(opener, origin, localhost_ci):
    health = inspect(opener, origin, "/api/v1/health")
    if health["status"] != 200 or not isinstance(health["json"], dict) or health["json"].get("status") != "ok":
        raise AssertionError("Private health endpoint not reachable from approved side")
    state = inspect(opener, origin, "/api/v1/auth/state")
    data = state.get("json")
    if state["status"] != 200 or not isinstance(data, dict) or data.get("profile") != "mock-only" \
            or data.get("authenticated") is not False or data.get("user") is not None \
            or not isinstance(data.get("csrf"), str) or not re.fullmatch(r"[a-f0-9]{64}", data["csrf"]):
        raise AssertionError("Private test-only authentication shell unavailable or already authenticated")
    cookie = state.get("cookie", "").lower()
    for flag in ("qsyn_user_session=", "httponly", "samesite=strict"):
        if flag not in cookie:
            raise AssertionError("Private session cookie missing required security attributes")
    if not localhost_ci and "secure" not in cookie:
        raise AssertionError("Private HTTPS test session missing Secure cookie")
    app = inspect(opener, origin, "/app")
    if app["status"] != 200 or "text/html" not in app.get("content_type", "") \
            or "DEVELOPMENT / SIMULATED ONLY" not in (app.get("body") or "") \
            or "frame-ancestors 'none'" not in app.get("csp", ""):
        raise AssertionError("Private simulated dashboard shell or CSP missing")
    accounts = inspect(opener, origin, "/api/v1/accounts/list")
    bars = inspect(opener, origin, "/api/v1/accounts/bars")
    if accounts["status"] != 401 or bars["status"] != 401:
        raise AssertionError("Anonymous private request unexpectedly accessed account records or candles")
    return {
        "health": "http_200", "auth_shell": "anonymous_mock_only",
        "dashboard": "simulated_csp", "anonymous_accounts": "http_401",
        "anonymous_bars": "http_401", "cookie_security": "checked",
    }


def test_outside(opener, origin):
    observations = {}
    for path, label in [("/api/v1/health", "health"), ("/app", "dashboard"),
                        ("/api/v1/auth/state", "auth")]:
        outcome = inspect(opener, origin, path)
        status, transport = outcome.get("status"), outcome.get("transport")
        if transport == "http" and status in BLOCKED_HTTP:
            observations[label] = "edge_denial_" + str(status)
        elif transport == "connection_blocked":
            observations[label] = "connection_blocked"
        elif transport == "dns_failure":
            raise AssertionError("Outside host did not resolve; network ACL denial not established")
        else:
            raise AssertionError(label + ": outside network reached an unblocked endpoint or returned an ambiguous error")
    return observations


def run_probe(url, side, vantage, allow_loopback_ci=False, opener=None):
    if not re.fullmatch(r"[a-zA-Z0-9_.-]{3,64}", vantage):
        raise ValueError("Vantage must be 3-64 simple non-secret characters")
    origin, _, target = private_target(url, allow_loopback_ci)
    opener = opener or urllib.request.build_opener(NoRedirect())
    observed = (test_inside(opener, origin, allow_loopback_ci)
                if side == "inside" else test_outside(opener, origin))
    return {
        "schema": SCHEMA,
        "target_sha256": target,
        "side": side,
        "vantage": vantage,
        "observed_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "result": "pass",
        "observations": observed,
        "localhost_simulation": bool(allow_loopback_ci),
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True, help="Separate private HTTPS origin or /qsyn prefix")
    parser.add_argument("--side", required=True, choices=["inside", "outside"])
    parser.add_argument("--vantage", required=True, help="Non-secret identifier for the actual client network")
    parser.add_argument("--output", required=True, help="Output evidence JSON, without credentials")
    parser.add_argument("--allow-loopback-ci", action="store_true", help="For isolated local PHP regression only")
    args = parser.parse_args(argv)
    try:
        receipt = run_probe(args.url, args.side, args.vantage, args.allow_loopback_ci)
        with open(args.output, "x", encoding="utf-8") as handle:
            json.dump(receipt, handle, sort_keys=True, indent=2)
            handle.write("\n")
    except (ValueError, AssertionError, OSError) as exc:
        print("FAIL: private ingress probe did not establish the required evidence", file=sys.stderr)
        return 1
    print("PASS: " + args.side + " read-only private ingress observations saved")
    print("NOTE: vantage identity is self-reported; external network enforcement requires operator review")
    return 0


if __name__ == "__main__":
    sys.exit(main())
