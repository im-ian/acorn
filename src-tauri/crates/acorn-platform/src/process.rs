//! Process-tree ownership across Unix process groups and Windows Job Objects.

use std::io::{self, Read, Write};
use std::process::{Child, Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System};

/// Return whether `candidate_pid` is the same process as `root_pid` or a live
/// descendant of it. The candidate must come from kernel peer credentials;
/// a PID supplied inside a protocol message is not authentication evidence.
pub fn is_descendant_or_same(root_pid: u32, candidate_pid: u32) -> bool {
    if root_pid == 0 || candidate_pid == 0 {
        return false;
    }
    if root_pid == candidate_pid {
        return true;
    }
    let mut system = System::new_with_specifics(
        RefreshKind::nothing().with_processes(ProcessRefreshKind::nothing()),
    );
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    let root = Pid::from_u32(root_pid);
    let mut current = Pid::from_u32(candidate_pid);
    let mut visited = std::collections::HashSet::new();
    for _ in 0..128 {
        if current == root {
            return true;
        }
        if !visited.insert(current) {
            return false;
        }
        let Some(parent) = system.process(current).and_then(|process| process.parent()) else {
            return false;
        };
        current = parent;
    }
    false
}

/// Compare a live process's executable/name/argv[0] basename with an expected
/// binary name. This is an additional local-IPC identity signal, not a code
/// signature: writable unsigned binaries remain a documented residual risk.
pub fn pid_executable_name_matches(pid: u32, expected: &str) -> bool {
    if pid == 0 {
        return false;
    }
    let system = System::new_all();
    let Some(process) = system.process(Pid::from_u32(pid)) else {
        return false;
    };
    process
        .exe()
        .and_then(|path| path.to_str())
        .is_some_and(|value| crate::executable::executable_name_matches(value, expected))
        || process
            .name()
            .to_str()
            .is_some_and(|value| crate::executable::executable_name_matches(value, expected))
        || process.cmd().first().is_some_and(|value| {
            crate::executable::executable_name_matches(&value.to_string_lossy(), expected)
        })
}

/// Configure a native child as the root of a separately terminable tree.
pub fn configure_tree_root(command: &mut Command) {
    configure_tree_root_platform(command);
}

#[derive(Debug, Clone, Copy)]
pub struct BoundedOutputLimits {
    pub timeout: Duration,
    pub stdin_bytes: usize,
    pub stdout_bytes: usize,
    pub stderr_bytes: usize,
}

/// Run a child with bounded stdout/stderr capture, a wall-clock deadline, and
/// whole-tree termination. Reader threads drain pipes concurrently so a child
/// cannot deadlock the parent by filling one pipe while the other is read.
pub fn run_bounded(
    command: &mut Command,
    stdin: Option<&[u8]>,
    limits: BoundedOutputLimits,
) -> io::Result<Output> {
    if stdin.is_some_and(|bytes| bytes.len() > limits.stdin_bytes) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("child stdin exceeded its {} byte limit", limits.stdin_bytes),
        ));
    }
    command
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_tree_root(command);
    let mut child = command.spawn()?;
    let process_tree = match ProcessTree::from_std_child(&child) {
        Ok(tree) => tree,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };

    let Some(stdout) = child.stdout.take() else {
        let _ = process_tree.terminate();
        let _ = child.kill();
        let _ = child.wait();
        return Err(io::Error::other("bounded child stdout pipe is missing"));
    };
    let Some(stderr) = child.stderr.take() else {
        let _ = process_tree.terminate();
        let _ = child.kill();
        let _ = child.wait();
        return Err(io::Error::other("bounded child stderr pipe is missing"));
    };
    let stdout_overflow = Arc::new(AtomicBool::new(false));
    let stderr_overflow = Arc::new(AtomicBool::new(false));
    let stdout_reader = spawn_bounded_reader(stdout, limits.stdout_bytes, stdout_overflow.clone());
    let stderr_reader = spawn_bounded_reader(stderr, limits.stderr_bytes, stderr_overflow.clone());

    let stdin_writer = stdin.map(|bytes| {
        let mut pipe = child
            .stdin
            .take()
            .expect("stdin pipe requested for bounded child");
        let bytes = bytes.to_vec();
        std::thread::spawn(move || pipe.write_all(&bytes))
    });

    let deadline = Instant::now() + limits.timeout;
    let wait_result = loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                // A one-shot command must not leave descendants holding its
                // pipes open after the root exits. Closing the whole owned
                // tree also makes the reader joins below deadline-safe.
                let _ = process_tree.terminate();
                break Ok((status, None));
            }
            Err(error) => {
                let _ = process_tree.terminate();
                let _ = child.kill();
                let _ = child.wait();
                break Err(error);
            }
            Ok(None) => {}
        }
        let overflowed =
            stdout_overflow.load(Ordering::Acquire) || stderr_overflow.load(Ordering::Acquire);
        let timed_out = Instant::now() >= deadline;
        if overflowed || timed_out {
            let _ = process_tree.terminate();
            let _ = child.kill();
            let status = child.wait();
            let error = if overflowed {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!(
                        "child output exceeded limits (stdout {} bytes, stderr {} bytes)",
                        limits.stdout_bytes, limits.stderr_bytes
                    ),
                )
            } else {
                io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!("child exceeded its {:?} deadline", limits.timeout),
                )
            };
            break status.map(|status| (status, Some(error)));
        }
        std::thread::sleep(Duration::from_millis(5));
    };

    if let Some(writer) = stdin_writer {
        let _ = writer.join();
    }
    let stdout = stdout_reader
        .join()
        .map_err(|_| io::Error::other("bounded stdout reader panicked"))??;
    let stderr = stderr_reader
        .join()
        .map_err(|_| io::Error::other("bounded stderr reader panicked"))??;
    let (status, terminal_error) = wait_result?;
    if let Some(error) = terminal_error {
        return Err(error);
    }
    if stdout_overflow.load(Ordering::Acquire) || stderr_overflow.load(Ordering::Acquire) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "child output exceeded limits (stdout {} bytes, stderr {} bytes)",
                limits.stdout_bytes, limits.stderr_bytes
            ),
        ));
    }
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

fn spawn_bounded_reader<R>(
    mut reader: R,
    limit: usize,
    overflow: Arc<AtomicBool>,
) -> std::thread::JoinHandle<io::Result<Vec<u8>>>
where
    R: Read + Send + 'static,
{
    std::thread::spawn(move || {
        let mut output = Vec::with_capacity(limit.min(64 * 1024));
        let mut chunk = [0_u8; 16 * 1024];
        loop {
            let read = reader.read(&mut chunk)?;
            if read == 0 {
                break;
            }
            let remaining = limit.saturating_sub(output.len());
            let keep = remaining.min(read);
            output.extend_from_slice(&chunk[..keep]);
            if keep < read {
                overflow.store(true, Ordering::Release);
                break;
            }
        }
        Ok(output)
    })
}

/// A handle that can terminate a root process and its descendants.
#[derive(Debug)]
pub struct ProcessTree {
    inner: PlatformProcessTree,
}

impl ProcessTree {
    pub fn from_std_child(child: &Child) -> io::Result<Self> {
        from_std_child_platform(child).map(|inner| Self { inner })
    }

    pub fn from_portable_child(child: &dyn portable_pty::Child) -> io::Result<Self> {
        from_portable_child_platform(child).map(|inner| Self { inner })
    }

    pub fn terminate(&self) -> io::Result<()> {
        terminate_platform(&self.inner)
    }
}

#[cfg(unix)]
#[derive(Debug)]
struct PlatformProcessTree {
    process_group: nix::unistd::Pid,
}

#[cfg(unix)]
fn configure_tree_root_platform(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(unix)]
fn from_std_child_platform(child: &Child) -> io::Result<PlatformProcessTree> {
    process_group_from_pid(child.id())
}

#[cfg(unix)]
fn from_portable_child_platform(
    child: &dyn portable_pty::Child,
) -> io::Result<PlatformProcessTree> {
    let pid = child
        .process_id()
        .ok_or_else(|| io::Error::other("portable PTY child has no process id"))?;
    process_group_from_pid(pid)
}

#[cfg(unix)]
fn process_group_from_pid(pid: u32) -> io::Result<PlatformProcessTree> {
    let raw = i32::try_from(pid)
        .ok()
        .filter(|pid| *pid > 0)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid child process id"))?;
    Ok(PlatformProcessTree {
        process_group: nix::unistd::Pid::from_raw(raw),
    })
}

#[cfg(unix)]
fn terminate_platform(tree: &PlatformProcessTree) -> io::Result<()> {
    use nix::sys::signal::{kill, Signal};

    let group = nix::unistd::Pid::from_raw(-tree.process_group.as_raw());
    let term_result = kill(group, Signal::SIGTERM);
    std::thread::sleep(std::time::Duration::from_millis(50));
    let kill_result = kill(group, Signal::SIGKILL);
    match (term_result, kill_result) {
        (Err(nix::errno::Errno::ESRCH), Err(nix::errno::Errno::ESRCH)) => Ok(()),
        (_, Ok(()))
        | (Ok(()), Err(nix::errno::Errno::ESRCH))
        // Darwin reports EPERM when the group now contains only a zombie
        // owned by this parent. A successful group-wide SIGTERM immediately
        // beforehand proves every live member was signalable; the wait owner
        // will reap the zombie next.
        | (Ok(()), Err(nix::errno::Errno::EPERM)) => Ok(()),
        (_, Err(err)) => Err(io::Error::other(err.to_string())),
    }
}

#[cfg(windows)]
#[derive(Debug)]
struct PlatformProcessTree {
    job: std::os::windows::io::OwnedHandle,
}

#[cfg(windows)]
fn configure_tree_root_platform(_command: &mut Command) {}

#[cfg(windows)]
fn from_std_child_platform(child: &Child) -> io::Result<PlatformProcessTree> {
    use std::os::windows::io::AsRawHandle;
    create_and_assign_job(child.as_raw_handle())
}

#[cfg(windows)]
fn from_portable_child_platform(
    child: &dyn portable_pty::Child,
) -> io::Result<PlatformProcessTree> {
    let handle = child
        .as_raw_handle()
        .ok_or_else(|| io::Error::other("portable PTY child has no process handle"))?;
    create_and_assign_job(handle)
}

#[cfg(windows)]
fn create_and_assign_job(
    process: std::os::windows::io::RawHandle,
) -> io::Result<PlatformProcessTree> {
    use std::mem::size_of;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    let raw_job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if raw_job.is_null() {
        return Err(io::Error::last_os_error());
    }
    let job = unsafe { OwnedHandle::from_raw_handle(raw_job.cast()) };
    let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let configured = unsafe {
        SetInformationJobObject(
            job.as_raw_handle().cast(),
            JobObjectExtendedLimitInformation,
            (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    if configured == 0 {
        return Err(io::Error::last_os_error());
    }
    let assigned = unsafe { AssignProcessToJobObject(job.as_raw_handle().cast(), process.cast()) };
    if assigned == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(PlatformProcessTree { job })
}

#[cfg(windows)]
fn terminate_platform(tree: &PlatformProcessTree) -> io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::JobObjects::TerminateJobObject;

    let result = unsafe { TerminateJobObject(tree.job.as_raw_handle().cast(), 1) };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(any(unix, windows)))]
#[derive(Debug)]
struct PlatformProcessTree {
    pid: u32,
}

#[cfg(not(any(unix, windows)))]
fn configure_tree_root_platform(_command: &mut Command) {}

#[cfg(not(any(unix, windows)))]
fn from_std_child_platform(child: &Child) -> io::Result<PlatformProcessTree> {
    Ok(PlatformProcessTree { pid: child.id() })
}

#[cfg(not(any(unix, windows)))]
fn from_portable_child_platform(
    child: &dyn portable_pty::Child,
) -> io::Result<PlatformProcessTree> {
    child
        .process_id()
        .map(|pid| PlatformProcessTree { pid })
        .ok_or_else(|| io::Error::other("portable PTY child has no process id"))
}

#[cfg(not(any(unix, windows)))]
fn terminate_platform(_tree: &PlatformProcessTree) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "process-tree termination is unsupported on this platform",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    const ROLE_ENV: &str = "ACORN_PROCESS_TREE_TEST_ROLE";
    const DIRECTORY_ENV: &str = "ACORN_PROCESS_TREE_TEST_DIRECTORY";

    #[test]
    fn ancestry_accepts_same_process_and_rejects_invalid_ids() {
        let pid = std::process::id();
        assert!(is_descendant_or_same(pid, pid));
        assert!(!is_descendant_or_same(0, pid));
        assert!(!is_descendant_or_same(pid, 0));
    }

    #[cfg(unix)]
    #[test]
    fn bounded_runner_captures_output_and_rejects_overflow() {
        let limits = BoundedOutputLimits {
            timeout: Duration::from_secs(2),
            stdin_bytes: 16,
            stdout_bytes: 16,
            stderr_bytes: 16,
        };
        let output = run_bounded(
            Command::new("/bin/sh").args(["-c", "printf hello"]),
            None,
            limits,
        )
        .unwrap();
        assert_eq!(output.stdout, b"hello");

        let error = run_bounded(
            Command::new("/bin/sh").args(["-c", "printf 12345678901234567"]),
            None,
            limits,
        )
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);

        let error = run_bounded(
            Command::new("/bin/sh").args(["-c", "cat"]),
            Some(b"12345678901234567"),
            limits,
        )
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);

        let started = Instant::now();
        let output = run_bounded(
            Command::new("/bin/sh").args(["-c", "(sleep 30) & printf done"]),
            None,
            limits,
        )
        .unwrap();
        assert_eq!(output.stdout, b"done");
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn process_tree_helper() {
        let Ok(role) = std::env::var(ROLE_ENV) else {
            return;
        };
        let directory = std::path::PathBuf::from(
            std::env::var_os(DIRECTORY_ENV).expect("helper directory environment"),
        );
        if role == "grandchild" {
            std::thread::sleep(Duration::from_secs(30));
            return;
        }

        assert_eq!(role, "child");
        let go = directory.join("go");
        let deadline = Instant::now() + Duration::from_secs(10);
        while !go.exists() {
            assert!(Instant::now() < deadline, "parent never released helper");
            std::thread::sleep(Duration::from_millis(10));
        }

        let mut grandchild = Command::new(std::env::current_exe().unwrap());
        grandchild
            .args([
                "--exact",
                "process::tests::process_tree_helper",
                "--nocapture",
            ])
            .env(ROLE_ENV, "grandchild")
            .env(DIRECTORY_ENV, &directory);
        let grandchild = grandchild.spawn().expect("spawn grandchild helper");
        std::fs::write(
            directory.join("grandchild.pid"),
            grandchild.id().to_string(),
        )
        .unwrap();
        std::mem::forget(grandchild);
        std::thread::sleep(Duration::from_secs(30));
    }

    #[test]
    fn terminates_a_child_and_its_descendant() {
        let directory = tempfile::tempdir().unwrap();
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "process::tests::process_tree_helper",
                "--nocapture",
            ])
            .env(ROLE_ENV, "child")
            .env(DIRECTORY_ENV, directory.path());
        configure_tree_root(&mut command);
        let mut child = command.spawn().expect("spawn process-tree helper");
        let tree = ProcessTree::from_std_child(&child).expect("track helper process tree");

        std::fs::write(directory.path().join("go"), b"go").unwrap();
        let pid_path = directory.path().join("grandchild.pid");
        let deadline = Instant::now() + Duration::from_secs(10);
        while !pid_path.exists() {
            assert!(
                Instant::now() < deadline,
                "helper did not publish grandchild pid"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        let grandchild_pid = std::fs::read_to_string(pid_path)
            .unwrap()
            .trim()
            .parse::<u32>()
            .unwrap();
        assert!(pid_is_alive(grandchild_pid));

        tree.terminate().expect("terminate process tree");
        let deadline = Instant::now() + Duration::from_secs(10);
        while child.try_wait().unwrap().is_none() || pid_is_alive(grandchild_pid) {
            assert!(Instant::now() < deadline, "process tree did not terminate");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[cfg(unix)]
    fn pid_is_alive(pid: u32) -> bool {
        let Ok(pid) = i32::try_from(pid) else {
            return false;
        };
        nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None).is_ok()
    }

    #[cfg(windows)]
    fn pid_is_alive(pid: u32) -> bool {
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        use windows_sys::Win32::Foundation::WAIT_TIMEOUT;
        use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject};

        const SYNCHRONIZE_ACCESS: u32 = 0x0010_0000;

        let raw = unsafe { OpenProcess(SYNCHRONIZE_ACCESS, 0, pid) };
        if raw.is_null() {
            return false;
        }
        let handle = unsafe { OwnedHandle::from_raw_handle(raw.cast()) };
        (unsafe { WaitForSingleObject(handle.as_raw_handle().cast(), 0) }) == WAIT_TIMEOUT
    }

    #[cfg(not(any(unix, windows)))]
    fn pid_is_alive(_pid: u32) -> bool {
        false
    }
}
