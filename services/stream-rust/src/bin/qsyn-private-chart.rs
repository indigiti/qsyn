//! Private chart operator utility. Never a public PHP endpoint.
use qsyn_stream::private_chart_ws::{epoch_ms,load_rights,load_secret,serve};
use qsyn_stream::chart_entitlement::ChartSigner;
use std::{env,io,path::Path};
fn denied()->io::Error{
    io::Error::new(io::ErrorKind::PermissionDenied,"private_chart_operator_access_denied")
}
async fn run()->io::Result<()> {
    if env::var("QSYN_PRIVATE_CHART_GATEWAY_ENABLED").as_deref()!=Ok("1")
        || env::var("QSYN_TRADING_ENABLED").as_deref()==Ok("1")
        || env::var("QSYN_ENABLE_LIVE_TRADING").as_deref()==Ok("1") {
        return Err(denied());
    }
    let rights=env::var("QSYN_PRIVATE_CHART_RIGHTS_FILE").map_err(|_|denied())?;
    let key=env::var("QSYN_PRIVATE_CHART_SIGNING_KEY_FILE").map_err(|_|denied())?;
    let args:Vec<String>=env::args().skip(1).collect();
    match args.as_slice(){
        [cmd,instrument] if cmd=="issue"=>{
            // The caller must authenticate the user via a separate access
            // control plane; operator-only issue is not public login.
            let att=load_rights(Path::new(&rights))?;
            if att.valid_until_ms<=epoch_ms()?{return Err(denied());}
            let signer=ChartSigner::new(load_secret(Path::new(&key))?);
            let grant=signer.issue(&att,instrument,epoch_ms()?,60_000)?;
            println!("{grant}");
            Ok(())
        }
        [cmd,port,socket] if cmd=="serve"=>{
            let port:u16=port.parse().map_err(|_|denied())?;
            serve(port,Path::new(socket),Path::new(&rights),Path::new(&key)).await
        }
        _=>Err(denied())
    }
}
#[tokio::main]
async fn main(){
    if run().await.is_err(){
        eprintln!("QSYN private chart gateway rejected; verify operator access and permissions");
        std::process::exit(2);
    }
}
