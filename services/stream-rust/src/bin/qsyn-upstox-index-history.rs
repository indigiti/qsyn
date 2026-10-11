//! Private operator-only NSE/BSE index history. No browser-origin commands.
//! Never accepts URLs, access tokens or arbitrary instrument keys as arguments.
use qsyn_stream::private_chart_ws::epoch_ms;
use qsyn_stream::upstox_index_history::{backfill_day, preflight};
use qsyn_stream::upstox_index_worker::IndexWorkerSettings;
use serde_json::json;
use std::{env, io, path::Path};

fn denied() -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, "private_index_history_disabled")
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let outcome = match args.as_slice() {
        [mode, settings_file, archive_dir, date, symbol]
            if mode == "check" || mode == "backfill" =>
        {
            let settings = IndexWorkerSettings::from_private_file(Path::new(settings_file));
            match (mode.as_str(), settings) {
                ("check", Ok(settings)) => {
                    preflight(&settings, Path::new(archive_dir), date, symbol, epoch_ms().unwrap_or(0))
                        .map(|_| {
                            println!(
                                "{}",
                                json!({
                                    "schema":"QSYN-UPSTOX-V3-INDEX-HISTORY-PREFLIGHT/1",
                                    "status":"private_operator_preflight_ok",
                                    "provider_called":false,
                                    "history_imported":false,
                                    "trading_enabled":false,
                                    "public_redistribution_allowed":false
                                })
                            );
                        })
                }
                ("backfill", Ok(settings))
                    if env::var("QSYN_UPSTOX_INDEX_HISTORY_ENABLE").as_deref() == Ok("1")
                        && env::var("QSYN_TRADING_ENABLED").as_deref() != Ok("1")
                        && env::var("QSYN_ENABLE_LIVE_TRADING").as_deref() != Ok("1") =>
                {
                    backfill_day(&settings, Path::new(archive_dir), date, symbol)
                        .await
                        .map(|out| println!("{}", json!(out)))
                }
                _ => Err(denied()),
            }
        }
        _ => Err(denied()),
    };
    if outcome.is_err() {
        // Only a constant error; provider payloads, account identifiers and
        // filesystem paths are deliberately omitted from ordinary logs.
        eprintln!("QSYN private index-history operation denied; check operator rights and current BOD.");
        std::process::exit(2);
    }
}
