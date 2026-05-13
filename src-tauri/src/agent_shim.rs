//! Per-session shell shims that let user-invoked agents (`claude`,
//! `codex`) pick up Acorn's persistence hints without the user
//! installing anything.
//!
//! Every Acorn PTY gets the shim directory prepended onto `PATH`. The
//! shim scripts are POSIX shell, bundled into the binary via
//! `include_str!`, materialised once per data dir at app start.
//!
//! Per-agent strategy:
//! - **claude** — accepts `--session-id <uuid>`. Acorn exports its
//!   own session UUID as `ACORN_RESUME_TOKEN`; the shim forwards
//!   it. Reusing the Acorn UUID (rather than minting a fresh one)
//!   keeps the JSONL transcript filename aligned with what
//!   `session_status::detect` looks up.
//! - **codex** — no deterministic id flag. The shim snapshots
//!   `$CODEX_HOME/sessions/.../rollout-*.jsonl` before/after the
//!   first zero-arg run, extracts the trailing UUID from the new
//!   rollout filename, and stores it under `$ACORN_AGENT_STATE_DIR/
//!   codex.id`. Subsequent zero-arg invocations exec
//!   `codex resume <uuid>`. Any flag/subcommand passes through.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

const SHIM_DIR_NAME: &str = "shims";
const AGENT_STATE_DIR_NAME: &str = "agent-state";
const CLAUDE_SHIM_NAME: &str = "claude";
const CODEX_SHIM_NAME: &str = "codex";

const CLAUDE_SHIM_BODY: &str = include_str!("../shims/claude.sh");
const CODEX_SHIM_BODY: &str = include_str!("../shims/codex.sh");

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
    write_shim(&dir.join(CODEX_SHIM_NAME), CODEX_SHIM_BODY)?;
    Ok(dir)
}

/// Per-Acorn-session scratch directory used by agent shims to track
/// state that outlives a single shim invocation (today: the captured
/// codex session UUID under `codex.id`). Exported into the PTY env
/// as `ACORN_AGENT_STATE_DIR`.
pub fn ensure_session_state_dir(session_id: uuid::Uuid) -> io::Result<PathBuf> {
    ensure_session_state_dir_at(&crate::daemon::paths::data_dir()?, session_id)
}

fn ensure_session_state_dir_at(base: &Path, session_id: uuid::Uuid) -> io::Result<PathBuf> {
    let dir = base
        .join(AGENT_STATE_DIR_NAME)
        .join(session_id.to_string());
    fs::create_dir_all(&dir)?;
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

        // /bin + /usr/bin so `ls`, `mkdir`, `awk`, `rm` (used by the
        // codex shim's filesystem-scan path) resolve. Real PTYs always
        // have these on PATH; the test harness must replicate that.
        let path = format!("{}:{}:/bin:/usr/bin", dir.display(), bin_dir.display());
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

    /// Helper: build a fake-binary directory with a capture-argv script
    /// named `bin_name` that appends each arg on its own line to
    /// `capture`. Returns the bin dir.
    fn make_fake_bin(base: &Path, bin_name: &str, capture: &Path) -> PathBuf {
        let bin_dir = base.join(format!("fake-bin-{bin_name}"));
        fs::create_dir_all(&bin_dir).unwrap();
        let exe = bin_dir.join(bin_name);
        fs::write(
            &exe,
            format!(
                "#!/bin/sh\nfor a in \"$@\"; do printf '%s\\n' \"$a\" >> {}; done\n",
                capture.display()
            ),
        )
        .unwrap();
        let mut perms = fs::metadata(&exe).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&exe, perms).unwrap();
        bin_dir
    }

    /// Fake codex that drops a `rollout-<ts>-<uuid>.jsonl` under
    /// `$CODEX_HOME/sessions/2025/01/22/` matching the real codex's
    /// file layout. The shim's first-run path scans for new rollout
    /// files and captures the trailing UUID.
    fn make_fake_codex_writing_rollout(
        base: &Path,
        capture: &Path,
        codex_home: &Path,
        uuid: &str,
    ) -> PathBuf {
        let bin_dir = base.join("fake-bin-codex");
        fs::create_dir_all(&bin_dir).unwrap();
        let exe = bin_dir.join("codex");
        let day_dir = codex_home.join("sessions/2025/01/22");
        fs::write(
            &exe,
            format!(
                "#!/bin/sh\nmkdir -p {day}\ntouch {day}/rollout-2025-01-22T10-30-00-{uuid}.jsonl\nfor a in \"$@\"; do printf '%s\\n' \"$a\" >> {cap}; done\n",
                day = day_dir.display(),
                uuid = uuid,
                cap = capture.display(),
            ),
        )
        .unwrap();
        let mut perms = fs::metadata(&exe).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&exe, perms).unwrap();
        bin_dir
    }

    #[test]
    fn codex_shim_captures_uuid_on_first_invocation() {
        let base = ScratchDir::new("codex-capture");
        let dir = ensure_shim_dir_at(base.path()).unwrap();
        let state_dir =
            ensure_session_state_dir_at(base.path(), uuid::Uuid::new_v4()).unwrap();
        let codex_home = base.path().join("codex-home");
        let capture = base.path().join("argv-codex.txt");
        let uuid_str = "12345678-1234-1234-1234-123456789abc";
        let bin_dir = make_fake_codex_writing_rollout(
            base.path(),
            &capture,
            &codex_home,
            uuid_str,
        );

        // /bin + /usr/bin so `ls`, `mkdir`, `awk`, `rm` (used by the
        // codex shim's filesystem-scan path) resolve. Real PTYs always
        // have these on PATH; the test harness must replicate that.
        let path = format!("{}:{}:/bin:/usr/bin", dir.display(), bin_dir.display());
        let status = std::process::Command::new(dir.join(CODEX_SHIM_NAME))
            .env("PATH", &path)
            .env("ACORN_AGENT_STATE_DIR", &state_dir)
            .env("CODEX_HOME", &codex_home)
            .status()
            .unwrap();
        assert!(status.success(), "shim exit code: {status:?}");

        // First-run codex must see no extra args.
        let captured = fs::read_to_string(&capture).unwrap_or_default();
        assert!(captured.is_empty(), "first-run codex argv: {captured:?}");

        let stored = fs::read_to_string(state_dir.join("codex.id"))
            .expect("codex.id must be written on first run");
        assert_eq!(stored.trim(), uuid_str);
    }

    #[test]
    fn codex_shim_resumes_stored_id_on_second_invocation() {
        let base = ScratchDir::new("codex-resume");
        let dir = ensure_shim_dir_at(base.path()).unwrap();
        let state_dir =
            ensure_session_state_dir_at(base.path(), uuid::Uuid::new_v4()).unwrap();
        let uuid_str = "abcdef12-3456-7890-abcd-ef1234567890";
        fs::write(state_dir.join("codex.id"), format!("{uuid_str}\n")).unwrap();

        let capture = base.path().join("argv-codex.txt");
        let bin_dir = make_fake_bin(base.path(), "codex", &capture);

        // /bin + /usr/bin so `ls`, `mkdir`, `awk`, `rm` (used by the
        // codex shim's filesystem-scan path) resolve. Real PTYs always
        // have these on PATH; the test harness must replicate that.
        let path = format!("{}:{}:/bin:/usr/bin", dir.display(), bin_dir.display());
        let status = std::process::Command::new(dir.join(CODEX_SHIM_NAME))
            .env("PATH", &path)
            .env("ACORN_AGENT_STATE_DIR", &state_dir)
            .status()
            .unwrap();
        assert!(status.success());

        let captured = fs::read_to_string(&capture).unwrap();
        let lines: Vec<&str> = captured.lines().collect();
        assert_eq!(lines, vec!["resume", uuid_str]);
    }

    /// User-supplied subcommand or flags must passthrough — the shim
    /// only intercepts the bare zero-arg `codex` invocation.
    #[test]
    fn codex_shim_passes_through_user_args() {
        let base = ScratchDir::new("codex-passthrough");
        let dir = ensure_shim_dir_at(base.path()).unwrap();
        let state_dir =
            ensure_session_state_dir_at(base.path(), uuid::Uuid::new_v4()).unwrap();
        // Even with a stored id, explicit subcommand still passes through.
        fs::write(state_dir.join("codex.id"), "stored-uuid\n").unwrap();

        let capture = base.path().join("argv-codex.txt");
        let bin_dir = make_fake_bin(base.path(), "codex", &capture);

        // /bin + /usr/bin so `ls`, `mkdir`, `awk`, `rm` (used by the
        // codex shim's filesystem-scan path) resolve. Real PTYs always
        // have these on PATH; the test harness must replicate that.
        let path = format!("{}:{}:/bin:/usr/bin", dir.display(), bin_dir.display());
        let status = std::process::Command::new(dir.join(CODEX_SHIM_NAME))
            .env("PATH", &path)
            .env("ACORN_AGENT_STATE_DIR", &state_dir)
            .args(["resume", "user-supplied-id"])
            .status()
            .unwrap();
        assert!(status.success());

        let captured = fs::read_to_string(&capture).unwrap();
        let lines: Vec<&str> = captured.lines().collect();
        assert_eq!(lines, vec!["resume", "user-supplied-id"]);
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

        // /bin + /usr/bin so `ls`, `mkdir`, `awk`, `rm` (used by the
        // codex shim's filesystem-scan path) resolve. Real PTYs always
        // have these on PATH; the test harness must replicate that.
        let path = format!("{}:{}:/bin:/usr/bin", dir.display(), bin_dir.display());
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
