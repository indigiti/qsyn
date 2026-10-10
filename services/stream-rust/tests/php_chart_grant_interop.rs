use qsyn_stream::chart_entitlement::{
    ChartSigner, ChartViewer, EntitlementAttestation,
};
use std::fs;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

/// Ensures PHP private browser-session issuer produces EXACTLY the Rust WSS
/// HMAC/JSON grant wire format. No real identity, Upstox session or market feed.
#[test]
fn php_chart_grant_is_accepted_by_rust_without_bypassing_current_rights() {
    let directory = std::env::temp_dir().join(format!(
        "qsyn-php-chart-bridge-{}-{}",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos(),
    ));
    fs::create_dir(&directory).unwrap();
    let secret_path = directory.join("key.bin");
    fs::write(&secret_path, [42u8; 32]).unwrap();
    #[cfg(unix)]
    { use std::os::unix::fs::PermissionsExt;
      fs::set_permissions(&secret_path, fs::Permissions::from_mode(0o600)).unwrap(); }

    let php = r#"require $argv[2];
        putenv('QSYN_PRIVATE_CHART_SIGNING_KEY_FILE='.$argv[1].'/key.bin');
        $rights=['tenant'=>'tenant-one', 'account'=>'upstox-A',
                 'owner'=>'u_aabbcc', 'broker'=>'upstox',
                 'license_id'=>'private-test'];
        $method=new ReflectionMethod(\QSYN\MarketData\PrivateChartGrantApi::class,'issue');
        $value=$method->invoke(null,$rights,'NFO|CE',$argv[1],100000);
        if(!is_array($value)) exit(3);
        echo $value['ticket'];"#
    ;
    let php_src = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../apps/web-php/src/PrivateChartGrantApi.php");
    let result = Command::new("php")
        .arg("-r")
        .arg(php)
        .arg(&directory)
        .arg(php_src)
        .output()
        .expect("php installed in CI for interoperability");
    let _ = fs::remove_file(secret_path);
    let _ = fs::remove_dir(directory);
    assert!(result.status.success(), "php grant generation failed");
    let token = String::from_utf8(result.stdout).unwrap();
    let att = EntitlementAttestation {
        tenant: "tenant-one".into(), account: "upstox-A".into(),
        owner: "u_aabbcc".into(), broker: "upstox".into(),
        instruments: vec!["NFO|CE".into()], license_id: "private-test".into(),
        can_display_to_this_user: true, broker_session_verified: true,
        valid_until_ms: 180_000,
    };
    let signer = ChartSigner::new([42u8; 32]);
    let viewer = ChartViewer {
        tenant: "tenant-one", account: "upstox-A", owner: "u_aabbcc",
        instrument: "NFO|CE",
    };
    assert!(signer.verify(&token, 115_000, &viewer, &att).is_ok());
    assert!(signer.verify(&token, 130_000, &viewer, &att).is_err());
    let mut revoked = att.clone();
    revoked.can_display_to_this_user = false;
    assert!(signer.verify(&token, 115_000, &viewer, &revoked).is_err());
    assert!(signer.verify(
        &token, 115_000, &ChartViewer { account: "upstox-B", ..viewer }, &att
    ).is_err());
}
