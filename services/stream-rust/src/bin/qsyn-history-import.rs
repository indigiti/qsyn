//! Offline private historical constituent OHLC import. No public chart API.
use qsyn_stream::history_backfill::{import, HistoricalImport};
use serde_json::json;
use std::{fs, io, path::Path, time::{SystemTime, UNIX_EPOCH}};
#[cfg(unix)] use std::os::unix::fs::{MetadataExt,PermissionsExt};
fn denied()->io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied,"private_history_import_denied")
}
fn private_read(path:&str)->io::Result<Vec<u8>>{
    let path=Path::new(path);
    if !path.is_absolute() || path.canonicalize()? != path
        || path.components().any(|x|matches!(x,std::path::Component::Normal(v)
            if ["public","public_html","webroot","www"].contains(&v.to_str().unwrap_or(""))))
    {return Err(denied());}
    let meta=fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink() || !meta.is_file() || meta.len()>5_000_000 {
        return Err(denied());
    }
    #[cfg(unix)]
    if meta.permissions().mode()&0o077!=0 || meta.uid()!=unsafe{libc::geteuid()} {
        return Err(denied());
    }
    fs::read(path)
}
fn run()->io::Result<()> {
    if std::env::var("QSYN_PRIVATE_HISTORY_IMPORT_ENABLED").as_deref()!=Ok("1")
        || std::env::var("QSYN_TRADING_ENABLED").as_deref()==Ok("1")
        || std::env::var("QSYN_ENABLE_LIVE_TRADING").as_deref()==Ok("1") {
        return Err(denied());
    }
    let args:Vec<String>=std::env::args().skip(1).collect();
    let [cmd,source,root]=args.as_slice() else{return Err(denied())};
    if cmd!="import" {return Err(denied());}
    let raw=private_read(source)?;
    let request:HistoricalImport=serde_json::from_slice(&raw)
        .map_err(|_|denied())?;
    let now=SystemTime::now().duration_since(UNIX_EPOCH)
        .map_err(|_|denied())?.as_millis() as u64;
    let count=import(Path::new(root),request,now)?;
    println!("{}",json!({
        "schema":"QSYN-PRIVATE-HISTORY-IMPORT-RESULT/1",
        "records_imported":count,
        "public_market_data_enabled":false,
        "broker_orders_enabled":false
    }));
    Ok(())
}
fn main(){
    if run().is_err() {
        eprintln!("QSYN private history import rejected; check operator approval, account data and private paths");
        std::process::exit(2);
    }
}
