//! Operator-only one-day index historical import. No public API, no trading.
use qsyn_stream::durable_market_wal::root_check;
use qsyn_stream::private_chart_ws::epoch_ms;
use qsyn_stream::upstox_index_history::{approved_key, backfill_index_day, day_for_operator};
use qsyn_stream::upstox_index_worker::IndexWorkerSettings;
use serde_json::json;
use std::{env, io, path::Path};

fn denied() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "index_history_operator_denied",
    )
}
#[tokio::main]
async fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let result = match args.as_slice() {
        [mode, plan_file, archive_root, key, date] if mode == "check" || mode == "backfill" => {
            let authorized = (|| -> io::Result<IndexWorkerSettings> {
                let settings = IndexWorkerSettings::from_private_file(Path::new(plan_file))?;
                settings.validate(epoch_ms()?)?;
                approved_key(&settings, key)?;
                day_for_operator(date, epoch_ms()?)?;
                root_check(Path::new(archive_root))?;
                Ok(settings)
            })();
            match (mode.as_str(), authorized) {
                ("check", Ok(_)) => {
                    println!(
                        "{}",
                        json!({
                            "schema":"QSYN-UPSTOX-INDEX-HISTORY-PREFLIGHT/1",
                            "operator_config":"validated","provider_called":false,
                            "history_imported":false,"trading_enabled":false
                        })
                    );
                    Ok(())
                }
                ("backfill", Ok(settings))
                    if env::var("QSYN_UPSTOX_INDEX_HISTORY_ENABLE").as_deref() == Ok("1")
                        && env::var("QSYN_TRADING_ENABLED").as_deref() != Ok("1")
                        && env::var("QSYN_ENABLE_LIVE_TRADING").as_deref() != Ok("1") =>
                {
                    backfill_index_day(&settings, Path::new(archive_root), key, date)
                        .await
                        .map(|result| println!("{}", json!(result)))
                }
                _ => Err(denied()),
            }
        }
        _ => Err(denied()),
    };
    if result.is_err() {
        eprintln!("QSYN private index history denied: verify operator session, BOD mapping, rights and private archive.");
        std::process::exit(2);
    }
}
