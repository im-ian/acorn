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
use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use interprocess::local_socket::{
    traits::Stream as _StreamConnect, GenericFilePath, ListenerOptions, Name, ToFsName,
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
#[cfg(unix)]
fn bind_one(path: &Path) -> io::Result<interprocess::local_socket::Listener> {
    if path.exists() {
        let _ = std::fs::remove_file(path);
    }
    // Keep the default `.sock` staging names shorter than their canonical
    // names so ordinary data-directory paths retain their prior length bound.
    let staging_path = path.with_extension("tmp");
    if staging_path.exists() {
        let _ = std::fs::remove_file(&staging_path);
    }
    let name: Name<'_> = staging_path
        .as_os_str()
        .to_fs_name::<GenericFilePath>()
        .map_err(io::Error::other)?;
    // The socket is renamed below, so interprocess must not retain its
    // default drop guard for the staging pathname. Otherwise dropping the
    // listener could unlink an unrelated file later created at that name.
    let listener = ListenerOptions::new()
        .name(name)
        .reclaim_name(false)
        .create_sync()?;
    if let Err(err) =
        std::fs::set_permissions(&staging_path, std::fs::Permissions::from_mode(0o600))
    {
        drop(listener);
        let _ = std::fs::remove_file(&staging_path);
        return Err(err);
    }
    if let Err(err) = std::fs::rename(&staging_path, path) {
        drop(listener);
        let _ = std::fs::remove_file(&staging_path);
        return Err(err);
    }
    Ok(listener)
}

#[cfg(not(unix))]
fn bind_one(path: &Path) -> io::Result<interprocess::local_socket::Listener> {
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
        #[cfg(unix)]
        {
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
