//! Isolated, operator-started index source. No browser or demo auto-start.
use qsyn_stream::upstox_index_worker::IndexWorkerSettings;
use std::path::Path;

pub(crate) fn main() {
    let args = qsyn_stream::runtime_cli::operator_args("qsyn-upstox-index-worker");
    let result = match args.as_slice() {
        [operation, symbol, day, runtime] if operation == "personal-history" => {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build();
            match rt {
                Ok(rt) => match rt.block_on(qsyn_stream::personal_index::history(
                    symbol,
                    day,
                    Path::new(runtime),
                )) {
                    Ok(json) => {
                        println!("{json}");
                        Ok(())
                    }
                    Err(_) => Err(std::io::Error::other("personal_index_history_unavailable")),
                },
                Err(_) => Err(std::io::Error::other("runtime_unavailable")),
            }
        }
        [operation, instrument, day, runtime] if operation == "instrument-history" => {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build();
            match rt {
                Ok(rt) => match rt.block_on(qsyn_stream::upstox_instrument_history::history(
                    instrument,
                    day,
                    Path::new(runtime),
                )) {
                    Ok(json) => {
                        println!("{json}");
                        Ok(())
                    }
                    Err(_) => Err(std::io::Error::other(
                        "private_instrument_history_unavailable",
                    )),
                },
                Err(_) => Err(std::io::Error::other("runtime_unavailable")),
            }
        }
        [operation, path] if operation == "check" || operation == "run" => {
            let settings = IndexWorkerSettings::from_private_file(Path::new(path));
            match (operation.as_str(), settings) {
                ("check", Ok(_)) => {
                    println!(
                        "{}",
                        serde_json::json!({
                            "schema":"QSYN-UPSTOX-INDEX-WORKER-READINESS/1",
                            "operator_configuration_accepted":true,
                            "provider_session_currently_verified":false,
                            "live_index_stream_activated":false,
                            "exchange_display_rights_independently_audited":false,
                            "trading_enabled":false
                        })
                    );
                    Ok(())
                }
                ("run", Ok(settings))
                    if std::env::var("QSYN_UPSTOX_INDEX_WORKER_ENABLE").as_deref() == Ok("1")
                        && std::env::var("QSYN_TRADING_ENABLED").as_deref() != Ok("1")
                        && std::env::var("QSYN_ENABLE_LIVE_TRADING").as_deref() != Ok("1") =>
                {
                    tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                        .map_err(|_| std::io::Error::other("runtime_unavailable"))
                        .and_then(|rt| {
                            rt.block_on(qsyn_stream::upstox_index_worker::run(&settings))
                        })
                }
                _ => Err(std::io::Error::other("operator_index_worker_denied")),
            }
        }
        _ => Err(std::io::Error::other("index_worker_invalid_command")),
    };
    if result.is_err() {
        eprintln!(
            "QSYN native Upstox index worker is not authorized or its private readiness failed."
        );
        std::process::exit(2);
    }
}
