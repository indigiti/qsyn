//! Operator-only V3 historical NSE/BSE index OHLC import.
//! No browser-origin fetches, public quotes, credential logs or order execution.
use crate::durable_market_wal::root_check;
use crate::immutable_candles::{self, SeriesDescriptor};
use crate::market_pipeline::{Candle, DataMode, Scope};
use crate::private_chart_ws::epoch_ms;
use crate::upstox_index_worker::IndexWorkerSettings;
use chrono::{DateTime, FixedOffset, NaiveDate, Offset, Utc};
use reqwest::redirect::Policy;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{io, path::Path};
use tokio::time::Duration;

fn denied() -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, "private_index_history_denied")
}
fn ist() -> io::Result<FixedOffset> {
    FixedOffset::east_opt(19_800).ok_or_else(denied)
}
pub fn day_for_operator(raw: &str, now_ms: u64) -> io::Result<NaiveDate> {
    if raw.len() != 10 || !raw.bytes().enumerate().all(|(i, byte)| {
        if i == 4 || i == 7 { byte == b'-' } else { byte.is_ascii_digit() }
    }) {
        return Err(denied());
    }
    let day = NaiveDate::parse_from_str(raw, "%Y-%m-%d").map_err(|_| denied())?;
    let today = DateTime::<Utc>::from_timestamp_millis(
        i64::try_from(now_ms).map_err(|_| denied())?
    ).ok_or_else(denied)?.with_timezone(&ist()?).date_naive();
    if !(0..=30).contains(&today.signed_duration_since(day).num_days()) {
        return Err(denied());
    }
    Ok(day)
}
pub fn approved_key(settings: &IndexWorkerSettings, key: &str) -> io::Result<()> {
    if settings.instruments.iter().any(|i| i.instrument_key == key)
        && matches!(key.split_once('|').map(|v| v.0), Some("NSE_INDEX" | "BSE_INDEX"))
    {
        Ok(())
    } else {
        Err(denied())
    }
}
/// The filename is private and collision-resistant; never put free-form
/// provider names or a client-supplied path in an archive filename.
pub fn index_series_id(key: &str, day: NaiveDate) -> io::Result<String> {
    let (segment, name) = key.split_once('|').ok_or_else(denied)?;
    if !matches!(segment, "NSE_INDEX" | "BSE_INDEX")
        || name.is_empty() || name.len() > 100
        || !name.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b' ' | b'.' | b'_' | b'-'))
    {
        return Err(denied());
    }
    let hash = Sha256::digest(key.as_bytes());
    let digest = hash[..16].iter().map(|v| format!("{v:02x}")).collect::<String>();
    Ok(format!("{segment}_{digest}_{}", day.format("%Y%m%d")))
}
pub fn index_descriptor(settings: &IndexWorkerSettings, key: &str, day: NaiveDate)
    -> io::Result<SeriesDescriptor>
{
    approved_key(settings, key)?;
    Ok(SeriesDescriptor {
        scope: Scope {
            tenant_id: settings.tenant.clone(),
            account_id: settings.account.clone(),
            source_id: "upstox_v3_index_history".into(),
            entitlement_id: settings.entitlement_id.clone(),
        },
        mode: DataMode::Replay,
        series_id: index_series_id(key, day)?,
        interval_ms: 60_000,
    })
}
/// Upstox index volumes can be unavailable; QCB stores OHLC and a count of
/// provider candle observations, NOT invented exchange index volume.
pub fn decode_index_day(body: &[u8], day: NaiveDate, now_ms: u64) -> io::Result<Vec<Candle>> {
    if body.len() > 2_000_000 { return Err(denied()); }
    let json: Value = serde_json::from_slice(body).map_err(|_| denied())?;
    if json["status"] != "success" { return Err(denied()); }
    let rows = json["data"]["candles"].as_array().ok_or_else(denied)?;
    if rows.len() > 2000 { return Err(denied()); }
    let mut candles = Vec::with_capacity(rows.len());
    for row in rows {
        let cells = row.as_array().ok_or_else(denied)?;
        if !(6..=7).contains(&cells.len()) { return Err(denied()); }
        let timestamp = DateTime::parse_from_rfc3339(
            cells[0].as_str().ok_or_else(denied)?
        ).map_err(|_| denied())?;
        if timestamp.offset().fix() != ist()? || timestamp.date_naive() != day {
            return Err(denied());
        }
        let ms = u64::try_from(timestamp.timestamp_millis()).map_err(|_| denied())?;
        if ms == 0 || ms % 60_000 != 0 || ms > now_ms { return Err(denied()); }
        let numeric = |index: usize| -> io::Result<f64> {
            let v = cells[index].as_f64().ok_or_else(denied)?;
            if !v.is_finite() || v <= 0.0 { return Err(denied()); }
            Ok(v)
        };
        let (open, high, low, close) = (numeric(1)?, numeric(2)?, numeric(3)?, numeric(4)?);
        if low > open.min(close) || high < open.max(close) || high < low {
            return Err(denied());
        }
        if !(cells[5].is_null() || cells[5].as_u64().is_some())
            || (cells.len() == 7 && !(cells[6].is_null() || cells[6].as_u64().is_some()))
        {
            return Err(denied());
        }
        candles.push(Candle {
            open_time_ms: ms, open, high, low, close, observations: 1,
        });
    }
    candles.sort_by_key(|c| c.open_time_ms);
    if candles.windows(2).any(|w| w[0].open_time_ms == w[1].open_time_ms) {
        return Err(denied());
    }
    Ok(candles)
}
pub fn index_history_url(key: &str, day: NaiveDate) -> io::Result<String> {
    index_series_id(key, day)?;
    let encoded = key.replace('|', "%7C").replace(' ', "%20");
    Ok(format!(
        "https://api.upstox.com/v3/historical-candle/{encoded}/minutes/1/{day}/{day}"
    ))
}
pub fn archive_index_day(root: &Path, settings: &IndexWorkerSettings, key: &str,
    day: NaiveDate, candles: &[Candle], now_ms: u64) -> io::Result<()>
{
    settings.validate(now_ms)?;
    day_for_operator(&day.to_string(), now_ms)?;
    root_check(root)?;
    if candles.is_empty() || candles.len() > 2000 { return Err(denied()); }
    for candle in candles {
        let at = DateTime::<Utc>::from_timestamp_millis(
            i64::try_from(candle.open_time_ms).map_err(|_| denied())?
        ).ok_or_else(denied)?.with_timezone(&ist()?);
        if at.date_naive() != day { return Err(denied()); }
    }
    immutable_candles::publish(
        root, &day.format("%Y%m").to_string(),
        &index_descriptor(settings, key, day)?, candles,
    )
}
#[derive(Serialize)]
pub struct IndexHistoryResult {
    pub schema: &'static str,
    pub instrument: String,
    pub day: String,
    pub candle_count: usize,
    pub archive_written: bool,
    pub source: &'static str,
    pub public_redistribution_allowed: bool,
    pub execution_enabled: bool,
}
pub async fn backfill_index_day(settings: &IndexWorkerSettings, archive_root: &Path,
    key: &str, date: &str) -> io::Result<IndexHistoryResult>
{
    let now = epoch_ms()?;
    settings.validate(now)?;
    approved_key(settings, key)?;
    let day = day_for_operator(date, now)?;
    root_check(archive_root)?;
    let token = settings.authorized_history_token(now)?;
    let client = reqwest::Client::builder()
        .https_only(true)
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(12))
        .build().map_err(|_| denied())?;
    let mut response = client.get(index_history_url(key, day)?)
        .bearer_auth(token)
        .header("Accept", "application/json")
        .send().await.map_err(|_| denied())?;
    if response.status() != reqwest::StatusCode::OK
        || response.content_length().is_some_and(|v| v > 2_000_000)
    {
        return Err(denied());
    }
    let mut data = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| denied())? {
        if data.len().saturating_add(chunk.len()) > 2_000_000 { return Err(denied()); }
        data.extend_from_slice(&chunk);
    }
    let candles = decode_index_day(&data, day, now)?;
    // Revalidate rights and BOD after provider call, before durable publish.
    if !candles.is_empty() {
        archive_index_day(archive_root, settings, key, day, &candles, epoch_ms()?)?;
    }
    Ok(IndexHistoryResult {
        schema: "QSYN-UPSTOX-PRIVATE-INDEX-IMPORT/1",
        instrument: key.to_string(), day: day.to_string(), candle_count: candles.len(),
        archive_written: !candles.is_empty(), source: "upstox_v3_private_index_history",
        public_redistribution_allowed: false, execution_enabled: false,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validate_provider_index_ohlc_and_bounded_day() {
        let day = NaiveDate::from_ymd_opt(2026, 10, 9).unwrap();
        let data = br#"{"status":"success","data":{"candles":[
          ["2026-10-09T09:16:00+05:30",25101,25106,25100,25103,null,null],
          ["2026-10-09T09:15:00+05:30",25100,25110,25098,25101,0,0]
        ]}}"#;
        let rows = decode_index_day(data, day, 1_800_000_000_000).unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows[0].open_time_ms < rows[1].open_time_ms);
        assert_eq!(rows[0].open, 25100.0);
        assert!(decode_index_day(data, day, 1_000).is_err());
        assert!(decode_index_day(data, NaiveDate::from_ymd_opt(2026,10,8).unwrap(),
            1_800_000_000_000).is_err());
        assert!(decode_index_day(br#"{"status":"success","data":{"candles":[]}}"#,
            day, 1_800_000_000_000).unwrap().is_empty());
        let duplicate = br#"{"status":"success","data":{"candles":[
          ["2026-10-09T09:15:00+05:30",100,102,99,101,0],
          ["2026-10-09T09:15:00+05:30",100,102,99,101,0]
        ]}}"#;
        assert!(decode_index_day(duplicate, day, 1_800_000_000_000).is_err());
        assert!(index_history_url("NSE_INDEX|Nifty 50", day).unwrap()
            .contains("NSE_INDEX%7CNifty%2050/minutes/1/2026-10-09"));
        assert!(index_history_url("NSE_INDEX|../secret", day).is_err());
        assert!(day_for_operator("2026-10-09", 1_791_900_000_000).is_ok());
        assert!(day_for_operator("1970-01-01", 1_791_900_000_000).is_err());
    }
}
