//! Private per-account read-only NSE/BSE index OHLC history endpoint.
//! Separate from NSE_FO option history. No public chart route or bearer in URLs.
use crate::{
    chart_entitlement::{ChartGrant, ChartSigner, ChartViewer},
    durable_market_wal::root_check,
    immutable_candles::CandlePartition,
    private_chart_ws::{epoch_ms, load_rights, load_secret},
    upstox_index_history::{approved_key, index_descriptor},
    upstox_index_worker::IndexWorkerSettings,
};
use axum::{
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{Days, FixedOffset, Utc};
use serde::Serialize;
use std::{
    io,
    net::{Ipv4Addr, SocketAddrV4},
    path::{Path, PathBuf},
    sync::Arc,
};
fn denied() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "private_index_history_access_denied",
    )
}
#[derive(Clone)]
pub struct IndexHistoryConfig {
    pub settings_path: PathBuf,
    pub signing_key_path: PathBuf,
    pub archive_root: PathBuf,
}
impl IndexHistoryConfig {
    pub fn verify(&self, now: u64) -> io::Result<IndexWorkerSettings> {
        let settings = IndexWorkerSettings::from_private_file(&self.settings_path)?;
        settings.validate(now)?;
        root_check(&self.archive_root)?;
        let _ = load_secret(&self.signing_key_path)?;
        Ok(settings)
    }
}
#[derive(Serialize)]
pub struct IndexHistoryBar {
    time: u64,
    open: f64,
    high: f64,
    low: f64,
    close: f64,
}
#[derive(Serialize)]
pub struct IndexHistoryResponse {
    schema: &'static str,
    source: &'static str,
    account: String,
    instrument: String,
    exchange: &'static str,
    interval: &'static str,
    trading_enabled: bool,
    public_redistribution_allowed: bool,
    history_complete: bool,
    bars: Vec<IndexHistoryBar>,
}
fn header_token(headers: &HeaderMap) -> io::Result<&str> {
    let value = headers
        .get(header::AUTHORIZATION)
        .ok_or_else(denied)?
        .to_str()
        .map_err(|_| denied())?
        .strip_prefix("Bearer ")
        .ok_or_else(denied)?;
    if value.is_empty() || value.len() > 2048 || value.contains(char::is_whitespace) {
        return Err(denied());
    }
    Ok(value)
}
pub fn validate_index_ticket(
    token: &str,
    now: u64,
    settings: &IndexWorkerSettings,
    signing_key: &Path,
) -> io::Result<ChartGrant> {
    if token.len() > 2048 {
        return Err(denied());
    }
    let raw = token.split_once('.').ok_or_else(denied)?.0;
    let bytes = URL_SAFE_NO_PAD.decode(raw).map_err(|_| denied())?;
    if bytes.len() > 1024 {
        return Err(denied());
    }
    let claim: ChartGrant = serde_json::from_slice(&bytes).map_err(|_| denied())?;
    let signer = ChartSigner::new(load_secret(signing_key)?);
    let rights = load_rights(&settings.private_rights_file)?;
    let viewer = ChartViewer {
        tenant: &claim.tenant,
        account: &claim.account,
        owner: &claim.owner,
        instrument: &claim.instrument,
    };
    signer.verify(token, now, &viewer, &rights)?;
    approved_key(settings, &claim.instrument)?;
    if claim.broker != "upstox"
        || claim.tenant != settings.tenant
        || claim.account != settings.account
        || claim.owner != settings.owner
        || claim.license_id != settings.entitlement_id
        || claim.expires_ms.saturating_sub(claim.issued_ms) > 30_000
        || !settings.operator_approved_retention
        || !settings.operator_approved_display
    {
        return Err(denied());
    }
    Ok(claim)
}
pub fn read_recent_index_bars(
    root: &Path,
    settings: &IndexWorkerSettings,
    instrument: &str,
    now: u64,
    limit: usize,
) -> io::Result<Vec<IndexHistoryBar>> {
    if limit == 0 || limit > 1200 {
        return Err(denied());
    }
    approved_key(settings, instrument)?;
    root_check(root)?;
    let today =
        chrono::DateTime::<Utc>::from_timestamp_millis(i64::try_from(now).map_err(|_| denied())?)
            .ok_or_else(denied)?
            .with_timezone(&FixedOffset::east_opt(19_800).ok_or_else(denied)?)
            .date_naive();
    let mut out = Vec::new();
    for days_ago in (0..=30).rev() {
        let date = today
            .checked_sub_days(Days::new(days_ago))
            .ok_or_else(denied)?;
        let descriptor = index_descriptor(settings, instrument, date)?;
        let partition = date.format("%Y%m").to_string();
        let mut reader = match CandlePartition::open(root, &partition, &descriptor) {
            Ok(reader) => reader,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(_) => return Err(denied()),
        };
        reader.audit()?;
        for row in reader.range(0, now, limit)? {
            out.push(IndexHistoryBar {
                time: row.open_time_ms / 1000,
                open: row.open,
                high: row.high,
                low: row.low,
                close: row.close,
            });
        }
        if out.len() > limit {
            out.drain(0..out.len() - limit);
        }
    }
    Ok(out)
}
fn response_for_token(
    cfg: &IndexHistoryConfig,
    ticket: &str,
    now: u64,
) -> io::Result<IndexHistoryResponse> {
    let settings = cfg.verify(now)?;
    let claim = validate_index_ticket(ticket, now, &settings, &cfg.signing_key_path)?;
    let bars = read_recent_index_bars(&cfg.archive_root, &settings, &claim.instrument, now, 1200)?;
    Ok(IndexHistoryResponse {
        schema: "QSYN-UPSTOX-PRIVATE-INDEX-HISTORY/1",
        source: "licensed_private_index_history",
        account: claim.account,
        instrument: claim.instrument,
        exchange: "UPSTOX_PRIVATE",
        interval: "1m",
        trading_enabled: false,
        public_redistribution_allowed: false,
        history_complete: false,
        bars,
    })
}
async fn handler(State(cfg): State<Arc<IndexHistoryConfig>>, headers: HeaderMap) -> Response {
    let report = (|| -> io::Result<IndexHistoryResponse> {
        response_for_token(&cfg, header_token(&headers)?, epoch_ms()?)
    })();
    match report {
        Ok(body) => (
            [
                (header::CACHE_CONTROL, "private, no-store"),
                (header::PRAGMA, "no-cache"),
                (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            ],
            Json(body),
        )
            .into_response(),
        Err(_) => (
            StatusCode::FORBIDDEN,
            [(header::CACHE_CONTROL, "private, no-store")],
            Json(serde_json::json!({"error":"private_index_history_unavailable"})),
        )
            .into_response(),
    }
}
pub fn router(cfg: IndexHistoryConfig) -> Router {
    Router::new()
        .route("/qsyn/private-chart/index-history", get(handler))
        .with_state(Arc::new(cfg))
}
pub async fn serve(port: u16, cfg: IndexHistoryConfig) -> io::Result<()> {
    if !(1025..=65535).contains(&port) {
        return Err(denied());
    }
    cfg.verify(epoch_ms()?)?;
    let listener =
        tokio::net::TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)).await?;
    axum::serve(listener, router(cfg))
        .await
        .map_err(|_| denied())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn private_index_reader_rejects_anonymous_and_foreign_input() {
        let mut headers = HeaderMap::new();
        assert!(header_token(&headers).is_err());
        headers.insert(header::AUTHORIZATION, "Basic bad".parse().unwrap());
        assert!(header_token(&headers).is_err());
        headers.insert(header::AUTHORIZATION, "Bearer fake.token".parse().unwrap());
        assert_eq!(header_token(&headers).unwrap(), "fake.token");
        // Invalid private config cannot expose archives or return success.
        let cfg = IndexHistoryConfig {
            settings_path: PathBuf::from("/missing/config"),
            signing_key_path: PathBuf::from("/missing/secret"),
            archive_root: PathBuf::from("/missing/archive"),
        };
        assert!(response_for_token(&cfg, "fake.token", epoch_ms().unwrap()).is_err());
    }
}
