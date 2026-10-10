//! Optional operator-run read-only OpenAlgo LTP subscriber.
//! This is a *private diagnostic*, not public live charting or trade routing.
use qsyn_stream::market_pipeline::Scope;
use qsyn_stream::openalgo_stream::{probe, Subscription};
use serde_json::{json, Value};
use std::fs;
use std::io;
use std::path::Path;

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
        if cmd != "inspect" || ![tenant, owner, account].iter().all(|x| safe_id(x)) {
            return Err(rejected());
        }
        let (port, broker, api_key) = config(tenant, owner, account)?;
        let subs = subscriptions(instruments)?;
        let scope = Scope {
            tenant_id: tenant.clone(), account_id: account.clone(),
            source_id: "openalgo_private".to_owned(),
            entitlement_id: "not_attested".to_owned(),
        };
        let result = probe(port, &api_key, &broker, &scope, &subs, 100, 8).await?;
        Ok(json!(result))
    }.await;
    match result {
        Ok(data) => println!("{data}"),
        Err(_) => {
            eprintln!("Private QSYN feed diagnostic denied or failed; no live feed activated.");
            std::process::exit(2);
        }
    }
}
