#[path = "bin/qsyn-history-import.rs"]
mod history_import_entry;
#[path = "bin/qsyn-market-archive.rs"]
mod market_archive_entry;
#[path = "bin/qsyn-openalgo-feed.rs"]
mod openalgo_feed_entry;
#[path = "bin/qsyn-private-chart.rs"]
mod private_chart_entry;
#[path = "bin/qsyn-private-history.rs"]
mod private_history_entry;
#[path = "bin/qsyn-private-index-history.rs"]
mod private_index_history_entry;
#[path = "bin/qsyn-upstox-history.rs"]
mod upstox_history_entry;
#[path = "bin/qsyn-upstox-index-history.rs"]
mod upstox_index_history_entry;
#[path = "bin/qsyn-upstox-index-worker.rs"]
mod upstox_index_worker_entry;
#[path = "bin/qsyn-upstox-worker.rs"]
mod upstox_worker_entry;

mod binary_activation;
mod crypto_public;
mod process_control;

use axum::{
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    OnceLock,
};
use std::time::Instant;
use tokio::time::{interval, Duration};

// Shared simulated progression, not a per-WebSocket replay from quote #1.
// No broker-derived prices, subscriptions or trading side effects.
static DEMO_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static STARTED_AT: OnceLock<Instant> = OnceLock::new();

async fn health() -> Json<Value> {
    Json(json!({
        "status": "ok",
        "component": "qsyn-stream",
        "mode": "foundation",
        "upstox_connected": false,
        "trading_enabled": false,
        "demo_runtime_control": true,
        "demo_ws_enabled": process_control::demo_ws_enabled(),
        "runtime_version": env!("CARGO_PKG_VERSION"),
        "runtime_commit": option_env!("QSYN_SOURCE_SHA").unwrap_or("development"),
        "auto_activation": binary_activation::active(),
        "uptime_seconds": STARTED_AT.get_or_init(Instant::now).elapsed().as_secs()
    }))
}

/// Only the existing loopback Rust service handles the WSS upgrade.
/// A short-lived signed ticket is sent in the FIRST frame, not the URL.
async fn personal_index_ws(ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(personal_index_session)
}
async fn personal_index_session(mut socket: WebSocket) {
    let runtime = match std::env::var("QSYN_RUNTIME_DIR") {
        Ok(p) => p,
        Err(_) => {
            let _ = socket.close().await;
            return;
        }
    };
    let token = match qsyn_stream::personal_index::read_token(std::path::Path::new(&runtime)) {
        Ok(t) => t,
        Err(_) => {
            let _ = socket.close().await;
            return;
        }
    };
    let first = tokio::time::timeout(Duration::from_secs(5), socket.recv()).await;
    let Some(Ok(Message::Text(raw))) = first.ok().flatten() else {
        let _ = socket.close().await;
        return;
    };
    if raw.len() > 512 {
        let _ = socket.close().await;
        return;
    }
    let request: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => {
            let _ = socket.close().await;
            return;
        }
    };
    let ticket = match request
        .as_object()
        .filter(|o| o.len() == 1)
        .and_then(|o| o.get("ticket"))
        .and_then(|v| v.as_str())
    {
        Some(x) => x,
        None => {
            let _ = socket.close().await;
            return;
        }
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let symbol = match qsyn_stream::personal_index::verify_ticket(ticket, &token, now) {
        Ok(x) => x,
        Err(_) => {
            let _ = socket.close().await;
            return;
        }
    };
    let (sender, mut receiver) = tokio::sync::mpsc::channel::<serde_json::Value>(64);
    let worker = tokio::spawn(async move {
        qsyn_stream::personal_index::live(&symbol, &token, move |tick, bar| {
            let tx = sender.clone();
            async move {
                tx.send(serde_json::json!({
                    "schema":"QSYN-RUST-PERSONAL-INDEX-TICK/1",
                    "source":"upstox_v3_websocket","symbol":tick.symbol,
                    "time_ms":tick.time_ms,"price":tick.price,"bar":bar,
                    "trading_enabled":false
                }))
                .await
                .map_err(|_| std::io::Error::other("browser_disconnected"))
            }
        })
        .await
    });
    tokio::pin!(worker);
    loop {
        tokio::select! {
            packet=receiver.recv()=>{
                match packet{
                    Some(payload)=>{
                        if socket.send(Message::Text(payload.to_string().into())).await.is_err(){
                            break;
                        }
                    },
                    None=>break,
                }
            },
            packet=socket.recv()=>{
                match packet{
                    Some(Ok(Message::Ping(p)))=>{
                        if socket.send(Message::Pong(p)).await.is_err(){break;}
                    },
                    Some(Ok(Message::Close(_)))|None|Some(Err(_))=>break,
                    _=>{},
                }
            },
            _= &mut worker=>break,
        }
    }
    worker.abort();
    let _ = socket.close().await;
}

async fn demo_ws(ws: WebSocketUpgrade) -> Response {
    if !process_control::demo_ws_enabled() {
        return StatusCode::NOT_FOUND.into_response();
    }
    ws.on_upgrade(demo_session)
}

async fn demo_session(mut socket: WebSocket) {
    let mut ticker = interval(Duration::from_millis(500));
    loop {
        ticker.tick().await;
        let sample = DEMO_SEQUENCE.fetch_add(1, Ordering::Relaxed) + 1;
        let price = 220.0 + (sample as f64 / 7.0).sin() * 8.0;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |duration| duration.as_secs());
        let payload = json!({
            "type": "demo_quote",
            "source": "simulated",
            "symbol": "QSYN-DEMO",
            "timestamp": now,
            "price": price
        });
        if socket
            .send(Message::Text(payload.to_string().into()))
            .await
            .is_err()
        {
            break;
        }
    }
}

/// Opt-in dispatcher for previously separate operator utilities. The CLI
/// intentionally retains the original restricted worker validations and never
/// auto-starts a privileged market source from the public web service.
fn dispatch_operator_mode(args: &[String]) -> bool {
    if args.first().map(String::as_str) != Some("mode") {
        return false;
    }
    match args.get(1).map(String::as_str) {
        Some("qsyn-market-archive") => market_archive_entry::main(),
        Some("qsyn-openalgo-feed") => openalgo_feed_entry::main(),
        Some("qsyn-history-import") => history_import_entry::main(),
        Some("qsyn-private-chart") => private_chart_entry::main(),
        Some("qsyn-upstox-worker") => upstox_worker_entry::main(),
        Some("qsyn-upstox-index-worker") => upstox_index_worker_entry::main(),
        Some("qsyn-upstox-history") => upstox_history_entry::main(),
        Some("qsyn-upstox-index-history") => upstox_index_history_entry::main(),
        Some("qsyn-private-index-history") => private_index_history_entry::main(),
        Some("qsyn-private-history") => private_history_entry::main(),
        _ => {
            eprintln!("QSYN runtime: unknown operator mode");
            std::process::exit(2);
        }
    }
    true
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if dispatch_operator_mode(&args) {
        return Ok(());
    }
    if let Some(result) = process_control::dispatch(&args) {
        println!("{}", result);
        if result["ok"] == true {
            return Ok(());
        }
        std::process::exit(2);
    }
    // Preserve original foreground behavior unless explicitly using
    // --qsyn-managed, which is spawned by the restricted ctl subcommand.
    let _managed_pid = if process_control::is_managed(&args) {
        Some(process_control::enter_managed()?)
    } else {
        None
    };
    if !args.is_empty() && !process_control::is_managed(&args) {
        return Err("invalid_arguments".into());
    }
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(run_service())
}

async fn run_service() -> Result<(), Box<dyn std::error::Error>> {
    STARTED_AT.get_or_init(Instant::now);
    // Localhost only by default. Do not publish the demo gateway to the internet.
    let bind = std::env::var("QSYN_BIND").unwrap_or_else(|_| "127.0.0.1:10251".to_owned());
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    // Only the exact qsyn-stream Supervisor program can hand a binary
    // replacement back to Supervisor. Manual processes never auto-exit.
    binary_activation::start();
    let app = Router::new()
        .route("/health", get(health))
        .route("/ws/demo", get(demo_ws))
        .route("/ws/personal-index", get(personal_index_ws))
        .merge(crypto_public::router());
    println!("QSYN Rust foundation listening on {bind}");
    axum::serve(listener, app).await?;
    Ok(())
}
