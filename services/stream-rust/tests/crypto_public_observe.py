#!/usr/bin/env python3
"""QSYN live seven-venue read-only feed acceptance.

Run from an operator workstation that can reach the staging site:
 python3 services/stream-rust/tests/crypto_public_observe.py \
   --base-url https://stage.digiti.in --observe-seconds 600 --require-websocket

Never uses broker credentials, writes data, places orders or opens private routes.
The sample endpoints are public but access may vary by network/geography.
Passing a snapshot proves only that window, not 24/7 uptime.
"""
from __future__ import annotations
import argparse
import json
import sys
import time
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen

VENUES = (
    ("BINANCE", "spot", "BTCUSDT"),
    ("BYBIT", "spot", "BTCUSDT"),
    ("OKX", "spot", "BTC-USDT"),
    ("COINBASE", "spot", "BTC-USD"),
    ("KRAKEN", "spot", "XBTUSD"),
    ("BITGET", "spot", "BTCUSDT"),
    ("HYPERLIQUID", "perp", "BTC"),
)
SCHEMA_BARS = "QSYN-PUBLIC-CRYPTO-BARS/1"
SCHEMA_HEALTH = "QSYN-PUBLIC-CRYPTO-HEALTH/1"

def get_json(base: str, path: str, params: dict[str,str]) -> dict:
    url = base.rstrip("/") + "/qsyn/api/v1/crypto/" + path + "?" + urlencode(params)
    with urlopen(Request(url, headers={"Accept":"application/json",
                                      "User-Agent":"QSYN-seven-venue-diagnostic/1"}), timeout=15) as r:
        if r.status != 200:
            raise ValueError(f"HTTP {r.status}")
        data = r.read(1_000_001)
        if len(data)>1_000_000:
            raise ValueError("response too large")
    obj = json.loads(data)
    if not isinstance(obj,dict):
        raise ValueError("invalid JSON shape")
    return obj

def inspect_bars(data:dict, exchange:str,market:str,symbol:str)->dict:
    assert data["schema"]==SCHEMA_BARS and data["source"]=="exchange_public"
    assert data["exchange"]==exchange and data["market"]==market and data["symbol"]==symbol
    assert data["interval"]=="1m" and data["trading_enabled"] is False
    candles=data["bars"]
    assert isinstance(candles,list) and candles, "no historical candles"
    times=[]
    for item in candles:
        assert all(k in item for k in ("time","open","high","low","close","volume"))
        assert isinstance(item["time"],int) and item["time"]%60==0
        assert 0<float(item["low"])<=float(item["high"])
        assert float(item["high"])>=max(float(item["open"]),float(item["close"]))
        assert float(item["low"])<=min(float(item["open"]),float(item["close"]))
        assert float(item["volume"])>=0
        times.append(item["time"])
    assert times==sorted(set(times)), "duplicate/out-of-order candle timestamps"
    missing=sum(max(0,(after-before)//60-1) for before,after in zip(times,times[1:]))
    exchange_lag=max(0,int(data["asof_ms"]/1000)-times[-1])
    return {"last_candle_start":times[-1], "count":len(times),
            "missing_candles":missing,"exchange_lag_seconds":exchange_lag,
            "transport":data.get("feed_transport","unknown")}

def inspect_health(data:dict, exchange:str,market:str,symbol:str)->dict:
    assert data["schema"]==SCHEMA_HEALTH and data["source"]=="exchange_public"
    assert (data["exchange"],data["market"],data["symbol"])==(exchange,market,symbol)
    assert data["trading_enabled"] is False
    feed=data["feed"]
    assert feed["state"] in ("websocket","reconnecting","stale","not_started")
    return {k:feed.get(k) for k in ("state","fresh","reconnect_count",
        "websocket_candle_updates","websocket_lag_seconds",
        "last_exchange_candle_sec","last_rest_ms","history_gap_events",
        "missing_history_bars","rest_refreshes_after_reconnect")}

def scan(base:str)->dict:
    results={}
    for exchange,market,symbol in VENUES:
        key=f"{exchange}/{market}/{symbol}"
        params={"exchange":exchange,"market":market,"symbol":symbol,"interval":"1m","limit":"300"}
        try:
            bars=inspect_bars(get_json(base,"bars",params),exchange,market,symbol)
            health=inspect_health(get_json(base,"health",params),exchange,market,symbol)
            results[key]={"ok":True,"bars":bars,"feed":health}
        except (AssertionError,ValueError,KeyError,HTTPError,URLError,TimeoutError,OSError) as exc:
            results[key]={"ok":False,"error":type(exc).__name__+":"+str(exc)[:180]}
    return results

def main()->int:
    ap=argparse.ArgumentParser(description=__doc__,formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base-url",default="https://stage.digiti.in")
    ap.add_argument("--observe-seconds",type=int,default=0,help="elapsed monitoring seconds, e.g. 600")
    ap.add_argument("--sample-seconds",type=int,default=15)
    ap.add_argument("--require-websocket",action="store_true")
    ap.add_argument("--require-contiguous",action="store_true",help="strict: can flag legitimately illiquid markets")
    args=ap.parse_args()
    u=urlsplit(args.base_url)
    if u.scheme!="https" and not (u.scheme=="http" and u.hostname in ("127.0.0.1","localhost")):
        ap.error("base URL must be HTTPS or local loopback HTTP")
    if not u.hostname or u.username or u.password or u.path not in ("","/") or u.query or u.fragment:
        ap.error("base URL must be an origin only, with no credentials or path")
    if args.observe_seconds<0 or args.observe_seconds>3600 or not 5<=args.sample_seconds<=300:
        ap.error("invalid sampling interval")
    first=scan(args.base_url)
    end=time.monotonic()+args.observe_seconds
    last=first
    observed_gap_keys={key for key,result in first.items()
                       if result.get("ok") and result["bars"]["missing_candles"]>0}
    observed_unhealthy_keys={key for key,result in first.items()
        if not result.get("ok") or result["feed"]["state"]!="websocket" or not result["feed"]["fresh"]}
    gap_samples={key:int(key in observed_gap_keys) for key in first}
    rounds=1
    while time.monotonic()<end:
        time.sleep(min(args.sample_seconds,max(0,end-time.monotonic())))
        last=scan(args.base_url)
        rounds+=1
        for key,result in last.items():
            if not result.get("ok") or result["feed"]["state"]!="websocket" or not result["feed"]["fresh"]:
                observed_unhealthy_keys.add(key)
            if result.get("ok") and result["bars"]["missing_candles"]:
                observed_gap_keys.add(key)
                gap_samples[key]=gap_samples.get(key,0)+1
    passing=0
    for key,result in last.items():
        if not result.get("ok"):
            print(f"FAIL {key}: {result['error']}")
            continue
        earlier=first.get(key,{})
        newest=result["bars"]
        health=result["feed"]
        advanced=(earlier.get("ok") and
                 newest["last_candle_start"]>=earlier["bars"]["last_candle_start"]+
                 (60 if args.observe_seconds>=60 else 0))
        ws=(health["state"]=="websocket" and health["fresh"])
        gaps=newest["missing_candles"]
        # Strict endurance requires *every sampled response* to be healthy,
        # not merely the final response after a transient gap self-resolved.
        ok=(not args.require_websocket or (ws and key not in observed_unhealthy_keys)) and (
            not args.require_contiguous or (gaps==0 and key not in observed_gap_keys))
        if args.observe_seconds>=60:
            ok=ok and advanced
        print(f'{"PASS" if ok else "WARN"} {key}: transport={health["state"]} '
              f'candles={newest["count"]} missing={gaps} '
              f'last={datetime.fromtimestamp(newest["last_candle_start"],timezone.utc).isoformat()} '
              f'reconnects={health["reconnect_count"]} updates={health["websocket_candle_updates"]} '
              f'advance={advanced} observed_gap_samples={gap_samples.get(key,0)} '
              f'observed_unhealthy={key in observed_unhealthy_keys}')
        passing+=int(ok)
    print(json.dumps({"schema":"QSYN-CRYPTO-PROBE/1","observations":rounds,
        "tested":len(VENUES),"passed":passing,"observed_gap_instruments":sorted(observed_gap_keys),
        "observed_unhealthy_instruments":sorted(observed_unhealthy_keys),
        "gap_samples":gap_samples,
        "require_contiguous":args.require_contiguous,
        "require_websocket":args.require_websocket},sort_keys=True))
    return 0 if passing==len(VENUES) else 1

if __name__=="__main__":
    sys.exit(main())
