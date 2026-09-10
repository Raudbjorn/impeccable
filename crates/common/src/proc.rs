//! Process helpers the JS got from Node for free and that differ per OS:
//! `process.kill(pid, 0)` liveness, `process.kill(pid)`, `spawn(...,
//! { detached: true })`, and `process.on('SIGINT' | 'SIGTERM')`.
//!
//! Linux process operations use libc.

use std::process::Command;
use std::sync::atomic::AtomicBool;

/// `process.kill(pid, 0)`: `Ok(())` when the process exists and can be
/// signalled, otherwise the errno name Node would report (`ESRCH` when there
/// is no such process, `EPERM` when it exists but is not ours, `EINVAL`
/// otherwise). Callers that only ask "is it alive?" should use
/// [`pid_reachable`].
pub fn kill0(pid: i64) -> Result<(), &'static str> {
    if pid <= 0 || pid > i32::MAX as i64 {
        return Err("ESRCH");
    }
    #[cfg(unix)]
    {
        let rc = unsafe { libc::kill(pid as libc::pid_t, 0) };
        if rc == 0 {
            return Ok(());
        }
        match std::io::Error::last_os_error().raw_os_error() {
            Some(libc::EPERM) => Err("EPERM"),
            Some(libc::ESRCH) => Err("ESRCH"),
            _ => Err("EINVAL"),
        }
    }

    #[cfg(not(unix))]
    {
        Err("ESRCH")
    }
}

/// `isLiveServerPidReachable(pid)` and friends: alive unless ESRCH (an EPERM
/// process is somebody else's, but it is there).
pub fn pid_reachable(pid: i64) -> bool {
    match kill0(pid) {
        Ok(()) => true,
        Err(code) => code != "ESRCH",
    }
}

/// Send SIGTERM. Errors are ignored by callers.
pub fn terminate(pid: i64) {
    if pid <= 0 || pid > i32::MAX as i64 {
        return;
    }
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as libc::pid_t, libc::SIGTERM);
    }
}

/// Start the child in its own session so it survives the parent.
pub fn detach(cmd: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: setsid is async-signal-safe and touches no shared state.
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }

    #[cfg(not(unix))]
    {
        let _ = cmd;
    }
}

/// Isolate a bounded worker so its descendants can be stopped with it.
pub fn worker_group(cmd: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
}

/// Kill a worker's entire process tree after a timeout, then reap the parent.
pub fn kill_worker(child: &mut std::process::Child) {
    #[cfg(unix)]
    unsafe { libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL); }

    let _ = child.kill();
    let _ = child.wait();
}

/// Register SIGINT/SIGTERM handlers that set a shared shutdown flag.
pub fn on_interrupt(flag: &'static AtomicBool) {
    FLAG.store(
        flag as *const AtomicBool as *mut AtomicBool,
        std::sync::atomic::Ordering::SeqCst,
    );
    #[cfg(unix)]
    unsafe {
        libc::signal(
            libc::SIGINT,
            unix_on_signal as *const () as libc::sighandler_t,
        );
        libc::signal(
            libc::SIGTERM,
            unix_on_signal as *const () as libc::sighandler_t,
        );
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }
}

static FLAG: std::sync::atomic::AtomicPtr<AtomicBool> =
    std::sync::atomic::AtomicPtr::new(std::ptr::null_mut());

fn set_flag() {
    let p = FLAG.load(std::sync::atomic::Ordering::SeqCst);
    if !p.is_null() {
        // SAFETY: the pointer came from a `&'static AtomicBool`.
        unsafe { (*p).store(true, std::sync::atomic::Ordering::SeqCst) };
    }
}

#[cfg(unix)]
extern "C" fn unix_on_signal(_sig: libc::c_int) {
    set_flag();
}

/// Render a child exit signal.
pub fn signal_name(sig: i32) -> String {
    #[cfg(unix)]
    {
        match sig {
            libc::SIGINT => "SIGINT".into(),
            libc::SIGTERM => "SIGTERM".into(),
            libc::SIGKILL => "SIGKILL".into(),
            libc::SIGHUP => "SIGHUP".into(),
            libc::SIGABRT => "SIGABRT".into(),
            libc::SIGSEGV => "SIGSEGV".into(),
            libc::SIGPIPE => "SIGPIPE".into(),
            _ => format!("SIG{}", sig),
        }
    }
    #[cfg(not(unix))]
    {
        format!("SIG{}", sig)
    }
}

/// The Node executable name.
pub fn node_exe() -> &'static str {
    "node"
}

/// Run a shell script through `/bin/sh -c`.
pub fn shell(script: &str) -> Command {
    let mut c = Command::new("/bin/sh");
    c.arg("-c").arg(script);
    c
}

/// Whether `which` can resolve a tool.
pub fn tool_on_path(tool: &str) -> bool {
    let probe = "which";
    let mut cmd = Command::new(probe);
    cmd.arg(tool)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    cmd.status().map(|s| s.success()).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn own_pid_is_alive_and_bogus_pid_is_not() {
        assert_eq!(kill0(std::process::id() as i64), Ok(()));
        assert!(pid_reachable(std::process::id() as i64));
        assert_eq!(kill0(0), Err("ESRCH"));
        assert_eq!(kill0(-1), Err("ESRCH"));
        assert_eq!(kill0(i64::MAX), Err("ESRCH"));
    }

    #[test]
    fn shell_runs_a_script() {
        let out = shell("echo hi").output().expect("shell spawns");
        assert!(String::from_utf8_lossy(&out.stdout)
            .trim_end()
            .ends_with("hi"));
    }

    #[test]
    fn detached_child_spawns() {
        let mut cmd = Command::new("true");

        cmd.stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        detach(&mut cmd);
        let mut child = cmd.spawn().expect("detached spawn");
        let _ = child.wait();
    }
}
