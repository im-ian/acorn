use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::{git_ops, persistence};

const PROJECT_SETTINGS_FILE: &str = "project_settings.json";
const PROJECT_SETTINGS_TMP_FILE: &str = "project_settings.json.tmp";
pub const PR_GENERATION_PROMPT_MAX_CHARS: usize = 2_000;
pub const STANDARD_PR_GENERATION_PROMPT: &str = "Use a standard GitHub-style pull request merge message.
- First line: Conventional Commit subject when the type is clear, e.g. feat(scope): concise summary. Keep it imperative/present tense and <=72 chars.
- Body: 1-2 concise paragraphs explaining why the change matters, user-visible impact, and key implementation notes when useful.
- Keep the wording specific to the PR. Avoid boilerplate, markdown headings, labels, and prompt explanations.";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProjectSettings {
    #[serde(default = "default_true")]
    pub remember_after_close: bool,
    #[serde(default)]
    pub pull_requests: ProjectPullRequestSettings,
}

impl Default for ProjectSettings {
    fn default() -> Self {
        Self {
            remember_after_close: true,
            pull_requests: ProjectPullRequestSettings::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProjectPullRequestSettings {
    #[serde(default)]
    pub generation_prompt: Option<String>,
}

impl Default for ProjectPullRequestSettings {
    fn default() -> Self {
        Self {
            generation_prompt: Some(STANDARD_PR_GENERATION_PROMPT.to_string()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProjectSettingsRecord {
    pub key: String,
    pub settings: ProjectSettings,
}

type SettingsMap = BTreeMap<String, ProjectSettings>;

fn default_true() -> bool {
    true
}

fn settings_path() -> AppResult<PathBuf> {
    Ok(persistence::data_dir()?.join(PROJECT_SETTINGS_FILE))
}

fn settings_tmp_path() -> AppResult<PathBuf> {
    Ok(persistence::data_dir()?.join(PROJECT_SETTINGS_TMP_FILE))
}

fn load_all() -> AppResult<SettingsMap> {
    let path = settings_path()?;
    if !path.exists() {
        return Ok(SettingsMap::new());
    }
    let bytes = fs::read(&path)?;
    serde_json::from_slice::<SettingsMap>(&bytes)
        .map_err(|err| AppError::Other(format!("failed to parse project settings: {err}")))
}

fn save_all(settings: &SettingsMap) -> AppResult<()> {
    let final_path = settings_path()?;
    let tmp_path = settings_tmp_path()?;
    let payload = serde_json::to_vec_pretty(settings)
        .map_err(|err| AppError::Other(format!("failed to serialize project settings: {err}")))?;
    fs::write(&tmp_path, payload)?;
    fs::rename(&tmp_path, &final_path)?;
    Ok(())
}

pub fn key_for_repo(repo_path: &Path) -> String {
    if let Ok(Some(slug)) = git_ops::github_owner_repo(repo_path) {
        return format!("github:{}", slug.to_ascii_lowercase());
    }
    let path = repo_path
        .canonicalize()
        .unwrap_or_else(|_| repo_path.to_path_buf());
    format!("path:{}", path.display())
}

pub fn get(repo_path: &Path) -> AppResult<ProjectSettingsRecord> {
    let key = key_for_repo(repo_path);
    let settings = load_all()?.get(&key).cloned().unwrap_or_default();
    Ok(ProjectSettingsRecord { key, settings })
}

pub fn update(repo_path: &Path, settings: ProjectSettings) -> AppResult<ProjectSettingsRecord> {
    let key = key_for_repo(repo_path);
    let settings = normalize_settings(settings);
    let mut all = load_all()?;
    all.insert(key.clone(), settings.clone());
    save_all(&all)?;
    Ok(ProjectSettingsRecord { key, settings })
}

pub fn remove(repo_path: &Path) -> AppResult<()> {
    let key = key_for_repo(repo_path);
    let mut all = load_all()?;
    if all.remove(&key).is_some() {
        save_all(&all)?;
    }
    Ok(())
}

pub fn should_remove_on_project_close(repo_path: &Path) -> AppResult<bool> {
    let record = get(repo_path)?;
    Ok(!record.settings.remember_after_close)
}

fn normalize_settings(mut settings: ProjectSettings) -> ProjectSettings {
    settings.pull_requests.generation_prompt =
        settings.pull_requests.generation_prompt.and_then(|prompt| {
            let trimmed = prompt.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(
                    prompt
                        .chars()
                        .take(PR_GENERATION_PROMPT_MAX_CHARS)
                        .collect(),
                )
            }
        });
    settings
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn with_data_dir(test: impl FnOnce(&Path)) {
        let _guard = ENV_LOCK.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        unsafe {
            std::env::set_var(acorn_paths::ENV_DATA_DIR_OVERRIDE, dir.path());
        }
        test(dir.path());
        unsafe {
            std::env::remove_var(acorn_paths::ENV_DATA_DIR_OVERRIDE);
        }
    }

    #[test]
    fn update_and_get_round_trips_project_settings() {
        with_data_dir(|_| {
            let repo = PathBuf::from("/tmp/acorn-settings-repo");
            let settings = ProjectSettings {
                remember_after_close: false,
                pull_requests: ProjectPullRequestSettings {
                    generation_prompt: Some("Write concise Korean PR messages.".to_string()),
                },
            };

            let saved = update(&repo, settings).unwrap();
            let loaded = get(&repo).unwrap();

            assert_eq!(loaded.key, saved.key);
            assert_eq!(loaded.settings.remember_after_close, false);
            assert_eq!(
                loaded.settings.pull_requests.generation_prompt.as_deref(),
                Some("Write concise Korean PR messages.")
            );
        });
    }

    #[test]
    fn default_settings_include_standard_pr_generation_prompt() {
        with_data_dir(|_| {
            let repo = PathBuf::from("/tmp/acorn-settings-repo");
            let loaded = get(&repo).unwrap();

            assert!(loaded
                .settings
                .pull_requests
                .generation_prompt
                .as_deref()
                .unwrap_or("")
                .contains("GitHub-style pull request"));
        });
    }

    #[test]
    fn blank_prompt_normalizes_to_none() {
        with_data_dir(|_| {
            let repo = PathBuf::from("/tmp/acorn-settings-repo");

            update(
                &repo,
                ProjectSettings {
                    remember_after_close: true,
                    pull_requests: ProjectPullRequestSettings {
                        generation_prompt: Some("   ".to_string()),
                    },
                },
            )
            .unwrap();

            assert_eq!(
                get(&repo).unwrap().settings.pull_requests.generation_prompt,
                None
            );
        });
    }

    #[test]
    fn remember_after_close_controls_close_cleanup() {
        with_data_dir(|_| {
            let repo = PathBuf::from("/tmp/acorn-settings-repo");

            assert_eq!(should_remove_on_project_close(&repo).unwrap(), false);

            update(
                &repo,
                ProjectSettings {
                    remember_after_close: false,
                    pull_requests: ProjectPullRequestSettings::default(),
                },
            )
            .unwrap();

            assert_eq!(should_remove_on_project_close(&repo).unwrap(), true);
        });
    }
}
