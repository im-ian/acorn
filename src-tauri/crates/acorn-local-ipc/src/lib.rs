//! Shared local IPC transport for the Acorn app, daemon, and companion CLIs.
//!
//! Callers provide a platform endpoint as a `Path`: a filesystem pathname on
//! Unix or a `\\.\pipe\...` pathname on Windows. The wire protocols stay in
//! their owning crates; this leaf only owns bind/connect/cleanup semantics and
//! the platform security boundary. Windows listeners use an owner-only DACL,
//! and clients verify the connected server process has the same TokenUser SID
//! before any protocol bytes are exchanged.

use std::io::{self, Read};
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

/// Connect to a previously bound endpoint. On Windows, reject a named-pipe
/// server owned by another user even if it pre-bound the predictable name with
/// a permissive DACL.
pub fn connect(endpoint: &Path) -> io::Result<Stream> {
    let name = endpoint_name(endpoint)?;
    let stream = Stream::connect(name)?;
    #[cfg(windows)]
    verify_windows_server_owner(&stream)?;
    Ok(stream)
}

/// Return the kernel-reported process id on the other end of a connected
/// local stream. Callers use this to bind application capabilities to a PTY
/// process tree instead of trusting forgeable JSON identity fields alone.
pub fn peer_process_id(stream: &Stream) -> io::Result<u32> {
    peer_process_id_platform(stream)
}

#[cfg(target_os = "macos")]
fn peer_process_id_platform(stream: &Stream) -> io::Result<u32> {
    use nix::sys::socket::{getsockopt, sockopt::LocalPeerPid};

    let Stream::UdSocket(socket) = stream;
    let pid = getsockopt(socket, LocalPeerPid).map_err(io::Error::other)?;
    u32::try_from(pid)
        .ok()
        .filter(|pid| *pid > 0)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid peer process id"))
}

#[cfg(not(target_os = "macos"))]
fn peer_process_id_platform(stream: &Stream) -> io::Result<u32> {
    use interprocess::local_socket::traits::StreamCommon;

    stream
        .peer_creds()?
        .pid()
        .and_then(|pid| u32::try_from(pid).ok())
        .filter(|pid| *pid > 0)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::Unsupported,
                "platform did not expose the peer process id",
            )
        })
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

/// Read a nonblocking local stream without mistaking an empty Windows named
/// pipe for EOF. Unix transports already report this state as `WouldBlock`.
pub fn read_nonblocking(stream: &mut Stream, buffer: &mut [u8]) -> io::Result<usize> {
    #[cfg(windows)]
    {
        return match stream.read(buffer) {
            Ok(0) if !buffer.is_empty() && windows_named_pipe_connected(stream)? => {
                Err(io::Error::from(io::ErrorKind::WouldBlock))
            }
            Err(error) if error.raw_os_error() == Some(232) => {
                if windows_named_pipe_connected(stream)? {
                    Err(io::Error::from(io::ErrorKind::WouldBlock))
                } else {
                    Ok(0)
                }
            }
            result => result,
        };
    }
    #[cfg(not(windows))]
    {
        stream.read(buffer)
    }
}

pub struct NonblockingStreamReader<'a> {
    stream: &'a mut Stream,
}

impl<'a> NonblockingStreamReader<'a> {
    pub fn new(stream: &'a mut Stream) -> Self {
        Self { stream }
    }
}

impl Read for NonblockingStreamReader<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        read_nonblocking(self.stream, buffer)
    }
}

#[cfg(windows)]
fn windows_named_pipe_connected(stream: &Stream) -> io::Result<bool> {
    use std::os::windows::io::{AsHandle, AsRawHandle};
    use std::ptr;
    use windows_sys::Win32::Foundation::{
        ERROR_BROKEN_PIPE, ERROR_NO_DATA, ERROR_PIPE_NOT_CONNECTED,
    };
    use windows_sys::Win32::System::Pipes::PeekNamedPipe;

    const BROKEN_PIPE: i32 = ERROR_BROKEN_PIPE as i32;
    const NO_DATA: i32 = ERROR_NO_DATA as i32;
    const PIPE_NOT_CONNECTED: i32 = ERROR_PIPE_NOT_CONNECTED as i32;

    let Stream::NamedPipe(pipe) = stream;
    let mut available = 0_u32;
    let succeeded = unsafe {
        PeekNamedPipe(
            pipe.as_handle().as_raw_handle(),
            ptr::null_mut(),
            0,
            ptr::null_mut(),
            &mut available,
            ptr::null_mut(),
        )
    };
    if succeeded != 0 {
        return Ok(true);
    }
    let error = io::Error::last_os_error();
    if matches!(
        error.raw_os_error(),
        Some(BROKEN_PIPE | NO_DATA | PIPE_NOT_CONNECTED)
    ) {
        Ok(false)
    } else {
        Err(error)
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
    let staging = endpoint.with_extension("tmp");
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

#[cfg(windows)]
fn verify_windows_server_owner(stream: &Stream) -> io::Result<()> {
    use interprocess::local_socket::traits::StreamCommon;

    let server_pid = stream.peer_creds()?.pid().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::PermissionDenied,
            "named-pipe server did not expose a process id",
        )
    })?;
    if process_runs_as_current_user(server_pid)? {
        return Ok(());
    }
    Err(io::Error::new(
        io::ErrorKind::PermissionDenied,
        format!("named-pipe server process {server_pid} belongs to another Windows user"),
    ))
}

#[cfg(windows)]
fn process_runs_as_current_user(process_id: u32) -> io::Result<bool> {
    use std::ptr;
    use windows_sys::Win32::Security::{EqualSid, IsValidSid};
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id) };
    let process = WinHandle::new(process)?;
    let process_token = open_process_token(process.raw())?;
    let current_token = open_process_token(unsafe { GetCurrentProcess() })?;
    let process_user = token_user(process_token.raw())?;
    let current_user = token_user(current_token.raw())?;
    let process_sid = process_user.sid();
    let current_sid = current_user.sid();
    if process_sid == ptr::null_mut()
        || current_sid == ptr::null_mut()
        || unsafe { IsValidSid(process_sid) } == 0
        || unsafe { IsValidSid(current_sid) } == 0
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Windows process token returned an invalid user SID",
        ));
    }
    Ok(unsafe { EqualSid(process_sid, current_sid) } != 0)
}

#[cfg(windows)]
struct WinHandle(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl WinHandle {
    fn new(handle: windows_sys::Win32::Foundation::HANDLE) -> io::Result<Self> {
        if handle.is_null() {
            Err(io::Error::last_os_error())
        } else {
            Ok(Self(handle))
        }
    }

    fn raw(&self) -> windows_sys::Win32::Foundation::HANDLE {
        self.0
    }
}

#[cfg(windows)]
impl Drop for WinHandle {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

#[cfg(windows)]
fn open_process_token(process: windows_sys::Win32::Foundation::HANDLE) -> io::Result<WinHandle> {
    use windows_sys::Win32::Security::TOKEN_QUERY;
    use windows_sys::Win32::System::Threading::OpenProcessToken;

    let mut token = std::ptr::null_mut();
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    WinHandle::new(token)
}

#[cfg(windows)]
struct TokenUserBuffer(Vec<usize>);

#[cfg(windows)]
impl TokenUserBuffer {
    fn sid(&self) -> windows_sys::Win32::Security::PSID {
        let user = self
            .0
            .as_ptr()
            .cast::<windows_sys::Win32::Security::TOKEN_USER>();
        unsafe { (*user).User.Sid }
    }
}

#[cfg(windows)]
fn token_user(token: windows_sys::Win32::Foundation::HANDLE) -> io::Result<TokenUserBuffer> {
    use windows_sys::Win32::Foundation::ERROR_INSUFFICIENT_BUFFER;
    use windows_sys::Win32::Security::{GetTokenInformation, TokenUser};

    let mut required = 0;
    if unsafe { GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut required) } != 0
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Windows token user query unexpectedly returned no data",
        ));
    }
    let query_error = io::Error::last_os_error();
    if query_error.raw_os_error() != Some(ERROR_INSUFFICIENT_BUFFER as i32) || required == 0 {
        return Err(query_error);
    }
    if (required as usize) < std::mem::size_of::<windows_sys::Win32::Security::TOKEN_USER>() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Windows token user query returned a truncated buffer size",
        ));
    }

    let word_size = std::mem::size_of::<usize>();
    let word_count = (required as usize).div_ceil(word_size);
    let mut buffer = vec![0usize; word_count];
    if unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            required,
            &mut required,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(TokenUserBuffer(buffer))
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

    #[cfg(target_os = "macos")]
    #[test]
    fn private_endpoint_binds_near_sun_path_limit() {
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::PermissionsExt;

        // Darwin's sun_path holds 104 bytes. Keep the canonical endpoint
        // valid near that boundary so any staging name longer than the
        // canonical socket breaks this test.
        const DATA_DIR_BYTES: usize = 79;
        let unique = format!(
            "acorn-ipc-limit-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let padding = DATA_DIR_BYTES
            .checked_sub("/tmp/".len() + unique.len())
            .expect("unique test directory should fit below the target length");
        let scratch =
            std::path::PathBuf::from("/tmp").join(format!("{unique}{}", "x".repeat(padding)));
        std::fs::create_dir_all(&scratch).unwrap();

        let endpoint = scratch.join("daemon-stream.sock");
        assert_eq!(endpoint.as_os_str().as_bytes().len(), 98);
        assert_eq!(
            endpoint.with_extension("tmp").as_os_str().as_bytes().len(),
            97
        );

        let listener = bind(&endpoint).expect("bind near macOS sun_path limit");
        assert_eq!(
            std::fs::metadata(&endpoint).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(!endpoint.with_extension("tmp").exists());

        drop(listener);
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
    fn fully_nonblocking_named_pipe_supports_a_delayed_round_trip() {
        let endpoint = unique_pipe("nonblocking");
        let listener = bind(&endpoint).expect("bind named pipe");
        listener
            .set_nonblocking(ListenerNonblockingMode::Both)
            .expect("set listener and accepted streams nonblocking");
        let (connected_tx, connected_rx) = std::sync::mpsc::channel();
        let (write_tx, write_rx) = std::sync::mpsc::channel();
        let client = std::thread::spawn({
            let endpoint = endpoint.clone();
            move || {
                let mut stream = connect(&endpoint).expect("connect named pipe");
                connected_tx.send(()).unwrap();
                write_rx.recv().unwrap();
                stream.write_all(b"ping").unwrap();
                let mut reply = [0; 4];
                stream.read_exact(&mut reply).unwrap();
                assert_eq!(&reply, b"pong");
            }
        });

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut server = loop {
            match listener.accept() {
                Ok(stream) => break stream,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "named-pipe listener did not accept before timeout"
                    );
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Err(error) => panic!("nonblocking named-pipe accept failed: {error}"),
            }
        };
        connected_rx.recv().unwrap();
        let pending = read_nonblocking(&mut server, &mut [0; 1])
            .expect_err("empty nonblocking named-pipe read must be pending");
        assert_eq!(pending.kind(), io::ErrorKind::WouldBlock);
        write_tx.send(()).unwrap();
        let mut bytes = [0; 4];
        let mut offset = 0;
        while offset < bytes.len() {
            match read_nonblocking(&mut server, &mut bytes[offset..]) {
                Ok(0) => panic!("named-pipe client closed before sending the test payload"),
                Ok(read) => offset += read,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "accepted named-pipe stream did not receive before timeout"
                    );
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Err(error) => panic!("accepted named-pipe stream read failed: {error}"),
            }
        }
        assert_eq!(&bytes, b"ping");
        server.write_all(b"pong").unwrap();
        client.join().unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn current_process_matches_its_windows_user() {
        assert!(process_runs_as_current_user(std::process::id()).unwrap());
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
