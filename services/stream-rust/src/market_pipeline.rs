//! Normalized, scoped market-event pipeline and replayable integrity journal.
//! No Upstox/OpenAlgo network adapter, broker credentials, or order APIs.
//! Future authorized adapters must supply externally-verified entitlements;
//! public demo data must never be labeled as a licensed exchange source.
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::Path;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DataMode {
    Simulated,
    Replay,
    AuthorizedLive,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Scope {
    pub tenant_id: String,
    pub account_id: String,
    pub source_id: String,
    pub entitlement_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NormalizedQuote {
    pub scope: Scope,
    pub instrument_id: String,
    pub timestamp_ms: u64,
    pub sequence: u64,
    pub price: f64,
    pub mode: DataMode,
}

#[derive(Clone, Debug)]
pub struct WeightedLeg {
    pub instrument_id: String,
    pub quantity: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Candle {
    pub open_time_ms: u64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub observations: u32,
}

#[derive(Clone, Debug)]
pub struct ScopedBasket {
    scope: Scope,
    mode: DataMode,
    legs: Vec<WeightedLeg>,
    max_age_ms: u64,
    seen: HashMap<String, (u64, u64, f64)>,
    current: Option<Candle>,
}

impl ScopedBasket {
    pub fn new(scope: Scope, mode: DataMode, legs: Vec<WeightedLeg>, max_age_ms: u64)
        -> Result<Self, &'static str>
    {
        if scope.tenant_id.is_empty() || scope.account_id.is_empty()
            || scope.source_id.is_empty() || scope.entitlement_id.is_empty()
            || legs.is_empty() || legs.len() > 8 || max_age_ms > 60_000
        {
            return Err("invalid_source_scope_or_legs");
        }
        let mut ids = std::collections::HashSet::new();
        if legs.iter().any(|l| l.instrument_id.is_empty() || l.instrument_id.len() > 128
            || !l.quantity.is_finite() || l.quantity <= 0.0
            || l.quantity > 100.0 || !ids.insert(l.instrument_id.clone()))
        {
            return Err("duplicate_or_invalid_leg");
        }
        Ok(Self { scope, mode, legs, max_age_ms, seen: HashMap::new(), current: None })
    }

    pub fn on_quote(&mut self, quote: &NormalizedQuote) -> Option<Candle> {
        if quote.scope != self.scope || quote.mode != self.mode
            || !quote.price.is_finite() || quote.price <= 0.0
            || quote.instrument_id.is_empty() || quote.timestamp_ms == 0
            || !self.legs.iter().any(|l| l.instrument_id == quote.instrument_id)
        {
            return None;
        }
        if let Some(&(last_ts, last_seq, _)) = self.seen.get(&quote.instrument_id) {
            if quote.timestamp_ms < last_ts || quote.sequence <= last_seq {
                return None;
            }
        }
        if let Some(candle) = &self.current {
            if quote.timestamp_ms / 60_000 * 60_000 < candle.open_time_ms {
                return None;
            }
        }
        self.seen.insert(quote.instrument_id.clone(),
            (quote.timestamp_ms, quote.sequence, quote.price));
        let mut newest = 0u64;
        let mut oldest = u64::MAX;
        let mut weighted = 0.0;
        for leg in &self.legs {
            let (ts, _, price) = self.seen.get(&leg.instrument_id)?;
            newest = newest.max(*ts);
            oldest = oldest.min(*ts);
            weighted += *price * leg.quantity;
        }
        if newest - oldest > self.max_age_ms || !weighted.is_finite() {
            return None;
        }
        let open_time_ms = newest / 60_000 * 60_000;
        let candle = match &self.current {
            Some(c) if c.open_time_ms == open_time_ms => Candle {
                open_time_ms, open: c.open,
                high: c.high.max(weighted), low: c.low.min(weighted),
                close: weighted, observations: c.observations.saturating_add(1),
            },
            _ => Candle { open_time_ms, open: weighted,
                high: weighted, low: weighted, close: weighted, observations: 1 },
        };
        self.current = Some(candle.clone());
        Some(candle)
    }

    pub fn current(&self) -> Option<&Candle> {
        self.current.as_ref()
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct JournalRow {
    schema: String,
    checksum: String,
    quote: NormalizedQuote,
}

/// Integrity check for accidental corruption, not an authentication MAC.
/// Journal is an append-only demo/test component, not production WAL/recovery.
fn checksum(data: &[u8]) -> String {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for b in data {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

pub struct ReplayJournal;

impl ReplayJournal {
    pub fn append(path: &Path, quote: &NormalizedQuote) -> std::io::Result<()> {
        if !quote.price.is_finite() || quote.price <= 0.0 {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid_quote"));
        }
        let payload = serde_json::to_vec(quote)?;
        let row = JournalRow {
            schema: "QSYN-NORMALIZED-JOURNAL/1".to_owned(),
            checksum: checksum(&payload),
            quote: quote.clone(),
        };
        let writer = OpenOptions::new().create(true).append(true).open(path)?;
        let mut writer = BufWriter::new(writer);
        serde_json::to_writer(&mut writer, &row)?;
        writer.write_all(b"\n")?;
        writer.flush()?;
        writer.get_ref().sync_data()?;
        Ok(())
    }

    pub fn replay(path: &Path) -> std::io::Result<Vec<NormalizedQuote>> {
        let reader = BufReader::new(File::open(path)?);
        let mut output = Vec::new();
        for (i, line) in reader.lines().enumerate() {
            if i >= 100_000 {
                return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "journal_limit"));
            }
            let line = line?;
            if line.len() > 16_384 {
                return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "oversized_row"));
            }
            let row: JournalRow = serde_json::from_str(&line)?;
            let content = serde_json::to_vec(&row.quote)?;
            if row.schema != "QSYN-NORMALIZED-JOURNAL/1"
                || row.checksum != checksum(&content)
            {
                return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "checksum_mismatch"));
            }
            output.push(row.quote);
        }
        Ok(output)
    }

    pub fn latest_by_instrument(events: &[NormalizedQuote]) -> BTreeMap<String, (u64, f64)> {
        let mut latest = BTreeMap::new();
        for q in events {
            if q.price > 0.0 && q.price.is_finite() {
                let key = format!("{}:{}:{}:{}:{}", q.scope.tenant_id,
                    q.scope.account_id, q.scope.source_id,
                    q.scope.entitlement_id, q.instrument_id);
                let current: Option<&(u64, f64)> = latest.get(&key);
                if current.is_none_or(|(ts, _)| q.timestamp_ms >= *ts) {
                    latest.insert(key, (q.timestamp_ms, q.price));
                }
            }
        }
        latest
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn scope() -> Scope {
        Scope { tenant_id: "tenant1".into(), account_id: "demoA".into(),
            source_id: "fixture".into(), entitlement_id: "simulated".into() }
    }
    fn q(id: &str, ts: u64, seq: u64, price: f64) -> NormalizedQuote {
        NormalizedQuote { scope: scope(), instrument_id: id.into(), timestamp_ms: ts,
            sequence: seq, price, mode: DataMode::Simulated }
    }
    #[test]
    fn rejects_foreign_scopes_replay_mode_staleness_and_duplicates() {
        let legs = vec![
            WeightedLeg { instrument_id: "CE".into(), quantity: 2.0 },
            WeightedLeg { instrument_id: "PE".into(), quantity: 1.0 },
        ];
        assert!(ScopedBasket::new(scope(), DataMode::Simulated,
            vec![legs[0].clone(), legs[0].clone()], 100).is_err());
        let mut engine = ScopedBasket::new(scope(), DataMode::Simulated, legs, 200).unwrap();
        assert!(engine.on_quote(&q("CE", 60_000, 1, 100.0)).is_none());
        let mut foreign = q("PE", 60_000, 1, 120.0);
        foreign.scope.account_id = "demoB".into();
        assert!(engine.on_quote(&foreign).is_none());
        foreign = q("PE", 60_000, 1, 120.0);
        foreign.mode = DataMode::AuthorizedLive;
        assert!(engine.on_quote(&foreign).is_none());
        let first = engine.on_quote(&q("PE", 60_000, 1, 120.0)).unwrap();
        assert_eq!(first.open, 320.0);
        assert!(engine.on_quote(&q("PE", 60_000, 1, 140.0)).is_none());
        assert!(engine.on_quote(&q("CE", 59_999, 2, 500.0)).is_none());
        let changed = engine.on_quote(&q("CE", 60_100, 2, 130.0)).unwrap();
        assert_eq!(changed.high, 380.0);
        assert_eq!(changed.close, 380.0);
        let stale = engine.on_quote(&q("PE", 60_550, 2, 500.0));
        assert!(stale.is_none());
        assert_eq!(engine.current().unwrap().high, 380.0);
        let rollover = engine.on_quote(&q("CE", 120_000, 3, 110.0));
        assert!(rollover.is_none());
        let rollover = engine.on_quote(&q("PE", 120_050, 3, 150.0)).unwrap();
        assert_eq!(rollover.open_time_ms, 120_000);
        assert_eq!(rollover.open, 370.0);
    }

    #[test]
    fn integrity_journal_replays_and_fails_on_tampering() {
        let file = std::env::temp_dir().join(format!(
            "qsyn-replay-{}-{:?}.jsonl", std::process::id(), std::thread::current().id()));
        let _ = std::fs::remove_file(&file);
        ReplayJournal::append(&file, &q("CE", 60_000, 1, 91.0)).unwrap();
        ReplayJournal::append(&file, &q("PE", 60_010, 1, 120.0)).unwrap();
        let restored = ReplayJournal::replay(&file).unwrap();
        assert_eq!(restored.len(), 2);
        assert_eq!(ReplayJournal::latest_by_instrument(&restored).len(), 2);
        let mut corrupted = std::fs::read_to_string(&file).unwrap();
        corrupted = corrupted.replacen("91.0", "92.0", 1);
        std::fs::write(&file, corrupted).unwrap();
        assert!(ReplayJournal::replay(&file).is_err());
        std::fs::remove_file(&file).unwrap();
    }
}
