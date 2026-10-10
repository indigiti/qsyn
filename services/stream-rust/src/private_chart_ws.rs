//! Private account-scoped chart WSS gateway and source Unix datagram receiver.
//! Bind only to 127.0.0.1. An operator-controlled HTTPS reverse proxy must
//! independently authenticate users before any browser-facing deployment.
use crate::chart_entitlement::{ChartGrant, ChartSigner, ChartViewer, EntitlementAttestation};
use crate::openalgo_stream::CandidateQuote;
use crate::private_chart_hub::PrivateChartHub;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
use std::fs;
use std::io;
use std::path::Path;
use std::sync::Arc;
use tokio::net::{TcpListener, TcpStream, UnixDatagram};
use tokio::time::{interval, timeout, Duration};
use tokio_tungstenite::{accept_async, tungstenite::Message};

#[cfg(unix)]use std::os::unix::fs::{MetadataExt, PermissionsExt};

fn denied() -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, "private_chart_access_denied")
}
pub fn private_bytes(path: &Path, max: u64) -> io::Result<Vec<u8>> {
    if !path.is_absolute() || path.canonicalize()? != path
        || path.components().any(|c| matches!(c, std::path::Component::Normal(s)
            if ["public","public_html","webroot","www"].contains(&s.to_str().unwrap_or(""))))
    { return Err(denied()); }
    let meta = fs::symlink_metadata(path)?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > max { return Err(denied()); }
    #[cfg(unix)]
    if meta.permissions().mode() & 0o077 != 0 || meta.uid() != unsafe { libc::geteuid() } {
        return Err(denied());
    }
    fs::read(path)
}
pub fn load_secret(path: &Path) -> io::Result<[u8;32]> {
    let bytes=private_bytes(path, 64)?;
    bytes.try_into().map_err(|_| denied())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Rights {
    schema: String,
    tenant: String,
    account: String,
    owner: String,
    broker: String,
    instruments: Vec<String>,
    license_id: String,
    can_display_to_this_user: bool,
    broker_session_verified: bool,
    valid_until_ms: u64,
}
pub fn load_rights(path:&Path)->io::Result<EntitlementAttestation>{
    let source:Rights=serde_json::from_slice(&private_bytes(path,8192)?)
        .map_err(|_|denied())?;
    if source.schema!="QSYN-PRIVATE-CHART-ENTITLEMENT/1"
        || source.instruments.is_empty() || source.instruments.len()>8 {
        return Err(denied());
    }
    Ok(EntitlementAttestation {tenant:source.tenant,account:source.account,
        owner:source.owner,broker:source.broker,instruments:source.instruments,
        license_id:source.license_id,can_display_to_this_user:source.can_display_to_this_user,
        broker_session_verified:source.broker_session_verified,
        valid_until_ms:source.valid_until_ms})
}
pub fn epoch_ms()->io::Result<u64>{
    Ok(std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).map_err(|_|denied())?.as_millis() as u64)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Authenticate { action:String, token:String }
fn verified_grant(signer:&ChartSigner,token:&str,
    now:u64,rights:&EntitlementAttestation)->io::Result<ChartGrant>{
    let (message,_) = token.split_once('.').ok_or_else(denied)?;
    let payload = URL_SAFE_NO_PAD.decode(message).map_err(|_|denied())?;
    if payload.len()>1024 {return Err(denied());}
    let claim:ChartGrant=serde_json::from_slice(&payload).map_err(|_|denied())?;
    let viewer=ChartViewer {tenant:&claim.tenant,account:&claim.account,
        owner:&claim.owner,instrument:&claim.instrument};
    signer.verify(token,now,&viewer,rights)
}
async fn websocket_client(
    stream:TcpStream,signer:Arc<ChartSigner>,hub:Arc<PrivateChartHub>,
    rights_path:Arc<std::path::PathBuf>,
)->io::Result<()>{
    let mut ws=timeout(Duration::from_secs(5),accept_async(stream))
        .await.map_err(|_|denied())?
        .map_err(|_|denied())?;
    let received=timeout(Duration::from_secs(5),ws.next())
        .await.map_err(|_|denied())?.ok_or_else(denied)?
        .map_err(|_|denied())?;
    let Message::Text(raw)=received else{return Err(denied())};
    if raw.len()>2048 {return Err(denied());}
    let auth:Authenticate=serde_json::from_str(&raw).map_err(|_|denied())?;
    if auth.action!="authenticate" {return Err(denied());}
    let rights=load_rights(&rights_path)?;
    let claim=verified_grant(&signer,&auth.token,epoch_ms()?,&rights)?;
    let viewer=ChartViewer {tenant:&claim.tenant,account:&claim.account,
        owner:&claim.owner,instrument:&claim.instrument};
    let mut receiver=hub.subscribe(&signer,&auth.token,epoch_ms()?,&viewer,&rights)?;
    ws.send(Message::Text(json!({
        "type":"authentication_success","source":"licensed_private_chart",
        "expires_ms":claim.expires_ms
    }).to_string().into())).await.map_err(|_|denied())?;
    let mut poll=interval(Duration::from_secs(1));
    loop {
        tokio::select!{
            _=poll.tick()=>{
                let fresh=load_rights(&rights_path)?;
                verified_grant(&signer,&auth.token,epoch_ms()?,&fresh)?;
            }
            incoming=ws.next()=>{
                match incoming {
                    Some(Ok(Message::Close(_)))|None=>break,
                    Some(Ok(Message::Ping(data)))=>{
                        ws.send(Message::Pong(data)).await.map_err(|_|denied())?;
                    }
                    Some(Ok(_))=>return Err(denied()),
                    Some(Err(_))=>break,
                }
            }
            event=receiver.recv()=>{
                let event=event.map_err(|_|denied())?;
                let fresh=load_rights(&rights_path)?;
                verified_grant(&signer,&auth.token,epoch_ms()?,&fresh)?;
                if event.tenant!=claim.tenant||event.account!=claim.account
                    || event.instrument!=claim.instrument {
                    return Err(denied());
                }
                ws.send(Message::Text(serde_json::to_string(&event)?.into()))
                    .await.map_err(|_|denied())?;
            }
        }
    }
    Ok(())
}

/// Operates on one dedicated, private owner-only Unix socket directory.
pub async fn serve(
    port:u16, unix_path:&Path,
    rights_path:&Path,secret_path:&Path,
)->io::Result<()>{
    if !(1025..=65535).contains(&port) || unix_path.exists() {
        return Err(denied());
    }
    let parent=unix_path.parent().ok_or_else(denied)?;
    crate::durable_market_wal::root_check(parent)?;
    let signer=Arc::new(ChartSigner::new(load_secret(secret_path)?));
    let rights=Arc::new(rights_path.to_path_buf());
    let current=load_rights(&rights)?;
    if !current.broker_session_verified || !current.can_display_to_this_user
        || current.valid_until_ms<=epoch_ms()? {return Err(denied());}
    let unix=UnixDatagram::bind(unix_path)?;
    #[cfg(unix)]
    fs::set_permissions(unix_path,fs::Permissions::from_mode(0o600))?;
    let listener=TcpListener::bind(("127.0.0.1",port)).await?;
    let hub=Arc::new(PrivateChartHub::new());
    let mut packet=[0u8;4096];
    loop{
        tokio::select!{
            next=listener.accept()=>{
                let (stream,_)=next?;
                let signer=signer.clone();let hub=hub.clone();let rights=rights.clone();
                tokio::spawn(async move{
                    let _=websocket_client(stream,signer,hub,rights).await;
                });
            }
            incoming=unix.recv(&mut packet)=>{
                let len=incoming?;
                if len==0||len>=packet.len() {continue;}
                let Ok(quote)=serde_json::from_slice::<CandidateQuote>(&packet[..len]) else {
                    continue;
                };
                let Ok(current)=load_rights(&rights) else {continue;};
                let Ok(now)=epoch_ms() else {continue;};
                let _=hub.publish(&quote,now,&current);
            }
        }
    }
}
#[cfg(test)]mod tests{
    use super::*;
    #[test]fn signed_ticket_matches_latest_rights_not_untrusted_claim(){
        let signer=ChartSigner::new([42;32]);
        let mut rights=EntitlementAttestation{tenant:"T".into(),account:"A".into(),
            owner:"U".into(),broker:"upstox".into(),instruments:vec!["NFO|CE".into()],
            license_id:"L1".into(),can_display_to_this_user:true,
            broker_session_verified:true,valid_until_ms:900000};
        let ticket=signer.issue(&rights,"NFO|CE",100000,60000).unwrap();
        assert!(verified_grant(&signer,&ticket,101000,&rights).is_ok());
        rights.can_display_to_this_user=false;
        assert!(verified_grant(&signer,&ticket,101000,&rights).is_err());
        rights.can_display_to_this_user=true;rights.license_id="L2".into();
        assert!(verified_grant(&signer,&ticket,101000,&rights).is_err());
    }
}
