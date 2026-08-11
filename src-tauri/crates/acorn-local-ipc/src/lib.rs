//! Shared local IPC transport for the Acorn app, daemon, and companion CLIs.
//!
//! Callers provide a platform endpoint as a `Path`: a filesystem pathname on
//! Unix or a `\\.\pipe\...` pathname on Windows. The wire protocols stay in
//! their owning crates; this leaf only owns bind/connect/cleanup semantics and
//! the platform security boundary.

use std::io;
use std::path::Path;

use interprocess::local_socket::{GenericFilePath, ListenerOptions, Name, ToFsName};

pub use interprocess::local_socket::traits::{Listener as ListenerTrait, Stream as StreamTrait};
pub use interprocess::local_socket::{Listener, ListenerNonblockingMode, Stream};
pub use interprocess::TryClone;

/// Bind a private local endpoint.
///
/// Unix binds at a staging pathname, applies owner-only permissions, and then
/// atomically publishes the canonical pathname. Windows uses a named pipe with
/// a protected DACL: only LocalSystem and the pipe owner can connect.
pub fn bind(endpoint: &Path) -> io::Result<Listener> {
    bind_platform(endpoint)
}

/// Connect to a previously bound endpoint.
pub fn connect(endpoint: &Path) -> io::Result<Stream> {
    let name = endpoint_name(endpoint)?;
    Stream::connect(name)
}

/// Remove filesystem-backed endpoint state after a graceful shutdown.
/// Named pipes disappear when their last listener handle closes.
pub fn cleanup(endpoint: &Path) {
    #[cfg(unix)]
    {
        let _ = std::fs::remove_file(endpoint);
    }
    #[cfg(not(unix))]
    let _ = endpoint;
}

/// Whether an endpoint has a persistent filesystem marker.
///
/// Windows named pipes have no meaningful `Path::exists` equivalent, so
/// reachability must be established by calling [`connect`].
pub fn marker_exists(endpoint: &Path) -> bool {
    #[cfg(unix)]
    {
        endpoint.exists()
    }
    #[cfg(not(unix))]
    {
        let _ = endpoint;
        false
    }
}

fn endpoint_name(endpoint: &Path) -> io::Result<Name<'_>> {
    endpoint
        .as_os_str()
        .to_fs_name::<GenericFilePath>()
        .map_err(io::Error::other)
}

#[cfg(unix)]
fn bind_platform(endpoint: &Path) -> io::Result<Listener> {
    use std::os::unix::fs::PermissionsExt;

    if let Some(parent) = endpoint.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if endpoint.exists() {
        let _ = std::fs::remove_file(endpoint);
    }

    // Keep the staging name deterministic and shorter than the canonical
    // socket. The listener's reclaim guard is disabled because the bound
    // pathname is renamed before the listener is dropped.
    let staging = endpoint.with_extension("ipc-staging");
    if staging.exists() {
        let _ = std::fs::remove_file(&staging);
    }
    let name = endpoint_name(&staging)?;
    let listener = ListenerOptions::new()
        .name(name)
        .reclaim_name(false)
        .create_sync()?;
    if let Err(err) = std::fs::set_permissions(&staging, std::fs::Permissions::from_mode(0o600)) {
        drop(listener);
        let _ = std::fs::remove_file(&staging);
        return Err(err);
    }
    if let Err(err) = std::fs::rename(&staging, endpoint) {
        drop(listener);
        let _ = std::fs::remove_file(&staging);
        return Err(err);
    }
    Ok(listener)
}

#[cfg(windows)]
fn bind_platform(endpoint: &Path) -> io::Result<Listener> {
    use interprocess::os::windows::local_socket::ListenerOptionsExt;
    use interprocess::os::windows::security_descriptor::SecurityDescriptor;
    use widestring::U16CString;

    // Protected DACL. `OW` is the Windows Owner Rights SID; the object
    // manager assigns the creator as owner when CreateNamedPipe creates the
    // endpoint. No Everyone/Authenticated Users ACE is inherited.
    const OWNER_ONLY_SDDL: &str = "D:P(A;;GA;;;SY)(A;;GA;;;OW)";
    let sddl = U16CString::from_str(OWNER_ONLY_SDDL)
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidInput, err.to_string()))?;
    let descriptor = SecurityDescriptor::deserialize(sddl.as_ucstr())?;
    let name = endpoint_name(endpoint)?;
    ListenerOptions::new()
        .name(name)
        .reclaim_name(false)
        .security_descriptor(descriptor)
        .create_sync()
}

#[cfg(not(any(unix, windows)))]
fn bind_platform(endpoint: &Path) -> io::Result<Listener> {
    let name = endpoint_name(endpoint)?;
    ListenerOptions::new().name(name).create_sync()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[cfg(unix)]
    #[test]
    fn private_endpoint_round_trip_and_cleanup() {
        use std::os::unix::fs::PermissionsExt;

        let scratch = tempfile_dir();
        let endpoint = scratch.join("roundtrip.sock");
        let listener = bind(&endpoint).expect("bind");
        assert_eq!(
            std::fs::metadata(&endpoint).unwrap().permissions().mode() & 0o777,
            0o600
        );

        let client = std::thread::spawn({
            let endpoint = endpoint.clone();
            move || {
                let mut stream = connect(&endpoint).expect("connect");
                stream.write_all(b"ping").unwrap();
            }
        });
        let mut server = listener.accept().expect("accept");
        let mut bytes = [0; 4];
        server.read_exact(&mut bytes).unwrap();
        assert_eq!(&bytes, b"ping");
        client.join().unwrap();

        drop((server, listener));
        cleanup(&endpoint);
        assert!(!endpoint.exists());
        let _ = std::fs::remove_dir_all(scratch);
    }

    #[cfg(unix)]
    fn tempfile_dir() -> std::path::PathBuf {
        // Keep below sockaddr_un's short pathname limit on macOS.
        let path = std::path::PathBuf::from("/tmp").join(format!(
            "acorn-local-ipc-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[cfg(windows)]
    fn unique_pipe(stem: &str) -> std::path::PathBuf {
        std::path::PathBuf::from(format!(
            r"\\.\pipe\acorn-local-ipc-test-{}-{}-{stem}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[cfg(windows)]
    #[test]
    fn private_named_pipe_round_trip() {
        let endpoint = unique_pipe("roundtrip");
        let listener = bind(&endpoint).expect("bind named pipe");
        let client = std::thread::spawn({
            let endpoint = endpoint.clone();
            move || {
                let mut stream = connect(&endpoint).expect("connect named pipe");
                stream.write_all(b"ping").unwrap();
            }
        });
        let mut server = listener.accept().expect("accept named pipe");
        let mut bytes = [0; 4];
        server.read_exact(&mut bytes).unwrap();
        assert_eq!(&bytes, b"ping");
        client.join().unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn duplicate_named_pipe_listener_is_rejected() {
        let endpoint = unique_pipe("singleton");
        let listener = bind(&endpoint).expect("first named-pipe bind");
        assert!(bind(&endpoint).is_err());
        drop(listener);
    }
}
