//! Same qsyn-stream ELF, no additional binary or index worker plan.
use std::path::Path;

pub(crate) fn main() {
    let args=qsyn_stream::runtime_cli::operator_args("qsyn-personal-index");
    let [operation,symbol,day,runtime]=args.as_slice() else {
        std::process::exit(2);
    };
    if operation!="history" {std::process::exit(2);}
    let run=tokio::runtime::Builder::new_current_thread()
        .enable_all().build();
    let result=run.ok().and_then(|rt|rt.block_on(
        qsyn_stream::personal_index::history(symbol,day,Path::new(runtime))
    ).ok());
    match result {
        Some(json)=>println!("{json}"),
        None=>{
            eprintln!("QSYN personal Upstox Rust history unavailable");
            std::process::exit(2);
        }
    }
}
