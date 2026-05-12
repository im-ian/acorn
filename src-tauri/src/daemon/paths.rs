//! Filesystem paths used by the daemon and its CLI mode. Single source so
//! daemon, app, and `acornd` CLI clients all derive the same locations
//! without each rolling its own `directories::ProjectDirs` call.
//!
//! macOS layout (production):
//!
//! ```text
//! ~/Library/Application Support/io.im-ian.acorn/
//! ├── sessions.json           (app-owned, untouched by the daemon)
//! ├── projects.json           (app-owned)
//! ├── ipc.sock                (in-process IPC socket for the legacy CLI)
//! ├── daemon.sock             (daemon control socket)
//! ├── daemon-stream.sock      (daemon stream socket — split from control to
//! │                            avoid head-of-line blocking under burst load)
//! ├── daemon.pid              (lockfile; presence implies daemon claim)
//! ├── daemon.log              (current log; rotated to .1 / .2 on size)
//! ├── daemon.log.1
//! ├── daemon.log.2
//! ├── daemon-sessions.json    (daemon-side minimal session metadata)
//! └── crashes/
//!     └── <utc-timestamp>.log (panic / abnormal-exit captures)
//! ```
//!
//! Test override: every helper consults `ACORN_DATA_DIR` first. Set this in
//! tests to redirect every artifact into a `tempdir` without monkey-patching
//! `directories` globally.

use std::path::PathBuf;

use directories::ProjectDirs;

/// Override env var. When set and non-empty, every helper rebases off this
/// directory instead of `ProjectDirs`. Tests use this to isolate daemon
/// state to a tempdir; production never sets it.
pub const ENV_DATA_DIR_OVERRIDE: &str = "ACORN_DATA_DIR";

/// Override env var for the daemon control socket. Mirrors the existing
/// `ACORN_IPC_SOCKET` override pattern used by `crate::ipc::socket_path`
/// so the same E2E harness that points the legacy IPC at a tempdir can
/// also point the daemon at one.
pub const ENV_DAEMON_SOCKET_OVERRIDE: &str = "ACORN_DAEMON_SOCKET";

/// Override env var for the stream socket. Independent override so a test
/// can isolate the daemon's two sockets to two different tempdirs without
/// colliding paths.
pub const ENV_DAEMON_STREAM_OVERRIDE: &str = "ACORN_DAEMON_STREAM_SOCKET";

/// Resolve the data directory, creating it on demand. Returns a `PathBuf`
/// rather than `&Path` because callers typically want to append to it
/// without re-rooting on each call.
pub fn data_dir() -> std::io::Result<PathBuf> {
    if let Ok(over) = std::env::var(ENV_DATA_DIR_OVERRIDE) {
        if !over.is_empty() {
            let p = PathBuf::from(over);
            std::fs::create_dir_all(&p)?;
            return Ok(p);
        }
    }
    let pd = ProjectDirs::from("io", "im-ian", "acorn").ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "could not resolve project data directory",
        )
    })?;
    let p = pd.data_dir().to_path_buf();
    std::fs::create_dir_all(&p)?;
    Ok(p)
}

/// Daemon control socket path. Honors `ACORN_DAEMON_SOCKET` override.
pub fn control_socket_path() -> std::io::Result<PathBuf> {
    if let Ok(over) = std::env::var(ENV_DAEMON_SOCKET_OVERRIDE) {
        if !over.is_empty() {
            return Ok(PathBuf::from(over));
        }
    }
    Ok(data_dir()?.join("daemon.sock"))
}

/// Daemon stream socket path. Honors `ACORN_DAEMON_STREAM_SOCKET` override.
pub fn stream_socket_path() -> std::io::Result<PathBuf> {
    if let Ok(over) = std::env::var(ENV_DAEMON_STREAM_OVERRIDE) {
        if !over.is_empty() {
            return Ok(PathBuf::from(over));
        }
    }
    Ok(data_dir()?.join("daemon-stream.sock"))
}

/// PID lockfile path. The daemon writes its PID here on startup and
/// inspects it on subsequent startups to detect a running peer.
pub fn pid_file_path() -> std::io::Result<PathBuf> {
    Ok(data_dir()?.join("daemon.pid"))
}

/// Current log file path. Older rotations live alongside as `.1`, `.2`.
pub fn log_file_path() -> std::io::Result<PathBuf> {
    Ok(data_dir()?.join("daemon.log"))
}

/// Daemon-side session metadata persistence path. Distinct from the
/// app's `sessions.json` so the two stores cannot accidentally clobber
/// each other. The app remains the rich source-of-truth; this file
/// only carries what the daemon needs to reconcile on next boot.
pub fn daemon_sessions_path() -> std::io::Result<PathBuf> {
    Ok(data_dir()?.join("daemon-sessions.json"))
}

/// Directory for crash dumps. Created on demand.
pub fn crash_dir() -> std::io::Result<PathBuf> {
    let d = data_dir()?.join("crashes");
    std::fs::create_dir_all(&d)?;
    Ok(d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use parking_lot::Mutex;

    // Serialize env mutation across tests in this module so concurrent
    // `cargo test` runs do not race on `ACORN_DATA_DIR`. parking_lot's
    // Mutex does not poison on panic, so a test that crashes holding
    // the lock does not cascade into the rest of the module.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// Pick a short root for test data dirs. macOS's default temp_dir()
    /// returns `/var/folders/qb/xxxxxxxx/T/` which already eats ~50 chars
    /// before our suffix; combined with `daemon-stream.sock` (18 chars)
    /// we'd overflow the 104-byte `sockaddr_un` cap on real socket
    /// binds. `/tmp` is always short and writable on macOS / Linux.
    fn short_tmp_root() -> PathBuf {
        PathBuf::from("/tmp")
    }

    #[test]
    fn override_redirects_data_dir() {
        let _g = ENV_LOCK.lock();
        let tmp = short_tmp_root().join(format!("acn-{}", uuid::Uuid::new_v4().simple()));
        // SAFETY: serialised against other env mutations in this module
        // via ENV_LOCK; outside processes are not affected.
        unsafe { std::env::set_var(ENV_DATA_DIR_OVERRIDE, &tmp) };
        let dd = data_dir().unwrap();
        assert_eq!(dd, tmp);
        assert!(tmp.exists());
        let sock = control_socket_path().unwrap();
        assert_eq!(sock.parent().unwrap(), tmp);
        unsafe { std::env::remove_var(ENV_DATA_DIR_OVERRIDE) };
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn socket_override_independent_of_data_dir() {
        let _g = ENV_LOCK.lock();
        let custom = short_tmp_root().join("acorn-custom.sock");
        // SAFETY: serialised via ENV_LOCK.
        unsafe { std::env::set_var(ENV_DAEMON_SOCKET_OVERRIDE, &custom) };
        let p = control_socket_path().unwrap();
        assert_eq!(p, custom);
        unsafe { std::env::remove_var(ENV_DAEMON_SOCKET_OVERRIDE) };
    }
}
