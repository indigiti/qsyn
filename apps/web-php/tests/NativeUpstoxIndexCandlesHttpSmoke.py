#!/usr/bin/env python3
"""Private index candles: gate checks only, no Upstox requests or credentials."""
import os
import subprocess
import tempfile
from pathlib import Path
from IdentityHttpSmoke import await_server, client, open_port, php_server, request

BASE="/qsyn/api/v1/admin/upstox/index-candles"
PASSWORD="test-index-history-password-01234567890"

def main():
    with tempfile.TemporaryDirectory(prefix="qsyn-admin-index-") as tmp:
        runtime=Path(tmp)/"runtime"
        private=runtime/"upstox-private"
        sessions=Path(tmp)/"sessions"
        for folder in [runtime,private,sessions]:
            folder.mkdir(mode=0o700)
        hashed=subprocess.check_output(["php","-r",
            "echo password_hash($argv[1],PASSWORD_DEFAULT);",PASSWORD],
            text=True).strip()
        env={**os.environ,"QSYN_ALLOW_HTTP_TEST":"1","QSYN_CONTROL_ENABLED":"1",
             "QSYN_RUNTIME_DIR":str(runtime),"QSYN_ADMIN_PASSWORD_HASH":hashed,
             "QSYN_TRADING_ENABLED":"0","QSYN_ENABLE_LIVE_TRADING":"0"}
        port=open_port()
        host=f"http://127.0.0.1:{port}"
        server=php_server(env,sessions,port)
        try:
            await_server(host)
            anon,_=client()
            assert request(anon,host,BASE+"?symbol=NIFTY&interval=1m")[0]==401
            admin,_=client()
            code,login,_=request(admin,host,
                "/qsyn/api/v1/admin/rust/login","POST",{"password":PASSWORD})
            assert code==200,login
            code,notready,headers=request(admin,host,BASE+"?symbol=NIFTY&interval=1m")
            assert code==409,(code,notready)
            assert notready["code"]=="UPSTOX_ANALYTICS_SESSION_NOT_READY"
            assert "no-store" in headers["Cache-Control"]
            assert "access_token" not in str(notready)
            assert request(admin,host,BASE+"?symbol=../../NIFTY&interval=1m")[0]==409
            assert request(admin,host,BASE,"POST",{})[0]==405
            assert request(admin,host,BASE+"?symbol=NIFTY&interval=1m",
                browser_origin="http://malicious.invalid")[0]==403
            code,logout,_=request(admin,host,
                "/qsyn/api/v1/admin/rust/logout","POST",{},login["csrf"])
            assert code==200
            assert request(admin,host,BASE+"?symbol=NIFTY&interval=1m")[0]==401
            print("PASS private index candles: admin session, origin, logout, no token exposure")
        finally:
            server.terminate()
            server.communicate(timeout=5)
if __name__=="__main__":
    main()
