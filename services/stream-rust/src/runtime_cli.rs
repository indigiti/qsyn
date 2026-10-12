//! Preserve legacy worker arguments when dispatched by the single QSYN ELF.
/// This affects only command parsing; broker entitlements, path validation and
/// per-mode opt-in environment flags remain enforced by each worker module.
pub fn operator_args(expected_mode: &str) -> Vec<String> {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    strip_mode(arguments, expected_mode)
}

/// Extracts only a matching, explicit dispatcher prefix; no generalized CLI
/// aliases or implicit market-feed activation are accepted.
fn strip_mode(mut arguments: Vec<String>, expected_mode: &str) -> Vec<String> {
    if arguments.len() >= 2
        && arguments[0] == "mode"
        && arguments[1] == expected_mode
    {
        arguments.drain(..2);
    }
    arguments
}

#[cfg(test)]
mod tests {
    #[test]
    fn preserves_legacy_cli_surface() {
        // The dispatcher rewrites only the explicit mode prefix. Each
        // individual executable retains its original direct invocation.
        assert_eq!(super::strip_mode(vec!["audit".into(), "/tmp".into()], "qsyn-market-archive"), vec!["audit", "/tmp"]);
        assert_eq!(super::strip_mode(vec!["mode".into(), "qsyn-market-archive".into(), "audit".into(), "/tmp".into()], "qsyn-market-archive"), vec!["audit", "/tmp"]);
        assert_eq!(super::strip_mode(vec!["mode".into(), "qsyn-upstox-worker".into(), "audit".into()], "qsyn-market-archive"), vec!["mode", "qsyn-upstox-worker", "audit"]);
    }
}
