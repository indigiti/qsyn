//! Durable owner-scoped PAPER order ledger, no live broker API.
//! Each accepted paper fill is risk-checked and fsync-acknowledged.
//! Actual broker execution requires separate certified routing.
use crate::durable_market_wal::root_check;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::fs::{File, OpenOptions};
use std::io::{self, BufRead, BufReader, Write};
use std::path::Path;
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
fn denied(reason: &'static str) -> io::Error { io::Error::new(io::ErrorKind::PermissionDenied, reason) }
fn safe(s: &str) -> bool {
    !s.is_empty() && s.len() <= 128
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b,b'_'|b'-'|b'.'|b'|'|b':'))
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all="snake_case")]
pub enum Side { Buy, Sell }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PaperIntent {
    pub client_order_id: String,
    pub tenant: String, pub account: String, pub owner: String,
    pub instrument: String, pub side: Side,
    pub quantity: u32, pub fill_price: f64,
    pub tick_time_ms: u64, pub received_ms: u64,
}
#[derive(Clone, Debug)]
pub struct RiskLimits {
    pub max_single_qty: u32,
    pub max_net_qty: i64,
    pub max_gross_exposure: f64,
    pub max_order_notional: f64,
    pub available_margin: f64,
    pub max_tick_age_ms: u64,
    pub max_orders: usize,
    pub kill_switch: bool,
}
impl RiskLimits {
    fn validate(&self) -> bool {
        self.max_single_qty > 0 && self.max_net_qty > 0
            && self.max_orders > 0 && self.max_orders <= 100_000
            && self.max_gross_exposure.is_finite() && self.max_gross_exposure > 0.0
            && self.max_order_notional.is_finite() && self.max_order_notional > 0.0
            && self.available_margin.is_finite() && self.available_margin > 0.0
            && self.max_tick_age_ms <= 30_000
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry { seq: u64, intent: PaperIntent, sha256: String }
pub struct PaperOms {
    file: File,
    pub tenant: String,
    pub account: String,
    pub owner: String,
    limits: RiskLimits,
    seen: HashMap<String, (String, u64)>,
    positions: BTreeMap<String, i64>,
    marks: HashMap<String, f64>,
    seq: u64,
    poisoned: bool,
}
fn hash(seq: u64, intent: &PaperIntent) -> io::Result<String> {
    let bytes = serde_json::to_vec(&(seq, intent))?;
    let digest = Sha256::digest(bytes);
    Ok(digest.iter().map(|x| format!("{x:02x}")).collect())
}
impl PaperOms {
    pub fn open(root: &Path, tenant: &str, account: &str, owner: &str, limits: RiskLimits)
        -> io::Result<Self> {
        root_check(root)?;
        if ![tenant,account,owner].iter().all(|s| safe(s)) || !limits.validate() {
            return Err(denied("invalid_paper_oms_scope_or_risk"));
        }
        let path=root.join("paper-orders-v1.jsonl");
        let mut opts=OpenOptions::new();
        opts.create(true).append(true).read(true);
        #[cfg(unix)]
        opts.mode(0o600).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        let file=opts.open(path)?;
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            let meta=file.metadata()?;
            if !meta.is_file() || (meta.permissions().mode() & 0o077) != 0
                || meta.uid() != unsafe { libc::geteuid() }
                || unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
                return Err(denied("paper_archive_not_private_or_writer_locked"));
            }
        }
        let mut ledger=Self {
            file, tenant:tenant.into(), account:account.into(), owner:owner.into(),
            limits, seen:HashMap::new(), positions:BTreeMap::new(),
            marks:HashMap::new(), seq:0, poisoned:false,
        };
        let reader=BufReader::new(ledger.file.try_clone()?);
        for line in reader.lines() {
            let raw=line?;
            if raw.len() > 8192 { return Err(denied("oversized_paper_entry")); }
            let entry:Entry=serde_json::from_str(&raw).map_err(|_| denied("bad_paper_journal"))?;
            if entry.seq != ledger.seq+1 || entry.sha256 != hash(entry.seq,&entry.intent)?
                || entry.intent.tenant != tenant || entry.intent.account != account
                || entry.intent.owner != owner {
                return Err(denied("paper_history_corrupt_or_cross_account"));
            }
            let serialized=serde_json::to_string(&entry.intent)?;
            if let Some((previous,_))=ledger.seen.get(&entry.intent.client_order_id) {
                if previous != &serialized { return Err(denied("duplicate_paper_id_changed")); }
                return Err(denied("duplicate_paper_entry"));
            }
            // Recovered history was already risk-accepted at initial order entry.
            ledger.update_position(&entry.intent)?;
            ledger.seen.insert(entry.intent.client_order_id.clone(),(serialized,entry.seq));
            ledger.seq=entry.seq;
        }
        Ok(ledger)
    }
    fn update_position(&mut self, intent: &PaperIntent) -> io::Result<()> {
        let delta= match intent.side {
            Side::Buy => i64::from(intent.quantity),
            Side::Sell => -i64::from(intent.quantity),
        };
        let current=*self.positions.get(&intent.instrument).unwrap_or(&0);
        let new=current.checked_add(delta).ok_or_else(|| denied("paper_position_overflow"))?;
        self.positions.insert(intent.instrument.clone(),new);
        self.marks.insert(intent.instrument.clone(),intent.fill_price);
        Ok(())
    }
    fn check(&self, intent: &PaperIntent) -> io::Result<()> {
        if self.poisoned || self.limits.kill_switch || self.seq as usize >= self.limits.max_orders
            || intent.tenant != self.tenant || intent.account != self.account
            || intent.owner != self.owner || !safe(&intent.client_order_id)
            || !safe(&intent.instrument) || intent.quantity==0
            || intent.quantity > self.limits.max_single_qty
            || !intent.fill_price.is_finite() || intent.fill_price <= 0.0
            || intent.tick_time_ms==0 || intent.received_ms < intent.tick_time_ms
            || intent.received_ms-intent.tick_time_ms > self.limits.max_tick_age_ms
        { return Err(denied("paper_order_scope_risk_or_staleness")); }
        let value=intent.fill_price*f64::from(intent.quantity);
        if !value.is_finite() || value>self.limits.max_order_notional
            || value > self.limits.available_margin {
            return Err(denied("paper_insufficient_limit_or_margin"));
        }
        let delta=if intent.side == Side::Buy {i64::from(intent.quantity)}
            else {-i64::from(intent.quantity)};
        let current=*self.positions.get(&intent.instrument).unwrap_or(&0);
        let next=current.checked_add(delta).ok_or_else(||denied("paper_position_overflow"))?;
        if next.unsigned_abs() > self.limits.max_net_qty as u64 {
            return Err(denied("paper_net_position_limit"));
        }
        let mut gross=0.0;
        for (instrument,qty) in &self.positions {
            let new_qty=if instrument == &intent.instrument {next} else {*qty};
            let mark=if instrument == &intent.instrument {
                intent.fill_price
            } else {*self.marks.get(instrument).ok_or_else(||denied("paper_missing_mark"))?};
            gross += new_qty.unsigned_abs() as f64 * mark;
        }
        if !self.positions.contains_key(&intent.instrument) {
            gross += next.unsigned_abs() as f64 * intent.fill_price;
        }
        if !gross.is_finite() || gross>self.limits.max_gross_exposure {
            return Err(denied("paper_gross_exposure_limit"));
        }
        Ok(())
    }
    /// Idempotently paper-fill a *simulated* order only. No broker POST.
    /// Failed filesystem writes poison the OMS until operator recovery.
    pub fn fill(&mut self, intent: PaperIntent) -> io::Result<u64> {
        let content=serde_json::to_string(&intent)?;
        if let Some((previous,seq))=self.seen.get(&intent.client_order_id) {
            return if *previous == content {Ok(*seq)} else {Err(denied("paper_idempotency_collision"))};
        }
        self.check(&intent)?;
        let seq=self.seq.checked_add(1).ok_or_else(||denied("paper_seq_overflow"))?;
        let entry=Entry {seq,sha256:hash(seq,&intent)?,intent: intent.clone()};
        let bytes=serde_json::to_vec(&entry)?;
        if bytes.len()>8191 {return Err(denied("oversized_paper_intent"));}
        self.poisoned=true;
        self.file.write_all(&bytes)?;
        self.file.write_all(b"\n")?;
        self.file.sync_data()?;
        self.update_position(&intent)?;
        self.seen.insert(intent.client_order_id.clone(),(content,seq));
        self.seq=seq;
        self.poisoned=false;
        Ok(seq)
    }
    pub fn positions(&self) -> &BTreeMap<String,i64> {&self.positions}
    pub fn last_sequence(&self) -> u64 {self.seq}
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[cfg(unix)]use std::os::unix::fs::PermissionsExt;
    use std::time::{SystemTime,UNIX_EPOCH};
    fn limits() -> RiskLimits {
        RiskLimits {max_single_qty:10,max_net_qty:15,max_gross_exposure:10000.0,
            max_order_notional:5000.0,available_margin:5000.0,max_tick_age_ms:3000,
            max_orders:100,kill_switch:false}
    }
    fn intent(id:&str) -> PaperIntent {
        PaperIntent {client_order_id:id.into(),tenant:"tenantA".into(),account:"upstoxA".into(),
            owner:"ownerA".into(),instrument:"NFO|CE".into(),side:Side::Buy,quantity:2,
            fill_price:100.0,tick_time_ms:100000,received_ms:101000}
    }
    #[test]
    fn paper_risk_recovery_scoped_journal_idempotency_kill_switch() {
        let dir=std::env::temp_dir().join(format!("qsyn-paper-{}-{}",std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir(&dir).unwrap();
        #[cfg(unix)]fs::set_permissions(&dir,fs::Permissions::from_mode(0o700)).unwrap();
        {
            let mut oms=PaperOms::open(&dir,"tenantA","upstoxA","ownerA",limits()).unwrap();
            assert_eq!(oms.fill(intent("id1")).unwrap(),1);
            assert_eq!(oms.fill(intent("id1")).unwrap(),1);
            let mut changed=intent("id1");changed.fill_price=200.0;
            assert!(oms.fill(changed).is_err());
            let mut foreign=intent("foreign");foreign.account="upstoxB".into();
            assert!(oms.fill(foreign).is_err());
            let mut stale=intent("stale");stale.received_ms=110000;
            assert!(oms.fill(stale).is_err());
            let mut huge=intent("huge");huge.quantity=100;
            assert!(oms.fill(huge).is_err());
            assert!(PaperOms::open(&dir,"tenantA","upstoxA","ownerA",limits()).is_err());
        }
        {
            let mut restored=PaperOms::open(&dir,"tenantA","upstoxA","ownerA",limits()).unwrap();
            assert_eq!(restored.positions()["NFO|CE"],2);
            assert_eq!(restored.last_sequence(),1);
            let mut sell=intent("sell1");sell.side=Side::Sell;
            assert_eq!(restored.fill(sell).unwrap(),2);
            assert_eq!(restored.positions()["NFO|CE"],0);
        }
        assert!(PaperOms::open(&dir,"tenantB","upstoxA","ownerA",limits()).is_err());
        let mut killed=limits();killed.kill_switch=true;
        let mut oms=PaperOms::open(&dir,"tenantA","upstoxA","ownerA",killed).unwrap();
        assert!(oms.fill(intent("blocked")).is_err());
        drop(oms);
        fs::remove_dir_all(dir).unwrap();
    }
}
