//! Daemon process lifecycle primitives.
//!
//! Three concerns handled here:
//!
//! 1. **Kernel-backed singleton lock.** Only one daemon may bind the control
//!    socket at a time per user. `daemon.pid` is held under an exclusive OS
//!    file lock for the daemon's entire lifetime; the PID text is diagnostic,
//!    not the authority. A crash releases the kernel lock automatically.
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

use std::fs::{File, OpenOptions};
use std::io::{self, Read, Seek, Write};
use std::path::{Path, PathBuf};

use super::paths;

const MAX_PID_FILE_BYTES: u64 = 32;

/// Outcome of attempting to acquire the daemon singleton lock.
#[derive(Debug)]
pub enum PidLock {
    /// We hold the lock. The file now contains our PID.
    Acquired(PidLockGuard),
    /// Another daemon is already running. The diagnostic PID is unavailable
    /// on platforms such as Windows that deny reads through a second handle
    /// while the exclusive kernel lock is held.
    AlreadyHeld(Option<u32>),
}

#[derive(Debug)]
pub struct PidLockGuard {
    path: PathBuf,
    file: Option<File>,
}

impl PidLockGuard {
    pub fn path(&self) -> &Path {
        &self.path
    }

    fn release(&mut self) {
        let Some(mut file) = self.file.take() else {
            return;
        };
        // Clear the diagnostic PID while still holding the lock. Keep the
        // inode in place so release cannot race another process that already
        // opened it between unlink and recreation.
        let _ = file.set_len(0);
        let _ = file.flush();
        let _ = file.sync_all();
        let _ = fs2::FileExt::unlock(&file);
    }
}

impl Drop for PidLockGuard {
    fn drop(&mut self) {
        self.release();
    }
}

/// Attempt to acquire the singleton lock. Returns immediately — no
/// retry loop, since the caller (the daemon `serve` entrypoint) needs
/// to make a policy decision (refuse-to-start vs. wait-and-replace).
pub fn try_acquire_pid_lock() -> io::Result<PidLock> {
    let path = paths::pid_file_path()?;
    let mut file = open_pid_lock_file(&path)?;
    if let Err(error) = fs2::FileExt::try_lock_exclusive(&file) {
        if error.kind() == io::ErrorKind::WouldBlock {
            return Ok(PidLock::AlreadyHeld(read_pid_file_at(&path)?));
        }
        return Err(error);
    }
    let me = std::process::id();
    file.set_len(0)?;
    file.rewind()?;
    file.write_all(me.to_string().as_bytes())?;
    file.flush()?;
    file.sync_all()?;
    Ok(PidLock::Acquired(PidLockGuard {
        path,
        file: Some(file),
    }))
}

fn open_pid_lock_file(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(nix::libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.file_type().is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "daemon pid lock is not a regular file",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(file)
}

/// Read the daemon PID for status reporting. Invalid, oversized, symlinked,
/// and special files are treated as absent rather than read without a bound.
pub fn read_pid_file() -> io::Result<Option<u32>> {
    read_pid_file_at(&paths::pid_file_path()?)
}

fn read_pid_file_at(path: &Path) -> io::Result<Option<u32>> {
    let (mut file, opened) = match acorn_platform::fs::open_regular_nofollow(path) {
        Ok(opened) => opened,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) if error.kind() == io::ErrorKind::InvalidInput => return Ok(None),
        Err(error) if pid_file_read_blocked_by_lock(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    match read_pid_from_open_file(&mut file, opened.len()) {
        Ok(pid) => Ok(pid),
        Err(error) if pid_file_read_blocked_by_lock(&error) => Ok(None),
        Err(error) => Err(error),
    }
}

fn read_pid_from_open_file(file: &mut File, length: u64) -> io::Result<Option<u32>> {
    if length > MAX_PID_FILE_BYTES {
        return Ok(None);
    }
    file.rewind()?;
    let mut contents = Vec::with_capacity(length as usize);
    file.take(MAX_PID_FILE_BYTES + 1)
        .read_to_end(&mut contents)?;
    if contents.len() as u64 > MAX_PID_FILE_BYTES {
        return Ok(None);
    }
    Ok(std::str::from_utf8(&contents)
        .ok()
        .and_then(|value| value.trim().parse::<u32>().ok()))
}

#[cfg(windows)]
fn pid_file_read_blocked_by_lock(error: &io::Error) -> bool {
    // ERROR_SHARING_VIOLATION (32) may be returned while opening the file;
    // ERROR_LOCK_VIOLATION (33) is returned when a read overlaps the range
    // held by LockFileEx. Both mean the singleton lock is doing its job and
    // only the diagnostic PID is temporarily unavailable.
    matches!(error.raw_os_error(), Some(32 | 33))
}

#[cfg(not(windows))]
fn pid_file_read_blocked_by_lock(_error: &io::Error) -> bool {
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
            PidLock::Acquired(mut guard) => {
                assert!(guard.path().exists());
                let file = guard.file.as_mut().unwrap();
                let length = file.metadata().unwrap().len();
                assert_eq!(
                    read_pid_from_open_file(file, length).unwrap(),
                    Some(std::process::id())
                );
                drop(guard);
                assert!(paths::pid_file_path().unwrap().exists());
                assert_eq!(read_pid_file().unwrap(), None);
            }
            PidLock::AlreadyHeld(_) => panic!("expected acquire on fresh dir"),
        }
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
        let acquired = match try_acquire_pid_lock().unwrap() {
            PidLock::Acquired(guard) => guard,
            PidLock::AlreadyHeld(pid) => panic!("reclaim should have happened, got {pid:?}"),
        };
        drop(acquired);
        unsafe { std::env::remove_var(paths::ENV_DATA_DIR_OVERRIDE) };
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn pid_lock_reclaims_oversized_file_without_unbounded_read() {
        let _g = ENV_LOCK.lock();
        let tmp = short_tmp_root().join(format!("acn-pid-large-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&tmp).unwrap();
        unsafe { std::env::set_var(paths::ENV_DATA_DIR_OVERRIDE, &tmp) };
        let pidfile = paths::pid_file_path().unwrap();
        std::fs::File::create(&pidfile)
            .unwrap()
            .set_len(MAX_PID_FILE_BYTES + 1)
            .unwrap();

        let mut acquired = try_acquire_pid_lock().unwrap();
        let guard = match &mut acquired {
            PidLock::Acquired(guard) => guard,
            PidLock::AlreadyHeld(pid) => panic!("expected acquire, got holder {pid:?}"),
        };
        let file = guard.file.as_mut().unwrap();
        let length = file.metadata().unwrap().len();
        assert_eq!(
            read_pid_from_open_file(file, length).unwrap(),
            Some(std::process::id())
        );
        drop(acquired);

        unsafe { std::env::remove_var(paths::ENV_DATA_DIR_OVERRIDE) };
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[cfg(unix)]
    #[test]
    fn pid_lock_rejects_symlink_without_overwriting_its_target() {
        use std::os::unix::fs::symlink;

        let _g = ENV_LOCK.lock();
        let tmp = short_tmp_root().join(format!("acn-pid-link-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&tmp).unwrap();
        unsafe { std::env::set_var(paths::ENV_DATA_DIR_OVERRIDE, &tmp) };
        let sentinel = tmp.join("sentinel");
        std::fs::write(&sentinel, "do not overwrite").unwrap();
        let pidfile = paths::pid_file_path().unwrap();
        symlink(&sentinel, &pidfile).unwrap();

        let error = try_acquire_pid_lock().expect_err("symlinked lock must fail closed");
        assert!(matches!(
            error.raw_os_error(),
            Some(nix::libc::ELOOP) | Some(nix::libc::EMLINK)
        ));
        assert_eq!(
            std::fs::read_to_string(&sentinel).unwrap(),
            "do not overwrite"
        );
        assert!(std::fs::symlink_metadata(&pidfile)
            .unwrap()
            .file_type()
            .is_symlink());

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
        let acquired = match try_acquire_pid_lock().unwrap() {
            PidLock::Acquired(guard) => guard,
            PidLock::AlreadyHeld(pid) => {
                panic!("recycled PID should have been reclaimed, got {pid:?}")
            }
        };
        drop(acquired);
        unsafe { std::env::remove_var(paths::ENV_DATA_DIR_OVERRIDE) };
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn pid_lock_is_held_by_the_kernel_until_guard_drop() {
        let _g = ENV_LOCK.lock();
        let tmp = short_tmp_root().join(format!("acn-pid-held-{}", uuid::Uuid::new_v4().simple()));
        unsafe { std::env::set_var(paths::ENV_DATA_DIR_OVERRIDE, &tmp) };

        let first = match try_acquire_pid_lock().unwrap() {
            PidLock::Acquired(guard) => guard,
            PidLock::AlreadyHeld(pid) => panic!("unexpected lock holder {pid:?}"),
        };
        let observed_pid = match try_acquire_pid_lock().unwrap() {
            PidLock::AlreadyHeld(pid) => pid,
            PidLock::Acquired(_) => panic!("second acquire unexpectedly succeeded"),
        };
        #[cfg(unix)]
        assert_eq!(observed_pid, Some(std::process::id()));
        #[cfg(windows)]
        assert_eq!(observed_pid, None);
        drop(first);
        let second = try_acquire_pid_lock().unwrap();
        assert!(matches!(&second, PidLock::Acquired(_)));
        drop(second);

        unsafe { std::env::remove_var(paths::ENV_DATA_DIR_OVERRIDE) };
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
