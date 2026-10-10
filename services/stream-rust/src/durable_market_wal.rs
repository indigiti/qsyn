//! Private, single-writer market event WAL with strict recovery diagnostics.
//!
//! This is an *offline storage component*, not a connected exchange recorder.
//! The frame CRC detects accidental corruption; it does not authenticate
//! data or establish entitlement, order provenance or regulatory retention.
use crate::market_pipeline::{DataMode, NormalizedQuote, Scope};
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::Path;

#[cfg(unix)]
use std::os::fd::AsRawFd;
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};

const MAGIC: [u8; 4] = *b"QWL1";
const HEADER_BYTES: usize = 20;
const MAX_PAYLOAD: usize = 16 * 1024;
const MAX_SCAN_RECORDS: usize = 100_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScanReport {
    pub records: usize,
    pub durable_bytes: u64,
    pub trailing_partial_frame_at: Option<u64>,
    pub last_sequence: u64,
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

pub(crate) fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = !0u32;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xedb8_8320 & (0u32.wrapping_sub(crc & 1)));
        }
    }
    !crc
}

fn valid_scope(scope: &Scope) -> bool {
    [&scope.tenant_id, &scope.account_id, &scope.source_id, &scope.entitlement_id]
        .iter()
        .all(|value| !value.is_empty() && value.len() <= 128
            && value.chars().all(|c| c.is_ascii_alphanumeric() || "._:-".contains(c)))
}

fn valid_quote(quote: &NormalizedQuote) -> bool {
    valid_scope(&quote.scope)
        && !quote.instrument_id.is_empty()
        && quote.instrument_id.len() <= 128
        && quote.instrument_id.chars().all(|c| c.is_ascii_alphanumeric() || "._:-|".contains(c))
        && quote.timestamp_ms > 0
        && quote.price.is_finite()
        && quote.price > 0.0
}

pub fn root_check(root: &Path) -> io::Result<()> {
    if !root.is_absolute() || root.as_os_str().is_empty() {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "absolute_private_root_required"));
    }
    let metadata = root.symlink_metadata()?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "unsafe_archive_root"));
    }
    if root.canonicalize()? != root {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "noncanonical_archive_root"));
    }
    #[cfg(unix)]
    if (metadata.permissions().mode() & 0o077) != 0
        || metadata.uid() != unsafe { libc::geteuid() }
    {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "archive_root_not_owner_only"));
    }
    Ok(())
}

fn open_file(root: &Path, write: bool) -> io::Result<File> {
    root_check(root)?;
    let file_path = root.join("market-events-v1.wal");
    if file_path.symlink_metadata().is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "archive_symlink_forbidden"));
    }
    let mut opts = OpenOptions::new();
    opts.read(true).write(write);
    if write {
        opts.create(true);
    }
    #[cfg(unix)]
    {
        opts.mode(0o600).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    let file = opts.open(file_path)?;
    #[cfg(unix)]
    {
        let meta = file.metadata()?;
        if !meta.is_file() || (meta.permissions().mode() & 0o077) != 0
            || meta.uid() != unsafe { libc::geteuid() }
        {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, "archive_file_not_owner_only"));
        }
    }
    Ok(file)
}

#[cfg(unix)]
fn lock(file: &File, exclusive: bool) -> io::Result<()> {
    let mode = if exclusive { libc::LOCK_EX } else { libc::LOCK_SH };
    if unsafe { libc::flock(file.as_raw_fd(), mode | libc::LOCK_NB) } == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(unix))]
fn lock(_file: &File, _exclusive: bool) -> io::Result<()> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "unix_private_archive_only"))
}

fn scan<F>(file: &mut File, mut visit: F) -> io::Result<ScanReport>
where
    F: FnMut(&NormalizedQuote) -> io::Result<()>,
{
    file.seek(SeekFrom::Start(0))?;
    let mut good: u64 = 0;
    let mut sequence: u64 = 0;
    let mut records = 0usize;
    loop {
        let start = good;
        let mut header = [0u8; HEADER_BYTES];
        let first = file.read(&mut header)?;
        if first == 0 {
            return Ok(ScanReport {
                records, durable_bytes: good, trailing_partial_frame_at: None, last_sequence: sequence,
            });
        }
        if first < HEADER_BYTES && file.read_exact(&mut header[first..]).is_err() {
            return Ok(ScanReport {
                records, durable_bytes: good, trailing_partial_frame_at: Some(start),
                last_sequence: sequence,
            });
        }
        if header[0..4] != MAGIC {
            return Err(invalid("bad_wal_magic_or_midfile_corruption"));
        }
        let seq = u64::from_le_bytes(header[4..12].try_into().unwrap());
        if seq != sequence + 1 {
            return Err(invalid("wal_sequence_gap_or_reorder"));
        }
        let len = u32::from_le_bytes(header[12..16].try_into().unwrap()) as usize;
        let expected_crc = u32::from_le_bytes(header[16..20].try_into().unwrap());
        if len == 0 || len > MAX_PAYLOAD {
            return Err(invalid("invalid_wal_frame_length"));
        }
        let mut payload = vec![0u8; len];
        if let Err(error) = file.read_exact(&mut payload) {
            if error.kind() != io::ErrorKind::UnexpectedEof {
                return Err(error);
            }
            return Ok(ScanReport {
                records, durable_bytes: good, trailing_partial_frame_at: Some(start),
                last_sequence: sequence,
            });
        }
        if crc32(&payload) != expected_crc {
            return Err(invalid("wal_payload_crc_mismatch"));
        }
        let quote: NormalizedQuote = serde_json::from_slice(&payload)
            .map_err(|_| invalid("invalid_wal_quote_json"))?;
        if !valid_quote(&quote) {
            return Err(invalid("invalid_wal_quote_contract"));
        }
        visit(&quote)?;
        good += (HEADER_BYTES + len) as u64;
        sequence = seq;
        records += 1;
        if records > MAX_SCAN_RECORDS {
            return Err(invalid("wal_scan_record_limit"));
        }
    }
}

/// A single-writer, fsync-after-each-append WAL. The lock is held until Drop.
/// The caller must supply a pre-existing owner-only, canonical absolute root.
pub struct DurableMarketWal {
    file: File,
    sequence: u64,
    poisoned: bool,
}

impl DurableMarketWal {
    pub fn open(root: &Path) -> io::Result<Self> {
        let mut file = open_file(root, true)?;
        lock(&file, true)?;
        let report = scan(&mut file, |_| Ok(()))?;
        if report.trailing_partial_frame_at.is_some() {
            return Err(invalid("torn_wal_tail_requires_explicit_repair"));
        }
        file.seek(SeekFrom::End(0))?;
        Ok(Self { file, sequence: report.last_sequence, poisoned: false })
    }

    /// Durable acknowledgment occurs only after the file fsync succeeds.
    /// A failed append permanently poisons this writer to prevent silent reuse.
    pub fn append(&mut self, quote: &NormalizedQuote) -> io::Result<u64> {
        if self.poisoned {
            return Err(invalid("wal_writer_poisoned"));
        }
        if !valid_quote(quote) {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid_quote_for_wal"));
        }
        let bytes = serde_json::to_vec(quote)?;
        if bytes.len() > MAX_PAYLOAD {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "oversized_quote_for_wal"));
        }
        let next = self.sequence.checked_add(1).ok_or_else(|| invalid("wal_sequence_exhausted"))?;
        let mut header = [0u8; HEADER_BYTES];
        header[0..4].copy_from_slice(&MAGIC);
        header[4..12].copy_from_slice(&next.to_le_bytes());
        header[12..16].copy_from_slice(&(bytes.len() as u32).to_le_bytes());
        header[16..20].copy_from_slice(&crc32(&bytes).to_le_bytes());
        self.poisoned = true;
        self.file.write_all(&header)?;
        self.file.write_all(&bytes)?;
        self.file.sync_data()?;
        self.sequence = next;
        self.poisoned = false;
        Ok(next)
    }


    /// Reconstruct per-instrument exchange-timestamp watermarks after a
    /// collector restart. Reject any rows from a different owner/mode in
    /// this archive: each live writer must use a dedicated private root.
    pub fn private_watermarks(
        &mut self,
        scope: &Scope,
        mode: &DataMode,
        allowed: &[String],
    ) -> io::Result<std::collections::HashMap<String, u64>> {
        if !valid_scope(scope) || allowed.is_empty() || allowed.len() > 8
            || allowed.iter().any(|v| v.is_empty()) {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid_private_watermark_scope"));
        }
        let mut latest = std::collections::HashMap::<String, u64>::new();
        let result = scan(&mut self.file, |quote| {
            if &quote.scope != scope || &quote.mode != mode
                || !allowed.contains(&quote.instrument_id)
            {
                return Err(io::Error::new(io::ErrorKind::PermissionDenied,
                    "private_market_archive_scope_mismatch"));
            }
            let ts = latest.entry(quote.instrument_id.clone()).or_default();
            *ts = (*ts).max(quote.timestamp_ms);
            Ok(())
        });
        self.file.seek(SeekFrom::End(0))?;
        let report = result?;
        if report.trailing_partial_frame_at.is_some() {
            return Err(invalid("torn_wal_tail_requires_explicit_repair"));
        }
        Ok(latest)
    }

    pub fn last_sequence(&self) -> u64 { self.sequence }
}

/// Read or audit the offline WAL. Fail closed on a torn tail or corrupt frame.
pub fn audit(root: &Path) -> io::Result<ScanReport> {
    let mut file = open_file(root, false)?;
    lock(&file, false)?;
    let report = scan(&mut file, |_| Ok(()))?;
    if report.trailing_partial_frame_at.is_some() {
        return Err(invalid("torn_wal_tail_requires_explicit_repair"));
    }
    Ok(report)
}

/// Read a strictly scoped, bounded historical snapshot without publishing data.
pub fn query(
    root: &Path,
    scope: &Scope,
    mode: &DataMode,
    instrument: &str,
    start_ms: u64,
    end_ms: u64,
    limit: usize,
) -> io::Result<Vec<NormalizedQuote>> {
    if !valid_scope(scope) || instrument.is_empty()
        || limit == 0 || limit > 5_000 || start_ms > end_ms
    {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid_history_query"));
    }
    let mut file = open_file(root, false)?;
    lock(&file, false)?;
    let mut rows = Vec::new();
    let report = scan(&mut file, |q| {
        if &q.scope == scope && &q.mode == mode && q.instrument_id == instrument
            && q.timestamp_ms >= start_ms && q.timestamp_ms <= end_ms
            && rows.len() < limit
        {
            rows.push(q.clone());
        }
        Ok(())
    })?;
    if report.trailing_partial_frame_at.is_some() {
        return Err(invalid("torn_wal_tail_requires_explicit_repair"));
    }
    Ok(rows)
}

/// Explicit, operator-authorized repair of ONLY an incomplete final frame.
/// CRC mismatch, bad schema, sequence gaps, and mid-file corruption are fatal.
pub fn repair_incomplete_tail(root: &Path) -> io::Result<Option<u64>> {
    let mut file = open_file(root, false)?;
    // Requires an existing file, opens read-only initially; reopen write-only
    // after obtaining the same private lock for the actual truncate.
    lock(&file, true)?;
    let report = scan(&mut file, |_| Ok(()))?;
    if let Some(offset) = report.trailing_partial_frame_at {
        // Keep the exclusive lock while a distinct writable fd truncates.
        let mut opts = OpenOptions::new();
        opts.write(true);
        #[cfg(unix)]
        opts.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        let mut writable = opts.open(root.join("market-events-v1.wal"))?;
        writable.set_len(offset)?;
        writable.flush()?;
        writable.sync_all()?;
        Ok(Some(offset))
    } else {
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::{symlink, PermissionsExt};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Fixture { dir: std::path::PathBuf }
    impl Fixture {
        fn new() -> Self {
            let tick = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
            let dir = std::env::temp_dir().join(format!("qsyn-wal-{}-{tick}", std::process::id()));
            fs::create_dir(&dir).unwrap();
            #[cfg(unix)]
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
            Self { dir }
        }
        fn quote(&self, account: &str, seq: u64, price: f64) -> NormalizedQuote {
            NormalizedQuote {
                scope: Scope { tenant_id: "tenant1".into(), account_id: account.into(),
                    source_id: "fixture".into(), entitlement_id: "simulated".into() },
                instrument_id: "NSE_FO:TEST".into(), timestamp_ms: 120_000 + seq,
                sequence: seq, price, mode: DataMode::Simulated,
            }
        }
        fn wal(&self) -> std::path::PathBuf { self.dir.join("market-events-v1.wal") }
    }
    impl Drop for Fixture {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.dir); }
    }

    #[test]
    fn reopens_with_durable_sequence_and_scoped_queries() {
        let f = Fixture::new();
        let q1 = f.quote("A", 1, 100.0);
        let q2 = f.quote("B", 2, 110.0);
        {
            let mut w = DurableMarketWal::open(&f.dir).unwrap();
            assert_eq!(w.append(&q1).unwrap(), 1);
            assert_eq!(w.append(&q2).unwrap(), 2);
            assert_eq!(w.last_sequence(), 2);
            assert!(DurableMarketWal::open(&f.dir).is_err(), "second writer must not start");
        }
        assert_eq!(audit(&f.dir).unwrap().records, 2);
        let rows = query(&f.dir, &q1.scope, &DataMode::Simulated,
            &q1.instrument_id, 0, u64::MAX, 100).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].price, 100.0);
        assert!(query(&f.dir, &q1.scope, &DataMode::AuthorizedLive,
            &q1.instrument_id, 0, u64::MAX, 100).unwrap().is_empty());
        let mut writer = DurableMarketWal::open(&f.dir).unwrap();
        assert_eq!(writer.append(&f.quote("A", 3, 105.0)).unwrap(), 3);
        assert!(writer.append(&f.quote("A", 4, f64::NAN)).is_err());
    }

    #[test]
    fn truncated_final_frame_requires_explicit_repair() {
        let f = Fixture::new();
        { let mut w = DurableMarketWal::open(&f.dir).unwrap();
          w.append(&f.quote("A", 1, 101.0)).unwrap();
          w.append(&f.quote("A", 2, 102.0)).unwrap(); }
        let size = fs::metadata(f.wal()).unwrap().len();
        let wal = OpenOptions::new().write(true).open(f.wal()).unwrap();
        wal.set_len(size - 3).unwrap();
        assert!(audit(&f.dir).is_err());
        assert!(DurableMarketWal::open(&f.dir).is_err());
        assert!(repair_incomplete_tail(&f.dir).unwrap().is_some());
        assert_eq!(audit(&f.dir).unwrap().records, 1);
        let mut w = DurableMarketWal::open(&f.dir).unwrap();
        assert_eq!(w.append(&f.quote("A", 3, 103.0)).unwrap(), 2);
    }

    #[test]
    fn checksum_or_sequence_tampering_cannot_be_repaired_as_tail() {
        let f = Fixture::new();
        { let mut w = DurableMarketWal::open(&f.dir).unwrap();
          w.append(&f.quote("A", 1, 105.0)).unwrap(); }
        let mut bytes = fs::read(f.wal()).unwrap();
        *bytes.last_mut().unwrap() ^= 0x01;
        fs::write(f.wal(), bytes).unwrap();
        assert!(audit(&f.dir).is_err());
        assert!(repair_incomplete_tail(&f.dir).is_err());
    }

    #[test]
    fn private_root_and_symlink_rejections() {
        let f = Fixture::new();
        #[cfg(unix)]
        {
            fs::set_permissions(&f.dir, fs::Permissions::from_mode(0o755)).unwrap();
            assert!(DurableMarketWal::open(&f.dir).is_err());
            fs::set_permissions(&f.dir, fs::Permissions::from_mode(0o700)).unwrap();
            let link = f.dir.join("market-events-v1.wal");
            symlink("/dev/null", &link).unwrap();
            assert!(DurableMarketWal::open(&f.dir).is_err());
        }
    }
}
