//! On-demand process-inspection pairing for the Tab > Fork menu.
//!
//! Each call walks every Acorn session's PTY descendant tree, picks
//! the `claude` / `codex` processes, and resolves each one to the
//! transcript file it is currently writing. The returned UUID is what
//! `claude --resume <id>` / `codex fork <id>` expect.
//!
//! Algorithm (mirrors agent-sessions' approach):
//!   1. List PTY descendants by basename.
//!   2. Map process cwd → transcript directory:
//!      claude: `~/.claude/projects/<slugified-cwd>/`
//!      codex:  scan `${CODEX_HOME:-~/.codex}/sessions/<y>/<m>/<d>/`
//!              (filename does not encode cwd, so read each candidate's
//!              first line `payload.cwd` and match).
//!   3. Sort processes by start-time DESC so newer fork chains claim
//!      newer transcripts first; an `assigned` set keeps each
//!      transcript pinned to one session per scan.
//!   4. Filter by transcript mtime ≥ process start to never pair a
//!      process with its predecessor's file.
//!   5. Trailing 36 chars of the filename stem is the session UUID.
//!
//! No disk markers, no `lsof` (claude does not keep the JSONL open
//! between writes; macOS lsof can hang on stale vnodes). The fresh
//! scan happens at `detect_session_agent` invocation time, so a Fork
//! menu opened seconds after spawning a new agent always sees the
//! latest process state.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime};

use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System, UpdateKind};

use crate::state::AppState;

// Maximum age (mtime → now) of a transcript that will be paired with
// a live agent process. Generous so an idle agent waiting on user
// input still surfaces as a Fork target.
const RECENCY_WINDOW_SECS: u64 = 24 * 60 * 60;

// Throttle window for `collect_live_mappings`. The scan walks every
// process on the host plus several directory trees, so back-to-back
// calls (e.g. a user flicking the right-click menu open repeatedly)
// would multiply that cost without changing the answer. A short hold
// returns the cached result for repeat calls within this window.
const SCAN_CACHE_TTL_MS: u64 = 300;

struct ScanCache {
    captured_at: Instant,
    mappings: Vec<(uuid::Uuid, AgentKind, String)>,
}

fn scan_cache() -> &'static Mutex<Option<ScanCache>> {
    static CACHE: OnceLock<Mutex<Option<ScanCache>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

#[derive(Clone, Copy, Debug)]
pub enum AgentKind {
    Claude,
    Codex,
}

/// On-demand pairing scan. `detect_session_agent` calls this every
/// time the Fork menu opens; results are cached for `SCAN_CACHE_TTL_MS`
/// so repeated menu opens within a short window do not multiply the
/// per-process syscall cost.
pub fn collect_live_mappings(state: &AppState) -> Vec<(uuid::Uuid, AgentKind, String)> {
    {
        let guard = scan_cache().lock().unwrap();
        if let Some(cache) = guard.as_ref() {
            if cache.captured_at.elapsed() < Duration::from_millis(SCAN_CACHE_TTL_MS) {
                return cache.mappings.clone();
            }
        }
    }
    let mappings = scan_live_mappings(state);
    *scan_cache().lock().unwrap() = Some(ScanCache {
        captured_at: Instant::now(),
        mappings: mappings.clone(),
    });
    mappings
}

fn scan_live_mappings(state: &AppState) -> Vec<(uuid::Uuid, AgentKind, String)> {
    let mut out = Vec::new();
    let mut sys = System::new_with_specifics(
        RefreshKind::new().with_processes(ProcessRefreshKind::new()),
    );
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::new().with_cwd(UpdateKind::Always),
    );

    let mut children: std::collections::HashMap<Pid, Vec<Pid>> = std::collections::HashMap::new();
    for (pid, proc) in sys.processes() {
        if let Some(parent) = proc.parent() {
            children.entry(parent).or_default().push(*pid);
        }
    }

    // Tracks transcripts that have already been claimed by some session
    // this cycle so two sessions running claude in the same cwd do not
    // collide on the same JSONL.
    let mut assigned: HashSet<PathBuf> = HashSet::new();
    let now = SystemTime::now();
    let recency_cutoff = now
        .checked_sub(Duration::from_secs(RECENCY_WINDOW_SECS))
        .unwrap_or(SystemTime::UNIX_EPOCH);

    let claude_root = claude_projects_root();
    let codex_root = codex_sessions_root();

    // Collect every (session, agent-process) candidate first so we can
    // sort by process-start-time before matching. Newest agent runs get
    // first pick of the transcript pool, which gives a stable answer
    // when two sessions are running the same agent in the same cwd:
    // the more recently spawned process pairs with the more recently
    // created transcript, and the older one falls back to its own
    // older file (or nothing).
    struct Candidate {
        session_id: uuid::Uuid,
        kind: AgentKind,
        pid: u32,
        cwd: PathBuf,
        start_time: SystemTime,
    }
    let mut candidates: Vec<Candidate> = Vec::new();

    for session in state.sessions.list() {
        let root_pid = state
            .stream_registry
            .pid(&session.id)
            .or_else(|| state.pty.child_pid(&session.id));
        let Some(root_pid) = root_pid else { continue };

        let mut stack = vec![Pid::from_u32(root_pid)];
        while let Some(pid) = stack.pop() {
            if let Some(proc) = sys.process(pid) {
                let basename = process_basename(proc);
                let kind = match basename {
                    "claude" => Some(AgentKind::Claude),
                    "codex" => Some(AgentKind::Codex),
                    _ => None,
                };
                if let Some(kind) = kind {
                    if let Some(cwd) = proc.cwd().map(|p| p.to_path_buf()) {
                        let start_time = SystemTime::UNIX_EPOCH
                            + Duration::from_secs(proc.start_time());
                        candidates.push(Candidate {
                            session_id: session.id,
                            kind,
                            pid: pid.as_u32(),
                            cwd,
                            start_time,
                        });
                    }
                }
            }
            if let Some(kids) = children.get(&pid) {
                stack.extend(kids.iter().copied());
            }
        }
    }

    // Newest agent process first so it claims the newest matching transcript.
    candidates.sort_by(|a, b| b.start_time.cmp(&a.start_time));

    for c in candidates {
        let candidate = match c.kind {
            AgentKind::Claude => find_recent_claude_jsonl(
                &c.cwd,
                claude_root.as_deref(),
                recency_cutoff,
                c.start_time,
                &assigned,
            ),
            AgentKind::Codex => find_recent_codex_jsonl(
                &c.cwd,
                codex_root.as_deref(),
                recency_cutoff,
                c.start_time,
                &assigned,
            ),
        };
        if let Some((path, uuid)) = candidate {
            tracing::info!(
                session_id = %c.session_id,
                kind = ?c.kind,
                pid = c.pid,
                cwd = ?c.cwd,
                ?path,
                %uuid,
                "transcript_watcher: paired live agent"
            );
            assigned.insert(path);
            out.push((c.session_id, c.kind, uuid));
        }
    }

    out
}

fn process_basename(proc: &sysinfo::Process) -> &str {
    proc.exe()
        .and_then(|p| p.file_name())
        .and_then(|s| s.to_str())
        .unwrap_or_else(|| proc.name().to_str().unwrap_or(""))
}

fn claude_projects_root() -> Option<PathBuf> {
    directories::UserDirs::new()
        .map(|d| d.home_dir().to_path_buf())
        .map(|h| h.join(".claude").join("projects"))
}

fn codex_sessions_root() -> Option<PathBuf> {
    std::env::var("CODEX_HOME")
        .ok()
        .map(PathBuf::from)
        .or_else(|| {
            directories::UserDirs::new()
                .map(|d| d.home_dir().join(".codex"))
        })
        .map(|p| p.join("sessions"))
}

/// Convert a filesystem cwd into the dash-slugged directory name claude
/// uses to bucket transcripts. Examples:
///   `/Users/me/proj`       → `-Users-me-proj`
///   `/Users/me/proj/sub`   → `-Users-me-proj-sub`
fn find_recent_claude_jsonl(
    cwd: &Path,
    projects_root: Option<&Path>,
    recency_cutoff: SystemTime,
    process_start: SystemTime,
    assigned: &HashSet<PathBuf>,
) -> Option<(PathBuf, String)> {
    let root = projects_root?;
    let slug_dir = root.join(crate::claude_util::slug_for_cwd(cwd));
    pick_newest_unassigned_jsonl(&slug_dir, recency_cutoff, process_start, assigned)
}

fn find_recent_codex_jsonl(
    cwd: &Path,
    sessions_root: Option<&Path>,
    recency_cutoff: SystemTime,
    process_start: SystemTime,
    assigned: &HashSet<PathBuf>,
) -> Option<(PathBuf, String)> {
    // Codex rollouts live under <root>/<year>/<month>/<day>/. The
    // filename does NOT encode the cwd (unlike claude), so we read each
    // candidate's first JSONL line and match its `payload.cwd` against
    // the live process's cwd. Walking just the newest date-dir keeps
    // the per-cycle work bounded.
    let root = sessions_root?;
    let day_dir = newest_subdir(&newest_subdir(&newest_subdir(root)?)?)?;
    let mut candidates: Vec<(PathBuf, SystemTime)> = Vec::new();
    for entry in std::fs::read_dir(&day_dir).ok()?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        if assigned.contains(&path) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(mtime) = meta.modified() else { continue };
        if mtime < recency_cutoff {
            continue;
        }
        // Transcript must have been written after this agent process
        // started — otherwise it belongs to an earlier run.
        if mtime < process_start {
            continue;
        }
        candidates.push((path, mtime));
    }
    candidates.sort_by(|a, b| b.1.cmp(&a.1));
    for (path, _) in candidates {
        let Some(transcript_cwd) = read_codex_transcript_cwd(&path) else {
            continue;
        };
        if transcript_cwd != cwd {
            continue;
        }
        if let Some(uuid) = extract_uuid_from_path(&path) {
            return Some((path, uuid));
        }
    }
    None
}

/// Read codex rollout's first non-empty JSONL line and pull `payload.cwd`.
/// The first event is a `SessionMeta` with cwd nested under `payload`.
fn read_codex_transcript_cwd(path: &Path) -> Option<PathBuf> {
    use std::io::{BufRead, BufReader};
    let f = std::fs::File::open(path).ok()?;
    let reader = BufReader::new(f);
    for line in reader.lines().map_while(Result::ok).take(20) {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if let Some(cwd) = v.get("cwd").and_then(|c| c.as_str()) {
            return Some(PathBuf::from(cwd));
        }
        if let Some(cwd) = v
            .get("payload")
            .and_then(|p| p.get("cwd"))
            .and_then(|c| c.as_str())
        {
            return Some(PathBuf::from(cwd));
        }
    }
    None
}

/// Pick the lexicographically greatest subdirectory of `dir`. Codex
/// date dirs are `<root>/<YYYY>/<MM>/<DD>/`, so lexicographic ordering
/// is equivalent to chronological ordering AND survives parent-dir
/// mtime drift (some filesystems do not bump a directory's mtime when
/// a child gains a new grandchild, which would mislead a mtime-based
/// pick).
fn newest_subdir(dir: &Path) -> Option<PathBuf> {
    let mut best: Option<PathBuf> = None;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        match &best {
            None => best = Some(path),
            Some(current) if path.file_name() > current.file_name() => {
                best = Some(path);
            }
            _ => {}
        }
    }
    best
}

fn pick_newest_unassigned_jsonl(
    dir: &Path,
    recency_cutoff: SystemTime,
    process_start: SystemTime,
    assigned: &HashSet<PathBuf>,
) -> Option<(PathBuf, String)> {
    let mut candidates: Vec<(PathBuf, SystemTime)> = Vec::new();
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        if assigned.contains(&path) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(mtime) = meta.modified() else { continue };
        if mtime < recency_cutoff {
            continue;
        }
        // Transcript must have been written at or after this agent
        // process started so we never pair a process with a transcript
        // its predecessor created.
        if mtime < process_start {
            continue;
        }
        candidates.push((path, mtime));
    }
    candidates.sort_by(|a, b| b.1.cmp(&a.1));
    for (path, _) in candidates {
        if let Some(uuid) = extract_uuid_from_path(&path) {
            return Some((path, uuid));
        }
    }
    None
}

/// Both claude `<uuid>.jsonl` and codex `rollout-<ts>-<uuid>.jsonl` end
/// in a 36-char UUID. Take the trailing 36 chars of the file stem.
fn extract_uuid_from_path(path: &Path) -> Option<String> {
    let filename = path.file_name()?.to_str()?;
    let stem = filename.strip_suffix(".jsonl")?;
    if stem.len() < 36 {
        return None;
    }
    let candidate = &stem[stem.len() - 36..];
    is_uuid_v4_shape(candidate).then(|| candidate.to_string())
}

fn is_uuid_v4_shape(s: &str) -> bool {
    if s.len() != 36 {
        return false;
    }
    for (i, b) in s.bytes().enumerate() {
        let is_sep = matches!(i, 8 | 13 | 18 | 23);
        if is_sep {
            if b != b'-' {
                return false;
            }
        } else if !b.is_ascii_hexdigit() {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_uuid_from_claude_path() {
        let path = Path::new(
            "/Users/me/.claude/projects/-slug/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl",
        );
        assert_eq!(
            extract_uuid_from_path(path).as_deref(),
            Some("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
        );
    }

    #[test]
    fn extracts_uuid_from_codex_rollout_path() {
        let path = Path::new(
            "/Users/me/.codex/sessions/2026/05/13/rollout-2026-05-13T15-23-29-019e2001-3250-76b0-8410-2e073b38a2c1.jsonl",
        );
        assert_eq!(
            extract_uuid_from_path(path).as_deref(),
            Some("019e2001-3250-76b0-8410-2e073b38a2c1")
        );
    }

    /// `newest_subdir` must pick the chronologically latest date dir
    /// regardless of filesystem mtime quirks. Lexicographic ordering on
    /// the date components (YYYY → MM → DD) is what makes that work.
    #[test]
    fn newest_subdir_picks_lexicographically_greatest() {
        use std::fs;
        let base = std::env::temp_dir().join(format!(
            "acorn-newest-subdir-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&base).unwrap();
        for name in &["2025", "2026", "2024"] {
            fs::create_dir(base.join(name)).unwrap();
        }
        let picked = newest_subdir(&base).unwrap();
        assert_eq!(picked.file_name().unwrap(), "2026");
        fs::remove_dir_all(&base).unwrap();
    }

    /// Process start-time and transcript mtime both round to seconds on
    /// macOS sysinfo. Same-second values must still match: a process
    /// that started in the same second as its transcript was created
    /// should pair with that transcript, not skip it.
    #[test]
    fn pick_newest_unassigned_jsonl_includes_same_second_mtime() {
        use std::fs::{self, File};
        let dir = std::env::temp_dir().join(format!(
            "acorn-mtime-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&dir).unwrap();
        let jsonl = dir.join("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl");
        File::create(&jsonl).unwrap();
        let mtime = fs::metadata(&jsonl).unwrap().modified().unwrap();
        // Process start equals transcript mtime → must include (>=).
        let result = pick_newest_unassigned_jsonl(
            &dir,
            SystemTime::UNIX_EPOCH,
            mtime,
            &HashSet::new(),
        );
        assert!(
            result.is_some(),
            "transcript with mtime == process_start must be a valid pair"
        );
        // Process started one second after the transcript → exclude.
        let later = mtime + Duration::from_secs(1);
        let result_later = pick_newest_unassigned_jsonl(
            &dir,
            SystemTime::UNIX_EPOCH,
            later,
            &HashSet::new(),
        );
        assert!(
            result_later.is_none(),
            "transcript predating the process must be excluded"
        );
        fs::remove_dir_all(&dir).unwrap();
    }
}
