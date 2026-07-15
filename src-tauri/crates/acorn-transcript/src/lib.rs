//! On-demand process-inspection pairing for live agent processes.
//!
//! Each call walks every Acorn session's PTY descendant tree, picks
//! the `claude` / `codex` / `antigravity` processes, and resolves each one
//! to the transcript file it is currently writing. The returned UUID is
//! what `claude --resume <id>` / `codex fork <id>` expect, or the
//! Antigravity brain id for Antigravity sessions.
//!
//! `collect_live_mappings` returns every live agent process for UI affordances
//! such as Fork. `collect_session_owner_mappings` stops at the first agent
//! boundary in each process-tree branch so durable resume markers track the
//! user-facing session owner instead of a nested sub-agent.
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

use acorn_agent::AgentKind;
use chrono::{Datelike, Local, TimeZone, Utc};
use parking_lot::Mutex;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System, UpdateKind};

mod line;

pub use line::{
    assistant_message_text, collapse_preview, latest_turn_state, parse_transcript_line,
    parse_transcript_value, read_tail, ParsedTranscriptLine, TailRead, TranscriptRole, TurnState,
};

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

type OwnerTranscriptQuarantine = std::collections::HashMap<uuid::Uuid, HashSet<PathBuf>>;
type OwnerRotationQuarantine = std::collections::HashMap<OwnerRotationScope, SystemTime>;

fn owner_transcript_quarantine() -> &'static Mutex<OwnerTranscriptQuarantine> {
    static QUARANTINE: OnceLock<Mutex<OwnerTranscriptQuarantine>> = OnceLock::new();
    QUARANTINE.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

fn owner_rotation_quarantine() -> &'static Mutex<OwnerRotationQuarantine> {
    static QUARANTINE: OnceLock<Mutex<OwnerRotationQuarantine>> = OnceLock::new();
    QUARANTINE.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

fn scan_cache() -> &'static Mutex<Option<ScanCache>> {
    static CACHE: OnceLock<Mutex<Option<ScanCache>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn owner_scan_cache() -> &'static Mutex<Option<ScanCache>> {
    static CACHE: OnceLock<Mutex<Option<ScanCache>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MappingScope {
    AllDescendants,
    SessionOwners,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CodexRolloutScope {
    AnyTerminal,
    SessionOwner,
    ResumedOwner,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AgentProcessRole {
    Emit,
    Quarantine,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct AgentProcessMatch {
    pid: Pid,
    kind: AgentKind,
    role: AgentProcessRole,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct OwnerRotationScope {
    session_id: uuid::Uuid,
    kind: AgentKind,
    cwd: Option<PathBuf>,
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
    collect_mappings_cached(scan_cache(), sessions, MappingScope::AllDescendants)
}

/// Pair the top-level user-facing agent process in each Acorn session branch.
/// Non-agent wrappers are transparent, but once an agent process is found its
/// children are excluded so nested sub-agents cannot overwrite the parent
/// session's durable resume marker.
pub fn collect_session_owner_mappings(
    sessions: &[SessionPid],
) -> Vec<(uuid::Uuid, AgentKind, String)> {
    collect_mappings_cached(owner_scan_cache(), sessions, MappingScope::SessionOwners)
}

fn collect_mappings_cached(
    cache: &'static Mutex<Option<ScanCache>>,
    sessions: &[SessionPid],
    scope: MappingScope,
) -> Vec<(uuid::Uuid, AgentKind, String)> {
    {
        let guard = cache.lock();
        if let Some(cache) = guard.as_ref() {
            if cache.captured_at.elapsed() < Duration::from_millis(SCAN_CACHE_TTL_MS) {
                return cache.mappings.clone();
            }
        }
    }
    let mappings = scan_live_mappings(sessions, scope);
    *cache.lock() = Some(ScanCache {
        captured_at: Instant::now(),
        mappings: mappings.clone(),
    });
    mappings
}

/// Resolve the provider conversation id created by an agent run in `cwd`.
/// Native chat uses this after non-interactive one-shot CLI calls that
/// create provider-side transcripts but do not print their id on stdout;
/// the path-returning sibling below also serves live processes.
///
/// The helper intentionally returns `None` for ambiguous matches instead
/// of guessing. A wrong provider cursor would silently resume another chat,
/// while `None` only falls back to Acorn's compiled context on the next turn.
pub fn find_completed_agent_run(
    cwd: &Path,
    kind: AgentKind,
    process_start: SystemTime,
) -> Option<String> {
    find_agent_run_transcript(cwd, kind, process_start).map(|(_, id)| id)
}

/// Path-returning form of [`find_completed_agent_run`]. The status poll's
/// codex marker fallback needs the transcript path (to read status and
/// previews) alongside the id it persists, under the same conservative
/// matching policy.
pub fn find_agent_run_transcript(
    cwd: &Path,
    kind: AgentKind,
    process_start: SystemTime,
) -> Option<(PathBuf, String)> {
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
        ),
        AgentKind::Codex => find_completed_codex_jsonl(
            cwd,
            codex_sessions_root().as_deref(),
            recency_cutoff,
            process_start,
        ),
        AgentKind::Antigravity => find_completed_antigravity_jsonl(
            cwd,
            &antigravity_brain_roots(),
            recency_cutoff,
            process_start,
        ),
    }
}

/// Resolve a Codex rollout for an explicit `codex resume` invocation whose
/// picker/flag did not expose the selected UUID in argv. A rollout retains its
/// original `source.subagent` metadata when the user deliberately resumes it
/// as a top-level conversation, so this narrow path allows such a writer.
pub fn find_resumed_codex_run_transcript(
    cwd: &Path,
    process_start: SystemTime,
) -> Option<(PathBuf, String)> {
    let now = SystemTime::now();
    let recency_cutoff = now
        .checked_sub(Duration::from_secs(RECENCY_WINDOW_SECS))
        .unwrap_or(SystemTime::UNIX_EPOCH);
    find_completed_resumed_codex_jsonl(
        cwd,
        codex_sessions_root().as_deref(),
        recency_cutoff,
        process_start,
    )
}

fn scan_live_mappings(
    sessions: &[SessionPid],
    scope: MappingScope,
) -> Vec<(uuid::Uuid, AgentKind, String)> {
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
    let now = SystemTime::now();
    let recency_cutoff = now
        .checked_sub(Duration::from_secs(RECENCY_WINDOW_SECS))
        .unwrap_or(SystemTime::UNIX_EPOCH);
    let mut assigned: HashSet<PathBuf> = HashSet::new();
    let mut owner_quarantined = if scope == MappingScope::SessionOwners {
        active_owner_quarantined_paths(now)
    } else {
        std::collections::HashMap::new()
    };
    let mut owner_rotation_quarantined = if scope == MappingScope::SessionOwners {
        active_owner_rotation_quarantines(now)
    } else {
        HashSet::new()
    };

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
        explicit_transcript_id: Option<String>,
        codex_resume_requested: bool,
        role: AgentProcessRole,
    }
    let mut candidates: Vec<Candidate> = Vec::new();

    for session in sessions {
        let Some(root_pid) = session.root_pid else {
            continue;
        };

        let matches =
            collect_agent_processes_in_tree(&children, Pid::from_u32(root_pid), scope, |pid| {
                let proc = sys.process(pid)?;
                if process_basename_matches(proc, "claude") {
                    return Some(AgentKind::Claude);
                }
                if process_basename_matches(proc, "codex") {
                    return Some(AgentKind::Codex);
                }
                if process_basename_matches(proc, "agy")
                    || process_basename_matches(proc, "antigravity")
                    || process_basename_matches(proc, "antigravity-cli")
                {
                    return Some(AgentKind::Antigravity);
                }
                None
            });

        for process_match in matches {
            if let Some(proc) = sys.process(process_match.pid) {
                if let Some(cwd) = proc.cwd().map(|p| p.to_path_buf()) {
                    let start_time =
                        SystemTime::UNIX_EPOCH + Duration::from_secs(proc.start_time());
                    let explicit_transcript_id = match process_match.kind {
                        AgentKind::Claude => claude_resume_id_from_process(proc),
                        AgentKind::Codex => codex_resume_id_from_process(proc),
                        AgentKind::Antigravity => None,
                    };
                    let codex_resume_requested = process_match.kind == AgentKind::Codex
                        && codex_resume_requested_from_process(proc);
                    candidates.push(Candidate {
                        session_id: session.session_id,
                        kind: process_match.kind,
                        pid: process_match.pid.as_u32(),
                        cwd,
                        start_time,
                        explicit_transcript_id,
                        codex_resume_requested,
                        role: process_match.role,
                    });
                }
            }
        }
    }

    if scope == MappingScope::SessionOwners {
        for c in candidates
            .iter()
            .filter(|c| c.role == AgentProcessRole::Quarantine)
        {
            let rotation_scope = owner_rotation_scope(c.session_id, c.kind, &c.cwd);
            remember_owner_rotation_quarantine(&rotation_scope, now);
            owner_rotation_quarantined.insert(rotation_scope);
        }
    }

    // Codex owner scans must let the top-level process claim its transcript
    // before descendant processes reserve theirs. A shell wrapper, node shim,
    // and native binary can all contain a `codex` argv entry and therefore look
    // like nested agent processes. Other providers and all-descendant scans
    // retain newest-first ordering.
    candidates.sort_by(|a, b| {
        let is_codex_owner = |candidate: &Candidate| {
            scope == MappingScope::SessionOwners
                && candidate.kind == AgentKind::Codex
                && candidate.role == AgentProcessRole::Emit
        };
        is_codex_owner(b)
            .cmp(&is_codex_owner(a))
            .then_with(|| b.start_time.cmp(&a.start_time))
    });

    for c in candidates {
        let mut reserved = assigned.clone();
        if c.role == AgentProcessRole::Emit {
            if let Some(paths) = owner_quarantined.get(&c.session_id) {
                reserved.extend(paths.iter().cloned());
            }
        }
        let candidate = match c.kind {
            AgentKind::Claude => {
                let sole_claude_in_cwd = claude_cwd_counts.get(&c.cwd).copied().unwrap_or(0) <= 1;
                let allow_rotation = sole_claude_in_cwd
                    && !owner_rotation_quarantined.contains(&owner_rotation_scope(
                        c.session_id,
                        c.kind,
                        &c.cwd,
                    ));
                c.explicit_transcript_id
                    .as_deref()
                    .and_then(|id| {
                        find_claude_jsonl_for_uuid(&c.cwd, claude_root.as_deref(), id, &assigned)
                    })
                    .or_else(|| {
                        find_recent_claude_jsonl(
                            &c.cwd,
                            claude_root.as_deref(),
                            recency_cutoff,
                            c.start_time,
                            now,
                            allow_rotation,
                            &reserved,
                        )
                    })
            }
            AgentKind::Codex => {
                let sole_codex_in_cwd = codex_cwd_counts.get(&c.cwd).copied().unwrap_or(0) <= 1;
                let allow_rotation = sole_codex_in_cwd
                    && !owner_rotation_quarantined.contains(&owner_rotation_scope(
                        c.session_id,
                        c.kind,
                        &c.cwd,
                    ));
                // `codex resume <uuid>` may attach to an existing JSONL before
                // Codex appends a new line, so the normal mtime >= process-start
                // guard would hide the active transcript.
                c.explicit_transcript_id
                    .as_deref()
                    .and_then(|id| find_codex_jsonl_for_uuid(codex_root.as_deref(), id, &assigned))
                    .or_else(|| {
                        match codex_rollout_scope_for_mapping(
                            scope,
                            c.role,
                            c.codex_resume_requested,
                        ) {
                            CodexRolloutScope::SessionOwner => find_recent_codex_owner_jsonl(
                                &c.cwd,
                                codex_root.as_deref(),
                                recency_cutoff,
                                c.start_time,
                                now,
                                allow_rotation,
                                &reserved,
                            ),
                            CodexRolloutScope::ResumedOwner => find_recent_resumed_codex_jsonl(
                                &c.cwd,
                                codex_root.as_deref(),
                                recency_cutoff,
                                c.start_time,
                                now,
                                allow_rotation,
                                &reserved,
                            ),
                            CodexRolloutScope::AnyTerminal => find_recent_codex_jsonl(
                                &c.cwd,
                                codex_root.as_deref(),
                                recency_cutoff,
                                c.start_time,
                                now,
                                allow_rotation,
                                &reserved,
                            ),
                        }
                    })
            }
            AgentKind::Antigravity => {
                let allow_rotation = antigravity_count <= 1
                    && !owner_rotation_quarantined.contains(&owner_rotation_scope(
                        c.session_id,
                        c.kind,
                        &c.cwd,
                    ));
                find_recent_antigravity_jsonl(
                    &antigravity_roots,
                    recency_cutoff,
                    c.start_time,
                    now,
                    allow_rotation,
                    &reserved,
                )
            }
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
            assigned.insert(path.clone());
            if c.role == AgentProcessRole::Quarantine {
                remember_owner_quarantined_path(c.session_id, &path);
                continue;
            }
            if scope == MappingScope::SessionOwners {
                release_owner_quarantined_path(c.session_id, &path);
                if let Some(paths) = owner_quarantined.get_mut(&c.session_id) {
                    paths.remove(&path);
                    if paths.is_empty() {
                        owner_quarantined.remove(&c.session_id);
                    }
                }
            }
            out.push((c.session_id, c.kind, uuid));
        } else {
            // A live agent process with no matching transcript is the
            // failure this scan exists to prevent — downstream, resume
            // and tab-title generation silently stall on it. Keep the
            // miss visible.
            tracing::debug!(
                session_id = %c.session_id,
                kind = ?c.kind,
                pid = c.pid,
                cwd = ?c.cwd,
                role = ?c.role,
                "transcript_watcher: live agent matched no transcript this cycle"
            );
        }
    }

    out
}

fn collect_agent_processes_in_tree<F>(
    children: &std::collections::HashMap<Pid, Vec<Pid>>,
    root: Pid,
    scope: MappingScope,
    mut kind_for_pid: F,
) -> Vec<AgentProcessMatch>
where
    F: FnMut(Pid) -> Option<AgentKind>,
{
    let mut out = Vec::new();
    let mut stack = vec![(root, false)];
    while let Some((pid, below_agent_boundary)) = stack.pop() {
        let mut next_below_agent_boundary = below_agent_boundary;
        if let Some(kind) = kind_for_pid(pid) {
            let role = if scope == MappingScope::SessionOwners && below_agent_boundary {
                AgentProcessRole::Quarantine
            } else {
                AgentProcessRole::Emit
            };
            out.push(AgentProcessMatch { pid, kind, role });
            next_below_agent_boundary =
                below_agent_boundary || scope == MappingScope::SessionOwners;
        }
        if let Some(kids) = children.get(&pid) {
            stack.extend(
                kids.iter()
                    .copied()
                    .map(|kid| (kid, next_below_agent_boundary)),
            );
        }
    }
    out
}

/// Snapshot the by-path owner quarantine, evicting entries that can no
/// longer affect pairing. Every mtime-based picker rejects transcripts
/// older than `RECENCY_WINDOW_SECS`, so once a quarantined file is gone
/// or its mtime has aged out of that window the reservation is dead
/// weight — and session ids are never reused, so without this prune the
/// map would grow for the life of the process.
fn active_owner_quarantined_paths(
    now: SystemTime,
) -> std::collections::HashMap<uuid::Uuid, HashSet<PathBuf>> {
    let recency_cutoff = now
        .checked_sub(Duration::from_secs(RECENCY_WINDOW_SECS))
        .unwrap_or(SystemTime::UNIX_EPOCH);
    let mut guard = owner_transcript_quarantine().lock();
    guard.retain(|_, paths| {
        paths.retain(|path| {
            std::fs::metadata(path)
                .ok()
                .filter(|meta| meta.is_file())
                .and_then(|meta| meta.modified().ok())
                .is_some_and(|mtime| mtime >= recency_cutoff)
        });
        !paths.is_empty()
    });
    guard.clone()
}

fn remember_owner_quarantined_path(session_id: uuid::Uuid, path: &Path) {
    owner_transcript_quarantine()
        .lock()
        .entry(session_id)
        .or_default()
        .insert(path.to_path_buf());
}

fn release_owner_quarantined_path(session_id: uuid::Uuid, path: &Path) {
    let mut guard = owner_transcript_quarantine().lock();
    if let Some(paths) = guard.get_mut(&session_id) {
        paths.remove(path);
        if paths.is_empty() {
            guard.remove(&session_id);
        }
    }
}

fn active_owner_rotation_quarantines(now: SystemTime) -> HashSet<OwnerRotationScope> {
    let mut guard = owner_rotation_quarantine().lock();
    guard.retain(|_, expires_at| *expires_at >= now);
    guard.keys().cloned().collect()
}

fn remember_owner_rotation_quarantine(scope: &OwnerRotationScope, now: SystemTime) {
    let expires_at = now
        .checked_add(Duration::from_secs(DORMANT_TRANSCRIPT_SECS))
        .unwrap_or(now);
    owner_rotation_quarantine()
        .lock()
        .insert(scope.clone(), expires_at);
}

fn owner_rotation_scope(session_id: uuid::Uuid, kind: AgentKind, cwd: &Path) -> OwnerRotationScope {
    OwnerRotationScope {
        session_id,
        kind,
        cwd: match kind {
            AgentKind::Claude | AgentKind::Codex => Some(cwd.to_path_buf()),
            AgentKind::Antigravity => None,
        },
    }
}

fn basename_matches(s: &str, target: &str) -> bool {
    let base = s.rsplit('/').next().unwrap_or(s);
    base == target
        || base.strip_suffix(".js") == Some(target)
        || base.strip_suffix(".mjs") == Some(target)
        || base.strip_suffix(".cjs") == Some(target)
}

fn process_basename_matches(proc: &sysinfo::Process, target: &str) -> bool {
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

fn codex_resume_id_from_process(proc: &sysinfo::Process) -> Option<String> {
    let args = proc
        .cmd()
        .iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    codex_resume_id_from_args(&args)
}

fn codex_resume_requested_from_process(proc: &sysinfo::Process) -> bool {
    let args = proc
        .cmd()
        .iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    codex_resume_requested_from_args(&args)
}

fn claude_resume_id_from_process(proc: &sysinfo::Process) -> Option<String> {
    let args = proc
        .cmd()
        .iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    claude_resume_id_from_args(&args)
}

fn claude_resume_id_from_args(args: &[String]) -> Option<String> {
    args.windows(2).find_map(|pair| {
        (pair[0] == "--resume" && is_uuid_v4_shape(&pair[1])).then(|| pair[1].clone())
    })
}

fn codex_resume_id_from_args(args: &[String]) -> Option<String> {
    let resume_index = codex_resume_subcommand_index(args)?;
    args.get(resume_index + 1)
        .filter(|arg| is_uuid_v4_shape(arg))
        .cloned()
}

/// Return whether `args` select Codex's top-level `resume` subcommand.
///
/// The wrapper injects global `--enable` and `-c` options before the user's
/// arguments, and Node installations put a `codex.js` launcher after the
/// runtime executable. Parse that prefix while failing closed on unknown
/// options so prompt text such as `codex exec resume` never widens owner
/// matching to historical sub-agent rollouts.
pub fn codex_resume_requested_from_args(args: &[String]) -> bool {
    codex_resume_subcommand_index(args).is_some()
}

fn codex_resume_subcommand_index(args: &[String]) -> Option<usize> {
    let mut index = args.iter().position(|arg| basename_matches(arg, "codex"))? + 1;

    while let Some(arg) = args.get(index).map(String::as_str) {
        if arg == "resume" {
            return Some(index);
        }
        if arg == "--" || !arg.starts_with('-') {
            return None;
        }

        if matches!(
            arg,
            "--strict-config"
                | "--oss"
                | "--dangerously-bypass-approvals-and-sandbox"
                | "--dangerously-bypass-hook-trust"
                | "--search"
                | "--no-alt-screen"
        ) {
            index += 1;
            continue;
        }

        if matches!(arg, "-h" | "--help" | "-V" | "--version") {
            return None;
        }

        const VALUE_OPTIONS: &[&str] = &[
            "-c",
            "--config",
            "--enable",
            "--disable",
            "--remote",
            "--remote-auth-token-env",
            "-i",
            "--image",
            "-m",
            "--model",
            "--local-provider",
            "-p",
            "--profile",
            "-s",
            "--sandbox",
            "-C",
            "--cd",
            "--add-dir",
            "-a",
            "--ask-for-approval",
        ];
        if VALUE_OPTIONS.contains(&arg) {
            args.get(index + 1)?;
            index += 2;
            continue;
        }
        if VALUE_OPTIONS.iter().any(|option| {
            option.starts_with("--")
                && arg
                    .strip_prefix(option)
                    .is_some_and(|suffix| suffix.starts_with('='))
        }) || ["-c", "-i", "-m", "-p", "-s", "-C", "-a"]
            .iter()
            .any(|option| arg.starts_with(option) && arg.len() > option.len())
        {
            index += 1;
            continue;
        }
        return None;
    }
    None
}

fn codex_rollout_scope_for_mapping(
    scope: MappingScope,
    role: AgentProcessRole,
    codex_resume_requested: bool,
) -> CodexRolloutScope {
    if scope != MappingScope::SessionOwners || role != AgentProcessRole::Emit {
        CodexRolloutScope::AnyTerminal
    } else if codex_resume_requested {
        CodexRolloutScope::ResumedOwner
    } else {
        CodexRolloutScope::SessionOwner
    }
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

/// Locate a Codex rollout JSONL by its transcript UUID.
///
/// Codex stores rollouts under `<sessions>/<yyyy>/<mm>/<dd>/`, while the
/// resume command only carries the trailing UUID. Modern Codex UUIDs are v7,
/// so their first 48 bits identify the rollout's timestamp; check that date
/// first and keep a small recent fallback for non-v7 or unusual layouts.
pub fn locate_codex_transcript(uuid: &str) -> Option<PathBuf> {
    let root = codex_sessions_root()?;
    locate_codex_transcript_in(&root, uuid)
}

fn locate_codex_transcript_in(sessions_root: &Path, uuid: &str) -> Option<PathBuf> {
    if !is_uuid_v4_shape(uuid) {
        return None;
    }

    for day_dir in codex_day_dirs_for_uuid(sessions_root, uuid) {
        if let Some(path) = find_rollout_for_uuid(&day_dir, uuid) {
            return Some(path);
        }
    }

    for year in iter_subdirs_desc(sessions_root)?.into_iter().take(2) {
        for month in iter_subdirs_desc(&year)?.into_iter().take(2) {
            for day in iter_subdirs_desc(&month)?.into_iter().take(7) {
                if let Some(path) = find_rollout_for_uuid(&day, uuid) {
                    return Some(path);
                }
            }
        }
    }
    None
}

fn find_codex_jsonl_for_uuid(
    sessions_root: Option<&Path>,
    uuid: &str,
    assigned: &HashSet<PathBuf>,
) -> Option<(PathBuf, String)> {
    let path = locate_codex_transcript_in(sessions_root?, uuid)?;
    if assigned.contains(&path) {
        return None;
    }
    Some((path, uuid.to_string()))
}

fn find_claude_jsonl_for_uuid(
    cwd: &Path,
    projects_root: Option<&Path>,
    uuid: &str,
    assigned: &HashSet<PathBuf>,
) -> Option<(PathBuf, String)> {
    let root = projects_root?;
    if !is_uuid_v4_shape(uuid) {
        return None;
    }
    let filename = format!("{uuid}.jsonl");
    let slug_path = root.join(slug_for_cwd(cwd)).join(&filename);
    if claude_uuid_path_matches_cwd(&slug_path, cwd, assigned) {
        return Some((slug_path, uuid.to_string()));
    }
    for project in std::fs::read_dir(root).ok()?.flatten() {
        let path = project.path().join(&filename);
        if claude_uuid_path_matches_cwd(&path, cwd, assigned) {
            return Some((path, uuid.to_string()));
        }
    }
    None
}

fn claude_uuid_path_matches_cwd(path: &Path, cwd: &Path, assigned: &HashSet<PathBuf>) -> bool {
    if assigned.contains(path) || !path.is_file() {
        return false;
    }
    read_agent_transcript_cwd(path)
        .map(|transcript_cwd| transcript_cwd == cwd)
        .unwrap_or(true)
}

fn codex_day_dirs_for_uuid(sessions_root: &Path, uuid: &str) -> Vec<PathBuf> {
    let Some(ms) = uuid_v7_unix_millis(uuid) else {
        return Vec::new();
    };
    let Ok(ms) = i64::try_from(ms) else {
        return Vec::new();
    };
    let mut dirs = Vec::new();
    if let Some(dt) = Local.timestamp_millis_opt(ms).single() {
        dirs.push(codex_day_dir(
            sessions_root,
            dt.year(),
            dt.month(),
            dt.day(),
        ));
    }
    if let Some(dt) = Utc.timestamp_millis_opt(ms).single() {
        let utc = codex_day_dir(sessions_root, dt.year(), dt.month(), dt.day());
        if !dirs.iter().any(|existing| existing == &utc) {
            dirs.push(utc);
        }
    }
    dirs
}

fn codex_day_dir(root: &Path, year: i32, month: u32, day: u32) -> PathBuf {
    root.join(format!("{year:04}"))
        .join(format!("{month:02}"))
        .join(format!("{day:02}"))
}

fn uuid_v7_unix_millis(uuid: &str) -> Option<u64> {
    let mut compact = String::with_capacity(32);
    for ch in uuid.chars() {
        if ch != '-' {
            compact.push(ch);
        }
    }
    if compact.len() != 32 || compact.as_bytes().get(12).copied() != Some(b'7') {
        return None;
    }
    u64::from_str_radix(&compact[..12], 16).ok()
}

fn find_rollout_for_uuid(day_dir: &Path, uuid: &str) -> Option<PathBuf> {
    let suffix = format!("{uuid}.jsonl");
    for entry in std::fs::read_dir(day_dir).ok()?.flatten() {
        let path = entry.path();
        let Some(filename) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if filename.starts_with("rollout-") && filename.ends_with(&suffix) {
            return Some(path);
        }
    }
    None
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
    find_recent_codex_jsonl_with_scope(
        cwd,
        sessions_root,
        recency_cutoff,
        process_start,
        now,
        allow_rotation,
        assigned,
        CodexRolloutScope::AnyTerminal,
    )
}

fn find_recent_codex_owner_jsonl(
    cwd: &Path,
    sessions_root: Option<&Path>,
    recency_cutoff: SystemTime,
    process_start: SystemTime,
    now: SystemTime,
    allow_rotation: bool,
    assigned: &HashSet<PathBuf>,
) -> Option<(PathBuf, String)> {
    find_recent_codex_jsonl_with_scope(
        cwd,
        sessions_root,
        recency_cutoff,
        process_start,
        now,
        allow_rotation,
        assigned,
        CodexRolloutScope::SessionOwner,
    )
}

fn find_recent_resumed_codex_jsonl(
    cwd: &Path,
    sessions_root: Option<&Path>,
    recency_cutoff: SystemTime,
    process_start: SystemTime,
    now: SystemTime,
    allow_rotation: bool,
    assigned: &HashSet<PathBuf>,
) -> Option<(PathBuf, String)> {
    find_recent_codex_jsonl_with_scope(
        cwd,
        sessions_root,
        recency_cutoff,
        process_start,
        now,
        allow_rotation,
        assigned,
        CodexRolloutScope::ResumedOwner,
    )
}

fn codex_day_dirs_for_scope(root: &Path, scope: CodexRolloutScope) -> Vec<PathBuf> {
    if scope != CodexRolloutScope::ResumedOwner {
        return newest_subdir(root)
            .and_then(|year| newest_subdir(&year))
            .and_then(|month| newest_subdir(&month))
            .into_iter()
            .collect();
    }

    // A picker, --last, or named resume can reopen a rollout stored under any
    // historical date. Its file mtime becomes current without changing the
    // containing directory, so the resume-only path must inspect every date
    // directory and let the normal mtime/process-start filters discard cold
    // files. New-session scans stay on the newest day above.
    let mut days = Vec::new();
    for year in iter_subdirs_desc(root).unwrap_or_default() {
        for month in iter_subdirs_desc(&year).unwrap_or_default() {
            days.extend(iter_subdirs_desc(&month).unwrap_or_default());
        }
    }
    days
}

#[allow(clippy::too_many_arguments)]
fn find_recent_codex_jsonl_with_scope(
    cwd: &Path,
    sessions_root: Option<&Path>,
    recency_cutoff: SystemTime,
    process_start: SystemTime,
    now: SystemTime,
    allow_rotation: bool,
    assigned: &HashSet<PathBuf>,
    scope: CodexRolloutScope,
) -> Option<(PathBuf, String)> {
    // Codex rollouts live under <root>/<year>/<month>/<day>/. The
    // filename does NOT encode the cwd (unlike claude), so we read each
    // candidate's first JSONL line and match its `payload.cwd` against
    // the live process's cwd. New-session scans walk just the newest date
    // directory; non-UUID resume scans include historical date directories
    // because reopening a rollout updates the file, not its parent directory.
    // The cwd check runs while collecting (not after ranking) so the rotation
    // successor is also guaranteed to belong to this cwd.
    let root = sessions_root?;
    let mut candidates: Vec<TranscriptCandidate> = Vec::new();
    for day_dir in codex_day_dirs_for_scope(root, scope) {
        let Ok(entries) = std::fs::read_dir(&day_dir) else {
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
            let Some(head) = read_codex_rollout_head(&path) else {
                continue;
            };
            if head.cwd != cwd || !head.is_writer_for_scope(scope) {
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
    }
    if scope == CodexRolloutScope::ResumedOwner {
        retain_resumed_codex_roots(&mut candidates, root, process_start);
    }
    pick_anchor_or_rotate(candidates, process_start, now, allow_rotation)
}

fn find_completed_codex_jsonl(
    cwd: &Path,
    sessions_root: Option<&Path>,
    recency_cutoff: SystemTime,
    process_start: SystemTime,
) -> Option<(PathBuf, String)> {
    find_completed_codex_jsonl_with_scope(
        cwd,
        sessions_root,
        recency_cutoff,
        process_start,
        CodexRolloutScope::SessionOwner,
    )
}

fn find_completed_resumed_codex_jsonl(
    cwd: &Path,
    sessions_root: Option<&Path>,
    recency_cutoff: SystemTime,
    process_start: SystemTime,
) -> Option<(PathBuf, String)> {
    find_completed_codex_jsonl_with_scope(
        cwd,
        sessions_root,
        recency_cutoff,
        process_start,
        CodexRolloutScope::ResumedOwner,
    )
}

fn find_completed_codex_jsonl_with_scope(
    cwd: &Path,
    sessions_root: Option<&Path>,
    recency_cutoff: SystemTime,
    process_start: SystemTime,
    scope: CodexRolloutScope,
) -> Option<(PathBuf, String)> {
    let root = sessions_root?;
    let mut candidates: Vec<TranscriptCandidate> = Vec::new();
    for day_dir in codex_day_dirs_for_scope(root, scope) {
        let Ok(entries) = std::fs::read_dir(&day_dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            let Ok(mtime) = meta.modified() else { continue };
            if mtime < recency_cutoff || mtime < process_start {
                continue;
            }
            let Some(head) = read_codex_rollout_head(&path) else {
                continue;
            };
            if head.cwd != cwd || !head.is_writer_for_scope(scope) {
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
    if scope == CodexRolloutScope::ResumedOwner {
        retain_resumed_codex_roots(&mut candidates, root, process_start);
    }
    candidates.sort_by_key(|candidate| time_distance(candidate.birth, process_start));
    if candidates.len() == 1 {
        let candidate = candidates.pop()?;
        Some((candidate.path, candidate.uuid))
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
struct CodexRolloutHead {
    cwd: PathBuf,
    originator: Option<String>,
    is_subagent: bool,
}

/// Rollout writers that share `~/.codex/sessions` with the terminal CLI but
/// can never belong to an Acorn PTY session. Codex Desktop records every GUI
/// conversation here; pairing one with a terminal process steals the marker
/// from the real tui rollout (or trips the unique-candidate policy). Missing
/// or unknown originators stay eligible — rollouts from older CLIs
/// (`codex_cli_rs`) and `codex exec` one-shots are legitimate matches.
const CODEX_GUI_HOST_ORIGINATORS: &[&str] = &["Codex Desktop"];

impl CodexRolloutHead {
    fn is_terminal_writer(&self) -> bool {
        self.originator
            .as_deref()
            .is_none_or(|originator| !CODEX_GUI_HOST_ORIGINATORS.contains(&originator))
    }

    fn is_session_owner_writer(&self) -> bool {
        self.is_terminal_writer() && !self.is_subagent
    }

    fn is_writer_for_scope(&self, scope: CodexRolloutScope) -> bool {
        match scope {
            CodexRolloutScope::SessionOwner => self.is_session_owner_writer(),
            CodexRolloutScope::AnyTerminal | CodexRolloutScope::ResumedOwner => {
                self.is_terminal_writer()
            }
        }
    }
}

/// Return the owner declared by a Codex sub-agent rollout. Marker repair uses
/// this relationship narrowly; arbitrary backwards transcript moves still
/// pass the normal dormant-echo guard.
pub fn codex_rollout_parent_thread_id(path: &Path) -> Option<String> {
    use std::io::{BufRead, BufReader};
    let file = std::fs::File::open(path).ok()?;
    let reader = BufReader::new(file);
    for line in reader.lines().map_while(Result::ok).take(20) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        for scope in [Some(&value), value.get("payload")] {
            let Some(scope) = scope else { continue };
            let (is_subagent, parent_thread_id) = codex_subagent_metadata(scope);
            if is_subagent && parent_thread_id.is_some() {
                return parent_thread_id;
            }
        }
    }
    None
}

/// A deliberately resumed sub-agent rollout becomes the root conversation for
/// this terminal run, but it keeps its original `source.subagent` metadata.
/// Historical ancestors remain candidates so normal birth anchoring selects
/// the youngest pre-existing rollout. Only descendants born by this process
/// are removed. Process start times are second-granularity on supported hosts;
/// treating same-second descendants as new fails closed in the rare ambiguous
/// boundary instead of allowing a child to take over the live owner marker.
fn retain_resumed_codex_roots(
    candidates: &mut Vec<TranscriptCandidate>,
    sessions_root: &Path,
    process_start: SystemTime,
) {
    let candidate_ids = candidates
        .iter()
        .map(|candidate| candidate.uuid.clone())
        .collect::<HashSet<_>>();
    candidates.retain(|candidate| {
        let born_this_run = candidate.birth.duration_since(process_start).is_ok();
        !born_this_run
            || !codex_rollout_has_candidate_ancestor(&candidate.path, &candidate_ids, sessions_root)
    });
}

fn codex_rollout_has_candidate_ancestor(
    rollout: &Path,
    candidate_ids: &HashSet<String>,
    sessions_root: &Path,
) -> bool {
    const MAX_ANCESTOR_DEPTH: usize = 16;

    let mut current = rollout.to_path_buf();
    let mut seen = HashSet::new();
    for _ in 0..MAX_ANCESTOR_DEPTH {
        let Some(parent_uuid) = codex_rollout_parent_thread_id(&current) else {
            return false;
        };
        if !seen.insert(parent_uuid.clone()) {
            return true;
        }
        if candidate_ids.contains(&parent_uuid) {
            return true;
        }
        let Some((parent_path, _)) =
            find_codex_jsonl_for_uuid(Some(sessions_root), &parent_uuid, &HashSet::new())
        else {
            return false;
        };
        current = parent_path;
    }
    true
}

/// Read owner metadata from a codex rollout's leading `session_meta` line.
/// Fields live at the top level in old formats and under `payload` in current
/// ones. Current sub-agent sources encode their parent beneath
/// `source.subagent`; the payload-level parent id is retained as a fallback
/// for compatible writers.
fn read_codex_rollout_head(path: &Path) -> Option<CodexRolloutHead> {
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
        for scope in [Some(&v), v.get("payload")] {
            let Some(scope) = scope else { continue };
            if let Some(cwd) = scope.get("cwd").and_then(|c| c.as_str()) {
                let (is_subagent, _) = codex_subagent_metadata(scope);
                return Some(CodexRolloutHead {
                    cwd: PathBuf::from(cwd),
                    originator: scope
                        .get("originator")
                        .and_then(|o| o.as_str())
                        .map(str::to_string),
                    is_subagent,
                });
            }
        }
    }
    None
}

fn codex_subagent_metadata(scope: &serde_json::Value) -> (bool, Option<String>) {
    let source = scope.get("source");
    let subagent_source = source.and_then(|source| source.get("subagent"));
    let is_subagent =
        subagent_source.is_some() || source.and_then(|source| source.as_str()) == Some("subagent");
    let parent_thread_id = subagent_source
        .and_then(find_parent_thread_id)
        .or_else(|| {
            is_subagent
                .then(|| scope.get("parent_thread_id").and_then(|id| id.as_str()))
                .flatten()
        })
        .map(str::to_string);
    (is_subagent, parent_thread_id)
}

fn find_parent_thread_id(value: &serde_json::Value) -> Option<&str> {
    match value {
        serde_json::Value::Object(fields) => fields
            .get("parent_thread_id")
            .and_then(|value| value.as_str())
            .or_else(|| fields.values().find_map(find_parent_thread_id)),
        serde_json::Value::Array(values) => values.iter().find_map(find_parent_thread_id),
        _ => None,
    }
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

fn iter_subdirs_desc(dir: &Path) -> Option<Vec<PathBuf>> {
    let mut entries: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    entries.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
    Some(entries)
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

    fn process_roles(matches: Vec<AgentProcessMatch>) -> Vec<(u32, AgentKind, AgentProcessRole)> {
        matches
            .into_iter()
            .map(|m| (m.pid.as_u32(), m.kind, m.role))
            .collect()
    }

    fn emitted_processes(matches: Vec<AgentProcessMatch>) -> Vec<(u32, AgentKind)> {
        matches
            .into_iter()
            .filter(|m| m.role == AgentProcessRole::Emit)
            .map(|m| (m.pid.as_u32(), m.kind))
            .collect()
    }

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
    fn codex_resume_id_from_args_reads_resume_subcommand() {
        let id = "019e2001-3250-76b0-8410-2e073b38a2c1";
        for args in [
            vec!["codex", "resume", id],
            vec!["codex", "resume", "--all", id],
            vec!["codex", "resume", "--yolo", id],
            vec!["codex", "resume", "-c", "model=o3", id],
        ] {
            let args = args.into_iter().map(str::to_string).collect::<Vec<_>>();
            assert_eq!(
                codex_resume_id_from_args(&args).as_deref(),
                Some(id),
                "{args:?}"
            );
        }
    }

    #[test]
    fn codex_resume_mode_allows_explicitly_resumed_subagent_owner() {
        for args in [
            vec!["codex".into(), "resume".into()],
            vec!["codex".into(), "resume".into(), "--last".into()],
            vec!["codex".into(), "resume".into(), "named-session".into()],
        ] {
            assert!(codex_resume_requested_from_args(&args));
        }
        assert!(!codex_resume_requested_from_args(&["codex".into()]));

        assert_eq!(
            codex_rollout_scope_for_mapping(
                MappingScope::SessionOwners,
                AgentProcessRole::Emit,
                false,
            ),
            CodexRolloutScope::SessionOwner,
        );
        assert_eq!(
            codex_rollout_scope_for_mapping(
                MappingScope::SessionOwners,
                AgentProcessRole::Emit,
                true,
            ),
            CodexRolloutScope::ResumedOwner,
        );
        assert_eq!(
            codex_rollout_scope_for_mapping(
                MappingScope::SessionOwners,
                AgentProcessRole::Quarantine,
                false,
            ),
            CodexRolloutScope::AnyTerminal,
        );
    }

    #[test]
    fn codex_resume_mode_only_accepts_the_resume_subcommand() {
        let id = "019e2001-3250-76b0-8410-2e073b38a2c1";
        for args in [
            vec!["codex", "--enable", "hooks", "-c", "notify=[]", "resume"],
            vec!["node", "/opt/codex.js", "resume", "--last"],
            vec![
                "node",
                "/opt/codex.js",
                "--enable",
                "hooks",
                "-c",
                "notify=[]",
                "--yolo",
                "resume",
                id,
            ],
            vec!["codex", "resume", "named-session"],
        ] {
            let args = args.into_iter().map(str::to_string).collect::<Vec<_>>();
            assert!(codex_resume_requested_from_args(&args), "{args:?}");
        }

        for args in [
            vec!["codex", "exec", "resume"],
            vec!["codex", "exec", "--json", "resume"],
            vec!["codex", "-C", "resume"],
            vec!["codex", "--", "resume"],
            vec!["codex", "review", "resume", id],
        ] {
            let args = args.into_iter().map(str::to_string).collect::<Vec<_>>();
            assert!(!codex_resume_requested_from_args(&args), "{args:?}");
            assert_eq!(codex_resume_id_from_args(&args), None, "{args:?}");
        }
    }

    #[test]
    fn claude_resume_id_from_args_reads_resume_flag() {
        let id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        let args = vec!["claude".to_string(), "--resume".to_string(), id.to_string()];

        assert_eq!(claude_resume_id_from_args(&args).as_deref(), Some(id));
    }

    #[test]
    fn session_owner_scope_stops_at_first_agent_boundary() {
        let root = Pid::from_u32(1);
        let wrapper = Pid::from_u32(2);
        let codex = Pid::from_u32(3);
        let nested_codex = Pid::from_u32(4);
        let mut children = std::collections::HashMap::new();
        children.insert(root, vec![wrapper]);
        children.insert(wrapper, vec![codex]);
        children.insert(codex, vec![nested_codex]);

        let kind_for_pid = |pid: Pid| match pid.as_u32() {
            3 | 4 => Some(AgentKind::Codex),
            _ => None,
        };

        let all = collect_agent_processes_in_tree(
            &children,
            root,
            MappingScope::AllDescendants,
            kind_for_pid,
        );
        assert_eq!(
            all.into_iter().map(|m| m.pid.as_u32()).collect::<Vec<_>>(),
            vec![3, 4],
        );

        let owners = collect_agent_processes_in_tree(
            &children,
            root,
            MappingScope::SessionOwners,
            kind_for_pid,
        );
        assert_eq!(
            process_roles(owners),
            vec![
                (3, AgentKind::Codex, AgentProcessRole::Emit),
                (4, AgentKind::Codex, AgentProcessRole::Quarantine),
            ],
        );
    }

    #[test]
    fn session_owner_scope_preserves_sibling_top_level_agents() {
        let root = Pid::from_u32(1);
        let codex = Pid::from_u32(2);
        let wrapper = Pid::from_u32(3);
        let claude = Pid::from_u32(4);
        let nested_codex = Pid::from_u32(5);
        let mut children = std::collections::HashMap::new();
        children.insert(root, vec![codex, wrapper]);
        children.insert(wrapper, vec![claude]);
        children.insert(codex, vec![nested_codex]);

        let mut owners =
            collect_agent_processes_in_tree(&children, root, MappingScope::SessionOwners, |pid| {
                match pid.as_u32() {
                    2 | 5 => Some(AgentKind::Codex),
                    4 => Some(AgentKind::Claude),
                    _ => None,
                }
            })
            .into_iter()
            .filter(|m| m.role == AgentProcessRole::Emit)
            .map(|m| (m.pid.as_u32(), m.kind))
            .collect::<Vec<_>>();
        owners.sort_by_key(|(pid, _)| *pid);

        assert_eq!(owners, vec![(2, AgentKind::Codex), (4, AgentKind::Claude)]);
    }

    #[test]
    fn session_owner_scope_handles_exec_replaced_shell_root() {
        let root_codex = Pid::from_u32(1);
        let nested_codex = Pid::from_u32(2);
        let mut children = std::collections::HashMap::new();
        children.insert(root_codex, vec![nested_codex]);

        let owners = collect_agent_processes_in_tree(
            &children,
            root_codex,
            MappingScope::SessionOwners,
            |pid| match pid.as_u32() {
                1 | 2 => Some(AgentKind::Codex),
                _ => None,
            },
        );

        assert_eq!(
            process_roles(owners),
            vec![
                (1, AgentKind::Codex, AgentProcessRole::Emit),
                (2, AgentKind::Codex, AgentProcessRole::Quarantine),
            ],
        );
    }

    #[test]
    fn session_owner_scope_excludes_nested_peer_provider() {
        let root = Pid::from_u32(1);
        let claude = Pid::from_u32(2);
        let tool_shell = Pid::from_u32(3);
        let nested_codex = Pid::from_u32(4);
        let mut children = std::collections::HashMap::new();
        children.insert(root, vec![claude]);
        children.insert(claude, vec![tool_shell]);
        children.insert(tool_shell, vec![nested_codex]);

        let owners =
            collect_agent_processes_in_tree(&children, root, MappingScope::SessionOwners, |pid| {
                match pid.as_u32() {
                    2 => Some(AgentKind::Claude),
                    4 => Some(AgentKind::Codex),
                    _ => None,
                }
            });

        assert_eq!(
            emitted_processes(owners.clone()),
            vec![(2, AgentKind::Claude)],
        );
        assert_eq!(
            process_roles(owners),
            vec![
                (2, AgentKind::Claude, AgentProcessRole::Emit),
                (4, AgentKind::Codex, AgentProcessRole::Quarantine),
            ],
        );
    }

    #[test]
    fn all_descendant_scope_keeps_nested_peer_provider_for_fork() {
        let root = Pid::from_u32(1);
        let claude = Pid::from_u32(2);
        let tool_shell = Pid::from_u32(3);
        let nested_codex = Pid::from_u32(4);
        let mut children = std::collections::HashMap::new();
        children.insert(root, vec![claude]);
        children.insert(claude, vec![tool_shell]);
        children.insert(tool_shell, vec![nested_codex]);

        let kind_for_pid = |pid: Pid| match pid.as_u32() {
            2 => Some(AgentKind::Claude),
            4 => Some(AgentKind::Codex),
            _ => None,
        };

        let all = collect_agent_processes_in_tree(
            &children,
            root,
            MappingScope::AllDescendants,
            kind_for_pid,
        );
        assert_eq!(
            process_roles(all),
            vec![
                (2, AgentKind::Claude, AgentProcessRole::Emit),
                (4, AgentKind::Codex, AgentProcessRole::Emit),
            ],
        );

        let owners = collect_agent_processes_in_tree(
            &children,
            root,
            MappingScope::SessionOwners,
            kind_for_pid,
        );
        assert_eq!(
            emitted_processes(owners.clone()),
            vec![(2, AgentKind::Claude)],
        );
        assert_eq!(
            process_roles(owners),
            vec![
                (2, AgentKind::Claude, AgentProcessRole::Emit),
                (4, AgentKind::Codex, AgentProcessRole::Quarantine),
            ],
        );
    }

    #[test]
    fn uuid_v7_unix_millis_reads_codex_rollout_timestamp() {
        assert_eq!(
            uuid_v7_unix_millis("019e2001-3250-76b0-8410-2e073b38a2c1"),
            Some(1_778_653_409_872)
        );
        assert_eq!(
            uuid_v7_unix_millis("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
            None
        );
    }

    #[test]
    fn locate_codex_transcript_uses_uuid_date_dir() {
        use std::fs::{self, File};

        let root =
            std::env::temp_dir().join(format!("acorn-cxloc-{}", uuid::Uuid::new_v4().simple()));
        let sessions = root.join("sessions");
        let id = "019e2001-3250-76b0-8410-2e073b38a2c1";
        let day = codex_day_dirs_for_uuid(&sessions, id)
            .into_iter()
            .next()
            .unwrap();
        fs::create_dir_all(&day).unwrap();
        let expected = day.join(format!("rollout-2026-05-13T15-23-29-{id}.jsonl"));
        File::create(&expected).unwrap();

        let newer_day = sessions.join("2099").join("12").join("31");
        fs::create_dir_all(&newer_day).unwrap();
        File::create(
            newer_day
                .join("rollout-2099-12-31T00-00-00-11111111-2222-7333-8444-555555555555.jsonl"),
        )
        .unwrap();

        assert_eq!(
            locate_codex_transcript_in(&sessions, id).as_deref(),
            Some(expected.as_path())
        );

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn explicit_codex_resume_finds_transcript_before_first_append() {
        use std::fs::{self, File};
        use std::io::Write;

        let root =
            std::env::temp_dir().join(format!("acorn-cxresume-{}", uuid::Uuid::new_v4().simple()));
        let sessions = root.join("sessions");
        let cwd = root.join("repo");
        let id = "019e2001-3250-76b0-8410-2e073b38a2c1";
        let day = codex_day_dirs_for_uuid(&sessions, id)
            .into_iter()
            .next()
            .unwrap();
        fs::create_dir_all(&day).unwrap();
        fs::create_dir_all(&cwd).unwrap();

        let transcript = day.join(format!("rollout-2026-05-13T15-23-29-{id}.jsonl"));
        let mut file = File::create(&transcript).unwrap();
        writeln!(file, "{{\"payload\":{{\"cwd\":\"{}\"}}}}", cwd.display()).unwrap();

        let old_mtime = SystemTime::now() - Duration::from_secs(60);
        set_mtime(&transcript, old_mtime);
        let process_start = old_mtime + Duration::from_secs(30);

        let recent = find_recent_codex_jsonl(
            &cwd,
            Some(&sessions),
            SystemTime::UNIX_EPOCH,
            process_start,
            process_start,
            true,
            &HashSet::new(),
        );
        assert!(
            recent.is_none(),
            "mtime-based live matching rejects a resume before Codex appends"
        );

        let explicit = find_codex_jsonl_for_uuid(Some(&sessions), id, &HashSet::new());
        assert_eq!(explicit.map(|(_, found_id)| found_id).as_deref(), Some(id));

        fs::remove_dir_all(&root).unwrap();
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
    const C_UUID: &str = "66666666-7777-8888-9999-aaaaaaaaaaaa";

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

    fn three_transcripts(tag: &str) -> (PathBuf, PathBuf, PathBuf, PathBuf, SystemTime) {
        use std::fs::{self, File};
        let dir =
            std::env::temp_dir().join(format!("acorn-{tag}-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&dir).unwrap();
        let a = dir.join(format!("{A_UUID}.jsonl"));
        File::create(&a).unwrap();
        std::thread::sleep(Duration::from_millis(1100));
        let b = dir.join(format!("{B_UUID}.jsonl"));
        File::create(&b).unwrap();
        std::thread::sleep(Duration::from_millis(1100));
        let c = dir.join(format!("{C_UUID}.jsonl"));
        File::create(&c).unwrap();
        let c_mtime = fs::metadata(&c).unwrap().modified().unwrap();
        (dir, a, b, c, c_mtime)
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

    /// Owner-scoped resume markers must not advance to a nested
    /// same-provider transcript that is still hot after the nested process
    /// exits. The quarantine is represented as an assigned/reserved path for
    /// the owner matcher, so the dormant parent anchor stays selected instead
    /// of rotating forward to the nested successor.
    #[test]
    fn owner_quarantine_blocks_hot_nested_successor_after_exit() {
        let (dir, a, b, b_mtime) = two_transcripts("owner-quarantine-hot");
        let a_mtime = b_mtime - Duration::from_secs(60);
        set_mtime(&a, a_mtime);
        let mut reserved = HashSet::new();
        reserved.insert(b);

        let picked = pick_newest_unassigned_jsonl(
            &dir,
            SystemTime::UNIX_EPOCH,
            a_mtime,
            b_mtime,
            true,
            &reserved,
        );
        assert_eq!(
            picked.map(|(_, id)| id).as_deref(),
            Some(A_UUID),
            "owner marker must not rotate to a quarantined hot nested transcript"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A resumed parent transcript can have an old birth time but a fresh
    /// mtime. A nested transcript born closer to the parent process start must
    /// not win the birth-proximity anchor when it is quarantined.
    #[test]
    fn owner_quarantine_blocks_nested_anchor_for_resumed_parent() {
        let (dir, a, b, b_mtime) = two_transcripts("owner-quarantine-anchor");
        set_mtime(&a, b_mtime);
        let mut reserved = HashSet::new();
        reserved.insert(b);

        let picked = pick_newest_unassigned_jsonl(
            &dir,
            SystemTime::UNIX_EPOCH,
            b_mtime,
            b_mtime,
            true,
            &reserved,
        );
        assert_eq!(
            picked.map(|(_, id)| id).as_deref(),
            Some(A_UUID),
            "owner marker must keep the resumed parent transcript when the nested anchor is reserved"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Reserving a nested transcript must not disable a clearly separate
    /// top-level `/new` successor. The reserved nested file is skipped, and
    /// normal owner rotation can still advance from the dormant parent anchor
    /// to the unreserved hot successor.
    #[test]
    fn owner_quarantine_preserves_unreserved_top_level_new_rotation() {
        let (dir, a, b, _c, c_mtime) = three_transcripts("owner-quarantine-new");
        let a_mtime = c_mtime - Duration::from_secs(60);
        set_mtime(&a, a_mtime);
        let mut reserved = HashSet::new();
        reserved.insert(b);

        let picked = pick_newest_unassigned_jsonl(
            &dir,
            SystemTime::UNIX_EPOCH,
            a_mtime,
            c_mtime,
            true,
            &reserved,
        );
        assert_eq!(
            picked.map(|(_, id)| id).as_deref(),
            Some(C_UUID),
            "owner /new should still advance to an unreserved hot successor"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// When a nested same-provider agent was just observed, owner rotation is
    /// blocked briefly for that session/provider/cwd scope. That closes the
    /// two-scan hole where a nested agent performs `/new`, exits, and leaves an
    /// unreserved hot successor behind.
    #[test]
    fn owner_rotation_block_prevents_unreserved_nested_successor() {
        let (dir, a, b, _c, c_mtime) = three_transcripts("owner-rotation-block");
        let a_mtime = c_mtime - Duration::from_secs(60);
        set_mtime(&a, a_mtime);
        let mut reserved = HashSet::new();
        reserved.insert(b);

        let picked = pick_newest_unassigned_jsonl(
            &dir,
            SystemTime::UNIX_EPOCH,
            a_mtime,
            c_mtime,
            false,
            &reserved,
        );
        assert_eq!(
            picked.map(|(_, id)| id).as_deref(),
            Some(A_UUID),
            "rotation block must keep the parent anchor while a nested /new successor is ambiguous"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn owner_quarantine_is_scoped_to_observing_session() {
        use std::fs::{self, File};
        let dir = std::env::temp_dir().join(format!(
            "acorn-quarantine-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{A_UUID}.jsonl"));
        File::create(&path).unwrap();
        let session_a = uuid::Uuid::new_v4();
        let session_b = uuid::Uuid::new_v4();

        remember_owner_quarantined_path(session_a, &path);
        let active = active_owner_quarantined_paths(SystemTime::now());
        assert!(active
            .get(&session_a)
            .is_some_and(|paths| paths.contains(&path)));
        assert!(!active
            .get(&session_b)
            .is_some_and(|paths| paths.contains(&path)));

        release_owner_quarantined_path(session_a, &path);
        fs::remove_dir_all(&dir).unwrap();
    }

    /// Quarantined paths must not outlive their usefulness: every
    /// mtime-based picker rejects transcripts older than
    /// `RECENCY_WINDOW_SECS`, so once a quarantined file ages out of that
    /// window its entry is evicted from the global map instead of
    /// lingering for the life of the process (session ids are ephemeral
    /// and never reused, so nothing else would ever clear it).
    #[test]
    fn owner_quarantine_evicts_entries_aged_out_of_recency_window() {
        use std::fs::{self, File};
        let dir = std::env::temp_dir().join(format!(
            "acorn-quarantine-evict-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&dir).unwrap();
        let stale = dir.join(format!("{A_UUID}.jsonl"));
        let hot = dir.join(format!("{B_UUID}.jsonl"));
        File::create(&stale).unwrap();
        File::create(&hot).unwrap();
        let stale_session = uuid::Uuid::new_v4();
        let hot_session = uuid::Uuid::new_v4();

        remember_owner_quarantined_path(stale_session, &stale);
        remember_owner_quarantined_path(hot_session, &hot);
        let now = SystemTime::now();
        set_mtime(&stale, now - Duration::from_secs(RECENCY_WINDOW_SECS + 60));

        let active = active_owner_quarantined_paths(now);
        assert!(
            !active.contains_key(&stale_session),
            "an aged-out quarantined path must not appear in the active view"
        );
        assert!(
            active
                .get(&hot_session)
                .is_some_and(|paths| paths.contains(&hot)),
            "a still-recent quarantined path must survive the prune"
        );
        assert!(
            !owner_transcript_quarantine()
                .lock()
                .contains_key(&stale_session),
            "the stale session entry must be evicted from the global map"
        );

        release_owner_quarantined_path(hot_session, &hot);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn owner_rotation_quarantine_is_scoped_by_session_provider_and_cwd() {
        let session_a = uuid::Uuid::new_v4();
        let session_b = uuid::Uuid::new_v4();
        let cwd_a = Path::new("/tmp/acorn-a");
        let cwd_b = Path::new("/tmp/acorn-b");
        let scope_a = owner_rotation_scope(session_a, AgentKind::Codex, cwd_a);
        let same_session_other_cwd = owner_rotation_scope(session_a, AgentKind::Codex, cwd_b);
        let other_session_same_cwd = owner_rotation_scope(session_b, AgentKind::Codex, cwd_a);

        remember_owner_rotation_quarantine(&scope_a, SystemTime::now());
        let active = active_owner_rotation_quarantines(SystemTime::now());
        assert!(active.contains(&scope_a));
        assert!(!active.contains(&same_session_other_cwd));
        assert!(!active.contains(&other_session_same_cwd));

        owner_rotation_quarantine().lock().remove(&scope_a);
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

    /// Codex Desktop shares `~/.codex/sessions` with the terminal CLI. Its
    /// rollouts carry `originator: "Codex Desktop"` and can never belong to
    /// an Acorn PTY session, so live pairing must skip them even when the
    /// cwd matches.
    #[test]
    fn find_recent_codex_jsonl_ignores_gui_host_rollouts() {
        use std::fs::{self, File};
        use std::io::Write;

        let root =
            std::env::temp_dir().join(format!("acorn-cxgui-{}", uuid::Uuid::new_v4().simple()));
        let day = root.join("sessions").join("2026").join("06").join("10");
        fs::create_dir_all(&day).unwrap();
        let cwd = root.join("repo");

        let write_rollout = |name: &str, originator: Option<&str>| {
            let path = day.join(name);
            let mut f = File::create(&path).unwrap();
            match originator {
                Some(originator) => writeln!(
                    f,
                    "{{\"payload\":{{\"cwd\":\"{}\",\"originator\":\"{originator}\"}}}}",
                    cwd.display()
                )
                .unwrap(),
                None => writeln!(f, "{{\"payload\":{{\"cwd\":\"{}\"}}}}", cwd.display()).unwrap(),
            }
            path
        };

        let desktop = write_rollout(
            "rollout-2026-06-10T10-00-00-019e2001-3250-76b0-8410-2e073b38a2d1.jsonl",
            Some("Codex Desktop"),
        );
        let now = fs::metadata(&desktop).unwrap().modified().unwrap();
        let process_start = now - Duration::from_secs(5);

        let picked = find_recent_codex_jsonl(
            &cwd,
            Some(&root.join("sessions")),
            SystemTime::UNIX_EPOCH,
            process_start,
            now,
            false,
            &HashSet::new(),
        );
        assert!(
            picked.is_none(),
            "a GUI-host rollout must never pair with a terminal codex process"
        );

        let tui = write_rollout(
            "rollout-2026-06-10T10-00-01-019e2001-3250-76b0-8410-2e073b38a2d2.jsonl",
            Some("codex-tui"),
        );
        set_mtime(&tui, now);
        let picked = find_recent_codex_jsonl(
            &cwd,
            Some(&root.join("sessions")),
            SystemTime::UNIX_EPOCH,
            process_start,
            now,
            false,
            &HashSet::new(),
        );
        assert_eq!(
            picked.map(|(_, id)| id).as_deref(),
            Some("019e2001-3250-76b0-8410-2e073b38a2d2"),
            "the tui rollout must win with the GUI-host sibling filtered out"
        );

        // Rollouts predating the originator field stay eligible.
        let legacy = write_rollout(
            "rollout-2026-06-10T10-00-02-019e2001-3250-76b0-8410-2e073b38a2d3.jsonl",
            None,
        );
        set_mtime(&legacy, now);
        let picked = find_recent_codex_jsonl(
            &cwd,
            Some(&root.join("sessions")),
            SystemTime::UNIX_EPOCH,
            process_start,
            now,
            false,
            &HashSet::new(),
        );
        assert!(
            picked.is_some(),
            "legacy rollouts without originator must remain eligible"
        );

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn find_recent_codex_owner_jsonl_does_not_rotate_to_same_process_subagent() {
        use std::fs::{self, File};
        use std::io::Write;

        let root = std::env::temp_dir().join(format!(
            "acorn-cxsubagent-owner-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let day = root.join("sessions").join("2026").join("06").join("10");
        fs::create_dir_all(&day).unwrap();
        let cwd = root.join("repo");
        let parent_id = "019e2001-3250-76b0-8410-2e073b38a2e1";
        let child_id = "019e2001-3250-76b0-8410-2e073b38a2e2";

        let write_rollout = |id: &str, source: serde_json::Value, parent: Option<&str>| {
            let path = day.join(format!("rollout-2026-06-10T10-00-00-{id}.jsonl"));
            let mut file = File::create(&path).unwrap();
            writeln!(
                file,
                "{}",
                serde_json::json!({
                    "type": "session_meta",
                    "payload": {
                        "id": id,
                        "cwd": cwd,
                        "originator": "codex-tui",
                        "source": source,
                        "parent_thread_id": parent,
                    }
                })
            )
            .unwrap();
            path
        };

        let parent = write_rollout(parent_id, serde_json::json!("cli"), None);
        std::thread::sleep(Duration::from_millis(1100));
        let child = write_rollout(
            child_id,
            serde_json::json!({
                "subagent": {
                    "thread_spawn": {
                        "parent_thread_id": parent_id,
                        "depth": 1
                    }
                }
            }),
            Some(parent_id),
        );
        let now = fs::metadata(&child).unwrap().modified().unwrap();
        let process_start = now - Duration::from_secs(DORMANT_TRANSCRIPT_SECS + 120);
        set_mtime(&parent, process_start + Duration::from_secs(1));

        let picked = find_recent_codex_owner_jsonl(
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
            Some(parent_id),
            "a hot same-process subagent must not look like a /new owner rotation"
        );

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn completed_codex_owner_resolution_ignores_subagent_rollout() {
        use std::fs::{self, File};
        use std::io::Write;

        let root = std::env::temp_dir().join(format!(
            "acorn-cxsubagent-complete-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let day = root.join("sessions").join("2026").join("06").join("10");
        fs::create_dir_all(&day).unwrap();
        let cwd = root.join("repo");
        let parent_id = "019e2001-3250-76b0-8410-2e073b38a2f1";
        let child_id = "019e2001-3250-76b0-8410-2e073b38a2f2";

        for (id, source, parent) in [
            (parent_id, serde_json::json!("cli"), None),
            (
                child_id,
                serde_json::json!({
                    "subagent": {
                        "thread_spawn": {
                            "parent_thread_id": parent_id,
                            "depth": 1
                        }
                    }
                }),
                Some(parent_id),
            ),
        ] {
            let path = day.join(format!("rollout-2026-06-10T10-00-00-{id}.jsonl"));
            let mut file = File::create(path).unwrap();
            writeln!(
                file,
                "{}",
                serde_json::json!({
                    "type": "session_meta",
                    "payload": {
                        "id": id,
                        "cwd": cwd,
                        "originator": "codex-tui",
                        "source": source,
                        "parent_thread_id": parent,
                    }
                })
            )
            .unwrap();
        }
        let process_start = SystemTime::now() - Duration::from_secs(5);

        let resolved = find_completed_codex_jsonl(
            &cwd,
            Some(&root.join("sessions")),
            SystemTime::UNIX_EPOCH,
            process_start,
        );
        assert_eq!(
            resolved.map(|(_, id)| id).as_deref(),
            Some(parent_id),
            "a child rollout must not make the owner fallback ambiguous"
        );

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn completed_resumed_codex_resolution_accepts_subagent_rollout() {
        use std::fs::{self, File};
        use std::io::Write;

        let root = std::env::temp_dir().join(format!(
            "acorn-cxsubagent-resumed-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let day = root.join("sessions").join("2026").join("06").join("10");
        fs::create_dir_all(&day).unwrap();
        let cwd = root.join("repo");
        let parent_id = "019e2001-3250-76b0-8410-2e073b38a2f1";
        let parent = day.join(format!("rollout-2026-06-10T09-59-59-{parent_id}.jsonl"));
        let mut parent_file = File::create(&parent).unwrap();
        writeln!(
            parent_file,
            "{}",
            serde_json::json!({
                "type": "session_meta",
                "payload": {
                    "id": parent_id,
                    "cwd": cwd,
                    "originator": "codex-tui",
                    "source": "cli"
                }
            })
        )
        .unwrap();
        std::thread::sleep(Duration::from_millis(1100));
        let child_id = "019e2001-3250-76b0-8410-2e073b38a2f3";
        let child = day.join(format!("rollout-2026-06-10T10-00-00-{child_id}.jsonl"));
        let mut file = File::create(&child).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type": "session_meta",
                "payload": {
                    "id": child_id,
                    "cwd": cwd,
                    "originator": "codex-tui",
                    "source": {
                        "subagent": {
                            "thread_spawn": {
                                "parent_thread_id": parent_id,
                                "depth": 1
                            }
                        }
                    }
                }
            })
        )
        .unwrap();
        let process_start = SystemTime::now();
        std::thread::sleep(Duration::from_millis(1100));
        let nested_id = "019e2001-3250-76b0-8410-2e073b38a2f4";
        let nested = day.join(format!("rollout-2026-06-10T10-00-01-{nested_id}.jsonl"));
        let mut nested_file = File::create(&nested).unwrap();
        writeln!(
            nested_file,
            "{}",
            serde_json::json!({
                "type": "session_meta",
                "payload": {
                    "id": nested_id,
                    "cwd": cwd,
                    "originator": "codex-tui",
                    "source": {
                        "subagent": {
                            "thread_spawn": {
                                "parent_thread_id": child_id,
                                "depth": 2
                            }
                        }
                    }
                }
            })
        )
        .unwrap();
        let now = fs::metadata(&nested).unwrap().modified().unwrap();
        set_mtime(&child, now);
        set_mtime(&parent, process_start - Duration::from_secs(1));

        let resolved = find_completed_resumed_codex_jsonl(
            &cwd,
            Some(&root.join("sessions")),
            SystemTime::UNIX_EPOCH,
            process_start,
        );
        assert_eq!(
            resolved,
            Some((child.clone(), child_id.to_string())),
            "a newer child of the resumed rollout must not take over the owner marker"
        );

        set_mtime(&parent, now);
        let live = find_recent_resumed_codex_jsonl(
            &cwd,
            Some(&root.join("sessions")),
            SystemTime::UNIX_EPOCH,
            process_start,
            now,
            true,
            &HashSet::new(),
        );
        assert_eq!(
            live,
            Some((child, child_id.to_string())),
            "a hot historical parent and newer child must not displace the resumed boundary"
        );

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn resumed_codex_resolution_scans_older_date_directories() {
        use std::fs::{self, File};
        use std::io::Write;

        let root = std::env::temp_dir().join(format!(
            "acorn-cxresume-old-day-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let sessions = root.join("sessions");
        let old_day = sessions.join("2025").join("12").join("31");
        let new_day = sessions.join("2026").join("07").join("15");
        fs::create_dir_all(&old_day).unwrap();
        fs::create_dir_all(&new_day).unwrap();
        let cwd = root.join("repo");
        let owner_id = "019e2001-3250-76b0-8410-2e073b38a2f3";
        let owner = old_day.join(format!("rollout-2025-12-31T23-59-59-{owner_id}.jsonl"));
        let mut owner_file = File::create(&owner).unwrap();
        writeln!(
            owner_file,
            "{}",
            serde_json::json!({
                "type": "session_meta",
                "payload": {
                    "id": owner_id,
                    "cwd": cwd,
                    "originator": "codex-tui",
                    "source": {
                        "subagent": {
                            "thread_spawn": {
                                "parent_thread_id": "019e2001-3250-76b0-8410-2e073b38a2f1",
                                "depth": 1
                            }
                        }
                    }
                }
            })
        )
        .unwrap();

        let unrelated_id = "019e2001-3250-76b0-8410-2e073b38a2f9";
        let unrelated = new_day.join(format!("rollout-2026-07-15T10-00-00-{unrelated_id}.jsonl"));
        let mut unrelated_file = File::create(&unrelated).unwrap();
        writeln!(
            unrelated_file,
            "{}",
            serde_json::json!({
                "type": "session_meta",
                "payload": {
                    "id": unrelated_id,
                    "cwd": root.join("other-repo"),
                    "originator": "codex-tui",
                    "source": "cli"
                }
            })
        )
        .unwrap();

        let process_start = SystemTime::now() - Duration::from_secs(5);
        let now = SystemTime::now();
        set_mtime(&owner, now);
        set_mtime(&unrelated, now);

        let completed = find_completed_resumed_codex_jsonl(
            &cwd,
            Some(&sessions),
            SystemTime::UNIX_EPOCH,
            process_start,
        );
        assert_eq!(completed, Some((owner.clone(), owner_id.to_string())));

        let live = find_recent_resumed_codex_jsonl(
            &cwd,
            Some(&sessions),
            SystemTime::UNIX_EPOCH,
            process_start,
            now,
            true,
            &HashSet::new(),
        );
        assert_eq!(live, Some((owner, owner_id.to_string())));

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn resumed_codex_resolution_excludes_descendants_born_in_the_first_second() {
        use std::fs::{self, File};
        use std::io::Write;

        let root = std::env::temp_dir().join(format!(
            "acorn-cxresume-first-second-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let sessions = root.join("sessions");
        let day = sessions.join("2026").join("07").join("15");
        fs::create_dir_all(&day).unwrap();
        let owner_id = "019e2001-3250-76b0-8410-2e073b38a2f3";
        let owner = day.join(format!("rollout-owner-{owner_id}.jsonl"));
        File::create(&owner).unwrap();
        let child_id = "019e2001-3250-76b0-8410-2e073b38a2f4";
        let child = day.join(format!("rollout-child-{child_id}.jsonl"));
        let mut child_file = File::create(&child).unwrap();
        writeln!(
            child_file,
            "{}",
            serde_json::json!({
                "type": "session_meta",
                "payload": {
                    "id": child_id,
                    "source": {
                        "subagent": {
                            "thread_spawn": {
                                "parent_thread_id": owner_id,
                                "depth": 1
                            }
                        }
                    }
                }
            })
        )
        .unwrap();

        let process_start = SystemTime::UNIX_EPOCH + Duration::from_secs(10_000);
        let mut candidates = vec![
            TranscriptCandidate {
                path: owner,
                birth: process_start - Duration::from_secs(60),
                mtime: process_start + Duration::from_secs(1),
                uuid: owner_id.to_string(),
            },
            TranscriptCandidate {
                path: child,
                birth: process_start + Duration::from_millis(500),
                mtime: process_start + Duration::from_secs(1),
                uuid: child_id.to_string(),
            },
        ];

        retain_resumed_codex_roots(&mut candidates, &sessions, process_start);

        assert_eq!(
            candidates
                .iter()
                .map(|candidate| candidate.uuid.as_str())
                .collect::<Vec<_>>(),
            vec![owner_id]
        );

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn explicit_codex_resume_can_select_subagent_rollout() {
        use std::fs::{self, File};
        use std::io::Write;

        let root = std::env::temp_dir().join(format!(
            "acorn-cxsubagent-explicit-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let sessions = root.join("sessions");
        let child_id = "019e2001-3250-76b0-8410-2e073b38a2f3";
        let day = codex_day_dirs_for_uuid(&sessions, child_id)
            .into_iter()
            .next()
            .unwrap();
        fs::create_dir_all(&day).unwrap();
        let child = day.join(format!("rollout-2026-06-10T10-00-00-{child_id}.jsonl"));
        let mut file = File::create(&child).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({
                "type": "session_meta",
                "payload": {
                    "id": child_id,
                    "cwd": "/tmp/repo",
                    "originator": "codex-tui",
                    "source": {
                        "subagent": {
                            "thread_spawn": {
                                "parent_thread_id": "019e2001-3250-76b0-8410-2e073b38a2f1",
                                "depth": 1
                            }
                        }
                    }
                }
            })
        )
        .unwrap();

        let resolved = find_codex_jsonl_for_uuid(Some(&sessions), child_id, &HashSet::new());
        assert_eq!(resolved, Some((child, child_id.to_string())));

        fs::remove_dir_all(&root).unwrap();
    }

    /// Backs `find_agent_run_transcript`, the path-returning form the
    /// status poll's codex marker fallback consumes: the resolver must
    /// hand back the rollout path alongside the id.
    #[test]
    fn find_completed_codex_jsonl_returns_path_and_id() {
        use std::fs::{self, File};
        use std::io::Write;

        let root =
            std::env::temp_dir().join(format!("acorn-cxlive-{}", uuid::Uuid::new_v4().simple()));
        let day = root.join("sessions").join("2026").join("06").join("10");
        fs::create_dir_all(&day).unwrap();
        let cwd = root.join("repo");

        let id = "019e2001-3250-76b0-8410-2e073b38a2f1";
        let rollout = day.join(format!("rollout-2026-06-10T10-00-00-{id}.jsonl"));
        let mut f = File::create(&rollout).unwrap();
        writeln!(
            f,
            "{{\"payload\":{{\"cwd\":\"{}\",\"originator\":\"codex-tui\"}}}}",
            cwd.display()
        )
        .unwrap();
        let now = fs::metadata(&rollout).unwrap().modified().unwrap();
        let process_start = now - Duration::from_secs(5);

        let resolved = find_completed_codex_jsonl(
            &cwd,
            Some(&root.join("sessions")),
            SystemTime::UNIX_EPOCH,
            process_start,
        );
        assert_eq!(
            resolved,
            Some((rollout.clone(), id.to_string())),
            "resolver must return both the rollout path and its id"
        );

        fs::remove_dir_all(&root).unwrap();
    }

    /// The completed-run resolver refuses ambiguous matches, so a GUI-host
    /// rollout in the same cwd would otherwise turn one legitimate
    /// candidate into two and resolve nothing.
    #[test]
    fn find_completed_codex_jsonl_ignores_gui_host_rollouts() {
        use std::fs::{self, File};
        use std::io::Write;

        let root =
            std::env::temp_dir().join(format!("acorn-cxguic-{}", uuid::Uuid::new_v4().simple()));
        let day = root.join("sessions").join("2026").join("06").join("10");
        fs::create_dir_all(&day).unwrap();
        let cwd = root.join("repo");

        let write_rollout = |name: &str, originator: &str| {
            let path = day.join(name);
            let mut f = File::create(&path).unwrap();
            writeln!(
                f,
                "{{\"payload\":{{\"cwd\":\"{}\",\"originator\":\"{originator}\"}}}}",
                cwd.display()
            )
            .unwrap();
            path
        };

        write_rollout(
            "rollout-2026-06-10T10-00-00-019e2001-3250-76b0-8410-2e073b38a2e1.jsonl",
            "Codex Desktop",
        );
        let exec = write_rollout(
            "rollout-2026-06-10T10-00-01-019e2001-3250-76b0-8410-2e073b38a2e2.jsonl",
            "codex_exec",
        );
        let now = fs::metadata(&exec).unwrap().modified().unwrap();
        let process_start = now - Duration::from_secs(5);

        let resolved = find_completed_codex_jsonl(
            &cwd,
            Some(&root.join("sessions")),
            SystemTime::UNIX_EPOCH,
            process_start,
        );
        assert_eq!(
            resolved.map(|(_, id)| id).as_deref(),
            Some("019e2001-3250-76b0-8410-2e073b38a2e2"),
            "GUI-host rollouts must not break the unique-candidate policy"
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
