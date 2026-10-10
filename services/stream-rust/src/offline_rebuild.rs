//! Offline end-to-end quote WAL -> synchronized synthetic candle -> immutable block.
//! No broker connection, OAuth, public websocket, background daemon or trade API.
use crate::durable_market_wal;
use crate::immutable_candles::{self, SeriesDescriptor};
use crate::market_pipeline::{Candle, DataMode, ScopedBasket, WeightedLeg};
use std::io;
use std::path::Path;

pub fn rebuild_offline_basket(
    wal_root: &Path,
    candle_root: &Path,
    partition: &str,
    descriptor: &SeriesDescriptor,
    legs: &[WeightedLeg],
    start_ms: u64,
    end_ms: u64,
    max_leg_skew_ms: u64,
) -> io::Result<usize> {
    // Live source data requires a separate independently authorized ingestion
    // and entitlement layer. The offline adapter must never invent it.
    if descriptor.mode == DataMode::AuthorizedLive
        || descriptor.interval_ms != 60_000
        || legs.is_empty()
        || legs.len() > 8
        || start_ms > end_ms
    {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "offline_demo_only"));
    }
    let mut engine = ScopedBasket::new(
        descriptor.scope.clone(),
        descriptor.mode.clone(),
        legs.to_vec(),
        max_leg_skew_ms,
    ).map_err(|message| io::Error::new(io::ErrorKind::InvalidInput, message))?;

    let mut quotes = Vec::new();
    for leg in legs {
        let events = durable_market_wal::query(
            wal_root, &descriptor.scope, &descriptor.mode, &leg.instrument_id,
            start_ms, end_ms, 5_000,
        )?;
        if events.len() == 5_000 {
            // Cannot prove this finite read captured all input events.
            return Err(io::Error::new(io::ErrorKind::InvalidData, "replay_window_may_be_truncated"));
        }
        quotes.extend(events);
    }
    if quotes.is_empty() {
        return Err(io::Error::new(io::ErrorKind::NotFound, "no_scoped_quote_events"));
    }
    // Event clock is the source timestamp; source sequence resolves ties.
    // Arrival-time order must not be mistaken for wall-clock simultaneity.
    quotes.sort_by_key(|q| (q.timestamp_ms, q.sequence, q.instrument_id.clone()));
    let mut result: Vec<Candle> = Vec::new();
    let mut building: Option<Candle> = None;
    for quote in quotes {
        if let Some(current) = engine.on_quote(&quote) {
            if let Some(previous) = building.take() {
                if previous.open_time_ms < current.open_time_ms {
                    result.push(previous);
                } else if previous.open_time_ms > current.open_time_ms {
                    return Err(io::Error::new(io::ErrorKind::InvalidData, "replay_clock_regressed"));
                }
            }
            building = Some(current);
        }
    }
    // The final candle has no observed successor minute and therefore
    // remains forming. Do not label it immutable/final.
    if result.is_empty() {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "no_finalized_bars"));
    }
    immutable_candles::publish(candle_root, partition, descriptor, &result)?;
    Ok(result.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::durable_market_wal::DurableMarketWal;
    use crate::immutable_candles::CandlePartition;
    use crate::market_pipeline::{NormalizedQuote, Scope};
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Fixture {
        wal: std::path::PathBuf,
        candles: std::path::PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
            let root = std::env::temp_dir().join(format!("qsyn-rebuild-{}-{unique}", std::process::id()));
            let wal = root.join("wal");
            let candles = root.join("candles");
            fs::create_dir_all(&wal).unwrap();
            fs::create_dir_all(&candles).unwrap();
            #[cfg(unix)]
            for dir in [&wal, &candles] {
                fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).unwrap();
            }
            Self { wal, candles }
        }
        fn scope(&self) -> Scope {
            Scope { tenant_id: "tenant".into(), account_id: "A".into(),
                source_id: "sim".into(), entitlement_id: "fixture".into() }
        }
        fn descriptor(&self) -> SeriesDescriptor {
            SeriesDescriptor { scope: self.scope(), mode: DataMode::Simulated,
                series_id: "atm_straddle".into(), interval_ms: 60_000 }
        }
        fn quote(&self, instrument: &str, seq: u64, ms: u64, price: f64, account: &str) -> NormalizedQuote {
            let mut scope = self.scope();
            scope.account_id = account.into();
            NormalizedQuote {
                scope, instrument_id: instrument.into(),
                timestamp_ms: ms, sequence: seq, price, mode: DataMode::Simulated,
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            if let Some(root) = self.wal.parent() { let _ = fs::remove_dir_all(root); }
        }
    }

    #[test]
    fn scoped_events_rebuild_only_finalized_synthetic_highs_and_lows() {
        let fixture = Fixture::new();
        let mut wal = DurableMarketWal::open(&fixture.wal).unwrap();
        let samples = [
            ("CE", 60_000, 50.0, "A"), ("PE", 60_010, 100.0, "A"),
            ("CE", 60_500, 70.0, "A"), ("PE", 60_510, 80.0, "A"),
            ("CE", 61_000, 65.0, "A"), ("PE", 61_010, 110.0, "A"),
            ("CE", 61_500, 60.0, "B"), ("PE", 61_510, 999.0, "B"),
            ("CE", 120_000, 60.0, "A"), ("PE", 120_010, 90.0, "A"),
        ];
        for (i, (instrument, ts, price, account)) in samples.iter().enumerate() {
            wal.append(&fixture.quote(instrument, i as u64 + 1, *ts, *price, account)).unwrap();
        }
        drop(wal);
        let legs = vec![
            WeightedLeg { instrument_id: "CE".into(), quantity: 1.0 },
            WeightedLeg { instrument_id: "PE".into(), quantity: 1.0 },
        ];
        let count = rebuild_offline_basket(
            &fixture.wal, &fixture.candles, "202610",
            &fixture.descriptor(), &legs, 60_000, 150_000, 100,
        ).unwrap();
        assert_eq!(count, 1);
        let mut part = CandlePartition::open(
            &fixture.candles, "202610", &fixture.descriptor(),
        ).unwrap();
        let rows = part.range(0, u64::MAX, 10).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].open, 150.0);
        assert_eq!(rows[0].high, 175.0);
        assert_eq!(rows[0].low, 150.0);
        assert_eq!(rows[0].close, 175.0);
        assert_eq!(rows[0].observations, 5);
        let mut foreign = fixture.descriptor();
        foreign.scope.account_id = "B".into();
        assert!(CandlePartition::open(&fixture.candles, "202610", &foreign).is_err());
    }
    #[test]
    fn denies_fake_live_provenance_and_empty_replay() {
        let fixture = Fixture::new();
        let descriptor = fixture.descriptor();
        let legs = [WeightedLeg { instrument_id: "CE".into(), quantity: 1.0 }];
        let mut live = descriptor.clone();
        live.mode = DataMode::AuthorizedLive;
        assert!(rebuild_offline_basket(
            &fixture.wal, &fixture.candles, "202610", &live, &legs, 0, 1, 100,
        ).is_err());
    }
}
