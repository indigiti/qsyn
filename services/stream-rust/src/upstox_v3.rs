//! Native Upstox Market Data Feed V3 *read-only* wire decoder and bounded
//! single-session source. No broker login, bearer token, public redistribution,
//! paper/live orders or automatically started background worker.
//!
//! Wire tags follow the official Upstox MarketDataFeed.proto (V3).
//! https://assets.upstox.com/feed/market-data-feed/v3/MarketDataFeed.proto
//! Only operator-verified, currently listed CE/PE keys enter this adapter.
//! Last trade time (ltpc.ltt) is NOT replaced by packet reception time.
use crate::market_pipeline::Scope;
use crate::openalgo_stream::CandidateQuote;
use futures_util::{SinkExt, StreamExt};
use prost::Message as ProstMessage;
use serde_json::json;
use std::collections::HashMap;
use std::io;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::time::{timeout, Duration, Instant};
use tokio_tungstenite::{connect_async, tungstenite::Message};

const MAX_FRAME: usize = 65_536;
const MAX_SESSION_SECONDS: u64 = 120;
const MAX_QUOTE_DELAY_MS: u64 = 5_000;

fn denied(reason: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, reason)
}
fn epoch_ms() -> io::Result<u64> {
    Ok(SystemTime::now().duration_since(UNIX_EPOCH)
        .map_err(|_| denied("invalid_receiver_clock"))?.as_millis() as u64)
}

// Schema is intentionally limited to fields needed for LTPC and market status.
// Protobuf safely ignores new fields; no binary frame is parsed as JSON.
#[derive(Clone, PartialEq, prost::Message)]
struct Ltpc {
    #[prost(double, tag = "1")]
    ltp: f64,
    #[prost(int64, tag = "2")]
    ltt: i64,
    #[prost(int64, tag = "3")]
    ltq: i64,
    #[prost(double, tag = "4")]
    cp: f64,
}
#[derive(Clone, PartialEq, prost::Message)]
struct MarketFullFeed {
    #[prost(message, optional, tag = "1")]
    ltpc: Option<Ltpc>,
}
#[derive(Clone, PartialEq, prost::Message)]
struct IndexFullFeed {
    #[prost(message, optional, tag = "1")]
    ltpc: Option<Ltpc>,
}
#[derive(Clone, PartialEq, prost::Message)]
struct FullFeed {
    #[prost(oneof = "full_feed::Variant", tags = "1, 2")]
    variant: Option<full_feed::Variant>,
}
mod full_feed {
    #[derive(Clone, PartialEq, prost::Oneof)]
    pub enum Variant {
        #[prost(message, tag = "1")]
        Market(super::MarketFullFeed),
        #[prost(message, tag = "2")]
        Index(super::IndexFullFeed),
    }
}
#[derive(Clone, PartialEq, prost::Message)]
struct FirstLevelWithGreeks {
    #[prost(message, optional, tag = "1")]
    ltpc: Option<Ltpc>,
}
#[derive(Clone, PartialEq, prost::Message)]
struct Feed {
    #[prost(oneof = "feed::Variant", tags = "1, 2, 3")]
    variant: Option<feed::Variant>,
    #[prost(int32, tag = "4")]
    request_mode: i32,
}
mod feed {
    #[derive(Clone, PartialEq, prost::Oneof)]
    pub enum Variant {
        #[prost(message, tag = "1")]
        Ltpc(super::Ltpc),
        #[prost(message, tag = "2")]
        Full(super::FullFeed),
        #[prost(message, tag = "3")]
        FirstLevel(super::FirstLevelWithGreeks),
    }
}
impl Feed {
    fn last_trade(&self) -> Option<&Ltpc> {
        match &self.variant {
            Some(feed::Variant::Ltpc(v)) => Some(v),
            Some(feed::Variant::Full(v)) => match &v.variant {
                Some(full_feed::Variant::Market(m)) => m.ltpc.as_ref(),
                Some(full_feed::Variant::Index(m)) => m.ltpc.as_ref(),
                _ => None,
            },
            Some(feed::Variant::FirstLevel(v)) => v.ltpc.as_ref(),
            _ => None,
        }
    }
}
#[derive(Clone, PartialEq, prost::Message)]
struct MarketInfo {
    #[prost(map = "string, int32", tag = "1")]
    segment_status: HashMap<String, i32>,
}
#[derive(Clone, PartialEq, prost::Message)]
struct FeedResponse {
    #[prost(int32, tag = "1")]
    frame_type: i32,
    #[prost(map = "string, message", tag = "2")]
    feeds: HashMap<String, Feed>,
    #[prost(int64, tag = "3")]
    current_ts: i64,
    #[prost(message, optional, tag = "4")]
    market_info: Option<MarketInfo>,
}

/// This describes an *externally verified* account. The operator must obtain
/// the listed instrument IDs from current Upstox BOD (not from user input).
#[derive(Clone, Debug)]
pub struct UpstoxV3Plan {
    pub scope: Scope,
    pub ce_key: String,
    pub pe_key: String,
    pub contract_expiry_ms: u64,
    pub rights_expire_ms: u64,
    pub session_approved: bool,
    pub instrument_mapping_verified: bool,
    pub market_data_display_approved: bool,
}
impl UpstoxV3Plan {
    pub fn validate(&self, now_ms: u64) -> io::Result<()> {
        let valid_key = |s: &str| {
            s.strip_prefix("NSE_FO|").is_some_and(|id|
                !id.is_empty() && id.len() <= 24
                    && id.bytes().all(|byte| byte.is_ascii_digit()))
        };
        if self.scope.tenant_id.is_empty()
            || self.scope.account_id.is_empty()
            || self.scope.entitlement_id.is_empty()
            || self.scope.source_id != "upstox_v3_direct"
            || !valid_key(&self.ce_key) || !valid_key(&self.pe_key)
            || self.ce_key == self.pe_key
            || self.contract_expiry_ms <= now_ms
            || self.rights_expire_ms <= now_ms
            || !self.session_approved
            || !self.instrument_mapping_verified
            || !self.market_data_display_approved
        { return Err(denied("unverified_v3_subscription_plan")); }
        Ok(())
    }
    /// To be transmitted as a WebSocket *binary* frame, NOT a text frame.
    pub fn binary_subscription(&self, guid: &str, now_ms: u64) -> io::Result<Vec<u8>> {
        self.validate(now_ms)?;
        if guid.is_empty() || guid.len() > 64 ||
            !guid.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') {
            return Err(denied("invalid_subscription_nonce"));
        }
        Ok(json!({"guid":guid,"method":"sub","data":{
            "mode":"ltpc","instrumentKeys":[self.ce_key,self.pe_key],
        }}).to_string().into_bytes())
    }
}

/// A current BOD-resolved NSE/BSE index (never from unauthenticated chart inputs).
#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct ApprovedIndexInstrument {
    pub exchange: String,
    pub symbol: String,
    pub instrument_key: String,
}

/// Read-only index plan, separate from CE/PE synthetic option subscriptions.
/// OAuth token presence alone must NEVER satisfy these operator gates.
#[derive(Clone, Debug)]
pub struct UpstoxIndexV3Plan {
    pub scope: Scope,
    pub instruments: Vec<ApprovedIndexInstrument>,
    pub rights_expire_ms: u64,
    pub session_approved: bool,
    pub instrument_mapping_verified: bool,
    pub market_data_display_approved: bool,
}
impl UpstoxIndexV3Plan {
    pub fn validate(&self, now_ms: u64) -> io::Result<()> {
        if self.scope.tenant_id.is_empty()
            || self.scope.account_id.is_empty()
            || self.scope.entitlement_id.is_empty()
            || self.scope.source_id != "upstox_v3_direct"
            || !self.session_approved
            || !self.instrument_mapping_verified
            || !self.market_data_display_approved
            || self.rights_expire_ms <= now_ms
            || self.instruments.is_empty()
            || self.instruments.len() > 6 {
            return Err(denied("unverified_index_v3_subscription_plan"));
        }
        let mut keys = std::collections::HashSet::new();
        let mut symbols = std::collections::HashSet::new();
        for index in &self.instruments {
            let allowed = match index.exchange.as_str() {
                "NSE_INDEX" => matches!(
                    index.symbol.as_str(),
                    "NIFTY" | "BANKNIFTY" | "FINNIFTY" | "MIDCPNIFTY" | "INDIAVIX"
                ),
                "BSE_INDEX" => index.symbol == "SENSEX",
                _ => false,
            };
            let prefix = format!("{}|", index.exchange);
            let key = index.instrument_key.strip_prefix(&prefix);
            if !allowed || !key.is_some_and(|name| {
                !name.is_empty()
                    && name.len() <= 100
                    && name.bytes().all(|b| b.is_ascii_alphanumeric()
                        || b == b' ' || b == b'_' || b == b'.' || b == b'-')
            }) || !keys.insert(&index.instrument_key)
                || !symbols.insert((&index.exchange, &index.symbol)) {
                return Err(denied("unverified_index_v3_instrument"));
            }
        }
        Ok(())
    }

    /// Upstox V3 requires JSON encoded into a WebSocket BINARY message.
    pub fn binary_subscription(&self, guid: &str, now_ms: u64) -> io::Result<Vec<u8>> {
        self.validate(now_ms)?;
        if guid.is_empty() || guid.len() > 64 ||
            !guid.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
            return Err(denied("invalid_index_subscription_nonce"));
        }
        let keys: Vec<&str> = self.instruments.iter()
            .map(|i| i.instrument_key.as_str()).collect();
        Ok(json!({"guid":guid,"method":"sub","data":{
            "mode":"ltpc","instrumentKeys":keys
        }}).to_string().into_bytes())
    }
}

/// Decoder yields private CandidateQuote records only; it cannot bypass
/// downstream account/entitlement checks in the Rust WAL and WSS gate.
pub struct UpstoxV3IndexDecoder {
    plan: UpstoxIndexV3Plan,
    open_segments: std::collections::HashSet<String>,
    last_trade_ms: HashMap<String, u64>,
}
impl UpstoxV3IndexDecoder {
    pub fn new(plan: UpstoxIndexV3Plan, now_ms: u64) -> io::Result<Self> {
        plan.validate(now_ms)?;
        Ok(Self { plan, open_segments: std::collections::HashSet::new(),
            last_trade_ms: HashMap::new() })
    }
    pub fn reconnect(&mut self) {
        self.open_segments.clear();
        // Keep the watermark: reconnect snapshots are not fresh index ticks.
    }
    pub fn decode(&mut self, binary: &[u8], received_ms: u64) -> io::Result<Vec<CandidateQuote>> {
        self.plan.validate(received_ms)?;
        if binary.is_empty() || binary.len() > MAX_FRAME {
            return Err(denied("invalid_index_v3_frame"));
        }
        let frame = FeedResponse::decode(binary).map_err(|_| denied("invalid_index_v3_protobuf"))?;
        if frame.current_ts <= 0 || frame.current_ts as u64 > received_ms.saturating_add(2_000) {
            return Err(denied("invalid_index_v3_provider_clock"));
        }
        match frame.frame_type {
            2 => {
                if !frame.feeds.is_empty() {
                    return Err(denied("invalid_index_v3_market_info"));
                }
                let market = frame.market_info.ok_or_else(|| denied("missing_index_market_info"))?;
                self.open_segments.clear();
                for instrument in &self.plan.instruments {
                    if market.segment_status.get(&instrument.exchange) == Some(&2) {
                        self.open_segments.insert(instrument.exchange.clone());
                    }
                }
                Ok(Vec::new())
            }
            0 | 1 => {
                if frame.feeds.len() > self.plan.instruments.len() {
                    return Err(denied("excessive_index_v3_instruments"));
                }
                let mut out = Vec::new();
                for (key, feed) in frame.feeds {
                    let instrument = self.plan.instruments.iter()
                        .find(|item| item.instrument_key == key)
                        .ok_or_else(|| denied("unapproved_index_v3_key"))?;
                    if !self.open_segments.contains(&instrument.exchange) {
                        return Err(denied("index_market_not_verified_open"));
                    }
                    let last = feed.last_trade()
                        .ok_or_else(|| denied("missing_index_v3_ltpc"))?;
                    let trade_ms = u64::try_from(last.ltt)
                        .map_err(|_| denied("invalid_index_v3_ltt"))?;
                    if trade_ms == 0 || trade_ms > received_ms.saturating_add(2_000)
                        || trade_ms > (frame.current_ts as u64).saturating_add(2_000)
                        || !last.ltp.is_finite() || last.ltp <= 0.0 {
                        return Err(denied("invalid_index_v3_exchange_tick"));
                    }
                    if received_ms.saturating_sub(trade_ms) > MAX_QUOTE_DELAY_MS
                        || self.last_trade_ms.get(&key).is_some_and(|prior| trade_ms <= *prior) {
                        continue;
                    }
                    self.last_trade_ms.insert(key.clone(), trade_ms);
                    out.push(CandidateQuote {
                        scope: self.plan.scope.clone(),
                        instrument_id: key,
                        exchange_timestamp_ms: trade_ms,
                        received_timestamp_ms: received_ms,
                        price: last.ltp,
                        stale: false,
                        entitlement_verified: false,
                        publishable_to_public_studio: false,
                    });
                }
                Ok(out)
            }
            _ => Err(denied("unsupported_index_v3_frame_type")),
        }
    }
}

/// Validates a one-use authorized redirect given by Upstox, rather than ever
/// forwarding bearer headers/credentials to a user-controlled WebSocket host.
pub fn validate_one_use_redirect(raw: &str) -> io::Result<()> {
    if raw.len() > 2048 || !raw.is_ascii() || raw.bytes().any(|b| b <= 32 || b == 127) {
        return Err(denied("invalid_authorized_v3_redirect"));
    }
    let uri: tokio_tungstenite::tungstenite::http::Uri = raw
        .parse().map_err(|_| denied("invalid_authorized_v3_redirect"))?;
    let host = uri.host().ok_or_else(|| denied("invalid_authorized_v3_redirect"))?;
    if uri.scheme_str() != Some("wss")
        || !(host == "upstox.com" || host.ends_with(".upstox.com"))
        || uri.port_u16().is_some()
        || !uri.path().starts_with("/market-data-feeder/v3/")
        || !uri.query().is_some_and(|q| q.contains("code=") && q.contains("requestId="))
        || uri.authority().is_some_and(|a| a.as_str().contains('@')) {
        return Err(denied("invalid_authorized_v3_redirect"));
    }
    Ok(())
}

/// Account-dedicated, session-scoped decoder. Requires a new MARKET_INFO after
/// reconnect. Previous timestamps remain watermarked across reconnections.
pub struct UpstoxV3Decoder {
    plan: UpstoxV3Plan,
    fo_market_open: bool,
    last_trade_ms: HashMap<String, u64>,
}
impl UpstoxV3Decoder {
    pub fn new(plan: UpstoxV3Plan, now_ms: u64) -> io::Result<Self> {
        plan.validate(now_ms)?;
        Ok(Self { plan, fo_market_open: false, last_trade_ms: HashMap::new() })
    }
    pub fn reconnect(&mut self) { self.fo_market_open = false; }
    pub fn decode(&mut self, binary: &[u8], received_ms: u64) -> io::Result<Vec<CandidateQuote>> {
        self.plan.validate(received_ms)?;
        if binary.is_empty() || binary.len() > MAX_FRAME {
            return Err(denied("invalid_v3_binary_frame_length"));
        }
        let frame = FeedResponse::decode(binary).map_err(|_| denied("invalid_v3_protobuf"))?;
        if frame.current_ts <= 0 || frame.current_ts as u64 > received_ms.saturating_add(2_000) {
            return Err(denied("v3_feed_clock_invalid"));
        }
        match frame.frame_type {
            2 => {
                if !frame.feeds.is_empty() {
                    return Err(denied("invalid_market_info_frame"));
                }
                let info = frame.market_info.ok_or_else(|| denied("missing_v3_market_status"))?;
                // MarketStatus NORMAL_OPEN=2; other statuses stop market subscriptions.
                self.fo_market_open = info.segment_status.get("NSE_FO") == Some(&2);
                Ok(Vec::new())
            }
            0 | 1 => {
                if !self.fo_market_open || frame.feeds.len() > 8
                    || frame.current_ts as u64 > received_ms.saturating_add(2_000) {
                    return Err(denied("v3_market_not_open_or_excessive_keys"));
                }
                let mut output = Vec::new();
                for (key, feed) in frame.feeds {
                    if key != self.plan.ce_key && key != self.plan.pe_key {
                        return Err(denied("v3_unsubscribed_instrument"));
                    }
                    let last = feed.last_trade().ok_or_else(|| denied("missing_v3_ltpc"))?;
                    let time = u64::try_from(last.ltt).map_err(|_| denied("invalid_v3_ltt"))?;
                    if time == 0 || time > received_ms.saturating_add(2_000)
                        || time > (frame.current_ts as u64).saturating_add(2_000)
                        || !last.ltp.is_finite() || last.ltp <= 0.0 {
                        return Err(denied("invalid_v3_exchange_timestamp_or_ltp"));
                    }
                    // V3 snapshots can contain older last trades; never publish
                    // such records as a fresh real-time chart/collector event.
                    if received_ms.saturating_sub(time) > MAX_QUOTE_DELAY_MS
                        || self.last_trade_ms.get(&key).is_some_and(|prev| time <= *prev) {
                        continue;
                    }
                    self.last_trade_ms.insert(key.clone(), time);
                    output.push(CandidateQuote {
                        scope: self.plan.scope.clone(),
                        instrument_id: key,
                        exchange_timestamp_ms: time,
                        received_timestamp_ms: received_ms,
                        price: last.ltp,
                        stale: false,
                        entitlement_verified: false,
                        publishable_to_public_studio: false,
                    });
                }
                Ok(output)
            }
            _ => Err(denied("unknown_v3_feed_frame_type")),
        }
    }
}

#[derive(Debug, serde::Serialize)]
pub struct V3SessionReport {
    pub schema: &'static str,
    pub source: &'static str,
    pub quote_candidates: u64,
    pub persisted_quotes: u64,
    pub frames: u64,
    pub broker_credentials_present: bool,
    pub public_stream_enabled: bool,
    pub execution_enabled: bool,
}

/// One bounded private read-only session. Caller independently fetches a
/// **fresh** one-use URL from the official authorized API for each connection.
/// It must create a scoped approved WAL sink; this function does not grant
/// any retention rights. Disconnect does not silently reconnect/reuse URL.
pub async fn observe_one_use_session(
    redirect: &str,
    decoder: &mut UpstoxV3Decoder,
    ingest: &mut crate::authorized_ingest::PrivatePersistentIngest,
    guid: &str,
    limit_seconds: u64,
) -> io::Result<V3SessionReport> {
    observe_one_use_session_with_sink(redirect, decoder, ingest, guid, limit_seconds, None).await
}

/// Optional operator-private Unix datagram fanout. Only forward AFTER the
/// private durable WAL acknowledges and CURRENT rights are re-read.
pub async fn observe_one_use_session_with_sink(
    redirect: &str,
    decoder: &mut UpstoxV3Decoder,
    ingest: &mut crate::authorized_ingest::PrivatePersistentIngest,
    guid: &str,
    limit_seconds: u64,
    sink: Option<(&std::path::Path, &std::path::Path)>,
) -> io::Result<V3SessionReport> {
    if !(1..=MAX_SESSION_SECONDS).contains(&limit_seconds) {
        return Err(denied("observation_duration_unbounded"));
    }
    validate_one_use_redirect(redirect)?;
    let binary = decoder.plan.binary_subscription(guid, epoch_ms()?)?;
    decoder.reconnect();
    let (mut socket, _) = timeout(Duration::from_secs(5), connect_async(redirect))
        .await.map_err(|_| denied("v3_connect_timeout"))?
        .map_err(|_| denied("v3_connect_failed"))?;
    socket.send(Message::Binary(binary.into())).await
        .map_err(|_| denied("v3_binary_subscription_failed"))?;
    let deadline = Instant::now() + Duration::from_secs(limit_seconds);
    let mut report = V3SessionReport {
        schema: "QSYN-UPSTOX-V3-PRIVATE-SESSION/1", source: "upstox_v3_binary",
        quote_candidates: 0, persisted_quotes: 0, frames: 0,
        broker_credentials_present: false, public_stream_enabled: false,
        execution_enabled: false,
    };
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() { break; }
        let received = timeout(remaining.min(Duration::from_secs(10)), socket.next()).await;
        let packet = match received {
            Ok(Some(Ok(v))) => v,
            Ok(None) => break,
            _ => return Err(denied("v3_feed_disconnected_or_timed_out")),
        };
        match packet {
            Message::Binary(bytes) => {
                let now = epoch_ms()?;
                let quotes = decoder.decode(&bytes, now)?;
                report.frames += 1;
                for quote in quotes {
                    report.quote_candidates += 1;
                    let prior_stored = ingest.stored;
                    // Durable WAL checks persistence rights AGAIN; then fsyncs.
                    // Fail closed when rights expire, owner/account mismatch,
                    // or legal display permission is revoked mid-session.
                    if let Some((rights_path, socket_path)) = sink {
                        let rights = crate::private_chart_ws::load_rights(rights_path)?;
                        if rights.tenant != quote.scope.tenant_id
                            || rights.account != quote.scope.account_id
                            || rights.broker != "upstox"
                            || rights.license_id != quote.scope.entitlement_id
                            || !rights.broker_session_verified
                            || !rights.can_display_to_this_user
                            || rights.valid_until_ms <= now
                            || !rights.instruments.contains(&quote.instrument_id) {
                            return Err(denied("v3_current_chart_rights_revoked"));
                        }
                        ingest.ingest(&quote, now)?;
                        // Restarted streams replay snapshots. WAL de-dupes,
                        // and old quotes must NOT be sent to client charts.
                        if ingest.stored == prior_stored { continue; }
                        let packet = serde_json::to_vec(&quote)?;
                        if packet.len() > 4095 { return Err(denied("v3_private_packet_oversize")); }
                        let unix = tokio::net::UnixDatagram::unbound()?;
                        unix.send_to(&packet, socket_path).await
                            .map_err(|_| denied("v3_private_chart_sink_unavailable"))?;
                    } else {
                        ingest.ingest(&quote, now)?;
                        if ingest.stored == prior_stored { continue; }
                    }
                    report.persisted_quotes += 1;
                }
            }
            Message::Ping(data) => socket.send(Message::Pong(data)).await
                .map_err(|_| denied("v3_ping_failure"))?,
            Message::Pong(_) => {}
            Message::Close(_) => break,
            // Live V3 data must NEVER be interpreted as text/JSON messages.
            Message::Text(_) => return Err(denied("v3_text_feed_not_allowed")),
            _ => {}
        }
    }
    let _ = socket.close(None).await;
    Ok(report)
}

/// Read-only, bounded native Upstox NSE/BSE index receiver. A fresh one-use
/// upstream WSS URL, approved current instrument mapping, persistence rights
/// and private chart grants must already exist. Never starts automatically.
pub async fn observe_one_use_index_session_with_sink(
    redirect: &str,
    decoder: &mut UpstoxV3IndexDecoder,
    ingest: &mut crate::authorized_ingest::PrivatePersistentIngest,
    guid: &str,
    limit_seconds: u64,
    sink: Option<(&std::path::Path, &std::path::Path)>,
) -> io::Result<V3SessionReport> {
    if !(1..=MAX_SESSION_SECONDS).contains(&limit_seconds) {
        return Err(denied("observation_duration_unbounded"));
    }
    validate_one_use_redirect(redirect)?;
    let binary = decoder.plan.binary_subscription(guid, epoch_ms()?)?;
    decoder.reconnect();
    let (mut socket, _) = timeout(Duration::from_secs(5), connect_async(redirect))
        .await.map_err(|_| denied("v3_connect_timeout"))?
        .map_err(|_| denied("v3_connect_failed"))?;
    socket.send(Message::Binary(binary.into())).await
        .map_err(|_| denied("v3_binary_subscription_failed"))?;
    let deadline = Instant::now() + Duration::from_secs(limit_seconds);
    let mut report = V3SessionReport {
        schema: "QSYN-UPSTOX-V3-PRIVATE-INDEX-SESSION/1", source: "upstox_v3_binary",
        quote_candidates: 0, persisted_quotes: 0, frames: 0,
        broker_credentials_present: false, public_stream_enabled: false,
        execution_enabled: false,
    };
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() { break; }
        let received = timeout(remaining.min(Duration::from_secs(10)), socket.next()).await;
        let packet = match received {
            Ok(Some(Ok(v))) => v,
            Ok(None) => break,
            _ => return Err(denied("v3_feed_disconnected_or_timed_out")),
        };
        match packet {
            Message::Binary(bytes) => {
                let now = epoch_ms()?;
                let quotes = decoder.decode(&bytes, now)?;
                report.frames += 1;
                for quote in quotes {
                    report.quote_candidates += 1;
                    let prior_stored = ingest.stored;
                    // Durable WAL checks persistence rights AGAIN; then fsyncs.
                    // Fail closed when rights expire, owner/account mismatch,
                    // or legal display permission is revoked mid-session.
                    if let Some((rights_path, socket_path)) = sink {
                        let rights = crate::private_chart_ws::load_rights(rights_path)?;
                        if rights.tenant != quote.scope.tenant_id
                            || rights.account != quote.scope.account_id
                            || rights.broker != "upstox"
                            || rights.license_id != quote.scope.entitlement_id
                            || !rights.broker_session_verified
                            || !rights.can_display_to_this_user
                            || rights.valid_until_ms <= now
                            || !rights.instruments.contains(&quote.instrument_id) {
                            return Err(denied("v3_current_chart_rights_revoked"));
                        }
                        ingest.ingest(&quote, now)?;
                        // Restarted streams replay snapshots. WAL de-dupes,
                        // and old quotes must NOT be sent to client charts.
                        if ingest.stored == prior_stored { continue; }
                        let packet = serde_json::to_vec(&quote)?;
                        if packet.len() > 4095 { return Err(denied("v3_private_packet_oversize")); }
                        let unix = tokio::net::UnixDatagram::unbound()?;
                        unix.send_to(&packet, socket_path).await
                            .map_err(|_| denied("v3_private_chart_sink_unavailable"))?;
                    } else {
                        ingest.ingest(&quote, now)?;
                        if ingest.stored == prior_stored { continue; }
                    }
                    report.persisted_quotes += 1;
                }
            }
            Message::Ping(data) => socket.send(Message::Pong(data)).await
                .map_err(|_| denied("v3_ping_failure"))?,
            Message::Pong(_) => {}
            Message::Close(_) => break,
            // Live V3 data must NEVER be interpreted as text/JSON messages.
            Message::Text(_) => return Err(denied("v3_text_feed_not_allowed")),
            _ => {}
        }
    }
    let _ = socket.close(None).await;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use crate::authorized_ingest::{PrivateIngestApproval, PrivatePersistentIngest};
    use crate::durable_market_wal;
    use crate::market_pipeline::DataMode;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    fn plan() -> UpstoxV3Plan {
        UpstoxV3Plan {
            scope: Scope {
                tenant_id: "tenant-A".into(), account_id: "upstox-A".into(),
                source_id: "upstox_v3_direct".into(), entitlement_id: "license-A".into(),
            },
            ce_key: "NSE_FO|12345".into(),
            pe_key: "NSE_FO|12346".into(),
            contract_expiry_ms: 500_000,
            rights_expire_ms: 500_000,
            session_approved: true, instrument_mapping_verified: true,
            market_data_display_approved: true,
        }
    }
    fn status(now: i64, open: bool) -> Vec<u8> {
        FeedResponse {
            frame_type: 2, feeds: HashMap::new(), current_ts: now,
            market_info: Some(MarketInfo {
                segment_status: HashMap::from([("NSE_FO".into(), if open {2} else {3})]),
            }),
        }.encode_to_vec()
    }
    fn quote(now: i64, key: &str, trade_ms: i64, price: f64, kind: u8) -> Vec<u8> {
        let ltpc = Ltpc { ltp: price, ltt: trade_ms, ltq: 1, cp: 90.0 };
        let variant = match kind {
            0 => feed::Variant::Ltpc(ltpc),
            1 => feed::Variant::Full(FullFeed {
                variant: Some(full_feed::Variant::Market(MarketFullFeed { ltpc: Some(ltpc) })),
            }),
            _ => feed::Variant::FirstLevel(FirstLevelWithGreeks { ltpc: Some(ltpc) }),
        };
        FeedResponse {
            frame_type: 1, feeds: HashMap::from([(key.to_string(),
                Feed { variant: Some(variant), request_mode: 0 })]),
            current_ts: now, market_info: None,
        }.encode_to_vec()
    }
    fn index_plan() -> UpstoxIndexV3Plan {
        UpstoxIndexV3Plan {
            scope: Scope {
                tenant_id:"tenant-A".into(), account_id:"upstox-A".into(),
                source_id:"upstox_v3_direct".into(), entitlement_id:"license-A".into(),
            },
            instruments:vec![
                ApprovedIndexInstrument {
                    exchange:"NSE_INDEX".into(),symbol:"NIFTY".into(),
                    instrument_key:"NSE_INDEX|Nifty 50".into(),
                },
                ApprovedIndexInstrument {
                    exchange:"BSE_INDEX".into(),symbol:"SENSEX".into(),
                    instrument_key:"BSE_INDEX|SENSEX".into(),
                },
            ],
            rights_expire_ms:500_000,
            session_approved:true, instrument_mapping_verified:true,
            market_data_display_approved:true,
        }
    }
    #[test]
    fn native_index_plan_requires_bod_session_and_display_rights() {
        let plan=index_plan();
        let sub=plan.binary_subscription("idx-123",100_000).unwrap();
        let json:Value=serde_json::from_slice(&sub).unwrap();
        assert_eq!(json["method"],"sub");
        assert_eq!(json["data"]["mode"],"ltpc");
        assert_eq!(json["data"]["instrumentKeys"][0],"NSE_INDEX|Nifty 50");
        assert_eq!(json["data"]["instrumentKeys"][1],"BSE_INDEX|SENSEX");

        let mut p=plan.clone();p.market_data_display_approved=false;
        assert!(p.binary_subscription("idx-123",100_000).is_err());
        let mut p=plan.clone();p.session_approved=false;
        assert!(p.validate(100_000).is_err());
        let mut p=plan.clone();p.instrument_mapping_verified=false;
        assert!(p.validate(100_000).is_err());
        let mut p=plan.clone();p.rights_expire_ms=100_000;
        assert!(p.validate(100_000).is_err());
        let mut p=plan.clone();p.instruments[0].instrument_key="NSE_FO|123".into();
        assert!(p.validate(100_000).is_err());
        let mut p=plan.clone();p.instruments[1].exchange="NSE_INDEX".into();
        assert!(p.validate(100_000).is_err());
        let mut p=plan.clone();p.instruments.push(p.instruments[0].clone());
        assert!(p.validate(100_000).is_err());
    }
    #[test]
    fn private_index_protobuf_ltt_and_reconnect_watermark() {
        let mut dec=UpstoxV3IndexDecoder::new(index_plan(),100_000).unwrap();
        let tick = |when:i64, lt_time:i64, key:&str, price:f64| {
            FeedResponse {
                frame_type:1, current_ts:when,market_info:None,
                feeds:HashMap::from([(key.to_string(),Feed {
                    variant:Some(feed::Variant::Full(FullFeed {
                        variant:Some(full_feed::Variant::Index(IndexFullFeed {
                            ltpc:Some(Ltpc{ltp:price,ltt:lt_time,ltq:0,cp:90.0})
                        }))
                    })),
                    request_mode:0,
                })]),
            }.encode_to_vec()
        };
        let info=FeedResponse {
            frame_type:2,current_ts:100_000,feeds:HashMap::new(),
            market_info:Some(MarketInfo {
                segment_status:HashMap::from([
                    ("NSE_INDEX".into(),2),("BSE_INDEX".into(),3)
                ]),
            }),
        }.encode_to_vec();
        assert!(dec.decode(&tick(100_000,99_999,"NSE_INDEX|Nifty 50",105.0),100_020).is_err());
        assert!(dec.decode(&info,100_000).unwrap().is_empty());
        let rows=dec.decode(&tick(100_100,100_090,"NSE_INDEX|Nifty 50",105.0),100_110).unwrap();
        assert_eq!(rows.len(),1);
        assert_eq!(rows[0].exchange_timestamp_ms,100_090);
        assert!(!rows[0].entitlement_verified && !rows[0].publishable_to_public_studio);
        assert!(dec.decode(&tick(100_120,100_090,"NSE_INDEX|Nifty 50",106.0),100_130)
            .unwrap().is_empty());
        assert!(dec.decode(&tick(100_130,100_120,"BSE_INDEX|SENSEX",89000.0),100_140).is_err());
        dec.reconnect();
        assert!(dec.decode(&tick(100_190,100_180,"NSE_INDEX|Nifty 50",106.0),100_200).is_err());
        dec.decode(&info,100_201).unwrap();
        assert!(dec.decode(&tick(100_250,100_090,"NSE_INDEX|Nifty 50",106.0),100_260)
            .unwrap().is_empty());
        assert!(dec.decode(&tick(100_300,100_280,"NSE_INDEX|Nifty 50",-1.0),100_310).is_err());
        assert!(dec.decode(&tick(100_320,0,"NSE_INDEX|Nifty 50",106.0),100_330).is_err());
        assert!(dec.decode(&tick(100_340,100_330,"NSE_FO|123",106.0),100_350).is_err());
    }

    #[test]
    fn official_v3_protobuf_tags_binary_subscribe_and_market_gate() {
        let p = plan();
        let request = p.binary_subscription("test-abc", 100_000).unwrap();
        let encoded: Value = serde_json::from_slice(&request).unwrap();
        assert_eq!(encoded["method"], "sub");
        assert_eq!(encoded["data"]["mode"], "ltpc");
        assert_eq!(encoded["data"]["instrumentKeys"][0], p.ce_key);
        let mut decoder = UpstoxV3Decoder::new(p, 100_000).unwrap();
        assert!(decoder.decode(&quote(100_020,"NSE_FO|12345",100_010,101.5,0),100_030).is_err());
        assert!(decoder.decode(&status(100_000,true),100_000).unwrap().is_empty());
        let rows=decoder.decode(&quote(100_030,"NSE_FO|12345",100_010,101.5,0),100_040).unwrap();
        assert_eq!(rows.len(),1);
        assert_eq!(rows[0].exchange_timestamp_ms,100_010);
        assert!(!rows[0].entitlement_verified && !rows[0].publishable_to_public_studio);
        assert!(decoder.decode(&quote(100_050,"NSE_FO|12345",100_010,101.5,0),100_055).unwrap().is_empty());
        for n in 1..=2 {
            assert_eq!(decoder.decode(&quote(100_100+n as i64,"NSE_FO|12346",
                100_100+n as i64,120.5, n),100_110+n as u64).unwrap().len(),1);
        }
        decoder.reconnect();
        assert!(decoder.decode(&quote(100_300,"NSE_FO|12345",100_200,105.0,0),100_310).is_err());
        decoder.decode(&status(100_400,false),100_400).unwrap();
        assert!(decoder.decode(&quote(100_410,"NSE_FO|12345",100_200,105.0,0),100_420).is_err());
    }
    #[test]
    fn rejects_stale_foreign_future_bad_prices_and_unverified_scope() {
        let mut decoder=UpstoxV3Decoder::new(plan(),100_000).unwrap();
        decoder.decode(&status(100_000,true),100_000).unwrap();
        assert!(decoder.decode(&quote(100_010,"NSE_FO|99999",100_005,50.0,0),100_020).is_err());
        assert!(decoder.decode(&quote(100_010,"NSE_FO|12345",100_005,-1.0,0),100_020).is_err());
        assert!(decoder.decode(&quote(100_010,"NSE_FO|12345",103_500,10.0,0),100_020).is_err());
        assert!(decoder.decode(&quote(100_010,"NSE_FO|12345",80_000,10.0,0),100_020).unwrap().is_empty());
        assert!(decoder.decode(&[0xff,0xff],100_020).is_err());
        assert!(decoder.decode(&vec![0;65537],100_020).is_err());
        let mut p=plan(); p.session_approved=false;
        assert!(UpstoxV3Decoder::new(p,100_000).is_err());
        let mut p=plan(); p.ce_key="NFO|FAKE_CE".into();
        assert!(UpstoxV3Decoder::new(p,100_000).is_err());
        assert!(validate_one_use_redirect("wss://evil.example/market-data-feeder/v3/x?code=a&requestId=b").is_err());
        assert!(validate_one_use_redirect("ws://ok.upstox.com/market-data-feeder/v3/x?code=a&requestId=b").is_err());
        assert!(validate_one_use_redirect("wss://ok.upstox.com.evil.com/market-data-feeder/v3/x?code=a&requestId=b").is_err());
        assert!(validate_one_use_redirect("wss://ok.upstox.com/market-data-feeder/v3/x?code=a&requestId=b").is_ok());
    }
    #[test]
    fn accepted_binary_ce_pe_stays_in_approved_durable_scoped_wal_and_survives_restart() {
        let root=std::env::temp_dir().join(format!("qsyn-v3-{}-{}",
            std::process::id(),std::thread::current().name().unwrap_or("test")));
        let _=fs::remove_dir_all(&root);
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root,fs::Permissions::from_mode(0o700)).unwrap();
        let p=plan();
        let approval=PrivateIngestApproval {
            scope:p.scope.clone(),
            approved_instruments:vec![p.ce_key.clone(),p.pe_key.clone()],
            licensed_persistence:true,broker_session_verified:true,
            expires_ms:500_000,max_delay_ms:5_000,
        };
        let mut decoder=UpstoxV3Decoder::new(p.clone(),100_000).unwrap();
        let mut wal=PrivatePersistentIngest::open(&root,approval.clone(),100_000).unwrap();
        decoder.decode(&status(100_000,true),100_000).unwrap();
        for key in [&p.ce_key,&p.pe_key] {
            for quote in decoder.decode(&quote(100_100,key,100_050,150.0,0),100_120).unwrap() {
                wal.ingest(&quote,100_120).unwrap();
            }
        }
        assert_eq!(wal.stored,2);
        drop(wal);
        let audit=durable_market_wal::audit(&root).unwrap();
        assert_eq!(audit.records,2);
        let mut restart=PrivatePersistentIngest::open(&root,approval,100_200).unwrap();
        let mut new_decoder=UpstoxV3Decoder::new(p.clone(),100_200).unwrap();
        new_decoder.decode(&status(100_200,true),100_200).unwrap();
        let row=new_decoder.decode(&quote(100_210,&p.ce_key,100_050,150.0,0),100_230).unwrap();
        assert_eq!(row.len(),1);
        assert_eq!(restart.ingest(&row[0],100_230).unwrap(),2);
        assert_eq!(restart.stored,0);
        let mut disallowed=row[0].clone();
        disallowed.scope.account_id="upstox-B".into();
        assert!(restart.ingest(&disallowed,100_230).is_err());
        drop(restart);
        assert_eq!(durable_market_wal::audit(&root).unwrap().records,2);
        let scoped=durable_market_wal::query(&root,&p.scope,&DataMode::AuthorizedLive,
            &p.pe_key,0,200_000,10).unwrap();
        assert_eq!(scoped.len(),1);
        fs::remove_dir_all(root).unwrap();
    }
}
