//! Project-owned agent schedules. A schedule is a prompt plus a recurrence;
//! the frontend ticker launches a session for it when it comes due and records
//! the run here so the schedule's board tab can resume or summarize it later.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use chrono::{SecondsFormat, Utc};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::{persistence, project_settings};

const PROJECT_SCHEDULES_FILE: &str = "project_schedules.json";
const MAX_PROJECT_SCHEDULES_FILE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_SCHEDULES_PER_PROJECT: usize = 100;
const MAX_RUNS_PER_SCHEDULE: usize = 100;
const MAX_NAME_CHARS: usize = 200;
const MAX_PROMPT_CHARS: usize = 20_000;
const MAX_ERROR_CHARS: usize = 2_000;
const MAX_EVERY_MINUTES: u64 = 7 * 24 * 60;
/// Directory, relative to the project root, that holds run summaries. Mirrors
/// `SCHEDULE_SUMMARY_DIR` in `src/lib/scheduleRunner.ts`, which is what builds
/// the path the agent is actually told to write.
const SUMMARY_DIR: &str = "schedule-summaries";
const ACORN_DIR: &str = ".acorn";

static STORE_LOCK: Mutex<()> = Mutex::new(());

/// How a run reaches the agent. `Session` types the interactive start command
/// so the conversation stays open and resumable; `Oneshot` types the provider's
/// `-p` form, which prints and exits.
///
/// A background schedule is always `Oneshot`: nothing is watching it, so an
/// interactive agent would just sit at its prompt in a session the workspace
/// deliberately hides. `enforce_background_mode` is what keeps that true no
/// matter which field the caller set.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ScheduleMode {
    #[default]
    Session,
    Oneshot,
}

/// Recurrence. `time` is wall-clock `HH:MM` in the user's local zone — the
/// frontend owns the next-run math because only it knows that zone.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ScheduleTrigger {
    Interval { every_minutes: u64 },
    Daily { time: String },
    Weekly { weekday: u8, time: String },
}

impl ScheduleTrigger {
    fn validate(&self) -> Result<(), ScheduleStoreError> {
        match self {
            Self::Interval { every_minutes } => {
                if *every_minutes < 1 || *every_minutes > MAX_EVERY_MINUTES {
                    return Err(ScheduleStoreError::Invalid(format!(
                        "interval must be between 1 and {MAX_EVERY_MINUTES} minutes"
                    )));
                }
                Ok(())
            }
            Self::Daily { time } => validate_time(time),
            Self::Weekly { weekday, time } => {
                if *weekday > 6 {
                    return Err(ScheduleStoreError::Invalid(
                        "weekday must be 0 (Sunday) through 6".to_string(),
                    ));
                }
                validate_time(time)
            }
        }
    }
}

/// Background implies one-shot. Enforced here rather than in the UI so the
/// invariant cannot be bypassed by an older client or a hand-edited file.
fn enforce_background_mode(mode: ScheduleMode, background: bool) -> ScheduleMode {
    if background {
        ScheduleMode::Oneshot
    } else {
        mode
    }
}

fn validate_time(time: &str) -> Result<(), ScheduleStoreError> {
    let invalid = || ScheduleStoreError::Invalid(format!("invalid time of day: {time}"));
    let (hour, minute) = time.split_once(':').ok_or_else(invalid)?;
    if hour.len() != 2 || minute.len() != 2 {
        return Err(invalid());
    }
    let hour: u32 = hour.parse().map_err(|_| invalid())?;
    let minute: u32 = minute.parse().map_err(|_| invalid())?;
    if hour > 23 || minute > 59 {
        return Err(invalid());
    }
    Ok(())
}

/// One launch attempt. A failed launch still lands here so the schedule does
/// not re-fire on the very next tick.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ScheduleRun {
    pub id: String,
    pub started_at: String,
    #[serde(default)]
    pub session_id: Option<String>,
    /// Kept beside `session_id` so the run stays traceable after the session
    /// row is removed.
    #[serde(default)]
    pub worktree_path: Option<String>,
    /// File the run's prompt asked the agent to write its work summary to.
    /// Recorded rather than recomputed so the board reads exactly what the
    /// agent was told, even if the path layout changes later.
    #[serde(default)]
    pub summary_path: Option<String>,
    /// Whether that summary is actually on disk. Recomputed on every read and
    /// never trusted from the file — `skip_deserializing` is what guarantees
    /// that, so the copy the file carries is informational only. This is the
    /// only end-of-run signal Acorn has: the agent writes the summary last.
    #[serde(default, skip_deserializing)]
    pub summary_ready: bool,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProjectSchedule {
    pub id: String,
    pub name: String,
    pub prompt: String,
    pub trigger: ScheduleTrigger,
    #[serde(default)]
    pub mode: ScheduleMode,
    /// Run without ever placing the session in the workspace. Requires the
    /// `acornd` daemon, which is what owns the PTY when no terminal is mounted.
    #[serde(default)]
    pub background: bool,
    pub created_at: String,
    /// When a run last happened, for display. Manual runs move this.
    #[serde(default)]
    pub last_run_at: Option<String>,
    /// The scheduling cursor: the last slot the *timer* consumed. Separate from
    /// `last_run_at` on purpose — anchoring the next slot on when a run
    /// actually started folds the tick's lateness into every later slot, and
    /// lets a manual "Run now" shove the whole schedule forward. Only the
    /// scheduler advances this, and only to exact slot times.
    #[serde(default)]
    pub last_slot_at: Option<String>,
    #[serde(default)]
    pub runs: Vec<ScheduleRun>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRunInput {
    /// Minted by the caller so the prompt it builds can name the run's summary
    /// file before the run exists on disk.
    #[serde(default)]
    pub id: Option<String>,
    /// The slot this run consumes, when the scheduler is the one firing. Absent
    /// for a manual run, which must not move the cursor.
    #[serde(default)]
    pub slot_at: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub worktree_path: Option<String>,
    #[serde(default)]
    pub summary_path: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

/// Editable fields of a schedule. Omitted fields keep their current value, so
/// the run history and `last_run_at` are untouched by an edit.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleUpdate {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub trigger: Option<ScheduleTrigger>,
    #[serde(default)]
    pub mode: Option<ScheduleMode>,
    #[serde(default)]
    pub background: Option<bool>,
}

/// What a launch learned after its slot was already claimed. `summary_path` is
/// set at claim time and never changes, so it is not patchable here.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRunPatch {
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub worktree_path: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug)]
pub enum ScheduleStoreError {
    NotFound,
    Invalid(String),
    Failed(AppError),
}

impl From<AppError> for ScheduleStoreError {
    fn from(error: AppError) -> Self {
        Self::Failed(error)
    }
}

pub fn schedule_store_error(error: ScheduleStoreError) -> AppError {
    match error {
        ScheduleStoreError::NotFound => AppError::Other("schedule not found".to_string()),
        ScheduleStoreError::Invalid(message) => AppError::Other(message),
        ScheduleStoreError::Failed(error) => error,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct ScheduleFile {
    #[serde(default)]
    projects: BTreeMap<String, Vec<ProjectSchedule>>,
}

pub fn list(repo_path: &Path) -> Result<Vec<ProjectSchedule>, ScheduleStoreError> {
    let _guard = STORE_LOCK.lock();
    let key = project_settings::key_for_repo(repo_path)?;
    let file = load()?;
    let mut schedules = file.projects.get(&key).cloned().unwrap_or_default();
    for schedule in &mut schedules {
        mark_summary_ready(repo_path, schedule);
    }
    Ok(schedules)
}

pub fn create(
    repo_path: &Path,
    name: &str,
    prompt: &str,
    trigger: ScheduleTrigger,
    mode: ScheduleMode,
    background: bool,
) -> Result<ProjectSchedule, ScheduleStoreError> {
    let name = required_text(name, MAX_NAME_CHARS, "name")?;
    let prompt = required_text(prompt, MAX_PROMPT_CHARS, "prompt")?;
    trigger.validate()?;
    let _guard = STORE_LOCK.lock();
    let key = project_settings::key_for_repo(repo_path)?;
    let mut file = load()?;
    let bucket = file.projects.entry(key).or_default();
    if bucket.len() >= MAX_SCHEDULES_PER_PROJECT {
        return Err(ScheduleStoreError::Invalid(
            "this project already has the maximum number of schedules".to_string(),
        ));
    }
    let schedule = ProjectSchedule {
        id: Uuid::new_v4().to_string(),
        name,
        prompt,
        trigger,
        mode: enforce_background_mode(mode, background),
        background,
        created_at: timestamp(),
        last_run_at: None,
        last_slot_at: None,
        runs: Vec::new(),
    };
    bucket.push(schedule.clone());
    save(&file)?;
    Ok(schedule)
}

pub fn update(
    repo_path: &Path,
    id: &str,
    patch: ScheduleUpdate,
) -> Result<ProjectSchedule, ScheduleStoreError> {
    let name = patch
        .name
        .as_deref()
        .map(|name| required_text(name, MAX_NAME_CHARS, "name"))
        .transpose()?;
    let prompt = patch
        .prompt
        .as_deref()
        .map(|prompt| required_text(prompt, MAX_PROMPT_CHARS, "prompt"))
        .transpose()?;
    if let Some(trigger) = patch.trigger.as_ref() {
        trigger.validate()?;
    }
    let _guard = STORE_LOCK.lock();
    let key = project_settings::key_for_repo(repo_path)?;
    let mut file = load()?;
    let bucket = file
        .projects
        .get_mut(&key)
        .ok_or(ScheduleStoreError::NotFound)?;
    let index = resolve_index(bucket, id)?;
    let schedule = &mut bucket[index];
    if let Some(name) = name {
        schedule.name = name;
    }
    if let Some(prompt) = prompt {
        schedule.prompt = prompt;
    }
    if let Some(trigger) = patch.trigger {
        // The cursor holds a slot of the *old* cadence, which says nothing
        // about the new one. Dropping it restarts the sequence from now.
        if schedule.trigger != trigger {
            schedule.last_slot_at = None;
        }
        schedule.trigger = trigger;
    }
    if let Some(mode) = patch.mode {
        schedule.mode = mode;
    }
    if let Some(background) = patch.background {
        schedule.background = background;
    }
    schedule.mode = enforce_background_mode(schedule.mode, schedule.background);
    let mut updated = schedule.clone();
    save(&file)?;
    mark_summary_ready(repo_path, &mut updated);
    Ok(updated)
}

pub fn delete(repo_path: &Path, id: &str) -> Result<(), ScheduleStoreError> {
    let _guard = STORE_LOCK.lock();
    let key = project_settings::key_for_repo(repo_path)?;
    let mut file = load()?;
    let bucket = file
        .projects
        .get_mut(&key)
        .ok_or(ScheduleStoreError::NotFound)?;
    let index = resolve_index(bucket, id)?;
    let removed = bucket.remove(index);
    save(&file)?;
    for run in &removed.runs {
        remove_summary_file(repo_path, run);
    }
    Ok(())
}

/// Drop a schedule's whole run history and the summary files that went with
/// it. The automatic cap only evicts one run at a time, so this is the escape
/// hatch for a schedule that has been running for months.
pub fn clear_runs(repo_path: &Path, id: &str) -> Result<ProjectSchedule, ScheduleStoreError> {
    let _guard = STORE_LOCK.lock();
    let key = project_settings::key_for_repo(repo_path)?;
    let mut file = load()?;
    let bucket = file
        .projects
        .get_mut(&key)
        .ok_or(ScheduleStoreError::NotFound)?;
    let index = resolve_index(bucket, id)?;
    let dropped = std::mem::take(&mut bucket[index].runs);
    let updated = bucket[index].clone();
    save(&file)?;
    for run in &dropped {
        remove_summary_file(repo_path, run);
    }
    Ok(updated)
}

/// Append a launch attempt and advance `last_run_at`, which is the anchor the
/// frontend's due check measures the next run from.
pub fn record_run(
    repo_path: &Path,
    id: &str,
    run: ScheduleRunInput,
) -> Result<ProjectSchedule, ScheduleStoreError> {
    let error = run
        .error
        .as_deref()
        .map(|error| bounded_text(error.trim(), MAX_ERROR_CHARS, "error"))
        .transpose()?
        .filter(|error| !error.is_empty());
    let run_id = match run.id.as_deref().map(str::trim).filter(|id| !id.is_empty()) {
        Some(id) => run_token(id)?,
        None => Uuid::new_v4().to_string(),
    };
    let _guard = STORE_LOCK.lock();
    let key = project_settings::key_for_repo(repo_path)?;
    let mut file = load()?;
    let bucket = file
        .projects
        .get_mut(&key)
        .ok_or(ScheduleStoreError::NotFound)?;
    let index = resolve_index(bucket, id)?;
    let schedule = &mut bucket[index];
    let now = timestamp();
    let evicted = (schedule.runs.len() >= MAX_RUNS_PER_SCHEDULE).then(|| schedule.runs.remove(0));
    schedule.runs.push(ScheduleRun {
        id: run_id,
        started_at: now.clone(),
        session_id: run.session_id,
        worktree_path: run.worktree_path,
        summary_path: run.summary_path,
        summary_ready: false,
        error,
    });
    schedule.last_run_at = Some(now);
    if let Some(slot_at) = run.slot_at {
        schedule.last_slot_at = Some(slot_at);
    }
    let mut updated = schedule.clone();
    save(&file)?;
    // A summary file whose run is no longer listed can never be opened again,
    // so it follows the record out rather than accumulating on disk forever.
    if let Some(evicted) = evicted.as_ref() {
        remove_summary_file(repo_path, evicted);
    }
    mark_summary_ready(repo_path, &mut updated);
    Ok(updated)
}

/// Stamp `summary_ready` from the filesystem. Only the paths we would also be
/// willing to delete are probed, which keeps a hand-edited `summary_path` from
/// turning this into an arbitrary file-existence oracle.
fn mark_summary_ready(repo_path: &Path, schedule: &mut ProjectSchedule) {
    for run in &mut schedule.runs {
        run.summary_ready =
            summary_file_to_remove(repo_path, run).is_some_and(|path| path.is_file());
    }
}

/// Fill in what the launch produced for a run whose slot was already claimed.
/// The claim is what advances `last_run_at`, so this never touches it — a
/// second tick must stay un-due while the launch is still in flight.
pub fn update_run(
    repo_path: &Path,
    id: &str,
    run_id: &str,
    patch: ScheduleRunPatch,
) -> Result<ProjectSchedule, ScheduleStoreError> {
    let error = patch
        .error
        .as_deref()
        .map(|error| bounded_text(error.trim(), MAX_ERROR_CHARS, "error"))
        .transpose()?
        .filter(|error| !error.is_empty());
    let _guard = STORE_LOCK.lock();
    let key = project_settings::key_for_repo(repo_path)?;
    let mut file = load()?;
    let bucket = file
        .projects
        .get_mut(&key)
        .ok_or(ScheduleStoreError::NotFound)?;
    let index = resolve_index(bucket, id)?;
    let schedule = &mut bucket[index];
    let run = schedule
        .runs
        .iter_mut()
        .find(|run| run.id == run_id.trim())
        .ok_or(ScheduleStoreError::NotFound)?;
    run.session_id = patch.session_id;
    run.worktree_path = patch.worktree_path;
    run.error = error;
    let mut updated = schedule.clone();
    save(&file)?;
    mark_summary_ready(repo_path, &mut updated);
    Ok(updated)
}

/// Drop one run and the summary file it wrote.
pub fn delete_run(
    repo_path: &Path,
    id: &str,
    run_id: &str,
) -> Result<ProjectSchedule, ScheduleStoreError> {
    let _guard = STORE_LOCK.lock();
    let key = project_settings::key_for_repo(repo_path)?;
    let mut file = load()?;
    let bucket = file
        .projects
        .get_mut(&key)
        .ok_or(ScheduleStoreError::NotFound)?;
    let index = resolve_index(bucket, id)?;
    let schedule = &mut bucket[index];
    let at = schedule
        .runs
        .iter()
        .position(|run| run.id == run_id.trim())
        .ok_or(ScheduleStoreError::NotFound)?;
    let removed = schedule.runs.remove(at);
    let mut updated = schedule.clone();
    save(&file)?;
    remove_summary_file(repo_path, &removed);
    mark_summary_ready(repo_path, &mut updated);
    Ok(updated)
}

/// The summary file to delete for `run`, or `None` when the recorded path is
/// not one we wrote. `summary_path` arrives from the frontend, so a path that
/// does not sit directly in `<repo>/.acorn/schedule-summaries` under the run's
/// own id is refused rather than deleted.
fn summary_file_to_remove(repo_path: &Path, run: &ScheduleRun) -> Option<PathBuf> {
    let recorded = Path::new(run.summary_path.as_deref()?);
    let expected = repo_path
        .join(ACORN_DIR)
        .join(SUMMARY_DIR)
        .join(format!("{}.md", run.id));
    (recorded == expected).then_some(expected)
}

fn remove_summary_file(repo_path: &Path, run: &ScheduleRun) {
    let Some(path) = summary_file_to_remove(repo_path, run) else {
        return;
    };
    // Best effort: the user may have deleted it, or the agent may never have
    // written it. Neither is worth failing the store write that just landed.
    std::fs::remove_file(path).ok();
}

fn resolve_index(bucket: &[ProjectSchedule], id: &str) -> Result<usize, ScheduleStoreError> {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return Err(ScheduleStoreError::Invalid(
            "schedule id is required".to_string(),
        ));
    }
    bucket
        .iter()
        .position(|schedule| schedule.id == trimmed)
        .ok_or(ScheduleStoreError::NotFound)
}

/// Run ids name a file the agent is told to write, so only an opaque token
/// shape is accepted — never a caller-supplied path fragment.
fn run_token(id: &str) -> Result<String, ScheduleStoreError> {
    let valid = id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !valid {
        return Err(ScheduleStoreError::Invalid(
            "run id must be up to 64 characters of letters, digits, '-', or '_'".to_string(),
        ));
    }
    Ok(id.to_string())
}

fn required_text(value: &str, max_chars: usize, label: &str) -> Result<String, ScheduleStoreError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(ScheduleStoreError::Invalid(format!("{label} is required")));
    }
    bounded_text(trimmed, max_chars, label)
}

fn bounded_text(value: &str, max_chars: usize, label: &str) -> Result<String, ScheduleStoreError> {
    if value.chars().count() > max_chars {
        return Err(ScheduleStoreError::Invalid(format!("{label} is too long")));
    }
    Ok(value.to_string())
}

fn timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn schedules_path() -> AppResult<PathBuf> {
    Ok(persistence::data_dir()?.join(PROJECT_SCHEDULES_FILE))
}

fn load() -> Result<ScheduleFile, ScheduleStoreError> {
    let path = schedules_path()?;
    let bytes =
        match persistence::read_bounded_regular_file(&path, MAX_PROJECT_SCHEDULES_FILE_BYTES) {
            Ok(bytes) => bytes,
            Err(AppError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(ScheduleFile::default());
            }
            Err(error) => return Err(error.into()),
        };
    serde_json::from_slice(&bytes).map_err(|error| {
        ScheduleStoreError::Failed(AppError::Other(format!(
            "failed to parse project schedules: {error}"
        )))
    })
}

fn save(file: &ScheduleFile) -> Result<(), ScheduleStoreError> {
    let path = schedules_path()?;
    let payload = serde_json::to_vec_pretty(file).map_err(|error| {
        ScheduleStoreError::Failed(AppError::Other(format!(
            "failed to serialize project schedules: {error}"
        )))
    })?;
    persistence::ensure_payload_within_limit(
        &payload,
        MAX_PROJECT_SCHEDULES_FILE_BYTES,
        "project schedules",
    )?;
    acorn_platform::fs::write_atomic_private(&path, &payload)
        .map_err(|error| ScheduleStoreError::Failed(AppError::Io(error)))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_data_dir(test: impl FnOnce()) {
        let dir = tempfile::tempdir().unwrap();
        persistence::with_test_data_dir(dir.path(), test);
    }

    #[test]
    fn create_record_and_delete_round_trip() {
        with_data_dir(|| {
            let repo = PathBuf::from("/tmp/acorn-project-schedules");
            let created = create(
                &repo,
                "Nightly audit",
                "Check the dependency report",
                ScheduleTrigger::Daily {
                    time: "09:30".to_string(),
                },
                ScheduleMode::Session,
                false,
            )
            .unwrap();
            assert!(created.last_run_at.is_none());
            assert_eq!(list(&repo).unwrap().len(), 1);

            let ran = record_run(
                &repo,
                &created.id,
                ScheduleRunInput {
                    id: Some("run-abc".to_string()),
                    slot_at: None,
                    session_id: Some("session-1".to_string()),
                    worktree_path: Some("/tmp/acorn-project-schedules".to_string()),
                    summary_path: Some(
                        "/tmp/acorn-project-schedules/.acorn/schedule-summaries/run-abc.md"
                            .to_string(),
                    ),
                    error: None,
                },
            )
            .unwrap();
            assert_eq!(ran.runs.len(), 1);
            assert_eq!(ran.runs[0].id, "run-abc");
            assert_eq!(ran.runs[0].session_id.as_deref(), Some("session-1"));
            assert!(ran.runs[0]
                .summary_path
                .as_deref()
                .is_some_and(|path| path.ends_with("run-abc.md")));
            assert_eq!(
                ran.last_run_at.as_deref(),
                Some(ran.runs[0].started_at.as_str())
            );

            delete(&repo, &created.id).unwrap();
            assert!(list(&repo).unwrap().is_empty());
        });
    }

    #[test]
    fn rejects_an_out_of_range_trigger() {
        with_data_dir(|| {
            let repo = PathBuf::from("/tmp/acorn-project-schedules-invalid");
            assert!(create(
                &repo,
                "Bad time",
                "do something",
                ScheduleTrigger::Daily {
                    time: "24:00".to_string()
                },
                ScheduleMode::Session,
                false,
            )
            .is_err());
            assert!(create(
                &repo,
                "Bad interval",
                "do something",
                ScheduleTrigger::Interval { every_minutes: 0 },
                ScheduleMode::Session,
                false,
            )
            .is_err());
            assert!(create(
                &repo,
                "Bad weekday",
                "do something",
                ScheduleTrigger::Weekly {
                    weekday: 7,
                    time: "09:00".to_string()
                },
                ScheduleMode::Session,
                false,
            )
            .is_err());
        });
    }

    #[test]
    fn rejects_a_path_shaped_run_id() {
        with_data_dir(|| {
            let repo = PathBuf::from("/tmp/acorn-project-schedules-token");
            let created = create(
                &repo,
                "Probe",
                "ping",
                ScheduleTrigger::Interval { every_minutes: 5 },
                ScheduleMode::Session,
                false,
            )
            .unwrap();
            for bad in ["../escape", "a/b", "with space", &"x".repeat(65)] {
                assert!(
                    record_run(
                        &repo,
                        &created.id,
                        ScheduleRunInput {
                            id: Some(bad.to_string()),
                            ..Default::default()
                        },
                    )
                    .is_err(),
                    "expected {bad} to be refused"
                );
            }
        });
    }

    #[test]
    fn a_background_schedule_is_always_one_shot() {
        with_data_dir(|| {
            let repo = PathBuf::from("/tmp/acorn-schedule-bg-mode");
            // Asked for an interactive session *and* background: background wins,
            // because nothing would ever read that prompt.
            let created = create(
                &repo,
                "Crawl",
                "fetch the listings",
                ScheduleTrigger::Interval { every_minutes: 30 },
                ScheduleMode::Session,
                true,
            )
            .unwrap();
            assert_eq!(created.mode, ScheduleMode::Oneshot);

            // Turning background on later coerces the stored mode too.
            let foreground = create(
                &repo,
                "Audit",
                "review things",
                ScheduleTrigger::Interval { every_minutes: 30 },
                ScheduleMode::Session,
                false,
            )
            .unwrap();
            assert_eq!(foreground.mode, ScheduleMode::Session);
            let edited = update(
                &repo,
                &foreground.id,
                ScheduleUpdate {
                    background: Some(true),
                    ..Default::default()
                },
            )
            .unwrap();
            assert_eq!(edited.mode, ScheduleMode::Oneshot);

            // And turning it back off leaves the mode editable again.
            let restored = update(
                &repo,
                &foreground.id,
                ScheduleUpdate {
                    background: Some(false),
                    mode: Some(ScheduleMode::Session),
                    ..Default::default()
                },
            )
            .unwrap();
            assert_eq!(restored.mode, ScheduleMode::Session);
        });
    }

    #[test]
    fn summary_ready_tracks_the_file_and_is_never_read_from_disk() {
        with_data_dir(|| {
            let dir = tempfile::tempdir().unwrap();
            let repo = dir.path().to_path_buf();
            let created = create(
                &repo,
                "Hourly",
                "ping",
                ScheduleTrigger::Interval { every_minutes: 60 },
                ScheduleMode::Session,
                false,
            )
            .unwrap();
            let summary = repo.join(".acorn/schedule-summaries/run-1.md");
            record_run(
                &repo,
                &created.id,
                ScheduleRunInput {
                    id: Some("run-1".to_string()),
                    summary_path: Some(summary.to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .unwrap();

            // The run is recorded before the agent writes anything.
            assert!(!list(&repo).unwrap()[0].runs[0].summary_ready);

            std::fs::create_dir_all(summary.parent().unwrap()).unwrap();
            std::fs::write(&summary, "## Result\nok\n").unwrap();
            assert!(list(&repo).unwrap()[0].runs[0].summary_ready);

            // A file that disappears takes the flag with it, so the board can
            // never offer a summary that is not there.
            std::fs::remove_file(&summary).unwrap();
            assert!(!list(&repo).unwrap()[0].runs[0].summary_ready);
        });
    }

    #[test]
    fn editing_a_schedule_leaves_its_history_alone() {
        with_data_dir(|| {
            let repo = PathBuf::from("/tmp/acorn-schedule-edit");
            let created = create(
                &repo,
                "Nightly",
                "check things",
                ScheduleTrigger::Daily {
                    time: "09:00".to_string(),
                },
                ScheduleMode::Session,
                false,
            )
            .unwrap();
            record_run(
                &repo,
                &created.id,
                ScheduleRunInput {
                    id: Some("run-1".to_string()),
                    ..Default::default()
                },
            )
            .unwrap();

            let edited = update(
                &repo,
                &created.id,
                ScheduleUpdate {
                    name: Some("Nightly audit".to_string()),
                    trigger: Some(ScheduleTrigger::Interval { every_minutes: 45 }),
                    mode: Some(ScheduleMode::Oneshot),
                    background: Some(true),
                    ..Default::default()
                },
            )
            .unwrap();
            assert_eq!(edited.name, "Nightly audit");
            assert_eq!(edited.prompt, "check things", "omitted fields stay put");
            assert_eq!(
                edited.trigger,
                ScheduleTrigger::Interval { every_minutes: 45 }
            );
            assert_eq!(edited.mode, ScheduleMode::Oneshot);
            assert!(edited.background);
            assert_eq!(edited.runs.len(), 1, "an edit must not touch the history");
            assert!(edited.last_run_at.is_some());

            assert!(update(
                &repo,
                &created.id,
                ScheduleUpdate {
                    name: Some("   ".to_string()),
                    ..Default::default()
                }
            )
            .is_err());
            assert!(update(
                &repo,
                &created.id,
                ScheduleUpdate {
                    trigger: Some(ScheduleTrigger::Daily {
                        time: "99:99".to_string()
                    }),
                    ..Default::default()
                }
            )
            .is_err());
        });
    }

    #[test]
    fn only_a_scheduled_run_moves_the_cursor() {
        with_data_dir(|| {
            let repo = PathBuf::from("/tmp/acorn-schedule-cursor");
            let created = create(
                &repo,
                "Hourly",
                "ping",
                ScheduleTrigger::Interval { every_minutes: 60 },
                ScheduleMode::Session,
                false,
            )
            .unwrap();
            assert!(created.last_slot_at.is_none());

            // A manual run: `last_run_at` moves, the cursor does not, so the
            // timer keeps its own cadence.
            let manual = record_run(
                &repo,
                &created.id,
                ScheduleRunInput {
                    id: Some("run-manual".to_string()),
                    ..Default::default()
                },
            )
            .unwrap();
            assert!(manual.last_run_at.is_some());
            assert!(manual.last_slot_at.is_none());

            // A scheduled run carries the slot it consumed.
            let scheduled = record_run(
                &repo,
                &created.id,
                ScheduleRunInput {
                    id: Some("run-timer".to_string()),
                    slot_at: Some("2026-03-10T09:00:00Z".to_string()),
                    ..Default::default()
                },
            )
            .unwrap();
            assert_eq!(
                scheduled.last_slot_at.as_deref(),
                Some("2026-03-10T09:00:00Z")
            );
            assert_ne!(
                scheduled.last_run_at.as_deref(),
                scheduled.last_slot_at.as_deref()
            );

            // Changing the cadence drops a cursor that belonged to the old one.
            let retimed = update(
                &repo,
                &created.id,
                ScheduleUpdate {
                    trigger: Some(ScheduleTrigger::Interval { every_minutes: 15 }),
                    ..Default::default()
                },
            )
            .unwrap();
            assert!(retimed.last_slot_at.is_none());

            // An edit that leaves the trigger alone keeps it.
            record_run(
                &repo,
                &created.id,
                ScheduleRunInput {
                    id: Some("run-timer-2".to_string()),
                    slot_at: Some("2026-03-10T09:15:00Z".to_string()),
                    ..Default::default()
                },
            )
            .unwrap();
            let renamed = update(
                &repo,
                &created.id,
                ScheduleUpdate {
                    name: Some("Quarterly".to_string()),
                    ..Default::default()
                },
            )
            .unwrap();
            assert_eq!(
                renamed.last_slot_at.as_deref(),
                Some("2026-03-10T09:15:00Z")
            );
        });
    }

    #[test]
    fn claiming_a_slot_then_patching_it_keeps_one_run() {
        with_data_dir(|| {
            let repo = PathBuf::from("/tmp/acorn-schedule-claim");
            let created = create(
                &repo,
                "Hourly",
                "ping",
                ScheduleTrigger::Interval { every_minutes: 60 },
                ScheduleMode::Session,
                false,
            )
            .unwrap();

            // The claim is what advances `last_run_at`, which is how a second
            // tick finds the schedule un-due while the launch is in flight.
            let claimed = record_run(
                &repo,
                &created.id,
                ScheduleRunInput {
                    id: Some("run-1".to_string()),
                    ..Default::default()
                },
            )
            .unwrap();
            assert_eq!(claimed.runs.len(), 1);
            let claimed_at = claimed.last_run_at.clone();
            assert!(claimed_at.is_some());

            let patched = update_run(
                &repo,
                &created.id,
                "run-1",
                ScheduleRunPatch {
                    session_id: Some("session-1".to_string()),
                    worktree_path: Some("/tmp/acorn-schedule-claim".to_string()),
                    error: None,
                },
            )
            .unwrap();
            assert_eq!(patched.runs.len(), 1, "patching must not append a run");
            assert_eq!(patched.runs[0].session_id.as_deref(), Some("session-1"));
            assert_eq!(
                patched.last_run_at, claimed_at,
                "patching must not re-stamp the claim"
            );

            assert!(
                update_run(&repo, &created.id, "missing", ScheduleRunPatch::default()).is_err()
            );
        });
    }

    #[test]
    fn deleting_one_run_drops_only_its_summary_file() {
        with_data_dir(|| {
            let dir = tempfile::tempdir().unwrap();
            let repo = dir.path().to_path_buf();
            let created = create(
                &repo,
                "Hourly",
                "ping",
                ScheduleTrigger::Interval { every_minutes: 60 },
                ScheduleMode::Session,
                false,
            )
            .unwrap();
            let summary_for = |id: &str| repo.join(format!(".acorn/schedule-summaries/{id}.md"));
            std::fs::create_dir_all(summary_for("x").parent().unwrap()).unwrap();
            for id in ["run-a", "run-b"] {
                let path = summary_for(id);
                std::fs::write(&path, "## Result\nok\n").unwrap();
                record_run(
                    &repo,
                    &created.id,
                    ScheduleRunInput {
                        id: Some(id.to_string()),
                        summary_path: Some(path.to_string_lossy().to_string()),
                        ..Default::default()
                    },
                )
                .unwrap();
            }

            let left = delete_run(&repo, &created.id, "run-a").unwrap();
            assert_eq!(
                left.runs
                    .iter()
                    .map(|run| run.id.as_str())
                    .collect::<Vec<_>>(),
                vec!["run-b"]
            );
            assert!(!summary_for("run-a").exists());
            assert!(summary_for("run-b").exists());
            assert!(delete_run(&repo, &created.id, "run-a").is_err());
        });
    }

    #[test]
    fn summary_cleanup_only_touches_files_we_wrote() {
        let repo = Path::new("/tmp/acorn-schedule-summary-guard");
        let run = |summary: Option<&str>| ScheduleRun {
            id: "run-1".to_string(),
            started_at: "2026-01-01T00:00:00Z".to_string(),
            session_id: None,
            worktree_path: None,
            summary_path: summary.map(str::to_string),
            summary_ready: false,
            error: None,
        };

        assert_eq!(
            summary_file_to_remove(
                repo,
                &run(Some(
                    "/tmp/acorn-schedule-summary-guard/.acorn/schedule-summaries/run-1.md"
                ))
            ),
            Some(repo.join(".acorn/schedule-summaries/run-1.md"))
        );
        assert_eq!(summary_file_to_remove(repo, &run(None)), None);
        for refused in [
            // Another run's file, a path outside the directory, a traversal,
            // and a different project entirely.
            "/tmp/acorn-schedule-summary-guard/.acorn/schedule-summaries/run-2.md",
            "/tmp/acorn-schedule-summary-guard/README.md",
            "/tmp/acorn-schedule-summary-guard/.acorn/schedule-summaries/../../README.md",
            "/etc/hosts",
        ] {
            assert_eq!(
                summary_file_to_remove(repo, &run(Some(refused))),
                None,
                "expected {refused} to be refused"
            );
        }
    }

    #[test]
    fn clearing_runs_drops_the_history_and_its_summary_files() {
        with_data_dir(|| {
            let dir = tempfile::tempdir().unwrap();
            let repo = dir.path().to_path_buf();
            let created = create(
                &repo,
                "Hourly",
                "check things",
                ScheduleTrigger::Interval { every_minutes: 60 },
                ScheduleMode::Session,
                false,
            )
            .unwrap();
            let summary = repo.join(".acorn/schedule-summaries/run-keep.md");
            std::fs::create_dir_all(summary.parent().unwrap()).unwrap();
            std::fs::write(&summary, "## Result\nall good\n").unwrap();
            record_run(
                &repo,
                &created.id,
                ScheduleRunInput {
                    id: Some("run-keep".to_string()),
                    summary_path: Some(summary.to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .unwrap();
            assert!(summary.exists());

            let cleared = clear_runs(&repo, &created.id).unwrap();
            assert!(cleared.runs.is_empty());
            assert!(!summary.exists(), "summary file should be gone");
        });
    }

    #[test]
    fn evicting_the_oldest_run_removes_its_summary_file() {
        with_data_dir(|| {
            let dir = tempfile::tempdir().unwrap();
            let repo = dir.path().to_path_buf();
            let created = create(
                &repo,
                "Chatty",
                "ping",
                ScheduleTrigger::Interval { every_minutes: 1 },
                ScheduleMode::Oneshot,
                true,
            )
            .unwrap();
            let summary_for = |id: &str| repo.join(format!(".acorn/schedule-summaries/{id}.md"));
            std::fs::create_dir_all(summary_for("x").parent().unwrap()).unwrap();
            for index in 0..MAX_RUNS_PER_SCHEDULE {
                let id = format!("run-{index}");
                let path = summary_for(&id);
                std::fs::write(&path, "## Result\nok\n").unwrap();
                record_run(
                    &repo,
                    &created.id,
                    ScheduleRunInput {
                        id: Some(id),
                        summary_path: Some(path.to_string_lossy().to_string()),
                        ..Default::default()
                    },
                )
                .unwrap();
            }
            assert!(summary_for("run-0").exists());

            let path = summary_for("run-overflow");
            std::fs::write(&path, "## Result\nok\n").unwrap();
            record_run(
                &repo,
                &created.id,
                ScheduleRunInput {
                    id: Some("run-overflow".to_string()),
                    summary_path: Some(path.to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .unwrap();
            assert!(
                !summary_for("run-0").exists(),
                "the evicted run's summary should be deleted"
            );
            assert!(summary_for("run-overflow").exists());
        });
    }

    #[test]
    fn caps_the_run_history() {
        with_data_dir(|| {
            let repo = PathBuf::from("/tmp/acorn-project-schedules-cap");
            let created = create(
                &repo,
                "Frequent",
                "ping",
                ScheduleTrigger::Interval { every_minutes: 5 },
                ScheduleMode::Oneshot,
                true,
            )
            .unwrap();
            for _ in 0..(MAX_RUNS_PER_SCHEDULE + 10) {
                record_run(&repo, &created.id, ScheduleRunInput::default()).unwrap();
            }
            assert_eq!(list(&repo).unwrap()[0].runs.len(), MAX_RUNS_PER_SCHEDULE);
        });
    }
}
