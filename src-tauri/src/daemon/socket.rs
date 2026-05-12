//! Cross-platform local-socket abstraction wrapping the `interprocess` crate.
//!
//! * **Control socket** and **stream socket** are bound to two separate
//!   filesystem paths (Unix) / named pipes (Windows). Splitting them
//!   prevents head-of-line blocking — a multi-MB scrollback dump on the
//!   stream socket cannot starve a `ListSessions` RPC on the control
//!   socket.
//! * **`interprocess`** crate is used so the same code path works on
//!   macOS (`AF_UNIX`) and Windows (named pipes). The current build
//!   targets macOS, but `interprocess` keeps the Windows path one
//!   `cfg!()` away rather than a rewrite.
//! * Pre-bind cleanup: stale socket files left behind by an abnormal
//!   exit are removed before `bind()`. The PID-file singleton check has
//!   already verified that no other daemon owns the path.

use std::io;
use std::path::PathBuf;

use interprocess::local_socket::{
    GenericFilePath, ListenerOptions, Name, ToFsName,
    traits::Stream as _StreamConnect,
};

/// Listener pair bound to the daemon's two canonical sockets. The fields
/// are `Option` so a future migration to a single-socket dev mode can
/// `None` out one side without changing the public surface.
pub struct DaemonListeners {
    pub control: interprocess::local_socket::Listener,
    pub stream: interprocess::local_socket::Listener,
    pub control_path: PathBuf,
    pub stream_path: PathBuf,
}

/// Bind both sockets. On `Err`, neither listener is created (cleanup
/// happens locally before propagation). The caller is expected to have
/// already acquired the PID lock via `lifecycle::try_acquire_pid_lock`
/// so this routine does not negotiate ownership.
pub fn bind_both() -> io::Result<DaemonListeners> {
    let control_path = super::paths::control_socket_path()?;
    let stream_path = super::paths::stream_socket_path()?;
    let control = bind_one(&control_path)?;
    let stream = match bind_one(&stream_path) {
        Ok(l) => l,
        Err(e) => {
            // First listener bound, second failed: drop the first one's
            // file before returning so a retry sees clean state.
            drop(control);
            let _ = std::fs::remove_file(&control_path);
            return Err(e);
        }
    };
    Ok(DaemonListeners {
        control,
        stream,
        control_path,
        stream_path,
    })
}

/// Bind a single local socket at `path`. Removes any pre-existing file so
/// a stale socket from a previous crash does not block startup.
fn bind_one(path: &PathBuf) -> io::Result<interprocess::local_socket::Listener> {
    if path.exists() {
        let _ = std::fs::remove_file(path);
    }
    let name: Name<'_> = path
        .as_os_str()
        .to_fs_name::<GenericFilePath>()
        .map_err(io::Error::other)?;
    ListenerOptions::new().name(name).create_sync()
}

/// Clean up socket files. Called on graceful shutdown. Non-fatal on
/// failure — best-effort symmetric with `release_pid_lock`.
pub fn cleanup_paths(control: &PathBuf, stream: &PathBuf) {
    let _ = std::fs::remove_file(control);
    let _ = std::fs::remove_file(stream);
}

/// Client-side: open the canonical control socket as a one-shot RPC
/// channel. Returns `Err(NotFound)` if the daemon is not running.
pub fn connect_control() -> io::Result<interprocess::local_socket::Stream> {
    let path = super::paths::control_socket_path()?;
    connect_one(&path)
}

/// Client-side: open the stream socket. Used by the app to attach to a
/// running session.
pub fn connect_stream() -> io::Result<interprocess::local_socket::Stream> {
    let path = super::paths::stream_socket_path()?;
    connect_one(&path)
}

fn connect_one(path: &PathBuf) -> io::Result<interprocess::local_socket::Stream> {
    let name: Name<'_> = path
        .as_os_str()
        .to_fs_name::<GenericFilePath>()
        .map_err(io::Error::other)?;
    interprocess::local_socket::Stream::connect(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use parking_lot::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// macOS / Linux: `sockaddr_un::sun_path` is 104 bytes (mac) / 108
    /// (linux). The default `std::env::temp_dir()` on macOS resolves to
    /// `/var/folders/qb/.../T/` which leaves only ~20-30 chars for the
    /// suffix before we overflow. `/tmp` keeps us comfortably under.
    fn short_tmp_root() -> PathBuf {
        PathBuf::from("/tmp")
    }

    #[test]
    fn bind_creates_and_cleanup_removes() {
        let _g = ENV_LOCK.lock();
        let tmp = short_tmp_root().join(format!("acn-sk-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&tmp).unwrap();
        unsafe { std::env::set_var(super::super::paths::ENV_DATA_DIR_OVERRIDE, &tmp) };

        let listeners = bind_both().unwrap();
        assert!(listeners.control_path.exists());
        assert!(listeners.stream_path.exists());

        // Drop listeners before cleanup so the OS releases the fd.
        let cp = listeners.control_path.clone();
        let sp = listeners.stream_path.clone();
        drop(listeners);
        cleanup_paths(&cp, &sp);
        assert!(!cp.exists());
        assert!(!sp.exists());

        unsafe { std::env::remove_var(super::super::paths::ENV_DATA_DIR_OVERRIDE) };
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn bind_reclaims_stale_socket_file() {
        let _g = ENV_LOCK.lock();
        let tmp =
            short_tmp_root().join(format!("acn-stale-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&tmp).unwrap();
        unsafe { std::env::set_var(super::super::paths::ENV_DATA_DIR_OVERRIDE, &tmp) };

        // Pre-create both socket-named files (as plain files — exact
        // shape doesn't matter to the reclaim logic).
        std::fs::write(tmp.join("daemon.sock"), b"stale").unwrap();
        std::fs::write(tmp.join("daemon-stream.sock"), b"stale").unwrap();

        let listeners = bind_both().expect("bind should reclaim stale files");
        let cp = listeners.control_path.clone();
        let sp = listeners.stream_path.clone();
        drop(listeners);
        cleanup_paths(&cp, &sp);

        unsafe { std::env::remove_var(super::super::paths::ENV_DATA_DIR_OVERRIDE) };
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
