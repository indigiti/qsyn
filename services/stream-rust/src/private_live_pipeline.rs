//! Read-only, bounded private OpenAlgo market observations.
//! No broker orders, credential storage, public feed, licensed history or UI.
use crate::market_pipeline::{Candle, Scope, WeightedLeg};
use crate::openalgo_stream::{normalize, CandidateQuote, Subscription};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::time::{sleep, timeout, Duration, Instant};
use tokio_tungstenite::{connect_async, tungstenite::Message};

fn denied(reason: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, reason)
}
fn utc_ms() -> io::Result<u64> {
    Ok(SystemTime::now().duration_since(UNIX_EPOCH)
        .map_err(|_| denied("invalid_worker_clock"))?.as_millis() as u64)
}
#[derive(Debug, Clone)]
pub struct PrivateFeedPlan {
    pub ws_port: u16,
    pub broker: String,
    pub scope: Scope,
    pub subscriptions: Vec<Subscription>,
    pub legs: Vec<WeightedLeg>,
    pub max_skew_ms: u64,
    pub observe_seconds: u64,
    pub max_reconnects: u32,
}
impl PrivateFeedPlan {
    pub fn validate(&self) -> io::Result<()> {
        if self.ws_port < 1025 || self.broker.is_empty()
            || !self.broker.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
            || [&self.scope.account_id, &self.scope.tenant_id,
                &self.scope.source_id, &self.scope.entitlement_id].iter().any(|s| s.is_empty() || s.len() > 128)
            || self.subscriptions.is_empty() || self.subscriptions.len() > 8
            || self.legs.is_empty() || self.legs.len() > 8
            || self.max_skew_ms > 5_000
            || !(1..=120).contains(&self.observe_seconds) || self.max_reconnects > 4
        { return Err(denied("invalid_private_feed_plan")); }
        let mut known = HashSet::new();
        if self.subscriptions.iter().any(|s| !s.valid()
            || !known.insert(format!("{}|{}", s.exchange, s.symbol))) {
            return Err(denied("duplicate_or_invalid_subscription"));
        }
        let mut legs = HashSet::new();
        if self.legs.iter().any(|l| !known.contains(&l.instrument_id)
            || !legs.insert(l.instrument_id.clone()) || !l.quantity.is_finite()
            || l.quantity <= 0.0 || l.quantity > 100.0) {
            return Err(denied("invalid_or_unsubscribed_basket_leg"));
        }
        Ok(())
    }
}
#[derive(Debug, Clone)]
pub struct BasketUpdate {
    pub forming: Candle,
    pub finalized: Option<Candle>,
}
/// In-memory, strictly scoped, synchronized premium OHLC. Different component
/// candles' highs/lows are never arithmetically summed together.
pub struct PrivateBasket {
    scope: Scope,
    legs: Vec<WeightedLeg>,
    max_skew_ms: u64,
    latest: HashMap<String, (u64, f64)>,
    forming: Option<Candle>,
    last_event_ms: u64,
    pub gap_detected: bool,
}
impl PrivateBasket {
    pub fn new(plan: &PrivateFeedPlan) -> io::Result<Self> {
        plan.validate()?;
        Ok(Self { scope: plan.scope.clone(), legs: plan.legs.clone(),
            max_skew_ms: plan.max_skew_ms, latest: HashMap::new(),
            forming: None, last_event_ms: 0, gap_detected: false })
    }
    pub fn disconnect(&mut self) {
        // Never forward-fill quotes across disconnected broker sessions.
        self.latest.clear();
        self.forming = None;
        self.gap_detected = true;
    }
    pub fn on_candidate(&mut self, candidate: &CandidateQuote) -> Option<BasketUpdate> {
        if candidate.scope != self.scope || candidate.entitlement_verified
            || candidate.publishable_to_public_studio || candidate.stale
            || !candidate.price.is_finite() || candidate.price <= 0.0
            || candidate.exchange_timestamp_ms == 0
            || candidate.received_timestamp_ms < candidate.exchange_timestamp_ms
            || candidate.received_timestamp_ms.saturating_sub(candidate.exchange_timestamp_ms) > 5_000
            || candidate.exchange_timestamp_ms < self.last_event_ms
            || !self.legs.iter().any(|leg| leg.instrument_id == candidate.instrument_id)
        { return None; }
        if self.latest.get(&candidate.instrument_id)
            .is_some_and(|(prev,_)| candidate.exchange_timestamp_ms <= *prev) {
            return None;
        }
        self.latest.insert(candidate.instrument_id.clone(),
            (candidate.exchange_timestamp_ms, candidate.price));
        let mut oldest = u64::MAX;
        let mut newest = 0u64;
        let mut minute = None;
        let mut premium = 0.0;
        for leg in &self.legs {
            let (ts, price) = *self.latest.get(&leg.instrument_id)?;
            let m = ts / 60_000;
            if minute.is_some_and(|previous| previous != m) { return None; }
            minute = Some(m);
            oldest = oldest.min(ts);
            newest = newest.max(ts);
            premium += leg.quantity * price;
        }
        if newest.saturating_sub(oldest) > self.max_skew_ms
            || !premium.is_finite() || premium <= 0.0 {
            return None;
        }
        let opening = newest / 60_000 * 60_000;
        let previous = self.forming.take();
        let (forming, finalized) = match previous {
            Some(mut candle) if candle.open_time_ms == opening => {
                candle.low = candle.low.min(premium);
                candle.high = candle.high.max(premium);
                candle.close = premium;
                candle.observations = candle.observations.saturating_add(1);
                (candle, None)
            }
            Some(candle) if candle.open_time_ms < opening => {
                if opening - candle.open_time_ms > 60_000 {
                    self.gap_detected = true;
                }
                (Candle { open_time_ms: opening, open: premium, low: premium,
                    high: premium, close: premium, observations: 1 }, Some(candle))
            }
            Some(candle) => {
                self.forming = Some(candle);
                return None;
            }
            None => (Candle { open_time_ms: opening, open: premium, low: premium,
                high: premium, close: premium, observations: 1 }, None),
        };
        self.forming = Some(forming.clone());
        self.last_event_ms = newest;
        Some(BasketUpdate { forming, finalized })
    }
}
#[derive(Debug, Default, Serialize)]
pub struct FeedReport {
    pub schema: &'static str,
    pub broker: String,
    pub account_id: String,
    pub authenticated_sessions: u32,
    pub reconnections: u32,
    pub synchronized_updates: u64,
    pub finalized_candles: u64,
    pub rejected_quotes: u64,
    pub data_gap_detected: bool,
    pub entitlement_attested: bool,
    pub public_feed_enabled: bool,
    pub order_execution_enabled: bool,
}

/// Operator-only time-bounded reconnecting observer. Upstream OpenAlgo owns
/// OAuth; this function does not authorize a QSYN public viewer or trade.
pub async fn observe(plan: &PrivateFeedPlan, key: &str) -> io::Result<FeedReport> {
    plan.validate()?;
    if !(16..=256).contains(&key.len()) || !key.bytes().all(|b|
        b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
        return Err(denied("invalid_private_openalgo_key"));
    }
    let mut report = FeedReport {
        schema: "QSYN-PRIVATE-FEED-OBSERVATION/1", broker: plan.broker.clone(),
        account_id: plan.scope.account_id.clone(), ..Default::default()
    };
    let deadline = Instant::now() + Duration::from_secs(plan.observe_seconds);
    let mut basket = PrivateBasket::new(plan)?;
    for attempt in 0..=plan.max_reconnects {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() { break; }
        if attempt > 0 {
            report.reconnections += 1;
            basket.disconnect();
            let backoff = Duration::from_millis(250 * (1u64 << (attempt - 1)));
            sleep(backoff.min(remaining)).await;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() { break; }
        let url = format!("ws://127.0.0.1:{}", plan.ws_port);
        let attempt_connect = timeout(remaining.min(Duration::from_secs(3)), connect_async(url)).await;
        let Ok(Ok((mut socket, _))) = attempt_connect else { continue; };
        socket.send(Message::Text(json!({
            "action":"authenticate", "api_key":key
        }).to_string().into())).await.map_err(|_| denied("auth_send_failed"))?;
        let authenticated = timeout(
            deadline.saturating_duration_since(Instant::now()).min(Duration::from_secs(3)),
            async {
                loop {
                    let packet = socket.next().await.ok_or_else(|| denied("auth_disconnected"))?
                        .map_err(|_| denied("auth_transport_error"))?;
                    if let Message::Text(text) = packet {
                        if text.len() > 8192 { return Err(denied("oversized_auth_frame")); }
                        let data: Value = serde_json::from_str(&text)
                            .map_err(|_| denied("malformed_auth_frame"))?;
                        if data["type"] == "error" { return Err(denied("auth_denied")); }
                        if data["type"] == "auth" {
                            if data["status"] != "success" || data["broker"] != plan.broker {
                                return Err(denied("auth_identity_mismatch"));
                            }
                            return Ok(());
                        }
                    } else if packet.is_close() { return Err(denied("auth_closed")); }
                }
            },
        ).await.map_err(|_| denied("auth_timeout"))?;
        authenticated?; // invalid authorization is not a recoverable quote gap
        report.authenticated_sessions += 1;
        socket.send(Message::Text(json!({
            "action":"subscribe", "mode":"LTP", "symbols":plan.subscriptions
        }).to_string().into())).await.map_err(|_| denied("subscribe_send_failed"))?;
        let mut retry = false;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() { break; }
            let received = timeout(left.min(Duration::from_secs(10)), socket.next()).await;
            let msg = match received {
                Ok(Some(Ok(msg))) => msg,
                Ok(None) | Ok(Some(Err(_))) | Err(_) => { retry = true; break; }
            };
            if msg.is_close() { retry = true; break; }
            if let Message::Ping(body) = msg {
                socket.send(Message::Pong(body)).await
                    .map_err(|_| denied("provider_pong_failed"))?;
                continue;
            }
            let Message::Text(text) = msg else { continue };
            if text.len() > 65_536 { return Err(denied("oversized_market_frame")); }
            let frame: Value = serde_json::from_str(&text)
                .map_err(|_| denied("malformed_market_frame"))?;
            if frame["type"] == "error"
                || (frame["type"] == "subscribe" && frame["status"] == "error") {
                return Err(denied("subscription_not_authorized"));
            }
            if let Some(quote) = normalize(&text, &plan.scope, &plan.broker,
                &plan.subscriptions, utc_ms()?)? {
                if let Some(update) = basket.on_candidate(&quote) {
                    report.synchronized_updates += 1;
                    if update.finalized.is_some() { report.finalized_candles += 1; }
                } else {
                    report.rejected_quotes += 1;
                }
            }
        }
        let _ = socket.close(None).await;
        if !retry { break; }
    }
    report.data_gap_detected = basket.gap_detected;
    Ok(report)
}
#[cfg(test)]
mod tests {
    use super::*;
    use tokio_tungstenite::accept_async;

    fn plan(port: u16) -> PrivateFeedPlan {
        PrivateFeedPlan { ws_port: port, broker: "upstox".into(),
            scope: Scope { tenant_id: "tenantA".into(), account_id: "accountA".into(),
                source_id: "isolated_provider".into(), entitlement_id: "not_attested".into() },
            subscriptions: vec![
                Subscription { exchange: "NFO".into(), symbol: "CE".into() },
                Subscription { exchange: "NFO".into(), symbol: "PE".into() },
            ],
            legs: vec![
                WeightedLeg { instrument_id: "NFO|CE".into(), quantity: 1.0 },
                WeightedLeg { instrument_id: "NFO|PE".into(), quantity: 1.0 },
            ], max_skew_ms: 500, observe_seconds: 2, max_reconnects: 0 }
    }
    fn q(p: &PrivateFeedPlan, symbol: &str, ts: u64, price: f64) -> CandidateQuote {
        CandidateQuote { scope: p.scope.clone(), instrument_id: format!("NFO|{symbol}"),
            exchange_timestamp_ms: ts, received_timestamp_ms: ts + 5, price,
            stale: false, entitlement_verified: false, publishable_to_public_studio: false }
    }
    #[test]
    fn no_cross_minute_forward_fill_or_cross_account_contamination() {
        let p = plan(8765);
        let mut builder = PrivateBasket::new(&p).unwrap();
        assert!(builder.on_candidate(&q(&p, "CE", 60_000, 100.0)).is_none());
        let first = builder.on_candidate(&q(&p, "PE", 60_010, 80.0)).unwrap();
        assert_eq!(first.forming.open, 180.0);
        assert!(builder.on_candidate(&q(&p, "CE", 120_000, 110.0)).is_none());
        let completed = builder.on_candidate(&q(&p, "PE", 120_010, 90.0)).unwrap();
        assert_eq!(completed.finalized.unwrap().close, 180.0);
        assert_eq!(completed.forming.open, 200.0);
        assert!(builder.on_candidate(&q(&p, "PE", 120_010, 900.0)).is_none());
        let mut foreign = q(&p, "CE", 120_100, 500.0);
        foreign.scope.account_id = "accountB".into();
        assert!(builder.on_candidate(&foreign).is_none());
        builder.disconnect();
        assert!(builder.gap_detected);
        assert!(builder.on_candidate(&q(&p, "PE", 180_000, 20.0)).is_none());
        assert!(builder.on_candidate(&q(&p, "CE", 180_020, 30.0)).is_some());
    }
    #[tokio::test]
    async fn authenticates_and_subscribes_to_private_fake_openalgo() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut ws = accept_async(tcp).await.unwrap();
            let auth: Value = serde_json::from_str(
                &ws.next().await.unwrap().unwrap().into_text().unwrap()).unwrap();
            assert_eq!(auth["action"], "authenticate");
            assert_eq!(auth["api_key"], "fake-private-openalgo-key-123");
            ws.send(Message::Text(json!({
                "type":"auth", "status":"success", "broker":"upstox"
            }).to_string().into())).await.unwrap();
            let sub: Value = serde_json::from_str(
                &ws.next().await.unwrap().unwrap().into_text().unwrap()).unwrap();
            assert_eq!(sub["action"], "subscribe");
            assert_eq!(sub["mode"], "LTP");
            let now = utc_ms().unwrap().saturating_sub(1_000);
            for (symbol, price) in [("CE", 100.0), ("PE", 80.0)] {
                ws.send(Message::Text(json!({
                    "type":"market_data", "broker":"upstox", "mode":1,
                    "exchange":"NFO", "symbol":symbol,
                    "data":{"ltp":price, "timestamp":now}
                }).to_string().into())).await.unwrap();
            }
            let _ = ws.close(None).await;
        });
        let report = observe(&plan(port), "fake-private-openalgo-key-123").await.unwrap();
        assert_eq!(report.authenticated_sessions, 1);
        assert_eq!(report.synchronized_updates, 1);
        assert!(!report.public_feed_enabled);
        assert!(!report.entitlement_attested);
        assert!(!report.order_execution_enabled);
        server.await.unwrap();
    }
}
