//! Genuine account-scoped Upstox V3 OHLCV history, using the existing
//! qsyn-stream binary and private Analytics Token. No trading or extra ELF.
use chrono::{DateTime, FixedOffset, NaiveDate, Offset, Utc};
use serde_json::{json, Value};
use std::{io, path::Path, time::{SystemTime, UNIX_EPOCH}};
use tokio::time::Duration;

const MAX_RESPONSE: usize = 1_048_576;
const MAX_BARS: usize = 1_800;

fn denied() -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, "private_instrument_history_unavailable")
}
pub fn valid_instrument_key(key: &str) -> bool {
    let Some((segment, id)) = key.split_once('|') else { return false };
    let segments = [
        "NSE_EQ", "BSE_EQ", "NSE_INDEX", "BSE_INDEX",
        "NSE_FO", "BSE_FO", "NCD_FO", "BCD_FO", "MCX_FO", "NSE_COM"
    ];
    segments.contains(&segment) && !id.is_empty() && id.len() <= 100
        && id.bytes().all(|c| c.is_ascii_alphanumeric()
            || c == b' ' || c == b'.' || c == b'_' || c == b'-')
}
fn now_ms() -> io::Result<u64> {
    Ok(SystemTime::now().duration_since(UNIX_EPOCH)
        .map_err(|_| denied())?.as_millis() as u64)
}
fn valid_day(raw: &str, now: u64) -> io::Result<NaiveDate> {
    let day = NaiveDate::parse_from_str(raw, "%Y-%m-%d").map_err(|_| denied())?;
    if day.format("%Y-%m-%d").to_string() != raw { return Err(denied()); }
    let tz = FixedOffset::east_opt(19800).ok_or_else(denied)?;
    let today = DateTime::<Utc>::from_timestamp_millis(now as i64)
        .ok_or_else(denied)?.with_timezone(&tz).date_naive();
    if day < NaiveDate::from_ymd_opt(2022, 1, 1).ok_or_else(denied)?
        || day > today { return Err(denied()); }
    Ok(day)
}
/// Validates each source candle. The numeric zero is only a format placeholder
/// when Upstox did not provide traded volume; never replace missing with ticks.
pub fn decode_instrument_day(
    bytes: &[u8], instrument: &str, day: NaiveDate, now: u64
) -> io::Result<Vec<Value>> {
    if !valid_instrument_key(instrument) || bytes.len() > MAX_RESPONSE {
        return Err(denied());
    }
    let value: Value = serde_json::from_slice(bytes).map_err(|_| denied())?;
    if value["status"] != "success" { return Err(denied()); }
    let records = value["data"]["candles"].as_array().ok_or_else(denied)?;
    if records.len() > MAX_BARS { return Err(denied()); }
    let index = instrument.starts_with("NSE_INDEX|") || instrument.starts_with("BSE_INDEX|");
    let tz = FixedOffset::east_opt(19800).ok_or_else(denied)?;
    let mut candles = Vec::with_capacity(records.len());
    for row in records {
        let v = row.as_array().ok_or_else(denied)?;
        if !(6..=7).contains(&v.len()) { return Err(denied()); }
        let timestamp = DateTime::parse_from_rfc3339(v[0].as_str().ok_or_else(denied)?)
            .map_err(|_| denied())?;
        if timestamp.offset().fix() != tz || timestamp.date_naive() != day {
            return Err(denied());
        }
        let ms = u64::try_from(timestamp.timestamp_millis()).map_err(|_| denied())?;
        if ms == 0 || ms > now || ms % 60_000 != 0 { return Err(denied()); }
        let number = |n: usize| -> io::Result<f64> {
            let x = v[n].as_f64().ok_or_else(denied)?;
            if !x.is_finite() || x <= 0.0 { return Err(denied()); }
            Ok(x)
        };
        let (open, high, low, close) = (number(1)?, number(2)?, number(3)?, number(4)?);
        if high < open.max(close) || low > open.min(close) || high < low {
            return Err(denied());
        }
        let raw_volume = if v[5].is_null() { None } else {
            Some(v[5].as_u64().ok_or_else(denied)?)
        };
        let oi = if v.len() == 7 && !v[6].is_null() {
            Some(v[6].as_u64().ok_or_else(denied)?)
        } else { None };
        let volume = if index { None } else { raw_volume };
        candles.push(json!({
            "time":ms/1000,"open":open,"high":high,"low":low,"close":close,
            "volume":volume.unwrap_or(0),"volume_available":volume.is_some(),
            "open_interest":oi,
        }));
    }
    candles.sort_by_key(|bar| bar["time"].as_u64().unwrap_or(0));
    if candles.windows(2).any(|w| w[0]["time"] == w[1]["time"]) {
        return Err(denied());
    }
    Ok(candles)
}
pub async fn history(instrument: &str, date: &str, runtime: &Path) -> io::Result<Value> {
    if !valid_instrument_key(instrument) { return Err(denied()); }
    let now = now_ms()?;
    let day = valid_day(date, now)?;
    let today = valid_day(
        &DateTime::<Utc>::from_timestamp_millis(now as i64)
            .ok_or_else(denied)?.with_timezone(
                &FixedOffset::east_opt(19800).ok_or_else(denied)?
            ).format("%Y-%m-%d").to_string(), now
    )?;
    let escaped = instrument.replace('|', "%7C").replace(' ', "%20");
    let url = if day == today {
        format!("https://api.upstox.com/v3/historical-candle/intraday/{escaped}/minutes/1")
    } else {
        format!("https://api.upstox.com/v3/historical-candle/{escaped}/minutes/1/{date}/{date}")
    };
    let token = crate::personal_index::read_token(runtime)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(17))
        .build().map_err(|_| denied())?;
    let response = client.get(url).bearer_auth(token)
        .header("Accept", "application/json").send().await.map_err(|_| denied())?;
    if response.status() != reqwest::StatusCode::OK
        || response.content_length().is_some_and(|n| n > MAX_RESPONSE as u64) {
        return Err(denied());
    }
    let bytes = response.bytes().await.map_err(|_| denied())?;
    let bars = decode_instrument_day(&bytes, instrument, day, now)?;
    Ok(json!({
        "schema":"QSYN-UPSTOX-INSTRUMENT-HISTORY/1",
        "source":"upstox_v3_private_instrument_history",
        "instrument_key":instrument,"day_ist":date,"interval":"1m",
        "bars":bars,"trading_enabled":false,"public_redistribution_allowed":false,
        "live_feed_verified":false
    }))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn instrument_key_is_strict_and_never_a_client_url() {
        assert!(valid_instrument_key("NSE_EQ|INE002A01018"));
        assert!(valid_instrument_key("NSE_FO|157318"));
        assert!(valid_instrument_key("MCX_FO|89897"));
        assert!(!valid_instrument_key("NSE_EQ|../token"));
        assert!(!valid_instrument_key("https://api.upstox.com/secret"));
        assert!(!valid_instrument_key("NSE_FO|123?foo=bar"));
    }
    #[test]
    fn equity_volume_and_oi_are_provider_observations() {
        let day = NaiveDate::from_ymd_opt(2026, 10, 9).unwrap();
        let sample = br#"{"status":"success","data":{"candles":[
            ["2026-10-09T09:16:00+05:30",100,102,99,101,150,2400],
            ["2026-10-09T09:15:00+05:30",99,101,98,100,null,null]
        ]}}"#;
        let rows = decode_instrument_day(sample, "NSE_EQ|INE002A01018",
            day, 1_800_000_000_000).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1]["volume"], 150);
        assert_eq!(rows[1]["open_interest"], 2400);
        assert_eq!(rows[0]["volume_available"], false);
        let index = decode_instrument_day(sample, "NSE_INDEX|Nifty 50",
            day, 1_800_000_000_000).unwrap();
        assert_eq!(index[1]["volume"], 0);
        assert_eq!(index[1]["volume_available"], false);
        assert!(decode_instrument_day(sample, "NSE_EQ|../../x",
            day, 1_800_000_000_000).is_err());
    }
}
