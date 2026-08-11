//! Process-tree ownership across Unix process groups and Windows Job Objects.

use std::io;
use std::process::{Child, Command};

/// Configure a native child as the root of a separately terminable tree.
pub fn configure_tree_root(command: &mut Command) {
    configure_tree_root_platform(command);
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
