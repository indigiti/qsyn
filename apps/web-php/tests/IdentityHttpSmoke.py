#!/usr/bin/env python3
"""Opt-in identity HTTP regression; no real accounts, credentials or HTTPS bypass off loopback."""
import http.cookiejar
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[3]
PHP = ROOT / "apps/web-php"
FAKE_PASSWORD = "test-only-strong-password-123456"


def open_port():
    with socket.socket() as server:
        server.bind(("127.0.0.1", 0))
        return server.getsockname()[1]


def client():
    jar = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar)), jar


def request(opener, origin, path, method="GET", data=None, csrf=None, browser_origin=None):
    headers = {"Accept": "application/json"}
    if method == "POST":
        headers["Content-Type"] = "application/json"
        headers["Origin"] = browser_origin or origin
        if csrf:
            headers["X-CSRF-Token"] = csrf
        data = json.dumps(data if data is not None else {}).encode()
    req = urllib.request.Request(origin + path, data=data, headers=headers, method=method)
    try:
        with opener.open(req, timeout=5) as response:
            return response.status, json.loads(response.read()), response.headers
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read()), error.headers


def fixture(env, directory, action, *args):
    base = """
require 'apps/web-php/src/FileStore.php';
require 'apps/web-php/src/UserRepository.php';
require 'apps/web-php/src/FileUserRepository.php';
$users = new QSYN\\Identity\\FileUserRepository(
    new QSYN\\Storage\\FileStore($argv[1])
);
"""
    if action == "create":
        code = base + "$users->createFixture($argv[2],$argv[3],$argv[4],$argv[5]);"
    else:
        code = base + """
$user = $users->verify($argv[2],$argv[3],$argv[4]);
if (!$user) exit(2);
$users->deactivateFixture($argv[2],$user['user_id'],$user['revision']);
"""
    subprocess.run(["php", "-r", code, str(directory), *args],
                   cwd=ROOT, env=env, check=True, capture_output=True, text=True)


def php_server(env, session_dir, port):
    return subprocess.Popen([
        "php", "-d", "session.save_path=" + str(session_dir),
        "-S", "127.0.0.1:" + str(port),
        "-t", "apps/web-php/public", "apps/web-php/dev-router.php",
    ], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def await_server(origin):
    for _ in range(70):
        try:
            with urllib.request.urlopen(origin + "/qsyn/api/v1/health", timeout=1):
                return
        except (urllib.error.URLError, TimeoutError):
            time.sleep(0.10)
    raise AssertionError("Local PHP server never became healthy")


def run():
    with tempfile.TemporaryDirectory(prefix="qsyn-identity-http-") as tmp:
        directory = Path(tmp) / "private-identity"
        directory.mkdir(mode=0o700)
        session_dir = Path(tmp) / "private-sessions"
        session_dir.mkdir(mode=0o700)
        env = os.environ.copy()
        env.update({
            "QSYN_ENV": "test",
            "QSYN_ALLOW_HTTP_TEST": "1",
            "QSYN_IDENTITY_ENABLED": "1",
            "QSYN_IDENTITY_STORAGE_DIR": str(directory),
        })
        fixture(env, directory, "create", "tenant-one", "alice", FAKE_PASSWORD, "member")
        fixture(env, directory, "create", "tenant-one", "bob", FAKE_PASSWORD, "viewer")
        fixture(env, directory, "create", "tenant-two", "alice", FAKE_PASSWORD, "tenant_admin")

        port = open_port()
        origin = "http://127.0.0.1:" + str(port)
        proc = php_server(env, session_dir, port)
        try:
            await_server(origin)
            opener, jar = client()
            url = "/qsyn/api/v1/auth/"
            status, state, headers = request(opener, origin, url + "state")
            assert status == 200 and state["authenticated"] is False
            assert state["profile"] == "mock-only"
            assert len(state["csrf"]) == 64
            cookies = list(jar)
            assert len(cookies) == 1 and cookies[0].name == "QSYN_USER_SESSION"
            assert cookies[0].path == "/qsyn/"
            cookie_header = headers.get("Set-Cookie", "")
            assert "httponly" in cookie_header.lower()
            assert "samesite=strict" in cookie_header.lower()
            assert "QSYN_ADMIN_SESSION" not in cookie_header
            assert request(opener, origin, url + "me")[0] == 401

            payload = {"tenant": "tenant-one", "username": "alice", "password": FAKE_PASSWORD}
            assert request(opener, origin, url + "login", "POST", payload,
                           state["csrf"], "http://attacker.example")[0] == 403
            assert request(opener, origin, url + "login", "POST", payload)[0] == 403
            bad = {**payload, "password": "bad-secret"}
            assert request(opener, origin, url + "login", "POST", bad, state["csrf"])[0] == 401
            wrong_tenant = {**payload, "tenant": "tenant-two", "password": "bad-secret"}
            assert request(opener, origin, url + "login", "POST", wrong_tenant, state["csrf"])[0] == 401

            status, login, _ = request(opener, origin, url + "login", "POST", payload, state["csrf"])
            assert status == 200 and login["authenticated"] is True, login
            assert login["user"]["tenant_id"] == "tenant-one"
            assert login["user"]["role"] == "member"
            assert login["csrf"] != state["csrf"]
            assert "password_hash" not in json.dumps(login)
            status, me, _ = request(opener, origin, url + "me")
            assert status == 200 and me["user"]["username"] == "alice"
            assert request(opener, origin, url + "login", "POST", payload, login["csrf"])[0] == 409
            assert request(opener, origin, url + "logout", "POST", {}, state["csrf"])[0] == 403
            status, logout, _ = request(opener, origin, url + "logout", "POST", {}, login["csrf"])
            assert status == 200 and logout["authenticated"] is False
            assert request(opener, origin, url + "me")[0] == 401

            status, again, _ = request(opener, origin, url + "login", "POST", payload, logout["csrf"])
            assert status == 200, again
            fixture(env, directory, "revoke", "tenant-one", "alice", FAKE_PASSWORD)
            assert request(opener, origin, url + "me")[0] == 401, "Disabled user retained session"

            independent, _ = client()
            _, state2, _ = request(independent, origin, url + "state")
            bob = {"tenant": "tenant-one", "username": "bob", "password": FAKE_PASSWORD}
            status, signed_in, _ = request(independent, origin, url + "login", "POST",
                                           bob, state2["csrf"])
            assert status == 200 and signed_in["user"]["username"] == "bob", signed_in
            assert request(opener, origin, url + "me")[0] == 401
            assert request(independent, origin, url + "me")[0] == 200

            attacker, _ = client()
            _, attacker_state, _ = request(attacker, origin, url + "state")
            for _ in range(5):
                assert request(attacker, origin, url + "login", "POST",
                               {"tenant": "tenant-one", "username": "unknown", "password": "x"},
                               attacker_state["csrf"])[0] == 401
            assert request(attacker, origin, url + "login", "POST",
                           {"tenant": "tenant-one", "username": "unknown", "password": "x"},
                           attacker_state["csrf"])[0] == 429
            print("PASS: login/logout, secure cookie, CSRF, origin, sessions, revocation, throttling")
        finally:
            proc.terminate()
            try:
                proc.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.communicate()

        # Feature is off by default even when mock users exist on disk.
        disabled_env = {**env, "QSYN_IDENTITY_ENABLED": "0"}
        off_port = open_port()
        off_origin = "http://127.0.0.1:" + str(off_port)
        off = php_server(disabled_env, session_dir, off_port)
        try:
            await_server(off_origin)
            disabled, _ = client()
            assert request(disabled, off_origin, "/qsyn/api/v1/auth/state")[0] == 503
            print("PASS: private test identity API disabled unless explicitly enabled")
        finally:
            off.terminate()
            try:
                off.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                off.kill()
                off.communicate()


if __name__ == "__main__":
    run()
