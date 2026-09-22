//! Spawn a command on an already-opened PTY.

use std::io;

use portable_pty::{Child, CommandBuilder, MasterPty, SlavePty};

/// Spawn `cmd` on `slave`, using `master` only for the slave TTY path on macOS.
///
/// macOS TCC attributes Screen Recording and similar prompts to the responsible
/// process of the capturing binary. portable-pty uses `fork`/`exec` with
/// `pre_exec`, so a session child keeps Acorn (or `acornd`) as that responsible
/// process. Granting the prompt then stores a decision for Acorn while
/// ScreenCaptureKit still checks the child, so the dialog repeats. `posix_spawn`
/// with `responsibility_spawnattrs_setdisclaim` starts a new responsibility
/// chain at the shell; later tools prompt and persist as themselves.
pub fn spawn_command(
    master: &dyn MasterPty,
    slave: &dyn SlavePty,
    cmd: CommandBuilder,
) -> io::Result<Box<dyn Child + Send + Sync>> {
    #[cfg(target_os = "macos")]
    {
        if let Some(tty) = master.tty_name() {
            return macos::spawn_disclaimed(&tty, &cmd);
        }
    }
    let _ = master;
    slave
        .spawn_command(cmd)
        .map_err(|err| io::Error::other(err.to_string()))
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use std::ffi::{CString, OsStr};
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;
    use std::ptr;

    use libc::{self, posix_spawn_file_actions_t, posix_spawnattr_t};
    use portable_pty::ExitStatus;

    const POSIX_SPAWN_SETSID: libc::c_int = 0x0400;

    unsafe extern "C" {
        fn responsibility_spawnattrs_setdisclaim(
            attr: *mut posix_spawnattr_t,
            disclaim: libc::c_int,
        ) -> libc::c_int;
        fn posix_spawn_file_actions_addchdir_np(
            actions: *mut posix_spawn_file_actions_t,
            path: *const libc::c_char,
        ) -> libc::c_int;
    }

    pub(super) fn spawn_disclaimed(
        tty: &Path,
        cmd: &CommandBuilder,
    ) -> io::Result<Box<dyn Child + Send + Sync>> {
        let (exe, argv) = resolve_argv(cmd)?;
        let envp = env_pairs(cmd)?;
        let tty_c = cstring_os(tty.as_os_str())?;
        let cwd_c = match cmd.get_cwd() {
            Some(cwd) => Some(cstring_os(cwd)?),
            None => None,
        };

        let argv_ptrs = null_terminated_ptrs(&argv);
        let env_ptrs = null_terminated_ptrs(&envp);

        let mut pid: libc::pid_t = 0;
        let mut attr = SpawnAttr::new()?;
        let mut actions = FileActions::new()?;
        attr.set_disclaimed_session()?;
        if let Some(cwd) = cwd_c.as_ref() {
            actions.add_chdir(cwd)?;
        }
        actions.bind_controlling_tty(&tty_c)?;

        let rc = unsafe {
            libc::posix_spawn(
                &mut pid,
                exe.as_ptr(),
                &actions.0,
                &attr.0,
                argv_ptrs.as_ptr(),
                env_ptrs.as_ptr(),
            )
        };
        if rc != 0 {
            return Err(io::Error::from_raw_os_error(rc));
        }
        if pid <= 0 {
            return Err(io::Error::other("posix_spawn returned a non-positive pid"));
        }
        Ok(Box::new(DisclaimedChild { pid: pid as u32 }))
    }

    fn resolve_argv(cmd: &CommandBuilder) -> io::Result<(CString, Vec<CString>)> {
        let argv = cmd.get_argv();
        let program = argv
            .first()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "pty command is empty"))?;
        let resolved = resolve_program(program, cmd.get_cwd(), cmd.get_env("PATH"))?;
        let exe = cstring_os(resolved.as_os_str())?;
        let args = argv
            .iter()
            .map(|arg| cstring_os(arg))
            .collect::<io::Result<Vec<_>>>()?;
        Ok((exe, args))
    }

    fn resolve_program(
        program: &OsStr,
        cwd: Option<&std::ffi::OsString>,
        path_var: Option<&OsStr>,
    ) -> io::Result<std::path::PathBuf> {
        let path = Path::new(program);
        if path.is_absolute() {
            return Ok(path.to_path_buf());
        }
        if path
            .parent()
            .is_some_and(|parent| !parent.as_os_str().is_empty())
        {
            let base = match cwd {
                Some(cwd) => std::path::PathBuf::from(cwd),
                None => std::env::current_dir()?,
            };
            return Ok(base.join(path));
        }
        let path_var = path_var.ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                format!("unable to resolve {program:?} because PATH is unset"),
            )
        })?;
        for dir in std::env::split_paths(path_var) {
            let candidate = dir.join(program);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
        Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("unable to resolve {program:?} on PATH"),
        ))
    }

    fn env_pairs(cmd: &CommandBuilder) -> io::Result<Vec<CString>> {
        cmd.iter_full_env_as_str()
            .map(|(key, value)| {
                CString::new(format!("{key}={value}")).map_err(|_| {
                    io::Error::new(
                        io::ErrorKind::InvalidInput,
                        format!("environment {key} contains an interior NUL"),
                    )
                })
            })
            .collect()
    }

    fn cstring_os(value: &OsStr) -> io::Result<CString> {
        CString::new(value.as_bytes()).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "spawn argument contains an interior NUL",
            )
        })
    }

    fn null_terminated_ptrs(entries: &[CString]) -> Vec<*mut libc::c_char> {
        let mut ptrs: Vec<*mut libc::c_char> = entries
            .iter()
            .map(|entry| entry.as_ptr() as *mut libc::c_char)
            .collect();
        ptrs.push(ptr::null_mut());
        ptrs
    }

    struct SpawnAttr(posix_spawnattr_t);

    impl SpawnAttr {
        fn new() -> io::Result<Self> {
            let mut attr = unsafe { std::mem::zeroed() };
            spawn_rc(unsafe { libc::posix_spawnattr_init(&mut attr) })?;
            Ok(Self(attr))
        }

        fn set_disclaimed_session(&mut self) -> io::Result<()> {
            let mut mask = unsafe { std::mem::zeroed() };
            let mut default_set = unsafe { std::mem::zeroed() };
            unsafe {
                libc::sigemptyset(&mut mask);
                libc::sigemptyset(&mut default_set);
                for signo in [
                    libc::SIGCHLD,
                    libc::SIGHUP,
                    libc::SIGINT,
                    libc::SIGQUIT,
                    libc::SIGTERM,
                    libc::SIGALRM,
                ] {
                    libc::sigaddset(&mut default_set, signo);
                }
            }
            spawn_rc(unsafe { libc::posix_spawnattr_setsigmask(&mut self.0, &mask) })?;
            spawn_rc(unsafe { libc::posix_spawnattr_setsigdefault(&mut self.0, &default_set) })?;
            spawn_rc(unsafe {
                libc::posix_spawnattr_setflags(
                    &mut self.0,
                    (libc::POSIX_SPAWN_CLOEXEC_DEFAULT
                        | libc::POSIX_SPAWN_SETSIGDEF
                        | libc::POSIX_SPAWN_SETSIGMASK
                        | POSIX_SPAWN_SETSID) as libc::c_short,
                )
            })?;
            spawn_rc(unsafe { responsibility_spawnattrs_setdisclaim(&mut self.0, 1) })
        }
    }

    impl Drop for SpawnAttr {
        fn drop(&mut self) {
            unsafe {
                libc::posix_spawnattr_destroy(&mut self.0);
            }
        }
    }

    struct FileActions(posix_spawn_file_actions_t);

    impl FileActions {
        fn new() -> io::Result<Self> {
            let mut actions = unsafe { std::mem::zeroed() };
            spawn_rc(unsafe { libc::posix_spawn_file_actions_init(&mut actions) })?;
            Ok(Self(actions))
        }

        fn add_chdir(&mut self, cwd: &CString) -> io::Result<()> {
            spawn_rc(unsafe { posix_spawn_file_actions_addchdir_np(&mut self.0, cwd.as_ptr()) })
        }

        fn bind_controlling_tty(&mut self, tty: &CString) -> io::Result<()> {
            // posix_spawn cannot ioctl TIOCSCTTY; a session leader opening
            // the slave without O_NOCTTY is what makes this PTY controlling.
            spawn_rc(unsafe {
                libc::posix_spawn_file_actions_addopen(
                    &mut self.0,
                    0,
                    tty.as_ptr(),
                    libc::O_RDWR,
                    0,
                )
            })?;
            spawn_rc(unsafe { libc::posix_spawn_file_actions_adddup2(&mut self.0, 0, 1) })?;
            spawn_rc(unsafe { libc::posix_spawn_file_actions_adddup2(&mut self.0, 0, 2) })
        }
    }

    impl Drop for FileActions {
        fn drop(&mut self) {
            unsafe {
                libc::posix_spawn_file_actions_destroy(&mut self.0);
            }
        }
    }

    fn spawn_rc(rc: libc::c_int) -> io::Result<()> {
        if rc == 0 {
            Ok(())
        } else {
            Err(io::Error::from_raw_os_error(rc))
        }
    }

    #[derive(Debug)]
    struct DisclaimedChild {
        pid: u32,
    }

    impl DisclaimedChild {
        fn wait_status(
            &mut self,
            flags: Option<nix::sys::wait::WaitPidFlag>,
        ) -> io::Result<Option<ExitStatus>> {
            let pid = nix::unistd::Pid::from_raw(self.pid as i32);
            loop {
                match nix::sys::wait::waitpid(pid, flags) {
                    Ok(nix::sys::wait::WaitStatus::StillAlive) => return Ok(None),
                    Ok(status) => return Ok(Some(exit_status_from_wait(status))),
                    Err(nix::errno::Errno::EINTR) => continue,
                    Err(err) => return Err(io::Error::from_raw_os_error(err as i32)),
                }
            }
        }
    }

    impl Child for DisclaimedChild {
        fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
            self.wait_status(Some(nix::sys::wait::WaitPidFlag::WNOHANG))
        }

        fn wait(&mut self) -> io::Result<ExitStatus> {
            match self.wait_status(None)? {
                Some(status) => Ok(status),
                None => Err(io::Error::other(
                    "waitpid returned StillAlive without WNOHANG",
                )),
            }
        }

        fn process_id(&self) -> Option<u32> {
            Some(self.pid)
        }
    }

    impl portable_pty::ChildKiller for DisclaimedChild {
        fn kill(&mut self) -> io::Result<()> {
            PidKiller { pid: self.pid }.kill()
        }

        fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
            Box::new(PidKiller { pid: self.pid })
        }
    }

    #[derive(Debug, Clone)]
    struct PidKiller {
        pid: u32,
    }

    impl portable_pty::ChildKiller for PidKiller {
        fn kill(&mut self) -> io::Result<()> {
            let pid = nix::unistd::Pid::from_raw(self.pid as i32);
            match nix::sys::signal::kill(pid, nix::sys::signal::Signal::SIGKILL) {
                Ok(()) | Err(nix::errno::Errno::ESRCH) => Ok(()),
                Err(err) => Err(io::Error::from_raw_os_error(err as i32)),
            }
        }

        fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
            Box::new(self.clone())
        }
    }

    fn exit_status_from_wait(status: nix::sys::wait::WaitStatus) -> ExitStatus {
        match status {
            nix::sys::wait::WaitStatus::Exited(_, code) => {
                ExitStatus::with_exit_code(code.max(0) as u32)
            }
            nix::sys::wait::WaitStatus::Signaled(_, signal, _) => {
                ExitStatus::with_signal(signal.as_str())
            }
            _ => ExitStatus::with_exit_code(1),
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    use portable_pty::{native_pty_system, PtySize};

    fn collect_output(mut reader: Box<dyn Read + Send>, needle: &str) -> String {
        let (tx, rx) = mpsc::channel();
        let wanted = needle.to_string();
        thread::spawn(move || {
            let mut buf = String::new();
            let mut bytes = [0u8; 1024];
            while let Ok(n) = reader.read(&mut bytes) {
                if n == 0 {
                    break;
                }
                buf.push_str(&String::from_utf8_lossy(&bytes[..n]));
                if buf.contains(&wanted) {
                    break;
                }
            }
            let _ = tx.send(buf);
        });
        rx.recv_timeout(Duration::from_secs(5))
            .expect("PTY child produced output")
    }

    #[test]
    fn spawned_pty_child_stdio_is_a_tty() {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.arg("-c");
        cmd.arg("if [ -t 0 ]; then printf IS_TTY; else printf NOT_A_TTY; fi");
        let mut child = spawn_command(&*pair.master, &*pair.slave, cmd).expect("spawn pty child");
        drop(pair.slave);
        let reader = pair.master.try_clone_reader().expect("clone reader");
        let output = collect_output(reader, "IS_TTY");
        let status = child.wait().expect("child wait");
        assert!(
            output.contains("IS_TTY") && !output.contains("NOT_A_TTY"),
            "child stdin should be a tty, got {output:?}"
        );
        assert!(status.success(), "child should exit 0, got {status:?}");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn spawned_pty_child_receives_sigint_from_master() {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.arg("-c");
        cmd.arg("trap 'printf GOTINT; exit 0' INT; while true; do sleep 1; done");
        let mut child = spawn_command(&*pair.master, &*pair.slave, cmd).expect("spawn pty child");
        drop(pair.slave);
        let reader = pair.master.try_clone_reader().expect("clone reader");
        thread::sleep(Duration::from_millis(200));
        let mut writer = pair.master.take_writer().expect("take writer");
        writer.write_all(&[0x03]).expect("write ETX");
        writer.flush().expect("flush ETX");
        let output = collect_output(reader, "GOTINT");
        let _ = child.wait();
        assert!(
            output.contains("GOTINT"),
            "controlling tty should deliver SIGINT, got {output:?}"
        );
    }
}
