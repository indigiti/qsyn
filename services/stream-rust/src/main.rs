mod process_control;

use axum::{
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde_json::{json, Value};
use tokio::time::{interval, Duration};

async fn health() -> Json<Value> {
    Json(json!({
        "status": "ok",
        "component": "qsyn-stream",
        "mode": "foundation",
        "upstox_connected": false,
        "trading_enabled": false
    }))
}

async fn demo_ws(ws: WebSocketUpgrade) -> Response {
    if std::env::var("QSYN_ENABLE_DEMO_WS").as_deref() != Ok("1") {
        return StatusCode::NOT_FOUND.into_response();
    }
    ws.on_upgrade(demo_session)
}

async fn demo_session(mut socket: WebSocket) {
    let mut ticker = interval(Duration::from_millis(500));
    let mut sample = 0_u64;
    loop {
        ticker.tick().await;
        sample += 1;
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
    // Localhost only by default. Do not publish the demo gateway to the internet.
    let bind = std::env::var("QSYN_BIND").unwrap_or_else(|_| "127.0.0.1:10251".to_owned());
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    let app = Router::new()
        .route("/health", get(health))
        .route("/ws/demo", get(demo_ws));
    println!("QSYN Rust foundation listening on {bind}");
    axum::serve(listener, app).await?;
    Ok(())
}
