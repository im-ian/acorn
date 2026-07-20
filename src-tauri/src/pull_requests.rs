//! GitHub pull request and issue data via the `gh` CLI.
//!
//! We shell out to `gh pr list --json ...` rather than calling GitHub's REST
//! API directly so that the user's existing `gh` auth (keychain, OAuth
//! device flow, enterprise hosts) is reused with zero in-app token storage.
//! When `gh` is missing or unauthenticated we surface a typed error so the
//! frontend can show actionable guidance.
//!
//! ## Multi-account routing
//!
//! Users frequently keep multiple GitHub identities logged into `gh` (e.g. a
//! work account in `~/Documents/Github` and a personal account in
//! `~/Documents/Personal`). The currently-active `gh` account is global, so
//! a personal repo opened while the work account is active would 403.
//!
//! To avoid that, before listing PRs we resolve the *correct* account for
//! the repo:
//!
//!   1. Enumerate every login authenticated against `github.com`.
//!   2. Probe `repos/<slug>` access with each account's token.
//!   3. If only one account has access — use it.
//!   4. If multiple do — prefer the one whose primary email matches the
//!      repo's `git config user.email` (best-effort; falls back to the
//!      currently-active gh account).
//!
//! The picked token is passed to `gh pr list` via `GH_TOKEN`, overriding
//! whichever account `gh` would otherwise pick.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::cli_resolver;
use crate::error::{AppError, AppResult};
use crate::git_ops::{github_owner_repo, DiffImages, DiffPayload};

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

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IssueStateFilter {
    Open,
    Closed,
    All,
}

impl IssueStateFilter {
    fn as_gh_arg(self) -> &'static str {
        match self {
            IssueStateFilter::Open => "open",
            IssueStateFilter::Closed => "closed",
            IssueStateFilter::All => "all",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct PullRequestLabel {
    pub name: String,
    /// Hex color without the leading `#`, as returned by gh.
    pub color: String,
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
    pub closed_at: Option<String>,
    pub merged_at: Option<String>,
    pub is_draft: bool,
    /// Aggregate of status checks on the head sha, mirroring the detail
    /// modal's badge logic. `None` when gh returned no rollup entries.
    pub checks: Option<ChecksSummary>,
    pub labels: Vec<PullRequestLabel>,
}

/// Pass / fail / pending counts derived from `statusCheckRollup`. NEUTRAL,
/// SKIPPED, CANCELLED conclusions are intentionally excluded so an optional
/// skipped job doesn't push a green PR into the partial bucket.
#[derive(Debug, Clone, Serialize)]
pub struct ChecksSummary {
    pub passed: u32,
    pub failed: u32,
    pub pending: u32,
}

/// One gh login that was probed during account resolution. `has_access` lets
/// the frontend explain why none of the user's accounts could see the repo.
#[derive(Debug, Clone, Serialize)]
pub struct AccountSummary {
    pub login: String,
    pub has_access: bool,
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
    #[serde(rename = "closedAt", default)]
    closed_at: Option<String>,
    #[serde(rename = "mergedAt", default)]
    merged_at: Option<String>,
    #[serde(rename = "isDraft", default)]
    is_draft: bool,
    #[serde(rename = "statusCheckRollup", default)]
    status_check_rollup: Option<Vec<GhCheck>>,
    #[serde(default)]
    labels: Vec<GhLabel>,
}

#[derive(Debug, Deserialize)]
struct GhLabel {
    #[serde(default)]
    name: String,
    #[serde(default)]
    color: String,
}

#[derive(Debug, Default, Deserialize)]
struct GhAuthor {
    #[serde(default)]
    login: Option<String>,
}

/// Outcome of the listing call.
///
/// - `NotGithub` — origin remote is non-GitHub; frontend renders a quiet
///   empty state instead of an error banner.
/// - `NoAccess` — `gh` is authenticated but none of the logged-in accounts
///   have access to the repo. Frontend lists the tried logins so the user
///   knows what to fix.
/// - `Ok` — listing succeeded; `account` is the login that was used so the
///   frontend can surface "via @login" context.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PullRequestListing {
    Ok {
        items: Vec<PullRequestInfo>,
        account: String,
    },
    NotGithub,
    NoAccess {
        slug: String,
        accounts: Vec<AccountSummary>,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct IssueInfo {
    pub number: u64,
    pub title: String,
    /// Lifecycle state from gh: "OPEN" / "CLOSED".
    pub state: String,
    pub author: String,
    pub url: String,
    pub created_at: String,
    pub updated_at: String,
    /// GitHub close reason such as "COMPLETED" / "NOT_PLANNED".
    pub state_reason: Option<String>,
    pub comments: u32,
    pub labels: Vec<PullRequestLabel>,
}

#[derive(Debug, Deserialize)]
struct GhIssue {
    number: u64,
    title: String,
    state: String,
    #[serde(default)]
    author: GhAuthor,
    url: String,
    #[serde(rename = "createdAt")]
    created_at: String,
    #[serde(rename = "updatedAt")]
    updated_at: String,
    #[serde(rename = "stateReason", default)]
    state_reason: Option<String>,
    #[serde(default)]
    comments: GhIssueComments,
    #[serde(default)]
    labels: Vec<GhLabel>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum GhIssueComments {
    Count(u32),
    Items(Vec<serde_json::Value>),
}

impl Default for GhIssueComments {
    fn default() -> Self {
        GhIssueComments::Count(0)
    }
}

impl GhIssueComments {
    fn count(&self) -> u32 {
        match self {
            GhIssueComments::Count(count) => *count,
            GhIssueComments::Items(items) => items.len().try_into().unwrap_or(u32::MAX),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum IssueListing {
    Ok {
        items: Vec<IssueInfo>,
        account: String,
    },
    NotGithub,
    NoAccess {
        slug: String,
        accounts: Vec<AccountSummary>,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct IssueComment {
    pub id: Option<u64>,
    pub author: String,
    pub author_avatar_url: Option<String>,
    pub body: String,
    pub created_at: String,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct IssueDetail {
    pub number: u64,
    pub title: String,
    pub body: String,
    /// Lifecycle state from gh: "OPEN" / "CLOSED".
    pub state: String,
    pub author: String,
    pub url: String,
    pub created_at: String,
    pub updated_at: String,
    /// GitHub close reason such as "COMPLETED" / "NOT_PLANNED".
    pub state_reason: Option<String>,
    pub labels: Vec<PullRequestLabel>,
    pub comments: Vec<IssueComment>,
    pub assignees: Vec<String>,
    pub milestone: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum IssueDetailListing {
    Ok {
        account: String,
        detail: IssueDetail,
    },
    NotGithub,
    NoAccess {
        slug: String,
        accounts: Vec<AccountSummary>,
    },
}

const GH_HOST: &str = "github.com";
const PR_PLAIN_TEXT_FALLBACK_SCAN_LIMIT: u32 = 1000;
const PR_PLAIN_TEXT_FALLBACK_MIN_CHARS: usize = 3;

/// How long a successful (login, repo) resolution stays trusted before we
/// re-probe access. Picked to be long enough to make periodic refreshes
/// cheap, short enough that a `gh auth login` for a new account becomes
/// usable without restarting the app.
const RESOLUTION_TTL: Duration = Duration::from_secs(10 * 60);
const RESOLUTION_CACHE_CAPACITY: usize = 128;

#[derive(Clone)]
struct CachedResolution {
    login: String,
    cached_at: Instant,
}

impl CachedResolution {
    fn fresh(&self) -> bool {
        self.cached_at.elapsed() < RESOLUTION_TTL
    }
}

struct ResolutionCache {
    entries: HashMap<PathBuf, CachedResolution>,
    capacity: usize,
}

impl ResolutionCache {
    fn with_capacity(capacity: usize) -> Self {
        Self {
            entries: HashMap::with_capacity(capacity),
            capacity,
        }
    }

    fn get(&mut self, repo_path: &Path) -> Option<CachedResolution> {
        let entry = self.entries.get(repo_path)?.clone();
        if entry.fresh() {
            Some(entry)
        } else {
            self.entries.remove(repo_path);
            None
        }
    }

    fn insert_at(&mut self, repo_path: PathBuf, login: String, cached_at: Instant) {
        self.entries.retain(|_, entry| entry.fresh());
        if self.capacity == 0 {
            return;
        }
        if !self.entries.contains_key(&repo_path) && self.entries.len() >= self.capacity {
            let oldest = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.cached_at)
                .map(|(path, _)| path.clone());
            if let Some(oldest) = oldest {
                self.entries.remove(&oldest);
            }
        }
        self.entries
            .insert(repo_path, CachedResolution { login, cached_at });
    }

    fn remove(&mut self, repo_path: &Path) {
        self.entries.remove(repo_path);
    }

    fn len(&self) -> usize {
        self.entries.len()
    }
}

/// Per-repo cache of which gh login was last seen with access. Keyed by
/// the repo path the frontend sent (the worktree). The token itself is
/// re-fetched on every call — that's a fast local `gh auth token` spawn,
/// no network — so we never store secrets in this cache.
fn resolution_cache() -> &'static Mutex<ResolutionCache> {
    use std::sync::OnceLock;
    static CELL: OnceLock<Mutex<ResolutionCache>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(ResolutionCache::with_capacity(RESOLUTION_CACHE_CAPACITY)))
}

fn cached_login(repo_path: &Path) -> Option<CachedResolution> {
    resolution_cache().lock().ok()?.get(repo_path)
}

fn store_resolution(repo_path: &Path, login: &str) {
    let Ok(mut cache) = resolution_cache().lock() else {
        return;
    };
    cache.insert_at(repo_path.to_path_buf(), login.to_string(), Instant::now());
}

fn invalidate_resolution(repo_path: &Path) {
    if let Ok(mut cache) = resolution_cache().lock() {
        cache.remove(repo_path);
    }
}

pub fn list_pull_requests(
    repo_path: &Path,
    state: PrStateFilter,
    limit: u32,
    query: Option<&str>,
) -> AppResult<PullRequestListing> {
    let Some(slug) = github_owner_repo(repo_path)? else {
        return Ok(PullRequestListing::NotGithub);
    };

    match try_with_account(repo_path, &slug, |token| {
        run_pr_list(&slug, token, state, limit, query)
    })? {
        AccountOutcome::Ok { account, value } => Ok(PullRequestListing::Ok {
            items: value,
            account,
        }),
        AccountOutcome::NoAccess { accounts } => {
            Ok(PullRequestListing::NoAccess { slug, accounts })
        }
    }
}

pub fn list_issues(
    repo_path: &Path,
    state: IssueStateFilter,
    limit: u32,
    query: Option<&str>,
) -> AppResult<IssueListing> {
    let Some(slug) = github_owner_repo(repo_path)? else {
        return Ok(IssueListing::NotGithub);
    };

    match try_with_account(repo_path, &slug, |token| {
        run_issue_list(&slug, token, state, limit, query)
    })? {
        AccountOutcome::Ok { account, value } => Ok(IssueListing::Ok {
            items: value,
            account,
        }),
        AccountOutcome::NoAccess { accounts } => Ok(IssueListing::NoAccess { slug, accounts }),
    }
}

pub fn get_issue_detail(repo_path: &Path, number: u64) -> AppResult<IssueDetailListing> {
    let Some(slug) = github_owner_repo(repo_path)? else {
        return Ok(IssueDetailListing::NotGithub);
    };

    match try_with_account(repo_path, &slug, |token| {
        let view = run_issue_view(&slug, number, token)?;
        Ok(build_issue_detail(number, view))
    })? {
        AccountOutcome::Ok {
            account,
            value: detail,
        } => Ok(IssueDetailListing::Ok { account, detail }),
        AccountOutcome::NoAccess { accounts } => {
            Ok(IssueDetailListing::NoAccess { slug, accounts })
        }
    }
}

pub fn add_issue_comment(repo_path: &Path, number: u64, body: &str) -> AppResult<()> {
    let Some(slug) = github_owner_repo(repo_path)? else {
        return Err(AppError::Other(
            "Origin remote is not a GitHub repository.".to_string(),
        ));
    };

    let body = body.trim();
    if body.is_empty() {
        return Err(AppError::Other("Comment body cannot be empty.".to_string()));
    }

    match try_with_account(repo_path, &slug, |token| {
        run_gh_comment("issue", &slug, number, token, body)
    })? {
        AccountOutcome::Ok { value, .. } => Ok(value),
        AccountOutcome::NoAccess { .. } => Err(AppError::Other(
            "No logged-in gh account can comment on this issue.".to_string(),
        )),
    }
}

pub fn update_github_comment(
    repo_path: &Path,
    account_login: &str,
    comment_id: u64,
    body: &str,
) -> AppResult<()> {
    let Some(slug) = github_owner_repo(repo_path)? else {
        return Err(AppError::Other(
            "Origin remote is not a GitHub repository.".to_string(),
        ));
    };

    let body = body.trim();
    if body.is_empty() {
        return Err(AppError::Other("Comment body cannot be empty.".to_string()));
    }

    let token = gh_token_for_required(account_login)?;
    run_issue_comment_update(&slug, comment_id, &token, body)?;
    store_resolution(repo_path, account_login.trim());
    Ok(())
}

pub fn delete_github_comment(
    repo_path: &Path,
    account_login: &str,
    comment_id: u64,
) -> AppResult<()> {
    let Some(slug) = github_owner_repo(repo_path)? else {
        return Err(AppError::Other(
            "Origin remote is not a GitHub repository.".to_string(),
        ));
    };

    let token = gh_token_for_required(account_login)?;
    run_issue_comment_delete(&slug, comment_id, &token)?;
    store_resolution(repo_path, account_login.trim());
    Ok(())
}

/// Outcome of running an authenticated gh operation for a repo. `Ok` carries
/// the gh login that ultimately serviced the call so the frontend can render
/// "via @login" context. `NoAccess` lets callers branch into a typed empty
/// state without going through the error path.
enum AccountOutcome<T> {
    Ok { account: String, value: T },
    NoAccess { accounts: Vec<AccountSummary> },
}

/// Run `op` with the right gh token for `slug`. Tries the cached login
/// first; on failure (or cache miss / stale login) falls through to a
/// fresh resolution and stores the picked login on success.
fn try_with_account<T, F>(repo_path: &Path, slug: &str, op: F) -> AppResult<AccountOutcome<T>>
where
    F: Fn(&str) -> AppResult<T>,
{
    if let Some(cached) = cached_login(repo_path) {
        if let Some(token) = gh_token_for(&cached.login) {
            match op(&token) {
                Ok(value) => {
                    return Ok(AccountOutcome::Ok {
                        account: cached.login,
                        value,
                    });
                }
                Err(_) => {
                    // Cached login lost access — drop and fall through.
                    invalidate_resolution(repo_path);
                }
            }
        } else {
            invalidate_resolution(repo_path);
        }
    }

    let resolution = resolve_account_for_repo(repo_path, slug)?;
    let Some(picked) = resolution.picked else {
        return Ok(AccountOutcome::NoAccess {
            accounts: resolution.candidates,
        });
    };

    let value = op(&picked.token)?;
    store_resolution(repo_path, &picked.login);
    Ok(AccountOutcome::Ok {
        account: picked.login,
        value,
    })
}

fn run_pr_list(
    slug: &str,
    token: &str,
    state: PrStateFilter,
    limit: u32,
    query: Option<&str>,
) -> AppResult<Vec<PullRequestInfo>> {
    let limit = limit.clamp(1, 1000);
    let items = run_pr_list_page(slug, token, state, limit, query)?;
    if !items.is_empty() {
        return Ok(items);
    }

    let Some(terms) = query.and_then(plain_text_pr_search_terms) else {
        return Ok(items);
    };

    let scan_limit = PR_PLAIN_TEXT_FALLBACK_SCAN_LIMIT.max(limit).clamp(1, 1000);
    let fallback_items = run_pr_list_page(slug, token, state, scan_limit, None)?;
    Ok(fallback_items
        .into_iter()
        .filter(|pr| pull_request_matches_plain_text_terms(pr, &terms))
        .take(limit as usize)
        .collect())
}

fn run_pr_list_page(
    slug: &str,
    token: &str,
    state: PrStateFilter,
    limit: u32,
    query: Option<&str>,
) -> AppResult<Vec<PullRequestInfo>> {
    let limit = limit.clamp(1, 1000);
    let limit_s = limit.to_string();
    let output = cli_resolver::run("gh", |cmd| {
        cmd.env("GH_TOKEN", token)
            // gh treats GH_HOST + GH_TOKEN as an "external" auth source and
            // skips its own keyring lookup, so this isolates the run to the
            // picked identity even when a different `gh auth status` account
            // is active.
            .env("GH_HOST", GH_HOST)
            .args([
                "pr",
                "list",
                "--repo",
                slug,
                "--state",
                state.as_gh_arg(),
                "--limit",
                &limit_s,
                "--json",
                "number,title,state,author,headRefName,baseRefName,url,updatedAt,\
                 closedAt,mergedAt,isDraft,statusCheckRollup,labels",
            ]);
        if let Some(q) = query {
            cmd.args(["--search", q]);
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

    Ok(raw.into_iter().map(pull_request_info_from_gh).collect())
}

fn pull_request_info_from_gh(pr: GhPullRequest) -> PullRequestInfo {
    let checks = pr.status_check_rollup.as_deref().and_then(|rollup| {
        if rollup.is_empty() {
            None
        } else {
            Some(summarize_checks(rollup))
        }
    });
    PullRequestInfo {
        number: pr.number,
        title: pr.title,
        state: pr.state,
        author: pr.author.login.unwrap_or_else(|| "unknown".to_string()),
        head_branch: pr.head_ref_name,
        base_branch: pr.base_ref_name,
        url: pr.url,
        updated_at: pr.updated_at,
        closed_at: normalize_github_timestamp(pr.closed_at),
        merged_at: normalize_github_timestamp(pr.merged_at),
        is_draft: pr.is_draft,
        checks,
        labels: pr
            .labels
            .into_iter()
            .map(|l| PullRequestLabel {
                name: l.name,
                color: l.color,
            })
            .collect(),
    }
}

fn plain_text_pr_search_terms(query: &str) -> Option<Vec<String>> {
    let trimmed = query.trim();
    if trimmed.is_empty() || trimmed.contains(':') || trimmed.contains('"') {
        return None;
    }

    let terms: Vec<String> = trimmed
        .split_whitespace()
        .map(|term| term.to_lowercase())
        .collect();
    if terms.iter().any(|term| {
        term.chars().filter(|c| c.is_alphanumeric()).count() >= PR_PLAIN_TEXT_FALLBACK_MIN_CHARS
    }) {
        Some(terms)
    } else {
        None
    }
}

fn pull_request_matches_plain_text_terms(pr: &PullRequestInfo, terms: &[String]) -> bool {
    terms
        .iter()
        .all(|term| pull_request_field_contains(pr, term))
}

fn pull_request_field_contains(pr: &PullRequestInfo, term: &str) -> bool {
    pr.title.to_lowercase().contains(term)
        || pr.author.to_lowercase().contains(term)
        || pr.head_branch.to_lowercase().contains(term)
        || pr.base_branch.to_lowercase().contains(term)
        || pr
            .labels
            .iter()
            .any(|label| label.name.to_lowercase().contains(term))
}

fn run_issue_list(
    slug: &str,
    token: &str,
    state: IssueStateFilter,
    limit: u32,
    query: Option<&str>,
) -> AppResult<Vec<IssueInfo>> {
    let limit = limit.clamp(1, 1000);
    let limit_s = limit.to_string();
    let output = cli_resolver::run("gh", |cmd| {
        cmd.env("GH_TOKEN", token).env("GH_HOST", GH_HOST).args([
            "issue",
            "list",
            "--repo",
            slug,
            "--state",
            state.as_gh_arg(),
            "--limit",
            &limit_s,
            "--json",
            "number,title,state,author,url,createdAt,updatedAt,stateReason,comments,labels",
        ]);
        if let Some(q) = query {
            cmd.args(["--search", q]);
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

    let raw: Vec<GhIssue> = serde_json::from_slice(&output.stdout)
        .map_err(|e| AppError::Other(format!("failed to parse gh output: {e}")))?;

    Ok(raw
        .into_iter()
        .map(|issue| IssueInfo {
            number: issue.number,
            title: issue.title,
            state: issue.state,
            author: issue.author.login.unwrap_or_else(|| "unknown".to_string()),
            url: issue.url,
            created_at: issue.created_at,
            updated_at: issue.updated_at,
            state_reason: normalize_optional_string(issue.state_reason),
            comments: issue.comments.count(),
            labels: issue
                .labels
                .into_iter()
                .map(|l| PullRequestLabel {
                    name: l.name,
                    color: l.color,
                })
                .collect(),
        })
        .collect())
}

fn build_issue_detail(number: u64, view: GhIssueView) -> IssueDetail {
    let actor_avatars = view
        .actor_avatars
        .as_ref()
        .map(|avatars| avatars.by_login.clone())
        .unwrap_or_default();
    let comments = view
        .comments
        .unwrap_or_default()
        .into_iter()
        .map(|comment| {
            let author = comment
                .author
                .login
                .unwrap_or_else(|| "unknown".to_string());
            IssueComment {
                id: comment
                    .database_id
                    .or_else(|| comment_id_from_url(comment.url.as_deref())),
                author_avatar_url: actor_avatars.get(&author).cloned(),
                author,
                body: comment.body.unwrap_or_default(),
                created_at: comment.created_at.unwrap_or_default(),
                url: comment.url,
            }
        })
        .collect();

    IssueDetail {
        number,
        title: view.title.unwrap_or_default(),
        body: view.body.unwrap_or_default(),
        state: view.state.unwrap_or_default(),
        author: view
            .author
            .unwrap_or_default()
            .login
            .unwrap_or_else(|| "unknown".to_string()),
        url: view.url.unwrap_or_default(),
        created_at: view.created_at.unwrap_or_default(),
        updated_at: view.updated_at.unwrap_or_default(),
        state_reason: normalize_optional_string(view.state_reason),
        labels: view
            .labels
            .into_iter()
            .map(|label| PullRequestLabel {
                name: label.name,
                color: label.color,
            })
            .collect(),
        comments,
        assignees: view
            .assignees
            .unwrap_or_default()
            .into_iter()
            .filter_map(|assignee| assignee.login)
            .collect(),
        milestone: view.milestone.and_then(|milestone| milestone.title),
    }
}

fn run_issue_view(slug: &str, number: u64, token: &str) -> AppResult<GhIssueView> {
    let number_s = number.to_string();
    let output = cli_resolver::run("gh", |cmd| {
        cmd.env("GH_TOKEN", token).env("GH_HOST", GH_HOST).args([
            "issue",
            "view",
            &number_s,
            "--repo",
            slug,
            "--json",
            "number,title,body,state,author,url,createdAt,updatedAt,stateReason,\
             comments,labels,assignees,milestone",
        ]);
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

    let mut view: GhIssueView = serde_json::from_slice(&output.stdout)
        .map_err(|e| AppError::Other(format!("failed to parse gh output: {e}")))?;
    view.actor_avatars = Some(resolve_issue_actor_avatars(&view, token));
    Ok(view)
}

/// Aggregate `statusCheckRollup` entries into pass/fail/pending counts.
/// Mirrors the frontend's `summarizeChecks` so list and detail views agree.
fn summarize_checks(checks: &[GhCheck]) -> ChecksSummary {
    let mut passed = 0u32;
    let mut failed = 0u32;
    let mut pending = 0u32;
    for c in checks {
        let status = c.status.as_deref().unwrap_or("").to_ascii_uppercase();
        if status != "COMPLETED" {
            pending += 1;
            continue;
        }
        match c
            .conclusion
            .as_deref()
            .unwrap_or("")
            .to_ascii_uppercase()
            .as_str()
        {
            "SUCCESS" => passed += 1,
            "FAILURE" | "TIMED_OUT" | "ACTION_REQUIRED" => failed += 1,
            // NEUTRAL / SKIPPED / CANCELLED: no signal — excluded from totals.
            _ => {}
        }
    }
    ChecksSummary {
        passed,
        failed,
        pending,
    }
}

struct PickedAccount {
    login: String,
    token: String,
}

struct AccountResolution {
    candidates: Vec<AccountSummary>,
    picked: Option<PickedAccount>,
}

/// Pick the gh account most likely to have access to `slug`. Preference
/// order: only-accessible-account → email-match against the repo's git
/// config → currently-active gh account → first accessible. Returns
/// `picked = None` when nothing has access.
///
/// Per-account `gh auth token` and `gh api repos/<slug>` probes run in
/// parallel — they're independent and each costs a process spawn plus
/// (for the API call) a network round-trip, so serializing them dominated
/// the total resolution time on multi-account setups.
fn resolve_account_for_repo(repo_path: &Path, slug: &str) -> AppResult<AccountResolution> {
    let logins = enumerate_logins(GH_HOST)?;
    if logins.is_empty() {
        return Err(AppError::Other(
            "gh CLI is not authenticated. Run `gh auth login`.".to_string(),
        ));
    }

    struct Probe {
        login: String,
        token: Option<String>,
        has_access: bool,
    }

    let probes: Vec<Probe> = std::thread::scope(|scope| {
        let handles: Vec<_> = logins
            .iter()
            .map(|login| {
                let login = login.clone();
                let slug = slug.to_string();
                scope.spawn(move || {
                    let token = gh_token_for(&login);
                    let has_access = token
                        .as_deref()
                        .map(|t| account_can_access(&slug, t))
                        .unwrap_or(false);
                    Probe {
                        login,
                        token,
                        has_access,
                    }
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().expect("probe thread panicked"))
            .collect()
    });

    let mut candidates: Vec<AccountSummary> = Vec::with_capacity(probes.len());
    let mut accessible: Vec<(String, String)> = Vec::new();
    for p in probes {
        candidates.push(AccountSummary {
            login: p.login.clone(),
            has_access: p.has_access,
        });
        if p.has_access {
            if let Some(tok) = p.token {
                accessible.push((p.login, tok));
            }
        }
    }

    let picked = match accessible.len() {
        0 => None,
        1 => Some(PickedAccount {
            login: accessible[0].0.clone(),
            token: accessible[0].1.clone(),
        }),
        _ => Some(pick_from_multiple(repo_path, &accessible)),
    };

    Ok(AccountResolution { candidates, picked })
}

fn pick_from_multiple(repo_path: &Path, accessible: &[(String, String)]) -> PickedAccount {
    // 1. Prefer an account whose primary email matches the repo's
    //    git user.email. Best-effort; either side may be missing.
    if let Some(repo_email) = git_user_email(repo_path) {
        for (login, token) in accessible {
            if let Some(account_email) = primary_email_for(token) {
                if account_email.eq_ignore_ascii_case(&repo_email) {
                    return PickedAccount {
                        login: login.clone(),
                        token: token.clone(),
                    };
                }
            }
        }
    }

    // 2. Fall back to whatever account `gh` currently considers active —
    //    matches the user's existing mental model.
    if let Some(active) = gh_active_token() {
        if let Some((login, token)) = accessible.iter().find(|(_, t)| t == &active) {
            return PickedAccount {
                login: login.clone(),
                token: token.clone(),
            };
        }
    }

    // 3. Otherwise just take the first account that worked.
    PickedAccount {
        login: accessible[0].0.clone(),
        token: accessible[0].1.clone(),
    }
}

/// Parse `gh auth status --hostname <host>` output and pull out logins.
/// gh writes the human-readable status block to *stderr*, so we read both
/// streams. Lines look like:
///   "  ✓ Logged in to github.com account jtf-ian (keyring)"
fn enumerate_logins(host: &str) -> AppResult<Vec<String>> {
    let out = cli_resolver::run("gh", |cmd| {
        cmd.args(["auth", "status", "--hostname", host]);
    })?;
    // Unauthenticated returns non-zero — empty list, not an error, so the
    // caller can produce a single canonical "not authenticated" message.
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );

    let needle = " account ";
    let mut logins: Vec<String> = Vec::new();
    for line in combined.lines() {
        let Some(idx) = line.find(needle) else {
            continue;
        };
        let after = &line[idx + needle.len()..];
        let login: String = after.chars().take_while(|c| !c.is_whitespace()).collect();
        if !login.is_empty() && !logins.iter().any(|l| l == &login) {
            logins.push(login);
        }
    }
    Ok(logins)
}

fn gh_token_for(login: &str) -> Option<String> {
    let out = cli_resolver::run("gh", |cmd| {
        cmd.args(["auth", "token", "--user", login]);
    })
    .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

fn gh_token_for_required(login: &str) -> AppResult<String> {
    let login = login.trim();
    if login.is_empty() {
        return Err(AppError::Other("GitHub account is required.".to_string()));
    }
    gh_token_for(login)
        .ok_or_else(|| AppError::Other(format!("No gh token found for account {login}.")))
}

fn gh_active_token() -> Option<String> {
    let out = cli_resolver::run("gh", |cmd| {
        cmd.args(["auth", "token"]);
    })
    .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// Cheap repo-access probe via `gh api repos/<slug> --silent`. Exits
/// non-zero on 403/404, success on 200 — exactly the signal we need.
fn account_can_access(slug: &str, token: &str) -> bool {
    let endpoint = format!("repos/{slug}");
    let out = cli_resolver::run("gh", |cmd| {
        cmd.env("GH_TOKEN", token)
            .env("GH_HOST", GH_HOST)
            .args(["api", &endpoint, "--silent"]);
    });
    match out {
        Ok(o) => o.status.success(),
        Err(_) => false,
    }
}

fn primary_email_for(token: &str) -> Option<String> {
    let out = cli_resolver::run("gh", |cmd| {
        cmd.env("GH_TOKEN", token)
            .env("GH_HOST", GH_HOST)
            .args(["api", "user", "--jq", ".email"]);
    })
    .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() || s == "null" {
        None
    } else {
        Some(s)
    }
}

fn git_user_email(repo_path: &Path) -> Option<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .args(["config", "user.email"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

// ---------------------------------------------------------------------------
// PR detail
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct PullRequestComment {
    pub id: Option<u64>,
    pub author: String,
    pub author_avatar_url: Option<String>,
    pub body: String,
    pub created_at: String,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PullRequestReview {
    pub author: String,
    pub author_avatar_url: Option<String>,
    /// Review state from GitHub: `APPROVED` / `CHANGES_REQUESTED` / `COMMENTED` / `DISMISSED` / `PENDING`.
    pub state: String,
    pub body: String,
    pub submitted_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PullRequestCommitAuthor {
    pub name: String,
    pub email: String,
    /// GitHub login when gh resolved one. None for unattributed commits
    /// (e.g. authored locally with an email not linked to any account).
    pub login: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PullRequestCommit {
    /// Full SHA — the UI shortens it for display but the link target needs the full id.
    pub oid: String,
    pub message_headline: String,
    pub message_body: String,
    pub committed_date: String,
    pub authors: Vec<PullRequestCommitAuthor>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PullRequestCheck {
    pub name: String,
    /// `QUEUED` / `IN_PROGRESS` / `COMPLETED` / `PENDING` (status checks).
    pub status: String,
    /// `SUCCESS` / `FAILURE` / `CANCELLED` / `NEUTRAL` / `SKIPPED` / `TIMED_OUT` / `ACTION_REQUIRED`.
    /// None while the run is still in progress.
    pub conclusion: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub url: Option<String>,
    /// Workflow display name (CheckRun) — empty for legacy StatusContext entries.
    pub workflow_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PullRequestDetail {
    pub number: u64,
    pub title: String,
    pub body: String,
    pub state: String,
    pub is_draft: bool,
    pub author: String,
    pub head_branch: String,
    pub base_branch: String,
    pub url: String,
    pub created_at: String,
    pub updated_at: String,
    pub merged_at: Option<String>,
    pub additions: u64,
    pub deletions: u64,
    pub changed_files: u64,
    /// `MERGEABLE` / `CONFLICTING` / `UNKNOWN`. Mirrors the GraphQL field exposed
    /// by `gh pr view --json mergeable`. The frontend uses this to decide
    /// whether to enable the merge button.
    pub mergeable: Option<String>,
    pub labels: Vec<PullRequestLabel>,
    pub comments: Vec<PullRequestComment>,
    pub reviews: Vec<PullRequestReview>,
    pub checks: Vec<PullRequestCheck>,
    pub commits: Vec<PullRequestCommit>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PullRequestDetailListing {
    Ok {
        account: String,
        detail: PullRequestDetail,
    },
    NotGithub,
    NoAccess {
        slug: String,
        accounts: Vec<AccountSummary>,
    },
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PullRequestDiffListing {
    Ok {
        account: String,
        diff: DiffPayload,
    },
    NotGithub,
    NoAccess {
        slug: String,
        accounts: Vec<AccountSummary>,
    },
}

pub fn get_pull_request_detail(
    repo_path: &Path,
    number: u64,
) -> AppResult<PullRequestDetailListing> {
    let Some(slug) = github_owner_repo(repo_path)? else {
        return Ok(PullRequestDetailListing::NotGithub);
    };

    match try_with_account(repo_path, &slug, |token| {
        let view = run_pr_view(&slug, number, token)?;
        Ok(build_detail(number, view))
    })? {
        AccountOutcome::Ok {
            account,
            value: detail,
        } => Ok(PullRequestDetailListing::Ok { account, detail }),
        AccountOutcome::NoAccess { accounts } => {
            Ok(PullRequestDetailListing::NoAccess { slug, accounts })
        }
    }
}

pub fn get_pull_request_diff(repo_path: &Path, number: u64) -> AppResult<PullRequestDiffListing> {
    let Some(slug) = github_owner_repo(repo_path)? else {
        return Ok(PullRequestDiffListing::NotGithub);
    };

    match try_with_account(repo_path, &slug, |token| {
        let diff_text = run_pr_diff(&slug, number, token)?;
        Ok(crate::unified_diff::parse_unified_diff(&diff_text))
    })? {
        AccountOutcome::Ok {
            account,
            value: diff,
        } => Ok(PullRequestDiffListing::Ok { account, diff }),
        AccountOutcome::NoAccess { accounts } => {
            Ok(PullRequestDiffListing::NoAccess { slug, accounts })
        }
    }
}

pub fn get_pull_request_diff_images(
    repo_path: &Path,
    number: u64,
    old_path: Option<&str>,
    new_path: Option<&str>,
) -> AppResult<DiffImages> {
    let Some(slug) = github_owner_repo(repo_path)? else {
        return Err(AppError::Other(
            "origin remote is not a GitHub repository".into(),
        ));
    };

    match try_with_account(repo_path, &slug, |token| {
        let refs = run_pr_refs(&slug, number, token)?;
        Ok(image_previews_against_refs(
            &slug,
            &refs.head_ref_name,
            &refs.base_ref_name,
            token,
            old_path,
            new_path,
        ))
    })? {
        AccountOutcome::Ok { value, .. } => Ok(value),
        AccountOutcome::NoAccess { .. } => Err(AppError::Other(format!(
            "no logged-in gh account can access {slug}"
        ))),
    }
}

pub fn add_pull_request_comment(repo_path: &Path, number: u64, body: &str) -> AppResult<()> {
    let Some(slug) = github_owner_repo(repo_path)? else {
        return Err(AppError::Other(
            "Origin remote is not a GitHub repository.".to_string(),
        ));
    };

    let body = body.trim();
    if body.is_empty() {
        return Err(AppError::Other("Comment body cannot be empty.".to_string()));
    }

    match try_with_account(repo_path, &slug, |token| {
        run_gh_comment("pr", &slug, number, token, body)
    })? {
        AccountOutcome::Ok { value, .. } => Ok(value),
        AccountOutcome::NoAccess { .. } => Err(AppError::Other(
            "No logged-in gh account can comment on this PR.".to_string(),
        )),
    }
}

/// Resolve one PR file's image sides without delaying the initial file list.
fn image_previews_against_refs(
    slug: &str,
    head_ref: &str,
    base_ref: &str,
    token: &str,
    old_path: Option<&str>,
    new_path: Option<&str>,
) -> DiffImages {
    let new_image = new_path.and_then(|path| {
        fetch_raw_blob(slug, head_ref, path, token)
            .ok()
            .map(|bytes| crate::git_ops::encode_data_uri(&bytes, path))
    });
    let old_image = old_path.and_then(|path| {
        fetch_raw_blob(slug, base_ref, path, token)
            .ok()
            .map(|bytes| crate::git_ops::encode_data_uri(&bytes, path))
    });
    DiffImages {
        old_image,
        new_image,
    }
}

fn build_detail(number: u64, view: GhPullRequestView) -> PullRequestDetail {
    let actor_avatars = view
        .actor_avatars
        .as_ref()
        .map(|avatars| avatars.by_login.clone())
        .unwrap_or_default();
    let comments = view
        .comments
        .unwrap_or_default()
        .into_iter()
        .map(|c| {
            let author = c.author.login.unwrap_or_else(|| "unknown".to_string());
            PullRequestComment {
                id: c
                    .database_id
                    .or_else(|| comment_id_from_url(c.url.as_deref())),
                author_avatar_url: actor_avatars.get(&author).cloned(),
                author,
                body: c.body.unwrap_or_default(),
                created_at: c.created_at.unwrap_or_default(),
                url: c.url,
            }
        })
        .collect();

    let reviews = view
        .reviews
        .unwrap_or_default()
        .into_iter()
        // Keep only reviews that actually carry a verdict or message — gh
        // emits a noisy stream of "PENDING" / empty COMMENTED entries that
        // would otherwise flood the conversation tab.
        .filter(|r| {
            !r.body.as_deref().unwrap_or("").is_empty()
                || r.state
                    .as_deref()
                    .map(|s| s == "APPROVED" || s == "CHANGES_REQUESTED" || s == "DISMISSED")
                    .unwrap_or(false)
        })
        .map(|r| {
            let author = r.author.login.unwrap_or_else(|| "unknown".to_string());
            PullRequestReview {
                author_avatar_url: actor_avatars.get(&author).cloned(),
                author,
                state: r.state.unwrap_or_default(),
                body: r.body.unwrap_or_default(),
                submitted_at: r.submitted_at.unwrap_or_default(),
            }
        })
        .collect();

    let checks = view
        .status_check_rollup
        .unwrap_or_default()
        .into_iter()
        .map(|c| PullRequestCheck {
            name: c.name.unwrap_or_else(|| c.context.unwrap_or_default()),
            status: c.status.unwrap_or_default(),
            conclusion: normalize_optional_string(c.conclusion),
            started_at: normalize_github_timestamp(c.started_at),
            completed_at: normalize_github_timestamp(c.completed_at),
            url: c.details_url.or(c.target_url),
            workflow_name: normalize_optional_string(c.workflow_name),
        })
        .collect();

    let commits = view
        .commits
        .unwrap_or_default()
        .into_iter()
        .map(|c| PullRequestCommit {
            oid: c.oid.unwrap_or_default(),
            message_headline: c.message_headline.unwrap_or_default(),
            message_body: c.message_body.unwrap_or_default(),
            committed_date: c.committed_date.unwrap_or_default(),
            authors: c
                .authors
                .unwrap_or_default()
                .into_iter()
                .map(|a| PullRequestCommitAuthor {
                    name: a.name.unwrap_or_default(),
                    email: a.email.unwrap_or_default(),
                    login: a.login,
                })
                .collect(),
        })
        .collect();

    PullRequestDetail {
        number,
        title: view.title.unwrap_or_default(),
        body: view.body.unwrap_or_default(),
        state: view.state.unwrap_or_default(),
        is_draft: view.is_draft.unwrap_or(false),
        author: view
            .author
            .unwrap_or_default()
            .login
            .unwrap_or_else(|| "unknown".to_string()),
        head_branch: view.head_ref_name.unwrap_or_default(),
        base_branch: view.base_ref_name.unwrap_or_default(),
        url: view.url.unwrap_or_default(),
        created_at: view.created_at.unwrap_or_default(),
        updated_at: view.updated_at.unwrap_or_default(),
        merged_at: view.merged_at,
        additions: view.additions.unwrap_or(0),
        deletions: view.deletions.unwrap_or(0),
        changed_files: view.changed_files.unwrap_or(0),
        mergeable: view.mergeable,
        labels: view
            .labels
            .into_iter()
            .map(|l| PullRequestLabel {
                name: l.name,
                color: l.color,
            })
            .collect(),
        comments,
        reviews,
        checks,
        commits,
    }
}

fn run_pr_view(slug: &str, number: u64, token: &str) -> AppResult<GhPullRequestView> {
    let number_s = number.to_string();
    let output = cli_resolver::run("gh", |cmd| {
        cmd.env("GH_TOKEN", token).env("GH_HOST", GH_HOST).args([
            "pr",
            "view",
            &number_s,
            "--repo",
            slug,
            "--json",
            "number,title,body,state,isDraft,author,headRefName,baseRefName,url,\
                 createdAt,updatedAt,mergedAt,additions,deletions,changedFiles,\
                 mergeable,labels,comments,reviews,statusCheckRollup,commits",
        ]);
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

    let mut view: GhPullRequestView = serde_json::from_slice(&output.stdout)
        .map_err(|e| AppError::Other(format!("failed to parse gh output: {e}")))?;
    view.actor_avatars = Some(resolve_pr_actor_avatars(&view, token));
    Ok(view)
}

fn run_pr_refs(slug: &str, number: u64, token: &str) -> AppResult<GhPullRequestRefs> {
    let number_s = number.to_string();
    let output = cli_resolver::run("gh", |cmd| {
        cmd.env("GH_TOKEN", token).env("GH_HOST", GH_HOST).args([
            "pr",
            "view",
            &number_s,
            "--repo",
            slug,
            "--json",
            "headRefName,baseRefName",
        ]);
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

    let view: GhPullRequestRefs = serde_json::from_slice(&output.stdout)
        .map_err(|e| AppError::Other(format!("failed to parse gh output: {e}")))?;
    Ok(view)
}

#[derive(Debug, Default, Clone)]
struct PrActorAvatars {
    by_login: HashMap<String, String>,
}

fn resolve_pr_actor_avatars(view: &GhPullRequestView, token: &str) -> PrActorAvatars {
    let mut logins = Vec::new();
    for comment in view.comments.as_deref().unwrap_or(&[]) {
        if let Some(login) = comment.author.login.as_deref() {
            logins.push(login.to_string());
        }
    }
    for review in view.reviews.as_deref().unwrap_or(&[]) {
        if let Some(login) = review.author.login.as_deref() {
            logins.push(login.to_string());
        }
    }
    logins.sort();
    logins.dedup();

    let mut by_login = HashMap::new();
    for login in logins {
        if let Some(url) = resolve_actor_avatar_url(&login, token) {
            by_login.insert(login, url);
        }
    }
    PrActorAvatars { by_login }
}

fn resolve_issue_actor_avatars(view: &GhIssueView, token: &str) -> PrActorAvatars {
    let mut logins = Vec::new();
    for comment in view.comments.as_deref().unwrap_or(&[]) {
        if let Some(login) = comment.author.login.as_deref() {
            logins.push(login.to_string());
        }
    }
    logins.sort();
    logins.dedup();

    let mut by_login = HashMap::new();
    for login in logins {
        if let Some(url) = resolve_actor_avatar_url(&login, token) {
            by_login.insert(login, url);
        }
    }
    PrActorAvatars { by_login }
}

fn resolve_actor_avatar_url(login: &str, token: &str) -> Option<String> {
    let user_endpoint = format!("users/{login}");
    if let Some(url) = gh_api_json::<GhRestUser>(&user_endpoint, token)
        .ok()
        .and_then(|u| u.avatar_url)
    {
        return Some(url);
    }

    let app_endpoint = format!("apps/{login}");
    gh_api_json::<GhRestApp>(&app_endpoint, token)
        .ok()
        .map(|app| format!("https://avatars.githubusercontent.com/in/{}?v=4", app.id))
}

fn gh_api_json<T: serde::de::DeserializeOwned>(endpoint: &str, token: &str) -> AppResult<T> {
    let output = cli_resolver::run("gh", |cmd| {
        cmd.env("GH_TOKEN", token)
            .env("GH_HOST", GH_HOST)
            .args(["api", endpoint]);
    })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let msg = if stderr.is_empty() {
            format!("gh api {endpoint} exited with status {}", output.status)
        } else {
            stderr
        };
        return Err(AppError::Other(msg));
    }

    serde_json::from_slice(&output.stdout)
        .map_err(|e| AppError::Other(format!("failed to parse gh api output: {e}")))
}

#[derive(Debug, Deserialize)]
struct GhRestUser {
    #[serde(rename = "avatar_url")]
    avatar_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GhRestApp {
    id: u64,
}

pub fn get_pull_request_commit_diff(repo_path: &Path, sha: &str) -> AppResult<DiffPayload> {
    let Some(slug) = github_owner_repo(repo_path)? else {
        return Err(AppError::Other(
            "origin remote is not a GitHub repository".into(),
        ));
    };
    match try_with_account(repo_path, &slug, |token| {
        let diff_text = run_commit_diff(&slug, sha, token)?;
        Ok(crate::unified_diff::parse_unified_diff(&diff_text))
    })? {
        AccountOutcome::Ok { value, .. } => Ok(value),
        AccountOutcome::NoAccess { .. } => Err(AppError::Other(format!(
            "no logged-in gh account can access {slug}"
        ))),
    }
}

pub fn get_pull_request_commit_diff_images(
    repo_path: &Path,
    sha: &str,
    old_path: Option<&str>,
    new_path: Option<&str>,
) -> AppResult<DiffImages> {
    let Some(slug) = github_owner_repo(repo_path)? else {
        return Err(AppError::Other(
            "origin remote is not a GitHub repository".into(),
        ));
    };
    match try_with_account(repo_path, &slug, |token| {
        Ok(image_previews_for_commit(
            &slug, sha, token, old_path, new_path,
        ))
    })? {
        AccountOutcome::Ok { value, .. } => Ok(value),
        AccountOutcome::NoAccess { .. } => Err(AppError::Other(format!(
            "no logged-in gh account can access {slug}"
        ))),
    }
}

/// Map of git OID → GitHub login for commits in a repo. Resolves the
/// missing chunk in one batched GraphQL call against `repository.object`
/// nodes, then caches `(slug, sha) → Option<login>` so subsequent calls
/// (re-paging, modal re-opens) are free.
///
/// `None` in the returned map means the commit exists on GitHub but its
/// author email didn't resolve to a user account; missing keys mean we
/// couldn't reach GitHub at all (no gh account with access, network
/// failure, etc.) and the caller should not display an avatar.
pub fn resolve_commit_logins(
    repo_path: &Path,
    shas: Vec<String>,
) -> AppResult<HashMap<String, Option<String>>> {
    let Some(slug) = github_owner_repo(repo_path)? else {
        return Ok(HashMap::new());
    };
    let (owner, name) = validate_github_slug(&slug)?;
    for sha in &shas {
        validate_commit_oid(sha)?;
    }

    let cache = commit_login_cache();
    let mut result: HashMap<String, Option<String>> = HashMap::new();
    let mut needed: Vec<String> = Vec::new();
    {
        let lock = cache
            .lock()
            .map_err(|_| AppError::Other("commit-login cache poisoned".into()))?;
        for sha in &shas {
            let key = (slug.clone(), sha.clone());
            if let Some(login) = lock.get(&key) {
                result.insert(sha.clone(), login.clone());
            } else {
                needed.push(sha.clone());
            }
        }
    }
    if needed.is_empty() {
        return Ok(result);
    }

    let query = build_commit_login_query(needed.len());

    match try_with_account(repo_path, &slug, |token| {
        let output = cli_resolver::run("gh", |cmd| {
            cmd.env("GH_TOKEN", token)
                .env("GH_HOST", GH_HOST)
                .arg("api")
                .arg("graphql")
                .arg("-f")
                .arg(format!("query={query}"))
                .arg("-f")
                .arg(format!("owner={owner}"))
                .arg("-f")
                .arg(format!("name={name}"));
            for (i, sha) in needed.iter().enumerate() {
                cmd.arg("-f").arg(format!("oid{i}={sha}"));
            }
        })?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(AppError::Other(if stderr.is_empty() {
                format!("gh graphql exited with {}", output.status)
            } else {
                stderr
            }));
        }
        let v: serde_json::Value = serde_json::from_slice(&output.stdout)
            .map_err(|e| AppError::Other(format!("gh graphql parse: {e}")))?;
        let mut out: HashMap<String, Option<String>> = HashMap::new();
        if let Some(repo) = v.pointer("/data/repository").and_then(|x| x.as_object()) {
            for (i, sha) in needed.iter().enumerate() {
                let key = format!("c{i}");
                let login = repo
                    .get(&key)
                    .and_then(|c| c.pointer("/author/user/login"))
                    .and_then(|l| l.as_str())
                    .map(|s| s.to_string());
                out.insert(sha.clone(), login);
            }
        }
        Ok(out)
    })? {
        AccountOutcome::Ok { value, .. } => {
            if let Ok(mut lock) = cache.lock() {
                for (sha, login) in value.iter() {
                    lock.insert((slug.clone(), sha.clone()), login.clone());
                }
            }
            result.extend(value);
            Ok(result)
        }
        AccountOutcome::NoAccess { .. } => Ok(result),
    }
}

fn validate_github_slug(slug: &str) -> AppResult<(&str, &str)> {
    let (owner, name) = slug
        .split_once('/')
        .ok_or_else(|| AppError::Other(format!("invalid GitHub slug: {slug}")))?;
    if owner.is_empty()
        || name.is_empty()
        || owner.contains('/')
        || name.contains('/')
        || !owner.bytes().all(is_github_slug_part_byte)
        || !name.bytes().all(is_github_slug_part_byte)
    {
        return Err(AppError::Other(format!("invalid GitHub slug: {slug}")));
    }
    Ok((owner, name))
}

fn is_github_slug_part_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-')
}

fn validate_commit_oid(oid: &str) -> AppResult<()> {
    if oid.len() == 40 && oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(AppError::Other(format!("invalid commit oid: {oid}")))
    }
}

fn build_commit_login_query(count: usize) -> String {
    let mut query = String::from("query($owner:String!,$name:String!");
    for i in 0..count {
        query.push_str(&format!(",$oid{i}:GitObjectID!"));
    }
    query.push_str("){repository(owner:$owner,name:$name){");
    for i in 0..count {
        query.push_str(&format!(
            "c{i}:object(oid:$oid{i}){{...on Commit{{author{{user{{login}}}}}}}}",
        ));
    }
    query.push_str("}}");
    query
}

const COMMIT_LOGIN_CACHE_CAPACITY: usize = 4096;

struct CommitLoginCache {
    entries: HashMap<(String, String), Option<String>>,
    insertion_order: VecDeque<(String, String)>,
    capacity: usize,
}

impl CommitLoginCache {
    fn with_capacity(capacity: usize) -> Self {
        Self {
            entries: HashMap::with_capacity(capacity),
            insertion_order: VecDeque::with_capacity(capacity),
            capacity,
        }
    }

    fn get(&self, key: &(String, String)) -> Option<&Option<String>> {
        self.entries.get(key)
    }

    fn insert(&mut self, key: (String, String), login: Option<String>) {
        if self.entries.contains_key(&key) {
            self.entries.insert(key, login);
            return;
        }
        if self.capacity == 0 {
            return;
        }
        while self.entries.len() >= self.capacity {
            let Some(oldest) = self.insertion_order.pop_front() else {
                break;
            };
            self.entries.remove(&oldest);
        }
        self.insertion_order.push_back(key.clone());
        self.entries.insert(key, login);
    }

    fn len(&self) -> usize {
        self.entries.len()
    }
}

fn commit_login_cache() -> &'static Mutex<CommitLoginCache> {
    use std::sync::OnceLock;
    static CELL: OnceLock<Mutex<CommitLoginCache>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(CommitLoginCache::with_capacity(COMMIT_LOGIN_CACHE_CAPACITY)))
}

/// Resolve one commit file's image sides. Missing sides and fetch failures
/// remain absent so the renderer can show its preview placeholder.
fn image_previews_for_commit(
    slug: &str,
    sha: &str,
    token: &str,
    old_path: Option<&str>,
    new_path: Option<&str>,
) -> DiffImages {
    let parent = format!("{sha}^");
    let new_image = new_path.and_then(|path| {
        fetch_raw_blob(slug, sha, path, token)
            .ok()
            .map(|bytes| crate::git_ops::encode_data_uri(&bytes, path))
    });
    let old_image = old_path.and_then(|path| {
        fetch_raw_blob(slug, &parent, path, token)
            .ok()
            .map(|bytes| crate::git_ops::encode_data_uri(&bytes, path))
    });
    DiffImages {
        old_image,
        new_image,
    }
}

fn fetch_raw_blob(slug: &str, git_ref: &str, path: &str, token: &str) -> AppResult<Vec<u8>> {
    let endpoint = format!("repos/{slug}/contents/{path}?ref={git_ref}");
    let output = cli_resolver::run("gh", |cmd| {
        cmd.env("GH_TOKEN", token).env("GH_HOST", GH_HOST).args([
            "api",
            "-H",
            "Accept: application/vnd.github.raw",
            &endpoint,
        ]);
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
    Ok(output.stdout)
}

fn run_commit_diff(slug: &str, sha: &str, token: &str) -> AppResult<String> {
    let endpoint = format!("repos/{slug}/commits/{sha}");
    let output = cli_resolver::run("gh", |cmd| {
        cmd.env("GH_TOKEN", token).env("GH_HOST", GH_HOST).args([
            "api",
            "-H",
            "Accept: application/vnd.github.diff",
            &endpoint,
        ]);
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
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn run_pr_diff(slug: &str, number: u64, token: &str) -> AppResult<String> {
    let number_s = number.to_string();
    let output = cli_resolver::run("gh", |cmd| {
        cmd.env("GH_TOKEN", token)
            .env("GH_HOST", GH_HOST)
            .args(["pr", "diff", &number_s, "--repo", slug]);
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
    // gh writes the patch to stdout as UTF-8. Lossy decode keeps things
    // working for the rare diff containing invalid bytes (binary files,
    // mojibake) — those segments are non-renderable anyway and the parser
    // ultimately routes them into the binary-placeholder branch.
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[derive(Debug, Default, Deserialize)]
struct GhPullRequestRefs {
    #[serde(rename = "headRefName")]
    head_ref_name: String,
    #[serde(rename = "baseRefName")]
    base_ref_name: String,
}

#[derive(Debug, Default, Deserialize)]
struct GhPullRequestView {
    title: Option<String>,
    body: Option<String>,
    state: Option<String>,
    #[serde(rename = "isDraft")]
    is_draft: Option<bool>,
    author: Option<GhAuthor>,
    #[serde(rename = "headRefName")]
    head_ref_name: Option<String>,
    #[serde(rename = "baseRefName")]
    base_ref_name: Option<String>,
    url: Option<String>,
    #[serde(rename = "createdAt")]
    created_at: Option<String>,
    #[serde(rename = "updatedAt")]
    updated_at: Option<String>,
    #[serde(rename = "mergedAt")]
    merged_at: Option<String>,
    additions: Option<u64>,
    deletions: Option<u64>,
    #[serde(rename = "changedFiles")]
    changed_files: Option<u64>,
    mergeable: Option<String>,
    #[serde(default)]
    labels: Vec<GhLabel>,
    comments: Option<Vec<GhComment>>,
    reviews: Option<Vec<GhReview>>,
    #[serde(rename = "statusCheckRollup")]
    status_check_rollup: Option<Vec<GhCheck>>,
    commits: Option<Vec<GhCommit>>,
    #[serde(skip)]
    actor_avatars: Option<PrActorAvatars>,
}

#[derive(Debug, Default, Deserialize)]
struct GhIssueView {
    title: Option<String>,
    body: Option<String>,
    state: Option<String>,
    author: Option<GhAuthor>,
    url: Option<String>,
    #[serde(rename = "createdAt")]
    created_at: Option<String>,
    #[serde(rename = "updatedAt")]
    updated_at: Option<String>,
    #[serde(rename = "stateReason")]
    state_reason: Option<String>,
    #[serde(default)]
    labels: Vec<GhLabel>,
    comments: Option<Vec<GhIssueComment>>,
    assignees: Option<Vec<GhAuthor>>,
    milestone: Option<GhMilestone>,
    #[serde(skip)]
    actor_avatars: Option<PrActorAvatars>,
}

#[derive(Debug, Deserialize)]
struct GhIssueComment {
    #[serde(rename = "databaseId")]
    database_id: Option<u64>,
    #[serde(default)]
    author: GhAuthor,
    body: Option<String>,
    #[serde(rename = "createdAt")]
    created_at: Option<String>,
    url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GhMilestone {
    title: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GhCommit {
    oid: Option<String>,
    #[serde(rename = "messageHeadline")]
    message_headline: Option<String>,
    #[serde(rename = "messageBody")]
    message_body: Option<String>,
    #[serde(rename = "committedDate")]
    committed_date: Option<String>,
    authors: Option<Vec<GhCommitAuthor>>,
}

#[derive(Debug, Default, Deserialize)]
struct GhCommitAuthor {
    name: Option<String>,
    email: Option<String>,
    login: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GhComment {
    #[serde(rename = "databaseId")]
    database_id: Option<u64>,
    #[serde(default)]
    author: GhAuthor,
    body: Option<String>,
    #[serde(rename = "createdAt")]
    created_at: Option<String>,
    url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GhReview {
    #[serde(default)]
    author: GhAuthor,
    state: Option<String>,
    body: Option<String>,
    #[serde(rename = "submittedAt")]
    submitted_at: Option<String>,
}

/// gh blends two shapes into `statusCheckRollup`: `CheckRun` (from GitHub
/// Actions / app check-runs) and `StatusContext` (legacy commit statuses).
/// Field availability differs, so every key is optional.
#[derive(Debug, Deserialize)]
struct GhCheck {
    name: Option<String>,
    /// Legacy StatusContext label.
    context: Option<String>,
    status: Option<String>,
    conclusion: Option<String>,
    #[serde(rename = "startedAt")]
    started_at: Option<String>,
    #[serde(rename = "completedAt")]
    completed_at: Option<String>,
    #[serde(rename = "detailsUrl")]
    details_url: Option<String>,
    /// StatusContext exposes `targetUrl` instead of `detailsUrl`.
    #[serde(rename = "targetUrl")]
    target_url: Option<String>,
    #[serde(rename = "workflowName")]
    workflow_name: Option<String>,
}

// ---------------------------------------------------------------------------
// PR mutations: merge / close / AI commit message
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MergeMethod {
    Squash,
    Merge,
    Rebase,
}

impl MergeMethod {
    fn flag(self) -> &'static str {
        match self {
            MergeMethod::Squash => "--squash",
            MergeMethod::Merge => "--merge",
            MergeMethod::Rebase => "--rebase",
        }
    }

    /// Squash and merge commits accept `--subject` / `--body` to override the
    /// commit message. Rebase merges replay individual commits, so message
    /// overrides are not applicable.
    fn accepts_message_override(self) -> bool {
        matches!(self, MergeMethod::Squash | MergeMethod::Merge)
    }
}

pub fn merge_pull_request(
    repo_path: &Path,
    number: u64,
    method: MergeMethod,
    commit_title: Option<String>,
    commit_body: Option<String>,
    admin: bool,
) -> AppResult<()> {
    let Some(slug) = github_owner_repo(repo_path)? else {
        return Err(AppError::Other(
            "Origin remote is not a GitHub repository.".to_string(),
        ));
    };

    match try_with_account(repo_path, &slug, |token| {
        run_pr_merge(
            &slug,
            number,
            token,
            method,
            commit_title.as_deref(),
            commit_body.as_deref(),
            admin,
        )
    })? {
        AccountOutcome::Ok { value, .. } => Ok(value),
        AccountOutcome::NoAccess { .. } => Err(AppError::Other(
            "No logged-in gh account has merge access to this repo.".to_string(),
        )),
    }
}

pub fn close_pull_request(repo_path: &Path, number: u64) -> AppResult<()> {
    let Some(slug) = github_owner_repo(repo_path)? else {
        return Err(AppError::Other(
            "Origin remote is not a GitHub repository.".to_string(),
        ));
    };

    match try_with_account(repo_path, &slug, |token| run_pr_close(&slug, number, token))? {
        AccountOutcome::Ok { value, .. } => Ok(value),
        AccountOutcome::NoAccess { .. } => Err(AppError::Other(
            "No logged-in gh account can close this PR.".to_string(),
        )),
    }
}

pub fn update_pull_request_body(repo_path: &Path, number: u64, body: &str) -> AppResult<()> {
    let Some(slug) = github_owner_repo(repo_path)? else {
        return Err(AppError::Other(
            "Origin remote is not a GitHub repository.".to_string(),
        ));
    };

    match try_with_account(repo_path, &slug, |token| {
        run_pr_edit_body(&slug, number, token, body)
    })? {
        AccountOutcome::Ok { value, .. } => Ok(value),
        AccountOutcome::NoAccess { .. } => Err(AppError::Other(
            "No logged-in gh account can edit this PR.".to_string(),
        )),
    }
}

fn run_pr_merge(
    slug: &str,
    number: u64,
    token: &str,
    method: MergeMethod,
    commit_title: Option<&str>,
    commit_body: Option<&str>,
    admin: bool,
) -> AppResult<()> {
    use std::io::Write;
    use std::process::Stdio;

    // stdin-piped invocation can't go through `cli_resolver::run` (which is
    // shaped for `output()`-style calls), so resolve the path manually and
    // build the Command ourselves. NotFound during spawn invalidates the
    // cache so the next attempt re-resolves.
    let gh_path = cli_resolver::resolve("gh")?;
    let mut cmd = Command::new(&gh_path);
    cmd.env("GH_TOKEN", token).env("GH_HOST", GH_HOST).args([
        "pr",
        "merge",
        &number.to_string(),
        "--repo",
        slug,
        method.flag(),
    ]);

    // `--admin` instructs gh to use admin privileges to override branch
    // protection rules. Required when checks are failing or pending but the
    // user has the role to force-merge against repo policy.
    if admin {
        cmd.arg("--admin");
    }

    if method.accepts_message_override() {
        if let Some(title) = commit_title {
            if !title.trim().is_empty() {
                cmd.args(["--subject", title]);
            }
        }
        if let Some(body) = commit_body {
            // Always pass --body even when empty so gh doesn't fall back to a
            // user-config template on top of the supplied subject.
            cmd.args(["--body", body]);
        }
    }

    // Older `gh` releases reject `--yes` as an unknown flag. Pipe a
    // confirmation through stdin instead — it answers any "Continue with
    // merge?" prompt without depending on a flag the local CLI may not have.
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                cli_resolver::invalidate("gh");
            }
            cli_resolver::spawn_error("gh", e)
        })?;
    if let Some(stdin) = child.stdin.as_mut() {
        let _ = stdin.write_all(b"y\n");
    }
    let output = child
        .wait_with_output()
        .map_err(|e| AppError::Other(format!("failed waiting for gh: {e}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let msg = if stderr.is_empty() {
            format!("gh exited with status {}", output.status)
        } else {
            stderr
        };
        return Err(AppError::Other(msg));
    }
    Ok(())
}

fn run_pr_close(slug: &str, number: u64, token: &str) -> AppResult<()> {
    let number_s = number.to_string();
    let output = cli_resolver::run("gh", |cmd| {
        cmd.env("GH_TOKEN", token)
            .env("GH_HOST", GH_HOST)
            .args(["pr", "close", &number_s, "--repo", slug]);
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
    Ok(())
}

/// Pipe the new body via stdin (`--body-file -`) to dodge shell escaping
/// pitfalls — bodies routinely contain backticks, `$`, and other characters
/// that would need defensive quoting if passed as `--body "..."`.
fn run_pr_edit_body(slug: &str, number: u64, token: &str, body: &str) -> AppResult<()> {
    use std::io::Write;
    use std::process::Stdio;

    let gh_path = cli_resolver::resolve("gh")?;
    let mut cmd = Command::new(&gh_path);
    cmd.env("GH_TOKEN", token).env("GH_HOST", GH_HOST).args([
        "pr",
        "edit",
        &number.to_string(),
        "--repo",
        slug,
        "--body-file",
        "-",
    ]);

    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                cli_resolver::invalidate("gh");
            }
            cli_resolver::spawn_error("gh", e)
        })?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(body.as_bytes())
            .map_err(|e| AppError::Other(format!("failed writing body to gh: {e}")))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|e| AppError::Other(format!("failed waiting for gh: {e}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let msg = if stderr.is_empty() {
            format!("gh exited with status {}", output.status)
        } else {
            stderr
        };
        return Err(AppError::Other(msg));
    }
    Ok(())
}

fn run_gh_comment(target: &str, slug: &str, number: u64, token: &str, body: &str) -> AppResult<()> {
    use std::io::Write;
    use std::process::Stdio;

    let gh_path = cli_resolver::resolve("gh")?;
    let number_s = number.to_string();
    let mut cmd = Command::new(&gh_path);
    cmd.env("GH_TOKEN", token).env("GH_HOST", GH_HOST).args([
        target,
        "comment",
        &number_s,
        "--repo",
        slug,
        "--body-file",
        "-",
    ]);

    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                cli_resolver::invalidate("gh");
            }
            cli_resolver::spawn_error("gh", e)
        })?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(body.as_bytes())
            .map_err(|e| AppError::Other(format!("failed writing comment to gh: {e}")))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|e| AppError::Other(format!("failed waiting for gh: {e}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let msg = if stderr.is_empty() {
            format!("gh exited with status {}", output.status)
        } else {
            stderr
        };
        return Err(AppError::Other(msg));
    }
    Ok(())
}

fn run_issue_comment_update(slug: &str, comment_id: u64, token: &str, body: &str) -> AppResult<()> {
    use std::io::Write;
    use std::process::Stdio;

    let gh_path = cli_resolver::resolve("gh")?;
    let endpoint = format!("repos/{slug}/issues/comments/{comment_id}");
    let payload = serde_json::json!({ "body": body }).to_string();
    let mut cmd = Command::new(&gh_path);
    cmd.env("GH_TOKEN", token)
        .env("GH_HOST", GH_HOST)
        .args(["api", "-X", "PATCH", &endpoint, "--input", "-", "--silent"]);

    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                cli_resolver::invalidate("gh");
            }
            cli_resolver::spawn_error("gh", e)
        })?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(payload.as_bytes())
            .map_err(|e| AppError::Other(format!("failed writing comment update to gh: {e}")))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|e| AppError::Other(format!("failed waiting for gh: {e}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let msg = if stderr.is_empty() {
            format!("gh exited with status {}", output.status)
        } else {
            stderr
        };
        return Err(AppError::Other(msg));
    }
    Ok(())
}

fn run_issue_comment_delete(slug: &str, comment_id: u64, token: &str) -> AppResult<()> {
    let endpoint = format!("repos/{slug}/issues/comments/{comment_id}");
    let output = cli_resolver::run("gh", |cmd| {
        cmd.env("GH_TOKEN", token)
            .env("GH_HOST", GH_HOST)
            .args(["api", "-X", "DELETE", &endpoint, "--silent"]);
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
    Ok(())
}

fn comment_id_from_url(url: Option<&str>) -> Option<u64> {
    let fragment = url?.rsplit_once('#')?.1;
    fragment.strip_prefix("issuecomment-")?.parse().ok()
}

#[derive(Debug, Clone, Serialize)]
pub struct GeneratedCommitMessage {
    pub title: String,
    pub body: String,
}

/// Generate a squash/merge commit message by spawning a one-shot headless
/// AI CLI invocation. The renderer sends provider intent only; the backend
/// resolves that intent to a known command/arg shape before spawning.
pub fn generate_pr_commit_message(
    repo_path: &Path,
    number: u64,
    method: MergeMethod,
    ai: crate::ai::AiExecutionRequest,
    prompt: String,
) -> AppResult<GeneratedCommitMessage> {
    let resolved = ai.resolve()?;

    let Some(slug) = github_owner_repo(repo_path)? else {
        return Err(AppError::Other(
            "Origin remote is not a GitHub repository.".to_string(),
        ));
    };

    let context = match try_with_account(repo_path, &slug, |token| {
        let view = run_pr_view(&slug, number, token)?;
        let diff = run_pr_diff(&slug, number, token)?;
        Ok((view, diff))
    })? {
        AccountOutcome::Ok { value, .. } => value,
        AccountOutcome::NoAccess { .. } => {
            return Err(AppError::Other(
                "No logged-in gh account can read this PR.".to_string(),
            ));
        }
    };

    let (view, diff) = context;
    let prompt = build_commit_message_prompt(method, &prompt, &view, &diff);
    let raw = crate::ai::run_resolved_oneshot(&resolved, &prompt, "Settings → Agents")?;
    Ok(parse_commit_message_response(&raw))
}

fn build_commit_message_prompt(
    method: MergeMethod,
    user_prompt: &str,
    view: &GhPullRequestView,
    diff: &str,
) -> String {
    let fallback_prompt = match method {
        MergeMethod::Squash => {
            "Write a single squash commit message. The first line is a short imperative subject (≤72 chars). \
             Leave one blank line, then a concise body explaining the WHY (not the what)."
        }
        MergeMethod::Merge => {
            "Write a merge commit message. The first line is a short imperative subject (≤72 chars). \
             Leave one blank line, then a body explaining what this branch brings into the base."
        }
        MergeMethod::Rebase => {
            // Rebase doesn't accept message overrides — but if the caller asks
            // for a message anyway, give them something usable.
            "Summarize the change as a single subject line (≤72 chars), no body."
        }
    };
    let user_prompt = user_prompt.trim();
    let instructions = if user_prompt.is_empty() {
        fallback_prompt
    } else {
        user_prompt
    };

    // Cap diff size — claude has a context budget and the user can refine
    // afterwards if details are missing.
    const MAX_DIFF_BYTES: usize = 12_000;
    let trimmed_diff = if diff.len() > MAX_DIFF_BYTES {
        format!("{}\n…(diff truncated)…", &diff[..MAX_DIFF_BYTES])
    } else {
        diff.to_string()
    };

    format!(
        "You are generating the exact git commit message text that Acorn will put into \
         the pull request merge dialog.\n\n\
         Style and content instructions:\n{instructions}\n\n\
         Hard output contract:\n\
         - Return only the generated commit message text.\n\
         - First line: subject only, no label, prefix, or heading.\n\
         - Then one blank line, then the body text. For rebase, leave the body empty.\n\
         - Do not mention or summarize the prompt, rules, PR, diff, or your reasoning.\n\
         - Do not include explanations, markdown headings, code fences, quotes, or \
         labels such as \"Title:\" / \"Comment:\".\n\n\
         PR title: {title}\n\
         PR description:\n{body}\n\n\
         Diff:\n{diff}\n",
        instructions = instructions,
        title = view.title.as_deref().unwrap_or(""),
        body = view.body.as_deref().unwrap_or(""),
        diff = trimmed_diff,
    )
}

fn parse_commit_message_response(raw: &str) -> GeneratedCommitMessage {
    let trimmed = raw.trim_matches(|c: char| c.is_whitespace() || c == '`');
    let mut lines = trimmed.lines();
    let title = lines.next().map(str::trim).unwrap_or("").to_string();
    let remaining: String = lines.collect::<Vec<_>>().join("\n");
    let body = remaining.trim_start_matches('\n').trim().to_string();
    GeneratedCommitMessage { title, body }
}

/// Single GitHub Actions workflow run. Mirrors the fields the Actions tab
/// shows; richer detail (jobs, logs) intentionally omitted — clicking a row
/// opens the run on GitHub where the user already has the full UI.
#[derive(Debug, Clone, Serialize)]
pub struct WorkflowRun {
    pub id: u64,
    /// `displayTitle` from gh — the commit message the run was triggered for,
    /// or the manually entered title for `workflow_dispatch` runs.
    pub display_title: String,
    pub workflow_name: String,
    /// `queued` | `in_progress` | `completed` | `requested` | `waiting` |
    /// `pending` (gh REST status field, lower-case).
    pub status: String,
    /// `success` | `failure` | `cancelled` | `skipped` | `neutral` |
    /// `timed_out` | `action_required` | `startup_failure`. None while the
    /// run is still in progress.
    pub conclusion: Option<String>,
    /// Trigger event: `push`, `pull_request`, `workflow_dispatch`, ...
    pub event: String,
    pub head_branch: Option<String>,
    pub head_sha: String,
    pub url: String,
    pub created_at: String,
    pub updated_at: String,
    pub started_at: Option<String>,
    pub attempt: u32,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WorkflowRunsListing {
    Ok {
        items: Vec<WorkflowRun>,
        account: String,
    },
    NotGithub,
    NoAccess {
        slug: String,
        accounts: Vec<AccountSummary>,
    },
}

#[derive(Debug, Deserialize)]
struct GhWorkflowRun {
    #[serde(rename = "databaseId")]
    database_id: u64,
    #[serde(rename = "displayTitle", default)]
    display_title: String,
    #[serde(rename = "name", default)]
    name: String,
    #[serde(rename = "workflowName", default)]
    workflow_name: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    conclusion: Option<String>,
    #[serde(default)]
    event: String,
    #[serde(rename = "headBranch", default)]
    head_branch: Option<String>,
    #[serde(rename = "headSha", default)]
    head_sha: String,
    #[serde(default)]
    url: String,
    #[serde(rename = "createdAt", default)]
    created_at: String,
    #[serde(rename = "updatedAt", default)]
    updated_at: String,
    #[serde(rename = "startedAt", default)]
    started_at: Option<String>,
    #[serde(default = "default_attempt")]
    attempt: u32,
}

fn default_attempt() -> u32 {
    1
}

fn normalize_optional_string(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn normalize_github_timestamp(value: Option<String>) -> Option<String> {
    normalize_optional_string(value).and_then(|value| {
        if value.starts_with("0001-01-01T00:00:00") {
            None
        } else {
            Some(value)
        }
    })
}

pub fn list_workflow_runs(repo_path: &Path, limit: u32) -> AppResult<WorkflowRunsListing> {
    let Some(slug) = github_owner_repo(repo_path)? else {
        return Ok(WorkflowRunsListing::NotGithub);
    };

    match try_with_account(repo_path, &slug, |token| {
        run_workflow_list(&slug, token, limit)
    })? {
        AccountOutcome::Ok { account, value } => Ok(WorkflowRunsListing::Ok {
            items: value,
            account,
        }),
        AccountOutcome::NoAccess { accounts } => {
            Ok(WorkflowRunsListing::NoAccess { slug, accounts })
        }
    }
}

fn run_workflow_list(slug: &str, token: &str, limit: u32) -> AppResult<Vec<WorkflowRun>> {
    let limit = limit.clamp(1, 200);
    let limit_s = limit.to_string();
    let output = cli_resolver::run("gh", |cmd| {
        cmd.env("GH_TOKEN", token).env("GH_HOST", GH_HOST).args([
            "run",
            "list",
            "--repo",
            slug,
            "--limit",
            &limit_s,
            "--json",
            "databaseId,displayTitle,name,workflowName,status,conclusion,event,\
             headBranch,headSha,url,createdAt,updatedAt,startedAt,attempt",
        ]);
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

    let raw: Vec<GhWorkflowRun> = serde_json::from_slice(&output.stdout)
        .map_err(|e| AppError::Other(format!("failed to parse gh output: {e}")))?;

    Ok(raw
        .into_iter()
        .map(|r| {
            let workflow_name = if !r.workflow_name.is_empty() {
                r.workflow_name
            } else {
                r.name
            };
            WorkflowRun {
                id: r.database_id,
                display_title: r.display_title,
                workflow_name,
                status: r.status,
                conclusion: normalize_optional_string(r.conclusion),
                event: r.event,
                head_branch: r.head_branch.filter(|s| !s.is_empty()),
                head_sha: r.head_sha,
                url: r.url,
                created_at: r.created_at,
                updated_at: r.updated_at,
                started_at: normalize_github_timestamp(r.started_at),
                attempt: r.attempt,
            }
        })
        .collect())
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkflowJobStep {
    pub name: String,
    pub number: u32,
    pub status: String,
    pub conclusion: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkflowJob {
    pub id: u64,
    pub name: String,
    pub status: String,
    pub conclusion: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub url: String,
    pub steps: Vec<WorkflowJobStep>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkflowRunDetail {
    pub id: u64,
    pub display_title: String,
    pub workflow_name: String,
    pub status: String,
    pub conclusion: Option<String>,
    pub event: String,
    pub head_branch: Option<String>,
    pub head_sha: String,
    pub url: String,
    pub created_at: String,
    pub updated_at: String,
    pub started_at: Option<String>,
    pub attempt: u32,
    pub jobs: Vec<WorkflowJob>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WorkflowRunDetailListing {
    Ok {
        account: String,
        detail: WorkflowRunDetail,
    },
    NotGithub,
    NoAccess {
        slug: String,
        accounts: Vec<AccountSummary>,
    },
}

#[derive(Debug, Deserialize)]
struct GhWorkflowJobStep {
    #[serde(default)]
    name: String,
    #[serde(default)]
    number: u32,
    #[serde(default)]
    status: String,
    #[serde(default)]
    conclusion: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GhWorkflowJob {
    #[serde(rename = "databaseId", default)]
    database_id: u64,
    #[serde(default)]
    name: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    conclusion: Option<String>,
    #[serde(rename = "startedAt", default)]
    started_at: Option<String>,
    #[serde(rename = "completedAt", default)]
    completed_at: Option<String>,
    #[serde(default)]
    url: String,
    #[serde(default)]
    steps: Vec<GhWorkflowJobStep>,
}

#[derive(Debug, Deserialize)]
struct GhWorkflowRunDetail {
    #[serde(rename = "databaseId")]
    database_id: u64,
    #[serde(rename = "displayTitle", default)]
    display_title: String,
    #[serde(rename = "name", default)]
    name: String,
    #[serde(rename = "workflowName", default)]
    workflow_name: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    conclusion: Option<String>,
    #[serde(default)]
    event: String,
    #[serde(rename = "headBranch", default)]
    head_branch: Option<String>,
    #[serde(rename = "headSha", default)]
    head_sha: String,
    #[serde(default)]
    url: String,
    #[serde(rename = "createdAt", default)]
    created_at: String,
    #[serde(rename = "updatedAt", default)]
    updated_at: String,
    #[serde(rename = "startedAt", default)]
    started_at: Option<String>,
    #[serde(default = "default_attempt")]
    attempt: u32,
    #[serde(default)]
    jobs: Vec<GhWorkflowJob>,
}

pub fn get_workflow_run_detail(
    repo_path: &Path,
    run_id: u64,
) -> AppResult<WorkflowRunDetailListing> {
    let Some(slug) = github_owner_repo(repo_path)? else {
        return Ok(WorkflowRunDetailListing::NotGithub);
    };

    match try_with_account(repo_path, &slug, |token| {
        run_workflow_view(&slug, token, run_id)
    })? {
        AccountOutcome::Ok { account, value } => Ok(WorkflowRunDetailListing::Ok {
            account,
            detail: value,
        }),
        AccountOutcome::NoAccess { accounts } => {
            Ok(WorkflowRunDetailListing::NoAccess { slug, accounts })
        }
    }
}

fn run_workflow_view(slug: &str, token: &str, run_id: u64) -> AppResult<WorkflowRunDetail> {
    let id_s = run_id.to_string();
    let output = cli_resolver::run("gh", |cmd| {
        cmd.env("GH_TOKEN", token).env("GH_HOST", GH_HOST).args([
            "run",
            "view",
            &id_s,
            "--repo",
            slug,
            "--json",
            "databaseId,displayTitle,name,workflowName,status,conclusion,event,\
             headBranch,headSha,url,createdAt,updatedAt,startedAt,attempt,jobs",
        ]);
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

    let raw: GhWorkflowRunDetail = serde_json::from_slice(&output.stdout)
        .map_err(|e| AppError::Other(format!("failed to parse gh output: {e}")))?;

    let workflow_name = if !raw.workflow_name.is_empty() {
        raw.workflow_name
    } else {
        raw.name
    };
    let jobs = raw
        .jobs
        .into_iter()
        .map(|j| WorkflowJob {
            id: j.database_id,
            name: j.name,
            status: j.status,
            conclusion: normalize_optional_string(j.conclusion),
            started_at: normalize_github_timestamp(j.started_at),
            completed_at: normalize_github_timestamp(j.completed_at),
            url: j.url,
            steps: j
                .steps
                .into_iter()
                .map(|s| WorkflowJobStep {
                    name: s.name,
                    number: s.number,
                    status: s.status,
                    conclusion: normalize_optional_string(s.conclusion),
                })
                .collect(),
        })
        .collect();

    Ok(WorkflowRunDetail {
        id: raw.database_id,
        display_title: raw.display_title,
        workflow_name,
        status: raw.status,
        conclusion: normalize_optional_string(raw.conclusion),
        event: raw.event,
        head_branch: raw.head_branch.filter(|s| !s.is_empty()),
        head_sha: raw.head_sha,
        url: raw.url,
        created_at: raw.created_at,
        updated_at: raw.updated_at,
        started_at: normalize_github_timestamp(raw.started_at),
        attempt: raw.attempt,
        jobs,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_view() -> GhPullRequestView {
        GhPullRequestView {
            title: Some("Add prompt editing".to_string()),
            body: Some("Let users steer generated merge messages.".to_string()),
            ..Default::default()
        }
    }

    fn fake_pr_info() -> PullRequestInfo {
        PullRequestInfo {
            number: 42,
            title: "refactor(ui): separate context submenu affordance".to_string(),
            state: "OPEN".to_string(),
            author: "jtf-ian".to_string(),
            head_branch: "context-refactor".to_string(),
            base_branch: "main".to_string(),
            url: "https://github.com/im-ian/acorn/pull/42".to_string(),
            updated_at: "2026-06-22T00:00:00Z".to_string(),
            closed_at: None,
            merged_at: None,
            is_draft: false,
            checks: None,
            labels: vec![PullRequestLabel {
                name: "frontend".to_string(),
                color: "a2eeef".to_string(),
            }],
        }
    }

    #[test]
    fn pr_list_payload_preserves_completion_timestamps() {
        let raw: GhPullRequest = serde_json::from_str(
            r##"{
                "number": 42,
                "title": "Complete lifecycle work",
                "state": "MERGED",
                "author": {"login": "jtf-ian"},
                "headRefName": "feat/lifecycle",
                "baseRefName": "main",
                "url": "https://github.com/im-ian/acorn/pull/42",
                "updatedAt": "2026-07-10T01:00:00Z",
                "closedAt": "2026-07-10T00:59:00Z",
                "mergedAt": "2026-07-10T00:58:00Z",
                "isDraft": false,
                "labels": []
            }"##,
        )
        .expect("PR list payload should parse");

        let pr = pull_request_info_from_gh(raw);

        assert_eq!(pr.closed_at.as_deref(), Some("2026-07-10T00:59:00Z"));
        assert_eq!(pr.merged_at.as_deref(), Some("2026-07-10T00:58:00Z"));
    }

    #[test]
    fn plain_text_pr_search_matches_partial_title_terms() {
        let pr = fake_pr_info();
        let terms = plain_text_pr_search_terms("refac").expect("plain text terms");

        assert!(pull_request_matches_plain_text_terms(&pr, &terms));
    }

    #[test]
    fn plain_text_pr_search_matches_author_branch_and_label_terms() {
        let pr = fake_pr_info();

        for query in ["jtf", "context-refac", "front"] {
            let terms = plain_text_pr_search_terms(query).expect("plain text terms");
            assert!(
                pull_request_matches_plain_text_terms(&pr, &terms),
                "{query} should match"
            );
        }

        let terms = plain_text_pr_search_terms("backend").expect("plain text terms");
        assert!(!pull_request_matches_plain_text_terms(&pr, &terms));
    }

    #[test]
    fn plain_text_pr_search_keeps_advanced_queries_on_github_search() {
        assert!(plain_text_pr_search_terms("label:fix").is_none());
        assert!(plain_text_pr_search_terms("\"exact title\"").is_none());
        assert!(plain_text_pr_search_terms("ui").is_none());
        assert_eq!(
            plain_text_pr_search_terms("  REFAC  "),
            Some(vec!["refac".to_string()])
        );
    }

    #[test]
    fn commit_message_prompt_uses_custom_user_prompt() {
        let prompt = build_commit_message_prompt(
            MergeMethod::Squash,
            "Write the title and comment in Korean.",
            &fake_view(),
            "diff --git a/src/app.tsx b/src/app.tsx",
        );

        assert!(prompt
            .contains("Style and content instructions:\nWrite the title and comment in Korean."));
        assert!(prompt.contains("Return only the generated commit message text."));
        assert!(prompt.contains("Do not mention or summarize the prompt"));
        assert!(prompt.contains("labels such as \"Title:\" / \"Comment:\""));
        assert!(prompt.contains("PR title: Add prompt editing"));
        assert!(prompt.contains("Diff:\ndiff --git"));
    }

    #[test]
    fn commit_message_prompt_falls_back_when_custom_prompt_is_blank() {
        let prompt = build_commit_message_prompt(
            MergeMethod::Merge,
            "  ",
            &fake_view(),
            "diff --git a/src/app.tsx b/src/app.tsx",
        );

        assert!(prompt.contains("Write a merge commit message."));
    }

    #[test]
    fn github_zero_timestamps_are_treated_as_absent() {
        assert_eq!(normalize_github_timestamp(None), None);
        assert_eq!(normalize_github_timestamp(Some("".to_string())), None);
        assert_eq!(
            normalize_github_timestamp(Some("0001-01-01T00:00:00Z".to_string())),
            None
        );
        assert_eq!(
            normalize_github_timestamp(Some("2026-05-27T02:42:28Z".to_string())),
            Some("2026-05-27T02:42:28Z".to_string())
        );
    }

    #[test]
    fn issue_comment_id_is_parsed_from_web_url_fragment() {
        assert_eq!(
            comment_id_from_url(Some(
                "https://github.com/acme/widgets/issues/7#issuecomment-12345"
            )),
            Some(12345)
        );
        assert_eq!(
            comment_id_from_url(Some("https://github.com/acme/widgets/issues/7")),
            None
        );
        assert_eq!(comment_id_from_url(Some("not-a-url#comment-12345")), None);
        assert_eq!(comment_id_from_url(None), None);
    }

    #[test]
    fn commit_login_query_uses_graphql_variables() {
        let query = build_commit_login_query(2);

        assert!(query.contains("$owner:String!"));
        assert!(query.contains("$name:String!"));
        assert!(query.contains("$oid0:GitObjectID!"));
        assert!(query.contains("repository(owner:$owner,name:$name)"));
        assert!(query.contains("c0:object(oid:$oid0)"));
        assert!(query.contains("c1:object(oid:$oid1)"));
        assert!(!query.contains("acme"));
        assert!(!query.contains("0123456789abcdef0123456789abcdef01234567"));
    }

    #[test]
    fn commit_login_cache_evicts_oldest_entry_at_capacity() {
        let mut cache = CommitLoginCache::with_capacity(2);
        let first = ("acme/widgets".to_string(), "1".repeat(40));
        let second = ("acme/widgets".to_string(), "2".repeat(40));
        let third = ("acme/widgets".to_string(), "3".repeat(40));

        cache.insert(first.clone(), Some("alice".to_string()));
        cache.insert(second.clone(), Some("bob".to_string()));
        cache.insert(third.clone(), Some("carol".to_string()));

        assert_eq!(cache.len(), 2);
        assert_eq!(cache.get(&first), None);
        assert_eq!(cache.get(&second), Some(&Some("bob".to_string())));
        assert_eq!(cache.get(&third), Some(&Some("carol".to_string())));
    }

    #[test]
    fn commit_login_cache_update_does_not_consume_capacity() {
        let mut cache = CommitLoginCache::with_capacity(2);
        let first = ("acme/widgets".to_string(), "1".repeat(40));
        let second = ("acme/widgets".to_string(), "2".repeat(40));

        cache.insert(first.clone(), Some("alice".to_string()));
        cache.insert(second.clone(), Some("bob".to_string()));
        cache.insert(first.clone(), Some("alice-updated".to_string()));

        assert_eq!(cache.len(), 2);
        assert_eq!(cache.get(&first), Some(&Some("alice-updated".to_string())));
        assert_eq!(cache.get(&second), Some(&Some("bob".to_string())));
    }

    #[test]
    fn resolution_cache_removes_expired_entries_on_read() {
        let mut cache = ResolutionCache::with_capacity(2);
        let repo = PathBuf::from("/tmp/expired-worktree");
        let expired_at = Instant::now()
            .checked_sub(RESOLUTION_TTL)
            .expect("resolution TTL should fit before now");
        cache.insert_at(repo.clone(), "alice".to_string(), expired_at);

        assert!(cache.get(&repo).is_none());
        assert_eq!(cache.len(), 0);
    }

    #[test]
    fn resolution_cache_evicts_oldest_fresh_repo_at_capacity() {
        let mut cache = ResolutionCache::with_capacity(2);
        let now = Instant::now();
        let first = PathBuf::from("/tmp/first-worktree");
        let second = PathBuf::from("/tmp/second-worktree");
        let third = PathBuf::from("/tmp/third-worktree");

        cache.insert_at(
            first.clone(),
            "alice".to_string(),
            now.checked_sub(Duration::from_secs(2)).unwrap(),
        );
        cache.insert_at(
            second.clone(),
            "bob".to_string(),
            now.checked_sub(Duration::from_secs(1)).unwrap(),
        );
        cache.insert_at(third.clone(), "carol".to_string(), now);

        assert_eq!(cache.len(), 2);
        assert!(cache.get(&first).is_none());
        assert_eq!(
            cache.get(&second).map(|entry| entry.login),
            Some("bob".into())
        );
        assert_eq!(
            cache.get(&third).map(|entry| entry.login),
            Some("carol".into())
        );
    }

    #[test]
    fn commit_login_input_validation_rejects_graphql_fragments() {
        assert_eq!(
            validate_github_slug("acme/widgets").unwrap(),
            ("acme", "widgets")
        );
        assert!(validate_github_slug("acme/widgets.rs").is_ok());
        assert!(validate_github_slug("acme\"/widgets").is_err());
        assert!(validate_github_slug("acme/widgets\") { viewer { login } }").is_err());
        assert!(validate_github_slug("acme/widgets\nnext").is_err());

        assert!(validate_commit_oid("0123456789abcdef0123456789ABCDEF01234567").is_ok());
        assert!(validate_commit_oid("0123456789abcdef0123456789abcdef0123456").is_err());
        assert!(validate_commit_oid("0123456789abcdef0123456789abcdef0123456\"").is_err());
        assert!(validate_commit_oid("0123456789abcdef0123456789abcdef0123456g").is_err());
    }

    #[test]
    fn issue_comments_accept_count_or_comment_array() {
        let with_array: GhIssue = serde_json::from_str(
            r##"{
                "number": 1,
                "title": "Track issues",
                "state": "OPEN",
                "url": "https://github.com/acme/widgets/issues/1",
                "createdAt": "2026-06-01T00:00:00Z",
                "updatedAt": "2026-06-02T00:00:00Z",
                "comments": [{"id": "1"}, {"id": "2"}],
                "labels": [{"name": "bug", "color": "d73a4a"}]
            }"##,
        )
        .expect("issue with comment array should parse");
        assert_eq!(with_array.comments.count(), 2);

        let with_count: GhIssue = serde_json::from_str(
            r##"{
                "number": 2,
                "title": "Track issue counts",
                "state": "CLOSED",
                "url": "https://github.com/acme/widgets/issues/2",
                "createdAt": "2026-06-01T00:00:00Z",
                "updatedAt": "2026-06-02T00:00:00Z",
                "comments": 4,
                "labels": []
            }"##,
        )
        .expect("issue with comment count should parse");
        assert_eq!(with_count.comments.count(), 4);
    }

    #[test]
    fn issue_view_builds_detail_with_comments_and_metadata() {
        let view: GhIssueView = serde_json::from_str(
            r##"{
                "number": 7,
                "title": "Render issue detail",
                "body": "Issue body",
                "state": "CLOSED",
                "author": { "login": "alice" },
                "url": "https://github.com/acme/widgets/issues/7",
                "createdAt": "2026-06-01T00:00:00Z",
                "updatedAt": "2026-06-02T00:00:00Z",
                "stateReason": "COMPLETED",
                "labels": [{ "name": "enhancement", "color": "a2eeef" }],
                "comments": [
                    {
                        "author": { "login": "bob" },
                        "body": "Looks good",
                        "createdAt": "2026-06-02T01:00:00Z",
                        "url": "https://github.com/acme/widgets/issues/7#issuecomment-1"
                    }
                ],
                "assignees": [{ "login": "carol" }],
                "milestone": { "title": "v1" }
            }"##,
        )
        .expect("issue view should parse");

        let detail = build_issue_detail(7, view);
        assert_eq!(detail.number, 7);
        assert_eq!(detail.title, "Render issue detail");
        assert_eq!(detail.state_reason.as_deref(), Some("COMPLETED"));
        assert_eq!(detail.labels[0].name, "enhancement");
        assert_eq!(detail.comments[0].author, "bob");
        assert_eq!(detail.comments[0].id, Some(1));
        assert_eq!(detail.comments[0].body, "Looks good");
        assert_eq!(detail.assignees, vec!["carol".to_string()]);
        assert_eq!(detail.milestone.as_deref(), Some("v1"));
    }
}
