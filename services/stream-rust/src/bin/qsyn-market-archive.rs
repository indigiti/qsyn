//! Offline owner-only WAL audit / explicit torn-tail repair.
//! Deliberately no network, no broker API, no order API and no UI.
use qsyn_stream::durable_market_wal::{audit, repair_incomplete_tail};
use serde_json::json;
use std::path::Path;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.as_slice() {
        [operation, root] if operation == "audit" => {
            audit(Path::new(root)).map(|summary| json!({
                "ok": true, "mode": "offline_only",
                "schema": "QSYN-MARKET-ARCHIVE-DOCTOR/1",
                "records": summary.records,
                "durable_bytes": summary.durable_bytes,
                "last_sequence": summary.last_sequence,
                "trading_enabled": false,
                "connected_to_broker": false,
            }))
        }
        [operation, root] if operation == "repair-torn-tail" => {
            if std::env::var("QSYN_ARCHIVE_REPAIR_APPROVED").as_deref() != Ok("1") {
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied, "repair_not_approved",
                ))
            } else {
                repair_incomplete_tail(Path::new(root)).map(|changed| json!({
                    "ok": true, "mode": "offline_only",
                    "schema": "QSYN-MARKET-ARCHIVE-DOCTOR/1",
                    "tail_repaired": changed.is_some(),
                    "durable_prefix_bytes": changed,
                    "trading_enabled": false,
                    "connected_to_broker": false,
                }))
            }
        }
        _ => Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput, "usage_audit_or_explicit_repair",
        )),
    };
    match result {
        Ok(value) => println!("{value}"),
        Err(_) => {
            // Avoid printing any user-supplied path or error details to logs.
            eprintln!("QSYN offline archive audit failed or requires operator approval");
            std::process::exit(2);
        }
    }
}
