//! Isolated NSE/BSE Upstox V3 index worker. No web-origin execution,
//! no operator-implicit approvals, no public sockets or broker orders.
use crate::authorized_ingest::{PrivateIngestApproval, PrivatePersistentIngest};
use crate::market_pipeline::Scope;
use crate::private_chart_ws::{epoch_ms, load_rights, private_bytes};
use crate::upstox_v3::{
    observe_one_use_index_session_with_sink, ApprovedIndexInstrument, UpstoxIndexV3Plan,
    UpstoxV3IndexDecoder,
};
use crate::upstox_worker::authorize_next;
use reqwest::redirect::Policy;
use serde::{Deserialize, Serialize};
use std::io;
use std::path::{Path, PathBuf};
use tokio::time::{sleep, Duration};

fn denied() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "private_upstox_index_worker_denied",
    )
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct IndexWorkerSettings {
    pub schema: String,
    pub tenant: String,
    pub account: String,
    pub owner: String,
    pub upstox_user_id: String,
    pub entitlement_id: String,
    pub instruments: Vec<ApprovedIndexInstrument>,
    pub rights_expire_ms: u64,
    pub wal_root: PathBuf,
    pub private_chart_socket: PathBuf,
    pub private_rights_file: PathBuf,
    pub private_oauth_session_file: PathBuf,
    /// Independent, dated operator BOD attestation: a boolean alone is insufficient.
    pub private_index_mapping_file: PathBuf,
    pub operator_approved_display: bool,
    pub operator_approved_retention: bool,
    pub current_bod_mapping_verified: bool,
    pub max_attempts: u32,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OAuthSession {
    schema: String,
    broker: String,
    user_id: String,
    access_token: String,
    created_at: String,
    order_routing_enabled: bool,
    display_entitlement_verified: bool,
    retention_entitlement_verified: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MappingAttestation {
    schema: String,
    tenant: String,
    account: String,
    owner: String,
    upstox_user_id: String,
    source: String,
    checked_at_ms: u64,
    bod_date_ist: String,
    operator_attested: bool,
    instruments: Vec<ApprovedIndexInstrument>,
}

fn mapping_matches(settings: &IndexWorkerSettings, now: u64) -> io::Result<()> {
    let mapping: MappingAttestation =
        serde_json::from_slice(&private_bytes(&settings.private_index_mapping_file, 8192)?)
            .map_err(|_| denied())?;
    let ist = chrono::FixedOffset::east_opt(5 * 3600 + 30 * 60).ok_or_else(denied)?;
    let now_i64 = i64::try_from(now).map_err(|_| denied())?;
    let utc = chrono::DateTime::from_timestamp_millis(now_i64).ok_or_else(denied)?;
    let date = utc.with_timezone(&ist).format("%Y-%m-%d").to_string();
    if mapping.schema != "QSYN-UPSTOX-INDEX-BOD-MAPPING/1"
        || mapping.source != "operator_checked_official_upstox_bod_json"
        || !mapping.operator_attested
        || mapping.tenant != settings.tenant
        || mapping.account != settings.account
        || mapping.owner != settings.owner
        || mapping.upstox_user_id != settings.upstox_user_id
        || mapping.bod_date_ist != date
        || mapping.checked_at_ms > now
        || now.saturating_sub(mapping.checked_at_ms) > 16 * 60 * 60 * 1000
        || mapping.instruments.len() != settings.instruments.len()
        || mapping
            .instruments
            .iter()
            .any(|value| !settings.instruments.contains(value))
    {
        return Err(denied());
    }
    Ok(())
}

impl IndexWorkerSettings {
    pub fn from_private_file(path: &Path) -> io::Result<Self> {
        let raw = private_bytes(path, 8192)?;
        let parsed: Self = serde_json::from_slice(&raw).map_err(|_| denied())?;
        parsed.validate(epoch_ms()?)?;
        Ok(parsed)
    }
    fn scope(&self) -> Scope {
        Scope {
            tenant_id: self.tenant.clone(),
            account_id: self.account.clone(),
            source_id: "upstox_v3_direct".into(),
            entitlement_id: self.entitlement_id.clone(),
        }
    }
    fn plan(&self) -> UpstoxIndexV3Plan {
        UpstoxIndexV3Plan {
            scope: self.scope(),
            instruments: self.instruments.clone(),
            rights_expire_ms: self.rights_expire_ms,
            session_approved: true,
            instrument_mapping_verified: self.current_bod_mapping_verified,
            market_data_display_approved: self.operator_approved_display,
        }
    }
    fn session(&self) -> io::Result<OAuthSession> {
        let session: OAuthSession =
            serde_json::from_slice(&private_bytes(&self.private_oauth_session_file, 16384)?)
                .map_err(|_| denied())?;
        if session.schema != "QSYN-UPSTOX-AUTH-SESSION/1"
            || session.broker != "upstox"
            || session.user_id != self.upstox_user_id
            || session.created_at.is_empty()
            || session.order_routing_enabled
            || session.display_entitlement_verified
            || session.retention_entitlement_verified
            || session.access_token.len() < 20
            || session.access_token.len() > 8192
            || !session.access_token.bytes().all(|b| b.is_ascii_graphic())
        {
            return Err(denied());
        }
        Ok(session)
    }
    pub fn validate(&self, now: u64) -> io::Result<()> {
        if self.schema != "QSYN-UPSTOX-INDEX-PRIVATE-WORKER/1"
            || self.tenant.is_empty()
            || self.tenant.len() > 128
            || self.account.is_empty()
            || self.account.len() > 128
            || self.owner.is_empty()
            || self.owner.len() > 128
            || self.upstox_user_id.is_empty()
            || self.upstox_user_id.len() > 128
            || self.entitlement_id.is_empty()
            || self.entitlement_id.len() > 128
            || !self.operator_approved_display
            || !self.operator_approved_retention
            || !self.current_bod_mapping_verified
            || !(1..=1000).contains(&self.max_attempts)
            || !self.private_chart_socket.is_absolute()
            || self.rights_expire_ms <= now
        {
            return Err(denied());
        }
        self.plan().validate(now)?;
        mapping_matches(self, now)?;
        crate::durable_market_wal::root_check(&self.wal_root)?;
        let rights = load_rights(&self.private_rights_file)?;
        if rights.tenant != self.tenant
            || rights.account != self.account
            || rights.owner != self.owner
            || rights.broker != "upstox"
            || rights.license_id != self.entitlement_id
            || !rights.can_display_to_this_user
            || !rights.broker_session_verified
            || rights.valid_until_ms <= now
            || rights.valid_until_ms < self.rights_expire_ms
            || self
                .instruments
                .iter()
                .any(|i| !rights.instruments.contains(&i.instrument_key))
        {
            return Err(denied());
        }
        let _ = self.session()?;
        Ok(())
    }
    fn approval(&self) -> PrivateIngestApproval {
        PrivateIngestApproval {
            scope: self.scope(),
            approved_instruments: self
                .instruments
                .iter()
                .map(|i| i.instrument_key.clone())
                .collect(),
            licensed_persistence: self.operator_approved_retention,
            broker_session_verified: true,
            expires_ms: self.rights_expire_ms,
            max_delay_ms: 5000,
        }
    }
}
fn retry_delay(attempt: u32) -> Duration {
    Duration::from_secs((1u64 << attempt.min(5)).min(30))
}
pub async fn run(settings: &IndexWorkerSettings) -> io::Result<()> {
    let client = reqwest::Client::builder()
        .https_only(true)
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|_| denied())?;
    let mut attempts = 0;
    while attempts < settings.max_attempts {
        let now = epoch_ms()?;
        // Hard stop whenever current operator approval, private session,
        // WAL or chart rights are absent or revoked.
        settings.validate(now)?;
        let session = settings.session()?;
        attempts += 1;
        match authorize_next(&client, &session.access_token).await {
            Ok(one_use_url) => {
                let mut wal =
                    PrivatePersistentIngest::open(&settings.wal_root, settings.approval(), now)?;
                let mut decoder = UpstoxV3IndexDecoder::new(settings.plan(), now)?;
                let guid = format!("qsynidx-{}-{}", std::process::id(), attempts);
                let observed = observe_one_use_index_session_with_sink(
                    &one_use_url,
                    &mut decoder,
                    &mut wal,
                    &guid,
                    120,
                    Some((
                        &settings.private_rights_file,
                        &settings.private_chart_socket,
                    )),
                )
                .await;
                if let Err(error) = observed {
                    if error.kind() == io::ErrorKind::PermissionDenied {
                        return Err(denied());
                    }
                    // Timeout and upstream closure may reconnect using a NEW URL.
                }
            }
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
                return Err(denied());
            }
            Err(_) => {}
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
    fn bod_mapping_must_be_current_private_exact_and_operator_checked() {
        use std::os::unix::fs::PermissionsExt;
        let folder = std::env::temp_dir().join(format!(
            "qsyn-test-index-mapping-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&folder).unwrap();
        std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o700)).unwrap();
        let path = folder.join("mapping.json");
        let now = 1_792_080_000_000u64;
        let date = chrono::DateTime::from_timestamp_millis(now as i64)
            .unwrap()
            .with_timezone(&chrono::FixedOffset::east_opt(19_800).unwrap())
            .format("%Y-%m-%d")
            .to_string();
        let settings = IndexWorkerSettings {
            schema: "QSYN-UPSTOX-INDEX-PRIVATE-WORKER/1".into(),
            tenant: "a".into(),
            account: "b".into(),
            owner: "c".into(),
            upstox_user_id: "provider".into(),
            entitlement_id: "license".into(),
            instruments: vec![ApprovedIndexInstrument {
                exchange: "NSE_INDEX".into(),
                symbol: "NIFTY".into(),
                instrument_key: "NSE_INDEX|Nifty 50".into(),
            }],
            rights_expire_ms: now + 60_000,
            wal_root: folder.clone(),
            private_chart_socket: folder.join("chart.sock"),
            private_rights_file: folder.join("rights"),
            private_oauth_session_file: folder.join("session"),
            private_index_mapping_file: path.clone(),
            operator_approved_display: false,
            operator_approved_retention: false,
            current_bod_mapping_verified: true,
            max_attempts: 1,
        };
        let sample = serde_json::json!({
            "schema":"QSYN-UPSTOX-INDEX-BOD-MAPPING/1",
            "tenant":"a","account":"b","owner":"c","upstox_user_id":"provider",
            "source":"operator_checked_official_upstox_bod_json",
            "checked_at_ms":now,"bod_date_ist":date,
            "operator_attested":true,
            "instruments":settings.instruments
        });
        let write = |data: &serde_json::Value, mode: u32| {
            std::fs::write(&path, serde_json::to_vec(data).unwrap()).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
        };
        write(&sample, 0o600);
        assert!(mapping_matches(&settings, now).is_ok());
        assert!(mapping_matches(&settings, now + 17 * 60 * 60 * 1000).is_err());
        let mut bad = sample.clone();
        bad["operator_attested"] = serde_json::json!(false);
        write(&bad, 0o600);
        assert!(mapping_matches(&settings, now).is_err());
        let mut bad = sample.clone();
        bad["instruments"][0]["instrument_key"] = serde_json::json!("NSE_INDEX|WRONG");
        write(&bad, 0o600);
        assert!(mapping_matches(&settings, now).is_err());
        let mut bad = sample.clone();
        bad["account"] = serde_json::json!("other-account");
        write(&bad, 0o600);
        assert!(mapping_matches(&settings, now).is_err());
        write(&sample, 0o644);
        assert!(mapping_matches(&settings, now).is_err());
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&folder);
    }

    #[test]
    fn unapproved_index_worker_is_inert() {
        let s = IndexWorkerSettings {
            schema: "QSYN-UPSTOX-INDEX-PRIVATE-WORKER/1".into(),
            tenant: "tenant-a".into(),
            account: "account-a".into(),
            owner: "owner-a".into(),
            upstox_user_id: "upstox-id".into(),
            entitlement_id: "license".into(),
            instruments: vec![ApprovedIndexInstrument {
                exchange: "NSE_INDEX".into(),
                symbol: "NIFTY".into(),
                instrument_key: "NSE_INDEX|Nifty 50".into(),
            }],
            rights_expire_ms: 500_000,
            wal_root: PathBuf::from("/nonexistent"),
            private_chart_socket: PathBuf::from("/tmp/upstox-index-test.sock"),
            private_rights_file: PathBuf::from("/nonexistent/rights"),
            private_oauth_session_file: PathBuf::from("/nonexistent/session"),
            private_index_mapping_file: PathBuf::from("/nonexistent/mapping"),
            operator_approved_display: false,
            operator_approved_retention: false,
            current_bod_mapping_verified: false,
            max_attempts: 3,
        };
        assert!(s.validate(100_000).is_err());
        let mut enabled = s;
        enabled.operator_approved_display = true;
        enabled.operator_approved_retention = true;
        enabled.current_bod_mapping_verified = true;
        assert!(enabled.validate(100_000).is_err()); // no signed rights/session/WAL
        assert_eq!(retry_delay(1), Duration::from_secs(2));
        assert_eq!(retry_delay(100), Duration::from_secs(30));
    }
}
