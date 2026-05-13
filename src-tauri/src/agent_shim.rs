//! Per-session shell shims that let user-invoked agents (today: `claude`)
//! pick up Acorn's persistence tokens without the user installing
//! anything.
//!
//! Every Acorn PTY gets `ACORN_RESUME_TOKEN` injected into its env and
//! the shim directory prepended onto `PATH`. The shim binary itself is
//! a tiny POSIX shell script bundled with the app via `include_str!`,
//! materialised once per data dir at app start. The script (see
//! `shims/claude.sh`) strips its own directory from `PATH`, finds the
//! real `claude`, and forwards `--session-id $ACORN_RESUME_TOKEN` so
//! claude's JSONL conversation file remains reachable across Acorn
//! restarts.
//!
//! The token is owned by the app (persisted on `Session.agent_resume_token`),
//! so the same value reaches claude on every spawn — daemon-routed or
//! in-process — without the shim having to talk to either IPC.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

const SHIM_DIR_NAME: &str = "shims";
const CLAUDE_SHIM_NAME: &str = "claude";

const CLAUDE_SHIM_BODY: &str = include_str!("../shims/claude.sh");

/// Ensure the shim directory and its scripts exist under Acorn's data
/// dir, returning the directory PTYs should prepend to their `PATH`.
///
/// Idempotent: rewrites the script body on every call so a shipped
/// shim fix lands without bumping a data-dir version. The bodies are
/// small (a few hundred bytes) and PTY spawns are not hot enough for
/// the extra write to matter.
pub fn ensure_shim_dir() -> io::Result<PathBuf> {
    ensure_shim_dir_at(&crate::daemon::paths::data_dir()?)
}

/// Inner form that takes an explicit base directory. Split out so
/// tests can exercise materialisation without racing on the
/// `ACORN_DATA_DIR` env var (which is also consumed by daemon path
/// tests and would otherwise force test-thread serialisation).
fn ensure_shim_dir_at(base: &Path) -> io::Result<PathBuf> {
    let dir = base.join(SHIM_DIR_NAME);
    fs::create_dir_all(&dir)?;
    write_shim(&dir.join(CLAUDE_SHIM_NAME), CLAUDE_SHIM_BODY)?;
    Ok(dir)
}

#[cfg(unix)]
fn write_shim(path: &Path, body: &str) -> io::Result<()> {
    fs::write(path, body)?;
    let mut perms = fs::metadata(path)?.permissions();
    perms.set_mode(0o755);
    fs::set_permissions(path, perms)
}

#[cfg(not(unix))]
fn write_shim(_path: &Path, _body: &str) -> io::Result<()> {
    // Acorn ships macOS-only today; keep the function compilable on
    // Windows so unrelated cross-platform CI/tests don't break, but do
    // not pretend to materialise a working shim there.
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    /// Allocate a short-rooted scratch dir. `/tmp` (not `std::env::temp_dir()`)
    /// matches `daemon::paths::tests`' rationale and avoids macOS's overlong
    /// `/var/folders/...` prefix.
    struct ScratchDir(PathBuf);
    impl ScratchDir {
        fn new(tag: &str) -> Self {
            let p = PathBuf::from("/tmp").join(format!(
                "acn-shim-{tag}-{}",
                uuid::Uuid::new_v4().simple()
            ));
            fs::create_dir_all(&p).unwrap();
            Self(p)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for ScratchDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn ensure_shim_dir_creates_executable_claude_script() {
        let base = ScratchDir::new("exec");
        let dir = ensure_shim_dir_at(base.path()).unwrap();
        let claude = dir.join(CLAUDE_SHIM_NAME);
        assert!(claude.exists());
        let mode = fs::metadata(&claude).unwrap().permissions().mode();
        assert_eq!(
            mode & 0o111,
            0o111,
            "claude shim must be executable: {mode:o}"
        );
        let body = fs::read_to_string(&claude).unwrap();
        assert!(body.contains("ACORN_RESUME_TOKEN"));
    }

    #[test]
    fn ensure_shim_dir_is_idempotent() {
        let base = ScratchDir::new("idem");
        let dir1 = ensure_shim_dir_at(base.path()).unwrap();
        let dir2 = ensure_shim_dir_at(base.path()).unwrap();
        assert_eq!(dir1, dir2);
    }

    /// End-to-end: write the shim, drop a fake `claude` capture script
    /// next to it, run the shim, and verify the captured argv carries
    /// the injected `--session-id <token>` exactly once.
    #[test]
    fn claude_shim_injects_session_id_when_token_set() {
        let base = ScratchDir::new("inject");
        let dir = ensure_shim_dir_at(base.path()).unwrap();

        let bin_dir = base.path().join("fake-bin");
        fs::create_dir_all(&bin_dir).unwrap();
        let capture = base.path().join("argv.txt");
        let fake_claude = bin_dir.join("claude");
        fs::write(
            &fake_claude,
            format!(
                "#!/bin/sh\nfor a in \"$@\"; do printf '%s\\n' \"$a\" >> {}; done\n",
                capture.display()
            ),
        )
        .unwrap();
        let mut perms = fs::metadata(&fake_claude).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&fake_claude, perms).unwrap();

        let path = format!("{}:{}", dir.display(), bin_dir.display());
        let status = std::process::Command::new(dir.join(CLAUDE_SHIM_NAME))
            .env("PATH", &path)
            .env("ACORN_RESUME_TOKEN", "test-token-1234")
            .arg("--print")
            .status()
            .unwrap();
        assert!(status.success(), "shim exit code: {status:?}");

        let captured = fs::read_to_string(&capture).unwrap();
        let lines: Vec<&str> = captured.lines().collect();
        assert_eq!(
            lines,
            vec!["--session-id", "test-token-1234", "--print"],
            "shim must prepend --session-id <token> to user args"
        );
    }

    /// User-supplied `--session-id` wins — the shim must not double-up.
    #[test]
    fn claude_shim_respects_user_session_id() {
        let base = ScratchDir::new("user");
        let dir = ensure_shim_dir_at(base.path()).unwrap();

        let bin_dir = base.path().join("fake-bin");
        fs::create_dir_all(&bin_dir).unwrap();
        let capture = base.path().join("argv-user.txt");
        let fake_claude = bin_dir.join("claude");
        fs::write(
            &fake_claude,
            format!(
                "#!/bin/sh\nfor a in \"$@\"; do printf '%s\\n' \"$a\" >> {}; done\n",
                capture.display()
            ),
        )
        .unwrap();
        let mut perms = fs::metadata(&fake_claude).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&fake_claude, perms).unwrap();

        let path = format!("{}:{}", dir.display(), bin_dir.display());
        let status = std::process::Command::new(dir.join(CLAUDE_SHIM_NAME))
            .env("PATH", &path)
            .env("ACORN_RESUME_TOKEN", "shim-token")
            .args(["--session-id", "user-token", "--print"])
            .status()
            .unwrap();
        assert!(status.success());

        let captured = fs::read_to_string(&capture).unwrap();
        let lines: Vec<&str> = captured.lines().collect();
        assert_eq!(lines, vec!["--session-id", "user-token", "--print"]);
    }
}
