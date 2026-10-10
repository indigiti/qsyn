//! Signed, short-lived private market-data subscription grants.
//! A broker login does not imply exchange or redistribution entitlement.
//! No grant is issued without an explicit server-side licensing attestation.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::io;

fn denied() -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, "market_data_grant_denied")
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ChartGrant {
    pub version: u8,
    pub tenant: String,
    pub account: String,
    pub owner: String,
    pub broker: String,
    pub instrument: String,
    pub license_id: String,
    pub audience: String,
    pub issued_ms: u64,
    pub expires_ms: u64,
}

#[derive(Clone, Debug)]
pub struct EntitlementAttestation {
    pub tenant: String,
    pub account: String,
    pub owner: String,
    pub broker: String,
    pub instruments: Vec<String>,
    pub license_id: String,
    pub can_display_to_this_user: bool,
    pub broker_session_verified: bool,
    pub valid_until_ms: u64,
}

fn ident(s: &str) -> bool {
    !s.is_empty() && s.len() <= 128
        && s.bytes().all(|b| b.is_ascii_alphanumeric()
            || matches!(b, b'_' | b'-' | b'.' | b':' | b'|'))
}
type Hmac256 = Hmac<Sha256>;

pub struct ChartSigner { secret: [u8; 32] }
impl ChartSigner {
    pub fn new(secret: [u8; 32]) -> Self { Self { secret } }
    pub fn issue(
        &self, attested: &EntitlementAttestation,
        instrument: &str,
        now_ms: u64,
        duration_ms: u64,
    ) -> io::Result<String> {
        if !attested.can_display_to_this_user || !attested.broker_session_verified
            || !attested.instruments.iter().any(|s| s == instrument)
            || ![&attested.tenant, &attested.account, &attested.owner, &attested.broker,
                &attested.license_id].iter().all(|s| ident(s))
            || !ident(instrument) || now_ms == 0
            || !(1_000..=300_000).contains(&duration_ms)
        { return Err(denied()); }
        let expires = now_ms.checked_add(duration_ms).ok_or_else(denied)?;
        if expires > attested.valid_until_ms { return Err(denied()); }
        let claim = ChartGrant {
            version: 1, tenant: attested.tenant.clone(), account: attested.account.clone(),
            owner: attested.owner.clone(), broker: attested.broker.clone(),
            instrument: instrument.to_string(), license_id: attested.license_id.clone(),
            audience: "qsyn-private-chart".into(),
            issued_ms: now_ms, expires_ms: expires,
        };
        let payload = serde_json::to_vec(&claim)?;
        let mut mac = Hmac256::new_from_slice(&self.secret).map_err(|_| denied())?;
        mac.update(&payload);
        let tag = mac.finalize().into_bytes();
        Ok(format!("{}.{}", URL_SAFE_NO_PAD.encode(payload), URL_SAFE_NO_PAD.encode(tag)))
    }

    pub fn verify(
        &self, token: &str, now_ms: u64, tenant: &str,
        account: &str, owner: &str, instrument: &str,
        current: &EntitlementAttestation,
    ) -> io::Result<ChartGrant> {
        if token.len() > 2048 || token.contains(char::is_whitespace) {
            return Err(denied());
        }
        let (message, signature) = token.split_once('.').ok_or_else(denied)?;
        let payload = URL_SAFE_NO_PAD.decode(message).map_err(|_| denied())?;
        let tag = URL_SAFE_NO_PAD.decode(signature).map_err(|_| denied())?;
        let mut mac = Hmac256::new_from_slice(&self.secret).map_err(|_| denied())?;
        mac.update(&payload);
        mac.verify_slice(&tag).map_err(|_| denied())?;
        let claim: ChartGrant = serde_json::from_slice(&payload).map_err(|_| denied())?;
        if claim.version != 1 || claim.audience != "qsyn-private-chart"
            || claim.tenant != tenant || claim.account != account || claim.owner != owner
            || claim.instrument != instrument || claim.tenant != current.tenant
            || claim.account != current.account || claim.owner != current.owner
            || claim.broker != current.broker || claim.license_id != current.license_id
            || !current.can_display_to_this_user || !current.broker_session_verified
            || !current.instruments.iter().any(|v| v == instrument)
            || claim.issued_ms == 0 || claim.issued_ms > now_ms
            || claim.expires_ms <= now_ms || claim.expires_ms > current.valid_until_ms
            || claim.expires_ms - claim.issued_ms > 300_000
        { return Err(denied()); }
        Ok(claim)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn attestation() -> EntitlementAttestation {
        EntitlementAttestation {
            tenant:"tenantA".into(), account:"upstoxA".into(),
            owner:"ownerA".into(), broker:"upstox".into(),
            instruments:vec!["NFO|CE".into(), "NFO|PE".into()],
            license_id:"user-display-only".into(), can_display_to_this_user:true,
            broker_session_verified:true, valid_until_ms:900_000,
        }
    }
    #[test]
    fn verifies_scope_expiry_tamper_and_revocation() {
        let signer = ChartSigner::new([17;32]);
        let att = attestation();
        let t = signer.issue(&att,"NFO|CE",100_000,30_000).unwrap();
        assert!(signer.verify(&t,110_000,"tenantA","upstoxA","ownerA","NFO|CE",&att).is_ok());
        assert!(signer.verify(&t,110_000,"tenantA","upstoxB","ownerA","NFO|CE",&att).is_err());
        assert!(signer.verify(&t,110_000,"tenantA","upstoxA","ownerB","NFO|CE",&att).is_err());
        assert!(signer.verify(&t,131_000,"tenantA","upstoxA","ownerA","NFO|CE",&att).is_err());
        assert!(signer.verify(&t,110_000,"tenantA","upstoxA","ownerA","NFO|PE",&att).is_err());
        let mut changed = t.clone();changed.push('x');
        assert!(signer.verify(&changed,110_000,"tenantA","upstoxA","ownerA","NFO|CE",&att).is_err());
        let mut revoked = att.clone();
        revoked.can_display_to_this_user = false;
        assert!(signer.verify(&t,110_000,"tenantA","upstoxA","ownerA","NFO|CE",&revoked).is_err());
        let mut switched = att;
        switched.license_id="different-license".into();
        assert!(signer.verify(&t,110_000,"tenantA","upstoxA","ownerA","NFO|CE",&switched).is_err());
    }
    #[test]
    fn refuses_broker_login_without_actual_exchange_entitlement() {
        let signer = ChartSigner::new([19;32]);
        let mut att = attestation();
        att.can_display_to_this_user=false;
        assert!(signer.issue(&att,"NFO|CE",100_000,30_000).is_err());
        att.can_display_to_this_user=true;
        att.broker_session_verified=false;
        assert!(signer.issue(&att,"NFO|CE",100_000,30_000).is_err());
        att.broker_session_verified=true;
        assert!(signer.issue(&att,"NFO|CE",100_000,301_000).is_err());
    }
}
