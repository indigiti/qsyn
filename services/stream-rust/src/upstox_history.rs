//! Operator-only, account-scoped Upstox V3 1-minute option leg backfill.
//!
//! This module does not create a public REST endpoint or fabricate synchronized
//! CE+PE basket OHLC. It requires current OAuth, separate retention approval,
//! operator-verified current BOD keys and a private owner-only immutable archive.
use crate::immutable_candles::{self, SeriesDescriptor};
use crate::market_pipeline::{Candle, DataMode, Scope};
use crate::private_chart_ws::epoch_ms;
use crate::upstox_worker::WorkerSettings;
use chrono::{DateTime, FixedOffset, NaiveDate, Offset, Utc};
use reqwest::redirect::Policy;
use serde_json::Value;
use std::io;
use std::path::Path;
use tokio::time::Duration;

fn rejected() -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, "private_upstox_history_not_approved")
}

fn decode_day(raw: &str, today: NaiveDate) -> io::Result<NaiveDate> {
    if raw.len() != 10 || !raw.bytes().enumerate().all(|(i, b)| {
        if i == 4 || i == 7 { b == b'-' } else { b.is_ascii_digit() }
    }) {
        return Err(rejected());
    }
    let day = NaiveDate::parse_from_str(raw, "%Y-%m-%d").map_err(|_| rejected())?;
    let age = today.signed_duration_since(day).num_days();
    if !(0..=30).contains(&age) { return Err(rejected()); }
    Ok(day)
}

fn ist_offset() -> io::Result<FixedOffset> {
    FixedOffset::east_opt(5 * 3600 + 30 * 60).ok_or_else(rejected)
}

/// Strictly decode the actual Upstox historical-candle response shape.
/// The sixth array field is provider volume, not an event count. The QCB
/// observations field denotes one aggregated provider candle, NOT volume.
pub fn decode_upstox_v3_day(
    body: &[u8], date: NaiveDate, now_ms: u64,
) -> io::Result<Vec<Candle>> {
    if body.len() > 2_000_000 { return Err(rejected()); }
    let data: Value = serde_json::from_slice(body).map_err(|_| rejected())?;
    if data["status"] != "success" { return Err(rejected()); }
    let rows = data["data"]["candles"].as_array().ok_or_else(rejected)?;
    if rows.is_empty() || rows.len() > 2000 { return Err(rejected()); }
    let tz = ist_offset()?;
    let mut out = Vec::with_capacity(rows.len());
    for item in rows {
        let values = item.as_array().ok_or_else(rejected)?;
        if !(6..=7).contains(&values.len()) { return Err(rejected()); }
        let date_raw = values[0].as_str().ok_or_else(rejected)?;
        let timestamp = DateTime::parse_from_rfc3339(date_raw).map_err(|_| rejected())?;
        if timestamp.offset().fix() != tz
            || timestamp.date_naive() != date {
            return Err(rejected());
        }
        let milliseconds = timestamp.timestamp_millis();
        let ms = u64::try_from(milliseconds).map_err(|_| rejected())?;
        if ms == 0 || ms > now_ms || ms % 60_000 != 0 {
            return Err(rejected());
        }
        let numeric = |index: usize| -> io::Result<f64> {
            let n = values[index].as_f64().ok_or_else(rejected)?;
            if !n.is_finite() || n < 0.0 { return Err(rejected()); }
            Ok(n)
        };
        let o = numeric(1)?;
        let h = numeric(2)?;
        let l = numeric(3)?;
        let c = numeric(4)?;
        let volume = values[5].as_u64().ok_or_else(rejected)?;
        if volume > 100_000_000_000
            || l > o.min(c) || h < o.max(c) || h < l || c <= 0.0 {
            return Err(rejected());
        }
        if values.len() == 7 && values[6].as_u64().is_none() {
            return Err(rejected());
        }
        out.push(Candle {
            open_time_ms: ms, open: o, high: h, low: l, close: c,
            observations: 1,
        });
    }
    out.sort_by_key(|c| c.open_time_ms);
    if out.windows(2).any(|x| x[0].open_time_ms == x[1].open_time_ms) {
        return Err(rejected());
    }
    Ok(out)
}

fn series_for(key: &str) -> io::Result<String> {
    let digits = key.strip_prefix("NSE_FO|").ok_or_else(rejected)?;
    if digits.is_empty() || digits.len() > 24 || !digits.bytes().all(|c| c.is_ascii_digit()) {
        return Err(rejected());
    }
    Ok(format!("NSE_FO_{digits}"))
}

fn history_scope(settings: &WorkerSettings) -> Scope {
    Scope {
        tenant_id: settings.tenant.clone(), account_id: settings.account.clone(),
        source_id: "upstox_v3_history".into(), entitlement_id: settings.entitlement_id.clone(),
    }
}

/// Immutable owner-scoped leg archives: CE and PE separately; synchronized
/// straddle intrabar extrema CANNOT be derived from leg 1-minute OHLC.
pub fn archive_leg(
    root: &Path, settings: &WorkerSettings, key: &str,
    date: NaiveDate, candles: &[Candle], now_ms: u64,
) -> io::Result<()> {
    settings.validate(now_ms)?;
    if key != settings.ce_key && key != settings.pe_key { return Err(rejected()); }
    if candles.is_empty() || candles.len() > 2000 { return Err(rejected()); }
    // Validate the entire slice again at disk boundary; no foreign days.
    let offset = ist_offset()?;
    for bar in candles {
        let ms = i64::try_from(bar.open_time_ms).map_err(|_| rejected())?;
        let utc = DateTime::<Utc>::from_timestamp_millis(ms).ok_or_else(rejected)?;
        if utc.with_timezone(&offset).date_naive() != date { return Err(rejected()); }
    }
    let descriptor = SeriesDescriptor {
        scope: history_scope(settings), mode: DataMode::Replay,
        series_id: series_for(key)?, interval_ms: 60_000,
    };
    let partition = date.format("%Y%m").to_string();
    immutable_candles::publish(root, &partition, &descriptor, candles)
}

fn historical_url(key: &str, date: NaiveDate) -> io::Result<String> {
    series_for(key)?;
    let encoded = key.replace('|', "%7C");
    let day = date.format("%Y-%m-%d");
    Ok(format!("https://api.upstox.com/v3/historical-candle/{encoded}/minutes/1/{day}/{day}"))
}

#[derive(Debug, serde::Serialize)]
pub struct HistoryResult {
    pub schema: &'static str,
    pub broker_authenticated: bool,
    pub ce_candles: usize,
    pub pe_candles: usize,
    pub private_immutable_files: usize,
    pub history_display_public: bool,
    pub execution_enabled: bool,
}

/// One historical day, both legs. Fetch and validate BOTH complete responses
/// before touching the archive. The two independent immutable file publishes
/// are NOT a cross-file transaction: a storage failure can leave one leg.
/// Operators must audit the two matching partitions before serving charts.
pub async fn backfill_day(
    settings: &WorkerSettings, archive_root: &Path, day_raw: &str,
) -> io::Result<HistoryResult> {
    let now = epoch_ms()?;
    settings.validate(now)?;
    let local_now = DateTime::<Utc>::from_timestamp_millis(
        i64::try_from(now).map_err(|_| rejected())?
    ).ok_or_else(rejected)?.with_timezone(&ist_offset()?);
    let day = decode_day(day_raw, local_now.date_naive())?;
    crate::durable_market_wal::root_check(archive_root)?;
    let token = settings.private_history_token(now)?;
    let client = reqwest::Client::builder()
        .https_only(true).redirect(Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(12)).build().map_err(|_| rejected())?;
    let mut all = Vec::with_capacity(2);
    for key in [&settings.ce_key, &settings.pe_key] {
        let url = historical_url(key, day)?;
        let response = client.get(url).bearer_auth(&token)
            .header("Accept", "application/json")
            .send().await.map_err(|_| rejected())?;
        if response.status() != reqwest::StatusCode::OK { return Err(rejected()); }
        // Bound response before parsing; never print provider bodies.
        if response.content_length().is_some_and(|n| n > 2_000_000) {
            return Err(rejected());
        }
        let bytes = response.bytes().await.map_err(|_| rejected())?;
        all.push(decode_upstox_v3_day(&bytes, day, now)?);
    }
    let ce_candles = all[0].len();
    let pe_candles = all[1].len();
    archive_leg(archive_root, settings, &settings.ce_key, day, &all[0], now)?;
    archive_leg(archive_root, settings, &settings.pe_key, day, &all[1], now)?;
    Ok(HistoryResult {
        schema: "QSYN-UPSTOX-V3-HISTORY-RESULT/1", broker_authenticated: true,
        ce_candles, pe_candles, private_immutable_files: 2,
        history_display_public: false, execution_enabled: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_bars_require_real_offset_valid_ohlc_and_uniqueness() {
        let d = NaiveDate::from_ymd_opt(2026, 10, 9).unwrap();
        let valid = br#"{"status":"success","data":{"candles":[
          ["2026-10-09T09:16:00+05:30",98.0,104.0,97.0,102.0,500,10],
          ["2026-10-09T09:15:00+05:30",100.0,103.0,95.0,98.0,100,5]
        ]}}"#;
        let bars = decode_upstox_v3_day(valid, d, 1_800_000_000_000).unwrap();
        assert_eq!(bars.len(), 2);
        assert!(bars[0].open_time_ms < bars[1].open_time_ms);
        assert_eq!(bars[0].observations, 1);
        assert_eq!(bars[0].open, 100.0);
        assert!(decode_upstox_v3_day(valid, d, 1_000).is_err());
        let duplicate = br#"{"status":"success","data":{"candles":[
          ["2026-10-09T09:15:00+05:30",100,105,95,102,1,1],
          ["2026-10-09T09:15:00+05:30",100,105,95,102,1,1]
        ]}}"#;
        assert!(decode_upstox_v3_day(duplicate, d, 1_800_000_000_000).is_err());
        let foreign = br#"{"status":"success","data":{"candles":[
          ["2026-10-08T09:15:00+05:30",100,105,95,102,1,1]
        ]}}"#;
        assert!(decode_upstox_v3_day(foreign, d, 1_800_000_000_000).is_err());
        let wrong_timezone = br#"{"status":"success","data":{"candles":[
          ["2026-10-09T03:45:00+00:00",100,105,95,102,1,1]
        ]}}"#;
        assert!(decode_upstox_v3_day(wrong_timezone,d,1_800_000_000_000).is_err());
        assert!(decode_upstox_v3_day(br#"{"data":{"candles":[]}}"#,d,1_800_000_000_000).is_err());
        assert_eq!(historical_url("NSE_FO|12345",d).unwrap(),
            "https://api.upstox.com/v3/historical-candle/NSE_FO%7C12345/minutes/1/2026-10-09/2026-10-09");
        assert!(historical_url("NSE_EQ|something",d).is_err());
    }

    #[test]
    fn range_protection_prevents_public_arbitrary_dates() {
        let today=NaiveDate::from_ymd_opt(2026,10,11).unwrap();
        assert!(decode_day("2026-10-11",today).is_ok());
        assert!(decode_day("2026-10-09",today).is_ok());
        assert!(decode_day("2026-10-12",today).is_err());
        assert!(decode_day("2026-01-01",today).is_err());
        assert!(decode_day("../../etc",today).is_err());
    }
}
