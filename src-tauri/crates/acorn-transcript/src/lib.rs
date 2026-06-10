//! On-demand process-inspection pairing for the Tab > Fork menu.
//!
//! Each call walks every Acorn session's PTY descendant tree, picks
//! the `claude` / `codex` / `antigravity` processes, and resolves each one
//! to the transcript file it is currently writing. The returned UUID is
//! what `claude --resume <id>` / `codex fork <id>` expect, or the
//! Antigravity brain id for Antigravity sessions.
//!
//! Algorithm (mirrors agent-sessions' approach):
//!   1. List PTY descendants by basename.
//!   2. Map process cwd → transcript directory:
//!      claude: `~/.claude/projects/<slugified-cwd>/`, with a metadata scan
//!              fallback for Claude versions whose cwd slug differs
//!      codex:  scan `${CODEX_HOME:-~/.codex}/sessions/<y>/<m>/<d>/`
//!              (filename does not encode cwd, so read each candidate's
//!              first line `payload.cwd` and match).
//!      antigravity: scan `${ANTIGRAVITY_DIR:-~/.gemini}/antigravity*/brain/<uuid>/.system_generated/logs/transcript.jsonl`
//!   3. Sort processes by start-time DESC so newer fork chains claim
//!      newer transcripts first; an `assigned` set keeps each
//!      transcript pinned to one session per scan.
//!   4. Filter by transcript mtime ≥ process start to never pair a
//!      process with its predecessor's file.
//!   5. Extract the provider's session id from the transcript path or
//!      metadata line.
//!
//! No disk markers, no `lsof` (claude does not keep the JSONL open
//! between writes; macOS lsof can hang on stale vnodes). The fresh
//! scan happens at `detect_session_agent` invocation time, so a Fork
//! menu opened seconds after spawning a new agent always sees the
//! latest process state.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime};

use parking_lot::Mutex;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System, UpdateKind};

// Maximum age (mtime → now) of a transcript that will be paired with
// a live agent process. Generous so an idle agent waiting on user
// input still surfaces as a Fork target.
const RECENCY_WINDOW_SECS: u64 = 24 * 60 * 60;

/// How long a transcript must sit un-appended (mtime → now) before we
/// treat it as no longer being written. Used on both sides of the
/// `/new` rotation: the birth-anchored pairing only rolls forward off a
/// *dormant* anchor (the signal that the same process abandoned its
/// first JSONL), and only onto a successor that is still *hot* — a file
/// left behind by an exited sibling tab or one-shot `claude -p` run
/// goes dormant within seconds of its writer dying, so it can never be
/// adopted by mistake. Public so the resume persister can apply the
/// same activity window when deciding whether a backwards marker move
/// is a real `--resume` or a stale post-rotation echo.
pub const DORMANT_TRANSCRIPT_SECS: u64 = 10;

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
    Antigravity,
}

/// Per-session input handed to [`collect_live_mappings`]: the Acorn
/// session id and the PTY root pid (if any) whose descendant tree
/// should be walked for live agent processes. The host crate builds
/// this slice from its `AppState` (sessions list + stream/pty pid
/// lookups) so this crate stays decoupled from acorn's app state.
#[derive(Clone, Debug)]
pub struct SessionPid {
    pub session_id: uuid::Uuid,
    pub root_pid: Option<u32>,
}

/// Convert a filesystem cwd into the dash-slug directory name Claude
/// uses to bucket its JSONL transcripts.
///
/// Examples:
///   `/Users/me/proj`                          → `-Users-me-proj`
///   `/Users/me/proj/.claude/worktrees/foo`    → `-Users-me-proj--claude-worktrees-foo`
pub fn slug_for_cwd(cwd: &Path) -> String {
    let s = cwd.to_string_lossy();
    let trimmed = s.trim_start_matches('/');
    let mut slug = String::with_capacity(s.len() + 1);
    slug.push('-');
    for ch in trimmed.chars() {
        if ch == '/' || ch == '.' {
            slug.push('-');
        } else {
            slug.push(ch);
        }
    }
    slug
}

/// On-demand pairing scan. `detect_session_agent` calls this every
/// time the Fork menu opens; results are cached for `SCAN_CACHE_TTL_MS`
/// so repeated menu opens within a short window do not multiply the
/// per-process syscall cost.
pub fn collect_live_mappings(sessions: &[SessionPid]) -> Vec<(uuid::Uuid, AgentKind, String)> {
    {
        let guard = scan_cache().lock();
        if let Some(cache) = guard.as_ref() {
            if cache.captured_at.elapsed() < Duration::from_millis(SCAN_CACHE_TTL_MS) {
                return cache.mappings.clone();
            }
        }
    }
    let mappings = scan_live_mappings(sessions);
    *scan_cache().lock() = Some(ScanCache {
        captured_at: Instant::now(),
        mappings: mappings.clone(),
    });
    mappings
}

/// Resolve the provider conversation id created by a completed one-shot
/// agent run. Native chat uses this after non-interactive CLI calls that
/// create provider-side transcripts but do not print their id on stdout.
///
/// The helper intentionally returns `None` for ambiguous matches instead
/// of guessing. A wrong provider cursor would silently resume another chat,
/// while `None` only falls back to Acorn's compiled context on the next turn.
pub fn find_completed_agent_run(
    cwd: &Path,
    kind: AgentKind,
    process_start: SystemTime,
) -> Option<String> {
    let now = SystemTime::now();
    let recency_cutoff = now
        .checked_sub(Duration::from_secs(RECENCY_WINDOW_SECS))
        .unwrap_or(SystemTime::UNIX_EPOCH);
    match kind {
        // `allow_rotation: false` — this path resolves a finished one-shot
        // run, not a long-lived interactive process, so there is no
        // in-session `/new` to follow and no process-table context to
        // prove the cwd has a single claude. Keep the plain birth anchor.
        AgentKind::Claude => find_recent_claude_jsonl(
            cwd,
            claude_projects_root().as_deref(),
            recency_cutoff,
            process_start,
            now,
            false,
            &HashSet::new(),
        )
        .map(|(_, id)| id),
        AgentKind::Codex => find_completed_codex_jsonl(
            cwd,
            codex_sessions_root().as_deref(),
            recency_cutoff,
            process_start,
        )
        .map(|(_, id)| id),
        AgentKind::Antigravity => find_completed_antigravity_jsonl(
            cwd,
            &antigravity_brain_roots(),
            recency_cutoff,
            process_start,
        )
        .map(|(_, id)| id),
    }
}

fn scan_live_mappings(sessions: &[SessionPid]) -> Vec<(uuid::Uuid, AgentKind, String)> {
    let mut out = Vec::new();
    let refresh = ProcessRefreshKind::new()
        .with_cwd(UpdateKind::Always)
        .with_exe(UpdateKind::Always)
        .with_cmd(UpdateKind::Always);
    let mut sys = System::new_with_specifics(RefreshKind::new().with_processes(refresh));
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, refresh);

    let mut children: std::collections::HashMap<Pid, Vec<Pid>> = std::collections::HashMap::new();
    // Host-wide counts of live agent processes (tracked by Acorn or
    // not). The `/new` rotation in `pick_anchor_or_rotate` is only safe
    // when the paired process is the sole agent in scope — any second
    // live agent could be the writer of the hot later-born transcript,
    // so rotation stays off while one is around. claude/codex bucket
    // their transcripts by cwd, so the scope is per-cwd; antigravity
    // transcripts carry no cwd, so its scope is the whole host.
    let mut claude_cwd_counts: std::collections::HashMap<PathBuf, u32> =
        std::collections::HashMap::new();
    let mut codex_cwd_counts: std::collections::HashMap<PathBuf, u32> =
        std::collections::HashMap::new();
    let mut antigravity_count: u32 = 0;
    for (pid, proc) in sys.processes() {
        if let Some(parent) = proc.parent() {
            children.entry(parent).or_default().push(*pid);
        }
        if process_basename_matches(proc, "claude") {
            if let Some(cwd) = proc.cwd() {
                *claude_cwd_counts.entry(cwd.to_path_buf()).or_default() += 1;
            }
        } else if process_basename_matches(proc, "codex") {
            if let Some(cwd) = proc.cwd() {
                *codex_cwd_counts.entry(cwd.to_path_buf()).or_default() += 1;
            }
        } else if process_basename_matches(proc, "agy")
            || process_basename_matches(proc, "antigravity")
            || process_basename_matches(proc, "antigravity-cli")
        {
            antigravity_count += 1;
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
    let antigravity_roots = antigravity_brain_roots();

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

    for session in sessions {
        let Some(root_pid) = session.root_pid else {
            continue;
        };

        let mut stack = vec![Pid::from_u32(root_pid)];
        while let Some(pid) = stack.pop() {
            if let Some(proc) = sys.process(pid) {
                let kind = if process_basename_matches(proc, "claude") {
                    Some(AgentKind::Claude)
                } else if process_basename_matches(proc, "codex") {
                    Some(AgentKind::Codex)
                } else if process_basename_matches(proc, "agy")
                    || process_basename_matches(proc, "antigravity")
                    || process_basename_matches(proc, "antigravity-cli")
                {
                    Some(AgentKind::Antigravity)
                } else {
                    None
                };
                if let Some(kind) = kind {
                    if let Some(cwd) = proc.cwd().map(|p| p.to_path_buf()) {
                        let start_time =
                            SystemTime::UNIX_EPOCH + Duration::from_secs(proc.start_time());
                        candidates.push(Candidate {
                            session_id: session.session_id,
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
            AgentKind::Claude => {
                let sole_claude_in_cwd = claude_cwd_counts.get(&c.cwd).copied().unwrap_or(0) <= 1;
                find_recent_claude_jsonl(
                    &c.cwd,
                    claude_root.as_deref(),
                    recency_cutoff,
                    c.start_time,
                    now,
                    sole_claude_in_cwd,
                    &assigned,
                )
            }
            AgentKind::Codex => {
                let sole_codex_in_cwd = codex_cwd_counts.get(&c.cwd).copied().unwrap_or(0) <= 1;
                find_recent_codex_jsonl(
                    &c.cwd,
                    codex_root.as_deref(),
                    recency_cutoff,
                    c.start_time,
                    now,
                    sole_codex_in_cwd,
                    &assigned,
                )
            }
            AgentKind::Antigravity => find_recent_antigravity_jsonl(
                &antigravity_roots,
                recency_cutoff,
                c.start_time,
                now,
                antigravity_count <= 1,
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

fn process_basename_matches(proc: &sysinfo::Process, target: &str) -> bool {
    fn basename_matches(s: &str, target: &str) -> bool {
        let base = s.rsplit('/').next().unwrap_or(s);
        base == target
            || base.strip_suffix(".js") == Some(target)
            || base.strip_suffix(".mjs") == Some(target)
            || base.strip_suffix(".cjs") == Some(target)
    }

    if let Some(exe) = proc.exe().and_then(|p| p.to_str()) {
        if basename_matches(exe, target) {
            return true;
        }
    }
    if let Some(name) = proc.name().to_str() {
        if basename_matches(name, target) {
            return true;
        }
    }
    for arg in proc.cmd() {
        let s = arg.to_string_lossy();
        if basename_matches(&s, target) {
            return true;
        }
    }
    false
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
        .or_else(|| directories::UserDirs::new().map(|d| d.home_dir().join(".codex")))
        .map(|p| p.join("sessions"))
}

fn google_agent_storage_root() -> Option<PathBuf> {
    std::env::var_os("ANTIGRAVITY_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("GEMINI_DIR").map(PathBuf::from))
        .or_else(|| directories::UserDirs::new().map(|d| d.home_dir().join(".gemini")))
}

fn antigravity_brain_roots() -> Vec<PathBuf> {
    let Some(root) = google_agent_storage_root() else {
        return Vec::new();
    };
    ["antigravity", "antigravity-ide", "antigravity-cli"]
        .into_iter()
        .map(|profile| root.join(profile).join("brain"))
        .filter(|path| path.is_dir())
        .collect()
}

/// Resolve the JSONL transcript a `claude` process is currently writing
/// in the given cwd. Claude normally buckets transcripts by slugified cwd,
/// but the metadata fallback keeps pairing stable when that slug differs.
fn find_recent_claude_jsonl(
    cwd: &Path,
    projects_root: Option<&Path>,
    recency_cutoff: SystemTime,
    process_start: SystemTime,
    now: SystemTime,
    allow_rotation: bool,
    assigned: &HashSet<PathBuf>,
) -> Option<(PathBuf, String)> {
    let root = projects_root?;
    let slug_dir = root.join(slug_for_cwd(cwd));
    pick_newest_unassigned_jsonl(
        &slug_dir,
        recency_cutoff,
        process_start,
        now,
        allow_rotation,
        assigned,
    )
    .or_else(|| {
        find_recent_claude_jsonl_by_cwd(
            cwd,
            root,
            recency_cutoff,
            process_start,
            now,
            allow_rotation,
            assigned,
        )
    })
}

fn find_recent_claude_jsonl_by_cwd(
    cwd: &Path,
    projects_root: &Path,
    recency_cutoff: SystemTime,
    process_start: SystemTime,
    now: SystemTime,
    allow_rotation: bool,
    assigned: &HashSet<PathBuf>,
) -> Option<(PathBuf, String)> {
    let mut candidates: Vec<TranscriptCandidate> = Vec::new();
    for project in std::fs::read_dir(projects_root).ok()?.flatten() {
        let dir = project.path();
        if !dir.is_dir() {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            if assigned.contains(&path) {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            let Ok(mtime) = meta.modified() else { continue };
            if mtime < recency_cutoff || mtime < process_start {
                continue;
            }
            let Some(transcript_cwd) = read_agent_transcript_cwd(&path) else {
                continue;
            };
            if transcript_cwd != cwd {
                continue;
            }
            let Some(uuid) = extract_uuid_from_path(&path) else {
                continue;
            };
            let birth = meta.created().unwrap_or(mtime);
            candidates.push(TranscriptCandidate {
                path,
                birth,
                mtime,
                uuid,
            });
        }
    }
    pick_anchor_or_rotate(candidates, process_start, now, allow_rotation)
}

fn find_recent_codex_jsonl(
    cwd: &Path,
    sessions_root: Option<&Path>,
    recency_cutoff: SystemTime,
    process_start: SystemTime,
    now: SystemTime,
    allow_rotation: bool,
    assigned: &HashSet<PathBuf>,
) -> Option<(PathBuf, String)> {
    // Codex rollouts live under <root>/<year>/<month>/<day>/. The
    // filename does NOT encode the cwd (unlike claude), so we read each
    // candidate's first JSONL line and match its `payload.cwd` against
    // the live process's cwd. Walking just the newest date-dir keeps
    // the per-cycle work bounded. The cwd check runs while collecting
    // (not after ranking) so the rotation successor is also guaranteed
    // to belong to this cwd.
    let root = sessions_root?;
    let day_dir = newest_subdir(&newest_subdir(&newest_subdir(root)?)?)?;
    let mut candidates: Vec<TranscriptCandidate> = Vec::new();
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
        let Some(uuid) = extract_uuid_from_path(&path) else {
            continue;
        };
        if read_codex_transcript_cwd(&path).as_deref() != Some(cwd) {
            continue;
        }
        let birth = meta.created().unwrap_or(mtime);
        candidates.push(TranscriptCandidate {
            path,
            birth,
            mtime,
            uuid,
        });
    }
    pick_anchor_or_rotate(candidates, process_start, now, allow_rotation)
}

fn find_completed_codex_jsonl(
    cwd: &Path,
    sessions_root: Option<&Path>,
    recency_cutoff: SystemTime,
    process_start: SystemTime,
) -> Option<(PathBuf, String)> {
    let root = sessions_root?;
    let day_dir = newest_subdir(&newest_subdir(&newest_subdir(root)?)?)?;
    let mut candidates: Vec<(PathBuf, SystemTime, String)> = Vec::new();
    for entry in std::fs::read_dir(&day_dir).ok()?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(mtime) = meta.modified() else { continue };
        if mtime < recency_cutoff || mtime < process_start {
            continue;
        }
        let Some(transcript_cwd) = read_codex_transcript_cwd(&path) else {
            continue;
        };
        if transcript_cwd != cwd {
            continue;
        }
        let Some(uuid) = extract_uuid_from_path(&path) else {
            continue;
        };
        let created = meta.created().unwrap_or(mtime);
        candidates.push((path, created, uuid));
    }
    candidates.sort_by_key(|candidate| time_distance(candidate.1, process_start));
    if candidates.len() == 1 {
        let (path, _, id) = candidates.pop()?;
        Some((path, id))
    } else {
        None
    }
}

fn find_recent_antigravity_jsonl(
    brain_roots: &[PathBuf],
    recency_cutoff: SystemTime,
    process_start: SystemTime,
    now: SystemTime,
    allow_rotation: bool,
    assigned: &HashSet<PathBuf>,
) -> Option<(PathBuf, String)> {
    let mut candidates: Vec<TranscriptCandidate> = Vec::new();
    for root in brain_roots {
        let Ok(entries) = std::fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten() {
            let session_dir = entry.path();
            if !session_dir.is_dir() {
                continue;
            }
            let Some(uuid) = session_dir.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            if !is_uuid_v4_shape(uuid) {
                continue;
            }
            let path = session_dir
                .join(".system_generated")
                .join("logs")
                .join("transcript.jsonl");
            if assigned.contains(&path) || !path.is_file() {
                continue;
            }
            let Some(id) = antigravity_uuid_from_transcript_path(&path) else {
                continue;
            };
            let Ok(meta) = std::fs::metadata(&path) else {
                continue;
            };
            let Ok(mtime) = meta.modified() else { continue };
            if mtime < recency_cutoff || mtime < process_start {
                continue;
            }
            let birth = meta.created().unwrap_or(mtime);
            candidates.push(TranscriptCandidate {
                path,
                birth,
                mtime,
                uuid: id,
            });
        }
    }
    pick_anchor_or_rotate(candidates, process_start, now, allow_rotation)
}

fn find_completed_antigravity_jsonl(
    cwd: &Path,
    brain_roots: &[PathBuf],
    recency_cutoff: SystemTime,
    process_start: SystemTime,
) -> Option<(PathBuf, String)> {
    let mut candidates: Vec<(PathBuf, SystemTime, String)> = Vec::new();
    for root in brain_roots {
        let Ok(entries) = std::fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten() {
            let session_dir = entry.path();
            if !session_dir.is_dir() {
                continue;
            }
            let path = session_dir
                .join(".system_generated")
                .join("logs")
                .join("transcript.jsonl");
            if !path.is_file() {
                continue;
            }
            let Some(id) = antigravity_uuid_from_transcript_path(&path) else {
                continue;
            };
            let Ok(meta) = std::fs::metadata(&path) else {
                continue;
            };
            let Ok(mtime) = meta.modified() else { continue };
            if mtime < recency_cutoff || mtime < process_start {
                continue;
            }
            let Some(transcript_cwd) = read_agent_transcript_cwd(&path) else {
                continue;
            };
            if transcript_cwd != cwd {
                continue;
            }
            let created = meta.created().unwrap_or(mtime);
            candidates.push((path, created, id));
        }
    }
    candidates.sort_by_key(|candidate| time_distance(candidate.1, process_start));
    if candidates.len() == 1 {
        let (path, _, id) = candidates.pop()?;
        Some((path, id))
    } else {
        None
    }
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

fn read_agent_transcript_cwd(path: &Path) -> Option<PathBuf> {
    use std::io::{BufRead, BufReader};
    let f = std::fs::File::open(path).ok()?;
    let reader = BufReader::new(f);
    for line in reader.lines().map_while(Result::ok).take(50) {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        for key in ["cwd", "project"] {
            if let Some(path) = v.get(key).and_then(|c| c.as_str()) {
                return Some(PathBuf::from(path));
            }
            if let Some(path) = v
                .get("payload")
                .and_then(|p| p.get(key))
                .and_then(|c| c.as_str())
            {
                return Some(PathBuf::from(path));
            }
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
    now: SystemTime,
    allow_rotation: bool,
    assigned: &HashSet<PathBuf>,
) -> Option<(PathBuf, String)> {
    // We track two timestamps per candidate. `created` (file birth
    // time, falling back to mtime when btime is unavailable) is what
    // we rank by: when two `claude` processes run concurrently in the
    // same cwd, the one whose JSONL was *born* closest to the
    // process's own start time is its transcript. `mtime` is still
    // used as a recency filter so stale years-old files don't surface.
    let mut candidates: Vec<(PathBuf, SystemTime, SystemTime)> = Vec::new();
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
        let created = meta.created().unwrap_or(mtime);
        candidates.push((path, created, mtime));
    }
    let candidates = candidates
        .into_iter()
        .filter_map(|(path, birth, mtime)| {
            let uuid = extract_uuid_from_path(&path)?;
            Some(TranscriptCandidate {
                path,
                birth,
                mtime,
                uuid,
            })
        })
        .collect();
    pick_anchor_or_rotate(candidates, process_start, now, allow_rotation)
}

/// A transcript file eligible for pairing with a live agent process.
struct TranscriptCandidate {
    path: PathBuf,
    birth: SystemTime,
    mtime: SystemTime,
    uuid: String,
}

/// Shared tail of every `find_recent_*` matcher.
///
/// The candidate born closest to `process_start` is the anchor —
/// mtime-DESC order would hand the actively-written transcript (mtime
/// keeps advancing) to a younger sibling agent in the same cwd,
/// cross-contaminating their session-id capture. Ranking by proximity
/// of birth to `process_start` keeps each process paired with the file
/// it actually opened.
///
/// In-session `/new` continuity: the birth anchor stays correct for the
/// whole life of one conversation, but `/new` keeps the *same* process
/// alive while it stops writing the old transcript and opens a fresh
/// one born much later than the process start. Birth-proximity would
/// pin forever to that first transcript, so a stale tab title / resume
/// cursor never advances. Roll forward to the later-born file, gated
/// three ways so a neighbour's conversation is never adopted by
/// mistake:
///   1. the anchor must be dormant (its writer stopped appending) — a
///      sibling agent still writing the anchor keeps it hot, so a live
///      file is never stolen mid-write;
///   2. the successor must still be hot — files left behind by an
///      exited sibling tab or a one-shot run go dormant within seconds
///      of their writer dying, while our own post-/new transcript is
///      the one being appended right now;
///   3. the caller must vouch via `allow_rotation` that this process is
///      the only matching agent in scope (same cwd for claude/codex,
///      host-wide for antigravity, whose transcripts carry no cwd) —
///      with a second live agent around, the hot later-born file may be
///      theirs, so ambiguity falls back to the anchor (old behaviour).
///
/// Tracked siblings are also excluded via `assigned` upstream.
fn pick_anchor_or_rotate(
    mut candidates: Vec<TranscriptCandidate>,
    process_start: SystemTime,
    now: SystemTime,
    allow_rotation: bool,
) -> Option<(PathBuf, String)> {
    candidates.sort_by_key(|c| time_distance(c.birth, process_start));
    let anchor = candidates.first()?;

    let dormant_before = now
        .checked_sub(Duration::from_secs(DORMANT_TRANSCRIPT_SECS))
        .unwrap_or(SystemTime::UNIX_EPOCH);
    if allow_rotation && anchor.mtime < dormant_before {
        let successor = candidates
            .iter()
            .filter(|c| c.birth > anchor.birth && c.mtime > anchor.mtime)
            .filter(|c| c.mtime >= dormant_before)
            .max_by_key(|c| c.birth);
        if let Some(c) = successor {
            return Some((c.path.clone(), c.uuid.clone()));
        }
    }

    Some((anchor.path.clone(), anchor.uuid.clone()))
}

/// Absolute difference between two `SystemTime`s as seconds. Saturates
/// to `u64::MAX` if the duration is unrepresentable.
fn time_distance(a: SystemTime, b: SystemTime) -> u64 {
    a.duration_since(b)
        .or_else(|_| b.duration_since(a))
        .map(|d| d.as_secs())
        .unwrap_or(u64::MAX)
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

fn antigravity_uuid_from_transcript_path(path: &Path) -> Option<String> {
    let filename = path.file_name()?.to_str()?;
    if filename != "transcript.jsonl" {
        return None;
    }
    let logs = path.parent()?.file_name()?.to_str()?;
    let generated = path.parent()?.parent()?.file_name()?.to_str()?;
    if logs != "logs" || generated != ".system_generated" {
        return None;
    }
    let uuid = path.parent()?.parent()?.parent()?.file_name()?.to_str()?;
    is_uuid_v4_shape(uuid).then(|| uuid.to_string())
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
    fn slug_for_simple_cwd() {
        assert_eq!(slug_for_cwd(Path::new("/Users/me/proj")), "-Users-me-proj");
    }

    #[test]
    fn slug_for_cwd_with_dot_dirs() {
        // Claude doubles the leading dash before any `.` segment.
        assert_eq!(
            slug_for_cwd(Path::new("/Users/me/proj/.claude/worktrees/foo")),
            "-Users-me-proj--claude-worktrees-foo"
        );
    }

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

    #[test]
    fn extracts_uuid_from_antigravity_transcript_path() {
        let path = Path::new(
            "/Users/me/.gemini/antigravity/brain/17f38e8c-3a7e-408b-8c79-aef7432c0fd2/.system_generated/logs/transcript.jsonl",
        );
        assert_eq!(
            antigravity_uuid_from_transcript_path(path).as_deref(),
            Some("17f38e8c-3a7e-408b-8c79-aef7432c0fd2")
        );
    }

    #[test]
    fn claude_lookup_falls_back_to_cwd_metadata_when_slug_dir_differs() {
        use std::fs::{self, File};
        use std::io::Write;

        let root = std::env::temp_dir().join(format!(
            "acorn-claude-cwd-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let projects = root.join("projects");
        let unexpected_slug = projects.join("-Users-me-project-with-alt-encoding");
        let cwd = root.join("repo");
        fs::create_dir_all(&unexpected_slug).unwrap();
        fs::create_dir_all(&cwd).unwrap();

        let id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        let transcript = unexpected_slug.join(format!("{id}.jsonl"));
        let mut file = File::create(&transcript).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "sessionId": id,
                "cwd": cwd.display().to_string(),
            })
        )
        .unwrap();

        let found = find_recent_claude_jsonl(
            &cwd,
            Some(&projects),
            SystemTime::UNIX_EPOCH,
            SystemTime::UNIX_EPOCH,
            SystemTime::UNIX_EPOCH,
            true,
            &HashSet::new(),
        );

        assert_eq!(found.map(|(_, found_id)| found_id).as_deref(), Some(id));
        fs::remove_dir_all(&root).unwrap();
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
        let dir =
            std::env::temp_dir().join(format!("acorn-mtime-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&dir).unwrap();
        let jsonl = dir.join("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl");
        File::create(&jsonl).unwrap();
        let mtime = fs::metadata(&jsonl).unwrap().modified().unwrap();
        // Process start equals transcript mtime → must include (>=).
        let result = pick_newest_unassigned_jsonl(
            &dir,
            SystemTime::UNIX_EPOCH,
            mtime,
            mtime,
            true,
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
            later,
            true,
            &HashSet::new(),
        );
        assert!(
            result_later.is_none(),
            "transcript predating the process must be excluded"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    /// Backdate a file's mtime so dormancy scenarios don't need real
    /// sleeps. Birth time (btime) cannot be set after the fact, so tests
    /// still create files in real birth order (with a >1s gap — both
    /// btime and sysinfo start times round to seconds on macOS).
    fn set_mtime(path: &Path, t: SystemTime) {
        let f = std::fs::File::options().write(true).open(path).unwrap();
        f.set_times(std::fs::FileTimes::new().set_modified(t))
            .unwrap();
    }

    const A_UUID: &str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const B_UUID: &str = "11111111-2222-3333-4444-555555555555";

    /// Create transcripts A then B (distinct birth seconds) and return
    /// (dir, a_path, b_path, b_mtime).
    fn two_transcripts(tag: &str) -> (PathBuf, PathBuf, PathBuf, SystemTime) {
        use std::fs::{self, File};
        let dir =
            std::env::temp_dir().join(format!("acorn-{tag}-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&dir).unwrap();
        let a = dir.join(format!("{A_UUID}.jsonl"));
        File::create(&a).unwrap();
        std::thread::sleep(Duration::from_millis(1100));
        let b = dir.join(format!("{B_UUID}.jsonl"));
        File::create(&b).unwrap();
        let b_mtime = fs::metadata(&b).unwrap().modified().unwrap();
        (dir, a, b, b_mtime)
    }

    /// `claude /new` keeps the same process alive but opens a fresh
    /// transcript born long after the process started. Birth-proximity
    /// alone would pin forever to the first JSONL; once the anchor has
    /// gone dormant and the successor is the file being written right
    /// now, the pairing must roll forward so a tab title / resume cursor
    /// tracks the live conversation.
    #[test]
    fn pick_newest_unassigned_jsonl_follows_dormant_new_rotation() {
        let (dir, a, _b, b_mtime) = two_transcripts("newrot");
        // A stopped being written a minute ago; B was written just now.
        let a_mtime = b_mtime - Duration::from_secs(60);
        set_mtime(&a, a_mtime);
        let process_start = a_mtime;
        let now = b_mtime;
        let picked = pick_newest_unassigned_jsonl(
            &dir,
            SystemTime::UNIX_EPOCH,
            process_start,
            now,
            true,
            &HashSet::new(),
        );
        assert_eq!(
            picked.map(|(_, id)| id).as_deref(),
            Some(B_UUID),
            "dormant anchor must roll forward to the hot post-/new transcript"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// The dormancy gate must not steal a still-hot sibling transcript:
    /// when the birth-anchored pick is still being written (a concurrent
    /// claude in the same cwd), a newer-born file is left alone even
    /// though it exists. Only a dormant anchor rolls forward.
    #[test]
    fn pick_newest_unassigned_jsonl_keeps_hot_anchor_over_newer_sibling() {
        use std::fs;
        let (dir, a, _b, b_mtime) = two_transcripts("hotanchor");
        let a_mtime = fs::metadata(&a).unwrap().modified().unwrap();
        let process_start = a_mtime;
        // `now` is right at the sibling's write → the anchor is still
        // within the dormancy window, so it stays paired.
        let now = b_mtime;
        let picked = pick_newest_unassigned_jsonl(
            &dir,
            SystemTime::UNIX_EPOCH,
            process_start,
            now,
            true,
            &HashSet::new(),
        );
        assert_eq!(
            picked.map(|(_, id)| id).as_deref(),
            Some(A_UUID),
            "a hot anchor must not roll forward to a newer-born sibling file"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    /// A transcript left behind by an exited sibling tab (or a one-shot
    /// `claude -p` run) is later-born but cold. A dormant anchor must NOT
    /// adopt it — only a successor that is actively being written (hot)
    /// can be our own post-/new file.
    #[test]
    fn pick_newest_unassigned_jsonl_ignores_cold_leftover_sibling_file() {
        let (dir, a, b, b_mtime_real) = two_transcripts("coldsib");
        // Anchor went quiet 60s ago; the leftover stopped 30s ago. Both
        // cold relative to `now`.
        let a_mtime = b_mtime_real - Duration::from_secs(60);
        let b_mtime = b_mtime_real - Duration::from_secs(30);
        set_mtime(&a, a_mtime);
        set_mtime(&b, b_mtime);
        let process_start = a_mtime;
        let now = b_mtime_real;
        let picked = pick_newest_unassigned_jsonl(
            &dir,
            SystemTime::UNIX_EPOCH,
            process_start,
            now,
            true,
            &HashSet::new(),
        );
        assert_eq!(
            picked.map(|(_, id)| id).as_deref(),
            Some(A_UUID),
            "a cold leftover file must never be adopted by a dormant anchor"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// With `allow_rotation: false` (a second live claude shares the cwd,
    /// or the completed-run path) the rotation must not fire even when
    /// the anchor is dormant and a hot successor exists — the hot file
    /// may belong to the other process.
    #[test]
    fn pick_newest_unassigned_jsonl_skips_rotation_when_not_sole_agent() {
        let (dir, a, _b, b_mtime) = two_transcripts("norot");
        let a_mtime = b_mtime - Duration::from_secs(60);
        set_mtime(&a, a_mtime);
        let process_start = a_mtime;
        let now = b_mtime;
        let picked = pick_newest_unassigned_jsonl(
            &dir,
            SystemTime::UNIX_EPOCH,
            process_start,
            now,
            false,
            &HashSet::new(),
        );
        assert_eq!(
            picked.map(|(_, id)| id).as_deref(),
            Some(A_UUID),
            "rotation must stay off when the process is not the sole claude in cwd"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Codex `/new` keeps the same process alive and opens a fresh
    /// rollout, exactly like claude — and the successor must match the
    /// process's cwd, so a hot later-born rollout from another directory
    /// is never adopted.
    #[test]
    fn find_recent_codex_jsonl_rotates_within_cwd_only() {
        use std::fs::{self, File};
        use std::io::Write;

        let root =
            std::env::temp_dir().join(format!("acorn-cxrot-{}", uuid::Uuid::new_v4().simple()));
        let day = root.join("sessions").join("2026").join("06").join("10");
        fs::create_dir_all(&day).unwrap();
        let cwd = root.join("repo");
        let other_cwd = root.join("elsewhere");

        let write_rollout = |name: &str, transcript_cwd: &Path| {
            let path = day.join(name);
            let mut f = File::create(&path).unwrap();
            writeln!(
                f,
                "{{\"payload\":{{\"cwd\":\"{}\"}}}}",
                transcript_cwd.display()
            )
            .unwrap();
            path
        };
        // Birth order: A, then B (ours, post-/new), then decoy C in a
        // different cwd born last — if the cwd filter broke, C would win
        // the successor pick.
        let a = write_rollout(
            "rollout-2026-06-10T10-00-00-019e2001-3250-76b0-8410-2e073b38a2c1.jsonl",
            &cwd,
        );
        std::thread::sleep(Duration::from_millis(1100));
        let b = write_rollout(
            "rollout-2026-06-10T10-00-01-019e2001-3250-76b0-8410-2e073b38a2c2.jsonl",
            &cwd,
        );
        std::thread::sleep(Duration::from_millis(1100));
        let decoy = write_rollout(
            "rollout-2026-06-10T10-00-02-019e2001-3250-76b0-8410-2e073b38a2c3.jsonl",
            &other_cwd,
        );
        let now = fs::metadata(&decoy).unwrap().modified().unwrap();
        // A dormant; B and the decoy hot.
        let a_mtime = now - Duration::from_secs(60);
        set_mtime(&a, a_mtime);
        set_mtime(&b, now);
        let process_start = a_mtime;

        let picked = find_recent_codex_jsonl(
            &cwd,
            Some(&root.join("sessions")),
            SystemTime::UNIX_EPOCH,
            process_start,
            now,
            true,
            &HashSet::new(),
        );
        assert_eq!(
            picked.map(|(_, id)| id).as_deref(),
            Some("019e2001-3250-76b0-8410-2e073b38a2c2"),
            "dormant codex anchor must roll forward to the hot same-cwd rollout"
        );

        let pinned = find_recent_codex_jsonl(
            &cwd,
            Some(&root.join("sessions")),
            SystemTime::UNIX_EPOCH,
            process_start,
            now,
            false,
            &HashSet::new(),
        );
        assert_eq!(
            pinned.map(|(_, id)| id).as_deref(),
            Some("019e2001-3250-76b0-8410-2e073b38a2c1"),
            "rotation must stay off when not the sole codex in cwd"
        );

        fs::remove_dir_all(&root).unwrap();
    }

    /// Antigravity `/new` keeps the same `agy` process alive and creates
    /// a fresh brain conversation; a dormant anchor must roll forward to
    /// the hot one, and only when agy is the sole live instance.
    #[test]
    fn find_recent_antigravity_jsonl_rotates_to_hot_brain() {
        use std::fs::{self, File};

        let root =
            std::env::temp_dir().join(format!("acorn-agrot-{}", uuid::Uuid::new_v4().simple()));
        let brain = root.join("brain");
        let make_brain = |uuid: &str| {
            let t = brain
                .join(uuid)
                .join(".system_generated")
                .join("logs")
                .join("transcript.jsonl");
            fs::create_dir_all(t.parent().unwrap()).unwrap();
            File::create(&t).unwrap();
            t
        };
        let a_id = "17f38e8c-3a7e-408b-8c79-aef7432c0fd2";
        let b_id = "28a49f9d-4b8f-419c-9d8a-bf0854310e03";
        let a = make_brain(a_id);
        std::thread::sleep(Duration::from_millis(1100));
        let b = make_brain(b_id);
        let now = fs::metadata(&b).unwrap().modified().unwrap();
        let a_mtime = now - Duration::from_secs(60);
        set_mtime(&a, a_mtime);
        let process_start = a_mtime;

        let picked = find_recent_antigravity_jsonl(
            &[brain.clone()],
            SystemTime::UNIX_EPOCH,
            process_start,
            now,
            true,
            &HashSet::new(),
        );
        assert_eq!(
            picked.map(|(_, id)| id).as_deref(),
            Some(b_id),
            "dormant antigravity anchor must roll forward to the hot brain"
        );

        let pinned = find_recent_antigravity_jsonl(
            &[brain],
            SystemTime::UNIX_EPOCH,
            process_start,
            now,
            false,
            &HashSet::new(),
        );
        assert_eq!(
            pinned.map(|(_, id)| id).as_deref(),
            Some(a_id),
            "rotation must stay off when agy is not the sole live instance"
        );

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn completed_codex_run_requires_one_matching_cwd() {
        use std::fs::{self, File};
        use std::io::Write;

        let root =
            std::env::temp_dir().join(format!("acorn-codex-{}", uuid::Uuid::new_v4().simple()));
        let day = root.join("sessions").join("2026").join("06").join("02");
        fs::create_dir_all(&day).unwrap();
        let cwd = root.join("repo");
        let matching_id = "019e2001-3250-76b0-8410-2e073b38a2c1";
        let matching = day.join(format!("rollout-2026-06-02T10-00-00-{matching_id}.jsonl"));
        let mut file = File::create(&matching).unwrap();
        writeln!(file, "{{\"payload\":{{\"cwd\":\"{}\"}}}}", cwd.display()).unwrap();

        let found = find_completed_codex_jsonl(
            &cwd,
            Some(&root.join("sessions")),
            SystemTime::UNIX_EPOCH,
            SystemTime::UNIX_EPOCH,
        );
        assert_eq!(found.map(|(_, id)| id).as_deref(), Some(matching_id));

        let other_id = "019e2001-3250-76b0-8410-2e073b38a2c2";
        let other = day.join(format!("rollout-2026-06-02T10-00-01-{other_id}.jsonl"));
        let mut file = File::create(&other).unwrap();
        writeln!(file, "{{\"payload\":{{\"cwd\":\"{}\"}}}}", cwd.display()).unwrap();
        let ambiguous = find_completed_codex_jsonl(
            &cwd,
            Some(&root.join("sessions")),
            SystemTime::UNIX_EPOCH,
            SystemTime::UNIX_EPOCH,
        );
        assert!(ambiguous.is_none());

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn completed_antigravity_run_requires_matching_cwd() {
        use std::fs::{self, File};
        use std::io::Write;

        let root = std::env::temp_dir().join(format!(
            "acorn-antigravity-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let brain = root.join("brain");
        let cwd = root.join("repo");
        let id = "17f38e8c-3a7e-408b-8c79-aef7432c0fd2";
        let transcript = brain
            .join(id)
            .join(".system_generated")
            .join("logs")
            .join("transcript.jsonl");
        fs::create_dir_all(transcript.parent().unwrap()).unwrap();
        let mut file = File::create(&transcript).unwrap();
        writeln!(file, "{{\"cwd\":\"{}\"}}", cwd.display()).unwrap();

        let found = find_completed_antigravity_jsonl(
            &cwd,
            &[brain],
            SystemTime::UNIX_EPOCH,
            SystemTime::UNIX_EPOCH,
        );
        assert_eq!(found.map(|(_, id)| id).as_deref(), Some(id));

        fs::remove_dir_all(&root).unwrap();
    }
}
