//! Standalone owner-only worker. NEVER started from QSYN demo main().
//! Intended for an independently approved, supervised OS service account.
use qsyn_stream::upstox_worker::WorkerSettings;
use std::path::Path;

fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let result = match args.as_slice() {
        [op, path] if op == "check" || op == "run" => {
            let settings = WorkerSettings::from_private_file(Path::new(path));
            match (op.as_str(), settings) {
                ("check", Ok(_)) => {
                    println!("{}", serde_json::json!({"status":"ready_for_operator_review","connection_tested":false,"market_feed":"not_verified","trading_enabled":false}));
                    Ok(())
                }
                ("run", Ok(settings)) if std::env::var("QSYN_UPSTOX_WORKER_ENABLE").as_deref() == Ok("1")
                    && std::env::var("QSYN_TRADING_ENABLED").as_deref() != Ok("1") => {
                    let runtime = tokio::runtime::Builder::new_current_thread()
                        .enable_all().build();
                    match runtime {
                        Ok(rt) => rt.block_on(qsyn_stream::upstox_worker::run(&settings)),
                        Err(_) => Err(std::io::Error::other("worker_runtime_unavailable")),
                    }
                }
                _ => Err(std::io::Error::other("private_worker_not_approved")),
            }
        }
        _ => Err(std::io::Error::other("invalid_worker_cli_arguments")),
    };
    if result.is_err() {
        // Intentionally no paths, tokens, credentials or raw upstream URLs.
        eprintln!("QSYN private Upstox worker stopped: operator authorization or readiness gate failed.");
        std::process::exit(2);
    }
}
