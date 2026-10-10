//! QSYN synthetic-candle core. No broker credentials or network calls.
//! OHLC is derived from simultaneously valued synthetic observations,
//! never from independently aggregated constituent highs and lows.

pub mod market_pipeline;
pub mod durable_market_wal;
pub mod immutable_candles;
pub mod offline_rebuild;
pub mod openalgo_stream;
pub mod private_live_pipeline;
pub mod chart_entitlement;
pub mod paper_oms;
pub mod authorized_ingest;
pub mod history_backfill;
pub mod private_chart_hub;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Leg {
    Call,
    Put,
}

#[derive(Clone, Copy, Debug)]
pub struct Tick {
    pub leg: Leg,
    pub timestamp_ms: u64,
    pub price: f64,
}

#[derive(Clone, Copy, Debug)]
struct Quote {
    timestamp_ms: u64,
    price: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Candle {
    /// UNIX seconds at the opening of the 60-second bar.
    pub time: u64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    /// Count of synthetic observations, not exchange trade volume.
    pub observations: u64,
}

#[derive(Debug)]
pub struct StraddleBuilder {
    call: Option<Quote>,
    put: Option<Quote>,
    max_skew_ms: u64,
    candle: Option<Candle>,
    last_emitted_ms: Option<u64>,
}

impl StraddleBuilder {
    pub fn new(max_skew_ms: u64) -> Self {
        Self { call: None, put: None, max_skew_ms, candle: None, last_emitted_ms: None }
    }

    /// Processes valid, non-stale quotes. Returns the currently forming synthetic candle
    /// when both legs are within the configured timestamp skew threshold.
    pub fn on_tick(&mut self, tick: Tick) -> Option<Candle> {
        if !tick.price.is_finite() || tick.price <= 0.0 {
            return None;
        }

        let previous = match tick.leg {
            Leg::Call => self.call,
            Leg::Put => self.put,
        };
        if previous.is_some_and(|old| tick.timestamp_ms < old.timestamp_ms) {
            return None; // never move source clock backwards
        }

        let incoming = Quote { timestamp_ms: tick.timestamp_ms, price: tick.price };
        match tick.leg {
            Leg::Call => self.call = Some(incoming),
            Leg::Put => self.put = Some(incoming),
        }

        let (call, put) = match (self.call, self.put) {
            (Some(c), Some(p)) => (c, p),
            _ => return None,
        };
        let newest = call.timestamp_ms.max(put.timestamp_ms);
        let oldest = call.timestamp_ms.min(put.timestamp_ms);
        if newest - oldest > self.max_skew_ms ||
            self.last_emitted_ms.is_some_and(|last| newest < last) {
            return None;
        }

        let price = call.price + put.price;
        let minute = newest / 60_000 * 60;
        let updated = match self.candle {
            Some(mut current) if current.time == minute => {
                current.high = current.high.max(price);
                current.low = current.low.min(price);
                current.close = price;
                current.observations += 1;
                current
            }
            _ => Candle {
                time: minute,
                open: price,
                high: price,
                low: price,
                close: price,
                observations: 1,
            },
        };
        self.last_emitted_ms = Some(newest);
        self.candle = Some(updated);
        Some(updated)
    }

    pub fn current(&self) -> Option<Candle> {
        self.candle
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn synthetic_high_uses_aligned_prices_not_sum_of_leg_highs() {
        let mut b = StraddleBuilder::new(2_000);
        assert!(b.on_tick(Tick { leg: Leg::Call, timestamp_ms: 60_000, price: 100.0 }).is_none());
        let first = b.on_tick(Tick { leg: Leg::Put, timestamp_ms: 60_000, price: 120.0 }).unwrap();
        assert_eq!(first.open, 220.0);
        let next = b.on_tick(Tick { leg: Leg::Call, timestamp_ms: 60_100, price: 150.0 }).unwrap();
        assert_eq!(next.high, 270.0);
        b.on_tick(Tick { leg: Leg::Call, timestamp_ms: 60_200, price: 90.0 }).unwrap();
        let result = b.on_tick(Tick { leg: Leg::Put, timestamp_ms: 60_300, price: 180.0 }).unwrap();
        assert_eq!(result.high, 270.0); // NOT 150 + 180 = 330
        assert_eq!(result.close, 270.0);
    }

    #[test]
    fn refuses_stale_legs_and_out_of_order_events() {
        let mut b = StraddleBuilder::new(100);
        assert!(b.on_tick(Tick { leg: Leg::Call, timestamp_ms: 1000, price: 100.0 }).is_none());
        assert!(b.on_tick(Tick { leg: Leg::Put, timestamp_ms: 1700, price: 110.0 }).is_none());
        assert!(b.on_tick(Tick { leg: Leg::Call, timestamp_ms: 1700, price: 90.0 }).is_some());
        assert!(b.on_tick(Tick { leg: Leg::Call, timestamp_ms: 1200, price: 1000.0 }).is_none());
        assert_eq!(b.current().unwrap().close, 200.0);
    }

    #[test]
    fn starts_new_candle_at_next_minute_and_rejects_invalid_prices() {
        let mut b = StraddleBuilder::new(1000);
        assert!(b.on_tick(Tick { leg: Leg::Call, timestamp_ms: 119_900, price: -1.0 }).is_none());
        b.on_tick(Tick { leg: Leg::Call, timestamp_ms: 119_900, price: 100.0 });
        b.on_tick(Tick { leg: Leg::Put, timestamp_ms: 119_900, price: 120.0 }).unwrap();
        let next = b.on_tick(Tick { leg: Leg::Call, timestamp_ms: 120_000, price: 101.0 }).unwrap();
        assert_eq!(next.time, 120);
        assert_eq!(next.open, 221.0);
        assert_eq!(next.observations, 1);
    }
}

pub mod order_lifecycle;
pub mod private_chart_ws;
