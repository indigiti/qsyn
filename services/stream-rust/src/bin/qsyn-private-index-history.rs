//! Operator-only private index history gateway; loopback ingress only.
use qsyn_stream::private_chart_ws::epoch_ms;
use qsyn_stream::private_index_history_http::{serve, IndexHistoryConfig};
use serde_json::json;
use std::{env, io, path::PathBuf};
fn denied() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "private_index_history_not_enabled",
    )
}
#[tokio::main]
async fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let result = match args.as_slice() {
        [cmd, plan, signing_key, archive, port] if cmd == "check" || cmd == "serve" => {
            let cfg = IndexHistoryConfig {
                settings_path: PathBuf::from(plan),
                signing_key_path: PathBuf::from(signing_key),
                archive_root: PathBuf::from(archive),
            };
            match cfg.verify(epoch_ms().unwrap_or(0)) {
                Ok(_) if cmd == "check" => {
                    println!(
                        "{}",
                        json!({
                            "status":"private_index_history_preflight_ok",
                            "listening":false, "broker_verified_live":false,
                            "trading_enabled":false
                        })
                    );
                    Ok(())
                }
                Ok(_)
                    if cmd == "serve"
                        && env::var("QSYN_PRIVATE_INDEX_HISTORY_HTTP_ENABLED").as_deref()
                            == Ok("1")
                        && env::var("QSYN_TRADING_ENABLED").as_deref() != Ok("1")
                        && env::var("QSYN_ENABLE_LIVE_TRADING").as_deref() != Ok("1") =>
                {
                    match port.parse::<u16>() {
                        Ok(port) => serve(port, cfg).await,
                        Err(_) => Err(denied()),
                    }
                }
                _ => Err(denied()),
            }
        }
        _ => Err(denied()),
    };
    if result.is_err() {
        eprintln!("QSYN private index-history reader denied; verify scoped account rights and loopback ingress.");
        std::process::exit(2);
    }
}
