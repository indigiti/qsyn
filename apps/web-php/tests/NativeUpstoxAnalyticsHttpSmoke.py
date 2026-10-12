#!/usr/bin/env python3
"""Analytics Token HTTP gates. Never calls Upstox or supplies a real bearer."""
import json
import os
import subprocess
import tempfile
from pathlib import Path
from IdentityHttpSmoke import await_server, client, open_port, php_server, request

PASSWORD="qsyn-analytics-ci-password-0123456789"
BASE="/qsyn/api/v1/admin/upstox/analytics/"

def run():
    with tempfile.TemporaryDirectory(prefix="qsyn-analytics-http-") as tmp:
        runtime=Path(tmp)/"runtime"
        private=runtime/"upstox-private"
        sessions=Path(tmp)/"sessions"
        for item in [runtime,private,sessions]:
            item.mkdir(mode=0o700)
        hashed=subprocess.check_output(["php","-r",
            "echo password_hash($argv[1], PASSWORD_DEFAULT);",PASSWORD],text=True).strip()
        env={**os.environ,
            "QSYN_CONTROL_ENABLED":"1",
            "QSYN_ALLOW_HTTP_TEST":"1",
            "QSYN_UPSTOX_ANALYTICS_IMPORT_ENABLED":"1",
            "QSYN_UPSTOX_ANALYTICS_EXPECTED_USER_ID":"TEST_ACCOUNT",
            "QSYN_RUNTIME_DIR":str(runtime),
            "QSYN_ADMIN_PASSWORD_HASH":hashed,
            "QSYN_TRADING_ENABLED":"0","QSYN_ENABLE_LIVE_TRADING":"0"}
        port=open_port()
        origin=f"http://127.0.0.1:{port}"
        server=php_server(env,sessions,port)
        try:
            await_server(origin)
            anon,_=client()
            assert request(anon,origin,BASE+"status")[0]==401
            assert request(anon,origin,BASE+"import","POST",
                {"token":"this-is-not-a-live-token-000","confirmed":True})[0]==401
            admin,_=client()
            status,login,_=request(admin,origin,
                "/qsyn/api/v1/admin/rust/login","POST",{"password":PASSWORD})
            assert status==200,(status,login)
            status,report,headers=request(admin,origin,BASE+"status")
            assert status==200,(status,report)
            assert report["schema"]=="QSYN-UPSTOX-ANALYTICS-STATUS/1"
            assert report["token_stored"] is False
            assert report["provider_feed_authorized_now"] is False
            assert report["provider_account_identity_verified"] is False
            assert report["trading_enabled"] is False
            assert "no-store" in headers["Cache-Control"]
            assert request(admin,origin,BASE+"import","POST",
                {"token":"bad","confirmed":True})[0]==403
            assert request(admin,origin,BASE+"import","POST",
                {"token":"bad","confirmed":True},report["csrf"],
                browser_origin="http://another.example")[0]==403
            assert request(admin,origin,BASE+"import","POST",
                {"token":"bad","confirmed":True},report["csrf"])[0]==422
            assert request(admin,origin,BASE+"verify","POST",
                {"confirmed":True})[0]==403
            assert request(admin,origin,BASE+"verify","POST",
                {"confirmed":True},report["csrf"],
                browser_origin="http://malicious.example")[0]==403
            assert request(admin,origin,BASE+"verify","POST",
                {"confirmed":True},report["csrf"])[0]==409
            assert request(anon,origin,BASE+"verify","POST",
                {"confirmed":True},report["csrf"])[0]==401
            assert request(admin,origin,BASE+"clear","POST",
                {"confirmed":True},report["csrf"])[0]==200
            assert not (private/"upstox-analytics-session.json").exists()
            assert not (private/"upstox-session.json").exists()
            assert request(admin,origin,BASE+"import")[0]==405
            assert request(admin,origin,BASE+"status","POST",{},report["csrf"])[0]==405
            assert request(anon,origin,BASE+"clear","POST",
                {"confirmed":True},report["csrf"])[0]==401
            _,logout,_=request(admin,origin,
                "/qsyn/api/v1/admin/rust/logout","POST",{},login["csrf"])
            assert logout["authenticated"] is False
            assert request(admin,origin,BASE+"status")[0]==401
            print("PASS analytics token HTTP: admin/CSRF/origin controls, no app required, no OAuth overwrite")
        finally:
            server.terminate()
            server.communicate(timeout=5)
if __name__=="__main__":
    run()
