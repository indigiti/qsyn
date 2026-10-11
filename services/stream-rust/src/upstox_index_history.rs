//! Licensed NSE/BSE V3 index-candle backfill into private immutable archives.
//! Read-only operator CLI, never a public index quote source or broker order.
//! Rights, BOD attestation and current OAuth are verified through IndexWorkerSettings.
use crate::durable_market_wal::root_check;
use crate::immutable_candles::{self, SeriesDescriptor};
use crate::market_pipeline::{Candle, DataMode, Scope};
use crate::private_chart_ws::epoch_ms;
use crate::upstox_history::decode_upstox_v3_day;
use crate::upstox_index_worker::IndexWorkerSettings;
use crate::upstox_v3::ApprovedIndexInstrument;
use chrono::{DateTime, FixedOffset, NaiveDate, Timelike, Utc};
use reqwest::redirect::Policy;
use serde::Serialize;
use std::io;
use std::path::Path;
use tokio::time::Duration;

fn denied() -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, "private_index_history_denied")
}

fn ist() -> io::Result<FixedOffset> {
    FixedOffset::east_opt(5 * 3600 + 30 * 60).ok_or_else(denied)
}

fn requested_day(value: &str, now_ms: u64) -> io::Result<NaiveDate> {
    if value.len() != 10
        || !value.bytes().enumerate().all(|(i, b)| {
            if i == 4 || i == 7 {
                b == b'-'
            } else {
                b.is_ascii_digit()
            }
        })
    {
        return Err(denied());
    }
    let day = NaiveDate::parse_from_str(value, "%Y-%m-%d").map_err(|_| denied())?;
    let today = DateTime::<Utc>::from_timestamp_millis(i64::try_from(now_ms).map_err(|_| denied())?)
        .ok_or_else(denied)?
        .with_timezone(&ist()?)
        .date_naive();
    if !(0..=30).contains(&today.signed_duration_since(day).num_days()) {
        return Err(denied());
    }
    Ok(day)
}

fn selected(
    settings: &IndexWorkerSettings,
    symbol: &str,
) -> io::Result<ApprovedIndexInstrument> {
    let mut found = settings.instruments.iter().filter(|i| i.symbol == symbol);
    let match_one = found.next().ok_or_else(denied)?;
    if found.next().is_some() {
        return Err(denied());
    }
    Ok(match_one.clone())
}

/// Only official mapped characters: percent encode the pipe and spaces;
/// no browser-selected URL or custom host is ever permitted.
fn encoded_key(key: &str) -> io::Result<String> {
    let (segment, name) = key.split_once('|').ok_or_else(denied)?;
    if !matches!(segment, "NSE_INDEX" | "BSE_INDEX")
        || name.is_empty()
        || name.len() > 100
        || !name.bytes().all(|b| {
            b.is_ascii_alphanumeric() || matches!(b, b' ' | b'_' | b'.' | b'-')
        })
    {
        return Err(denied());
    }
    Ok(format!("{}%7C{}", segment, name.replace(' ', "%20")))
}

fn provider_url(key: &str, date: NaiveDate, today: NaiveDate) -> io::Result<String> {
    let key = encoded_key(key)?;
    if date == today {
        Ok(format!(
            "https://api.upstox.com/v3/historical-candle/intraday/{key}/minutes/1"
        ))
    } else {
        let day = date.format("%Y-%m-%d");
        Ok(format!(
            "https://api.upstox.com/v3/historical-candle/{key}/minutes/1/{day}/{day}"
        ))
    }
}

/// Preserve only exchange-provided OHLC. One-minute index candles are never
/// reconstructed from individual last-traded-price snapshots.
pub fn validated_index_candles(
    body: &[u8],
    date: NaiveDate,
    now_ms: u64,
) -> io::Result<Vec<Candle>> {
    let candles = decode_upstox_v3_day(body, date, now_ms).map_err(|_| denied())?;
    let offset = ist()?;
    if candles.iter().any(|bar| {
        let Some(utc) = i64::try_from(bar.open_time_ms)
            .ok()
            .and_then(DateTime::<Utc>::from_timestamp_millis)
        else {
            return true;
        };
        let local = utc.with_timezone(&offset);
        let minute = local.hour() * 60 + local.minute();
        // The exact local cash-index session; no overnight or weekend bars.
        minute < 9 * 60 + 15 || minute >= 15 * 60 + 30
    }) {
        return Err(denied());
    }
    Ok(candles)
}

pub fn index_series(
    settings: &IndexWorkerSettings,
    symbol: &str,
    date: NaiveDate,
) -> io::Result<SeriesDescriptor> {
    let instrument = selected(settings, symbol)?;
    // The source/account/entitlement fields bind the immutable QCB archive
    // to the same private rights as the corresponding streaming index key.
    Ok(SeriesDescriptor {
        scope: Scope {
            tenant_id: settings.tenant.clone(),
            account_id: settings.account.clone(),
            source_id: "upstox_v3_index_history".into(),
            entitlement_id: settings.entitlement_id.clone(),
        },
        mode: DataMode::Replay,
        series_id: format!(
            "INDEX_{}_{}_{}",
            instrument.exchange,
            instrument.symbol,
            date.format("%Y%m%d")
        ),
        interval_ms: 60_000,
    })
}

pub fn preflight(
    settings: &IndexWorkerSettings,
    archive_root: &Path,
    day: &str,
    symbol: &str,
    now_ms: u64,
) -> io::Result<NaiveDate> {
    settings.validate(now_ms)?;
    root_check(archive_root)?;
    let date = requested_day(day, now_ms)?;
    let _ = index_series(settings, symbol, date)?;
    let now = DateTime::<Utc>::from_timestamp_millis(i64::try_from(now_ms).map_err(|_| denied())?)
        .ok_or_else(denied)?
        .with_timezone(&ist()?);
    // No immutable partial-current-day snapshots: wait for a completed session.
    if date == now.date_naive() && (now.hour(), now.minute()) < (15, 45) {
        return Err(denied());
    }
    Ok(date)
}

#[derive(Serialize, Debug)]
pub struct IndexHistoryResult {
    pub schema: &'static str,
    pub symbol: String,
    pub exchange: String,
    pub candles: usize,
    pub private_immutable_files: usize,
    pub data_present: bool,
    pub history_display_public: bool,
    pub execution_enabled: bool,
}

pub async fn backfill_day(
    settings: &IndexWorkerSettings,
    archive_root: &Path,
    day: &str,
    symbol: &str,
) -> io::Result<IndexHistoryResult> {
    let now = epoch_ms()?;
    let date = preflight(settings, archive_root, day, symbol, now)?;
    let index = selected(settings, symbol)?;
    let today = DateTime::<Utc>::from_timestamp_millis(i64::try_from(now).map_err(|_| denied())?)
        .ok_or_else(denied)?
        .with_timezone(&ist()?)
        .date_naive();
    let url = provider_url(&index.instrument_key, date, today)?;
    let token = settings.history_token(now)?;
    let client = reqwest::Client::builder()
        .https_only(true)
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|_| denied())?;
    let response = client
        .get(url)
        .bearer_auth(&token)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|_| denied())?;
    if response.status() != reqwest::StatusCode::OK
        || response.content_length().is_some_and(|n| n > 2_000_000)
    {
        return Err(denied());
    }
    let bytes = response.bytes().await.map_err(|_| denied())?;
    if bytes.len() > 2_000_000 {
        return Err(denied());
    }
    // A successful empty provider result means no archived candles, not a
    // certified exchange holiday or a completed backfill.
    let decoded: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| denied())?;
    let rows = decoded["data"]["candles"].as_array().ok_or_else(denied)?;
    if decoded["status"] != "success" || rows.len() > 2000 {
        return Err(denied());
    }
    let mut result = IndexHistoryResult {
        schema: "QSYN-UPSTOX-V3-INDEX-HISTORY-RESULT/1",
        symbol: symbol.into(),
        exchange: index.exchange,
        candles: 0,
        private_immutable_files: 0,
        data_present: false,
        history_display_public: false,
        execution_enabled: false,
    };
    if rows.is_empty() {
        return Ok(result);
    }
    let candles = validated_index_candles(&bytes, date, now)?;
    // Recheck legal rights, session and today's BOD immediately before write.
    preflight(settings, archive_root, day, symbol, epoch_ms()?)?;
    let descriptor = index_series(settings, symbol, date)?;
    immutable_candles::publish(
        archive_root,
        &date.format("%Y%m").to_string(),
        &descriptor,
        &candles,
    )?;
    result.candles = candles.len();
    result.private_immutable_files = 1;
    result.data_present = true;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_and_key_are_strict_provider_index_only() {
        let day = NaiveDate::from_ymd_opt(2026, 10, 9).unwrap();
        let today = NaiveDate::from_ymd_opt(2026, 10, 12).unwrap();
        assert_eq!(
            provider_url("NSE_INDEX|Nifty 50", day, today).unwrap(),
            "https://api.upstox.com/v3/historical-candle/NSE_INDEX%7CNifty%2050/minutes/1/2026-10-09/2026-10-09"
        );
        assert_eq!(
            provider_url("BSE_INDEX|SENSEX", today, today).unwrap(),
            "https://api.upstox.com/v3/historical-candle/intraday/BSE_INDEX%7CSENSEX/minutes/1"
        );
        for invalid in [
            "NSE_EQ|INE100",
            "NSE_INDEX|../../other",
            "NSE_INDEX|Nifty/50",
            "NSE_INDEX|",
            "NSE_INDEX|Nifty?access_token=x",
        ] {
            assert!(encoded_key(invalid).is_err());
        }
    }

    #[test]
    fn rejects_foreign_day_and_outside_market_hours() {
        let day = NaiveDate::from_ymd_opt(2026, 10, 9).unwrap();
        let valid = br#"{"status":"success","data":{"candles":[
            ["2026-10-09T09:16:00+05:30",100,105,99,104,0,0],
            ["2026-10-09T09:15:00+05:30",101,103,100,102,0,0]
        ]}}"#;
        let candles = validated_index_candles(valid, day, 1_800_000_000_000).unwrap();
        assert_eq!(candles.len(), 2);
        assert!(candles[0].open_time_ms < candles[1].open_time_ms);
        let out_of_hours = br#"{"status":"success","data":{"candles":[
            ["2026-10-09T09:00:00+05:30",100,105,99,104,0,0]
        ]}}"#;
        assert!(validated_index_candles(out_of_hours, day, 1_800_000_000_000).is_err());
        assert!(validated_index_candles(valid, NaiveDate::from_ymd_opt(2026, 10, 8).unwrap(),
            1_800_000_000_000).is_err());
        let duplicate = br#"{"status":"success","data":{"candles":[
            ["2026-10-09T09:15:00+05:30",100,105,99,104,0,0],
            ["2026-10-09T09:15:00+05:30",100,105,99,104,0,0]
        ]}}"#;
        assert!(validated_index_candles(duplicate, day, 1_800_000_000_000).is_err());
    }

    #[test]
    fn date_rejects_future_old_and_bad_values() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-10-12T16:00:00+05:30")
            .unwrap()
            .timestamp_millis() as u64;
        assert!(requested_day("2026-10-12", now).is_ok());
        assert!(requested_day("2026-10-10", now).is_ok());
        assert!(requested_day("2026-10-13", now).is_err());
        assert!(requested_day("2026-08-01", now).is_err());
        assert!(requested_day("10-12-2026", now).is_err());
    }
}
