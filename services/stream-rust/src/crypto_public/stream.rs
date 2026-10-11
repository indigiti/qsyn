//! On-demand public exchange WebSocket workers. Started once per allowlisted
//! instrument on the first 1m history request, and kept alive by the Rust
//! service even after the browser closes. Never runs an order or private API.
//! Reconnects with bounded exponential backoff and refreshes REST bars after
//! every disconnect. Browser clients still use the same-origin PHP bridge.
use super::{bar, epoch_ms, number, timestamp, Bar, Request};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{collections::{HashMap, VecDeque}, sync::OnceLock, time::{Duration, Instant}};
use tokio::sync::Mutex;
use tokio_tungstenite::{connect_async, tungstenite::Message};

#[derive(Clone)]
struct Slot {
    connected: bool,
    last: Option<Bar>,
    // Bounded authoritative WS candle snapshots, never synthetic fills.
    recent: VecDeque<Bar>,
    last_at: Option<Instant>,
    reconnects: u64,
    updates: u64,
    last_update_ms: Option<u64>,
    last_connection_ms: Option<u64>,
    last_disconnection_ms: Option<u64>,
    last_rest_ms: Option<u64>,
    rest_successes: u64,
    rest_recoveries: u64,
    last_rest_gap_count: usize,
    last_rest_missing_bars: u64,
}
type Slots = Mutex<HashMap<String, Slot>>;
fn slots() -> &'static Slots {
    static SLOTS: OnceLock<Slots> = OnceLock::new();
    SLOTS.get_or_init(|| Mutex::new(HashMap::new()))
}
fn key(req: &Request) -> String {
    format!("{}:{}:{}:{}", req.exchange, req.market, req.symbol, req.interval)
}
pub(super) async fn latest(req: &Request) -> Option<Bar> {
    let guard = slots().lock().await;
    let slot = guard.get(&key(req))?;
    if slot.connected && slot.last_at.is_some_and(|t| t.elapsed() < Duration::from_secs(20)) {
        slot.last.clone()
    } else {
        None
    }
}
/// Validated exchange candles observed within this Rust process. Historical
/// Coinbase fills are only possible for buckets seen since subscription.
/// A reconnect never turns these snapshots into fabricated forward candles.
pub(super) async fn recent(req: &Request) -> Vec<Bar> {
    let guard=slots().lock().await;
    if req.exchange!="COINBASE" || req.interval!="1m" {return Vec::new();}
    guard.get(&key(req)).map_or_else(Vec::new,|s|s.recent.iter().cloned().collect())
}
pub(super) async fn status(req: &Request) -> &'static str {
    let guard = slots().lock().await;
    match guard.get(&key(req)) {
        None => "rest",
        Some(s) if s.connected && s.last_at.is_some_and(|t| t.elapsed() < Duration::from_secs(20)) => "websocket",
        Some(_) => "reconnecting",
    }
}
pub(super) async fn ensure(req: &Request) {
    if req.interval != "1m" { return; }
    let k = key(req);
    let mut guard = slots().lock().await;
    if guard.contains_key(&k) { return; }
    guard.insert(k, Slot {
        connected: false, last: None, recent: VecDeque::new(), last_at: None, reconnects: 0,
        updates: 0, last_update_ms: None, last_connection_ms: None,
        last_disconnection_ms: None, last_rest_ms: None,
        rest_successes: 0, rest_recoveries: 0,
        last_rest_gap_count: 0, last_rest_missing_bars: 0,
    });
    let selected = req.clone();
    tokio::spawn(async move { worker(selected).await });
}
async fn publish(req: &Request, next: Bar) {
    let mut guard=slots().lock().await;
    if let Some(slot)=guard.get_mut(&key(req)) {
        if let Some(ref previous)=slot.last {
            if next.time < previous.time { return; }
        }
        // Hold the last 32 distinct minutes so lagged Coinbase REST candles
        // can be reconciled against real observed trade-derived bars.
        // A reconnect can replay older events: never reorder the ring.
        if slot.recent.back().is_some_and(|b| b.time > next.time) {return;}
        if slot.recent.back().is_some_and(|b| b.time == next.time) {
            slot.recent.pop_back();
        }
        slot.recent.push_back(next.clone());
        while slot.recent.len() > 32 { slot.recent.pop_front(); }
        slot.last=Some(next);
        slot.connected=true;
        slot.last_at=Some(Instant::now());
        slot.last_update_ms=Some(epoch_ms());
        slot.updates=slot.updates.saturating_add(1);
    }
}
async fn disconnected(req: &Request) {
    if let Some(slot)=slots().lock().await.get_mut(&key(req)) {
        slot.connected=false;
        slot.last_at=None;
        slot.last=None; // never reuse a bar from a dead source
        slot.last_disconnection_ms=Some(epoch_ms());
        slot.reconnects=slot.reconnects.saturating_add(1);
    }
}
/// Count gaps in the returned exchange history without manufacturing prices.
/// A missing candle can mean real illiquidity; report it rather than filling.
pub(super) fn history_gaps(bars: &[Bar], step: u64) -> (usize,u64) {
    let mut events=0usize;
    let mut missing=0u64;
    for pair in bars.windows(2) {
        if pair[1].time > pair[0].time.saturating_add(step) {
            events+=1;
            missing=missing.saturating_add((pair[1].time-pair[0].time)/step-1);
        }
    }
    (events,missing)
}
pub(super) async fn rest_completed(req: &Request, bars: &[Bar]) {
    let (gaps,missing)=history_gaps(bars,super::step_seconds(&req.interval).unwrap_or(60));
    let mut guard=slots().lock().await;
    if let Some(slot)=guard.get_mut(&key(req)) {
        slot.last_rest_ms=Some(epoch_ms());
        slot.rest_successes=slot.rest_successes.saturating_add(1);
        if slot.reconnects>0 {
            slot.rest_recoveries=slot.rest_recoveries.saturating_add(1);
        }
        slot.last_rest_gap_count=gaps;
        slot.last_rest_missing_bars=missing;
    }
}
fn telemetry(_req: &Request, slot: Option<&Slot>) -> Value {
    let now=epoch_ms();
    let Some(s)=slot else {
        return json!({"state":"not_started","feed_transport":"rest","reconnect_count":0,
            "websocket_candle_updates":0,"last_exchange_candle_sec":null,
            "last_websocket_update_ms":null,"websocket_lag_seconds":null,
            "last_connection_ms":null,"last_disconnection_ms":null,
            "rest_successes":0,"rest_refreshes_after_reconnect":0,
            "last_rest_ms":null,"history_gap_events":null,"missing_history_bars":null,
            "ws_recent_candles":0,"fresh":false});
    };
    let fresh=s.connected && s.last_at.is_some_and(|t|t.elapsed()<Duration::from_secs(20));
    let state=if fresh {"websocket"} else if s.connected {"stale"} else {"reconnecting"};
    json!({
        "state":state,
        "feed_transport":if fresh {"websocket"}else{"rest"},
        "fresh":fresh,
        "reconnect_count":s.reconnects,
        "websocket_candle_updates":s.updates,
        "ws_recent_candles":s.recent.len(),
        "last_exchange_candle_sec":s.last.as_ref().map(|b|b.time),
        "last_websocket_update_ms":s.last_update_ms,
        "websocket_lag_seconds":s.last_update_ms.map(|ms|now.saturating_sub(ms)/1000),
        "last_connection_ms":s.last_connection_ms,
        "last_disconnection_ms":s.last_disconnection_ms,
        "rest_successes":s.rest_successes,
        "rest_refreshes_after_reconnect":s.rest_recoveries,
        "last_rest_ms":s.last_rest_ms,
        "history_gap_events":if s.last_rest_ms.is_some(){Some(s.last_rest_gap_count)}else{None},
        "missing_history_bars":if s.last_rest_ms.is_some(){Some(s.last_rest_missing_bars)}else{None}
    })
}
pub(super) async fn health(req: &Request) -> Value {
    let guard=slots().lock().await;
    telemetry(req,guard.get(&key(req)))
}
fn endpoint(req:&Request)->(String,Option<Value>) {
    let symbol=&req.symbol;
    let symbol_lower=symbol.to_ascii_lowercase();
    match req.exchange.as_str() {
        "BINANCE" => {
            let host=if req.market=="perp" {"fstream.binance.com"}else{"data-stream.binance.vision"};
            (format!("wss://{host}/ws/{symbol_lower}@kline_1m"),None)
        }
        "BYBIT" => (
            format!("wss://stream.bybit.com/v5/public/{}",if req.market=="perp"{"linear"}else{"spot"}),
            Some(json!({"op":"subscribe","args":[format!("kline.1.{symbol}")]}))
        ),
        "OKX" => ("wss://ws.okx.com/ws/v5/business".into(),
            Some(json!({"op":"subscribe","args":[{"channel":"candle1m","instId":symbol}]}))),
        "COINBASE" => ("wss://ws-feed.exchange.coinbase.com".into(),
            Some(json!({"type":"subscribe","product_ids":[symbol],"channels":["matches","heartbeat"]}))),
        "KRAKEN" => ("wss://ws.kraken.com".into(),
            Some(json!({"event":"subscribe","pair":[kraken_pair(symbol)],"subscription":{"name":"ohlc","interval":1}}))),
        "BITGET" => ("wss://ws.bitget.com/v3/ws/public".into(),
            Some(json!({"op":"subscribe","args":[{"instType":if req.market=="perp"{"usdt-futures"}else{"spot"},
                "topic":"kline","symbol":symbol,"interval":"1m"}]}))),
        "HYPERLIQUID" => ("wss://api.hyperliquid.xyz/ws".into(),
            Some(json!({"method":"subscribe","subscription":{"type":"candle","coin":symbol,"interval":"1m"}}))),
        _ => (String::new(),None),
    }
}
fn kraken_pair(symbol: &str) -> String {
    match symbol { "XBTUSD"=>"XBT/USD", "ETHUSD"=>"ETH/USD", "SOLUSD"=>"SOL/USD",_=>"" }.into()
}
fn value_float(v:&Value)->Option<f64> {
    if let Some(x)=v.as_str(){x.parse::<f64>().ok()}else{v.as_f64()}
}
fn row(req:&Request,arr:&Value,ms:bool,columns:[usize;6])->Option<Bar> {
    let a=arr.as_array()?;
    let max=columns.iter().copied().max()?;
    if a.len()<=max{return None;}
    bar(timestamp(&a[columns[0]],ms)?,number(&a[columns[1]])?,
        number(&a[columns[2]])?,number(&a[columns[3]])?,
        number(&a[columns[4]])?,number(&a[columns[5]])?,60)
        .filter(|_| req.interval=="1m")
}
fn object_candle(data:&Value)->Option<Bar> {
    bar(timestamp(&data["t"],true)?,number(&data["o"])?,
        number(&data["h"])?,number(&data["l"])?,number(&data["c"])?,number(&data["v"])?,60)
}
fn parse_candle(req:&Request,v:&Value)->Option<Bar> {
    match req.exchange.as_str(){
        "BINANCE" => {
            let k=v.pointer("/data/k").or_else(||v.get("k"))?;
            if k["s"]!=req.symbol || k["i"]!="1m" {return None;}
            object_candle(k)
        }
        "BYBIT" => {
            if v["topic"]!=format!("kline.1.{}",req.symbol){return None;}
            let c=v.get("data")?.as_array()?.last()?;
            bar(timestamp(&c["start"],true)?,number(&c["open"])?,
                number(&c["high"])?,number(&c["low"])?,number(&c["close"])?,number(&c["volume"])?,60)
        }
        "OKX" => {
            if v.pointer("/arg/channel")?.as_str()?!="candle1m" ||
               v.pointer("/arg/instId")?.as_str()?!=req.symbol{return None;}
            row(req,v.get("data")?.as_array()?.last()?,true,[0,1,2,3,4,5])
        }
        "KRAKEN" => {
            let a=v.as_array()?;
            if a.len()<4 || a[3]!=kraken_pair(&req.symbol) || a[2]!="ohlc-1" {return None;}
            let c=a[1].as_array()?;
            if c.len()<8{return None;}
            // V1 Kraken OHLC data[1] is the candle's fractional UNIX end
            // time; subtract one second to resolve the current minute bucket.
            let end=value_float(&c[1])?;
            if !end.is_finite() || end<60.0{return None;}
            let start=((end-1.0)/60.0).floor() as u64*60;
            bar(start,number(&c[2])?,number(&c[3])?,number(&c[4])?,
                number(&c[5])?,number(&c[7])?,60)
        }
        "BITGET" => {
            // Bitget UTA v3 pushes candle objects, unlike the older v2
            // array-based candle channel. Enforce the actual market scope.
            let expected=if req.market=="perp" {"usdt-futures"} else {"spot"};
            if v.pointer("/arg/topic")?.as_str()?!="kline" ||
               v.pointer("/arg/symbol")?.as_str()?!=req.symbol ||
               v.pointer("/arg/interval")?.as_str()?!="1m" ||
               v.pointer("/arg/instType")?.as_str()?!=expected {return None;}
            let c=v.get("data")?.as_array()?.last()?;
            if c.is_object() {
                bar(timestamp(&c["start"],true)?,number(&c["open"])?,
                    number(&c["high"])?,number(&c["low"])?,
                    number(&c["close"])?,number(&c["volume"])?,60)
            } else {
                // Graceful handling for providers still emitting classic arrays.
                row(req,c,true,[0,1,2,3,4,5])
            }
        }
        "HYPERLIQUID" => {
            if v["channel"]!="candle" {return None;}
            let data=v.get("data")?;
            let c=if let Some(a)=data.as_array(){a.last()?}else{data};
            if c["s"]!=req.symbol || c["i"]!="1m" {return None;}
            object_candle(c)
        }
        _ => None,
    }
}
#[derive(Default)]
struct CoinbaseTrades {
    // Trade-only candle volume is incomplete during first subscribed minute.
    // Do not publish until the worker observes the next UTC minute.
    latest: Option<Bar>,
    warmup: bool,
    last_trade_id: Option<u64>,
}
impl CoinbaseTrades {
    fn on_message(&mut self,req:&Request,v:&Value)->Option<Bar> {
        if v["type"]!="match" || v["product_id"]!=req.symbol {return None;}
        // Duplicate/reordered matches must not double-count trading volume.
        // Exchange trade_id is monotonically increasing for this product.
        let trade_id=v["trade_id"].as_u64().or_else(||v["trade_id"].as_str()?.parse().ok())?;
        if self.last_trade_id.is_some_and(|previous|trade_id<=previous) {return None;}
        let price=number(&v["price"])?;
        let volume=number(&v["size"])?;
        let timestamp=chrono::DateTime::parse_from_rfc3339(v["time"].as_str()?).ok()?.timestamp();
        let timestamp=u64::try_from(timestamp).ok()?;
        let minute=timestamp/60*60;
        if volume<=0.0 || price<=0.0 || minute>epoch_ms()/1000+60 {return None;}
        if self.latest.as_ref().is_some_and(|last|minute<last.time) {return None;}
        self.last_trade_id=Some(trade_id);
        match self.latest.take() {
            Some(mut existing) if existing.time==minute => {
                existing.high=existing.high.max(price);
                existing.low=existing.low.min(price);
                existing.close=price;
                existing.volume+=volume;
                self.latest=Some(existing.clone());
                if self.warmup { None } else { Some(existing) }
            }
            Some(existing) if existing.time>minute => {
                self.latest=Some(existing);
                None
            }
            prior => {
                let next=Bar{time:minute,open:price,high:price,low:price,close:price,volume};
                // First observed bucket cannot have full-minute trade volume.
                // Once time crosses into the next bucket with an uninterrupted
                // subscription, subsequent trade accumulation is complete.
                self.warmup=prior.is_none();
                self.latest=Some(next.clone());
                if self.warmup { None } else { Some(next) }
            }
        }
    }
}
async fn worker(req:Request) {
    let (url,subscribe)=endpoint(&req);
    if url.is_empty(){return;}
    let mut delay=1u64;
    loop {
        // Rebuild from REST on every connection and retry. Source timestamps
        // and volumes come only from provider bars, never from quote close.
        super::invalidate(&req).await;
        // A REST refresh on connect/reconnect rebuilds the authoritative
        // window; failure stays observable (do not fabricate a missing bar).
        let _=super::load(&req).await;
        let result=tokio::time::timeout(Duration::from_secs(12),connect_async(&url)).await;
        if let Ok(Ok((mut socket,_)))=result {
            if let Some(body)=&subscribe {
                if socket.send(Message::Text(body.to_string().into())).await.is_err() {
                    disconnected(&req).await;
                    tokio::time::sleep(Duration::from_secs(delay)).await;
                    delay=(delay*2).min(60);
                    continue;
                }
            }
            delay=1;
            if let Some(slot)=slots().lock().await.get_mut(&key(&req)) {
                slot.last_connection_ms=Some(epoch_ms());
            }
            let mut ping=tokio::time::interval(Duration::from_secs(20));
            let mut coinbase=CoinbaseTrades::default();
            loop {
                tokio::select! {
                    _=ping.tick()=>{
                        let heartbeat=if req.exchange=="BYBIT"{Message::Text(json!({"op":"ping"}).to_string().into())}
                            else if req.exchange=="OKX"||req.exchange=="BITGET"{Message::Text("ping".into())}
                            else{Message::Ping(Vec::new().into())};
                        if socket.send(heartbeat).await.is_err(){break;}
                    }
                    result=tokio::time::timeout(Duration::from_secs(75),socket.next())=>{
                        let message=match result {Ok(Some(Ok(m)))=>m,_=>break};
                        if let Message::Text(text)=message {
                            if text.len()>262144 {break;}
                            let Ok(value)=serde_json::from_str::<Value>(&text) else {continue};
                            if value["event"]=="error" || value["type"]=="error" {break;}
                            let parsed=if req.exchange=="COINBASE" {
                                coinbase.on_message(&req,&value)
                            }else{parse_candle(&req,&value)};
                            if let Some(candle)=parsed{publish(&req,candle).await;}
                        }else if let Message::Ping(payload)=message {
                            if socket.send(Message::Pong(payload)).await.is_err(){break;}
                        }else if message.is_close(){break;}
                    }
                }
            }
        }
        disconnected(&req).await;
        tokio::time::sleep(Duration::from_secs(delay)).await;
        delay=(delay*2).min(60);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn req(exchange:&str,market:&str,symbol:&str)->Request {
        Request{exchange:exchange.into(),market:market.into(),symbol:symbol.into(),interval:"1m".into(),limit:Some(200)}
    }
    #[test] fn native_provider_candle_events_are_normalized() {
        let t=1_696_982_400_000_u64;
        let k=json!({"s":"BTCUSDT","i":"1m","t":t,"o":"100","h":"110","l":"90","c":"105","v":"12"});
        let bin=json!({"e":"kline","k":k});
        let b=parse_candle(&req("BINANCE","spot","BTCUSDT"),&bin).unwrap();
        assert_eq!((b.open,b.close,b.volume),(100.0,105.0,12.0));
        let by=json!({"topic":"kline.1.BTCUSDT","data":[{"start":t,"open":"100","high":"110","low":"90","close":"105","volume":"12"}]});
        assert_eq!(parse_candle(&req("BYBIT","perp","BTCUSDT"),&by),Some(b.clone()));
        let ok=json!({"arg":{"channel":"candle1m","instId":"BTC-USDT"},"data":[[t.to_string(),"100","110","90","105","12"]]});
        assert_eq!(parse_candle(&req("OKX","spot","BTC-USDT"),&ok),Some(b.clone()));
        let bit=json!({"arg":{"instType":"spot","topic":"kline","symbol":"BTCUSDT","interval":"1m"},
            "data":[{"start":t.to_string(),"open":"100","high":"110","low":"90","close":"105","volume":"12"}]});
        assert_eq!(parse_candle(&req("BITGET","spot","BTCUSDT"),&bit),Some(b.clone()));
        assert_eq!(parse_candle(&req("BITGET","perp","BTCUSDT"),&bit),None);
        let bit_array=json!({"arg":{"instType":"spot","topic":"kline","symbol":"BTCUSDT","interval":"1m"},
            "data":[[t.to_string(),"100","110","90","105","12"]]});
        assert_eq!(parse_candle(&req("BITGET","spot","BTCUSDT"),&bit_array),Some(b.clone()));
        let hl=json!({"channel":"candle","data":{"s":"BTC","i":"1m","t":t,"o":"100","h":"110","l":"90","c":"105","v":"12"}});
        assert_eq!(parse_candle(&req("HYPERLIQUID","perp","BTC"),&hl),Some(b));
        assert_eq!(parse_candle(&req("BINANCE","spot","ETHUSDT"),&bin),None);
    }
    #[test]
    fn candle_gap_diagnostics_detect_missing_minute_without_filling() {
        let b=|time|Bar{time,open:10.0,high:11.0,low:9.0,close:10.0,volume:1.0};
        let xs=vec![b(1_696_982_400),b(1_696_982_460),b(1_696_982_640)];
        assert_eq!(history_gaps(&xs,60),(1,2));
        assert_eq!(xs.len(),3);
        assert_eq!(history_gaps(&xs[..2],60),(0,0));
        assert_eq!(history_gaps(&[],60),(0,0));
    }
    #[test]
    fn diagnostics_never_report_websocket_without_fresh_update() {
        let req=req("BINANCE","spot","BTCUSDT");
        let unknown=telemetry(&req,None);
        assert_eq!(unknown["state"],"not_started");
        assert_eq!(unknown["fresh"],false);
        let no_candle=Slot{connected:true,last:None,recent:VecDeque::new(),last_at:None,reconnects:1,
            updates:0,last_update_ms:None,last_connection_ms:Some(1),
            last_disconnection_ms:None,last_rest_ms:None,rest_successes:0,
            rest_recoveries:0,last_rest_gap_count:0,last_rest_missing_bars:0};
        assert_eq!(telemetry(&req,Some(&no_candle))["state"],"stale");
        let fresh=Slot{connected:true,last:Some(Bar{time:1_696_982_400,open:1.0,
            high:2.0,low:0.5,close:1.0,volume:4.0}),
            last_at:Some(Instant::now()),last_update_ms:Some(epoch_ms()),
            ..no_candle};
        assert_eq!(telemetry(&req,Some(&fresh))["state"],"websocket");
    }

    #[test]
    fn coinbase_trade_buckets_are_complete_after_warmup_and_deduplicated() {
        let req=req("COINBASE","spot","BTC-USD");
        let mut trades=CoinbaseTrades::default();
        let base=epoch_ms()/60_000*60;
        let msg=|id:u64,time:u64,price:&str|{
            let when=chrono::DateTime::from_timestamp(time as i64,0).unwrap().to_rfc3339();
            json!({"type":"match","product_id":"BTC-USD","trade_id":id,
                "price":price,"size":"2","time":when})
        };
        assert!(trades.on_message(&req,&msg(10,base,"100")).is_none());
        assert!(trades.on_message(&req,&msg(10,base,"100")).is_none());
        assert!(trades.on_message(&req,&msg(11,base,"101")).is_none());
        // A complete new bucket starts at its first observed trade.
        let next=base+60;
        // A fake future timestamp would be rejected; use a past minute.
        let mut historic=CoinbaseTrades::default();
        let first=base.saturating_sub(120);
        assert!(historic.on_message(&req,&msg(100,first,"100")).is_none());
        let ready=historic.on_message(&req,&msg(101,first+60,"102")).unwrap();
        assert_eq!((ready.open,ready.volume),(102.0,2.0));
        assert!(historic.on_message(&req,&msg(101,first+60,"102")).is_none());
        let grown=historic.on_message(&req,&msg(102,first+61,"103")).unwrap();
        assert_eq!((grown.open,grown.high,grown.volume),(102.0,103.0,4.0));
        let _=next;
    }

    #[tokio::test]
    async fn reconnect_retains_real_recent_buckets_and_exposes_recovery_state() {
        let req=req("COINBASE","spot","SOL-USD");
        let k=key(&req);
        let start=epoch_ms()/60_000*60-120;
        let candle=|time:u64| Bar{time,open:100.0,high:100.0,low:100.0,close:100.0,volume:1.0};
        let slot=Slot{connected:false,last:None,recent:VecDeque::new(),
            last_at:None,reconnects:0,updates:0,last_update_ms:None,
            last_connection_ms:None,last_disconnection_ms:None,
            last_rest_ms:None,rest_successes:0,rest_recoveries:0,
            last_rest_gap_count:0,last_rest_missing_bars:0};
        slots().lock().await.insert(k.clone(),slot);
        publish(&req,candle(start)).await;
        assert_eq!(status(&req).await,"websocket");
        disconnected(&req).await;
        let offline=health(&req).await;
        assert_eq!(offline["state"],"reconnecting");
        assert_eq!(offline["reconnect_count"],1);
        assert_eq!(recent(&req).await.len(),1);
        publish(&req,candle(start+60)).await;
        assert_eq!(status(&req).await,"websocket");
        assert_eq!(recent(&req).await.len(),2);
        assert_eq!(health(&req).await["reconnect_count"],1);
        // Ignore replay of an earlier minute, including after reconnect.
        publish(&req,candle(start)).await;
        assert_eq!(recent(&req).await.len(),2);
        assert_eq!(recent(&req).await.last().unwrap().time,start+60);
        slots().lock().await.remove(&k);
    }

}