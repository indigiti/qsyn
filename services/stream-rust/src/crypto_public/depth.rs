//! Bounded, opt-in, read-only public level-2 snapshot foundation.
//! Binance BTC/ETH USDT spot and USD-M perpetuals only. This is NOT a
//! diff-depth stream: no historical depth, trades, heatmap or orders are implied.
//! A book is returned only after strict validation of a fresh REST snapshot.
use super::{epoch_ms, number};
use axum::{
    extract::Query,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

const LEVELS_PER_SNAPSHOT: usize = 100;
const CACHE_TTL: Duration = Duration::from_secs(2);
const MAX_JSON_BYTES: usize = 65_536;

#[derive(Debug, Deserialize)]
pub(super) struct DepthRequest {
    exchange: String,
    market: String,
    symbol: String,
    limit: Option<usize>,
}

#[derive(Clone, Debug)]
struct Level {
    price: f64,
    size: f64,
    notional_usdt: f64,
}

#[derive(Clone, Debug)]
struct Snapshot {
    sequence: u64,
    bids: Vec<Level>,
    asks: Vec<Level>,
    received_at_ms: u64,
    received_at: Instant,
}

type SnapshotSlot = Arc<Mutex<Option<Snapshot>>>;
fn slots() -> &'static Mutex<HashMap<String, SnapshotSlot>> {
    static SLOTS: OnceLock<Mutex<HashMap<String, SnapshotSlot>>> = OnceLock::new();
    SLOTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn enabled() -> bool {
    std::env::var("QSYN_CRYPTO_DEPTH_ENABLED").ok().as_deref() == Some("1")
}

fn valid(req: &DepthRequest) -> bool {
    req.exchange == "BINANCE"
        && matches!(req.market.as_str(), "spot" | "perp")
        && matches!(req.symbol.as_str(), "BTCUSDT" | "ETHUSDT")
        && (5..=LEVELS_PER_SNAPSHOT).contains(&req.limit.unwrap_or(20))
}

fn endpoint(market: &str) -> &'static str {
    match market {
        "perp" => "https://fapi.binance.com/fapi/v1/depth",
        _ => "https://api.binance.com/api/v3/depth",
    }
}

fn parse_levels(value: &Value, bids: bool) -> Result<Vec<Level>, ()> {
    let rows = value.as_array().ok_or(())?;
    if rows.is_empty() || rows.len() > LEVELS_PER_SNAPSHOT {
        return Err(());
    }
    let mut levels = Vec::with_capacity(rows.len());
    let mut previous = if bids { f64::INFINITY } else { 0.0 };
    for row in rows {
        let cols = row.as_array().filter(|v| v.len() == 2).ok_or(())?;
        let price = number(&cols[0]).filter(|p| *p > 0.0).ok_or(())?;
        let size = number(&cols[1]).filter(|q| *q > 0.0).ok_or(())?;
        let notional_usdt = price * size;
        if !notional_usdt.is_finite() || (bids && price >= previous) || (!bids && price <= previous)
        {
            return Err(());
        }
        levels.push(Level {
            price,
            size,
            notional_usdt,
        });
        previous = price;
    }
    Ok(levels)
}

fn parse_snapshot(value: &Value, received_at_ms: u64) -> Result<Snapshot, ()> {
    let sequence = value["lastUpdateId"]
        .as_u64()
        .filter(|x| *x > 0)
        .ok_or(())?;
    let bids = parse_levels(&value["bids"], true)?;
    let asks = parse_levels(&value["asks"], false)?;
    if bids[0].price >= asks[0].price {
        return Err(()); // crossed or locked book is not a verified snapshot
    }
    Ok(Snapshot {
        sequence,
        bids,
        asks,
        received_at_ms,
        received_at: Instant::now(),
    })
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(4))
            .user_agent("QSYN-read-only-depth/1")
            .build()
            .expect("static TLS client configuration")
    })
}

async fn fetch_snapshot(req: &DepthRequest) -> Result<Snapshot, ()> {
    let response = client()
        .get(endpoint(&req.market))
        .query(&[("symbol", req.symbol.as_str()), ("limit", "100")])
        .send()
        .await
        .map_err(|_| ())?;
    if !response.status().is_success() {
        return Err(());
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_JSON_BYTES as u64)
    {
        return Err(());
    }
    let body = response.bytes().await.map_err(|_| ())?;
    if body.len() > MAX_JSON_BYTES {
        return Err(());
    }
    let json: Value = serde_json::from_slice(&body).map_err(|_| ())?;
    parse_snapshot(&json, epoch_ms())
}

async fn latest(req: &DepthRequest) -> Result<Snapshot, ()> {
    let key = format!("{}:{}", req.market, req.symbol);
    let slot = {
        let mut guard = slots().lock().await;
        guard
            .entry(key)
            .or_insert_with(|| Arc::new(Mutex::new(None)))
            .clone()
    };
    // Per-instrument mutex coalesces concurrent requests; bounded to 4
    // allowlisted instruments. Never serve a stale snapshot if REST fails.
    let mut state = slot.lock().await;
    if let Some(snapshot) = state.as_ref() {
        if snapshot.received_at.elapsed() < CACHE_TTL {
            return Ok(snapshot.clone());
        }
    }
    let fresh = fetch_snapshot(req).await?;
    *state = Some(fresh.clone());
    Ok(fresh)
}

pub(super) async fn depth(Query(req): Query<DepthRequest>) -> Response {
    if !valid(&req) {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({"error":"unsupported_crypto_depth_instrument"})),
        )
            .into_response();
    }
    if !enabled() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error":"crypto_depth_disabled"})),
        )
            .into_response();
    }
    let snapshot = match latest(&req).await {
        Ok(snapshot) => snapshot,
        Err(_) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({"error":"exchange_depth_unavailable"})),
            )
                .into_response()
        }
    };
    let limit = req.limit.unwrap_or(20);
    let format_levels = |levels: &[Level]| -> Vec<Value> {
        levels
            .iter()
            .take(limit)
            .map(|v| {
                json!({
                    "price":v.price,"size":v.size,"notional_usdt":v.notional_usdt
                })
            })
            .collect()
    };
    (
        StatusCode::OK,
        Json(json!({
            "schema":"QSYN-PUBLIC-CRYPTO-DEPTH/1",
            "source":"exchange_public",
            "exchange":req.exchange,
            "market":req.market,
            "symbol":req.symbol,
            "feed_transport":"rest_snapshot",
            "last_update_id":snapshot.sequence,
            "received_at_ms":snapshot.received_at_ms,
            "age_ms":snapshot.received_at.elapsed().as_millis() as u64,
            "depth":{
                "bids":format_levels(&snapshot.bids),
                "asks":format_levels(&snapshot.asks)
            },
            "quote_asset":"USDT",
            "historical_depth_available":false,
            "incremental_stream_active":false,
            "trading_enabled":false
        })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(market: &str, symbol: &str, limit: Option<usize>) -> DepthRequest {
        DepthRequest {
            exchange: "BINANCE".into(),
            market: market.into(),
            symbol: symbol.into(),
            limit,
        }
    }
    fn book() -> Value {
        json!({"lastUpdateId":42,"bids":[["100.0","1.5"],["99.0","2"]],
            "asks":[["101.0","2"],["102.0","1"]]})
    }
    #[test]
    fn allowlist_and_limit_are_explicit() {
        assert!(valid(&request("spot", "BTCUSDT", Some(20))));
        assert!(valid(&request("perp", "ETHUSDT", None)));
        assert!(!valid(&request("spot", "SOLUSDT", None)));
        assert!(!valid(&request("swap", "BTCUSDT", None)));
        assert!(!valid(&request("spot", "BTCUSDT", Some(101))));
        assert!(!valid(&request("spot", "BTCUSDT", Some(0))));
        assert_eq!(endpoint("perp"), "https://fapi.binance.com/fapi/v1/depth");
    }
    #[test]
    fn validates_complete_sorted_non_crossed_snapshot() {
        let snapshot = parse_snapshot(&book(), epoch_ms()).unwrap();
        assert_eq!(snapshot.sequence, 42);
        assert_eq!(snapshot.bids[0].notional_usdt, 150.0);
        assert_eq!(snapshot.asks[0].notional_usdt, 202.0);
        let mut crossed = book();
        crossed["asks"][0][0] = json!("100");
        assert!(parse_snapshot(&crossed, epoch_ms()).is_err());
        let mut unsorted = book();
        unsorted["bids"][1][0] = json!("100");
        assert!(parse_snapshot(&unsorted, epoch_ms()).is_err());
        let mut zero = book();
        zero["asks"][1][1] = json!("0");
        assert!(parse_snapshot(&zero, epoch_ms()).is_err());
        let mut bad = book();
        bad["bids"][0][0] = json!("NaN");
        assert!(parse_snapshot(&bad, epoch_ms()).is_err());
        let mut no_seq = book();
        no_seq["lastUpdateId"] = json!(0);
        assert!(parse_snapshot(&no_seq, epoch_ms()).is_err());
    }
    #[test]
    fn rejects_empty_and_oversized_books() {
        let mut empty = book();
        empty["bids"] = json!([]);
        assert!(parse_snapshot(&empty, epoch_ms()).is_err());
        let mut oversized = book();
        oversized["asks"] = Value::Array(
            (0..101)
                .map(|i| json!([(101 + i).to_string(), "1"]))
                .collect(),
        );
        assert!(parse_snapshot(&oversized, epoch_ms()).is_err());
    }
}
