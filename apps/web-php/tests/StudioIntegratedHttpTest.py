#!/usr/bin/env python3
"""Integrated Studio HTTP smoke against ephemeral local PHP; no broker access."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import urllib.error
import urllib.parse
import urllib.request

from IdentityHttpSmoke import await_server, open_port, php_server

def inspect(url, method="GET"):
    request = urllib.request.Request(url, method=method,
        headers={"Accept": "application/json"})
    try:
        response = urllib.request.urlopen(request, timeout=8)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        return response.status, json.loads(response.read(800000))

def run():
    with tempfile.TemporaryDirectory(prefix="qsyn-studio-api-") as root:
        path = Path(root)
        sessions = path / "sessions"
        sessions.mkdir(mode=0o700)
        env = os.environ.copy()
        for name in ("QSYN_IDENTITY_ENABLED", "QSYN_MOCK_ACCOUNTS_ENABLED",
                     "QSYN_DASHBOARD_ENABLED", "QSYN_FIXTURE_BOOTSTRAP_ENABLED"):
            env[name] = "0"
        port = open_port()
        origin = f"http://127.0.0.1:{port}"
        server = php_server(env, sessions, port)
        try:
            await_server(origin)
            url = origin + "/qsyn/api/v1/studio/"
            status, capabilities = inspect(url + "capabilities")
            assert status == 200 and capabilities["market_data"] == "simulated"
            assert capabilities["broker_integration"] == "not_connected"
            assert capabilities["execution_enabled"] is False
            assert capabilities["paper_orders_sent_to_broker"] is False
            assert capabilities["paper_trades"] == "browser_local_only"

            status, market = inspect(url + "market?underlying=NIFTY")
            assert status == 200 and len(market["chain"]) == 13
            strike = market["atm"]
            legs = json.dumps([
                {"type": "CE", "side": "BUY", "strike": strike, "qty": 1},
                {"type": "PE", "side": "BUY", "strike": strike, "qty": 1}
            ], separators=(",", ":"))
            query = urllib.parse.urlencode({
                "underlying": "NIFTY", "expiry": "W1", "interval": "1m",
                "legs": legs,
            })
            status, data = inspect(url + "bars?" + query)
            assert status == 200 and data["mode"] == "simulated"
            assert data["trading_enabled"] is False
            assert data["broker_connected"] is False
            assert len(data["bars"]) == 120
            assert data["analytics"]["mode"] == "simulated"
            assert data["analytics"]["model"] == "fixed-volatility-educational-scenario"
            assert data["analytics"]["greeks"]["gamma"] > 0
            assert data["analytics"]["scenario_risk"]["global_max_loss_known"] is False

            for endpoint in ("market?underlying=NIFTY", "bars?" + query, "capabilities"):
                status, denied = inspect(url + endpoint, method="POST")
                assert status == 405 and denied["error"] == "method_not_allowed"
            status, invalid = inspect(url + "bars?underlying=NIFTY&legs=%5B%5D")
            assert status == 422
            assert invalid["error"] in {"invalid_legs_count", "invalid_studio_parameters"}
            status, account = inspect(origin + "/qsyn/api/v1/accounts/list")
            assert status in (401, 404, 503)
            status, home = inspect(origin + "/qsyn/api/v1/health")
            assert status == 200 and home["status"] == "ok"
            print("PASS: Studio analytics, provenance, disabled broker/trading, HTTP read-only and default account denial")
        finally:
            server.terminate()
            try:
                server.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
                server.communicate()

if __name__ == "__main__":
    run()
