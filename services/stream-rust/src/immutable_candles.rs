//! Immutable, indexed, account-scoped candle partitions.
//! Offline-only library: NOT wired to Upstox, publicly queryable HTTP,
//! a trading account, retention automation or exchange distribution rights.
use crate::durable_market_wal::{crc32, root_check};
use crate::market_pipeline::{Candle, DataMode, Scope};
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};

const MAGIC: &[u8; 4] = b"QCB1";
const HEADER_BYTES: usize = 16;
const ROW_BYTES: usize = 48;
const MAX_RECORDS: usize = 30_000;

fn bad(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct SeriesDescriptor {
    pub scope: Scope,
    pub mode: DataMode,
    pub series_id: String,
    pub interval_ms: u64,
}

fn safe_name(input: &str) -> bool {
    !input.is_empty()
        && input.len() <= 80
        && input.chars().all(|c| c.is_ascii_alphanumeric() || "_-".contains(c))
}
fn archive_path(root: &Path, series_id: &str, partition: &str) -> io::Result<PathBuf> {
    root_check(root)?;
    if !safe_name(series_id)
        || partition.len() != 6
        || !partition.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid_series_partition"));
    }
    Ok(root.join(format!("{series_id}-{partition}.qcb")))
}

fn valid_candle(c: &Candle, interval: u64) -> bool {
    (1_000..=86_400_000).contains(&interval)
        && c.open_time_ms > 0
        && c.open_time_ms.is_multiple_of(interval)
        && c.open.is_finite()
        && c.high.is_finite()
        && c.low.is_finite()
        && c.close.is_finite()
        && c.open >= 0.0 && c.low >= 0.0
        && c.low <= c.open && c.low <= c.close
        && c.high >= c.open && c.high >= c.close
        && c.observations > 0
}

fn encode_row(c: &Candle) -> [u8; ROW_BYTES] {
    let mut bytes = [0u8; ROW_BYTES];
    bytes[0..8].copy_from_slice(&c.open_time_ms.to_le_bytes());
    bytes[8..16].copy_from_slice(&c.open.to_le_bytes());
    bytes[16..24].copy_from_slice(&c.high.to_le_bytes());
    bytes[24..32].copy_from_slice(&c.low.to_le_bytes());
    bytes[32..40].copy_from_slice(&c.close.to_le_bytes());
    bytes[40..44].copy_from_slice(&c.observations.to_le_bytes());
    let check = crc32(&bytes[..44]);
    bytes[44..48].copy_from_slice(&check.to_le_bytes());
    bytes
}

fn read_row(file: &mut File, start: u64, index: usize, interval: u64) -> io::Result<Candle> {
    let offset = start + (index * ROW_BYTES) as u64;
    file.seek(SeekFrom::Start(offset))?;
    let mut bytes = [0u8; ROW_BYTES];
    file.read_exact(&mut bytes)?;
    if crc32(&bytes[..44]) != u32::from_le_bytes(bytes[44..48].try_into().unwrap()) {
        return Err(bad("corrupt_candle_row"));
    }
    let candle = Candle {
        open_time_ms: u64::from_le_bytes(bytes[0..8].try_into().unwrap()),
        open: f64::from_le_bytes(bytes[8..16].try_into().unwrap()),
        high: f64::from_le_bytes(bytes[16..24].try_into().unwrap()),
        low: f64::from_le_bytes(bytes[24..32].try_into().unwrap()),
        close: f64::from_le_bytes(bytes[32..40].try_into().unwrap()),
        observations: u32::from_le_bytes(bytes[40..44].try_into().unwrap()),
    };
    if !valid_candle(&candle, interval) {
        return Err(bad("invalid_stored_candle"));
    }
    Ok(candle)
}

fn validate_descriptor(descriptor: &SeriesDescriptor) -> io::Result<()> {
    if !safe_name(&descriptor.series_id)
        || descriptor.interval_ms < 1_000
        || descriptor.interval_ms > 86_400_000
        || [&descriptor.scope.tenant_id, &descriptor.scope.account_id,
            &descriptor.scope.source_id, &descriptor.scope.entitlement_id]
            .iter()
            .any(|s| s.is_empty() || s.len() > 128
                || !s.chars().all(|c| c.is_ascii_alphanumeric() || "._:-".contains(c)))
    {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid_series_descriptor"));
    }
    Ok(())
}

/// Atomically publish one immutable, indexed candle partition.
/// The series ID must be unique within its operator-approved tenant storage root.
/// This is *not* an exchange-aware calendar/rolling expiry implementation.
pub fn publish(
    root: &Path,
    partition: &str,
    descriptor: &SeriesDescriptor,
    candles: &[Candle],
) -> io::Result<()> {
    validate_descriptor(descriptor)?;
    if candles.is_empty() || candles.len() > MAX_RECORDS
        || candles.iter().any(|c| !valid_candle(c, descriptor.interval_ms))
        || candles.windows(2).any(|pair| pair[0].open_time_ms >= pair[1].open_time_ms)
    {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid_candle_partition"));
    }
    let destination = archive_path(root, &descriptor.series_id, partition)?;
    if destination.exists() {
        return Err(io::Error::new(io::ErrorKind::AlreadyExists, "immutable_partition_exists"));
    }
    let metadata = serde_json::to_vec(descriptor)?;
    if metadata.len() > 4096 {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "oversized_candle_metadata"));
    }
    let temporary = root.join(format!(
        ".{}-{}.qcb-{}-{}.tmp",
        descriptor.series_id, partition, std::process::id(),
        std::thread::current().name().unwrap_or("writer")
    ));
    let mut opts = OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    opts.mode(0o600).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    let mut file = opts.open(&temporary)?;
    let written = (|| -> io::Result<()> {
        let mut header = [0u8; HEADER_BYTES];
        header[0..4].copy_from_slice(MAGIC);
        header[4..8].copy_from_slice(&(metadata.len() as u32).to_le_bytes());
        header[8..12].copy_from_slice(&(candles.len() as u32).to_le_bytes());
        header[12..16].copy_from_slice(&crc32(&metadata).to_le_bytes());
        file.write_all(&header)?;
        file.write_all(&metadata)?;
        for candle in candles {
            file.write_all(&encode_row(candle))?;
        }
        file.sync_all()?;
        // Hard-link publishes the completed inode and refuses to overwrite
        // a previously published immutable partition in another process.
        fs::hard_link(&temporary, &destination)?;
        let parent = File::open(root)?;
        parent.sync_all()?;
        Ok(())
    })();
    let _ = fs::remove_file(temporary);
    written
}

pub struct CandlePartition {
    file: File,
    row_start: u64,
    count: usize,
    pub descriptor: SeriesDescriptor,
}

impl CandlePartition {
    pub fn open(root: &Path, partition: &str, expected: &SeriesDescriptor) -> io::Result<Self> {
        validate_descriptor(expected)?;
        let path = archive_path(root, &expected.series_id, partition)?;
        if path.symlink_metadata()?.file_type().is_symlink() {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, "candle_symlink_forbidden"));
        }
        let mut opts = OpenOptions::new();
        opts.read(true);
        #[cfg(unix)]
        opts.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        let mut file = opts.open(path)?;
        #[cfg(unix)]
        {
            let meta = file.metadata()?;
            if (meta.permissions().mode() & 0o077) != 0
                || meta.uid() != unsafe { libc::geteuid() }
            {
                return Err(io::Error::new(io::ErrorKind::PermissionDenied, "candle_not_owner_only"));
            }
        }
        let mut header = [0u8; HEADER_BYTES];
        file.read_exact(&mut header)?;
        if &header[..4] != MAGIC {
            return Err(bad("invalid_candle_partition_magic"));
        }
        let meta_len = u32::from_le_bytes(header[4..8].try_into().unwrap()) as usize;
        let count = u32::from_le_bytes(header[8..12].try_into().unwrap()) as usize;
        let expected_crc = u32::from_le_bytes(header[12..16].try_into().unwrap());
        if meta_len == 0 || meta_len > 4096 || count == 0 || count > MAX_RECORDS {
            return Err(bad("invalid_candle_header_counts"));
        }
        let mut metadata = vec![0u8; meta_len];
        file.read_exact(&mut metadata)?;
        if crc32(&metadata) != expected_crc {
            return Err(bad("corrupt_candle_metadata"));
        }
        let descriptor: SeriesDescriptor = serde_json::from_slice(&metadata)
            .map_err(|_| bad("invalid_candle_metadata"))?;
        if &descriptor != expected {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, "series_scope_mismatch"));
        }
        let row_start = (HEADER_BYTES + meta_len) as u64;
        if file.metadata()?.len() != row_start + (count * ROW_BYTES) as u64 {
            return Err(bad("candle_partition_size_mismatch"));
        }
        Ok(Self { file, row_start, count, descriptor })
    }

    /// O(log N) fixed-offset candle lookup; verifies CRCs of returned records.
    pub fn range(&mut self, start_ms: u64, end_ms: u64, limit: usize) -> io::Result<Vec<Candle>> {
        if start_ms > end_ms || limit == 0 || limit > 5_000 {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid_candle_range"));
        }
        let mut low = 0;
        let mut high = self.count;
        while low < high {
            let mid = low + (high - low) / 2;
            let item = read_row(&mut self.file, self.row_start, mid, self.descriptor.interval_ms)?;
            if item.open_time_ms < start_ms { low = mid + 1; } else { high = mid; }
        }
        let mut out = Vec::new();
        let mut previous = 0;
        for i in low..self.count {
            if out.len() == limit { break; }
            let candle = read_row(&mut self.file, self.row_start, i, self.descriptor.interval_ms)?;
            if candle.open_time_ms > end_ms { break; }
            if !out.is_empty() && candle.open_time_ms <= previous {
                return Err(bad("nonmonotonic_candle_series"));
            }
            previous = candle.open_time_ms;
            out.push(candle);
        }
        Ok(out)
    }

    /// Exhaustively verify every record and candle time ordering.
    pub fn audit(&mut self) -> io::Result<usize> {
        let mut previous = 0;
        for index in 0..self.count {
            let candle = read_row(&mut self.file, self.row_start, index, self.descriptor.interval_ms)?;
            if candle.open_time_ms <= previous {
                return Err(bad("nonmonotonic_candle_series"));
            }
            previous = candle.open_time_ms;
        }
        Ok(self.count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Fixture { dir: PathBuf }
    impl Fixture {
        fn new() -> Self {
            let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
            let dir = std::env::temp_dir().join(format!("qsyn-candles-{}-{stamp}", std::process::id()));
            fs::create_dir(&dir).unwrap();
            #[cfg(unix)]
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
            Self { dir }
        }
        fn spec(&self, account: &str) -> SeriesDescriptor {
            SeriesDescriptor {
                scope: Scope { tenant_id: "tenant".into(), account_id: account.into(),
                    source_id: "fixture".into(), entitlement_id: "simulated".into() },
                mode: DataMode::Replay, series_id: "straddle-001".into(), interval_ms: 60_000,
            }
        }
        fn bars(&self) -> Vec<Candle> {
            (1..=250).map(|index| Candle {
                open_time_ms: index * 60_000, open: 100.0, high: 101.0,
                low: 99.0, close: 100.5, observations: 2,
            }).collect()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.dir); }
    }

    #[test]
    fn indexed_range_and_tenant_denial() {
        let f = Fixture::new();
        publish(&f.dir, "202610", &f.spec("A"), &f.bars()).unwrap();
        assert!(publish(&f.dir, "202610", &f.spec("A"), &f.bars()).is_err());
        let mut series = CandlePartition::open(&f.dir, "202610", &f.spec("A")).unwrap();
        assert_eq!(series.audit().unwrap(), 250);
        let range = series.range(42 * 60_000, 47 * 60_000, 10).unwrap();
        assert_eq!(range.len(), 6);
        assert_eq!(range[0].open_time_ms, 42 * 60_000);
        assert_eq!(series.range(0, u64::MAX, 2).unwrap().len(), 2);
        assert!(CandlePartition::open(&f.dir, "202610", &f.spec("B")).is_err());
    }

    #[test]
    fn corrupt_rows_rejected_in_audit_and_reads() {
        let f = Fixture::new();
        publish(&f.dir, "202610", &f.spec("A"), &f.bars()).unwrap();
        let file = f.dir.join("straddle-001-202610.qcb");
        let mut bytes = fs::read(&file).unwrap();
        let corrupt_at = bytes.len() - 10;
        bytes[corrupt_at] ^= 0xff;
        fs::write(file, bytes).unwrap();
        let mut series = CandlePartition::open(&f.dir, "202610", &f.spec("A")).unwrap();
        assert!(series.audit().is_err());
        assert!(series.range(250 * 60_000, 250 * 60_000, 1).is_err());
    }

    #[test]
    fn incomplete_and_invalid_input_rejected() {
        let f = Fixture::new();
        assert!(publish(&f.dir, "../x", &f.spec("A"), &f.bars()).is_err());
        let mut bad = f.bars();
        bad[0].high = 90.0;
        assert!(publish(&f.dir, "202610", &f.spec("A"), &bad).is_err());
        publish(&f.dir, "202610", &f.spec("A"), &f.bars()).unwrap();
        let file = f.dir.join("straddle-001-202610.qcb");
        let handle = OpenOptions::new().write(true).open(file).unwrap();
        handle.set_len(80).unwrap();
        assert!(CandlePartition::open(&f.dir, "202610", &f.spec("A")).is_err());
    }
}
