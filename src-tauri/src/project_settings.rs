use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::{git_ops, persistence};

const PROJECT_SETTINGS_FILE: &str = "project_settings.json";
const MAX_PROJECT_SETTINGS_FILE_BYTES: u64 = 4 * 1024 * 1024;
pub const PR_GENERATION_PROMPT_MAX_CHARS: usize = 2_000;
pub const WORKTREE_BASE_BRANCH_MAX_CHARS: usize = 255;
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
    #[serde(default)]
    pub worktrees: ProjectWorktreeSettings,
}

impl Default for ProjectSettings {
    fn default() -> Self {
        Self {
            remember_after_close: true,
            pull_requests: ProjectPullRequestSettings::default(),
            worktrees: ProjectWorktreeSettings::default(),
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

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProjectWorktreeSettings {
    #[serde(default)]
    pub base_branch: Option<String>,
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

fn load_all() -> AppResult<SettingsMap> {
    let path = settings_path()?;
    let bytes = match persistence::read_bounded_regular_file(&path, MAX_PROJECT_SETTINGS_FILE_BYTES)
    {
        Ok(bytes) => bytes,
        Err(AppError::Io(err)) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(SettingsMap::new());
        }
        Err(err) => return Err(err),
    };
    serde_json::from_slice::<SettingsMap>(&bytes)
        .map_err(|err| AppError::Other(format!("failed to parse project settings: {err}")))
}

fn save_all(settings: &SettingsMap) -> AppResult<()> {
    let final_path = settings_path()?;
    let payload = serde_json::to_vec_pretty(settings)
        .map_err(|err| AppError::Other(format!("failed to serialize project settings: {err}")))?;
    persistence::ensure_payload_within_limit(
        &payload,
        MAX_PROJECT_SETTINGS_FILE_BYTES,
        "project settings",
    )?;
    acorn_platform::fs::write_atomic(&final_path, &payload)?;
    Ok(())
}

pub fn key_for_repo(repo_path: &Path) -> AppResult<String> {
    if git_ops::is_git_repository(repo_path)? {
        if let Some(slug) = git_ops::github_owner_repo(repo_path)? {
            return Ok(format!("github:{}", slug.to_ascii_lowercase()));
        }
    }
    let path = match repo_path.canonicalize() {
        Ok(path) => path,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => repo_path.to_path_buf(),
        Err(err) => {
            return Err(AppError::Io(std::io::Error::new(
                err.kind(),
                format!(
                    "failed to resolve project settings key for {}: {err}",
                    repo_path.display()
                ),
            )));
        }
    };
    Ok(format!("path:{}", path.display()))
}

pub fn get(repo_path: &Path) -> AppResult<ProjectSettingsRecord> {
    let key = key_for_repo(repo_path)?;
    let settings = load_all()?.get(&key).cloned().unwrap_or_default();
    Ok(ProjectSettingsRecord { key, settings })
}

pub fn update(repo_path: &Path, settings: ProjectSettings) -> AppResult<ProjectSettingsRecord> {
    let key = key_for_repo(repo_path)?;
    let settings = normalize_settings(settings);
    let mut all = load_all()?;
    all.insert(key.clone(), settings.clone());
    save_all(&all)?;
    Ok(ProjectSettingsRecord { key, settings })
}

pub fn remove(repo_path: &Path) -> AppResult<()> {
    let key = key_for_repo(repo_path)?;
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
    settings.worktrees.base_branch = settings.worktrees.base_branch.and_then(|branch| {
        let trimmed = branch.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(
                trimmed
                    .chars()
                    .take(WORKTREE_BASE_BRANCH_MAX_CHARS)
                    .collect(),
            )
        }
    });
    settings
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_data_dir(test: impl FnOnce(&Path)) {
        let dir = tempfile::tempdir().unwrap();
        persistence::with_test_data_dir(dir.path(), || test(dir.path()));
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
                worktrees: ProjectWorktreeSettings {
                    base_branch: Some("develop".to_string()),
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
            assert_eq!(
                loaded.settings.worktrees.base_branch.as_deref(),
                Some("develop")
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
    fn github_repo_key_uses_normalized_origin_slug() {
        let dir = tempfile::tempdir().unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();
        repo.remote("origin", "https://github.com/Acme/Widgets.git")
            .unwrap();

        assert_eq!(key_for_repo(dir.path()).unwrap(), "github:acme/widgets");
    }

    #[test]
    fn project_key_does_not_fall_back_after_remote_url_error() {
        let dir = tempfile::tempdir().unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();
        let config_path = repo.path().join("config");
        drop(repo);
        let mut config = fs::read(&config_path).unwrap();
        config.extend_from_slice(b"\n[remote \"origin\"]\n\turl = git@github.com:acme/");
        config.push(0xff);
        config.extend_from_slice(b".git\n");
        fs::write(config_path, config).unwrap();

        assert!(matches!(key_for_repo(dir.path()), Err(AppError::Git(_))));
    }

    #[test]
    fn settings_without_worktree_fields_use_automatic_base_branch() {
        let settings: ProjectSettings = serde_json::from_value(serde_json::json!({
            "remember_after_close": true,
            "pull_requests": { "generation_prompt": null }
        }))
        .unwrap();

        assert_eq!(settings.worktrees, ProjectWorktreeSettings::default());
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
                    worktrees: ProjectWorktreeSettings {
                        base_branch: Some("   ".to_string()),
                    },
                },
            )
            .unwrap();

            assert_eq!(
                get(&repo).unwrap().settings.pull_requests.generation_prompt,
                None
            );
            assert_eq!(get(&repo).unwrap().settings.worktrees.base_branch, None);
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
                    worktrees: ProjectWorktreeSettings::default(),
                },
            )
            .unwrap();

            assert_eq!(should_remove_on_project_close(&repo).unwrap(), true);
        });
    }
}
