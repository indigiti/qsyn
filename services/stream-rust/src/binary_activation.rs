//! QSYN-only binary activation for Cloudways Supervisor.
//!
//! DigiOps publishes a verified replacement by atomic rename. Linux allows
//! the old process to continue executing its old inode. Under Supervisor,
//! exit code 75 is deliberately unexpected, so `autorestart=unexpected`
//! launches the newly published executable without PHP process execution.
//! Never enable this behavior outside the named Supervisor program.

use std::{
    env, fs,
    os::unix::fs::MetadataExt,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::Duration,
};

pub const RESTART_EXIT_CODE: i32 = 75;
static ACTIVE: AtomicBool = AtomicBool::new(false);

fn supervised(enabled: Option<&str>, process: Option<&str>) -> bool {
    enabled == Some("1") && process == Some("qsyn-stream")
}

pub fn active() -> bool {
    ACTIVE.load(Ordering::Relaxed)
}

fn replaced_on_disk(path: &Path) -> bool {
    let Ok(running) = fs::metadata("/proc/self/exe") else { return false };
    let Ok(published) = fs::symlink_metadata(path) else { return false };
    if !published.file_type().is_file() || published.file_type().is_symlink() {
        return false;
    }
    running.dev() != published.dev() || running.ino() != published.ino()
}

pub fn start() {
    if !supervised(
        env::var("SUPERVISOR_ENABLED").ok().as_deref(),
        env::var("SUPERVISOR_PROCESS_NAME").ok().as_deref(),
    ) {
        return;
    }
    let Ok(path) = env::current_exe() else { return };
    // Do not enable if the executable path is already inconsistent or if
    // /proc cannot tell us which inode this process actually executes.
    if !fs::metadata("/proc/self/exe").is_ok_and(|m| {
        fs::symlink_metadata(&path).is_ok_and(|disk| {
            disk.file_type().is_file()
                && !disk.file_type().is_symlink()
                && m.dev() == disk.dev()
                && m.ino() == disk.ino()
        })
    }) {
        return;
    }
    match thread::Builder::new()
        .name("qsyn-supervisor-watch".to_owned())
        .spawn(move || loop {
            thread::sleep(Duration::from_secs(5));
            if replaced_on_disk(&path) {
                eprintln!("QSYN: verified executable path now points to a new inode; handing restart to Supervisor");
                std::process::exit(RESTART_EXIT_CODE);
            }
        })
    {
        Ok(_) => ACTIVE.store(true, Ordering::Relaxed),
        Err(_) => eprintln!("QSYN: Supervisor binary watcher could not start"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_exact_named_supervisor_program_can_activate() {
        assert!(supervised(Some("1"), Some("qsyn-stream")));
        assert!(!supervised(None, Some("qsyn-stream")));
        assert!(!supervised(Some("0"), Some("qsyn-stream")));
        assert!(!supervised(Some("1"), None));
        assert!(!supervised(Some("1"), Some("qnext")));
        assert!(!supervised(Some("1"), Some("other")));
    }
}
