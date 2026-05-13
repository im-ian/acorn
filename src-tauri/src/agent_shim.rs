//! Per-session shell shims that let user-invoked agents (`claude`,
//! `codex`) pick up Acorn's persistence hints without the user
//! installing anything.
//!
//! Every Acorn PTY gets the shim directory prepended onto `PATH`. The
//! shim scripts are POSIX shell, bundled into the binary via
//! `include_str!`, materialised once per data dir at app start.
//!
//! Per-agent strategy:
//! - **claude** — the shim never injects `--session-id`. Auto-resuming
//!   every invocation against the same Acorn UUID would silently
//!   accumulate unrelated turns into one ever-growing JSONL. Instead the
//!   shim snapshots `~/.claude/projects/<slug>/*.jsonl` before/after each
//!   bare-flag run, captures the new transcript's UUID, and stores it
//!   under `$ACORN_AGENT_STATE_DIR/claude.id`. The app reads that file
//!   on session focus and offers an explicit "이어하기" modal — see
//!   `claude_resume_candidate`. Explicit `--resume`/`--continue`/
//!   `--session-id` from the user passes through untouched.
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

/// Read-only sibling of `ensure_session_state_dir`. Returns `Ok(None)`
/// when the directory does not exist instead of creating it — the
/// resume-candidate query must not be the call that materialises the
/// state dir for sessions that never spawned claude.
fn session_state_dir_if_exists_at(
    base: &Path,
    session_id: uuid::Uuid,
) -> io::Result<Option<PathBuf>> {
    let dir = base
        .join(AGENT_STATE_DIR_NAME)
        .join(session_id.to_string());
    Ok(if dir.is_dir() { Some(dir) } else { None })
}

/// What `get_claude_resume_candidate` returns for the focus-time modal.
///
/// `uuid` is the JSONL stem; the frontend uses it both to render
/// "Resume this conversation?" and to dispatch `claude --resume <uuid>`
/// when the user accepts. `last_activity_unix` is the JSONL mtime — good
/// enough as a "last touched" signal without parsing the file. `preview`
/// is the first non-empty line of text content from the last assistant
/// turn, trimmed to fit a single modal line.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeResumeCandidate {
    pub uuid: String,
    pub last_activity_unix: u64,
    pub preview: Option<String>,
}

const CLAUDE_ID_FILE: &str = "claude.id";
const CLAUDE_ID_ACK_FILE: &str = "claude.id.acknowledged";

/// Read `claude.id` and compare against `claude.id.acknowledged`. Returns
/// `Ok(None)` when there is nothing to surface — either no claude run has
/// happened yet, or the user already saw the modal for this UUID.
pub fn claude_resume_candidate(
    session_id: uuid::Uuid,
) -> io::Result<Option<ClaudeResumeCandidate>> {
    claude_resume_candidate_at(&crate::daemon::paths::data_dir()?, session_id)
}

fn claude_resume_candidate_at(
    base: &Path,
    session_id: uuid::Uuid,
) -> io::Result<Option<ClaudeResumeCandidate>> {
    let Some(state_dir) = session_state_dir_if_exists_at(base, session_id)? else {
        return Ok(None);
    };
    let id_path = state_dir.join(CLAUDE_ID_FILE);
    let uuid = match fs::read_to_string(&id_path) {
        Ok(s) => s.trim().to_string(),
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err),
    };
    if uuid.is_empty() {
        return Ok(None);
    }
    let ack_path = state_dir.join(CLAUDE_ID_ACK_FILE);
    let acked = fs::read_to_string(&ack_path)
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    if acked == uuid {
        return Ok(None);
    }

    let transcript = crate::todos::locate_transcript_for(&uuid)
        .ok()
        .flatten();
    let last_activity_unix = transcript
        .as_ref()
        .and_then(|p| fs::metadata(p).ok())
        .and_then(|m| m.modified().ok())
        .and_then(|mt| mt.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let preview = transcript
        .as_ref()
        .and_then(|p| extract_last_assistant_preview(p).ok().flatten());

    Ok(Some(ClaudeResumeCandidate {
        uuid,
        last_activity_unix,
        preview,
    }))
}

/// Write the current `claude.id` value to `claude.id.acknowledged` so the
/// modal stops popping for the same UUID on subsequent focus events.
/// No-op if `claude.id` does not exist.
pub fn acknowledge_claude_resume(session_id: uuid::Uuid) -> io::Result<()> {
    acknowledge_claude_resume_at(&crate::daemon::paths::data_dir()?, session_id)
}

fn acknowledge_claude_resume_at(base: &Path, session_id: uuid::Uuid) -> io::Result<()> {
    let Some(state_dir) = session_state_dir_if_exists_at(base, session_id)? else {
        return Ok(());
    };
    let id = match fs::read_to_string(state_dir.join(CLAUDE_ID_FILE)) {
        Ok(s) => s,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(err),
    };
    fs::write(state_dir.join(CLAUDE_ID_ACK_FILE), id)
}

/// Walk the last ~256 KiB of the transcript looking for the most recent
/// `assistant` line and return its first text segment, truncated and
/// newline-collapsed for single-line display. Conservative parsing — any
/// JSON parse error or unexpected shape silently yields `None` so the
/// modal degrades to "no preview" rather than a hard error.
fn extract_last_assistant_preview(path: &Path) -> io::Result<Option<String>> {
    use std::io::{Read, Seek, SeekFrom};
    const TAIL_BYTES: u64 = 262_144;
    const PREVIEW_CHARS: usize = 90;

    let mut f = fs::File::open(path)?;
    let len = f.metadata()?.len();
    let start = len.saturating_sub(TAIL_BYTES);
    f.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::with_capacity(TAIL_BYTES as usize);
    f.read_to_end(&mut buf)?;
    let text = String::from_utf8_lossy(&buf);

    for line in text.lines().rev() {
        let trimmed = line.trim();
        if trimmed.is_empty() || !trimmed.starts_with('{') {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
            continue;
        }
        let content = v
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_array());
        let Some(items) = content else { continue };
        for item in items {
            let kind = item.get("type").and_then(|t| t.as_str());
            if kind != Some("text") {
                continue;
            }
            let Some(text) = item.get("text").and_then(|t| t.as_str()) else {
                continue;
            };
            let collapsed = text
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            if collapsed.is_empty() {
                continue;
            }
            let truncated: String = collapsed.chars().take(PREVIEW_CHARS).collect();
            let suffix = if collapsed.chars().count() > PREVIEW_CHARS {
                "…"
            } else {
                ""
            };
            return Ok(Some(format!("{truncated}{suffix}")));
        }
    }
    Ok(None)
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
        assert!(body.contains("claude.id"));
    }

    #[test]
    fn ensure_shim_dir_is_idempotent() {
        let base = ScratchDir::new("idem");
        let dir1 = ensure_shim_dir_at(base.path()).unwrap();
        let dir2 = ensure_shim_dir_at(base.path()).unwrap();
        assert_eq!(dir1, dir2);
    }

    /// Fake claude that writes a JSONL transcript under a faked
    /// projects/<slug>/<uuid>.jsonl, then captures argv. Returns the bin
    /// dir to place on PATH.
    fn make_fake_claude_writing_transcript(
        base: &Path,
        capture: &Path,
        projects_root: &Path,
        uuid: &str,
    ) -> PathBuf {
        let bin_dir = base.join("fake-bin-claude");
        fs::create_dir_all(&bin_dir).unwrap();
        let exe = bin_dir.join("claude");
        let slug_dir = projects_root.join("-some-cwd");
        fs::write(
            &exe,
            format!(
                "#!/bin/sh\nmkdir -p {slug}\ntouch {slug}/{uuid}.jsonl\nfor a in \"$@\"; do printf '%s\\n' \"$a\" >> {cap}; done\n",
                slug = slug_dir.display(),
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

    /// On a bare-flag run, the shim must not modify argv and must capture
    /// the UUID of the newly-created JSONL into `claude.id`.
    #[test]
    fn claude_shim_captures_uuid_on_bare_run() {
        let base = ScratchDir::new("claude-capture");
        let dir = ensure_shim_dir_at(base.path()).unwrap();
        let state_dir =
            ensure_session_state_dir_at(base.path(), uuid::Uuid::new_v4()).unwrap();
        let home = base.path().join("home");
        let projects_root = home.join(".claude/projects");
        let capture = base.path().join("argv-claude.txt");
        let uuid_str = "12345678-1234-1234-1234-123456789abc";
        let bin_dir = make_fake_claude_writing_transcript(
            base.path(),
            &capture,
            &projects_root,
            uuid_str,
        );

        let path = format!("{}:{}:/bin:/usr/bin", dir.display(), bin_dir.display());
        let status = std::process::Command::new(dir.join(CLAUDE_SHIM_NAME))
            .env("PATH", &path)
            .env("HOME", &home)
            .env("ACORN_AGENT_STATE_DIR", &state_dir)
            .arg("--print")
            .status()
            .unwrap();
        assert!(status.success(), "shim exit code: {status:?}");

        let captured = fs::read_to_string(&capture).unwrap();
        let lines: Vec<&str> = captured.lines().collect();
        assert_eq!(lines, vec!["--print"], "argv must passthrough untouched");

        let stored = fs::read_to_string(state_dir.join("claude.id"))
            .expect("claude.id must be written when a new JSONL appears");
        assert_eq!(stored.trim(), uuid_str);
    }

    /// `--resume` must passthrough untouched and the shim must NOT
    /// rewrite `claude.id` (the user is steering an explicit session).
    #[test]
    fn claude_shim_passthrough_on_explicit_resume() {
        let base = ScratchDir::new("claude-passthrough");
        let dir = ensure_shim_dir_at(base.path()).unwrap();
        let state_dir =
            ensure_session_state_dir_at(base.path(), uuid::Uuid::new_v4()).unwrap();
        // Pre-populate claude.id with a known value; the shim must not
        // overwrite it on an explicit-resume path.
        fs::write(state_dir.join("claude.id"), "pre-existing-uuid\n").unwrap();
        let capture = base.path().join("argv-claude.txt");
        let bin_dir = make_fake_bin(base.path(), "claude", &capture);

        let path = format!("{}:{}:/bin:/usr/bin", dir.display(), bin_dir.display());
        let status = std::process::Command::new(dir.join(CLAUDE_SHIM_NAME))
            .env("PATH", &path)
            .env("ACORN_AGENT_STATE_DIR", &state_dir)
            .args(["--resume", "user-supplied-uuid"])
            .status()
            .unwrap();
        assert!(status.success());

        let captured = fs::read_to_string(&capture).unwrap();
        let lines: Vec<&str> = captured.lines().collect();
        assert_eq!(lines, vec!["--resume", "user-supplied-uuid"]);

        let stored = fs::read_to_string(state_dir.join("claude.id")).unwrap();
        assert_eq!(
            stored.trim(),
            "pre-existing-uuid",
            "shim must not clobber claude.id on explicit --resume",
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

    /// User-supplied `--session-id` is one of the explicit-control flags
    /// that pin a specific transcript; the shim must passthrough untouched.
    #[test]
    fn claude_shim_passthrough_on_explicit_session_id() {
        let base = ScratchDir::new("user");
        let dir = ensure_shim_dir_at(base.path()).unwrap();
        let state_dir =
            ensure_session_state_dir_at(base.path(), uuid::Uuid::new_v4()).unwrap();
        let capture = base.path().join("argv-user.txt");
        let bin_dir = make_fake_bin(base.path(), "claude", &capture);

        let path = format!("{}:{}:/bin:/usr/bin", dir.display(), bin_dir.display());
        let status = std::process::Command::new(dir.join(CLAUDE_SHIM_NAME))
            .env("PATH", &path)
            .env("ACORN_AGENT_STATE_DIR", &state_dir)
            .args(["--session-id", "user-token", "--print"])
            .status()
            .unwrap();
        assert!(status.success());

        let captured = fs::read_to_string(&capture).unwrap();
        let lines: Vec<&str> = captured.lines().collect();
        assert_eq!(lines, vec!["--session-id", "user-token", "--print"]);
    }

    /// `claude_resume_candidate_at` returns None until `claude.id` exists,
    /// returns Some after a JSONL is captured, and falls back to None
    /// after the value is acknowledged.
    #[test]
    fn claude_resume_candidate_respects_acknowledgment() {
        let base = ScratchDir::new("ack");
        let session_id = uuid::Uuid::new_v4();
        let state_dir = ensure_session_state_dir_at(base.path(), session_id).unwrap();

        assert!(
            claude_resume_candidate_at(base.path(), session_id)
                .unwrap()
                .is_none(),
            "no claude.id → no candidate",
        );

        let uuid_a = "deadbeef-1234-5678-9abc-def012345678";
        fs::write(state_dir.join(CLAUDE_ID_FILE), format!("{uuid_a}\n")).unwrap();
        let candidate = claude_resume_candidate_at(base.path(), session_id)
            .unwrap()
            .expect("candidate must surface once claude.id is written");
        assert_eq!(candidate.uuid, uuid_a);

        acknowledge_claude_resume_at(base.path(), session_id).unwrap();
        assert!(
            claude_resume_candidate_at(base.path(), session_id)
                .unwrap()
                .is_none(),
            "acknowledged UUID must suppress the candidate",
        );

        let uuid_b = "00112233-4455-6677-8899-aabbccddeeff";
        fs::write(state_dir.join(CLAUDE_ID_FILE), format!("{uuid_b}\n")).unwrap();
        let candidate = claude_resume_candidate_at(base.path(), session_id)
            .unwrap()
            .expect("a different UUID must re-surface the candidate");
        assert_eq!(candidate.uuid, uuid_b);
    }

    /// `extract_last_assistant_preview` walks backwards through the
    /// tail and returns the most recent text-segment content from an
    /// assistant turn, collapsing newlines and truncating.
    #[test]
    fn extract_last_assistant_preview_picks_most_recent_text() {
        let base = ScratchDir::new("preview");
        let path = base.path().join("transcript.jsonl");
        let lines = [
            r#"{"type":"user","message":{"role":"user","content":"hi"}}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"older reply"}]}}"#,
            r#"{"type":"file-history-snapshot","snapshot":{}}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"newer\nreply with whitespace"}]}}"#,
            r#"{"type":"user","message":{"role":"user","content":"thanks"}}"#,
        ];
        fs::write(&path, lines.join("\n") + "\n").unwrap();
        let preview = extract_last_assistant_preview(&path).unwrap();
        assert_eq!(preview.as_deref(), Some("newer reply with whitespace"));
    }
}
