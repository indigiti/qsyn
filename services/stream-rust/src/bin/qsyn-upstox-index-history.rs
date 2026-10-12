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
/// Sequential, fail-closed import using only the dated private plan allowlist.
/// Never infer exchange data rights from the existence of an Analytics Token.
async fn batch(mode: &str, plan_file: &str, archive_root: &str, date: &str) -> io::Result<()> {
    let settings = IndexWorkerSettings::from_private_file(Path::new(plan_file))?;
    settings.validate(epoch_ms()?)?;
    day_for_operator(date, epoch_ms()?)?;
    root_check(Path::new(archive_root))?;
    if settings.instruments.is_empty() || settings.instruments.len() > 8 {
        return Err(denied());
    }
    for instrument in &settings.instruments {
        approved_key(&settings, &instrument.instrument_key)?;
    }
    if mode == "check-all" {
        println!(
            "{}",
            json!({
                "schema":"QSYN-UPSTOX-INDEX-HISTORY-BATCH-PREFLIGHT/1",
                "approved_instrument_count":settings.instruments.len(),
                "operator_config":"validated",
                "provider_called":false,
                "history_imported":false,
                "trading_enabled":false
            })
        );
        return Ok(());
    }
    if env::var("QSYN_UPSTOX_INDEX_HISTORY_ENABLE").as_deref() != Ok("1")
        || env::var("QSYN_TRADING_ENABLED").as_deref() == Ok("1")
        || env::var("QSYN_ENABLE_LIVE_TRADING").as_deref() == Ok("1")
    {
        return Err(denied());
    }
    let mut results = Vec::with_capacity(settings.instruments.len());
    let mut failed = false;
    for instrument in &settings.instruments {
        match backfill_index_day(
            &settings,
            Path::new(archive_root),
            &instrument.instrument_key,
            date,
        )
        .await
        {
            Ok(result) => results.push(json!(result)),
            Err(_) => {
                failed = true;
                results.push(json!({
                    "instrument":instrument.instrument_key,
                    "status":"private_index_history_denied"
                }));
                break;
            }
        }
    }
    println!(
        "{}",
        json!({
            "schema":"QSYN-UPSTOX-PRIVATE-INDEX-BATCH-IMPORT/1",
            "status":if failed {"incomplete"} else {"completed"},
            "date":date,
            "approved_instrument_count":settings.instruments.len(),
            "processed_instrument_count":results.len(),
            "results":results,
            "public_redistribution_allowed":false,
            "trading_enabled":false
        })
    );
    if failed {
        Err(denied())
    } else {
        Ok(())
    }
}

#[tokio::main]
pub(crate) async fn main() {
    let args: Vec<String> = qsyn_stream::runtime_cli::operator_args("qsyn-upstox-index-history");
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
        [mode, plan_file, archive_root, date] if mode == "check-all" || mode == "backfill-all" => {
            batch(mode, plan_file, archive_root, date).await
        }
        _ => Err(denied()),
    };
    if result.is_err() {
        eprintln!("QSYN private index history denied: verify operator session, BOD mapping, rights and private archive.");
        std::process::exit(2);
    }
}
