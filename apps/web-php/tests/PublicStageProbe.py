#!/usr/bin/env python3
"""Read-only *public* QSYN Phase 1 acceptance probe.

Uses GET only. Does not log in, create sessions intentionally, send passwords,
touch broker accounts, access an admin endpoint, or modify the server.

For production/public checks run with HTTPS. An explicit localhost-only
switch permits isolated CI tests against PHP's built-in HTTP test server.
"""
import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

DENIALS = {401, 403, 404, 503}
MAX_BODY = 262144


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def origin_and_path(url, allow_loopback):
    parsed = urllib.parse.urlsplit(url)
    host = parsed.hostname or ""
    loopback = host in ("localhost", "127.0.0.1")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("Probe target must not include credentials, query or fragment")
    if parsed.scheme != "https" and not (
        allow_loopback and parsed.scheme == "http" and loopback
    ):
        raise ValueError("HTTPS required outside explicit localhost testing")
    if not host or (parsed.path not in ("", "/", "/qsyn", "/qsyn/")):
        raise ValueError("Provide an origin or /qsyn path, without other paths")
    if parsed.port is not None and not (1 <= parsed.port <= 65535):
        raise ValueError("Invalid port")
    authority = parsed.netloc
    base = f"{parsed.scheme}://{authority}"
    return base, "/qsyn"


def get_json(opener, origin, path):
    request = urllib.request.Request(
        origin + path,
        headers={"Accept": "application/json", "Cache-Control": "no-store"},
        method="GET",
    )
    try:
        response = opener.open(request, timeout=12)
    except urllib.error.HTTPError as error:
        response = error
    except (OSError, urllib.error.URLError) as error:
        raise AssertionError(f"{path}: endpoint could not be reached") from error
    with response:
        status = response.status
        size = response.headers.get("Content-Length")
        if size and int(size) > MAX_BODY:
            raise AssertionError(f"{path}: response exceeds inspection size limit")
        body = response.read(MAX_BODY + 1)
        if len(body) > MAX_BODY:
            raise AssertionError(f"{path}: response exceeds inspection size limit")
        content_type = response.headers.get("Content-Type", "")
        parsed = None
        if body and "json" in content_type.lower():
            try:
                parsed = json.loads(body.decode("utf-8"))
            except (ValueError, UnicodeDecodeError) as error:
                raise AssertionError(f"{path}: invalid JSON response") from error
        return status, parsed, response.headers


def assert_public_baseline(opener, origin, prefix, expected_commit):
    checks = []
    def inspect(path):
        status, result, headers = get_json(opener, origin, prefix + path)
        checks.append((path, status))
        # Safe external-runner diagnostics: status and media class only.
        # Never print response bodies, cookies, CSRF values or private fields.
        media = headers.get("Content-Type", "").lower()
        response_kind = ("json" if "json" in media else
                         "html" if "html" in media else "other")
        print(f"OBSERVE {path}: HTTP {status}, response={response_kind}", flush=True)
        return status, result, headers

    status, health, _ = inspect("/api/v1/health")
    if status != 200 or not isinstance(health, dict) or health.get("status") != "ok":
        raise AssertionError(f"Public QSYN web health is not OK (HTTP {status}; JSON object={isinstance(health, dict)})")

    status, demo, _ = inspect("/api/v1/demo/bars")
    if status != 200 or not isinstance(demo, dict) or demo.get("mode") != "simulated":
        raise AssertionError(f"Public demo bars are missing or not explicitly simulated (HTTP {status}; JSON object={isinstance(demo, dict)})")
    if not isinstance(demo.get("bars"), list) or len(demo["bars"]) < 1:
        raise AssertionError("Public demo has no bars")

    status, rust, _ = inspect("/api/v1/diagnostics/rust")
    if status != 200 or not isinstance(rust, dict):
        raise AssertionError(f"Public read-only Rust diagnostic is unavailable (HTTP {status}; JSON object={isinstance(rust, dict)})")
    runtime = rust.get("status")
    if runtime == "online":
        if rust.get("trading_enabled") is not False or rust.get("upstox_connected") is not False:
            raise AssertionError("Runtime live trading or real Upstox appears enabled")
        if expected_commit and rust.get("runtime_commit") != expected_commit:
            raise AssertionError("Runtime commit differs from operator-confirmed deployment")
    elif expected_commit:
        raise AssertionError("Runtime is not online; cannot verify expected deployed commit")
    elif runtime not in ("offline", "unavailable"):
        raise AssertionError("Unexpected Rust runtime state")

    for suffix in ("/api/v1/auth/state", "/api/v1/accounts/list", "/app"):
        status, body, headers = inspect(suffix)
        if status not in DENIALS:
            raise AssertionError(f"{suffix}: test identity/account UI is publicly reachable")
        if headers.get("Set-Cookie", "").startswith("QSYN_USER_SESSION="):
            raise AssertionError(f"{suffix}: disabled account route issued a user session")
        if isinstance(body, dict):
            if body.get("authenticated") is True or "csrf" in body or "accounts" in body:
                raise AssertionError(f"{suffix}: private mock session or account content leaked")

    for path, status in checks:
        print(f"PASS {path}: HTTP {status}")
    print("PASS: public Phase 1 account features are inaccessible")
    if runtime == "online":
        commit = str(rust.get("runtime_commit", "unknown"))
        print(f"PASS: trading and Upstox disabled; Rust runtime={commit[:12]}")
    else:
        print("NOTE: Rust is offline; commit was not verified")
    return checks


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="https://stage.digiti.in/qsyn",
                        help="Known QSYN origin or /qsyn prefix")
    parser.add_argument("--expected-commit", default=None,
                        help="Exact full 40-character SHA expected in online Rust diagnostics")
    parser.add_argument("--allow-loopback", action="store_true",
                        help="Only for disposable CI PHP server on localhost/127.0.0.1")
    args = parser.parse_args(argv)
    try:
        origin, prefix = origin_and_path(args.url, args.allow_loopback)
        if args.expected_commit is not None and (
            len(args.expected_commit) != 40 or
            not all(char in "0123456789abcdef" for char in args.expected_commit)
        ):
            raise ValueError("Expected commit must be a full lowercase Git SHA")
        assert_public_baseline(urllib.request.build_opener(NoRedirect()),
                               origin, prefix, args.expected_commit)
    except (ValueError, AssertionError) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
