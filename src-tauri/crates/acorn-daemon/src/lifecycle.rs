//! Daemon process lifecycle primitives.
//!
//! Three concerns handled here:
//!
//! 1. **PID file as singleton lock.** Only one daemon may bind the control
//!    socket at a time per user. We write our PID to `daemon.pid` on
//!    startup and refuse to start only when the recorded PID is alive
//!    *and* points at an `acornd` binary. PIDs that are gone, unparseable,
//!    or recycled by an unrelated process are reclaimed silently — without
//!    the executable check, OS PID reuse (e.g. macOS handing the slot to
//!    a system XPC) wedges every restart with `daemon already running`.
//!
//! 2. **Detach from the spawning Acorn process group.** On Unix, the app's
//!    `acornd serve --detach` child forks once, calls `setsid()`, then forks
//!    again so the daemon cannot re-acquire a controlling TTY. On Windows,
//!    the `acornd` entry point re-execs itself with detached-process creation
//!    flags before entering this crate. In both cases, quitting Acorn leaves
//!    the daemon running until an explicit `Shutdown` RPC.
//!
//! 3. **Probe** — used by the app's pre-spawn check ("is a daemon already
//!    running on the canonical socket?"). Just a `connect()` attempt with
//!    a short timeout; on success the daemon is alive, on EOF / refused
//!    the slot is free.

use std::fs::{File, Metadata, OpenOptions, TryLockError};
use std::io::{self, Read, Seek, Write};
use std::path::{Path, PathBuf};

use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System};

use super::paths;

/// Logical basename of the daemon binary. Compared against the running
/// process's `exe()` / `name()` / `argv[0]` with platform naming rules.
const DAEMON_EXECUTABLE: &str = "acornd";

/// Outcome of attempting to acquire the daemon singleton lock.
#[derive(Debug)]
pub enum PidLock {
    /// We hold the lock. The guard keeps the OS lock alive until it is
    /// dropped; the reusable PID file itself remains on disk.
    Acquired(PidLockGuard),
    /// Another daemon is already running. Field is its PID.
    AlreadyHeld(u32),
}

/// Process-lifetime ownership of the daemon PID file.
#[derive(Debug)]
pub struct PidLockGuard {
    path: PathBuf,
    _file: File,
}

impl PidLockGuard {
    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// Attempt to acquire the singleton lock. Returns immediately — no
/// retry loop, since the caller (the daemon `serve` entrypoint) needs
/// to make a policy decision (refuse-to-start vs. wait-and-replace).
pub fn try_acquire_pid_lock() -> io::Result<PidLock> {
    let path = paths::pid_file_path()?;
    let mut file = open_pid_file(&path)?;
    match file.try_lock() {
        Ok(()) => {}
        Err(TryLockError::WouldBlock) => {
            let pid = read_pid_file(&mut file)?.ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::WouldBlock,
                    "daemon PID lock is held before a valid PID claim was published",
                )
            })?;
            return Ok(PidLock::AlreadyHeld(pid));
        }
        Err(TryLockError::Error(err)) => return Err(err),
    }

    if let Some(pid) = read_pid_file(&mut file)? {
        if is_our_daemon(pid) {
            return Ok(PidLock::AlreadyHeld(pid));
        }
        // Stale claim (process gone or PID was recycled by an unrelated
        // binary). The exclusive OS lock makes replacement atomic with
        // respect to every current daemon contender.
    }
    let me = std::process::id();
    #[cfg(unix)]
    file.set_permissions(std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
    file.set_len(0)?;
    file.rewind()?;
    file.write_all(me.to_string().as_bytes())?;
    file.flush()?;
    Ok(PidLock::Acquired(PidLockGuard { path, _file: file }))
}

fn open_pid_file(path: &Path) -> io::Result<File> {
    loop {
        match std::fs::symlink_metadata(path) {
            Ok(before) => {
                validate_pid_file_metadata(path, &before)?;
                let file = match OpenOptions::new().read(true).write(true).open(path) {
                    Ok(file) => file,
                    Err(err) if err.kind() == io::ErrorKind::NotFound => continue,
                    Err(err) => return Err(err),
                };
                let opened = file.metadata()?;
                validate_pid_file_metadata(path, &opened)?;
                validate_same_pid_file(path, &before, &opened)?;
                return Ok(file);
            }
            Err(err) if err.kind() == io::ErrorKind::NotFound => {
                let mut options = OpenOptions::new();
                options.read(true).write(true).create_new(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.mode(0o600);
                }
                match options.open(path) {
                    Ok(file) => return Ok(file),
                    Err(err) if err.kind() == io::ErrorKind::AlreadyExists => continue,
                    Err(err) => return Err(err),
                }
            }
            Err(err) => return Err(err),
        }
    }
}

fn validate_pid_file_metadata(path: &Path, metadata: &Metadata) -> io::Result<()> {
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("daemon PID lock is not a regular file: {}", path.display()),
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() > 1 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "daemon PID lock must not be hard-linked: {}",
                    path.display()
                ),
            ));
        }
    }
    Ok(())
}

#[cfg(unix)]
fn validate_same_pid_file(path: &Path, before: &Metadata, opened: &Metadata) -> io::Result<()> {
    use std::os::unix::fs::MetadataExt;

    if before.dev() != opened.dev() || before.ino() != opened.ino() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("daemon PID lock changed while opening: {}", path.display()),
        ));
    }
    Ok(())
}

#[cfg(not(unix))]
fn validate_same_pid_file(_path: &Path, _before: &Metadata, _opened: &Metadata) -> io::Result<()> {
    Ok(())
}

fn read_pid_file(file: &mut File) -> io::Result<Option<u32>> {
    const MAX_PID_BYTES: u64 = 32;

    file.rewind()?;
    let mut bytes = Vec::with_capacity(MAX_PID_BYTES as usize + 1);
    file.take(MAX_PID_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_PID_BYTES {
        return Ok(None);
    }
    let Ok(contents) = std::str::from_utf8(&bytes) else {
        return Ok(None);
    };
    Ok(contents.trim().parse::<u32>().ok())
}

/// A PID claim is valid only while that process exists and its executable
/// identity matches the daemon. This rejects both dead and recycled PIDs.
fn is_our_daemon(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    let target_pid = Pid::from_u32(pid);
    let mut sys = System::new_with_specifics(
        RefreshKind::nothing().with_processes(ProcessRefreshKind::nothing()),
    );
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[target_pid]),
        true,
        ProcessRefreshKind::nothing(),
    );
    sys.process(target_pid)
        .map(process_basename_is_daemon)
        .unwrap_or(false)
}

fn process_basename_is_daemon(proc: &sysinfo::Process) -> bool {
    if let Some(exe) = proc.exe().and_then(|p| p.to_str()) {
        if acorn_platform::executable::executable_name_matches(exe, DAEMON_EXECUTABLE) {
            return true;
        }
    }
    if let Some(name) = proc.name().to_str() {
        if acorn_platform::executable::executable_name_matches(name, DAEMON_EXECUTABLE) {
            return true;
        }
    }
    if let Some(first) = proc.cmd().first() {
        if acorn_platform::executable::executable_name_matches(
            &first.to_string_lossy(),
            DAEMON_EXECUTABLE,
        ) {
            return true;
        }
    }
    false
}

/// Probe a daemon by attempting to connect to the canonical control
/// socket. Returns `Ok(true)` on a successful connect (daemon is alive),
/// `Ok(false)` on a refused / not-found connection, and an `Err` only
/// on unexpected I/O failures the caller may want to log.
pub fn probe_daemon() -> io::Result<bool> {
    match super::socket::connect_control() {
        Ok(stream) => {
            drop(stream);
            Ok(true)
        }
        Err(err)
            if matches!(
                err.kind(),
                io::ErrorKind::NotFound
                    | io::ErrorKind::ConnectionRefused
                    | io::ErrorKind::TimedOut
            ) =>
        {
            Ok(false)
        }
        Err(err) => Err(err),
    }
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
    use nix::unistd::{fork, setsid, ForkResult};

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
    use crate::test_env::ENV_LOCK;

    /// Unix needs a short root to dodge `sockaddr_un` length limits. Windows
    /// must use the account's writable temporary directory rather than the
    /// Unix-specific `/tmp` path (which would resolve to `C:\tmp`).
    fn short_tmp_root() -> PathBuf {
        #[cfg(unix)]
        {
            PathBuf::from("/tmp")
        }
        #[cfg(not(unix))]
        {
            std::env::temp_dir()
        }
    }

    #[test]
    fn pid_lock_acquires_when_file_missing() {
        let _g = ENV_LOCK.lock();
        let tmp = short_tmp_root().join(format!("acn-pid-{}", uuid::Uuid::new_v4().simple()));
        unsafe { std::env::set_var(paths::ENV_DATA_DIR_OVERRIDE, &tmp) };
        match try_acquire_pid_lock().unwrap() {
            PidLock::Acquired(lock) => {
                let path = lock.path().to_path_buf();
                assert!(path.exists());
                let pid: u32 = std::fs::read_to_string(&path)
                    .unwrap()
                    .trim()
                    .parse()
                    .unwrap();
                assert_eq!(pid, std::process::id());
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    assert_eq!(
                        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                        0o600
                    );
                }
                drop(lock);
                assert!(path.exists(), "the reusable lock inode stays on disk");
            }
            PidLock::AlreadyHeld(_) => panic!("expected acquire on fresh dir"),
        }
        unsafe { std::env::remove_var(paths::ENV_DATA_DIR_OVERRIDE) };
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn pid_lock_stays_exclusive_for_the_guard_lifetime() {
        let _g = ENV_LOCK.lock();
        let tmp = short_tmp_root().join(format!("acn-pid-held-{}", uuid::Uuid::new_v4().simple()));
        unsafe { std::env::set_var(paths::ENV_DATA_DIR_OVERRIDE, &tmp) };
        let first = match try_acquire_pid_lock().unwrap() {
            PidLock::Acquired(lock) => lock,
            PidLock::AlreadyHeld(pid) => panic!("fresh lock already held by {pid}"),
        };

        assert!(matches!(
            try_acquire_pid_lock().unwrap(),
            PidLock::AlreadyHeld(pid) if pid == std::process::id()
        ));

        let path = first.path().to_path_buf();
        drop(first);
        assert!(path.exists());
        unsafe { std::env::remove_var(paths::ENV_DATA_DIR_OVERRIDE) };
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn pid_lock_reclaims_stale_file() {
        let _g = ENV_LOCK.lock();
        let tmp = short_tmp_root().join(format!("acn-pid-stale-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&tmp).unwrap();
        unsafe { std::env::set_var(paths::ENV_DATA_DIR_OVERRIDE, &tmp) };
        // `u32::MAX` cannot name a live process on supported hosts.
        let pidfile = paths::pid_file_path().unwrap();
        std::fs::write(&pidfile, u32::MAX.to_string()).unwrap();
        match try_acquire_pid_lock().unwrap() {
            PidLock::Acquired(_) => {}
            PidLock::AlreadyHeld(pid) => panic!("reclaim should have happened, got {pid}"),
        }
        unsafe { std::env::remove_var(paths::ENV_DATA_DIR_OVERRIDE) };
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// An alive PID whose binary is not `acornd` must be treated as stale.
    #[test]
    fn pid_lock_reclaims_when_pid_belongs_to_unrelated_binary() {
        let _g = ENV_LOCK.lock();
        let tmp = short_tmp_root().join(format!("acn-pid-reuse-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&tmp).unwrap();
        unsafe { std::env::set_var(paths::ENV_DATA_DIR_OVERRIDE, &tmp) };
        // The test runner itself: guaranteed alive, guaranteed not
        // `acornd` (cargo names the test binary something like
        // `acorn_lib-<hash>`).
        let pidfile = paths::pid_file_path().unwrap();
        std::fs::write(&pidfile, std::process::id().to_string()).unwrap();
        match try_acquire_pid_lock().unwrap() {
            PidLock::Acquired(_) => {}
            PidLock::AlreadyHeld(pid) => {
                panic!("recycled PID should have been reclaimed, got {pid}")
            }
        }
        unsafe { std::env::remove_var(paths::ENV_DATA_DIR_OVERRIDE) };
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[cfg(unix)]
    #[test]
    fn pid_lock_does_not_overwrite_an_inaccessible_claim() {
        use std::os::unix::fs::PermissionsExt;

        let _g = ENV_LOCK.lock();
        let tmp =
            short_tmp_root().join(format!("acn-pid-denied-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&tmp).unwrap();
        unsafe { std::env::set_var(paths::ENV_DATA_DIR_OVERRIDE, &tmp) };
        let pidfile = paths::pid_file_path().unwrap();
        std::fs::write(&pidfile, "stale-but-private").unwrap();
        let original_permissions = std::fs::metadata(&pidfile).unwrap().permissions();
        let mut denied_permissions = original_permissions.clone();
        denied_permissions.set_mode(0o000);
        std::fs::set_permissions(&pidfile, denied_permissions).unwrap();

        let result = try_acquire_pid_lock();

        std::fs::set_permissions(&pidfile, original_permissions).unwrap();
        assert!(matches!(
            result,
            Err(ref err) if err.kind() == io::ErrorKind::PermissionDenied
        ));
        assert_eq!(
            std::fs::read_to_string(&pidfile).unwrap(),
            "stale-but-private"
        );
        unsafe { std::env::remove_var(paths::ENV_DATA_DIR_OVERRIDE) };
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[cfg(unix)]
    #[test]
    fn pid_lock_rejects_symlinks_and_hard_links_without_clobbering_peers() {
        use std::os::unix::fs::symlink;

        let _g = ENV_LOCK.lock();
        let tmp = short_tmp_root().join(format!("acn-pid-link-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&tmp).unwrap();
        unsafe { std::env::set_var(paths::ENV_DATA_DIR_OVERRIDE, &tmp) };
        let pidfile = paths::pid_file_path().unwrap();
        let sentinel = tmp.join("sentinel");
        std::fs::write(&sentinel, "do-not-replace").unwrap();

        symlink(&sentinel, &pidfile).unwrap();
        assert_eq!(
            try_acquire_pid_lock().unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        assert_eq!(
            std::fs::read_to_string(&sentinel).unwrap(),
            "do-not-replace"
        );

        std::fs::remove_file(&pidfile).unwrap();
        std::fs::hard_link(&sentinel, &pidfile).unwrap();
        assert_eq!(
            try_acquire_pid_lock().unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        assert_eq!(
            std::fs::read_to_string(&sentinel).unwrap(),
            "do-not-replace"
        );

        unsafe { std::env::remove_var(paths::ENV_DATA_DIR_OVERRIDE) };
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
