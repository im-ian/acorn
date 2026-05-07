//! GitHub pull request listing via the `gh` CLI.
//!
//! We shell out to `gh pr list --json ...` rather than calling GitHub's REST
//! API directly so that the user's existing `gh` auth (keychain, OAuth
//! device flow, enterprise hosts) is reused with zero in-app token storage.
//! When `gh` is missing or unauthenticated we surface a typed error so the
//! frontend can show actionable guidance.

use std::path::Path;
use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::git_ops::github_owner_repo;

/// PR state filter accepted from the frontend. Mirrors the values gh
/// understands so we can pass it straight through.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PrStateFilter {
    Open,
    Closed,
    Merged,
    All,
}

impl PrStateFilter {
    fn as_gh_arg(self) -> &'static str {
        match self {
            PrStateFilter::Open => "open",
            PrStateFilter::Closed => "closed",
            PrStateFilter::Merged => "merged",
            PrStateFilter::All => "all",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct PullRequestInfo {
    pub number: u64,
    pub title: String,
    /// Lifecycle state from gh: "OPEN" / "CLOSED" / "MERGED".
    pub state: String,
    pub author: String,
    pub head_branch: String,
    pub base_branch: String,
    pub url: String,
    /// ISO-8601 timestamp from gh; the frontend formats it for display.
    pub updated_at: String,
    pub is_draft: bool,
}

/// Raw shape of a single PR entry returned by `gh pr list --json ...`.
/// Field names match gh's JSON output, which uses camelCase.
#[derive(Debug, Deserialize)]
struct GhPullRequest {
    number: u64,
    title: String,
    state: String,
    #[serde(default)]
    author: GhAuthor,
    #[serde(rename = "headRefName")]
    head_ref_name: String,
    #[serde(rename = "baseRefName")]
    base_ref_name: String,
    url: String,
    #[serde(rename = "updatedAt")]
    updated_at: String,
    #[serde(rename = "isDraft", default)]
    is_draft: bool,
}

#[derive(Debug, Default, Deserialize)]
struct GhAuthor {
    #[serde(default)]
    login: Option<String>,
}

/// Outcome of the listing call. `NotGithub` lets the frontend show an
/// "origin is not a GitHub remote" empty state without surfacing an error
/// banner; everything else flows through `AppError`.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PullRequestListing {
    Ok { items: Vec<PullRequestInfo> },
    NotGithub,
}

pub fn list_pull_requests(
    repo_path: &Path,
    state: PrStateFilter,
    limit: u32,
) -> AppResult<PullRequestListing> {
    let Some(slug) = github_owner_repo(repo_path)? else {
        return Ok(PullRequestListing::NotGithub);
    };

    let limit = limit.clamp(1, 200);
    let output = Command::new("gh")
        .args([
            "pr",
            "list",
            "--repo",
            &slug,
            "--state",
            state.as_gh_arg(),
            "--limit",
            &limit.to_string(),
            "--json",
            "number,title,state,author,headRefName,baseRefName,url,updatedAt,isDraft",
        ])
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                AppError::Other(
                    "`gh` CLI not found. Install it from https://cli.github.com and run `gh auth login`.".to_string(),
                )
            } else {
                AppError::Other(format!("failed to invoke gh: {e}"))
            }
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let msg = if stderr.is_empty() {
            format!("gh exited with status {}", output.status)
        } else {
            stderr
        };
        return Err(AppError::Other(msg));
    }

    let raw: Vec<GhPullRequest> = serde_json::from_slice(&output.stdout)
        .map_err(|e| AppError::Other(format!("failed to parse gh output: {e}")))?;

    let items = raw
        .into_iter()
        .map(|pr| PullRequestInfo {
            number: pr.number,
            title: pr.title,
            state: pr.state,
            author: pr.author.login.unwrap_or_else(|| "unknown".to_string()),
            head_branch: pr.head_ref_name,
            base_branch: pr.base_ref_name,
            url: pr.url,
            updated_at: pr.updated_at,
            is_draft: pr.is_draft,
        })
        .collect();
    Ok(PullRequestListing::Ok { items })
}
