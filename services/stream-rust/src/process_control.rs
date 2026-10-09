//! Small Linux-only, self-detaching QSYN lifecycle controller.
//! No shell, no generic command interpreter and no external process manager.
//! The web adapter can invoke only: qsyn-stream ctl start|stop|restart|status.
//! The daemon binds only to QSYN_BIND (127.0.0.1:10251 by default).
use serde_json::{json, Value};
use std::{
    env,
    fs::{self, DirBuilder, File, OpenOptions},
    io::{self, Read, Write},
    net::{SocketAddr, TcpStream},
    os::unix::{fs::{DirBuilderExt, OpenOptionsExt}, process::CommandExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const DAEMON_ARG: &str = "--qsyn-managed";
const PIDFILE: &str = "qsyn-stream.pid";
const LOCKFILE: &str = "qsyn-stream.control.lock";
const LOGFILE: &str = "qsyn-stream.log";

fn io_error(value: &'static str) -> io::Error {
    io::Error::other(value)
}

fn runtime_dir() -> io::Result<PathBuf> {
    let path = match env::var("QSYN_RUNTIME_DIR") {
        Ok(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => env::current_exe()?
            .parent().and_then(Path::parent).and_then(Path::parent)
            .ok_or_else(|| io_error("runtime_path_unavailable"))?
            .join("runtime"),
    };
    if !path.is_absolute() || path.components().any(|x| x == std::path::Component::ParentDir) {
        return Err(io_error("runtime_dir_invalid"));
    }
    if !path.exists() {
        DirBuilder::new().recursive(true).mode(0o700).create(&path)?;
    }
    let meta = fs::symlink_metadata(&path)?;
    if !meta.file_type().is_dir() || meta.file_type().is_symlink() {
        return Err(io_error("runtime_dir_invalid"));
    }
    Ok(path)
}

fn open_file(path: &Path) -> io::Result<File> {
    OpenOptions::new().create(true).read(true).write(true)
        .mode(0o600).custom_flags(libc::O_NOFOLLOW).open(path)
}

struct Lock(File);
impl Lock {
    fn acquire(dir: &Path) -> io::Result<Self> {
        let fd = open_file(&dir.join(LOCKFILE))?;
        // OS-level lock avoids overlapping management calls from PHP workers.
        let rc = unsafe { libc::flock(std::os::fd::AsRawFd::as_raw_fd(&fd), libc::LOCK_EX) };
        if rc != 0 { return Err(io::Error::last_os_error()); }
        Ok(Self(fd))
    }
}
impl Drop for Lock {
    fn drop(&mut self) {
        let _ = unsafe { libc::flock(std::os::fd::AsRawFd::as_raw_fd(&self.0), libc::LOCK_UN) };
    }
}

fn pid_file(dir: &Path) -> PathBuf { dir.join(PIDFILE) }

fn read_pid(dir: &Path) -> Option<i32> {
    let data = fs::read_to_string(pid_file(dir)).ok()?;
    let pid: i32 = data.trim().parse().ok()?;
    if pid <= 1 { return None; }
    Some(pid)
}

/// Never signal a foreign process: inspect its executable AND managed CLI flag.
fn owned_process(pid: i32) -> bool {
    if pid <= 1 { return false; }
    let self_exe = match env::current_exe() { Ok(x) => x, Err(_) => return false };
    let proc_exe = match fs::read_link(format!("/proc/{pid}/exe")) {
        Ok(x) => x,
        Err(_) => return false,
    };
    let a = self_exe.to_string_lossy();
    let b = proc_exe.to_string_lossy();
    if b != a && b != format!("{a} (deleted)") { return false; }

    fs::read(format!("/proc/{pid}/cmdline")).is_ok_and(|cmdline| {
        cmdline.split(|byte| *byte == 0).any(|arg| arg == DAEMON_ARG.as_bytes())
    })
}

fn current_pid(dir: &Path) -> Option<i32> {
    let pid = read_pid(dir)?;
    owned_process(pid).then_some(pid)
}

fn health_check() -> bool {
    let bind = env::var("QSYN_BIND").unwrap_or_else(|_| "127.0.0.1:10251".to_owned());
    let Ok(addr) = bind.parse::<SocketAddr>() else { return false };
    if addr.ip().to_string() != "127.0.0.1" { return false; }
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(120)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(250)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(250)));
    if stream.write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").is_err() {
        return false;
    }
    let mut response = Vec::with_capacity(1024);
    if stream.take(4096).read_to_end(&mut response).is_err() { return false; }
    let content = String::from_utf8_lossy(&response);
    content.starts_with("HTTP/1.1 200") && content.contains("\"component\":\"qsyn-stream\"")
}

fn start(dir: &Path) -> io::Result<&'static str> {
    if current_pid(dir).is_some() {
        return Ok("already_running");
    }
    let exe = env::current_exe()?;
    let log = OpenOptions::new().create(true).append(true).mode(0o600)
        .custom_flags(libc::O_NOFOLLOW).open(dir.join(LOGFILE))?;
    let err = log.try_clone()?;
    let mut process = Command::new(exe);
    process.arg(DAEMON_ARG)
        .stdin(Stdio::null()).stdout(Stdio::from(log)).stderr(Stdio::from(err));
    // setsid in the spawned child's pre-exec stage; CLI process can exit
    // while the service remains detached, if Cloudways permits it.
    unsafe {
        process.pre_exec(|| {
            if libc::setsid() < 0 { Err(io::Error::last_os_error()) } else { Ok(()) }
        });
    }
    let mut child = process.spawn()?;
    let deadline = Instant::now() + Duration::from_secs(4);
    while Instant::now() < deadline {
        if let Some(pid) = current_pid(dir) {
            if pid == child.id() as i32 && health_check() {
                return Ok("running");
            }
        }
        if child.try_wait()?.is_some() { break; }
        thread::sleep(Duration::from_millis(50));
    }
    // On failed readiness don't leave a stray process behind.
    if owned_process(child.id() as i32) {
        let _ = child.kill();
    }
    let _ = child.wait();
    Err(io_error("startup_failed"))
}

fn stop(dir: &Path) -> io::Result<&'static str> {
    let Some(pid) = current_pid(dir) else { return Ok("already_stopped"); };
    // Check identity again immediately before sending signal.
    if !owned_process(pid) { return Err(io_error("identity_changed")); }
    if unsafe { libc::kill(pid, libc::SIGTERM) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if !owned_process(pid) {
            return Ok("stopped");
        }
        thread::sleep(Duration::from_millis(50));
    }
    Err(io_error("shutdown_timeout"))
}

/// Opt-in Phase-0 demo setting controlled from the authenticated PHP admin.
/// Reads private configuration on each handshake: no Rust restart required.
/// An explicit on-disk 0/1 overrides the launch-time environment default.
pub fn demo_ws_enabled() -> bool {
    let fallback = env::var("QSYN_ENABLE_DEMO_WS").as_deref() == Ok("1");
    let Ok(dir) = runtime_dir() else { return fallback };
    let flag = dir.join("demo-websocket.flag");
    let Ok(meta) = fs::symlink_metadata(&flag) else { return fallback };
    if !meta.file_type().is_file() || meta.file_type().is_symlink() || meta.len() > 16 {
        return fallback;
    }
    match fs::read_to_string(flag).ok().as_deref().map(str::trim) {
        Some("1") => true,
        Some("0") => false,
        _ => fallback,
    }
}

pub fn is_managed(args: &[String]) -> bool {
    args == [DAEMON_ARG]
}

pub fn enter_managed() -> io::Result<ManagedPid> {
    let dir = runtime_dir()?;
    // A detached process must not overwrite another active managed PID.
    if current_pid(&dir).is_some() { return Err(io_error("already_running")); }
    let mut file = open_file(&pid_file(&dir))?;
    file.set_len(0)?;
    writeln!(file, "{}", std::process::id())?;
    file.sync_all()?;
    Ok(ManagedPid(dir))
}

pub struct ManagedPid(PathBuf);
impl Drop for ManagedPid {
    fn drop(&mut self) {
        if read_pid(&self.0) == Some(std::process::id() as i32) {
            let _ = fs::remove_file(pid_file(&self.0));
        }
    }
}

/// Returns None for ordinary foreground execution, Some for ctl requests.
pub fn dispatch(args: &[String]) -> Option<Value> {
    if args.first().map(String::as_str) != Some("ctl") { return None; }
    let Some(action) = args.get(1).map(String::as_str) else {
        return Some(json!({"ok":false,"error":"invalid_action"}));
    };
    if args.len() != 2 || !matches!(action, "start" | "stop" | "restart" | "status") {
        return Some(json!({"ok":false,"error":"invalid_action"}));
    }
    let result = (|| -> io::Result<Value> {
        let dir = runtime_dir()?;
        let _lock = Lock::acquire(&dir)?;
        match action {
            "status" => Ok(json!({"ok":true,"state":if current_pid(&dir).is_some() {"running"} else {"stopped"}})),
            "start" => Ok(json!({"ok":true,"state":start(&dir)?})),
            "stop" => Ok(json!({"ok":true,"state":stop(&dir)?})),
            "restart" => {
                stop(&dir)?;
                Ok(json!({"ok":true,"state":start(&dir)?}))
            }
            _ => unreachable!(),
        }
    })();
    Some(result.unwrap_or_else(|err| {
        // Do not reveal arbitrary host paths or system errors to PHP.
        let kind = match err.to_string().as_str() {
            "startup_failed" => "startup_failed",
            "shutdown_timeout" => "shutdown_timeout",
            "already_running" => "already_running",
            "identity_changed" => "identity_changed",
            "runtime_dir_invalid" => "runtime_dir_invalid",
            _ => "runtime_control_failed",
        };
        json!({"ok":false,"error":kind})
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recognized_commands_only() {
        assert!(is_managed(&["--qsyn-managed".to_owned()]));
        assert!(!is_managed(&["ctl".to_owned(), "start".to_owned()]));
        assert!(dispatch(&["ctl".to_owned(), "arbitrary".to_owned()]).is_some());
        assert!(dispatch(&["help".to_owned()]).is_none());
    }
}
