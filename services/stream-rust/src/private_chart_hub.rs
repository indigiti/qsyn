//! Private chart quote fanout. Only a currently licensed viewer can open
//! an instrument/account-scoped subscription; no anonymous public WebSocket.
use crate::chart_entitlement::{ChartSigner,ChartViewer,EntitlementAttestation};
use crate::openalgo_stream::CandidateQuote;
use serde::Serialize;
use std::collections::HashMap;
use std::io;
use std::sync::Mutex;
use tokio::sync::broadcast;

fn denied() -> io::Error { io::Error::new(io::ErrorKind::PermissionDenied,"chart_subscription_denied") }
#[derive(Clone,Debug,Serialize)]
pub struct ChartQuote {
    pub schema: &'static str,
    pub tenant:String, pub account:String, pub instrument:String,
    pub time_ms:u64,pub price:f64, pub source: &'static str,
}
type Key=(String,String,String);
pub struct PrivateChartHub {
    queues:Mutex<HashMap<Key,broadcast::Sender<ChartQuote>>>,
    max_per_instrument:usize,
}
impl PrivateChartHub {
    pub fn new() -> Self {
        Self {queues:Mutex::new(HashMap::new()),max_per_instrument:256}
    }
    /// Enforce an HMAC grant *and* freshly checked provider/legal entitlement.
    pub fn subscribe(&self, signer:&ChartSigner,token:&str,now_ms:u64,
        viewer:&ChartViewer<'_>,rights:&EntitlementAttestation)
        -> io::Result<broadcast::Receiver<ChartQuote>> {
        signer.verify(token,now_ms,viewer,rights)?;
        let key=(viewer.tenant.to_owned(),viewer.account.to_owned(),
            viewer.instrument.to_owned());
        let mut streams=self.queues.lock().map_err(|_|denied())?;
        let feed=streams.entry(key)
            .or_insert_with(||broadcast::channel(self.max_per_instrument).0);
        Ok(feed.subscribe())
    }
    /// Called only by the separate, approved private source worker.
    /// This event is NOT a public market quote and is not a real order.
    pub fn publish(&self,quote:&CandidateQuote,now_ms:u64,
        rights:&EntitlementAttestation)->io::Result<usize>{
        if rights.tenant != quote.scope.tenant_id
            || rights.account != quote.scope.account_id
            || !rights.broker_session_verified
            || !rights.can_display_to_this_user
            || rights.license_id != quote.scope.entitlement_id
            || rights.valid_until_ms<=now_ms
            || !rights.instruments.contains(&quote.instrument_id)
            || quote.stale || quote.publishable_to_public_studio
            || quote.entitlement_verified || !quote.price.is_finite()
            || quote.price<=0.0 || quote.exchange_timestamp_ms>now_ms
            || now_ms.saturating_sub(quote.exchange_timestamp_ms)>5_000
        {return Err(denied());}
        let k=(rights.tenant.clone(),rights.account.clone(),quote.instrument_id.clone());
        let streams=self.queues.lock().map_err(|_|denied())?;
        let Some(feed)=streams.get(&k) else{return Ok(0)};
        let event=ChartQuote {schema:"QSYN-PRIVATE-CHART-TICK/1",
            tenant:rights.tenant.clone(),account:rights.account.clone(),
            instrument:quote.instrument_id.clone(),
            time_ms:quote.exchange_timestamp_ms,price:quote.price,
            source:"private_verified_ltp"};
        Ok(feed.send(event).unwrap_or(0))
    }
    pub fn clear(&self)->io::Result<()>{
        self.queues.lock().map_err(|_|denied())?.clear();
        Ok(())
    }
}
impl Default for PrivateChartHub {fn default()->Self{Self::new()}}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::market_pipeline::Scope;
    #[tokio::test]
    async fn licensed_user_receives_only_owned_account_and_instrument(){
        let signer=ChartSigner::new([77;32]);
        let rights=EntitlementAttestation{
            tenant:"T".into(),account:"A".into(),owner:"Alice".into(),
            broker:"upstox".into(),instruments:vec!["NFO|CE".into()],
            license_id:"L1".into(),broker_session_verified:true,
            can_display_to_this_user:true,valid_until_ms:900_000,
        };
        let viewer=ChartViewer{tenant:"T",account:"A",owner:"Alice",instrument:"NFO|CE"};
        let ticket=signer.issue(&rights,"NFO|CE",100_000,30_000).unwrap();
        let hub=PrivateChartHub::new();
        let mut receiver=hub.subscribe(&signer,&ticket,110_000,&viewer,&rights).unwrap();
        let quote=CandidateQuote{scope:Scope{
            tenant_id:"T".into(),account_id:"A".into(),
            source_id:"openalgo".into(),entitlement_id:"L1".into()},
            instrument_id:"NFO|CE".into(),price:123.0,
            exchange_timestamp_ms:109_995,received_timestamp_ms:110_000,
            stale:false,entitlement_verified:false,publishable_to_public_studio:false,
        };
        assert_eq!(hub.publish(&quote,110_000,&rights).unwrap(),1);
        assert_eq!(receiver.try_recv().unwrap().price,123.0);
        let mut foreign=quote.clone();foreign.scope.account_id="B".into();
        assert!(hub.publish(&foreign,110_000,&rights).is_err());
        let outsider=ChartViewer{tenant:"T",account:"B",owner:"Alice",instrument:"NFO|CE"};
        assert!(hub.subscribe(&signer,&ticket,110_000,&outsider,&rights).is_err());
        assert!(hub.subscribe(&signer,&ticket,131_000,&viewer,&rights).is_err());
        let mut removed=rights;
        removed.can_display_to_this_user=false;
        assert!(hub.publish(&quote,110_000,&removed).is_err());
    }
}
