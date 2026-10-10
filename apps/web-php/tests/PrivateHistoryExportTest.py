#!/usr/bin/env python3
"""Local fake-OpenAlgo end-to-end history export, no real broker account."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT=Path(__file__).resolve().parents[3]
CLI=ROOT/"apps/web-php/tools/private-history-export.php"
KEY="fake-openalgo-app-key-for-history-2026"

class Provider(BaseHTTPRequestHandler):
    def do_POST(self):
        n=int(self.headers.get("Content-Length","0"))
        args=json.loads(self.rfile.read(min(n,4096)))
        if self.path!="/api/v1/history" or args.get("apikey")!=KEY:
            self.send_response(403);self.end_headers();return
        payload=json.dumps({"status":"success","data":[{
            "timestamp":"2026-10-09 09:15:00+05:30",
            "open":100,"high":103,"low":98,"close":102,"volume":10,
            "private_broker_token":KEY
        },{
            "timestamp":"2026-10-09 09:16:00+05:30",
            "open":102,"high":110,"low":101,"close":109,"volume":12
        }]}).encode()
        self.send_response(200)
        self.send_header("Content-Length",str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
    def log_message(self,*_):pass

def main():
    srv=ThreadingHTTPServer(("127.0.0.1",0),Provider)
    worker=threading.Thread(target=srv.serve_forever,daemon=True);worker.start()
    try:
        with tempfile.TemporaryDirectory(prefix="qsyn-private-history-") as name:
            root=Path(name);root.chmod(0o700)
            key=root/"app-key";key.write_text(KEY);key.chmod(0o600)
            reg=root/"broker-registry.json"
            reg.write_text(json.dumps({
                "schema":"QSYN-PRIVATE-OPENALGO-REGISTRY/1",
                "accounts":[{
                    "account_id":"upstox-a","tenant_id":"tenant1","owner_user_id":"owner1",
                    "broker":"upstox","rest_port":srv.server_port,"ws_port":8765,
                    "openalgo_apikey_file":str(key)
                }]
            }));reg.chmod(0o600)
            rights=root/"retention-rights.json"
            def approve(enabled):
                rights.write_text(json.dumps({
                    "schema":"QSYN-PRIVATE-HISTORY-RETENTION/1",
                    "tenant":"tenant1","owner":"owner1","account":"upstox-a",
                    "broker":"upstox","private_retention_approved":enabled,
                    "license_expires_ms":int(time.time()*1000)+600000,
                    "instruments":["NFO|NIFTY29OCT2624500CE"],
                    "license_id":"private-retention-A",
                }))
                rights.chmod(0o600)
            approve(True)
            exported=root/"history.json"
            env=os.environ.copy()
            env.update({
                "QSYN_PRIVATE_HISTORY_EXPORT_ENABLED":"1",
                "QSYN_PRIVATE_BROKER_GATEWAY":"1",
                "QSYN_OPENALGO_REGISTRY_FILE":str(reg),
                "QSYN_HISTORY_LICENSE_ATTESTATION_FILE":str(rights),
                "QSYN_TRADING_ENABLED":"0","QSYN_ENABLE_LIVE_TRADING":"0"
            })
            command=["php",str(CLI),"export","tenant1","owner1","upstox-a",
                "NIFTY29OCT2624500CE","NFO","2026-10-09","2026-10-09",str(exported)]
            good=subprocess.run(command,env=env,text=True,capture_output=True,timeout=10)
            assert good.returncode==0,good.stderr
            data=json.loads(exported.read_text())
            assert data["schema"]=="QSYN-OPENALGO-HISTORY-IMPORT/1"
            assert data["retention_rights_attested"] is True
            assert data["candles"][0]["open_time_ms"]<data["candles"][1]["open_time_ms"]
            assert len(data["candles"])==2
            assert KEY not in exported.read_text() and KEY not in good.stdout
            assert data["scope"]["account_id"]=="upstox-a"
            assert exported.stat().st_mode & 0o077 == 0
            assert subprocess.run(command,env=env,capture_output=True,timeout=10).returncode!=0
            approve(False)
            command[-1]=str(root/"denied.json")
            denied=subprocess.run(command,env=env,capture_output=True,text=True,timeout=10)
            assert denied.returncode!=0 and not (root/"denied.json").exists()
            env["QSYN_PRIVATE_HISTORY_EXPORT_ENABLED"]="0"
            assert subprocess.run(command,env=env,capture_output=True,timeout=10).returncode!=0
            print("PASS: licensed private history export, order-denial, 0600 output, no secret leakage")
    finally:
        srv.shutdown();srv.server_close();worker.join(timeout=5)

if __name__=="__main__":main()
