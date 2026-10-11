#!/usr/bin/env python3
"""QSYN native Upstox web OAuth: admin/CSRF, private app, no provider network."""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import urllib.request
import urllib.error
from urllib.parse import urlsplit, parse_qs
from IdentityHttpSmoke import await_server, client, open_port, php_server, request

PASSWORD = "ci-native-upstox-admin-password-123456"
SECRET = "fake_upstox_application_secret_for_test_only_4342"
USER_ID = "UPSTOX123"
API = "/qsyn/api/v1/admin/upstox/"
ADMIN = "/qsyn/api/v1/admin/rust/"

def main():
    with tempfile.TemporaryDirectory(prefix="qsyn-upstox-web-oauth-") as dirname:
        runtime = Path(dirname) / "runtime"
        sessions = Path(dirname) / "sessions"
        runtime.mkdir(mode=0o700)
        sessions.mkdir(mode=0o700)
        hash_ = subprocess.check_output([
            "php","-r","echo password_hash($argv[1],PASSWORD_DEFAULT);",PASSWORD
        ],text=True).strip()
        env = {**os.environ, "QSYN_ALLOW_HTTP_TEST":"1",
               "QSYN_CONTROL_ENABLED":"1","QSYN_ADMIN_PASSWORD_HASH":hash_,
               "QSYN_RUNTIME_DIR":str(runtime),"QSYN_TRADING_ENABLED":"0",
               "QSYN_ENABLE_LIVE_TRADING":"0"}
        port = open_port()
        origin = f"http://127.0.0.1:{port}"
        proc = php_server(env,sessions,port)
        try:
            await_server(origin)
            guest,_=client()
            assert request(guest,origin,API+"status")[0]==401
            assert request(guest,origin,API+"setup","POST",{})[0]==401
            assert request(guest,origin,API+"begin","POST",{})[0]==401
            admin,_=client()
            code,login,_=request(admin,origin,ADMIN+"login","POST",{"password":PASSWORD})
            assert code==200 and login["authenticated"],(code,login)
            csrf=login["csrf"]
            code,initial,_=request(admin,origin,API+"status")
            assert code==200 and not initial["configured"] and not initial["token_stored"],(code,initial)
            assert initial["oauth_callback_uri"]==origin+API+"callback"
            assert initial["index_feed_activated"] is False
            payload={"client_id":"upstoxApp1234","client_secret":SECRET,
                     "expected_user_id":USER_ID,"confirmed":True}
            assert request(admin,origin,API+"setup","POST",payload)[0]==403
            assert request(admin,origin,API+"setup","POST",payload,"bad")[0]==403
            assert request(admin,origin,API+"setup","POST",payload,csrf,
                           "http://attacker.invalid")[0]==403
            assert request(admin,origin,API+"setup","POST",{
                **payload,"client_secret":"bad"})[0]==403
            invalids=[
                {**payload,"client_secret":"short"},
                {**payload,"expected_user_id":"!"},
                {**payload,"client_id":"abc"},
                {**payload,"confirmed":False},
                {**payload,"tenant_id":"foreign"},
            ]
            for case in invalids:
                code,body,_=request(admin,origin,API+"setup","POST",case,csrf)
                assert code==422,(code,body)
                assert SECRET not in json.dumps(body)
            assert request(admin,origin,API+"begin","POST",{},csrf)[0]==503
            code,saved,_=request(admin,origin,API+"setup","POST",payload,csrf)
            assert code==201 and saved["configured"],(code,saved)
            assert SECRET not in json.dumps(saved)
            folder=runtime/"upstox-private"
            for path in [folder/"upstox-app.json",folder/"upstox-client-secret.key"]:
                assert path.is_file() and path.stat().st_mode&0o777==0o600
            assert folder.stat().st_mode&0o777==0o700
            assert (folder/"upstox-client-secret.key").read_text().strip()==SECRET
            assert request(admin,origin,API+"setup","POST",payload,csrf)[0]==409
            code,configured,_=request(admin,origin,API+"status")
            assert code==200 and configured["configured"]
            assert configured["token_stored"] is False
            assert request(guest,origin,API+"verify","POST",{})[0]==401
            assert request(admin,origin,API+"verify","POST",{})[0]==403
            assert request(admin,origin,API+"verify","POST",{},'0'*64)[0]==403
            assert request(admin,origin,API+"verify","POST",{},csrf,
                           "http://attacker.invalid")[0]==403
            code,not_ready,_=request(admin,origin,API+"verify","POST",{},csrf)
            assert code==200 and not not_ready["session_verified"]
            assert not not_ready["index_feed_activated"] and not not_ready["trading_enabled"]
            assert SECRET not in json.dumps(configured)
            assert request(admin,origin,API+"begin","POST",{},csrf,
                           "http://attacker.invalid")[0]==403
            assert request(admin,origin,API+"begin","POST",{},'0'*64)[0]==403
            code,begin,_=request(admin,origin,API+"begin","POST",{},csrf)
            assert code==200 and begin["oauth_pending"],(code,begin)
            url=urlsplit(begin["authorization_url"])
            assert url.scheme=="https" and url.hostname=="api.upstox.com"
            assert url.path=="/v2/login/authorization/dialog"
            params=parse_qs(url.query)
            assert len(params["state"][0])==64
            assert params["redirect_uri"]==[origin+API+"callback"]
            pending=folder/"upstox-oauth-pending.json"
            assert pending.is_file() and pending.stat().st_mode&0o777==0o600
            assert SECRET not in pending.read_text()
            # Direct external callback must reject a wrong state without a
            # session cookie, never reach Upstox and never echo the code.
            bad=origin+API+"callback?state="+"0"*64+"&code=FAKECODE777"
            with urllib.request.build_opener(NoRedirect()).open(bad) as response:
                raise AssertionError("callback should redirect")
        except urllib.error.HTTPError as error:
            # An external callback returns 303 to a sanitized terminal URL,
            # but urllib normally follows 303. The custom handler catches it.
            assert error.code==303 and "upstox_oauth=failed" in error.headers["Location"],error
            assert SECRET not in error.read().decode()
        finally:
            proc.terminate()
            proc.communicate(timeout=5)
        # The pending state was consumed on invalid callback. Starting
        # a new session and mocking the *server-only* exchange tests success.
        proc = php_server(env,sessions,port)
        try:
            await_server(origin)
            admin,_=client()
            code,login,_=request(admin,origin,ADMIN+"login","POST",{"password":PASSWORD})
            csrf=login["csrf"]
            code,begin,_=request(admin,origin,API+"begin","POST",{},csrf)
            assert code==200
            state=parse_qs(urlsplit(begin["authorization_url"]).query)["state"][0]
            php_code = r"""
require 'apps/web-php/src/RustAdmin.php';
require 'apps/web-php/src/UpstoxOperatorOAuth.php';
require 'apps/web-php/src/NativeUpstoxWebApi.php';
$result=QSYN\Broker\NativeUpstoxWebApi::dispatch(
  'callback',
  ['REQUEST_METHOD'=>'GET','HTTP_HOST'=>$argv[1]],
  ['code'=>'fake-one-use-code','state'=>$argv[2]],
  static function(string $url,array $form):array {
    if($url!=='https://api.upstox.com/v2/login/authorization/token'
      || $form['code']!=='fake-one-use-code') throw new RuntimeException('invalid_exchange');
    return ['user_id'=>'UPSTOX123','access_token'=>str_repeat('T',80),'token_type'=>'Bearer'];
  }
);
echo json_encode($result);
"""
            result=subprocess.run(["php","-r",php_code,f"127.0.0.1:{port}",state],
                cwd=Path(__file__).resolve().parents[3],env=env,capture_output=True,text=True,timeout=5)
            assert result.returncode==0,(result.stderr[:250],result.stdout[:250])
            result_json=json.loads(result.stdout)
            assert result_json[0]==303 and "upstox_oauth=stored" in result_json[1]["location"]
            code,status,_=request(admin,origin,API+"status")
            assert code==200 and status["token_stored"] and status["provider_user_id_checked_at_exchange"]
            assert not status["index_feed_activated"] and not status["trading_enabled"]
            assert SECRET not in json.dumps(status)
            tokenfile=folder/"upstox-session.json"
            assert tokenfile.is_file() and tokenfile.stat().st_mode&0o777==0o600
            session=json.loads(tokenfile.read_text())
            assert session["user_id"]==USER_ID and not session["order_routing_enabled"]
            assert "TTTT" not in json.dumps(status)
            result2=subprocess.run(["php","-r",php_code,f"127.0.0.1:{port}",state],
                cwd=Path(__file__).resolve().parents[3],env=env,capture_output=True,text=True)
            assert json.loads(result2.stdout)[1]["location"].endswith("upstox_oauth=failed")
            code,logout,_=request(admin,origin,ADMIN+"logout","POST",{},csrf)
            assert code==200 and not logout["authenticated"]
            assert request(admin,origin,API+"status")[0]==401
            print("PASS native Upstox web OAuth: admin-only, private 0600, state/CSRF, fake callback identity, replay denial, no live feed/orders")
        finally:
            proc.terminate()
            proc.communicate(timeout=5)

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

if __name__=="__main__":
    main()
