//! Explicitly attested private live source -> durable scoped market WAL.
//! Nothing in this module grants exchange data rights or public redistribution.
use crate::durable_market_wal::DurableMarketWal;
use crate::market_pipeline::{DataMode, NormalizedQuote, Scope};
use crate::openalgo_stream::CandidateQuote;
use std::collections::HashMap;
use std::io;
use std::path::Path;
fn refused(reason: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, reason)
}
#[derive(Clone, Debug)]
pub struct PrivateIngestApproval {
    pub scope: Scope,
    pub approved_instruments: Vec<String>,
    pub licensed_persistence: bool,
    pub broker_session_verified: bool,
    pub expires_ms: u64,
    pub max_delay_ms: u64,
}
pub struct PrivatePersistentIngest {
    approval: PrivateIngestApproval,
    wal: DurableMarketWal,
    last: HashMap<String, u64>,
    pub stored: u64,
}
impl PrivatePersistentIngest {
    /// Parent directory must preexist with owner 0700, WAL owner 0600.
    pub fn open(root: &Path, approval: PrivateIngestApproval, now_ms: u64)
        -> io::Result<Self> {
        if !approval.licensed_persistence || !approval.broker_session_verified
            || approval.scope.tenant_id.is_empty() || approval.scope.account_id.is_empty()
            || approval.scope.entitlement_id.is_empty()
            || approval.approved_instruments.is_empty()
            || approval.approved_instruments.len() > 8
            || approval.max_delay_ms > 5_000 || approval.expires_ms <= now_ms
        { return Err(refused("private_persistence_not_approved")); }
        let wal=DurableMarketWal::open(root)?;
        Ok(Self { approval, wal, last:HashMap::new(), stored:0 })
    }
    /// Accepted normalized quotes remain PRIVATE; source "authorized_live"
    /// is a provenance label only, not permission to send to web clients.
    pub fn ingest(&mut self, q: &CandidateQuote, now_ms: u64) -> io::Result<u64> {
        if !self.approval.licensed_persistence
            || !self.approval.broker_session_verified
            || self.approval.expires_ms <= now_ms || q.scope != self.approval.scope
            || q.publishable_to_public_studio || q.entitlement_verified
            || q.stale || !self.approval.approved_instruments.contains(&q.instrument_id)
            || q.exchange_timestamp_ms == 0 || q.exchange_timestamp_ms > now_ms
            || now_ms.saturating_sub(q.exchange_timestamp_ms) > self.approval.max_delay_ms
            || !q.price.is_finite() || q.price <= 0.0
        { return Err(refused("unapproved_stale_or_invalid_private_quote")); }
        // The upstream snapshot is replayed on every reconnection. Repeated
        // timestamps are safe no-op acknowledgments, not another WAL record.
        if self.last.get(&q.instrument_id).is_some_and(|t| q.exchange_timestamp_ms <= *t) {
            return Ok(self.wal.last_sequence());
        }
        let wal_quote=NormalizedQuote {
            scope:self.approval.scope.clone(),
            instrument_id:q.instrument_id.clone(),
            timestamp_ms:q.exchange_timestamp_ms,
            sequence:self.wal.last_sequence().checked_add(1)
                .ok_or_else(||refused("ingest_sequence_exhausted"))?,
            price:q.price,
            mode:DataMode::AuthorizedLive,
        };
        let seq=self.wal.append(&wal_quote)?;
        self.last.insert(q.instrument_id.clone(),q.exchange_timestamp_ms);
        self.stored+=1;
        Ok(seq)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[cfg(unix)]use std::os::unix::fs::PermissionsExt;
    use std::time::{SystemTime, UNIX_EPOCH};
    #[test]
    fn rejects_unlicensed_ingest_and_persists_scoped_valid_quote() {
        let root=std::env::temp_dir().join(format!("qsyn-ingest-{}-{}",std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir(&root).unwrap();
        #[cfg(unix)]fs::set_permissions(&root,fs::Permissions::from_mode(0o700)).unwrap();
        let scope=Scope {tenant_id:"tenantA".into(),account_id:"upstoxA".into(),
            source_id:"privateOpenAlgo".into(),entitlement_id:"signed-license".into()};
        let approval=PrivateIngestApproval {
            scope:scope.clone(),approved_instruments:vec!["NFO|CE".into()],
            licensed_persistence:true,broker_session_verified:true,
            expires_ms:300_000,max_delay_ms:2_000,
        };
        let mut disallowed=approval.clone();
        disallowed.licensed_persistence=false;
        assert!(PrivatePersistentIngest::open(&root,disallowed,100_000).is_err());
        let mut w=PrivatePersistentIngest::open(&root,approval,100_000).unwrap();
        let mut quote=CandidateQuote {
            scope, instrument_id:"NFO|CE".into(),exchange_timestamp_ms:100_000,
            received_timestamp_ms:100_005, price:100.0,stale:false,
            entitlement_verified:false,publishable_to_public_studio:false,
        };
        assert_eq!(w.ingest(&quote,100_500).unwrap(),1);
        assert_eq!(w.ingest(&quote,100_500).unwrap(),1);
        assert_eq!(w.stored,1);
        quote.exchange_timestamp_ms=101_000;
        quote.scope.account_id="upstoxB".into();
        assert!(w.ingest(&quote,101_500).is_err());
        quote.scope.account_id="upstoxA".into();
        assert_eq!(w.ingest(&quote,101_500).unwrap(),2);
        drop(w);
        let checked=crate::durable_market_wal::audit(&root).unwrap();
        assert_eq!(checked.records,2);
        let q=crate::durable_market_wal::query(&root,&quote.scope,&DataMode::AuthorizedLive,
            "NFO|CE",0,u64::MAX,10).unwrap();
        assert_eq!(q.len(),2);
        fs::remove_dir_all(root).unwrap();
    }
}
