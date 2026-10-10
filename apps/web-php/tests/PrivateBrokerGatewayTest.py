#!/usr/bin/env python3
"""Two isolated authorized OpenAlgo *fake* instances; no real broker APIs."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[3]
CLI = ROOT / "apps/web-php/tools/private-broker-gateway.php"
KEY_A = "fake-openalgo-credential-upstox-A-0001"
KEY_B = "fake-openalgo-credential-zerodha-B-0002"


def service(broker, token):
    class Fake(BaseHTTPRequestHandler):
        def do_POST(self):
            size = int(self.headers.get("Content-Length", "0"))
            if size > 5000:
                return self.send_json(413, {"status": "error"})
            args = json.loads(self.rfile.read(size))
            if args.get("apikey") != token:
                return self.send_json(403, {"status": "error"})
            responses = {
                "/api/v1/ping": {"status": "success", "data": {
                    "message": "pong", "broker": broker, "secret": token,
                }},
                "/api/v1/quotes": {"status": "success", "data": {
                    "ltp": 321.25, "broker_api_key": token,
                }},
                "/api/v1/funds": {"status": "success", "data": {
                    "availablecash": "12450.24", "m2munrealized": "-32.50",
                    "broker_token": token,
                }},
                "/api/v1/history": {"status": "success", "data": [{
                    "timestamp": "2026-10-09 09:15:00+05:30",
                    "open": 40.2, "high": 44.1, "low": 38.6,
                    "close": 43.1, "volume": 100, "secret": token,
                }]},
                "/api/v1/optionchain": {"status": "success", "chain": [{
                    "strike": 24500,
                    "ce": {"symbol": "NIFTY29OCT2624500CE", "ltp": 60.1,
                           "oi": 500, "gamma": 0.002, "broker_secret": token},
                    "pe": {"symbol": "NIFTY29OCT2624500PE", "ltp": 70.3,
                           "oi": 300},
                }]},
                "/api/v1/orderstatus": {"status": "success", "data": {
                    "orderid": "B123", "order_status": "complete",
                    "symbol": "NIFTY29OCT2624500CE", "exchange": "NFO",
                    "action": "BUY", "quantity": 25, "average_price": 101.5,
                    "private_access_token": token,
                }},
                "/api/v1/positionbook": {"status": "success", "data": [
                    {"symbol": "NIFTY", "secret": token},
                ]},
            }
            return self.send_json(200 if self.path in responses else 404,
                                  responses.get(self.path, {"status": "error"}))

        def send_json(self, status, response):
            payload = json.dumps(response).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_):
            pass
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Fake)
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    return srv, thread


def invoke(path, *args, enabled="1", trading="0"):
    env = os.environ.copy()
    env["QSYN_PRIVATE_BROKER_GATEWAY"] = enabled
    env["QSYN_TRADING_ENABLED"] = trading
    env["QSYN_ENABLE_LIVE_TRADING"] = "0"
    env["QSYN_OPENALGO_REGISTRY_FILE"] = str(path)
    return subprocess.run(["php", str(CLI), *args], text=True,
                          capture_output=True, env=env, cwd=ROOT, timeout=10)


def main():
    a, ta = service("upstox", KEY_A)
    b, tb = service("zerodha", KEY_B)
    try:
        with tempfile.TemporaryDirectory(prefix="qsyn-isolated-accounts-") as folder:
            root = Path(folder)
            root.chmod(0o700)
            ka, kb = root / "key-a", root / "key-b"
            ka.write_text(KEY_A + "\n", encoding="ascii")
            kb.write_text(KEY_B + "\n", encoding="ascii")
            ka.chmod(0o600)
            kb.chmod(0o600)
            reg = root / "registry.json"

            def config():
                return {"schema": "QSYN-PRIVATE-OPENALGO-REGISTRY/1", "accounts": [
                    {"account_id": "upstox-a", "tenant_id": "tenant1",
                     "owner_user_id": "alice", "broker": "upstox",
                     "rest_port": a.server_port, "ws_port": a.server_port + 20000,
                     "openalgo_apikey_file": str(ka)},
                    {"account_id": "zerodha-b", "tenant_id": "tenant2",
                     "owner_user_id": "bob", "broker": "zerodha",
                     "rest_port": b.server_port, "ws_port": b.server_port + 20000,
                     "openalgo_apikey_file": str(kb)},
                ]}
            # WS ports must also fit 16-bit range.
            # Ephemeral REST port can be >45K; allocate WS private ports
            # from the unused configured test range without connecting.
            items = config()
            occupied = {a.server_port, b.server_port}
            for ix, account in enumerate(items["accounts"]):
                port = 11001 + ix
                while port in occupied:
                    port += 5
                account["ws_port"] = port
                occupied.add(port)

            def write_registry(obj):
                reg.write_text(json.dumps(obj), encoding="utf-8")
                reg.chmod(0o600)
            write_registry(items)
            inventory = invoke(reg, "list", "tenant1", "alice")
            assert inventory.returncode == 0, inventory.stderr
            records = json.loads(inventory.stdout)
            assert len(records["accounts"]) == 1
            assert records["accounts"][0]["broker"] == "upstox"
            assert records["trading_enabled"] is False
            assert "zerodha-b" not in inventory.stdout and KEY_A not in inventory.stdout

            for tenant, owner, account, broker in (
                ("tenant1", "alice", "upstox-a", "upstox"),
                ("tenant2", "bob", "zerodha-b", "zerodha"),
            ):
                ping = invoke(reg, "read", tenant, owner, account, "ping")
                assert ping.returncode == 0, ping.stderr
                data = json.loads(ping.stdout)
                assert data["broker"] == broker
                assert data["broker_session_responding"] is True
                assert data["market_entitlement_verified"] is False
                assert data["trading_enabled"] is False
                assert KEY_A not in ping.stdout and KEY_B not in ping.stdout

            quote = invoke(reg, "read", "tenant1", "alice", "upstox-a", "quote",
                           json.dumps({"symbol": "NIFTY29OCT2624500CE", "exchange": "NFO"}))
            assert quote.returncode == 0, quote.stderr
            assert json.loads(quote.stdout)["ltp"] == 321.25

            chain = invoke(reg, "read", "tenant1", "alice", "upstox-a", "chain",
                           json.dumps({"underlying": "NIFTY", "exchange": "NSE_INDEX",
                                       "expiry_date": "29OCT26", "strike_count": 5}))
            assert chain.returncode == 0, chain.stderr
            c = json.loads(chain.stdout)["chain"][0]
            assert c["strike"] == 24500
            assert c["ce"]["gamma"] == 0.002
            assert KEY_A not in chain.stdout

            history = invoke(reg, "read", "tenant1", "alice", "upstox-a", "history",
                             json.dumps({"symbol": "NIFTY29OCT2624500CE", "exchange": "NFO",
                                         "interval": "1m",
                                         "start_date": "2026-10-08", "end_date": "2026-10-09"}))
            assert history.returncode == 0, history.stderr
            assert json.loads(history.stdout)["bars"][0]["close"] == 43.1
            assert KEY_A not in history.stdout

            funds = invoke(reg, "read", "tenant2", "bob", "zerodha-b", "funds")
            assert funds.returncode == 0
            assert json.loads(funds.stdout)["funds"]["m2munrealized"] == -32.5
            status = invoke(reg, "read", "tenant1", "alice", "upstox-a",
                            "order-status", json.dumps({"strategy":"QSYN Paper",
                                                        "orderid":"B123"}))
            assert status.returncode == 0, status.stderr
            record = json.loads(status.stdout)
            assert record["broker_order_id"] == "B123"
            assert record["broker_order_status"] == "complete"
            assert record["filled_quantity_verified"] is False
            assert record["reconciliation_verified"] is False
            assert KEY_A not in status.stdout
            cross = invoke(reg, "read", "tenant2", "bob", "upstox-a",
                           "order-status", json.dumps({"strategy":"QSYN Paper",
                                                        "orderid":"B123"}))
            assert cross.returncode != 0 and not cross.stdout
            positions = invoke(reg, "read", "tenant1", "alice", "upstox-a", "positions")
            assert json.loads(positions.stdout)["items_count"] == 1

            for denied in (
                invoke(reg, "read", "tenant2", "bob", "upstox-a", "ping"),
                invoke(reg, "read", "tenant1", "alice", "upstox-a", "placeorder"),
                invoke(reg, "read", "tenant1", "alice", "upstox-a", "cancelorder"),
                invoke(reg, "read", "tenant1", "alice", "upstox-a", "strategy/start"),
                invoke(reg, "read", "tenant1", "alice", "upstox-a", "analyzer/toggle"),
                invoke(reg, "read", "tenant1", "alice", "upstox-a", "quote",
                       json.dumps({"symbol": "../admin", "exchange": "NFO"})),
                invoke(reg, "list", "tenant1", "alice", enabled="0"),
                invoke(reg, "list", "tenant1", "alice", trading="1"),
            ):
                assert denied.returncode != 0 and not denied.stdout
                assert KEY_A not in denied.stderr and KEY_B not in denied.stderr

            ka.chmod(0o644)
            assert invoke(reg, "read", "tenant1", "alice", "upstox-a", "ping").returncode != 0
            ka.chmod(0o600)
            items["accounts"][1]["rest_port"] = a.server_port
            write_registry(items)
            assert invoke(reg, "list", "tenant1", "alice").returncode != 0
            items["accounts"][1]["rest_port"] = b.server_port
            write_registry(items)
            reg.chmod(0o644)
            assert invoke(reg, "list", "tenant1", "alice").returncode != 0

            print("PASS: two isolated OpenAlgo fake broker sessions, scoped read-only API, no secrets or order actions")
    finally:
        a.shutdown()
        b.shutdown()
        a.server_close()
        b.server_close()
        ta.join(timeout=5)
        tb.join(timeout=5)


if __name__ == "__main__":
    main()
