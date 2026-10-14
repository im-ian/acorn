//! Project-owned tasks. The record lives in Acorn, separate from GitHub
//! issues and from the Claude transcript todo list. The right panel and
//! `acorn-ipc tasks` both read this file.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use chrono::{SecondsFormat, Utc};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::{persistence, project_settings};

const PROJECT_TASKS_FILE: &str = "project_tasks.json";
const MAX_PROJECT_TASKS_FILE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_TASKS_PER_PROJECT: usize = 500;
const MAX_COMMENTS_PER_TASK: usize = 200;
const MAX_STATUS_CHANGES: usize = 100;
const MAX_TITLE_CHARS: usize = 200;
const MAX_DESCRIPTION_CHARS: usize = 20_000;
const MAX_COMMENT_CHARS: usize = 8_000;

static STORE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Todo,
    InProgress,
    InReview,
    Done,
    Canceled,
}

impl TaskStatus {
    pub fn parse(value: &str) -> Result<Self, TaskStoreError> {
        match value {
            "todo" => Ok(Self::Todo),
            "in_progress" => Ok(Self::InProgress),
            "in_review" => Ok(Self::InReview),
            "done" => Ok(Self::Done),
            "canceled" => Ok(Self::Canceled),
            _ => Err(TaskStoreError::Invalid(format!(
                "unknown task status: {value}"
            ))),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Todo => "todo",
            Self::InProgress => "in_progress",
            Self::InReview => "in_review",
            Self::Done => "done",
            Self::Canceled => "canceled",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProjectTaskComment {
    pub id: String,
    pub body: String,
    pub created_at: String,
}

/// One status transition. `at` is when the task entered `to`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TaskStatusChange {
    pub from: TaskStatus,
    pub to: TaskStatus,
    pub at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProjectTask {
    pub id: String,
    pub number: u64,
    pub title: String,
    pub description: String,
    pub status: TaskStatus,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub origin_session_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub comments: Vec<ProjectTaskComment>,
    #[serde(default)]
    pub status_changes: Vec<TaskStatusChange>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskUpdate {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub status: Option<TaskStatus>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub set_session_id: bool,
}

#[derive(Debug)]
pub enum TaskStoreError {
    NotFound,
    Invalid(String),
    Failed(AppError),
}

impl From<AppError> for TaskStoreError {
    fn from(error: AppError) -> Self {
        Self::Failed(error)
    }
}

pub fn task_store_error(error: TaskStoreError) -> AppError {
    match error {
        TaskStoreError::NotFound => AppError::Other("task not found".to_string()),
        TaskStoreError::Invalid(message) => AppError::Other(message),
        TaskStoreError::Failed(error) => error,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct ProjectBucket {
    #[serde(default)]
    next_number: u64,
    #[serde(default)]
    tasks: Vec<ProjectTask>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct TaskFile {
    #[serde(default)]
    projects: BTreeMap<String, ProjectBucket>,
}

pub fn list(repo_path: &Path) -> Result<Vec<ProjectTask>, TaskStoreError> {
    let _guard = STORE_LOCK.lock();
    let key = project_settings::key_for_repo(repo_path)?;
    let file = load()?;
    let mut tasks = file
        .projects
        .get(&key)
        .map(|bucket| bucket.tasks.clone())
        .unwrap_or_default();
    tasks.sort_by(|left, right| right.number.cmp(&left.number));
    Ok(tasks)
}

pub fn create(
    repo_path: &Path,
    title: &str,
    description: &str,
    origin_session_id: Option<String>,
) -> Result<ProjectTask, TaskStoreError> {
    let title = required_text(title, MAX_TITLE_CHARS, "title")?;
    let description = optional_text(description, MAX_DESCRIPTION_CHARS, "description")?;
    let _guard = STORE_LOCK.lock();
    let key = project_settings::key_for_repo(repo_path)?;
    let mut file = load()?;
    let bucket = file.projects.entry(key).or_default();
    if bucket.tasks.len() >= MAX_TASKS_PER_PROJECT {
        return Err(TaskStoreError::Invalid(
            "this project already has the maximum number of tasks".to_string(),
        ));
    }
    let number = bucket.next_number.saturating_add(1).max(1);
    bucket.next_number = number;
    let now = timestamp();
    let task = ProjectTask {
        id: Uuid::new_v4().to_string(),
        number,
        title,
        description,
        status: TaskStatus::Todo,
        session_id: None,
        origin_session_id,
        created_at: now.clone(),
        updated_at: now,
        comments: Vec::new(),
        status_changes: Vec::new(),
    };
    bucket.tasks.push(task.clone());
    save(&file)?;
    Ok(task)
}

pub fn update(
    repo_path: &Path,
    key: &str,
    patch: TaskUpdate,
) -> Result<ProjectTask, TaskStoreError> {
    let title = patch
        .title
        .as_deref()
        .map(|title| required_text(title, MAX_TITLE_CHARS, "title"))
        .transpose()?;
    let description = patch
        .description
        .as_deref()
        .map(|description| optional_text(description, MAX_DESCRIPTION_CHARS, "description"))
        .transpose()?;
    let _guard = STORE_LOCK.lock();
    let project_key = project_settings::key_for_repo(repo_path)?;
    let mut file = load()?;
    let bucket = file
        .projects
        .get_mut(&project_key)
        .ok_or(TaskStoreError::NotFound)?;
    let index = resolve_index(bucket, key)?;
    let current_status = bucket.tasks[index].status;
    let next_status = patch.status.filter(|status| *status != current_status);
    let unchanged =
        title.is_none() && description.is_none() && next_status.is_none() && !patch.set_session_id;
    if unchanged {
        return Ok(bucket.tasks[index].clone());
    }
    let now = timestamp();
    let task = &mut bucket.tasks[index];
    if let Some(title) = title {
        task.title = title;
    }
    if let Some(description) = description {
        task.description = description;
    }
    if let Some(status) = next_status {
        if task.status_changes.len() >= MAX_STATUS_CHANGES {
            task.status_changes.remove(0);
        }
        task.status_changes.push(TaskStatusChange {
            from: task.status,
            to: status,
            at: now.clone(),
        });
        task.status = status;
    }
    if patch.set_session_id {
        task.session_id = patch.session_id;
    }
    task.updated_at = now;
    let updated = task.clone();
    save(&file)?;
    Ok(updated)
}

pub fn add_comment(repo_path: &Path, key: &str, body: &str) -> Result<ProjectTask, TaskStoreError> {
    let body = required_text(body, MAX_COMMENT_CHARS, "comment")?;
    let _guard = STORE_LOCK.lock();
    let project_key = project_settings::key_for_repo(repo_path)?;
    let mut file = load()?;
    let bucket = file
        .projects
        .get_mut(&project_key)
        .ok_or(TaskStoreError::NotFound)?;
    let index = resolve_index(bucket, key)?;
    let task = &mut bucket.tasks[index];
    if task.comments.len() >= MAX_COMMENTS_PER_TASK {
        return Err(TaskStoreError::Invalid(
            "this task already has the maximum number of comments".to_string(),
        ));
    }
    task.comments.push(ProjectTaskComment {
        id: Uuid::new_v4().to_string(),
        body,
        created_at: timestamp(),
    });
    task.updated_at = timestamp();
    let updated = task.clone();
    save(&file)?;
    Ok(updated)
}

pub fn delete_comment(
    repo_path: &Path,
    key: &str,
    comment_id: &str,
) -> Result<ProjectTask, TaskStoreError> {
    let comment_id = comment_id.trim();
    if comment_id.is_empty() {
        return Err(TaskStoreError::Invalid("comment id is empty".to_string()));
    }
    let _guard = STORE_LOCK.lock();
    let project_key = project_settings::key_for_repo(repo_path)?;
    let mut file = load()?;
    let bucket = file
        .projects
        .get_mut(&project_key)
        .ok_or(TaskStoreError::NotFound)?;
    let index = resolve_index(bucket, key)?;
    let task = &mut bucket.tasks[index];
    let before = task.comments.len();
    task.comments.retain(|comment| comment.id != comment_id);
    if task.comments.len() == before {
        return Err(TaskStoreError::NotFound);
    }
    task.updated_at = timestamp();
    let updated = task.clone();
    save(&file)?;
    Ok(updated)
}

pub fn delete(repo_path: &Path, key: &str) -> Result<(), TaskStoreError> {
    let _guard = STORE_LOCK.lock();
    let project_key = project_settings::key_for_repo(repo_path)?;
    let mut file = load()?;
    let bucket = file
        .projects
        .get_mut(&project_key)
        .ok_or(TaskStoreError::NotFound)?;
    let index = resolve_index(bucket, key)?;
    bucket.tasks.remove(index);
    save(&file)?;
    Ok(())
}

pub fn get(repo_path: &Path, key: &str) -> Result<ProjectTask, TaskStoreError> {
    let _guard = STORE_LOCK.lock();
    let project_key = project_settings::key_for_repo(repo_path)?;
    let file = load()?;
    let bucket = file
        .projects
        .get(&project_key)
        .ok_or(TaskStoreError::NotFound)?;
    let index = resolve_index(bucket, key)?;
    Ok(bucket.tasks[index].clone())
}

fn resolve_index(bucket: &ProjectBucket, key: &str) -> Result<usize, TaskStoreError> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return Err(TaskStoreError::Invalid("task id is required".to_string()));
    }
    let number_key = trimmed.trim_start_matches('#');
    if let Ok(number) = number_key.parse::<u64>() {
        if let Some(index) = bucket.tasks.iter().position(|task| task.number == number) {
            return Ok(index);
        }
    }
    bucket
        .tasks
        .iter()
        .position(|task| task.id == trimmed)
        .ok_or(TaskStoreError::NotFound)
}

fn required_text(value: &str, max_chars: usize, label: &str) -> Result<String, TaskStoreError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(TaskStoreError::Invalid(format!("{label} is required")));
    }
    bounded_text(trimmed, max_chars, label)
}

fn optional_text(value: &str, max_chars: usize, label: &str) -> Result<String, TaskStoreError> {
    bounded_text(value.trim(), max_chars, label)
}

fn bounded_text(value: &str, max_chars: usize, label: &str) -> Result<String, TaskStoreError> {
    if value.chars().count() > max_chars {
        return Err(TaskStoreError::Invalid(format!("{label} is too long")));
    }
    Ok(value.to_string())
}

fn timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn tasks_path() -> AppResult<PathBuf> {
    Ok(persistence::data_dir()?.join(PROJECT_TASKS_FILE))
}

fn load() -> Result<TaskFile, TaskStoreError> {
    let path = tasks_path()?;
    let bytes = match persistence::read_bounded_regular_file(&path, MAX_PROJECT_TASKS_FILE_BYTES) {
        Ok(bytes) => bytes,
        Err(AppError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(TaskFile::default());
        }
        Err(error) => return Err(error.into()),
    };
    serde_json::from_slice(&bytes).map_err(|error| {
        TaskStoreError::Failed(AppError::Other(format!(
            "failed to parse project tasks: {error}"
        )))
    })
}

fn save(file: &TaskFile) -> Result<(), TaskStoreError> {
    let path = tasks_path()?;
    let payload = serde_json::to_vec_pretty(file).map_err(|error| {
        TaskStoreError::Failed(AppError::Other(format!(
            "failed to serialize project tasks: {error}"
        )))
    })?;
    persistence::ensure_payload_within_limit(
        &payload,
        MAX_PROJECT_TASKS_FILE_BYTES,
        "project tasks",
    )?;
    acorn_platform::fs::write_atomic_private(&path, &payload)
        .map_err(|error| TaskStoreError::Failed(AppError::Io(error)))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_data_dir(test: impl FnOnce(&Path)) {
        let dir = tempfile::tempdir().unwrap();
        persistence::with_test_data_dir(dir.path(), || test(dir.path()));
    }

    #[test]
    fn create_update_comment_and_delete_round_trip() {
        with_data_dir(|_| {
            let repo = PathBuf::from("/tmp/acorn-project-tasks");
            let created = create(
                &repo,
                "  Fix the panel  ",
                "body",
                Some("origin".to_string()),
            )
            .unwrap();
            assert_eq!(created.number, 1);
            assert_eq!(created.title, "Fix the panel");
            assert_eq!(created.status, TaskStatus::Todo);
            assert_eq!(created.origin_session_id.as_deref(), Some("origin"));

            let second = create(&repo, "Next", "", None).unwrap();
            assert_eq!(second.number, 2);
            let listed = list(&repo).unwrap();
            assert_eq!(listed[0].number, 2);

            let updated = update(
                &repo,
                "1",
                TaskUpdate {
                    status: Some(TaskStatus::InReview),
                    set_session_id: true,
                    session_id: Some("session-1".to_string()),
                    ..TaskUpdate::default()
                },
            )
            .unwrap();
            assert_eq!(updated.status, TaskStatus::InReview);
            assert_eq!(updated.session_id.as_deref(), Some("session-1"));

            let commented = add_comment(&repo, &created.id, " ready for review ").unwrap();
            assert_eq!(commented.comments.len(), 1);
            assert_eq!(commented.comments[0].body, "ready for review");
            assert_eq!(get(&repo, "#1").unwrap().comments.len(), 1);
            let comment_id = commented.comments[0].id.clone();
            let cleared = delete_comment(&repo, "#1", &comment_id).unwrap();
            assert!(cleared.comments.is_empty());
            assert!(matches!(
                delete_comment(&repo, "#1", &comment_id),
                Err(TaskStoreError::NotFound)
            ));

            delete(&repo, "#2").unwrap();
            assert_eq!(list(&repo).unwrap().len(), 1);
        });
    }

    #[test]
    fn task_update_reads_camel_case_command_fields() {
        let patch: TaskUpdate = serde_json::from_str(
            r#"{"status":"in_progress","sessionId":"abc","setSessionId":true}"#,
        )
        .unwrap();
        assert_eq!(patch.status, Some(TaskStatus::InProgress));
        assert_eq!(patch.session_id.as_deref(), Some("abc"));
        assert!(patch.set_session_id);

        let cleared: TaskUpdate =
            serde_json::from_str(r#"{"sessionId":null,"setSessionId":true}"#).unwrap();
        assert_eq!(cleared.session_id, None);
        assert!(cleared.set_session_id);
    }

    #[test]
    fn empty_update_keeps_the_stored_task() {
        with_data_dir(|dir| {
            let repo = PathBuf::from("/tmp/acorn-project-tasks-noop");
            let created = create(&repo, "Keep the time", "", None).unwrap();
            let path = dir.join("project_tasks.json");
            let before = std::fs::read(&path).unwrap();
            let updated = update(&repo, "1", TaskUpdate::default()).unwrap();
            assert_eq!(updated.updated_at, created.updated_at);
            assert_eq!(std::fs::read(&path).unwrap(), before);
        });
    }

    #[test]
    #[test]
    fn status_change_is_recorded_and_a_repeat_is_a_noop() {
        with_data_dir(|dir| {
            let repo = PathBuf::from("/tmp/acorn-project-tasks-history");
            let created = create(&repo, "Track status", "", None).unwrap();
            assert!(created.status_changes.is_empty());
            let started = update(
                &repo,
                "1",
                TaskUpdate {
                    status: Some(TaskStatus::InProgress),
                    ..TaskUpdate::default()
                },
            )
            .unwrap();
            assert_eq!(started.status, TaskStatus::InProgress);
            assert_eq!(started.status_changes.len(), 1);
            assert_eq!(started.status_changes[0].from, TaskStatus::Todo);
            assert_eq!(started.status_changes[0].to, TaskStatus::InProgress);
            assert_eq!(started.status_changes[0].at, started.updated_at);

            let path = dir.join("project_tasks.json");
            let before = std::fs::read(&path).unwrap();
            let again = update(
                &repo,
                "1",
                TaskUpdate {
                    status: Some(TaskStatus::InProgress),
                    ..TaskUpdate::default()
                },
            )
            .unwrap();
            assert_eq!(again.status_changes.len(), 1);
            assert_eq!(std::fs::read(&path).unwrap(), before);
        });
    }

    #[test]
    fn tasks_without_status_history_still_load() {
        let task: ProjectTask = serde_json::from_str(
            r#"{"id":"a","number":1,"title":"t","description":"","status":"todo","created_at":"t","updated_at":"t"}"#,
        )
        .unwrap();
        assert!(task.status_changes.is_empty());
        assert!(task.comments.is_empty());
    }

    #[test]
    fn rejects_an_empty_title_and_unknown_task() {
        with_data_dir(|_| {
            let repo = PathBuf::from("/tmp/acorn-project-tasks-invalid");
            assert!(matches!(
                create(&repo, "   ", "", None),
                Err(TaskStoreError::Invalid(_))
            ));
            assert!(matches!(get(&repo, "1"), Err(TaskStoreError::NotFound)));
            assert!(matches!(
                TaskStatus::parse("later"),
                Err(TaskStoreError::Invalid(_))
            ));
        });
    }
}
