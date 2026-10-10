//! Opt-in, loopback-only historical chart service. Private source rights and
//! reader authorization are checked for each request. No orders.
use qsyn_stream::private_history_http::{serve, HistoryConfig};
use serde_json::json;
use std::{env, io, path::PathBuf};
fn denied()->io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied,"operator_private_history_disabled")
}
#[tokio::main]
async fn main(){
    let args=env::args().skip(1).collect::<Vec<_>>();
    let result=match args.as_slice(){
        [cmd,settings,key,history,port] if cmd=="check" || cmd=="serve"=>{
            let cfg=HistoryConfig {
                settings_path:PathBuf::from(settings),
                signing_key_path:PathBuf::from(key),
                archive_root:PathBuf::from(history),
            };
            match cfg.verify(qsyn_stream::private_chart_ws::epoch_ms().unwrap_or(0)){
                Ok(_) if cmd=="check"=>{
                    println!("{}",json!({"status":"private_history_preflight_ok",
                        "http_listening":false,"broker_verified_live":false,
                        "live_trading_enabled":false}));
                    Ok(())
                }
                Ok(_) if cmd=="serve"
                    && env::var("QSYN_PRIVATE_HISTORY_HTTP_ENABLED").as_deref()==Ok("1")
                    && env::var("QSYN_TRADING_ENABLED").as_deref()!=Ok("1")
                    && env::var("QSYN_ENABLE_LIVE_TRADING").as_deref()!=Ok("1")=>{
                    match port.parse::<u16>(){
                        Ok(port)=>serve(port,cfg).await,
                        Err(_)=>Err(denied()),
                    }
                }
                _=>Err(denied())
            }
        }
        _=>Err(denied())
    };
    if result.is_err(){
        eprintln!("QSYN private history service refused: operator rights or private source unavailable");
        std::process::exit(2);
    }
}
