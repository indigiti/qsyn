//! Private, provider-authenticated historical constituent candle import.
//! This preserves actual leg OHLC; it does NOT pretend synthetic extrema can
//! be reconstructed by summing constituent candle highs or lows.
use crate::immutable_candles::{self,SeriesDescriptor};
use crate::market_pipeline::{Candle,DataMode,Scope};
use serde::{Deserialize,Serialize};
use std::io;
use std::path::Path;
fn refused(message:&'static str)->io::Error { io::Error::new(io::ErrorKind::InvalidData,message) }

#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HistoricalImport {
    pub schema:String,
    pub source:String,
    pub broker:String,
    pub scope:Scope,
    pub series_id:String,
    pub partition:String,
    pub interval_ms:u64,
    pub provider_authenticated:bool,
    pub retention_rights_attested:bool,
    pub license_expires_ms:u64,
    pub exported_at_ms:u64,
    pub candles:Vec<Candle>,
}
/// Separate immutable indexes for each real option leg. The imported data
/// remains private replay/history and can only be surfaced to specifically
/// licensed users by an independently authenticated chart gateway.
pub fn import(root:&Path, request:HistoricalImport,now_ms:u64)->io::Result<usize> {
    if request.schema != "QSYN-OPENALGO-HISTORY-IMPORT/1"
        || request.source != "openalgo_private_rest"
        || request.broker.is_empty()
        || request.broker.len()>48
        || !request.broker.bytes().all(|b|b.is_ascii_lowercase()||b.is_ascii_digit()||b==b'_')
        || !request.provider_authenticated || !request.retention_rights_attested
        || request.license_expires_ms <= now_ms
        || request.exported_at_ms == 0 || request.exported_at_ms>now_ms
        || now_ms-request.exported_at_ms>86_400_000
        || request.interval_ms != 60_000 || request.candles.is_empty()
        || request.candles.len()>30_000 {
        return Err(refused("private_history_provenance_not_approved"));
    }
    let mut previous=0u64;
    for candle in &request.candles {
        if candle.open_time_ms <= previous
            || candle.open_time_ms % request.interval_ms != 0
            || candle.open_time_ms>now_ms
            || candle.observations == 0
            || ![candle.open,candle.high,candle.low,candle.close]
                .iter().all(|v|v.is_finite()&&*v>=0.0)
            || candle.low>candle.open.min(candle.close)
            || candle.high<candle.open.max(candle.close)
            || candle.high<candle.low {
            return Err(refused("corrupt_or_unsorted_provider_history"));
        }
        previous=candle.open_time_ms;
    }
    let n=request.candles.len();
    let descriptor=SeriesDescriptor {
        scope:request.scope, mode:DataMode::Replay,
        series_id:request.series_id, interval_ms:request.interval_ms,
    };
    immutable_candles::publish(root,&request.partition,&descriptor,&request.candles)?;
    Ok(n)
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[cfg(unix)]use std::os::unix::fs::PermissionsExt;
    use std::time::{SystemTime,UNIX_EPOCH};
    fn fixture()->HistoricalImport {
        HistoricalImport {
            schema:"QSYN-OPENALGO-HISTORY-IMPORT/1".into(),
            source:"openalgo_private_rest".into(),broker:"upstox".into(),
            scope:Scope {tenant_id:"tenantA".into(),account_id:"A".into(),
                source_id:"openalgo_leg_history".into(),entitlement_id:"licenseA".into()},
            series_id:"NIFTY_CE_PROVIDER_HISTORY".into(),
            partition:"202610".into(),interval_ms:60_000,
            provider_authenticated:true,retention_rights_attested:true,
            license_expires_ms:2_000_000,exported_at_ms:1_000_000,
            candles:vec![Candle {open_time_ms:120_000,open:100.0,
                high:105.0,low:98.0,close:102.0,observations:1}],
        }
    }
    #[test]
    fn protected_import_rejects_bad_license_and_wrong_bars(){
        let root=std::env::temp_dir().join(format!("qsyn-history-{}-{}",
            std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir(&root).unwrap();
        #[cfg(unix)]fs::set_permissions(&root,fs::Permissions::from_mode(0o700)).unwrap();
        let mut request=fixture();
        request.retention_rights_attested=false;
        assert!(import(&root,request,1_000_500).is_err());
        let mut request=fixture();
        request.candles[0].high=90.0;
        assert!(import(&root,request,1_000_500).is_err());
        assert_eq!(import(&root,fixture(),1_000_500).unwrap(),1);
        assert!(import(&root,fixture(),1_000_500).is_err());
        let expected=SeriesDescriptor {scope:fixture().scope,mode:DataMode::Replay,
            series_id:"NIFTY_CE_PROVIDER_HISTORY".into(),interval_ms:60_000};
        let mut p=immutable_candles::CandlePartition::open(&root,"202610",&expected).unwrap();
        assert_eq!(p.range(0,u64::MAX,10).unwrap()[0].high,105.0);
        fs::remove_dir_all(root).unwrap();
    }
}
