//! Linear / Jira credentials.
//!
//! API tokens live in the OS keychain on macOS/Windows (owner-only files in
//! the data dir everywhere else, and always in unit tests so `cargo test`
//! cannot write the login keychain). Email, site, and display names are not
//! secrets and sit in `tracker_accounts.json`. Tokens never go in that file
//! and are never returned to the renderer.

use std::fs;
use std::io::Read;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::persistence;
use crate::tracker::{JiraAccount, LinearAccount, TrackerAccounts};

const ACCOUNTS_FILE: &str = "tracker_accounts.json";
const MAX_ACCOUNTS_FILE_BYTES: u64 = 16 * 1024;
const LINEAR_SECRET: &str = "linear-api-key";
const JIRA_SECRET: &str = "jira-api-token";
const KEYRING_SERVICE: &str = "io.im-ian.acorn";

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
struct StoredAccounts {
    #[serde(default)]
    linear: StoredLinear,
    #[serde(default)]
    jira: StoredJira,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
struct StoredLinear {
    viewer: Option<String>,
    workspace: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
struct StoredJira {
    email: Option<String>,
    site: Option<String>,
    cloud_id: Option<String>,
    display_name: Option<String>,
}

fn accounts_path() -> AppResult<PathBuf> {
    Ok(persistence::data_dir()?.join(ACCOUNTS_FILE))
}

fn load_accounts() -> AppResult<StoredAccounts> {
    let path = accounts_path()?;
    let bytes = match persistence::read_bounded_regular_file(&path, MAX_ACCOUNTS_FILE_BYTES) {
        Ok(bytes) => bytes,
        Err(AppError::Io(err)) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(StoredAccounts::default());
        }
        Err(err) => return Err(err),
    };
    serde_json::from_slice::<StoredAccounts>(&bytes)
        .map_err(|err| AppError::Other(format!("failed to parse tracker accounts: {err}")))
}

fn save_accounts(accounts: &StoredAccounts) -> AppResult<()> {
    let payload = serde_json::to_vec_pretty(accounts)
        .map_err(|err| AppError::Other(format!("failed to serialize tracker accounts: {err}")))?;
    persistence::ensure_payload_within_limit(
        &payload,
        MAX_ACCOUNTS_FILE_BYTES,
        "tracker accounts",
    )?;
    acorn_platform::fs::write_atomic(&accounts_path()?, &payload)?;
    Ok(())
}

fn secret_file_path(name: &str) -> AppResult<PathBuf> {
    Ok(persistence::data_dir()?.join("secrets").join(name))
}

fn use_file_secrets() -> bool {
    cfg!(test) || !(cfg!(target_os = "macos") || cfg!(windows))
}

fn set_secret(name: &str, value: &str) -> AppResult<()> {
    if use_file_secrets() {
        let path = secret_file_path(name)?;
        acorn_platform::fs::write_atomic_private(&path, value.as_bytes())
            .map_err(|err| AppError::Other(format!("failed to store {name}: {err}")))?;
        return Ok(());
    }
    set_keyring_secret(name, value)
}

fn get_secret(name: &str) -> AppResult<Option<String>> {
    if use_file_secrets() {
        let path = secret_file_path(name)?;
        let (file, metadata) = match acorn_platform::fs::open_regular_nofollow(&path) {
            Ok(opened) => opened,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(err) => {
                return Err(AppError::Other(format!("failed to read {name}: {err}")));
            }
        };
        if metadata.len() == 0 || metadata.len() > 4096 {
            return Err(AppError::Other(format!("{name} has an invalid size")));
        }
        let mut bytes = Vec::new();
        file.take(4097).read_to_end(&mut bytes)?;
        if bytes.len() > 4096 {
            return Err(AppError::Other(format!("{name} exceeds its byte limit")));
        }
        let value = String::from_utf8(bytes)
            .map_err(|_| AppError::Other(format!("{name} is not valid UTF-8")))?;
        let trimmed = value.trim();
        if trimmed.is_empty() {
            Ok(None)
        } else {
            Ok(Some(trimmed.to_string()))
        }
    } else {
        get_keyring_secret(name)
    }
}

fn delete_secret(name: &str) -> AppResult<()> {
    if use_file_secrets() {
        let path = secret_file_path(name)?;
        match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(AppError::Other(format!("failed to delete {name}: {err}"))),
        }
    } else {
        delete_keyring_secret(name)
    }
}

#[cfg(any(target_os = "macos", windows))]
fn set_keyring_secret(name: &str, value: &str) -> AppResult<()> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, name)
        .map_err(|err| AppError::Other(format!("failed to open keychain entry: {err}")))?;
    entry
        .set_password(value)
        .map_err(|err| AppError::Other(format!("failed to store {name} in keychain: {err}")))
}

#[cfg(not(any(target_os = "macos", windows)))]
fn set_keyring_secret(name: &str, value: &str) -> AppResult<()> {
    let path = secret_file_path(name)?;
    acorn_platform::fs::write_atomic_private(&path, value.as_bytes())
        .map_err(|err| AppError::Other(format!("failed to store {name}: {err}")))
}

#[cfg(any(target_os = "macos", windows))]
fn get_keyring_secret(name: &str) -> AppResult<Option<String>> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, name)
        .map_err(|err| AppError::Other(format!("failed to open keychain entry: {err}")))?;
    match entry.get_password() {
        Ok(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                Ok(None)
            } else {
                Ok(Some(trimmed.to_string()))
            }
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(AppError::Other(format!(
            "failed to read {name} from keychain: {err}"
        ))),
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
fn get_keyring_secret(name: &str) -> AppResult<Option<String>> {
    get_secret(name)
}

#[cfg(any(target_os = "macos", windows))]
fn delete_keyring_secret(name: &str) -> AppResult<()> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, name)
        .map_err(|err| AppError::Other(format!("failed to open keychain entry: {err}")))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(AppError::Other(format!(
            "failed to delete {name} from keychain: {err}"
        ))),
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
fn delete_keyring_secret(name: &str) -> AppResult<()> {
    delete_secret(name)
}

pub fn linear_api_key() -> AppResult<Option<String>> {
    get_secret(LINEAR_SECRET)
}

pub fn set_linear_api_key(
    key: &str,
    viewer: Option<String>,
    workspace: Option<String>,
) -> AppResult<()> {
    set_secret(LINEAR_SECRET, key)?;
    let mut accounts = load_accounts()?;
    accounts.linear = StoredLinear { viewer, workspace };
    save_accounts(&accounts)
}

pub fn clear_linear() -> AppResult<()> {
    delete_secret(LINEAR_SECRET)?;
    let mut accounts = load_accounts()?;
    accounts.linear = StoredLinear::default();
    save_accounts(&accounts)
}

pub fn jira_api_token() -> AppResult<Option<String>> {
    get_secret(JIRA_SECRET)
}

pub fn set_jira_credentials(
    email: &str,
    site: &str,
    token: &str,
    cloud_id: Option<String>,
    display_name: Option<String>,
) -> AppResult<()> {
    set_secret(JIRA_SECRET, token)?;
    let mut accounts = load_accounts()?;
    accounts.jira = StoredJira {
        email: Some(email.to_string()),
        site: Some(site.to_string()),
        cloud_id,
        display_name,
    };
    save_accounts(&accounts)
}

pub fn clear_jira() -> AppResult<()> {
    delete_secret(JIRA_SECRET)?;
    let mut accounts = load_accounts()?;
    accounts.jira = StoredJira::default();
    save_accounts(&accounts)
}

pub fn jira_site_meta() -> AppResult<StoredJiraPublic> {
    let stored = load_accounts()?.jira;
    Ok(StoredJiraPublic {
        email: stored.email,
        site: stored.site,
        cloud_id: stored.cloud_id,
        display_name: stored.display_name,
    })
}

#[derive(Debug, Clone, Default)]
pub struct StoredJiraPublic {
    pub email: Option<String>,
    pub site: Option<String>,
    pub cloud_id: Option<String>,
    pub display_name: Option<String>,
}

pub fn accounts() -> AppResult<TrackerAccounts> {
    let stored = load_accounts()?;
    let linear_connected = linear_api_key()?.is_some();
    let jira_connected = jira_api_token()?.is_some()
        && stored.jira.email.as_deref().is_some_and(|s| !s.is_empty())
        && stored.jira.site.as_deref().is_some_and(|s| !s.is_empty());
    Ok(TrackerAccounts {
        linear: LinearAccount {
            connected: linear_connected,
            viewer: stored.linear.viewer.filter(|_| linear_connected),
            workspace: stored.linear.workspace.filter(|_| linear_connected),
        },
        jira: JiraAccount {
            connected: jira_connected,
            email: stored.jira.email.filter(|_| jira_connected),
            site: stored.jira.site.filter(|_| jira_connected),
            display_name: stored.jira.display_name.filter(|_| jira_connected),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn with_data_dir(test: impl FnOnce(&Path)) {
        let dir = tempfile::tempdir().unwrap();
        persistence::with_test_data_dir(dir.path(), || test(dir.path()));
    }

    #[test]
    fn accounts_file_does_not_store_tokens() {
        with_data_dir(|dir| {
            set_linear_api_key(
                "lin_api_secret-value",
                Some("Ian".into()),
                Some("JTF".into()),
            )
            .unwrap();
            set_jira_credentials(
                "ian@example.com",
                "acme.atlassian.net",
                "jira-secret-token",
                Some("cloud".into()),
                Some("Ian".into()),
            )
            .unwrap();

            let accounts = fs::read_to_string(dir.join(ACCOUNTS_FILE)).unwrap();
            assert!(!accounts.contains("lin_api_secret-value"));
            assert!(!accounts.contains("jira-secret-token"));
            assert!(accounts.contains("ian@example.com"));

            let status = super::accounts().unwrap();
            assert!(status.linear.connected);
            assert_eq!(status.linear.viewer.as_deref(), Some("Ian"));
            assert!(status.jira.connected);
            assert_eq!(
                linear_api_key().unwrap().as_deref(),
                Some("lin_api_secret-value")
            );
            assert_eq!(
                jira_api_token().unwrap().as_deref(),
                Some("jira-secret-token")
            );
        });
    }

    #[test]
    fn clear_drops_secret_and_metadata() {
        with_data_dir(|_| {
            set_linear_api_key("lin_api_secret-value", Some("Ian".into()), None).unwrap();
            clear_linear().unwrap();
            assert!(linear_api_key().unwrap().is_none());
            assert!(!super::accounts().unwrap().linear.connected);
        });
    }
}
