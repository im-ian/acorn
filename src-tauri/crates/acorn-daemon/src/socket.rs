//! Daemon endpoint ownership on top of Acorn's shared local IPC transport.
//!
//! * **Control socket** and **stream socket** are bound to two separate
//!   filesystem paths (Unix) / named pipes (Windows). Splitting them
//!   prevents head-of-line blocking — a multi-MB scrollback dump on the
//!   stream socket cannot starve a `ListSessions` RPC on the control
//!   socket.
//! * The shared transport binds private filesystem sockets on Unix and
//!   owner-only named pipes on Windows.
//! * Pre-bind cleanup of stale Unix socket files happens in the shared
//!   transport. The PID-file singleton check has already verified that no
//!   other daemon owns the endpoint.

use std::io;
use std::path::{Path, PathBuf};

/// Listener pair bound to the daemon's two canonical sockets. The fields
/// are `Option` so a future migration to a single-socket dev mode can
/// `None` out one side without changing the public surface.
pub struct DaemonListeners {
    pub control: acorn_local_ipc::Listener,
    pub stream: acorn_local_ipc::Listener,
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
            acorn_local_ipc::cleanup(&control_path);
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

/// Bind one canonical endpoint through the shared transport contract.
fn bind_one(path: &Path) -> io::Result<acorn_local_ipc::Listener> {
    acorn_local_ipc::bind(path)
}

/// Clean up socket files. Called on graceful shutdown. Non-fatal on
/// failure — endpoint cleanup is independent of the reusable PID lockfile.
pub fn cleanup_paths(control: &PathBuf, stream: &PathBuf) {
    acorn_local_ipc::cleanup(control);
    acorn_local_ipc::cleanup(stream);
}

/// Client-side: open the canonical control socket as a one-shot RPC
/// channel. Returns `Err(NotFound)` if the daemon is not running.
pub fn connect_control() -> io::Result<acorn_local_ipc::Stream> {
    let path = super::paths::control_socket_path()?;
    connect_one(&path)
}

/// Client-side: open the stream socket. Used by the app to attach to a
/// running session.
pub fn connect_stream() -> io::Result<acorn_local_ipc::Stream> {
    let path = super::paths::stream_socket_path()?;
    connect_one(&path)
}

fn connect_one(path: &PathBuf) -> io::Result<acorn_local_ipc::Stream> {
    acorn_local_ipc::connect(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_env::ENV_LOCK;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    /// macOS / Linux: `sockaddr_un::sun_path` is 104 bytes (mac) / 108
    /// (linux). The default `std::env::temp_dir()` on macOS resolves to
    /// `/var/folders/qb/.../T/` which leaves only ~20-30 chars for the
    /// suffix before we overflow. Unix `/tmp` keeps us comfortably under;
    /// Windows uses the account's writable temporary directory.
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
    fn bind_creates_and_cleanup_removes() {
        let _g = ENV_LOCK.lock();
        let tmp = short_tmp_root().join(format!("acn-sk-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&tmp).unwrap();
        unsafe { std::env::set_var(super::super::paths::ENV_DATA_DIR_OVERRIDE, &tmp) };

        let listeners = bind_both().unwrap();
        #[cfg(unix)]
        {
            assert!(listeners.control_path.exists());
            assert!(listeners.stream_path.exists());
            assert_eq!(
                std::fs::metadata(&listeners.control_path)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
            assert_eq!(
                std::fs::metadata(&listeners.stream_path)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }

        // The canonical path must be connectable. On Unix this also proves
        // that renaming the bound socket did not break daemon clients.
        // Connect to the paths returned by this bind rather than resolving
        // the process-wide test override again; other path tests mutate that
        // environment variable in parallel.
        let control_client =
            connect_one(&listeners.control_path).expect("control socket should accept connects");
        let stream_client =
            connect_one(&listeners.stream_path).expect("stream socket should accept connects");
        drop((control_client, stream_client));

        #[cfg(unix)]
        let staging_marker = {
            // interprocess normally unlinks the path it originally bound when
            // the listener drops. Since we rename that path, prove its reclaim
            // guard is disabled and cannot delete a later-created sibling.
            let marker = listeners.control_path.with_extension("tmp");
            std::fs::write(&marker, b"keep").unwrap();
            marker
        };

        // Drop listeners before cleanup so the OS releases the fd.
        let cp = listeners.control_path.clone();
        let sp = listeners.stream_path.clone();
        drop(listeners);
        #[cfg(unix)]
        {
            assert_eq!(std::fs::read(&staging_marker).unwrap(), b"keep");
            std::fs::remove_file(&staging_marker).unwrap();
        }
        cleanup_paths(&cp, &sp);
        assert!(!cp.exists());
        assert!(!sp.exists());

        unsafe { std::env::remove_var(super::super::paths::ENV_DATA_DIR_OVERRIDE) };
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn bind_reclaims_stale_socket_file() {
        let _g = ENV_LOCK.lock();
        let tmp = short_tmp_root().join(format!("acn-stale-{}", uuid::Uuid::new_v4().simple()));
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
