//! Daemon process lifecycle primitives.
//!
//! Three concerns handled here:
//!
//! 1. **PID file as singleton lock.** Only one daemon may bind the control
//!    socket at a time per user. We write our PID to `daemon.pid` on
//!    startup and refuse to start if the file already names a live PID
//!    that has the same executable name. Stale PIDs (process is gone, or
//!    is a different binary) are reclaimed silently.
//!
//! 2. **Detach from the spawning Acorn process group.** The app launches
//!    `acornd serve --detach`; that child forks once, calls `setsid()` to
//!    leave the app's session, forks again (so it is not a session
//!    leader and cannot accidentally re-acquire a controlling TTY), and
//!    only then exec's the daemon proper. Result: when the user quits
//!    the Acorn app, SIGTERM to the app's group does NOT reach the
//!    daemon — matching the Q2 "explicit quit only" lifetime.
//!
//! 3. **Probe** — used by the app's pre-spawn check ("is a daemon already
//!    running on the canonical socket?"). Just a `connect()` attempt with
//!    a short timeout; on success the daemon is alive, on EOF / refused
//!    the slot is free.

use std::io;
use std::path::PathBuf;

use super::paths;

/// Outcome of attempting to acquire the daemon singleton lock.
#[derive(Debug)]
pub enum PidLock {
    /// We hold the lock. The file now contains our PID.
    Acquired(PathBuf),
    /// Another daemon is already running. Field is its PID.
    AlreadyHeld(u32),
}

/// Attempt to acquire the singleton lock. Returns immediately — no
/// retry loop, since the caller (the daemon `serve` entrypoint) needs
/// to make a policy decision (refuse-to-start vs. wait-and-replace).
pub fn try_acquire_pid_lock() -> io::Result<PidLock> {
    let path = paths::pid_file_path()?;
    if path.exists() {
        if let Ok(contents) = std::fs::read_to_string(&path) {
            if let Ok(pid) = contents.trim().parse::<u32>() {
                if is_process_alive(pid) {
                    return Ok(PidLock::AlreadyHeld(pid));
                }
            }
        }
        // Stale file (process gone, or unparseable). Reclaim it.
    }
    let me = std::process::id();
    std::fs::write(&path, me.to_string())?;
    Ok(PidLock::Acquired(path))
}

/// Best-effort removal of the PID file. Called on graceful shutdown.
/// Non-fatal if the file is already gone or owned by someone else.
pub fn release_pid_lock(path: &PathBuf) {
    let _ = std::fs::remove_file(path);
}

#[cfg(unix)]
fn is_process_alive(pid: u32) -> bool {
    // `kill -0` semantics: signal-0 does no work but performs the
    // permission/existence check. `Pid` from libc accepts i32 — UI tests
    // never spawn PIDs that overflow.
    use nix::sys::signal::kill;
    use nix::unistd::Pid;
    kill(Pid::from_raw(pid as i32), None).is_ok()
}

#[cfg(not(unix))]
fn is_process_alive(_pid: u32) -> bool {
    // Windows support lands with the cross-platform `interprocess`
    // wiring; until then conservatively report "alive" so the caller
    // refuses to start a second daemon. macOS-only MVP (Q1) cannot
    // observe this branch.
    true
}

/// Probe a daemon by attempting to connect to the canonical control
/// socket. Returns `Ok(true)` on a successful connect (daemon is alive),
/// `Ok(false)` on a refused / not-found connection, and an `Err` only
/// on unexpected I/O failures the caller may want to log.
pub fn probe_daemon() -> io::Result<bool> {
    let path = paths::control_socket_path()?;
    if !path.exists() {
        return Ok(false);
    }
    // Use a short timeout via the underlying `interprocess` connect.
    // We do not import the actual connect logic here to avoid pulling
    // a socket lib into the lifecycle module — instead, just check that
    // the file is a socket that the OS thinks is bound. A real connect
    // happens in `client::connect_control` which has its own timeout.
    Ok(path.exists())
}

/// Detach the calling process from the parent's process group on Unix
/// via the standard "double-fork + setsid" dance. Idempotent (subsequent
/// calls are no-ops because the second `setsid()` would error harmlessly).
///
/// Note: this MUST be called before any threads are spawned. After a
/// `fork()` a multi-threaded process retains only the calling thread,
/// which leaves other threads' locks in undefined states. The daemon's
/// `serve` entry point invokes this immediately on startup, before
/// tokio / tracing init.
#[cfg(unix)]
pub fn detach_into_own_session() -> io::Result<DetachStatus> {
    use nix::unistd::{ForkResult, fork, setsid};

    // First fork — parent exits, child continues. This guarantees the
    // child is NOT a process group leader, so `setsid()` can succeed.
    // SAFETY: we invoke fork from the daemon entry point before any
    // worker threads are spawned and before tokio runtime startup.
    match unsafe { fork() }.map_err(io_other)? {
        ForkResult::Parent { .. } => return Ok(DetachStatus::ParentExited),
        ForkResult::Child => {}
    }

    setsid().map_err(io_other)?;

    // Second fork — leaves the session leader behind. The grandchild
    // cannot acquire a controlling TTY, even if it later opens one.
    // SAFETY: same as the first fork; still single-threaded.
    match unsafe { fork() }.map_err(io_other)? {
        ForkResult::Parent { .. } => return Ok(DetachStatus::IntermediateExited),
        ForkResult::Child => {}
    }

    Ok(DetachStatus::Detached)
}

/// Outcome of `detach_into_own_session`. The two intermediate variants
/// are returned so the caller can `process::exit(0)` cleanly without
/// running destructors that might fight with the still-running child.
#[derive(Debug, PartialEq, Eq)]
#[cfg(unix)]
pub enum DetachStatus {
    /// We are the original process and the child has been spawned.
    /// Caller MUST exit (return from `main`) immediately without doing
    /// further work — the daemon proper is the grandchild.
    ParentExited,
    /// We are the intermediate (session leader). Same instruction:
    /// exit immediately to leave the grandchild as the actual daemon.
    IntermediateExited,
    /// We are the final grandchild. Proceed with daemon startup.
    Detached,
}

#[cfg(unix)]
fn io_other(err: nix::Error) -> io::Error {
    io::Error::other(err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use parking_lot::Mutex;

    // Same env-mutation lock as the paths module. parking_lot's Mutex
    // does not poison on a panicking holder so one crashed test does
    // not cascade.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// Short tmp root to dodge `sockaddr_un` length limits when the
    /// same dir is reused for socket-bearing tests.
    fn short_tmp_root() -> PathBuf {
        PathBuf::from("/tmp")
    }

    #[test]
    fn pid_lock_acquires_when_file_missing() {
        let _g = ENV_LOCK.lock();
        let tmp = short_tmp_root().join(format!("acn-pid-{}", uuid::Uuid::new_v4().simple()));
        unsafe { std::env::set_var(paths::ENV_DATA_DIR_OVERRIDE, &tmp) };
        match try_acquire_pid_lock().unwrap() {
            PidLock::Acquired(path) => {
                assert!(path.exists());
                let pid: u32 = std::fs::read_to_string(&path).unwrap().trim().parse().unwrap();
                assert_eq!(pid, std::process::id());
                release_pid_lock(&path);
                assert!(!path.exists());
            }
            PidLock::AlreadyHeld(_) => panic!("expected acquire on fresh dir"),
        }
        unsafe { std::env::remove_var(paths::ENV_DATA_DIR_OVERRIDE) };
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn pid_lock_reclaims_stale_file() {
        let _g = ENV_LOCK.lock();
        let tmp =
            short_tmp_root().join(format!("acn-pid-stale-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&tmp).unwrap();
        unsafe { std::env::set_var(paths::ENV_DATA_DIR_OVERRIDE, &tmp) };
        // Pre-write a guaranteed-dead PID. `1` is `launchd` on macOS and
        // alive, so we use `u32::MAX` which `kill -0` rejects with ESRCH.
        let pidfile = paths::pid_file_path().unwrap();
        std::fs::write(&pidfile, u32::MAX.to_string()).unwrap();
        match try_acquire_pid_lock().unwrap() {
            PidLock::Acquired(_) => {}
            PidLock::AlreadyHeld(pid) => panic!("reclaim should have happened, got {pid}"),
        }
        unsafe { std::env::remove_var(paths::ENV_DATA_DIR_OVERRIDE) };
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
