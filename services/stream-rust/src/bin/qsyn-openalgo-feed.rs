//! Optional operator-run read-only OpenAlgo LTP subscriber.
//! This is a *private diagnostic*, not public live charting or trade routing.
use qsyn_stream::market_pipeline::Scope;
use qsyn_stream::openalgo_stream::{probe, Subscription};
use qsyn_stream::private_live_pipeline::{observe, observe_with_sink, PrivateFeedPlan};
use qsyn_stream::authorized_ingest::{PrivateIngestApproval,PrivatePersistentIngest};
use serde_json::{json, Value};
use serde::Deserialize;
use std::time::{SystemTime, UNIX_EPOCH};
use std::fs;
use std::io;
use std::path::Path;
#[cfg(unix)] use std::os::unix::fs::FileTypeExt;
#[cfg(unix)] use std::os::unix::net::UnixDatagram;

#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, PermissionsExt};

fn rejected() -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, "private_gateway_not_authorized")
}
fn safe_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 80
        && value.bytes().all(|b| b.is_ascii_alphanumeric()
            || matches!(b, b'.' | b'_' | b'-'))
}
fn private_file(path: &str) -> io::Result<Vec<u8>> {
    let p = Path::new(path);
    if !p.is_absolute() || p.canonicalize()? != p
        || p.components().any(|x| matches!(x, std::path::Component::Normal(part)
            if ["public_html","public","webroot","www"].contains(&part.to_str().unwrap_or(""))))
    {
        return Err(rejected());
    }
    let meta = fs::symlink_metadata(p)?;
    if !meta.is_file() || meta.file_type().is_symlink()
        || meta.len() > 16384 {
        return Err(rejected());
    }
    #[cfg(unix)]
    if (meta.permissions().mode() & 0o077) != 0
        || meta.uid() != unsafe { libc::geteuid() }
    {
        return Err(rejected());
    }
    fs::read(p)
}

fn config(tenant: &str, owner: &str, account: &str) -> io::Result<(u16, String, String)> {
    let path = std::env::var("QSYN_OPENALGO_REGISTRY_FILE").map_err(|_| rejected())?;
    let bytes = private_file(&path)?;
    let data: Value = serde_json::from_slice(&bytes).map_err(|_| rejected())?;
    if data["schema"] != "QSYN-PRIVATE-OPENALGO-REGISTRY/1" {
        return Err(rejected());
    }
    let accounts = data["accounts"].as_array().ok_or_else(rejected)?;
    if accounts.is_empty() || accounts.len() > 16 { return Err(rejected()); }
    let mut matched = None;
    let mut used_ports = std::collections::HashSet::new();
    let mut used_keys = std::collections::HashSet::new();
    for item in accounts {
        let port = item["rest_port"].as_u64().ok_or_else(rejected)?;
        let ws_port = item["ws_port"].as_u64().ok_or_else(rejected)?;
        let key_path = item["openalgo_apikey_file"].as_str().ok_or_else(rejected)?;
        let broker = item["broker"].as_str().ok_or_else(rejected)?;
        for value in ["account_id", "tenant_id", "owner_user_id"] {
            if !item[value].as_str().is_some_and(safe_id) { return Err(rejected()); }
        }
        if !(1025..=65535).contains(&port) || !(1025..=65535).contains(&ws_port)
            || !used_ports.insert(port) || !used_ports.insert(ws_port)
            || !used_keys.insert(key_path) || !safe_id(broker)
        {
            return Err(rejected());
        }
        if item["account_id"] == account && item["tenant_id"] == tenant
            && item["owner_user_id"] == owner {
            let key = private_file(key_path)?;
            let secret = String::from_utf8(key).map_err(|_| rejected())?;
            let secret = secret.trim().to_owned();
            if secret.len() < 16 || secret.len() > 256
                || !secret.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            {
                return Err(rejected());
            }
            matched = Some((ws_port as u16, broker.to_owned(), secret));
        }
    }
    matched.ok_or_else(rejected)
}

fn subscriptions(csv: &str) -> io::Result<Vec<Subscription>> {
    let chunks: Vec<&str> = csv.split(',').collect();
    if chunks.is_empty() || chunks.len() > 8 { return Err(rejected()); }
    chunks.into_iter().map(|item| {
        let (exchange, symbol) = item.split_once(':').ok_or_else(rejected)?;
        let entry = Subscription { exchange: exchange.to_owned(), symbol: symbol.to_owned() };
        if !entry.valid() { return Err(rejected()); }
        Ok(entry)
    }).collect()
}


#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FeedStorageApproval {
    schema:String, tenant:String, owner:String, account:String, broker:String,
    license_id:String, instruments:Vec<String>,
    persistence_approved:bool, broker_session_verified:bool,
    valid_until_ms:u64, archive_root:String,
}
fn now_ms()->io::Result<u64>{
    Ok(SystemTime::now().duration_since(UNIX_EPOCH)
        .map_err(|_|rejected())?.as_millis() as u64)
}
fn read_storage_approval(
    tenant:&str,owner:&str,account:&str,broker:&str,
    subscriptions:&[Subscription],
)->io::Result<FeedStorageApproval>{
    let path=std::env::var("QSYN_PRIVATE_FEED_APPROVAL_FILE").map_err(|_|rejected())?;
    let config:FeedStorageApproval=serde_json::from_slice(&private_file(&path)?)
        .map_err(|_|rejected())?;
    if config.schema!="QSYN-PRIVATE-PERSISTENCE-ATTESTATION/1"
        || !config.persistence_approved || !config.broker_session_verified
        || config.tenant != tenant || config.owner != owner
        || config.account != account || config.broker != broker
        || !safe_id(&config.license_id) || config.valid_until_ms<=now_ms()?
        || !std::path::Path::new(&config.archive_root).is_absolute()
        || subscriptions.iter().any(|sub| {
            !config.instruments.contains(&format!("{}|{}",sub.exchange,sub.symbol))
        }) {
        return Err(rejected());
    }
    Ok(config)
}


#[cfg(unix)]
fn chart_ipc() -> io::Result<Option<(UnixDatagram,std::path::PathBuf)>> {
    if std::env::var("QSYN_PRIVATE_CHART_IPC_ENABLED").as_deref()!=Ok("1") {
        return Ok(None);
    }
    let path=std::env::var("QSYN_PRIVATE_CHART_IPC_SOCKET").map_err(|_|rejected())?;
    let path=std::path::PathBuf::from(path);
    let parent=path.parent().ok_or_else(rejected)?;
    qsyn_stream::durable_market_wal::root_check(parent)?;
    let meta=fs::symlink_metadata(&path)?;
    if !meta.file_type().is_socket() || meta.file_type().is_symlink()
        || meta.permissions().mode()&0o077!=0
        || meta.uid()!=unsafe{libc::geteuid()} {
        return Err(rejected());
    }
    Ok(Some((UnixDatagram::unbound()?,path)))
}

#[tokio::main]
async fn main() {
    let result = async {
        if std::env::var("QSYN_PRIVATE_BROKER_GATEWAY").as_deref() != Ok("1")
            || std::env::var("QSYN_PRIVATE_FEED_PROBE_ENABLED").as_deref() != Ok("1")
            || std::env::var("QSYN_TRADING_ENABLED").as_deref() == Ok("1")
            || std::env::var("QSYN_ENABLE_LIVE_TRADING").as_deref() == Ok("1")
        {
            return Err(rejected());
        }
        let args: Vec<String> = std::env::args().skip(1).collect();
        let [cmd, tenant, owner, account, instruments] = args.as_slice() else {
            return Err(rejected());
        };
        if !["inspect", "observe", "collect"].contains(&cmd.as_str()) || ![tenant, owner, account].iter().all(|x| safe_id(x)) {
            return Err(rejected());
        }
        let (port, broker, api_key) = config(tenant, owner, account)?;
        let subs = subscriptions(instruments)?;
        let scope = Scope {
            tenant_id: tenant.clone(), account_id: account.clone(),
            source_id: "openalgo_private".to_owned(),
            entitlement_id: "not_attested".to_owned(),
        };
        if cmd == "inspect" {
            let result = probe(port, &api_key, &broker, &scope, &subs, 100, 8).await?;
            return Ok(json!(result));
        }
        // Observe only from an explicitly opted-in private operator shell.
        // No public WS, broker order route or licensed persistence is activated.
        if std::env::var("QSYN_PRIVATE_FEED_RUNTIME_ENABLED").as_deref() != Ok("1") {
            return Err(rejected());
        }
        let legs = subs.iter().map(|s| qsyn_stream::market_pipeline::WeightedLeg {
            instrument_id: format!("{}|{}", s.exchange, s.symbol),
            quantity: 1.0,
        }).collect();
        let mut plan = PrivateFeedPlan {
            ws_port: port, broker, scope, subscriptions: subs, legs,
            max_skew_ms: 500, observe_seconds: 120, max_reconnects: 4,
        };
        if cmd == "observe" {
            let report = observe(&plan, &api_key).await?;
            return Ok(json!(report));
        }
        if std::env::var("QSYN_PRIVATE_FEED_PERSIST_ENABLED").as_deref()!=Ok("1"){
            return Err(rejected());
        }
        let approved=read_storage_approval(tenant,owner,account,&plan.broker,&plan.subscriptions)?;
        plan.scope.entitlement_id=approved.license_id.clone();
        let grant=PrivateIngestApproval{
            scope:plan.scope.clone(),
            approved_instruments:approved.instruments.clone(),
            licensed_persistence:approved.persistence_approved,
            broker_session_verified:approved.broker_session_verified,
            expires_ms:approved.valid_until_ms,
            max_delay_ms:5000,
        };
        let mut collector=PrivatePersistentIngest::open(
            Path::new(&approved.archive_root),grant,now_ms()?)?;
        #[cfg(unix)]
        let ipc=chart_ipc()?;
        let mut last_license_check=0u64;
        let mut observations=0u64;
        let mut connections=0u64;
        // The operator's process supervisor restarts unexpected failures.
        // This long-running collector stops at attestation expiry, and never
        // silently renews broker exchange/data use permissions.
        loop {
            if now_ms()? >= approved.valid_until_ms {break;}
            let run=observe_with_sink(&plan,&api_key,|candidate|{
                let now=now_ms()?;
                // Recheck externally approved data rights frequently, not
                // just at worker start. Revocation must stop this collector.
                if now.saturating_sub(last_license_check)>1_000 {
                    let current=read_storage_approval(
                        tenant,owner,account,&plan.broker,&plan.subscriptions)?;
                    if current.license_id!=approved.license_id
                        || current.archive_root!=approved.archive_root
                        || current.valid_until_ms!=approved.valid_until_ms
                        || current.instruments!=approved.instruments {
                        return Err(rejected());
                    }
                    last_license_check=now;
                }
                let was=collector.stored;
                collector.ingest(candidate,now)?;
                if collector.stored>was {
                    #[cfg(unix)]
                    if let Some((socket,path))=&ipc {
                        let payload=serde_json::to_vec(candidate)?;
                        if payload.len()>4095 {return Err(rejected());}
                        socket.send_to(&payload,path)?;
                    }
                }
                Ok(())
            }).await?;
            observations+=run.synchronized_updates;
            connections+=u64::from(run.authenticated_sessions);
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        }
        Ok(json!({
            "schema":"QSYN-PRIVATE-PERSISTENT-COLLECTOR/1",
            "records_synced":collector.stored,
            "synchronized_updates":observations,
            "authenticated_sessions":connections,
            "private_only":true,"public_live_charts":false,
            "broker_order_execution":false
        }))
    }.await;
    match result {
        Ok(data) => println!("{data}"),
        Err(_) => {
            eprintln!("Private QSYN feed diagnostic denied or failed; no live feed activated.");
            std::process::exit(2);
        }
    }
}
