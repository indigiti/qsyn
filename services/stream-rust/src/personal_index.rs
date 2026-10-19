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
        "BANKEX" => Ok("BSE_INDEX|BANKEX"),
        _ => Err(denied()),
    }
}

pub const INDEX_SYMBOLS: [&str; 7] = [
    "NIFTY",
    "BANKNIFTY",
    "FINNIFTY",
    "MIDCPNIFTY",
    "SENSEX",
    "BANKEX",
    "INDIAVIX",
];
pub fn symbol_for_key(instrument: &str) -> Option<&'static str> {
    INDEX_SYMBOLS
        .iter()
        .copied()
        .find(|&symbol| key(symbol).ok() == Some(instrument))
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
    // Upstox V3 supports minute history back to January 2022, when the
    // specific index was listed. Bound requests to a single historical day;
    // the browser requests more only when the user pans left.
    if day < NaiveDate::from_ymd_opt(2022, 1, 1).ok_or_else(denied)? || day > today {
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
// Volume=0 in index OHLCV is an OpenAlgo compatibility placeholder, not
// observed traded index volume. Response metadata explicitly marks N/A.
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
        "volume_available":false,"volume_status":"not_applicable_index",
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
/// Short-lived one-use browser ticket for a single dynamically discovered
/// instrument. This is independent from the seven legacy symbol tickets.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InstrumentTicket {
    instrument_key: String,
    exp: u64,
    nonce: String,
}
pub fn verify_instrument_ticket(ticket: &str, token: &str, now_s: u64) -> io::Result<String> {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    let (payload, signature) = ticket.split_once('.').ok_or_else(denied)?;
    if ticket.len() > 512
        || payload.len() > 350
        || signature.len() != 64
        || !signature.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(denied());
    }
    let mut mac = Hmac::<Sha256>::new_from_slice(token.as_bytes()).map_err(|_| denied())?;
    mac.update(payload.as_bytes());
    mac.verify_slice(&hex_bytes(signature)?)
        .map_err(|_| denied())?;
    let bytes = URL_SAFE_NO_PAD.decode(payload).map_err(|_| denied())?;
    let item: InstrumentTicket = serde_json::from_slice(&bytes).map_err(|_| denied())?;
    if !crate::upstox_instrument_history::valid_instrument_key(&item.instrument_key)
        || symbol_for_key(&item.instrument_key).is_some()
        || item.exp <= now_s
        || item.exp > now_s + MAX_TICKET_AGE
        || item.nonce.len() != 32
        || !item.nonce.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(denied());
    }
    let used = USED.get_or_init(|| Mutex::new(HashMap::new()));
    let mut cache = used.lock().map_err(|_| denied())?;
    cache.retain(|_, expiry| *expiry > now_s);
    if cache.len() > 4096 || cache.insert(item.nonce, item.exp).is_some() {
        return Err(denied());
    }
    Ok(item.instrument_key)
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
/// OHLC builder for actual provider-generated seconds. It does not fill gaps.
#[derive(Default)]
pub struct SecondBuilder {
    pub current: Option<Bar>,
    pub last_event_ms: u64,
}
impl SecondBuilder {
    pub fn on_tick(&mut self, t: &Tick) -> Option<Bar> {
        if t.time_ms < self.last_event_ms || !t.price.is_finite() || t.price <= 0.0 {
            return None;
        }
        self.last_event_ms = t.time_ms;
        let second = t.time_ms / 1_000;
        match self.current.as_mut() {
            Some(c) if c.time == second => {
                c.high = c.high.max(t.price);
                c.low = c.low.min(t.price);
                c.close = t.price;
            }
            Some(c) if c.time > second => return None,
            _ => {
                self.current = Some(Bar {
                    time: second,
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

/// Combined live tick and OHLCs, distributed through one shared provider socket.
#[derive(Debug, Clone, Serialize)]
pub struct IndexLiveEvent {
    pub tick: Tick,
    pub bar: Bar,
    pub second_bar: Bar,
}

static SHARED: OnceLock<Mutex<Option<SharedIndexFeed>>> = OnceLock::new();
static NEXT_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
const MAX_DYNAMIC_SUBSCRIPTIONS: usize = 16;

#[derive(Debug, Clone, Serialize)]
pub struct InstrumentLiveEvent {
    pub instrument_key: String,
    pub provider_time_ms: u64,
    pub bar: Value,
    pub volume_available: bool,
    pub open_interest: Option<f64>,
}

/// One upstream Upstox V3 connection shared with all seven legacy index
/// viewers. Dynamic subscriptions are bounded, reference-counted and removed
/// when the last chart closes, without touching the existing index aliases.
struct SharedIndexFeed {
    sender: tokio::sync::broadcast::Sender<IndexLiveEvent>,
    scoped_sender: tokio::sync::broadcast::Sender<InstrumentLiveEvent>,
    requested: tokio::sync::watch::Sender<Vec<String>>,
    refs: HashMap<String, usize>,
    generation: u64,
    task: tokio::task::JoinHandle<()>,
}

fn make_shared(token: String) -> SharedIndexFeed {
    use std::sync::atomic::Ordering;
    let (sender, _) = tokio::sync::broadcast::channel(1024);
    let (scoped_sender, _) = tokio::sync::broadcast::channel(256);
    let (requested, receiver) = tokio::sync::watch::channel(Vec::new());
    let index_broadcast = sender.clone();
    let scoped_broadcast = scoped_sender.clone();
    let generation = NEXT_GENERATION.fetch_add(1, Ordering::Relaxed);
    let task = tokio::spawn(async move {
        run_shared_index_feed(token, index_broadcast, scoped_broadcast, receiver).await;
    });
    SharedIndexFeed {
        sender,
        scoped_sender,
        requested,
        refs: HashMap::new(),
        generation,
        task,
    }
}

pub fn subscribe_shared(token: String) -> tokio::sync::broadcast::Receiver<IndexLiveEvent> {
    let state = SHARED.get_or_init(|| Mutex::new(None));
    let mut guard = state.lock().expect("shared index hub mutex");
    if guard.as_ref().is_none_or(|hub| hub.task.is_finished()) {
        *guard = Some(make_shared(token));
    }
    guard.as_ref().unwrap().sender.subscribe()
}

/// Drop-based release prevents disconnected charts from leaking provider
/// subscriptions and avoids opening another upstream connection per viewer.
pub struct InstrumentSubscription {
    key: String,
    generation: u64,
}
impl Drop for InstrumentSubscription {
    fn drop(&mut self) {
        let Some(state) = SHARED.get() else { return };
        let Ok(mut guard) = state.lock() else { return };
        let Some(hub) = guard.as_mut() else { return };
        if hub.generation != self.generation {
            return;
        }
        if let Some(count) = hub.refs.get_mut(&self.key) {
            *count -= 1;
            if *count == 0 {
                hub.refs.remove(&self.key);
            }
            let mut keys = hub.refs.keys().cloned().collect::<Vec<_>>();
            keys.sort_unstable();
            hub.requested.send_replace(keys);
        }
    }
}

pub fn subscribe_instrument(
    token: String,
    key: &str,
) -> io::Result<(
    tokio::sync::broadcast::Receiver<InstrumentLiveEvent>,
    InstrumentSubscription,
)> {
    if !crate::upstox_instrument_history::valid_instrument_key(key) || symbol_for_key(key).is_some()
    {
        return Err(denied());
    }
    let state = SHARED.get_or_init(|| Mutex::new(None));
    let mut guard = state.lock().map_err(|_| denied())?;
    if guard.as_ref().is_none_or(|hub| hub.task.is_finished()) {
        *guard = Some(make_shared(token));
    }
    let hub = guard.as_mut().ok_or_else(denied)?;
    if !hub.refs.contains_key(key) && hub.refs.len() >= MAX_DYNAMIC_SUBSCRIPTIONS {
        return Err(denied());
    }
    let count = hub.refs.entry(key.to_owned()).or_insert(0);
    *count += 1;
    let mut keys = hub.refs.keys().cloned().collect::<Vec<_>>();
    keys.sort_unstable();
    hub.requested.send_replace(keys);
    Ok((
        hub.scoped_sender.subscribe(),
        InstrumentSubscription {
            key: key.to_owned(),
            generation: hub.generation,
        },
    ))
}

fn has_subscribers(
    index_sender: &tokio::sync::broadcast::Sender<IndexLiveEvent>,
    scoped_sender: &tokio::sync::broadcast::Sender<InstrumentLiveEvent>,
) -> bool {
    index_sender.receiver_count() > 0 || scoped_sender.receiver_count() > 0
}

async fn run_shared_index_feed(
    token: String,
    index_sender: tokio::sync::broadcast::Sender<IndexLiveEvent>,
    scoped_sender: tokio::sync::broadcast::Sender<InstrumentLiveEvent>,
    mut requested: tokio::sync::watch::Receiver<Vec<String>>,
) {
    let mut retry = 2u64;
    while has_subscribers(&index_sender, &scoped_sender) {
        let _ = shared_session(&token, &index_sender, &scoped_sender, &mut requested).await;
        if !has_subscribers(&index_sender, &scoped_sender) {
            break;
        }
        tokio::time::sleep(Duration::from_secs(retry)).await;
        retry = (retry * 2).min(30);
    }
}

/// Binary V3 request; a dynamic full-mode chart receives exactly one
/// provider I1 candle stream, never a newly created per-chart socket.
async fn subscription_command(
    upstream: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    method: &str,
    mode: &str,
    keys: &[String],
) -> io::Result<()> {
    if keys.is_empty() {
        return Ok(());
    }
    let command = json!({
        "guid":format!("{:x}",now_ms()?),
        "method":method,
        "data":{"mode":mode,"instrumentKeys":keys},
    })
    .to_string();
    upstream
        .send(Message::Binary(command.into_bytes().into()))
        .await
        .map_err(|_| denied())
}

async fn shared_session(
    token: &str,
    index_sender: &tokio::sync::broadcast::Sender<IndexLiveEvent>,
    scoped_sender: &tokio::sync::broadcast::Sender<InstrumentLiveEvent>,
    requested: &mut tokio::sync::watch::Receiver<Vec<String>>,
) -> io::Result<()> {
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

    // The original seven aliases remain subscribed for legacy viewers.
    let index_keys = INDEX_SYMBOLS
        .iter()
        .map(|symbol| key(symbol).unwrap().to_owned())
        .collect::<Vec<_>>();
    subscription_command(&mut upstream, "sub", "ltpc", &index_keys).await?;
    let mut subscribed = std::collections::HashSet::<String>::new();
    let initial = requested.borrow().clone();
    if initial.len() > MAX_DYNAMIC_SUBSCRIPTIONS {
        return Err(denied());
    }
    subscription_command(&mut upstream, "sub", "full", &initial).await?;
    subscribed.extend(initial);

    let mut minute: HashMap<&'static str, MinuteBuilder> = HashMap::new();
    let mut second: HashMap<&'static str, SecondBuilder> = HashMap::new();
    let mut last_scoped = HashMap::<String, crate::upstox_v3::ScopedMinuteUpdate>::new();
    let started = Instant::now();
    let mut idle_since: Option<Instant> = None;
    loop {
        if started.elapsed() >= Duration::from_secs(110) {
            break;
        }
        if !has_subscribers(index_sender, scoped_sender) {
            let since = idle_since.get_or_insert_with(Instant::now);
            if since.elapsed() >= Duration::from_secs(3) {
                break;
            }
        } else {
            idle_since = None;
        }

        tokio::select! {
            changed = requested.changed() => {
                if changed.is_err() { break }
                let new_set = requested.borrow().iter().cloned()
                    .collect::<std::collections::HashSet<_>>();
                if new_set.len() > MAX_DYNAMIC_SUBSCRIPTIONS { return Err(denied()) }
                let mut added = new_set.difference(&subscribed).cloned().collect::<Vec<_>>();
                let mut removed = subscribed.difference(&new_set).cloned().collect::<Vec<_>>();
                added.sort_unstable();removed.sort_unstable();
                // Old seven-index subscriptions are never removed.
                subscription_command(&mut upstream,"unsub","full",&removed).await?;
                subscription_command(&mut upstream,"sub","full",&added).await?;
                for key in &removed { last_scoped.remove(key); }
                subscribed = new_set;
            }
            incoming = timeout(Duration::from_secs(2),upstream.next()) => {
                match incoming {
                    Err(_) => continue,
                    Ok(Some(Ok(Message::Binary(frame)))) => {
                        if frame.len() > MAX_FRAME { return Err(denied()) }
                        let received = now_ms()?;
                        let old = crate::upstox_v3::legacy_index_frame(&frame)?;
                        for update in crate::upstox_v3::decode_personal_index_updates(&old,received)? {
                            if update.snapshot { continue }
                            let Some(symbol) = symbol_for_key(&update.key) else { continue };
                            let tick = Tick {
                                symbol: symbol.to_owned(),time_ms:update.time_ms,price:update.price
                            };
                            let Some(second_bar) = second.entry(symbol).or_default().on_tick(&tick)
                                else { continue };
                            let minute_builder = minute.entry(symbol).or_default();
                            let bar = minute_builder.on_tick(&tick)
                                .or_else(|| minute_builder.current.clone());
                            if let Some(bar) = bar {
                                let _ = index_sender.send(IndexLiveEvent{tick,bar,second_bar});
                            }
                        }
                        for entry in crate::upstox_v3::decode_scoped_minute_updates(
                            &frame,&subscribed,received
                        )? {
                            if let Some(previous) = last_scoped.get(&entry.instrument_key) {
                                if previous.bar_time_ms > entry.bar_time_ms
                                    || (previous.bar_time_ms == entry.bar_time_ms &&
                                        (previous == &entry || previous.volume > entry.volume))
                                { continue }
                            }
                            last_scoped.insert(entry.instrument_key.clone(),entry.clone());
                            let volume = entry.volume;
                            let bar = json!({
                                "time":entry.bar_time_ms/1000,
                                "open":entry.open,"high":entry.high,
                                "low":entry.low,"close":entry.close,
                                "volume":volume
                            });
                            let _ = scoped_sender.send(InstrumentLiveEvent {
                                instrument_key:entry.instrument_key,
                                provider_time_ms:entry.provider_time_ms,
                                bar,volume_available:entry.volume_available,
                                open_interest:entry.open_interest,
                            });
                        }
                    }
                    Ok(Some(Ok(Message::Ping(data)))) => {
                        upstream.send(Message::Pong(data)).await.map_err(|_| denied())?;
                    }
                    Ok(Some(Ok(Message::Close(_)))) | Ok(None) => break,
                    Ok(Some(Err(_))) | Ok(Some(Ok(Message::Text(_)))) => return Err(denied()),
                    _ => {}
                }
            }
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
        assert_eq!(key("BANKEX").unwrap(), "BSE_INDEX|BANKEX");
        assert_eq!(symbol_for_key("BSE_INDEX|BANKEX"), Some("BANKEX"));
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
        assert_eq!(a.volume, 0); // no inferred trade size
        assert_eq!(
            as_utc_bar(
                &crate::market_pipeline::Candle::from_observation(
                    t.time_ms / 60_000 * 60_000,
                    t.price
                )
                .unwrap()
            )["volume"],
            0
        );
        assert!(b.on_tick(&t).is_none());
        let mut t2 = t.clone();
        t2.time_ms += 1000;
        t2.price = 25105.0;
        let next = b.on_tick(&t2).unwrap();
        assert_eq!(next.high, 25105.0);
        assert_eq!(next.open, 25100.0);
    }
    #[test]
    fn sparse_second_bars_preserve_gaps_and_same_second_prices() {
        let mut b = SecondBuilder::default();
        let mut tick = Tick {
            symbol: "NIFTY".into(),
            time_ms: 1_790_000_000_050,
            price: 25100.0,
        };
        let a = b.on_tick(&tick).unwrap();
        tick.time_ms += 100;
        tick.price = 25105.0;
        let updated = b.on_tick(&tick).unwrap();
        assert_eq!(updated.time, a.time);
        assert_eq!(updated.open, 25100.0);
        assert_eq!(updated.high, 25105.0);
        tick.time_ms += 3_000;
        let after_gap = b.on_tick(&tick).unwrap();
        assert_eq!(after_gap.time, a.time + 3);
        assert!(b
            .on_tick(&Tick {
                time_ms: tick.time_ms - 2_000,
                ..tick
            })
            .is_none());
        assert_eq!(symbol_for_key("NSE_INDEX|Nifty Bank"), Some("BANKNIFTY"));
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
        assert!(day_ist("2022-01-01", now_ms().unwrap()).is_ok());
        assert!(day_ist("2021-12-31", now_ms().unwrap()).is_err());
        assert!(day_ist("invalid", now_ms().unwrap()).is_err());
    }
}
