//! Loopback-only, ticket-scoped access to verified private Upstox V3 leg
//! archives. This service does not connect to Upstox, execute orders, or
//! publish anonymous market data. Reverse-proxy ingress MUST independently
//! authenticate the browser and keep this port private.
use axum::{
    extract::State, http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response}, routing::get, Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{Days, FixedOffset, Utc};
use crate::{
    chart_entitlement::{ChartGrant, ChartSigner, ChartViewer},
    immutable_candles::{CandlePartition, SeriesDescriptor},
    market_pipeline::DataMode,
    private_chart_ws::{epoch_ms, load_rights, load_secret},
    upstox_worker::WorkerSettings,
};
use serde::Serialize;
use std::{io, net::{Ipv4Addr, SocketAddrV4}, path::{Path, PathBuf}, sync::Arc};

fn denied() -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, "private_history_access_denied")
}
#[derive(Clone)]
pub struct HistoryConfig {
    pub settings_path: PathBuf,
    pub signing_key_path: PathBuf,
    pub archive_root: PathBuf,
}
impl HistoryConfig {
    pub fn verify(&self, now: u64) -> io::Result<WorkerSettings> {
        let settings=WorkerSettings::from_private_file(&self.settings_path)?;
        settings.validate(now)?;
        crate::durable_market_wal::root_check(&self.archive_root)?;
        let _=load_secret(&self.signing_key_path)?;
        Ok(settings)
    }
}
#[derive(Clone, Serialize, Debug, PartialEq)]
pub struct PrivateHistoryBar {
    time: u64, open: f64, high: f64, low: f64, close: f64,
}
#[derive(Serialize)]
struct PrivateHistoryResponse {
    schema: &'static str,
    source: &'static str,
    account: String,
    instrument: String,
    exchange: &'static str,
    interval: &'static str,
    trading_enabled: bool,
    public_redistribution_allowed: bool,
    history_complete: bool,
    bars: Vec<PrivateHistoryBar>,
}
fn token_from_headers(headers: &HeaderMap) -> io::Result<&str> {
    let raw=headers.get(header::AUTHORIZATION)
        .ok_or_else(denied)?.to_str().map_err(|_| denied())?;
    let value=raw.strip_prefix("Bearer ").ok_or_else(denied)?;
    if value.is_empty() || value.len()>2048 || value.contains(char::is_whitespace) {
        return Err(denied());
    }
    Ok(value)
}
pub fn validate_ticket(
    token: &str, now: u64, settings: &WorkerSettings,
    rights_path: &Path, signing_key_path: &Path,
) -> io::Result<ChartGrant> {
    if token.len()>2048 {return Err(denied());}
    let payload=token.split_once('.').ok_or_else(denied)?.0;
    let decoded=URL_SAFE_NO_PAD.decode(payload).map_err(|_|denied())?;
    if decoded.len()>1024 {return Err(denied());}
    let claim: ChartGrant=serde_json::from_slice(&decoded).map_err(|_|denied())?;
    let signer=ChartSigner::new(load_secret(signing_key_path)?);
    let rights=load_rights(rights_path)?;
    let viewer=ChartViewer {
        tenant:&claim.tenant,account:&claim.account,
        owner:&claim.owner,instrument:&claim.instrument,
    };
    signer.verify(token,now,&viewer,&rights)?;
    if claim.tenant!=settings.tenant || claim.owner!=settings.owner
        || claim.account!=settings.account || claim.broker!="upstox"
        || claim.license_id!=settings.entitlement_id
        || (claim.instrument!=settings.ce_key && claim.instrument!=settings.pe_key)
        || claim.expires_ms.saturating_sub(claim.issued_ms)>30_000
        || !settings.operator_approved_retention || !settings.operator_approved_display {
        return Err(denied());
    }
    Ok(claim)
}
fn ist() -> io::Result<FixedOffset> {
    FixedOffset::east_opt(5*3600+30*60).ok_or_else(denied)
}
/// Read a bounded recent window of individually CRC-verified immutable
/// candles. Missing dates are normal (weekends/unimported periods); a
/// corrupt or unauthorized file is a hard failure and never silently skipped.
pub fn read_recent_bars(
    archive_root: &Path, settings: &WorkerSettings,
    instrument: &str, now: u64, max_bars: usize,
) -> io::Result<Vec<PrivateHistoryBar>> {
    if max_bars==0 || max_bars>1200
        || (instrument!=settings.ce_key && instrument!=settings.pe_key) {
        return Err(denied());
    }
    let number=instrument.strip_prefix("NSE_FO|").ok_or_else(denied)?;
    if number.is_empty() || number.len()>24
        || !number.bytes().all(|x|x.is_ascii_digit()) {
        return Err(denied());
    }
    let now_utc=chrono::DateTime::<Utc>::from_timestamp_millis(
        i64::try_from(now).map_err(|_|denied())?
    ).ok_or_else(denied)?;
    let today=now_utc.with_timezone(&ist()?).date_naive();
    let mut result=Vec::new();
    for days_ago in (1..=30).rev() {
        let day=today.checked_sub_days(Days::new(days_ago)).ok_or_else(denied)?;
        let descriptor=SeriesDescriptor {
            scope:crate::market_pipeline::Scope {
                tenant_id:settings.tenant.clone(),
                account_id:settings.account.clone(),
                source_id:"upstox_v3_history".into(),
                entitlement_id:settings.entitlement_id.clone(),
            },
            mode:DataMode::Replay,
            series_id:format!("NSE_FO_{}_{}",number,day.format("%Y%m%d")),
            interval_ms:60_000,
        };
        let partition=day.format("%Y%m").to_string();
        let mut reader=match CandlePartition::open(archive_root,&partition,&descriptor) {
            Ok(file)=>file,
            Err(e) if e.kind()==io::ErrorKind::NotFound=>continue,
            Err(_)=>return Err(denied()),
        };
        // Verify every row, not only returned subset.
        reader.audit()?;
        for bar in reader.range(0,now,max_bars)? {
            result.push(PrivateHistoryBar {
                time:bar.open_time_ms/1000,
                open:bar.open,high:bar.high,low:bar.low,close:bar.close,
            });
        }
        if result.len()>max_bars {
            let discard=result.len()-max_bars;
            result.drain(0..discard);
        }
    }
    Ok(result)
}
fn response_for_token(cfg: &HistoryConfig, token: &str, now: u64)
    -> io::Result<PrivateHistoryResponse>
{
    let settings=cfg.verify(now)?;
    let claim=validate_ticket(token,now,&settings,
        &settings.private_rights_file,&cfg.signing_key_path)?;
    let bars=read_recent_bars(&cfg.archive_root,&settings,&claim.instrument,now,1200)?;
    Ok(PrivateHistoryResponse {
        schema:"QSYN-UPSTOX-PRIVATE-HISTORY/1",
        source:"licensed_private_history",
        account:claim.account,instrument:claim.instrument,
        exchange:"UPSTOX_PRIVATE",interval:"1m",
        trading_enabled:false,public_redistribution_allowed:false,
        // A backfill is NOT complete until history continuity/coverage and
        // public redistribution checks are independently audited.
        history_complete:false,bars,
    })
}
async fn handler(State(cfg):State<Arc<HistoryConfig>>, headers:HeaderMap)->Response {
    let status_and_payload=(|| -> io::Result<PrivateHistoryResponse> {
        let token=token_from_headers(&headers)?;
        response_for_token(&cfg,token,epoch_ms()?)
    })();
    match status_and_payload {
        Ok(body)=> (
            [(header::CACHE_CONTROL,"private, no-store"),
             (header::PRAGMA,"no-cache"),
             (header::X_CONTENT_TYPE_OPTIONS,"nosniff")],
            Json(body),
        ).into_response(),
        Err(_)=>(
            StatusCode::FORBIDDEN,
            [(header::CACHE_CONTROL,"private, no-store")],
            Json(serde_json::json!({"error":"private_history_unavailable"})),
        ).into_response(),
    }
}
pub fn router(cfg: HistoryConfig)->Router {
    Router::new().route("/qsyn/private-chart/history",get(handler))
        .with_state(Arc::new(cfg))
}
pub async fn serve(port:u16,cfg:HistoryConfig)->io::Result<()> {
    if !(1025..=65535).contains(&port) {return Err(denied());}
    cfg.verify(epoch_ms()?)?;
    let listener=tokio::net::TcpListener::bind(
        SocketAddrV4::new(Ipv4Addr::LOCALHOST,port)
    ).await?;
    axum::serve(listener,router(cfg)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        chart_entitlement::{ChartSigner,EntitlementAttestation},
        immutable_candles,
        market_pipeline::{Candle,Scope},
    };
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    fn setup()->(PathBuf,WorkerSettings,HistoryConfig,[u8;32]) {
        use std::time::{SystemTime,UNIX_EPOCH};
        let now=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root=std::env::temp_dir().join(format!("qsyn-history-gate-{}-{now}",std::process::id()));
        fs::create_dir(&root).unwrap();
        let wal=root.join("wal");let archive=root.join("history");
        fs::create_dir(&wal).unwrap();fs::create_dir(&archive).unwrap();
        #[cfg(unix)]
        for dir in [&root,&wal,&archive] {
            fs::set_permissions(dir,fs::Permissions::from_mode(0o700)).unwrap();
        }
        let now=epoch_ms().unwrap();
        let rights=root.join("rights.json");let oauth=root.join("oauth.json");
        let key=root.join("signing.key");let settings_path=root.join("settings.json");
        fs::write(&rights,serde_json::json!({
            "schema":"QSYN-PRIVATE-CHART-ENTITLEMENT/1",
            "tenant":"T","account":"A","owner":"U","broker":"upstox",
            "instruments":["NSE_FO|12345","NSE_FO|12346"],
            "license_id":"L","can_display_to_this_user":true,
            "broker_session_verified":true,"valid_until_ms":now+600_000
        }).to_string()).unwrap();
        fs::write(&oauth,serde_json::json!({
            "schema":"QSYN-UPSTOX-AUTH-SESSION/1","broker":"upstox",
            "user_id":"REALTEST","access_token":"TESTNOTREAL0012345678901234567",
            "order_routing_enabled":false,"display_entitlement_verified":false,
            "retention_entitlement_verified":false
        }).to_string()).unwrap();
        let secret=[42u8;32];fs::write(&key,secret).unwrap();
        #[cfg(unix)] for path in [&rights,&oauth,&key] {
            fs::set_permissions(path,fs::Permissions::from_mode(0o600)).unwrap();
        }
        let plan=WorkerSettings {
            schema:"QSYN-UPSTOX-V3-PRIVATE-WORKER/1".into(),tenant:"T".into(),
            account:"A".into(),owner:"U".into(),upstox_user_id:"REALTEST".into(),
            entitlement_id:"L".into(),ce_key:"NSE_FO|12345".into(),
            pe_key:"NSE_FO|12346".into(),contract_expiry_ms:now+600_000,
            rights_expire_ms:now+600_000,wal_root:wal,
            private_chart_socket:root.join("chart.sock"),
            private_rights_file:rights,private_oauth_session_file:oauth,
            operator_approved_display:true,operator_approved_retention:true,
            current_bod_mapping_verified:true,max_attempts:3,
        };
        fs::write(&settings_path,serde_json::to_vec(&plan).unwrap()).unwrap();
        #[cfg(unix)] fs::set_permissions(&settings_path,fs::Permissions::from_mode(0o600)).unwrap();
        (root,plan,HistoryConfig {
            settings_path,signing_key_path:key,archive_root:archive,
        },secret)
    }
    #[test]
    fn token_scope_history_replay_and_revocation_are_denied_or_scoped(){
        let (root,plan,cfg,secret)=setup();
        let now=epoch_ms().unwrap();
        let day=Utc::now().with_timezone(&ist().unwrap()).date_naive()
            .checked_sub_days(Days::new(2)).unwrap();
        let at=day.and_hms_opt(9,15,0).unwrap().and_local_timezone(ist().unwrap())
            .single().unwrap().timestamp_millis() as u64;
        let spec=SeriesDescriptor {
            scope:Scope{tenant_id:"T".into(),account_id:"A".into(),
                source_id:"upstox_v3_history".into(),entitlement_id:"L".into()},
            mode:DataMode::Replay,series_id:format!("NSE_FO_12345_{}",day.format("%Y%m%d")),
            interval_ms:60_000,
        };
        immutable_candles::publish(&cfg.archive_root,&day.format("%Y%m").to_string(),
            &spec,&[Candle{
                open_time_ms:at,open:100.0,high:103.0,low:99.0,close:102.0,observations:1,
            }]).unwrap();
        let signer=ChartSigner::new(secret);
        let att=EntitlementAttestation {
            tenant:"T".into(),owner:"U".into(),account:"A".into(),
            broker:"upstox".into(),license_id:"L".into(),
            instruments:vec![plan.ce_key.clone(),plan.pe_key.clone()],
            can_display_to_this_user:true,broker_session_verified:true,
            valid_until_ms:now+600_000,
        };
        let ticket=signer.issue(&att,&plan.ce_key,now,30_000).unwrap();
        let body=response_for_token(&cfg,&ticket,now+300).unwrap();
        assert_eq!(body.bars.len(),1);
        assert_eq!(body.bars[0].close,102.0);
        assert_eq!(body.account,"A");
        assert!(!body.history_complete && !body.trading_enabled);
        assert!(response_for_token(&cfg,&ticket,now+31_000).is_err());
        let other=signer.issue(&att,&plan.pe_key,now,30_000).unwrap();
        assert!(response_for_token(&cfg,&other,now+300).unwrap().bars.is_empty());
        let wrong=signer.issue(&EntitlementAttestation{
            account:"B".into(),..att.clone()
        },&plan.ce_key,now,30_000).unwrap();
        assert!(response_for_token(&cfg,&wrong,now+300).is_err());
        let mut rights:serde_json::Value=serde_json::from_slice(
            &fs::read(&plan.private_rights_file).unwrap()).unwrap();
        rights["can_display_to_this_user"]=serde_json::json!(false);
        fs::write(&plan.private_rights_file,rights.to_string()).unwrap();
        assert!(response_for_token(&cfg,&ticket,now+300).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn invalid_bearer_is_never_used_for_public_history(){
        let mut headers=HeaderMap::new();
        assert!(token_from_headers(&headers).is_err());
        headers.insert(header::AUTHORIZATION,"Basic no".parse().unwrap());
        assert!(token_from_headers(&headers).is_err());
        headers.insert(header::AUTHORIZATION,"Bearer token".parse().unwrap());
        assert_eq!(token_from_headers(&headers).unwrap(),"token");
    }
}
