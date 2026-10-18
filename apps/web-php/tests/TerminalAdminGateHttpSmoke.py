#!/usr/bin/env python3
"""Terminal page/password/alias HTTP gate; real PHP sessions, no external broker."""
import http.cookiejar
import os
from pathlib import Path
import re
import subprocess
import tempfile
import urllib.error
import urllib.parse
import urllib.request

from IdentityHttpSmoke import await_server, open_port, php_server, request

PASSWORD = "ci-qsyn-admin-only-terminal-password-123456789"

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def browser():
    jar = http.cookiejar.CookieJar()
    return urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(jar), NoRedirect()), jar

def page(opener, base, route, method="GET", form=None, origin=None):
    body = (urllib.parse.urlencode(form).encode() if form is not None else None)
    headers = {"Accept": "text/html"}
    if form is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
        headers["Origin"] = origin or base
    req = urllib.request.Request(base + route, headers=headers, data=body, method=method)
    try:
        with opener.open(req, timeout=5) as r:
            return r.status, r.read().decode("utf-8"), r.headers
    except urllib.error.HTTPError as err:
        return err.code, err.read().decode("utf-8"), err.headers

def run():
    # PHP-only CI runs before the frontend JS/CSS build. Temporary inert
    # files satisfy the shell's existence check without enabling any feed.
    assets = Path(__file__).resolve().parents[1] / "public" / "assets"
    installed = []
    for name in ("terminal.js", "terminal.css"):
        target = assets / name
        if not target.exists():
            target.write_text("/* CI placeholder: no executable terminal data */", encoding="utf-8")
            installed.append(target)
    with tempfile.TemporaryDirectory(prefix="qsyn-terminal-gate-") as tmp:
        parent = Path(tmp)
        private = parent / "private"
        sessions = parent / "sessions"
        private.mkdir(mode=0o700)
        sessions.mkdir(mode=0o700)
        hashed = subprocess.check_output([
            "php", "-r", "echo password_hash($argv[1], PASSWORD_DEFAULT);", PASSWORD
        ], text=True).strip()
        env = {**os.environ, "QSYN_ALLOW_HTTP_TEST": "1",
               "QSYN_CONTROL_ENABLED": "1", "QSYN_ADMIN_PASSWORD_HASH": hashed,
               "QSYN_RUNTIME_DIR": str(private)}
        port = open_port()
        origin = f"http://127.0.0.1:{port}"
        php = php_server(env, sessions, port)
        try:
            await_server(origin)
            guest, cookiejar = browser()
            status, home, headers = page(guest, origin, "/qsyn/")
            assert status == 200 and 'id="qsyn-root"' in home, (status, repr(home[:700]), dict(headers))
            assert "/qsyn/assets/terminal.js" in home
            assert "no-store" in headers.get("Cache-Control", "")
            assert "no-transform" not in headers.get("Cache-Control", "")
            home_nonce = re.search(r"script-src 'self' 'nonce-([A-Za-z0-9+/=]+)'",
                                   headers.get("Content-Security-Policy", ""))
            assert home_nonce, "Homepage missing cryptographic CSP nonce"
            assert f'nonce="{home_nonce.group(1)}"' in home
            again, home_again, new_headers = page(guest, origin, "/qsyn/")
            new_nonce = re.search(r"script-src 'self' 'nonce-([A-Za-z0-9+/=]+)'",
                                  new_headers.get("Content-Security-Policy", ""))
            assert again == 200 and new_nonce and new_nonce.group(1) != home_nonce.group(1)
            assert f'nonce="{new_nonce.group(1)}"' in home_again
            for path in [
                "/qsyn/terminal", "/qsyn/terminal/",
                "/qsyn/terminal/trading", "/qsyn/terminal/brokers",
                "/qsyn/terminal/operations", "/qsyn/terminal/routes",
                "/qsyn/terminal?view=private-live",
                "/qsyn/studio", "/qsyn/admin/rust", "/qsyn/legacy-chart",
            ]:
                code, data, hdr = page(guest, origin, path)
                assert code == 303 and hdr.get("Location")=="/qsyn/terminal/login", (path,code)
                assert "no-store" in hdr.get("Cache-Control","")
                assert "terminal.js" not in data
            status, login, headers = page(guest,origin,"/qsyn/terminal/login")
            assert status==200 and "Administrator sign-in" in login
            assert "terminal.js" not in login
            assert "unsafe-inline" not in headers.get("Content-Security-Policy","")
            assert "no-transform" in headers.get("Cache-Control", ""), "login HTML allows script injection"
            csrf = re.search(r'name="csrf" value="([a-f0-9]{64})"', login).group(1)
            assert any(cookie.name=="QSYN_ADMIN_SESSION" for cookie in cookiejar)
            code,_,_=page(guest,origin,"/qsyn/terminal/login","POST",
                          {"csrf":"e"*64,"password":PASSWORD})
            assert code==403
            code,_,_=page(guest,origin,"/qsyn/terminal/login","POST",
                          {"csrf":csrf,"password":PASSWORD},origin="http://attacker.test")
            assert code==403
            code,body,_=page(guest,origin,"/qsyn/terminal/login","POST",
                             {"csrf":csrf,"password":"wrong"})
            assert code==401 and "Invalid administrator password" in body
            code,body,headers=page(guest,origin,"/qsyn/terminal/login","POST",
                                   {"csrf":csrf,"password":PASSWORD})
            assert code==303 and headers.get("Location")=="/qsyn/terminal/dashboard"
            for path in ["/qsyn/terminal/brokers","/qsyn/terminal/operations",
                         "/qsyn/terminal/private-live"]:
                code,body,headers=page(guest,origin,path)
                assert code==200 and "/qsyn/assets/terminal.js" in body, (path,code)
                assert "no-store" in headers.get("Cache-Control", ""), path
                assert "no-transform" not in headers.get("Cache-Control", ""), path
                nonce = re.search(r"script-src 'self' 'nonce-([A-Za-z0-9+/=]+)'",
                                  headers.get("Content-Security-Policy", ""))
                assert nonce and f'nonce="{nonce.group(1)}"' in body, path
            code,_,headers=page(guest,origin,"/qsyn/studio")
            assert code==302 and headers.get("Location")=="/qsyn/terminal/strategy"
            code,_,headers=page(guest,origin,"/qsyn/terminal")
            assert code==302 and headers.get("Location")=="/qsyn/terminal/dashboard"
            redirect=page(guest,origin,"/qsyn/terminal/trading")
            assert redirect[0]==302 and redirect[2].get("Location")=="/qsyn/terminal/workspaces"
            code,_,_=page(guest,origin,"/qsyn/terminal/brokers","POST",{"x":"y"})
            assert code==405
            code,_,_=page(guest,origin,"/qsyn/terminal/unknown")
            assert code==404

            _,state,_=request(guest,origin,"/qsyn/api/v1/admin/rust/state")
            assert state["authenticated"] is True
            code,bye,_=request(guest,origin,"/qsyn/api/v1/admin/rust/logout",
                               "POST",{},state["csrf"])
            assert code==200 and bye["authenticated"] is False
            assert page(guest,origin,"/qsyn/terminal/brokers")[0]==303
            assert page(guest,origin,"/qsyn/")[0]==200
            print("PASS admin-only pages, aliases, CSRF login/logout, CSP, unknown paths and public homepage")
        finally:
            php.terminate()
            php.communicate(timeout=5)

        # First-visit administrator bootstrap remains reachable without an
        # existing terminal session, requiring a private setup code.
        first_private = parent / "first-private"
        first_private.mkdir(mode=0o700)
        env = {**env,"QSYN_RUNTIME_DIR":str(first_private)}
        env.pop("QSYN_ADMIN_PASSWORD_HASH",None)
        new_port=open_port()
        base=f"http://127.0.0.1:{new_port}"
        proc=php_server(env,sessions,new_port)
        try:
            await_server(base)
            fresh,_=browser()
            code,body,_=page(fresh,base,"/qsyn/terminal/login")
            assert code==200 and "Administrator setup" in body
            csrf=re.search(r'name="csrf" value="([a-f0-9]{64})"',body).group(1)
            setup_file=first_private/"admin-setup-code.txt"
            assert setup_file.is_file() and setup_file.stat().st_mode & 0o777==0o600
            code_val=setup_file.read_text().strip()
            wrong={"csrf":csrf,"setup_code":"f"*64,
                   "new_password":PASSWORD,"confirm_password":PASSWORD}
            assert page(fresh,base,"/qsyn/terminal/login","POST",wrong)[0]==403
            correct={**wrong,"setup_code":code_val}
            code,_,headers=page(fresh,base,"/qsyn/terminal/login","POST",correct)
            assert code==303, (code,headers)
            assert (first_private/"admin-auth.json").stat().st_mode & 0o777==0o600
            assert page(fresh,base,"/qsyn/terminal/brokers")[0]==200
            print("PASS private first-time administrator password setup without public terminal")
        finally:
            proc.terminate()
            proc.communicate(timeout=5)
    for target in installed:
        target.unlink(missing_ok=True)

if __name__=="__main__":
    run()
