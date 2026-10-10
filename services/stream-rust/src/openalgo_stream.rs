//! OpenAlgo authenticated WebSocket subscription boundary.
//! Private operator diagnostics only: real ticks are never sent to QSYN's
//! public demo, marked entitled, persisted or made executable by this module.
//! OpenAlgo brokers handle their own OAuth/TOTP and encrypted tokens upstream.
use crate::market_pipeline::Scope;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::time::{timeout, Duration, Instant};
use tokio_tungstenite::{connect_async, tungstenite::Message};

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Subscription {
    pub exchange: String,
    pub symbol: String,
}

impl Subscription {
    pub fn valid(&self) -> bool {
        const EXCHANGES: &[&str] = &["NSE","BSE","NFO","BFO","MCX","CDS","NSE_INDEX","BSE_INDEX"];
        EXCHANGES.contains(&self.exchange.as_str())
            && !self.symbol.is_empty() && self.symbol.len() <= 100
            && self.symbol.bytes().all(|c| c.is_ascii_uppercase()
                || c.is_ascii_digit() || matches!(c, b'_' | b'-' | b'.'))
    }
}

#[derive(Debug, Clone)]
pub struct CandidateQuote {
    pub scope: Scope,
    pub instrument_id: String,
    pub exchange_timestamp_ms: u64,
    pub received_timestamp_ms: u64,
    pub price: f64,
    pub stale: bool,
    pub entitlement_verified: bool,
    pub publishable_to_public_studio: bool,
}

/// The provider's delivery time and source timestamp are not the same.
/// Never infer exchange entitlement or market-data redistribution rights.
pub fn normalize(
    raw: &str,
    scope: &Scope,
    broker: &str,
    subscriptions: &[Subscription],
    received_ms: u64,
) -> io::Result<Option<CandidateQuote>> {
    if raw.len() > 65536 {
        return Err(invalid("oversized_provider_message"));
    }
    let frame: Value = serde_json::from_str(raw)
        .map_err(|_| invalid("invalid_provider_json"))?;
    if frame["type"] != "market_data" {
        return Ok(None);
    }
    let exchange = frame["exchange"].as_str().ok_or_else(|| invalid("missing_exchange"))?;
    let symbol = frame["symbol"].as_str().ok_or_else(|| invalid("missing_symbol"))?;
    if frame["broker"] != broker || frame["mode"] != 1
        || !subscriptions.iter().any(|s| s.exchange == exchange && s.symbol == symbol)
    {
        return Err(invalid("wrong_broker_mode_or_subscription"));
    }
    let data = frame["data"].as_object().ok_or_else(|| invalid("missing_ltp_data"))?;
    let price = data.get("ltp").and_then(Value::as_f64)
        .filter(|x| x.is_finite() && *x > 0.0)
        .ok_or_else(|| invalid("invalid_provider_ltp"))?;
    let ts = data.get("timestamp").and_then(Value::as_u64)
        .ok_or_else(|| invalid("missing_provider_timestamp"))?;
    if ts == 0 || ts > received_ms.saturating_add(30_000) {
        return Err(invalid("future_or_invalid_timestamp"));
    }
    Ok(Some(CandidateQuote {
        scope: scope.clone(),
        instrument_id: format!("{exchange}|{symbol}"),
        exchange_timestamp_ms: ts, received_timestamp_ms: received_ms,
        price, stale: received_ms.saturating_sub(ts) > 120_000,
        entitlement_verified: false,
        publishable_to_public_studio: false,
    }))
}

#[derive(Debug, Serialize)]
pub struct FeedDiagnostic {
    pub schema: &'static str,
    pub source: &'static str,
    pub authenticated_to_openalgo: bool,
    pub broker: String,
    pub account_id: String,
    pub delivered_frames: usize,
    pub fresh_frames: usize,
    pub stale_frames: usize,
    pub skipped_duplicates: usize,
    pub source_exchange_timestamps_present: bool,
    pub exchange_entitlement_verified: bool,
    pub market_data_redistribution_approved: bool,
    pub live_trading_enabled: bool,
}

/// A bounded probe of a single isolated loopback OpenAlgo instance.
/// The key is only ever written to the authenticated local WS channel.
/// No broker order action is sent. The caller must independently authenticate
/// and authorize the broker session and verify local config permissions.
pub async fn probe(
    ws_port: u16,
    key: &str,
    broker: &str,
    scope: &Scope,
    subscriptions: &[Subscription],
    max_frames: usize,
    duration_seconds: u64,
) -> io::Result<FeedDiagnostic> {
    if ws_port < 1025 || key.len() < 16 || key.len() > 256
        || subscriptions.is_empty() || subscriptions.len() > 8
        || !(1..=200).contains(&max_frames)
        || !(1..=30).contains(&duration_seconds)
        || broker.is_empty() || !broker.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
    {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid_probe_settings"));
    }
    let mut unique = HashSet::new();
    if subscriptions.iter().any(|s| !s.valid() || !unique.insert(s.clone())) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid_duplicate_subscription"));
    }
    let url = format!("ws://127.0.0.1:{ws_port}");
    let (mut socket, _) = timeout(Duration::from_secs(5), connect_async(url))
        .await.map_err(|_| invalid("provider_connection_timeout"))?
        .map_err(|_| invalid("local_openalgo_ws_unavailable"))?;

    socket.send(Message::Text(json!({"action":"authenticate","api_key":key}).to_string().into()))
        .await.map_err(|_| invalid("provider_auth_send_failed"))?;
    let authenticated = timeout(Duration::from_secs(5), async {
        loop {
            let incoming = socket.next().await
                .ok_or_else(|| invalid("provider_closed_before_auth"))?
                .map_err(|_| invalid("provider_auth_frame_failed"))?;
            if let Message::Text(text) = incoming {
                let parsed: Value = serde_json::from_str(&text)
                    .map_err(|_| invalid("invalid_provider_auth_json"))?;
                if parsed["type"] == "auth" {
                    if parsed["status"] != "success" || parsed["broker"] != broker {
                        return Err(invalid("broker_auth_or_identity_mismatch"));
                    }
                    return Ok(());
                }
                if parsed["type"] == "error" { return Err(invalid("provider_auth_denied")); }
            } else if incoming.is_close() {
                return Err(invalid("provider_auth_closed"));
            }
        }
    }).await.map_err(|_| invalid("provider_auth_timeout"))?;
    authenticated?;

    socket.send(Message::Text(json!({
        "action":"subscribe","mode":"LTP","symbols":subscriptions
    }).to_string().into())).await.map_err(|_| invalid("subscription_send_failed"))?;

    let start = Instant::now();
    let mut total = 0usize;
    let mut fresh = 0usize;
    let mut stale = 0usize;
    let mut duplicates = 0usize;
    let mut last = HashMap::<String, (u64, f64)>::new();
    while start.elapsed().as_secs() < duration_seconds && total < max_frames {
        let remaining = Duration::from_secs(duration_seconds)
            .saturating_sub(start.elapsed());
        let received = timeout(remaining, socket.next()).await;
        let incoming = match received {
            Ok(Some(Ok(frame))) => frame,
            Ok(Some(Err(_))) => return Err(invalid("provider_stream_error")),
            Ok(None) => break,
            Err(_) => break,
        };
        if incoming.is_close() { break; }
        if let Message::Ping(bytes) = incoming {
            socket.send(Message::Pong(bytes)).await
                .map_err(|_| invalid("provider_pong_failed"))?;
            continue;
        }
        let Message::Text(text) = incoming else { continue };
        let now_ms = SystemTime::now().duration_since(UNIX_EPOCH)
            .map_err(|_| invalid("local_clock_invalid"))?.as_millis() as u64;
        if let Some(candidate) = normalize(&text, scope, broker, subscriptions, now_ms)? {
            let duplicate = last.get(&candidate.instrument_id)
                .is_some_and(|(ms, price)| candidate.exchange_timestamp_ms < *ms
                    || (candidate.exchange_timestamp_ms == *ms && candidate.price == *price));
            if duplicate {
                duplicates += 1;
                continue;
            }
            last.insert(candidate.instrument_id.clone(),
                (candidate.exchange_timestamp_ms, candidate.price));
            total += 1;
            if candidate.stale { stale += 1; } else { fresh += 1; }
        }
    }
    // Attempt graceful close; failure is not permission to publish data.
    let _ = socket.close(None).await;
    Ok(FeedDiagnostic {
        schema: "QSYN-PRIVATE-OPENALGO-STREAM/1",
        source: "read_only_local_provider_probe",
        authenticated_to_openalgo: true,
        broker: broker.to_owned(),
        account_id: scope.account_id.clone(),
        delivered_frames: total, fresh_frames: fresh, stale_frames: stale,
        skipped_duplicates: duplicates,
        source_exchange_timestamps_present: total > 0,
        exchange_entitlement_verified: false,
        market_data_redistribution_approved: false,
        live_trading_enabled: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_tungstenite::accept_async;
    fn scope() -> Scope {
        Scope { tenant_id: "tenantA".into(), account_id: "brokerA".into(),
            source_id: "openalgo".into(), entitlement_id: "not_verified".into() }
    }
    fn symbols() -> Vec<Subscription> {
        vec![Subscription { exchange: "NFO".into(), symbol: "NIFTY29OCT2624500CE".into() }]
    }
    #[test]
    fn normalizes_only_correctly_scoped_ltp_without_licensing_claims() {
        let now = 1800000000000u64;
        let quote = json!({
            "type":"market_data", "symbol":symbols()[0].symbol,
            "exchange":"NFO","broker":"upstox","mode":1,
            "data":{"ltp":101.25,"timestamp":now-500}
        });
        let valid = normalize(&quote.to_string(), &scope(), "upstox", &symbols(), now).unwrap().unwrap();
        assert_eq!(valid.instrument_id, "NFO|NIFTY29OCT2624500CE");
        assert_eq!(valid.price, 101.25);
        assert!(!valid.entitlement_verified && !valid.publishable_to_public_studio && !valid.stale);
        let mut foreign = quote.clone();
        foreign["broker"] = json!("zerodha");
        assert!(normalize(&foreign.to_string(), &scope(), "upstox", &symbols(), now).is_err());
        foreign = quote.clone(); foreign["data"]["ltp"] = json!(-1);
        assert!(normalize(&foreign.to_string(), &scope(), "upstox", &symbols(), now).is_err());
        foreign = quote.clone(); foreign["data"]["timestamp"] = json!(now+60000);
        assert!(normalize(&foreign.to_string(), &scope(), "upstox", &symbols(), now).is_err());
        foreign = quote.clone(); foreign["data"]["timestamp"] = json!(now-180000);
        assert!(normalize(&foreign.to_string(), &scope(), "upstox", &symbols(), now).unwrap().unwrap().stale);
        foreign = quote; foreign["type"] = json!("subscription_ack");
        assert!(normalize(&foreign.to_string(), &scope(), "upstox", &symbols(), now).unwrap().is_none());
    }

    #[tokio::test]
    async fn authenticates_then_subscribes_to_loopback_fake_provider() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut ws = accept_async(tcp).await.unwrap();
            let auth = ws.next().await.unwrap().unwrap().into_text().unwrap();
            let auth: Value = serde_json::from_str(&auth).unwrap();
            assert_eq!(auth["action"], "authenticate");
            assert_eq!(auth["api_key"], "fake-private-openalgo-key");
            ws.send(Message::Text(json!({"type":"auth","status":"success","broker":"upstox"}).to_string().into())).await.unwrap();
            let sub = ws.next().await.unwrap().unwrap().into_text().unwrap();
            let sub: Value = serde_json::from_str(&sub).unwrap();
            assert_eq!(sub["action"], "subscribe");
            assert_eq!(sub["mode"], "LTP");
            let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64;
            let quote = json!({"type":"market_data","symbol":"NIFTY29OCT2624500CE",
                "exchange":"NFO","broker":"upstox","mode":1,
                "data":{"ltp":125.5,"timestamp":now}});
            ws.send(Message::Text(quote.to_string().into())).await.unwrap();
            let _ = ws.close(None).await;
        });
        let report = probe(port, "fake-private-openalgo-key", "upstox",
            &scope(), &symbols(), 10, 2).await.unwrap();
        assert_eq!(report.delivered_frames, 1);
        assert_eq!(report.fresh_frames, 1);
        assert!(!report.exchange_entitlement_verified);
        assert!(!report.market_data_redistribution_approved);
        server.await.unwrap();
    }
}
