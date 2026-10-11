#!/usr/bin/env python3
"""Authenticated diagnostics and session lifecycle: no secrets in exported JSON."""
import os
from pathlib import Path
import subprocess
import tempfile
from IdentityHttpSmoke import await_server,client,open_port,php_server,request

PASSWORD="ci-diagnostics-admin-password-123456789"
API="/qsyn/api/v1/admin/diagnostics/report"
STATE="/qsyn/api/v1/admin/rust/state"
ADMIN="/qsyn/api/v1/admin/rust/"

def main():
  with tempfile.TemporaryDirectory(prefix="qsyn-audit-") as temp:
    root=Path(temp)
    runtime=root/"private"
    sessions=root/"sessions"
    runtime.mkdir(mode=0o700);sessions.mkdir(mode=0o700)
    hashed=subprocess.check_output(["php","-r",
      "echo password_hash($argv[1],PASSWORD_DEFAULT);",PASSWORD],text=True).strip()
    env={**os.environ,"QSYN_ALLOW_HTTP_TEST":"1","QSYN_CONTROL_ENABLED":"1",
      "QSYN_ADMIN_PASSWORD_HASH":hashed,"QSYN_RUNTIME_DIR":str(runtime)}
    port=open_port()
    origin=f"http://127.0.0.1:{port}"
    p=php_server(env,sessions,port)
    try:
      await_server(origin)
      anon,_=client()
      code,data,headers=request(anon,origin,API)
      assert code==401 and data["diagnostic_code"]=="ADMIN_REAUTH_REQUIRED", (code,data)
      assert len(data["request_id"])==16
      assert request(anon,origin,API,"POST",{})[0]==405
      admin,_=client()
      code,login,_=request(admin,origin,ADMIN+"login","POST",{"password":PASSWORD})
      assert code==200 and login["authenticated"],(code,login)
      code,state,_=request(admin,origin,STATE)
      assert code==200 and state["session"]["authenticated"],(code,state)
      assert state["session"]["cookie_received"] and state["session"]["cookie_secure_expected"] is False
      assert state["session"]["idle_remaining_seconds"]>0
      assert state["session"]["reason_code"]=="authenticated"
      code,data,headers=request(admin,origin,API)
      assert code==200,(code,data)
      assert data["schema"]=="QSYN-ADMIN-DIAGNOSTICS/1"
      assert headers["Cache-Control"].find("no-store")>=0
      assert headers["X-QSYN-Request-ID"]==data["request_id"]
      assert data["trading_enabled"] is False and not data["live_index_feed_verified"]
      assert data["admin"]["cookie_path"]=="/qsyn/"
      keys=[x["component"] for x in data["components"]]
      assert "upstox_profile" in keys and "index_worker_binary" in keys
      serialized=str(data).lower()
      for banned in [PASSWORD.lower(),"authorization:","bearer ","client_secret",
        "access_token","qsyn_admin_session=","/tmp/qsyn-audit-"]:
        assert banned not in serialized,banned
      # No accidental automatic provider check, no account tokens or positions.
      code,logout,_=request(admin,origin,ADMIN+"logout","POST",{},login["csrf"])
      assert code==200 and logout["authenticated"] is False
      assert request(admin,origin,API)[0]==401
      assert request(admin,origin,STATE)[1]["session"]["reason_code"]=="signed_out"
      print("PASS admin diagnostics: auth, safe JSON, request ID, state/expiry, logout")
    finally:
      p.terminate()
      p.communicate(timeout=5)

if __name__=="__main__":
  main()
