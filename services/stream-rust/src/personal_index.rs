//! Personal read-only Upstox index data, in the existing qsyn-stream ELF.
//! The 1-year Analytics Token is read ONLY from QSYN's existing 0600 file.
//! No OAuth session, worker plan, trading endpoint, or public price route.
use crate::private_chart_ws::private_bytes;
use crate::upstox_index_history::{decode_index_day, index_history_url};
use crate::upstox_v3::validate_one_use_redirect;
use chrono::{DateTime, FixedOffset, NaiveDate, Utc};
use futures_util::{SinkExt, StreamExt};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;
use std::{
    collections::HashMap,
    io,
    path::Path,
    sync::{Mutex, OnceLock},
};
use tokio::time::{timeout, Duration, Instant};
use tokio_tungstenite::{connect_async, tungstenite::Message};

const AUTH_URL: &str = "https://api.upstox.com/v3/feed/market-data-feed/authorize";
const MAX_FRAME: usize = 65_536;
const MAX_HISTORY: usize = 524_288;
const MAX_TICKET_AGE: u64 = 45;
static USED: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();

fn denied() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "personal_upstox_data_unavailable",
    )
}
pub fn key(symbol: &str) -> io::Result<&'static str> {
    match symbol {
        "NIFTY" => Ok("NSE_INDEX|Nifty 50"),
        "BANKNIFTY" => Ok("NSE_INDEX|Nifty Bank"),
        "FINNIFTY" => Ok("NSE_INDEX|Nifty Fin Service"),
        "MIDCPNIFTY" => Ok("NSE_INDEX|Nifty Mid Select"),
        "INDIAVIX" => Ok("NSE_INDEX|India VIX"),
        "SENSEX" => Ok("BSE_INDEX|SENSEX"),
        _ => Err(denied()),
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Analytics {
    schema: String,
    broker: String,
    user_id: String,
    access_token: String,
    created_at: String,
    order_routing_enabled: bool,
    display_entitlement_verified: bool,
    retention_entitlement_verified: bool,
}
/// Match QSYN PHP's private/runtime layout without new env configuration.
/// Installed binary: private/app/bin/qsyn-stream -> private/runtime.
/// An explicit runtime path takes precedence and is validated by read_token.
pub fn runtime_dir() -> io::Result<std::path::PathBuf> {
    if let Some(configured) = std::env::var_os("QSYN_RUNTIME_DIR") {
        return Ok(std::path::PathBuf::from(configured));
    }
    let exe = std::env::current_exe()?;
    Ok(exe
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .ok_or_else(denied)?
        .join("runtime"))
}

pub fn read_token(runtime: &Path) -> io::Result<String> {
    if !runtime.is_absolute() || runtime.to_str().is_none() {
        return Err(denied());
    }
    let root = runtime.join("upstox-private");
    let meta = std::fs::symlink_metadata(&root)?;
    if !meta.is_dir() || meta.file_type().is_symlink() || root.canonicalize()? != root {
        return Err(denied());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if meta.permissions().mode() & 0o077 != 0 || meta.uid() != unsafe { libc::geteuid() } {
            return Err(denied());
        }
    }
    let data: Analytics = serde_json::from_slice(&private_bytes(
        &root.join("upstox-analytics-session.json"),
        16_384,
    )?)
    .map_err(|_| denied())?;
    if data.schema != "QSYN-UPSTOX-ANALYTICS-SESSION/1"
        || data.broker != "upstox"
        || data.order_routing_enabled
        || data.display_entitlement_verified
        || data.retention_entitlement_verified
        || data.created_at.is_empty()
        || data.user_id.len() < 2
        || data.user_id.len() > 128
        || data.access_token.len() < 20
        || data.access_token.len() > 8192
        || !data
            .access_token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._~+/=-".contains(&b))
    {
        return Err(denied());
    }
    Ok(data.access_token)
}
fn now_ms() -> io::Result<u64> {
    use std::time::{SystemTime, UNIX_EPOCH};
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| denied())?
        .as_millis() as u64)
}
fn day_ist(raw: &str, now: u64) -> io::Result<NaiveDate> {
    let day = NaiveDate::parse_from_str(raw, "%Y-%m-%d").map_err(|_| denied())?;
    if day.format("%Y-%m-%d").to_string() != raw {
        return Err(denied());
    }
    let tz = FixedOffset::east_opt(19800).ok_or_else(denied)?;
    let today = DateTime::<Utc>::from_timestamp_millis(now as i64)
        .ok_or_else(denied)?
        .with_timezone(&tz)
        .date_naive();
    if !(0..=30).contains(&today.signed_duration_since(day).num_days()) {
        return Err(denied());
    }
    Ok(day)
}
fn http_client() -> io::Result<reqwest::Client> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(16))
        .build()
        .map_err(|_| denied())
}
fn as_utc_bar(c: &crate::market_pipeline::Candle) -> Value {
    json!({"time":c.open_time_ms/1000,"open":c.open,"high":c.high,
        "low":c.low,"close":c.close,"volume":0})
}
/// Full day or current session. The Rust parser already rejects duplicate,
/// off-session, non-IST and non-OHLC Upstox payloads.
pub async fn history(symbol: &str, date: &str, runtime: &Path) -> io::Result<Value> {
    let instrument = key(symbol)?;
    let now = now_ms()?;
    let day = day_ist(date, now)?;
    let tz = FixedOffset::east_opt(19800).ok_or_else(denied)?;
    let today = DateTime::<Utc>::from_timestamp_millis(now as i64)
        .ok_or_else(denied)?
        .with_timezone(&tz)
        .date_naive();
    let url = if day == today {
        format!(
            "https://api.upstox.com/v3/historical-candle/intraday/{}/minutes/1",
            instrument.replace('|', "%7C").replace(' ', "%20")
        )
    } else {
        index_history_url(instrument, day)?
    };
    let token = read_token(runtime)?;
    let response = http_client()?
        .get(url)
        .bearer_auth(token)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|_| denied())?;
    if response.status() != reqwest::StatusCode::OK {
        return Err(denied());
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_HISTORY as u64)
    {
        return Err(denied());
    }
    let bytes = response.bytes().await.map_err(|_| denied())?;
    if bytes.len() > MAX_HISTORY {
        return Err(denied());
    }
    let candles = decode_index_day(&bytes, day, now)?;
    if candles.len() > 400 {
        return Err(denied());
    }
    Ok(json!({"schema":"QSYN-UPSTOX-RUST-INDEX-HISTORY/1",
        "symbol":symbol,"day_ist":date,"interval":"1m",
        "source":"upstox_v3_rust_history","bars":candles.iter().map(as_utc_bar).collect::<Vec<_>>(),
        "trading_enabled":false,"public_redistribution_allowed":false}))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PersonalTicket {
    symbol: String,
    exp: u64,
    nonce: String,
}
/// PHP issues these HMAC tickets only after a successful admin session+CSRF.
/// On the wire they cannot reveal or replace the provider's bearer token.
pub fn verify_ticket(ticket: &str, token: &str, now_s: u64) -> io::Result<String> {
    let (payload, signature) = ticket.split_once('.').ok_or_else(denied)?;
    if ticket.len() > 512
        || payload.len() > 300
        || signature.len() != 64
        || !signature.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(denied());
    }
    let mut mac = Hmac::<Sha256>::new_from_slice(token.as_bytes()).map_err(|_| denied())?;
    mac.update(payload.as_bytes());
    let signature = hex_bytes(signature)?;
    mac.verify_slice(&signature).map_err(|_| denied())?;
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    let bytes = URL_SAFE_NO_PAD.decode(payload).map_err(|_| denied())?;
    let scoped: PersonalTicket = serde_json::from_slice(&bytes).map_err(|_| denied())?;
    key(&scoped.symbol)?;
    if scoped.exp <= now_s
        || scoped.exp > now_s + MAX_TICKET_AGE
        || scoped.nonce.len() != 32
        || !scoped.nonce.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(denied());
    }
    let used = USED.get_or_init(|| Mutex::new(HashMap::new()));
    let mut cache = used.lock().map_err(|_| denied())?;
    cache.retain(|_, expiry| *expiry > now_s);
    if cache.len() > 4096 || cache.insert(scoped.nonce, scoped.exp).is_some() {
        return Err(denied());
    }
    Ok(scoped.symbol)
}
fn hex_bytes(s: &str) -> io::Result<Vec<u8>> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|_| denied()))
        .collect()
}
/// Pure rust decoder reused by all personal and operator V3 sockets.
#[derive(Debug, Clone, Serialize)]
pub struct Tick {
    pub symbol: String,
    pub time_ms: u64,
    pub price: f64,
}
#[derive(Debug, Clone, Serialize)]
pub struct Bar {
    pub time: u64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: u64,
}
#[derive(Default)]
pub struct MinuteBuilder {
    pub current: Option<Bar>,
    pub last_tick_ms: u64,
}
impl MinuteBuilder {
    pub fn on_tick(&mut self, t: &Tick) -> Option<Bar> {
        if t.time_ms <= self.last_tick_ms || !t.price.is_finite() || t.price <= 0.0 {
            return None;
        }
        self.last_tick_ms = t.time_ms;
        let minute = t.time_ms / 60_000 * 60;
        match self.current.as_mut() {
            Some(c) if c.time == minute => {
                c.high = c.high.max(t.price);
                c.low = c.low.min(t.price);
                c.close = t.price;
            }
            _ => {
                self.current = Some(Bar {
                    time: minute,
                    open: t.price,
                    high: t.price,
                    low: t.price,
                    close: t.price,
                    volume: 0,
                })
            }
        }
        self.current.clone()
    }
}
/// Provider WebSocket authorized with ONLY the same persisted Analytics Token.
/// One upstream connection per authenticated personal viewer, no background
/// daemon and no HTTP/REST polling. Exit when the browser disconnects.
pub async fn live<F, Fut>(symbol: &str, token: &str, mut emit: F) -> io::Result<()>
where
    F: FnMut(Tick, Bar) -> Fut,
    Fut: std::future::Future<Output = io::Result<()>>,
{
    let key = key(symbol)?;
    let response = http_client()?
        .get(AUTH_URL)
        .bearer_auth(token)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|_| denied())?;
    if response.status() != reqwest::StatusCode::OK {
        return Err(denied());
    }
    let payload: Value = response.json().await.map_err(|_| denied())?;
    if payload["status"] != "success" {
        return Err(denied());
    }
    let redirect = payload["data"]["authorized_redirect_uri"]
        .as_str()
        .ok_or_else(denied)?;
    validate_one_use_redirect(redirect)?;
    let (mut upstream, _) = timeout(Duration::from_secs(5), connect_async(redirect))
        .await
        .map_err(|_| denied())?
        .map_err(|_| denied())?;
    let nonce = format!("{:x}", now_ms()?);
    let subscribe = json!({"guid":nonce,"method":"sub",
        "data":{"mode":"ltpc","instrumentKeys":[key]}})
    .to_string();
    upstream
        .send(Message::Binary(subscribe.into_bytes().into()))
        .await
        .map_err(|_| denied())?;
    let mut builder = MinuteBuilder::default();
    let session = Instant::now();
    loop {
        if session.elapsed() > Duration::from_secs(120) {
            break;
        }
        let incoming = timeout(Duration::from_secs(15), upstream.next())
            .await
            .map_err(|_| denied())?;
        match incoming {
            Some(Ok(Message::Binary(frame))) => {
                if frame.len() > MAX_FRAME {
                    return Err(denied());
                }
                for (id, ms, price, snapshot) in
                    crate::upstox_v3::decode_personal_index_frame(&frame, key, now_ms()?)?
                {
                    if id != key || snapshot {
                        continue;
                    }
                    let tick = Tick {
                        symbol: symbol.to_string(),
                        time_ms: ms,
                        price,
                    };
                    if let Some(bar) = builder.on_tick(&tick) {
                        emit(tick, bar).await?;
                    }
                }
            }
            Some(Ok(Message::Ping(data))) => {
                upstream
                    .send(Message::Pong(data))
                    .await
                    .map_err(|_| denied())?;
            }
            Some(Ok(Message::Close(_))) | None => break,
            Some(Err(_)) => return Err(denied()),
            Some(Ok(Message::Text(_))) => return Err(denied()),
            _ => {}
        }
    }
    let _ = upstream.close(None).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn personal_keys_are_exact_and_denied_unknown() {
        assert_eq!(key("NIFTY").unwrap(), "NSE_INDEX|Nifty 50");
        assert_eq!(key("SENSEX").unwrap(), "BSE_INDEX|SENSEX");
        assert!(key("NSE_FO|fake").is_err());
    }
    #[test]
    fn minute_ohlc_uses_real_exchange_times_without_fake_volume() {
        let mut b = MinuteBuilder::default();
        let t = Tick {
            symbol: "NIFTY".into(),
            time_ms: 1_790_000_000_000,
            price: 25100.0,
        };
        let a = b.on_tick(&t).unwrap();
        assert_eq!(a.open, a.close);
        assert_eq!(a.volume, 0);
        assert!(b.on_tick(&t).is_none());
        let mut t2 = t.clone();
        t2.time_ms += 1000;
        t2.price = 25105.0;
        let next = b.on_tick(&t2).unwrap();
        assert_eq!(next.high, 25105.0);
        assert_eq!(next.open, 25100.0);
    }
    #[test]
    fn personal_ws_ticket_is_account_secret_bound_single_use_and_short_lived() {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
        let token = "test-read-only-analytics-token-not-a-live-credential-12345";
        let now = 1_790_000_000u64;
        let payload = serde_json::json!({
            "symbol":"NIFTY","exp":now+30,"nonce":"0123456789abcdef0123456789abcdef"
        })
        .to_string();
        let encoded = URL_SAFE_NO_PAD.encode(payload);
        let mut mac = Hmac::<Sha256>::new_from_slice(token.as_bytes()).unwrap();
        mac.update(encoded.as_bytes());
        let signed = mac.finalize().into_bytes();
        let sig = signed
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let ticket = format!("{encoded}.{sig}");
        assert!(verify_ticket(&ticket, "wrong-broker-token", now).is_err());
        assert_eq!(verify_ticket(&ticket, token, now).unwrap(), "NIFTY");
        assert!(verify_ticket(&ticket, token, now).is_err());
        assert!(verify_ticket(&ticket, token, now + 31).is_err());
    }
    #[test]
    fn history_scope_must_be_bounded() {
        assert!(day_ist("2000-01-01", now_ms().unwrap()).is_err());
        assert!(day_ist("invalid", now_ms().unwrap()).is_err());
    }
}
