mod binary_activation;
mod process_control;

use axum::{
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde_json::{json, Value};
use std::sync::{atomic::{AtomicU64, Ordering}, OnceLock};
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
        if socket.send(Message::Text(payload.to_string().into())).await.is_err() {
            break;
        }
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if let Some(result) = process_control::dispatch(&args) {
        println!("{}", result);
        if result["ok"] == true { return Ok(()); }
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
        .route("/ws/demo", get(demo_ws));
    println!("QSYN Rust foundation listening on {bind}");
    axum::serve(listener, app).await?;
    Ok(())
}
