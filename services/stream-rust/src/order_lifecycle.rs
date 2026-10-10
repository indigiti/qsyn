//! Durable state transitions for reconciled broker orders.
//! No order submission or credential access. Live routing remains disabled.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::{self, BufRead, BufReader, Write};
use std::path::Path;
#[cfg(unix)] use std::os::unix::fs::{MetadataExt,OpenOptionsExt,PermissionsExt};
#[cfg(unix)] use std::os::fd::AsRawFd;

fn denied(s: &'static str) -> io::Error { io::Error::new(io::ErrorKind::PermissionDenied,s) }
#[derive(Debug,Copy,Clone,PartialEq,Eq,Serialize,Deserialize)]
#[serde(rename_all="snake_case")]
pub enum Status { Prepared, Submitted, Acknowledged, PartiallyFilled, Filled,
    CancelRequested, Cancelled, Rejected }
#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OrderEvent {
    pub client_id: String, pub tenant: String, pub account: String,
    pub owner: String, pub status: Status, pub total_qty: u32,
    pub filled_qty: u32, pub broker_id: Option<String>, pub at_ms: u64,
}
#[derive(Debug,Serialize,Deserialize)]
struct Entry { seq: u64, prev: String, event: OrderEvent, digest: String }
fn checksum(seq:u64,prev:&str,event:&OrderEvent)->io::Result<String>{
    let value=Sha256::digest(serde_json::to_vec(&(seq,prev,event))?);
    Ok(value.iter().map(|b| format!("{b:02x}")).collect())
}
fn safe(s:&str)->bool{
    !s.is_empty() && s.len()<=128
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b,b'_'|b'-'|b'.'|b':'))
}
fn validate(previous:Option<&OrderEvent>,next:&OrderEvent)->io::Result<()>{
    if ![&next.client_id,&next.tenant,&next.account,&next.owner].iter().all(|s|safe(s))
        || next.total_qty==0 || next.total_qty>1_000_000
        || next.filled_qty>next.total_qty || next.at_ms==0 {
        return Err(denied("bad_order_event"));
    }
    if let Some(prev)=previous {
        if prev.client_id!=next.client_id || prev.tenant!=next.tenant
            || prev.account!=next.account || prev.owner!=next.owner
            || prev.total_qty!=next.total_qty || next.filled_qty<prev.filled_qty
            || next.at_ms<prev.at_ms
            || (prev.broker_id.is_some() && prev.broker_id!=next.broker_id){
            return Err(denied("order_identity_or_progress_invalid"));
        }
        if !matches!((prev.status,next.status),
            (Status::Prepared,Status::Submitted)|(Status::Prepared,Status::Rejected)
            |(Status::Submitted,Status::Acknowledged)|(Status::Submitted,Status::Rejected)
            |(Status::Submitted,Status::PartiallyFilled)|(Status::Submitted,Status::Filled)
            |(Status::Acknowledged,Status::PartiallyFilled)|(Status::Acknowledged,Status::Filled)
            |(Status::Acknowledged,Status::CancelRequested)|(Status::Acknowledged,Status::Rejected)
            |(Status::PartiallyFilled,Status::PartiallyFilled)
            |(Status::PartiallyFilled,Status::Filled)
            |(Status::PartiallyFilled,Status::CancelRequested)
            |(Status::CancelRequested,Status::Cancelled)
            |(Status::CancelRequested,Status::Filled)
            |(Status::CancelRequested,Status::PartiallyFilled)
            |(Status::CancelRequested,Status::Rejected)) {
            return Err(denied("order_transition_invalid"));
        }
        if !matches!(next.status,Status::PartiallyFilled|Status::Filled)
            && next.filled_qty!=prev.filled_qty {
            return Err(denied("fill_must_follow_broker_event"));
        }
    } else if next.status!=Status::Prepared || next.filled_qty!=0
        || next.broker_id.is_some() {return Err(denied("prepare_first")); }
    if next.status==Status::Filled && next.filled_qty!=next.total_qty {
        return Err(denied("unfilled_order_marked_filled"));
    }
    if next.status==Status::PartiallyFilled
        && (next.filled_qty==0||next.filled_qty>=next.total_qty) {
        return Err(denied("invalid_partial_fill"));
    }
    Ok(())
}
pub struct OrderLedger {
    file:std::fs::File,
    tenant:String,account:String,owner:String,
    state:HashMap<String,OrderEvent>, seq:u64,digest:String,poisoned:bool,
}
impl OrderLedger {
    pub fn open(root:&Path,tenant:&str,account:&str,owner:&str)->io::Result<Self>{
        crate::durable_market_wal::root_check(root)?;
        if ![tenant,account,owner].iter().all(|s|safe(s)){return Err(denied("bad_scope"));}
        let mut opts=OpenOptions::new();opts.create(true).read(true).append(true);
        #[cfg(unix)]opts.mode(0o600).custom_flags(libc::O_NOFOLLOW|libc::O_CLOEXEC);
        let file=opts.open(root.join("order-lifecycle-v1.jsonl"))?;
        #[cfg(unix)]{
            let meta=file.metadata()?;
            if (meta.permissions().mode()&0o077)!=0
                || meta.uid()!=unsafe{libc::geteuid()}
                || unsafe{libc::flock(file.as_raw_fd(),libc::LOCK_EX|libc::LOCK_NB)}!=0 {
                return Err(denied("private_order_journal_locked_or_unsafe"));
            }
        }
        let mut output=Self{file,tenant:tenant.into(),account:account.into(),
            owner:owner.into(),state:HashMap::new(),seq:0,digest:"GENESIS".into(),poisoned:false};
        for line in BufReader::new(output.file.try_clone()?).lines(){
            let raw=line?;
            if raw.len()>8192{return Err(denied("huge_order_history_event"));}
            let entry:Entry=serde_json::from_str(&raw)
                .map_err(|_|denied("corrupt_order_history"))?;
            if entry.seq!=output.seq+1||entry.prev!=output.digest
                || checksum(entry.seq,&entry.prev,&entry.event)?!=entry.digest {
                return Err(denied("tampered_order_history"));
            }
            output.check(&entry.event)?;
            output.state.insert(entry.event.client_id.clone(),entry.event);
            output.digest=entry.digest;output.seq=entry.seq;
        }
        Ok(output)
    }
    fn check(&self,event:&OrderEvent)->io::Result<()>{
        if event.tenant!=self.tenant||event.account!=self.account||event.owner!=self.owner {
            return Err(denied("cross_account_order_event"));
        }
        validate(self.state.get(&event.client_id),event)
    }
    /// This stores a verified outside event; it cannot submit an order.
    pub fn record(&mut self,event:OrderEvent)->io::Result<u64>{
        if self.poisoned{return Err(denied("order_ledger_poisoned"));}
        self.check(&event)?;
        let seq=self.seq.checked_add(1).ok_or_else(||denied("sequence_overflow"))?;
        let digest=checksum(seq,&self.digest,&event)?;
        let entry=Entry{seq,prev:self.digest.clone(),event:event.clone(),digest:digest.clone()};
        let bytes=serde_json::to_vec(&entry)?;
        if bytes.len()>8191{return Err(denied("oversized_record"));}
        self.poisoned=true;
        self.file.write_all(&bytes)?;self.file.write_all(b"\n")?;self.file.sync_data()?;
        self.seq=seq;self.digest=digest;self.state.insert(event.client_id.clone(),event);
        self.poisoned=false;
        Ok(seq)
    }
    pub fn latest(&self,id:&str)->Option<&OrderEvent>{self.state.get(id)}
    pub fn sequence(&self)->u64{self.seq}
}
#[cfg(test)]mod tests{
    use super::*;use std::fs;use std::time::{SystemTime,UNIX_EPOCH};
    #[cfg(unix)]use std::os::unix::fs::PermissionsExt;
    #[test]fn order_progress_rejects_cross_account_invalid_fills_and_recovers(){
        let root=std::env::temp_dir().join(format!("qsyn-oms-events-{}-{}",
            std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir(&root).unwrap();
        #[cfg(unix)]fs::set_permissions(&root,fs::Permissions::from_mode(0o700)).unwrap();
        let mut e=OrderEvent{client_id:"O1".into(),tenant:"T".into(),account:"A".into(),
            owner:"U".into(),status:Status::Prepared,total_qty:5,filled_qty:0,
            broker_id:None,at_ms:100};
        {
            let mut o=OrderLedger::open(&root,"T","A","U").unwrap();
            assert_eq!(o.record(e.clone()).unwrap(),1);
            assert!(o.record(e.clone()).is_err());
            e.status=Status::Submitted;e.at_ms=200;o.record(e.clone()).unwrap();
            e.status=Status::Acknowledged;e.broker_id=Some("BID".into());
            e.at_ms=300;o.record(e.clone()).unwrap();
            e.status=Status::PartiallyFilled;e.filled_qty=2;e.at_ms=400;
            o.record(e.clone()).unwrap();
            let mut bad=e.clone();bad.account="B".into();
            assert!(o.record(bad).is_err());
            bad=e.clone();bad.status=Status::Filled;bad.at_ms=500;
            assert!(o.record(bad).is_err());
            e.status=Status::CancelRequested;e.at_ms=500;
            o.record(e.clone()).unwrap();
            e.status=Status::Cancelled;e.at_ms=600;o.record(e.clone()).unwrap();
            assert!(o.record(e.clone()).is_err());
        }
        let o=OrderLedger::open(&root,"T","A","U").unwrap();
        assert_eq!(o.sequence(),6);
        assert_eq!(o.latest("O1").unwrap().filled_qty,2);
        drop(o);
        assert!(OrderLedger::open(&root,"T","B","U").is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
