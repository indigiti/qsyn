//! Read-only public crypto OHLCV gateway. No API keys, trading, arbitrary URLs,
//! private Upstox data or per-browser upstream credentials are accepted.
//! Provider history is polled for the *latest authoritative forming candle*;
//! this is NOT yet an exchange WebSocket/tick-by-tick feed.
use axum::{extract::Query, http::StatusCode, response::{IntoResponse, Response}, routing::get, Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::OnceLock, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};
use tokio::sync::Mutex;

#[derive(Debug, Deserialize)]
struct Request {
    exchange: String, market: String, symbol: String, interval: String,
    limit: Option<usize>,
}
#[derive(Debug, Clone, Serialize, PartialEq)]
struct Bar { time: u64, open: f64, high: f64, low: f64, close: f64, volume: f64 }
fn epoch_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}
fn step_seconds(interval: &str) -> Option<u64> {
    match interval { "1m"=>Some(60), "5m"=>Some(300), "15m"=>Some(900),
        "1h"=>Some(3600), "1d"=>Some(86400), _=>None }
}
// Explicit contract catalogue, not a URL forwarding service or generic symbol proxy.
// Hyperliquid spot needs a separate verified @index mapping; Kraken futures
// and Coinbase International derivatives likewise require separate adapters.
fn supported(exchange: &str, market: &str, symbol: &str) -> bool {
    match (exchange,market) {
        ("BINANCE" | "BYBIT" | "BITGET", "spot" | "perp") =>
            matches!(symbol, "BTCUSDT" | "ETHUSDT" | "SOLUSDT"),
        ("OKX", "spot") => matches!(symbol, "BTC-USDT" | "ETH-USDT" | "SOL-USDT"),
        ("OKX", "perp") => matches!(symbol, "BTC-USDT-SWAP" | "ETH-USDT-SWAP" | "SOL-USDT-SWAP"),
        ("COINBASE", "spot") => matches!(symbol, "BTC-USD" | "ETH-USD" | "SOL-USD"),
        ("KRAKEN", "spot") => matches!(symbol, "XBTUSD" | "ETHUSD" | "SOLUSD"),
        ("HYPERLIQUID", "perp") => matches!(symbol, "BTC" | "ETH" | "SOL"),
        _ => false,
    }
}
fn valid(req: &Request) -> bool {
    req.exchange.len() <= 16 && req.symbol.len() <= 32 &&
    req.limit.unwrap_or(250) >= 1 && req.limit.unwrap_or(250) <= 300 &&
    step_seconds(&req.interval).is_some() &&
    supported(&req.exchange,&req.market,&req.symbol)
}
fn number(v: &Value) -> Option<f64> {
    let n = if let Some(s)=v.as_str() { s.parse().ok()? } else { v.as_f64()? };
    if f64::is_finite(n) { Some(n) } else { None }
}
fn timestamp(v: &Value, ms: bool) -> Option<u64> {
    let t = v.as_u64().or_else(||v.as_str()?.parse::<u64>().ok())?;
    Some(if ms { t / 1000 } else { t })
}
fn bar(time:u64, open:f64, high:f64, low:f64, close:f64, volume:f64, step:u64) -> Option<Bar> {
    let now=epoch_ms()/1000;
    if time < 1_500_000_000 || time > now.saturating_add(step) || time%step!=0 ||
        open<=0.0 || high<=0.0 || low<=0.0 || close<=0.0 || volume<0.0 ||
        ![open,high,low,close,volume].iter().all(|v|v.is_finite()) ||
        high < open.max(close) || low > open.min(close) || low>high { return None; }
    Some(Bar{time,open,high,low,close,volume})
}
fn parse_rows(req:&Request, value:&Value) -> Result<Vec<Bar>,()> {
    let step=step_seconds(&req.interval).ok_or(())?;
    let rows = match req.exchange.as_str() {
        "BINANCE" | "COINBASE" | "HYPERLIQUID" => value.as_array(),
        "BYBIT" => value.pointer("/result/list").and_then(Value::as_array),
        "OKX" | "BITGET" => value.get("data").and_then(Value::as_array),
        "KRAKEN" => value.get("result").and_then(Value::as_object)
            .and_then(|m|m.iter().find(|(key,v)|key.as_str()!="last" && v.is_array()).map(|(_,v)|v))
            .and_then(Value::as_array),
        _ => None,
    }.ok_or(())?;
    let mut parsed=Vec::new();
    for row in rows {
        let found = match req.exchange.as_str() {
            "HYPERLIQUID" => {
                let t=timestamp(&row["t"],true).ok_or(())?;
                bar(t,number(&row["o"]).ok_or(())?,number(&row["h"]).ok_or(())?,
                    number(&row["l"]).ok_or(())?,number(&row["c"]).ok_or(())?,
                    number(&row["v"]).ok_or(())?,step)
            }
            "COINBASE" => {
                let a=row.as_array().ok_or(())?;
                if a.len()<6 {return Err(());}
                // Coinbase Exchange candles: [seconds,low,high,open,close,volume].
                bar(timestamp(&a[0],false).ok_or(())?,number(&a[3]).ok_or(())?,
                    number(&a[2]).ok_or(())?,number(&a[1]).ok_or(())?,
                    number(&a[4]).ok_or(())?,number(&a[5]).ok_or(())?,step)
            }
            _ => {
                let a=row.as_array().ok_or(())?;
                if a.len()<7 && req.exchange=="KRAKEN" || a.len()<6 {return Err(());}
                // All remaining providers: time, open, high, low, close;
                // Kraken volume index 6, the others volume index 5.
                bar(timestamp(&a[0],req.exchange!="KRAKEN").ok_or(())?,
                    number(&a[1]).ok_or(())?, number(&a[2]).ok_or(())?,
                    number(&a[3]).ok_or(())?, number(&a[4]).ok_or(())?,
                    number(&a[if req.exchange=="KRAKEN"{6}else{5}]).ok_or(())?,step)
            }
        };
        // Fail closed on malformed or inconsistent upstream data: do not
        // display invalid values as legitimate candles.
        parsed.push(found.ok_or(())?);
    }
    parsed.sort_by_key(|b|b.time);
    parsed.dedup_by_key(|b|b.time);
    if parsed.len()>req.limit.unwrap_or(250) {
        parsed.drain(..parsed.len()-req.limit.unwrap_or(250));
    }
    Ok(parsed)
}
fn source(req:&Request) -> Result<(String,Option<Value>),()> {
    let n=req.limit.unwrap_or(250).to_string();
    let i=req.interval.as_str(); let s=req.symbol.as_str();
    let (host,path,params)= match req.exchange.as_str() {
        "BINANCE" => (
            if req.market=="perp" {"https://fapi.binance.com"} else {"https://api.binance.com"},
            if req.market=="perp" {"/fapi/v1/klines"} else {"/api/v3/klines"},
            vec![("symbol",s),("interval",i),("limit",&n)]),
        "BYBIT" => ("https://api.bybit.com","/v5/market/kline",
            vec![("category",if req.market=="perp" {"linear"}else{"spot"}),
                 ("symbol",s),("interval",match i {"1m"=>"1","5m"=>"5","15m"=>"15","1h"=>"60","1d"=>"D",_=>return Err(())}),("limit",&n)]),
        "OKX" => ("https://www.okx.com","/api/v5/market/candles",
            vec![("instId",s),("bar",match i {"1d"=>"1D",_=>i}),("limit",&n)]),
        "COINBASE" => ("https://api.exchange.coinbase.com",
            &*Box::leak(format!("/products/{s}/candles").into_boxed_str()),
            vec![("granularity",match i {"1m"=>"60","5m"=>"300","15m"=>"900","1h"=>"3600","1d"=>"86400",_=>return Err(())})]),
        "KRAKEN" => ("https://api.kraken.com","/0/public/OHLC",
            vec![("pair",s),("interval",match i {"1m"=>"1","5m"=>"5","15m"=>"15","1h"=>"60","1d"=>"1440",_=>return Err(())})]),
        "BITGET" => ("https://api.bitget.com","/api/v3/market/candles",
            vec![("category",if req.market=="perp" {"USDT-FUTURES"}else{"SPOT"}),
                 ("symbol",s),("interval",match i {"1h"=>"1H","1d"=>"1D",_=>i}),("limit",&n)]),
        "HYPERLIQUID" => {
            let end=epoch_ms();
            let start=end.saturating_sub((req.limit.unwrap_or(250) as u64+2)*step_seconds(i).ok_or(())?*1000);
            return Ok(("https://api.hyperliquid.xyz/info".into(),Some(json!({
                "type":"candleSnapshot","req":{"coin":s,"interval":i,"startTime":start,"endTime":end}
            }))));
        }
        _=>return Err(()),
    };
    let mut url=reqwest::Url::parse(host).map_err(|_|())?;
    url.set_path(path);
    url.query_pairs_mut().extend_pairs(params);
    Ok((url.to_string(),None))
}
fn client() -> &'static reqwest::Client {
    static CLIENT:OnceLock<reqwest::Client>=OnceLock::new();
    CLIENT.get_or_init(||reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("QSYN-PublicCryptoCharts/1.0")
        .build().expect("fixed HTTPS client"))
}
type Cache = Mutex<HashMap<String,(Instant,Vec<Bar>)>>;
fn cache() -> &'static Cache {
    static CACHE:OnceLock<Cache>=OnceLock::new();
    CACHE.get_or_init(||Mutex::new(HashMap::new()))
}
async fn load(req:&Request)->Result<Vec<Bar>,()> {
    let cache_key=format!("{}:{}:{}:{}:{}",req.exchange,req.market,req.symbol,req.interval,req.limit.unwrap_or(250));
    {
        let guard=cache().lock().await;
        if let Some((since,bars))=guard.get(&cache_key) {
            if since.elapsed()<Duration::from_secs(4) {return Ok(bars.clone());}
        }
    }
    let (url,post)=source(req)?;
    let request=if let Some(body)=post {client().post(url).json(&body)} else {client().get(url)};
    let res=request.send().await.map_err(|_|())?;
    if !res.status().is_success() {return Err(());}
    let bytes=res.bytes().await.map_err(|_|())?;
    if bytes.len()>1_000_000{return Err(());}
    let json:Value=serde_json::from_slice(&bytes).map_err(|_|())?;
    if req.exchange=="BYBIT" && json.get("retCode")!=Some(&json!(0)) {return Err(());}
    if req.exchange=="OKX" && json.get("code")!=Some(&json!("0")) {return Err(());}
    if req.exchange=="BITGET" && json.get("code")!=Some(&json!("00000")) {return Err(());}
    if req.exchange=="KRAKEN" && json["error"].as_array().is_some_and(|v|!v.is_empty()) {return Err(());}
    let bars=parse_rows(req,&json)?;
    if bars.is_empty() {return Err(());}
    let mut guard=cache().lock().await;
    if guard.len()>128 {guard.retain(|_,(when,_)|when.elapsed()<Duration::from_secs(30));}
    guard.insert(cache_key,(Instant::now(),bars.clone()));
    Ok(bars)
}
async fn bars(Query(req):Query<Request>)->Response {
    if !valid(&req) {return (StatusCode::UNPROCESSABLE_ENTITY,Json(json!({"error":"unsupported_crypto_instrument"}))).into_response();}
    match load(&req).await {
        Ok(bars)=>(StatusCode::OK,Json(json!({
            "schema":"QSYN-PUBLIC-CRYPTO-BARS/1","source":"exchange_public",
            "exchange":req.exchange,"market":req.market,"symbol":req.symbol,
            "interval":req.interval,"bars":bars,"asof_ms":epoch_ms(),
            "trading_enabled":false
        }))).into_response(),
        Err(_)=>(StatusCode::BAD_GATEWAY,Json(json!({"error":"exchange_market_data_unavailable"}))).into_response()
    }
}
pub fn router()->Router {
    Router::new().route("/api/v1/crypto/bars",get(bars))
}
#[cfg(test)]
mod tests {
    use super::*;
    fn query(exchange:&str,market:&str,symbol:&str)->Request {
        Request{exchange:exchange.into(),market:market.into(),symbol:symbol.into(),interval:"1m".into(),limit:Some(200)}
    }
    #[test] fn strict_catalog() {
        for (e,m,s) in [("BINANCE","spot","BTCUSDT"),("BYBIT","perp","ETHUSDT"),
            ("OKX","perp","BTC-USDT-SWAP"),("COINBASE","spot","BTC-USD"),
            ("KRAKEN","spot","XBTUSD"),("BITGET","perp","SOLUSDT"),
            ("HYPERLIQUID","perp","BTC")] {assert!(valid(&query(e,m,s)));}
        assert!(!valid(&query("BINANCE","spot","../../config")));
        assert!(!valid(&query("HYPERLIQUID","spot","BTC")));
        assert!(!valid(&query("COINBASE","perp","BTC-USD")));
    }
    #[test] fn normalize_variants() {
        let t=1_696_982_400_000u64; // aligned 1m UTC epoch millis
        let bin=json!([[t,"100","110","90","105","12"]]);
        let b=parse_rows(&query("BINANCE","spot","BTCUSDT"),&bin).unwrap();
        assert_eq!((b[0].open,b[0].low,b[0].volume),(100.0,90.0,12.0));
        let bybit=json!({"result":{"list":[[t.to_string(),"100","110","90","105","12"]]}});
        assert_eq!(parse_rows(&query("BYBIT","spot","BTCUSDT"),&bybit).unwrap(),b);
        let coin=json!([[t/1000,90,110,100,105,12]]);
        assert_eq!(parse_rows(&query("COINBASE","spot","BTC-USD"),&coin).unwrap(),b);
        let kr=json!({"error":[],"result":{"XXBTZUSD":[[t/1000,"100","110","90","105","102","12","4"]],"last":0}});
        assert_eq!(parse_rows(&query("KRAKEN","spot","XBTUSD"),&kr).unwrap(),b);
        let hyp=json!([{"t":t,"o":"100","h":"110","l":"90","c":"105","v":"12"}]);
        assert_eq!(parse_rows(&query("HYPERLIQUID","perp","BTC"),&hyp).unwrap(),b);
    }
    #[test] fn rejects_invalid_ohlc_and_nonfinite() {
        let req=query("BINANCE","spot","BTCUSDT");
        assert!(parse_rows(&req,&json!([[1_696_982_400_000u64,"100","91","90","105","12"]])).is_err());
        assert!(parse_rows(&req,&json!([[1_696_982_400_000u64,"NaN","110","90","105","12"]])).is_err());
    }
}