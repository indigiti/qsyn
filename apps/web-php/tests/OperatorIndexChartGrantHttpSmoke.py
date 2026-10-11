#!/usr/bin/env python3
"""Private operator index chart grant contract. Loopback fixtures; no Upstox IO."""
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import subprocess
import tempfile
from IdentityHttpSmoke import await_server, client, open_port, php_server, request

PASSWORD="operator-index-fixture-password-123456789"
ACCESS="/qsyn/api/v1/admin/upstox/private-chart-access"
GRANT="/qsyn/api/v1/admin/upstox/private-chart-grant"
KEY=bytes([37]*32)
INDEX="NSE_INDEX|Nifty 50"

def main():
    with tempfile.TemporaryDirectory(prefix="qsyn-operator-index-") as tmp:
        root=Path(tmp)
        runtime=root/"runtime"
        private=runtime/"upstox-private"
        sessions=root/"sessions"
        for folder in [runtime,private,sessions]:
            folder.mkdir(mode=0o700)
        rights=private/"chart-rights.json"
        signing=private/"chart-signing.key"
        fake={
            "schema":"QSYN-PRIVATE-CHART-ENTITLEMENT/1",
            "tenant":"tenant-fixture","account":"approved-upstox-A",
            "owner":"single-operator","broker":"upstox","license_id":"test-license",
            "instruments":[INDEX],"can_display_to_this_user":True,
            "broker_session_verified":True,"valid_until_ms":9999999999999,
        }
        def write_rights(value):
            rights.write_text(json.dumps(value))
            rights.chmod(0o600)
        write_rights(fake)
        signing.write_bytes(KEY)
        signing.chmod(0o600)
        hashed=subprocess.check_output(["php","-r",
            "echo password_hash($argv[1],PASSWORD_DEFAULT);",PASSWORD],text=True).strip()
        port=open_port()
        origin=f"http://127.0.0.1:{port}"
        env={**os.environ,
            "QSYN_ALLOW_HTTP_TEST":"1","QSYN_CONTROL_ENABLED":"1",
            "QSYN_ADMIN_PASSWORD_HASH":hashed,
            "QSYN_RUNTIME_DIR":str(runtime),
            "QSYN_PRIVATE_OPERATOR_CHART_ENABLED":"1",
            "QSYN_PRIVATE_CHART_GRANTS_ENABLED":"1",
            "QSYN_PRIVATE_OPERATOR_CHART_HOST":f"127.0.0.1:{port}",
            "QSYN_PRIVATE_OPERATOR_CHART_TENANT":"tenant-fixture",
            "QSYN_PRIVATE_OPERATOR_CHART_OWNER":"single-operator",
            "QSYN_PRIVATE_OPERATOR_CHART_ACCOUNT":"approved-upstox-A",
            "QSYN_PRIVATE_CHART_RIGHTS_FILE":str(rights),
            "QSYN_PRIVATE_CHART_SIGNING_KEY_FILE":str(signing),
            "QSYN_TRADING_ENABLED":"0","QSYN_ENABLE_LIVE_TRADING":"0",
        }
        process=php_server(env,sessions,port)
        try:
            await_server(origin)
            anonymous,_=client()
            assert request(anonymous,origin,ACCESS)[0]==401
            assert request(anonymous,origin,GRANT,"POST",{"account_id":"approved-upstox-A","instrument":INDEX})[0]==401
            admin,_=client()
            login=request(admin,origin,"/qsyn/api/v1/admin/rust/login","POST",
                {"password":PASSWORD})
            assert login[0]==200,login
            code,access,_=request(admin,origin,ACCESS)
            assert code==200,access
            assert access["schema"]=="QSYN-PRIVATE-OPERATOR-CHART-ACCESS/1"
            assert access["profile"]=="operator-admin"
            assert access["account_id"]=="approved-upstox-A"
            assert not access["private_rights_attested"] and not access["live_feed_verified"]
            csrf=access["csrf"]
            payload={"account_id":"approved-upstox-A","instrument":INDEX}
            assert request(admin,origin,GRANT,"POST",payload)[0]==403
            assert request(admin,origin,GRANT,"POST",payload,csrf,origin.replace("127.0.0.1","evil.example"))[0]==403
            assert request(admin,origin,GRANT,"POST",{"account_id":"other","instrument":INDEX},csrf)[0]==422
            assert request(admin,origin,GRANT,"POST",{"account_id":payload["account_id"],
                "instrument":"NSE_INDEX|Nifty/50"},csrf)[0]==422
            code,grant,headers=request(admin,origin,GRANT,"POST",payload,csrf)
            assert code==200,grant
            assert grant["schema"]=="QSYN-PRIVATE-CHART-GRANT-RESPONSE/1"
            assert grant["instrument"]==INDEX and grant["account_id"]==payload["account_id"]
            assert grant["trading_enabled"] is False
            assert grant["public_redistribution_allowed"] is False
            assert "no-store" in headers["Cache-Control"]
            parts=grant["ticket"].split(".")
            assert len(parts)==2
            pad=lambda s:s+"="*((4-len(s)%4)%4)
            raw=base64.urlsafe_b64decode(pad(parts[0]))
            sig=base64.urlsafe_b64decode(pad(parts[1]))
            assert hmac.compare_digest(hmac.new(KEY,raw,hashlib.sha256).digest(),sig)
            data=json.loads(raw)
            assert data["account"]=="approved-upstox-A"
            assert data["owner"]=="single-operator"
            assert data["tenant"]=="tenant-fixture"
            assert data["instrument"]==INDEX
            assert data["audience"]=="qsyn-private-chart"
            assert data["expires_ms"]-data["issued_ms"]==30000
            assert request(anonymous,origin,GRANT,"POST",payload,csrf)[0]==401
            denied=dict(fake,can_display_to_this_user=False)
            write_rights(denied)
            assert request(admin,origin,GRANT,"POST",payload,csrf)[0]==403
            denied=dict(fake,account="other-account")
            write_rights(denied)
            assert request(admin,origin,GRANT,"POST",payload,csrf)[0]==403
            write_rights(fake)
            signing.chmod(0o644)
            assert request(admin,origin,GRANT,"POST",payload,csrf)[0]==503
            signing.chmod(0o600)
            assert request(admin,origin,GRANT,"POST",payload,csrf)[0]==200
            result=request(admin,origin,"/qsyn/api/v1/admin/rust/logout","POST",{},login[1]["csrf"])
            assert result[0]==200
            assert request(admin,origin,ACCESS)[0]==401
            sensitive=json.dumps(access)+json.dumps(grant)
            for secret in [PASSWORD,"test-secret","client_secret","access_token",str(runtime)]:
                assert secret not in sensitive
            print("PASS operator index chart grants: bound identity, rights, signature, CSRF, revocation, 0600, logout")
        finally:
            process.terminate()
            process.communicate(timeout=5)

if __name__=="__main__":
    main()
