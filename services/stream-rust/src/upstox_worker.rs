//! Operator-supervised Upstox V3 receiver with fresh authorization on every
//! reconnect. Requires a previously OAuth-authorized private file and
//! independent rights approval. Never grants exchange rights, orders or
//! publicly routable WebSocket access.
use crate::authorized_ingest::{PrivateIngestApproval, PrivatePersistentIngest};
use crate::market_pipeline::Scope;
use crate::private_chart_ws::{epoch_ms, load_rights, private_bytes};
use crate::upstox_v3::{
    observe_one_use_session_with_sink, validate_one_use_redirect, UpstoxV3Decoder, UpstoxV3Plan,
};
use reqwest::redirect::Policy;
use serde::{Deserialize, Serialize};
use std::io;
use std::path::{Path, PathBuf};
use tokio::time::{sleep, Duration};

fn denied() -> io::Error { io::Error::new(io::ErrorKind::PermissionDenied, "upstox_private_worker_denied") }

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerSettings {
    pub schema: String,
    pub tenant: String,
    pub account: String,
    pub owner: String,
    pub upstox_user_id: String,
    pub entitlement_id: String,
    pub ce_key: String,
    pub pe_key: String,
    pub contract_expiry_ms: u64,
    pub rights_expire_ms: u64,
    pub wal_root: PathBuf,
    pub private_chart_socket: PathBuf,
    pub private_rights_file: PathBuf,
    pub private_oauth_session_file: PathBuf,
    pub operator_approved_display: bool,
    pub operator_approved_retention: bool,
    pub current_bod_mapping_verified: bool,
    pub max_attempts: u32,
}
#[derive(Deserialize)]
struct OAuthSession {
    schema: String,
    broker: String,
    user_id: String,
    access_token: String,
    order_routing_enabled: bool,
    display_entitlement_verified: bool,
    retention_entitlement_verified: bool,
}
impl WorkerSettings {
    pub fn from_private_file(path: &Path) -> io::Result<Self> {
        let raw = private_bytes(path, 8192)?;
        let parsed: Self = serde_json::from_slice(&raw).map_err(|_| denied())?;
        parsed.validate(epoch_ms()?)?;
        Ok(parsed)
    }
    pub fn validate(&self, now: u64) -> io::Result<()> {
        if self.schema != "QSYN-UPSTOX-V3-PRIVATE-WORKER/1"
            || self.tenant.is_empty() || self.owner.is_empty()
            || self.account.is_empty() || self.upstox_user_id.is_empty()
            || self.entitlement_id.is_empty()
            || self.contract_expiry_ms <= now || self.rights_expire_ms <= now
            || !self.operator_approved_display || !self.operator_approved_retention
            || !self.current_bod_mapping_verified || !(1..=1000).contains(&self.max_attempts)
            || !self.private_chart_socket.is_absolute() {
            return Err(denied());
        }
        crate::durable_market_wal::root_check(&self.wal_root)?;
        let plan = self.plan();
        plan.validate(now)?;
        let rights = load_rights(&self.private_rights_file)?;
        if rights.tenant != self.tenant || rights.account != self.account
            || rights.owner != self.owner || rights.broker != "upstox"
            || rights.license_id != self.entitlement_id || !rights.broker_session_verified
            || !rights.can_display_to_this_user || rights.valid_until_ms <= now
            || !rights.instruments.contains(&self.ce_key)
            || !rights.instruments.contains(&self.pe_key) {
            return Err(denied());
        }
        let session = self.session()?;
        if session.user_id != self.upstox_user_id
            || session.schema != "QSYN-UPSTOX-AUTH-SESSION/1"
            || session.broker != "upstox"
            || session.order_routing_enabled || session.display_entitlement_verified
            || session.retention_entitlement_verified {
            return Err(denied());
        }
        Ok(())
    }
    /// Retention/display rights are independently checked at each history call.
    /// OAuth token remains only in this Rust process, never in the chart UI.
    pub(crate) fn private_history_token(&self, now_ms: u64) -> io::Result<String> {
        self.validate(now_ms)?;
        Ok(self.session()?.access_token)
    }

    fn session(&self) -> io::Result<OAuthSession> {
        let bytes = private_bytes(&self.private_oauth_session_file, 16384)?;
        let value: OAuthSession = serde_json::from_slice(&bytes).map_err(|_|denied())?;
        if value.access_token.len() < 20 || value.access_token.len() > 8192
            || !value.access_token.bytes().all(|b| b.is_ascii_graphic()) {
            return Err(denied());
        }
        Ok(value)
    }
    fn scope(&self) -> Scope {
        Scope { tenant_id: self.tenant.clone(), account_id: self.account.clone(),
            source_id: "upstox_v3_direct".into(), entitlement_id: self.entitlement_id.clone() }
    }
    fn plan(&self) -> UpstoxV3Plan {
        UpstoxV3Plan {
            scope: self.scope(), ce_key: self.ce_key.clone(), pe_key: self.pe_key.clone(),
            contract_expiry_ms: self.contract_expiry_ms,
            rights_expire_ms: self.rights_expire_ms,
            session_approved: true,
            instrument_mapping_verified: self.current_bod_mapping_verified,
            market_data_display_approved: self.operator_approved_display,
        }
    }
    fn ingestion_approval(&self) -> PrivateIngestApproval {
        PrivateIngestApproval {
            scope: self.scope(), approved_instruments: vec![self.ce_key.clone(), self.pe_key.clone()],
            licensed_persistence: self.operator_approved_retention,
            broker_session_verified: true,
            expires_ms: self.rights_expire_ms.min(self.contract_expiry_ms),
            max_delay_ms: 5_000,
        }
    }
}

/// Finite exponential recovery: 2s, 4s, 8s, 16s, <=30s.
fn retry_delay(attempt: u32) -> Duration {
    Duration::from_secs((1u64 << attempt.min(5)).min(30))
}

/// Authorize using the current account bearer token. The returned one-time
/// URL is used only in process memory and never logged or persisted.
fn transient_authorize() -> io::Error {
    io::Error::new(io::ErrorKind::TimedOut, "v3_authorize_temporarily_unavailable")
}
async fn authorize_next(client: &reqwest::Client, access_token: &str) -> io::Result<String> {
    let response = client.get("https://api.upstox.com/v3/feed/market-data-feed/authorize")
        .bearer_auth(access_token).header("Accept", "application/json")
        .send().await.map_err(|_|transient_authorize())?;
    if matches!(response.status().as_u16(), 401 | 403) { return Err(denied()); }
    if response.status() != reqwest::StatusCode::OK {
        return Err(io::Error::new(io::ErrorKind::TimedOut, "v3_authorization_unavailable"));
    }
    let body = response.bytes().await.map_err(|_|transient_authorize())?;
    if body.len() > 4096 { return Err(denied()); }
    let value: serde_json::Value = serde_json::from_slice(&body).map_err(|_|denied())?;
    if value["status"] != "success" {return Err(denied());}
    let url = value["data"]["authorized_redirect_uri"].as_str().ok_or_else(denied)?;
    validate_one_use_redirect(url)?;
    Ok(url.to_owned())
}

/// Call under a real operator-approved process supervisor: it is NOT started
/// by the existing demo daemon. Reconnect obtains new one-use URLs, checks
/// rights each cycle, deduplicates via WAL restart watermarks, bounds retries.
pub async fn run(settings: &WorkerSettings) -> io::Result<()> {
    let client = reqwest::Client::builder().https_only(true)
        .redirect(Policy::none()).connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(12)).build().map_err(|_| denied())?;
    let mut attempts = 0u32;
    while attempts < settings.max_attempts {
        let now = epoch_ms()?;
        // Failure of rights, keys, scope, local WAL readiness or expiry is a
        // hard stop. An operator must intervene; never spin on revoked rights.
        settings.validate(now)?;
        let session = settings.session()?;
        attempts += 1;
        // A one-use URL can be temporarily unavailable (timeout, rate limit,
        // upstream 5xx). Obtain a fresh URL on EACH reconnect/retry.
        // Broker 401/403 is terminal and requires a NEW operator OAuth login.
        match authorize_next(&client, &session.access_token).await {
            Ok(url) => {
                let mut ingest = PrivatePersistentIngest::open(
                    &settings.wal_root, settings.ingestion_approval(), now,
                )?;
                let mut decoder = UpstoxV3Decoder::new(settings.plan(), now)?;
                let guid = format!("qsyn-{}-{}", std::process::id(), attempts);
                let result = observe_one_use_session_with_sink(
                    &url, &mut decoder, &mut ingest, &guid, 120,
                    Some((&settings.private_rights_file, &settings.private_chart_socket)),
                ).await;
                if let Err(error) = result {
                    // Privileged worker logs omit all URLs, keys, tokens and
                    // quote payloads. Entitlement revoked => hard stop.
                    if error.kind() == io::ErrorKind::PermissionDenied {
                        return Err(denied());
                    }
                }
            }
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
                return Err(denied());
            }
            Err(_) => {} // transient issue, bounded retry after backoff
        }
        if attempts < settings.max_attempts {
            sleep(retry_delay(attempts)).await;
        }
    }
    Err(denied())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retry_delays_are_bounded_and_authorization_fail_closed() {
        assert_eq!(retry_delay(1), Duration::from_secs(2));
        assert_eq!(retry_delay(4), Duration::from_secs(16));
        assert_eq!(retry_delay(100), Duration::from_secs(30));
    }
    #[test]
    fn absent_broker_approval_never_activates() {
        let s = WorkerSettings {
            schema:"QSYN-UPSTOX-V3-PRIVATE-WORKER/1".into(),
            tenant:"tenant".into(),account:"account".into(),owner:"owner".into(),
            upstox_user_id:"upstox-user".into(),entitlement_id:"license".into(),
            ce_key:"NSE_FO|10001".into(),pe_key:"NSE_FO|10002".into(),
            contract_expiry_ms:9999999,rights_expire_ms:9999999,
            wal_root:PathBuf::from("/nonexistent"),
            private_chart_socket:PathBuf::from("/tmp/example-private.sock"),
            private_rights_file:PathBuf::from("/nonexistent/rights"),
            private_oauth_session_file:PathBuf::from("/nonexistent/session"),
            operator_approved_display:false,operator_approved_retention:false,
            current_bod_mapping_verified:false,max_attempts:2,
        };
        assert!(s.validate(1000).is_err());
        let mut q=s;
        q.operator_approved_display=true;
        q.operator_approved_retention=true;
        q.current_bod_mapping_verified=true;
        // Still fails without a private 0700 WAL and real 0600 rights/session.
        assert!(q.validate(1000).is_err());
    }
}
