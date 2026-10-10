//! Private, owner-only licensed V3 historical CE/PE archive command.
//! No public HTTP endpoint or credential-bearing arguments.
use qsyn_stream::private_chart_ws::epoch_ms;
use qsyn_stream::upstox_worker::WorkerSettings;
use qsyn_stream::durable_market_wal::root_check;
use qsyn_stream::upstox_history::backfill_day;
use serde_json::json;
use std::{env, io, path::Path};

fn denied() -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, "history_operator_approval_required")
}
#[tokio::main]
async fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let result = match args.as_slice() {
        [mode, settings_file, archive_dir, date] if mode == "check" || mode == "backfill" => {
            let approved = WorkerSettings::from_private_file(Path::new(settings_file))
                .and_then(|settings| {
                    root_check(Path::new(archive_dir))?;
                    settings.validate(epoch_ms()?)?;
                    Ok(settings)
                });
            match (mode.as_str(), approved) {
                ("check", Ok(_)) => {
                    println!("{}", json!({
                        "schema": "QSYN-UPSTOX-V3-HISTORY-PREFLIGHT/1",
                        "operator_config": "validated",
                        "provider_called": false,
                        "exchange_data_verified": false,
                        "execution_enabled": false
                    }));
                    Ok(())
                }
                ("backfill", Ok(settings))
                    if env::var("QSYN_UPSTOX_HISTORY_ENABLE").as_deref() == Ok("1")
                        && env::var("QSYN_TRADING_ENABLED").as_deref() != Ok("1")
                        && env::var("QSYN_ENABLE_LIVE_TRADING").as_deref() != Ok("1") =>
                {
                    backfill_day(&settings, Path::new(archive_dir), date)
                        .await.map(|out| {println!("{}", json!(out));})
                }
                _ => Err(denied()),
            }
        }
        _ => Err(denied()),
    };
    if result.is_err() {
        // Deliberately do not print paths, broker errors, exchange responses
        // or credentials in ordinary operator logs.
        eprintln!("QSYN private CE/PE archive denied. Verify approved account, rights, date and unmodified private files.");
        std::process::exit(2);
    }
}
