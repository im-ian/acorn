//! GitHub pull request and issue data.
//!
//! Authentication stays with the `gh` CLI so the user's existing logins
//! (keychain, OAuth device flow, multi-account) are reused with zero in-app
//! token storage. When `gh` is missing or unauthenticated we surface a typed
//! error so the frontend can show actionable guidance. API traffic itself
//! goes to GitHub over HTTPS so listing and detail views do not spawn `gh`
//! per call.
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
//! The picked token is sent as `Authorization: Bearer` on in-process HTTPS
//! calls, isolating the run to that identity even when a different
//! `gh auth status` account is active.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::cli_resolver;
use crate::error::{AppError, AppResult};
use crate::git_ops::{
    github_owner_repo, validate_commit_oid, validate_github_slug, DiffImages, DiffPayload,
};
use crate::github_api;

// GitHub diff images arrive as raw bytes, then grow again when encoded as a
// data URI and serialized into the renderer. Match the local diff-preview
// ceiling so a repository-controlled image cannot amplify an already-large
// response across each of those copies.
const MAX_REMOTE_DIFF_IMAGE_BYTES: usize = 8 * 1024 * 1024;

/// PR state filter accepted from the frontend.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PrStateFilter {
    Open,
    Closed,
    Merged,
    All,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IssueStateFilter {
    Open,
    Closed,
    All,
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
#[allow(dead_code)]
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

    #[cfg(test)]
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
        if let Some(token) = gh_token_for(&cached.login)? {
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

const PR_LIST_FIELDS: &str = r#"
number
title
state
isDraft
url
updatedAt
closedAt
mergedAt
author { login }
headRefName
baseRefName
labels(first: 20) { nodes { name color } }
commits(last: 1) {
  nodes {
    commit {
      statusCheckRollup {
        contexts(first: 100) {
          nodes {
            __typename
            ... on CheckRun {
              name
              status
              conclusion
              startedAt
              completedAt
              detailsUrl
              checkSuite { workflowRun { workflow { name } } }
            }
            ... on StatusContext {
              context
              state
              targetUrl
            }
          }
        }
      }
    }
  }
}
"#;

const ISSUE_LIST_FIELDS: &str = r#"
number
title
state
url
createdAt
updatedAt
stateReason
author { login }
comments { totalCount }
labels(first: 20) { nodes { name color } }
"#;

fn run_pr_list_page(
    slug: &str,
    token: &str,
    state: PrStateFilter,
    limit: u32,
    query: Option<&str>,
) -> AppResult<Vec<PullRequestInfo>> {
    let limit = limit.clamp(1, 1000);
    let (owner, name) = validate_github_slug(slug)?;
    let nodes = if let Some(search) = query {
        let search_query = pr_search_query(owner, name, state, search);
        graphql_search_nodes(token, &search_query, limit, "PullRequest")?
    } else {
        graphql_repo_connection(
            token,
            owner,
            name,
            "pullRequests",
            pr_list_states(state),
            limit,
            PR_LIST_FIELDS,
        )?
    };
    Ok(nodes.iter().map(pull_request_info_from_gql).collect())
}

fn pr_list_states(state: PrStateFilter) -> Option<&'static str> {
    match state {
        PrStateFilter::Open => Some("[OPEN]"),
        PrStateFilter::Closed => Some("[CLOSED]"),
        PrStateFilter::Merged => Some("[MERGED]"),
        PrStateFilter::All => None,
    }
}

fn pr_search_query(owner: &str, name: &str, state: PrStateFilter, search: &str) -> String {
    let mut query = format!("repo:{owner}/{name} is:pr");
    match state {
        PrStateFilter::Open => query.push_str(" is:open"),
        PrStateFilter::Closed => query.push_str(" is:closed"),
        PrStateFilter::Merged => query.push_str(" is:merged"),
        PrStateFilter::All => {}
    }
    let trimmed = search.trim();
    if !trimmed.is_empty() {
        query.push(' ');
        query.push_str(trimmed);
    }
    query
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

fn pull_request_info_from_gql(node: &Value) -> PullRequestInfo {
    let checks = flatten_status_check_rollup(node);
    PullRequestInfo {
        number: json_u64(node, "number"),
        title: json_str(node, "title"),
        state: json_str(node, "state"),
        author: json_login(node),
        head_branch: json_str(node, "headRefName"),
        base_branch: json_str(node, "baseRefName"),
        url: json_str(node, "url"),
        updated_at: json_str(node, "updatedAt"),
        closed_at: normalize_github_timestamp(json_opt_str(node, "closedAt")),
        merged_at: normalize_github_timestamp(json_opt_str(node, "mergedAt")),
        is_draft: json_bool(node, "isDraft", false),
        checks,
        labels: gql_labels(node),
    }
}

fn issue_info_from_gql(node: &Value) -> IssueInfo {
    IssueInfo {
        number: json_u64(node, "number"),
        title: json_str(node, "title"),
        state: json_str(node, "state"),
        author: json_login(node),
        url: json_str(node, "url"),
        created_at: json_str(node, "createdAt"),
        updated_at: json_str(node, "updatedAt"),
        state_reason: normalize_optional_string(json_opt_str(node, "stateReason")),
        comments: node
            .pointer("/comments/totalCount")
            .and_then(Value::as_u64)
            .unwrap_or(0) as u32,
        labels: gql_labels(node),
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
    let (owner, name) = validate_github_slug(slug)?;
    let nodes = if let Some(search) = query {
        let search_query = issue_search_query(owner, name, state, search);
        graphql_search_nodes(token, &search_query, limit, "Issue")?
    } else {
        graphql_repo_connection(
            token,
            owner,
            name,
            "issues",
            issue_list_states(state),
            limit,
            ISSUE_LIST_FIELDS,
        )?
    };
    Ok(nodes.iter().map(issue_info_from_gql).collect())
}

fn issue_list_states(state: IssueStateFilter) -> Option<&'static str> {
    match state {
        IssueStateFilter::Open => Some("[OPEN]"),
        IssueStateFilter::Closed => Some("[CLOSED]"),
        IssueStateFilter::All => None,
    }
}

fn issue_search_query(owner: &str, name: &str, state: IssueStateFilter, search: &str) -> String {
    let mut query = format!("repo:{owner}/{name} is:issue");
    match state {
        IssueStateFilter::Open => query.push_str(" is:open"),
        IssueStateFilter::Closed => query.push_str(" is:closed"),
        IssueStateFilter::All => {}
    }
    let trimmed = search.trim();
    if !trimmed.is_empty() {
        query.push(' ');
        query.push_str(trimmed);
    }
    query
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

const ISSUE_VIEW_QUERY: &str = r#"
query($owner:String!, $name:String!, $number:Int!) {
  repository(owner:$owner, name:$name) {
    issue(number:$number) {
      title
      body
      state
      url
      createdAt
      updatedAt
      stateReason
      author { login avatarUrl }
      labels(first: 50) { nodes { name color } }
      assignees(first: 20) { nodes { login } }
      milestone { title }
      comments(first: 100) {
        nodes {
          databaseId
          body
          createdAt
          url
          author { login avatarUrl }
        }
      }
    }
  }
}
"#;

fn run_issue_view(slug: &str, number: u64, token: &str) -> AppResult<GhIssueView> {
    let (owner, name) = validate_github_slug(slug)?;
    let value = github_api::graphql(
        token,
        ISSUE_VIEW_QUERY,
        json!({ "owner": owner, "name": name, "number": number as i64 }),
    )?;
    let Some(issue) = value.pointer("/data/repository/issue") else {
        return Err(AppError::Other(format!(
            "GitHub issue {number} was not found in {slug}"
        )));
    };
    if issue.is_null() {
        return Err(AppError::Other(format!(
            "GitHub issue {number} was not found in {slug}"
        )));
    }
    Ok(issue_view_from_gql(issue))
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

struct AccountProbe {
    login: String,
    token: Option<String>,
    has_access: bool,
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

    let probes: Vec<AppResult<AccountProbe>> = std::thread::scope(|scope| {
        let handles: Vec<_> = logins
            .iter()
            .map(|login| {
                let login = login.clone();
                let slug = slug.to_string();
                scope.spawn(move || {
                    let token = gh_token_for(&login).map_err(|error| {
                        AppError::Other(format!("failed to inspect gh account {login}: {error}"))
                    })?;
                    let has_access = match token.as_deref() {
                        Some(token) => account_can_access(&slug, token).map_err(|error| {
                            AppError::Other(format!("failed to probe gh account {login}: {error}"))
                        })?,
                        None => false,
                    };
                    Ok(AccountProbe {
                        login,
                        token,
                        has_access,
                    })
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|handle| {
                handle.join().unwrap_or_else(|_| {
                    Err(AppError::Other(
                        "GitHub account probe worker panicked".to_string(),
                    ))
                })
            })
            .collect()
    });

    finish_account_resolution(repo_path, probes)
}

fn finish_account_resolution(
    repo_path: &Path,
    probes: Vec<AppResult<AccountProbe>>,
) -> AppResult<AccountResolution> {
    let mut candidates: Vec<AccountSummary> = Vec::with_capacity(probes.len());
    let mut accessible: Vec<(String, String)> = Vec::new();
    let mut first_error = None;
    for probe in probes {
        match probe {
            Ok(probe) => {
                candidates.push(AccountSummary {
                    login: probe.login.clone(),
                    has_access: probe.has_access,
                });
                if probe.has_access {
                    if let Some(token) = probe.token {
                        accessible.push((probe.login, token));
                    }
                }
            }
            Err(error) => {
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
        }
    }

    if accessible.is_empty() {
        if let Some(error) = first_error {
            return Err(error);
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

fn gh_token_for(login: &str) -> AppResult<Option<String>> {
    let out = cli_resolver::run("gh", |cmd| {
        cmd.args(["auth", "token", "--user", login]);
    })?;
    if !out.status.success() {
        return Ok(None);
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        Ok(None)
    } else {
        Ok(Some(s))
    }
}

fn gh_token_for_required(login: &str) -> AppResult<String> {
    let login = login.trim();
    if login.is_empty() {
        return Err(AppError::Other("GitHub account is required.".to_string()));
    }
    gh_token_for(login)?
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

/// Cheap repo-access probe via `gh api repos/<slug> --silent`. A 401/403/404
/// response means this token cannot see the repository. Process failures,
/// rate limits, and server errors remain operational errors instead of being
/// presented as an account-access problem.
fn account_can_access(slug: &str, token: &str) -> AppResult<bool> {
    let response = github_api::request(token, Method::GET, &format!("repos/{slug}"), None, None)?;
    classify_account_access(
        slug,
        response.status,
        response.rate_limit_remaining,
        &response.body,
    )
}

fn classify_account_access(
    slug: &str,
    status: u16,
    rate_limit_remaining: Option<u32>,
    body: &[u8],
) -> AppResult<bool> {
    if (200..300).contains(&status) {
        return Ok(true);
    }

    let rate_limit_exhausted = rate_limit_remaining == Some(0);
    if matches!(status, 401 | 404) || status == 403 && !rate_limit_exhausted {
        return Ok(false);
    }

    Err(AppError::Other(format!(
        "GitHub access probe for {slug} failed: {}",
        github_api::error_message(status, body)
    )))
}

fn primary_email_for(token: &str) -> Option<String> {
    let user: Value = github_api::json(token, Method::GET, "user", None).ok()?;
    user.get("email")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|email| !email.is_empty() && *email != "null")
        .map(ToString::to_string)
}

fn git_user_email(repo_path: &Path) -> Option<String> {
    let out = cli_resolver::run("git", |command| {
        command
            .arg("-C")
            .arg(repo_path)
            .args(["config", "user.email"]);
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

const PR_VIEW_QUERY: &str = r#"
query($owner:String!, $name:String!, $number:Int!) {
  repository(owner:$owner, name:$name) {
    pullRequest(number:$number) {
      title
      body
      state
      isDraft
      url
      createdAt
      updatedAt
      mergedAt
      additions
      deletions
      changedFiles
      mergeable
      author { login avatarUrl }
      headRefName
      baseRefName
      labels(first: 50) { nodes { name color } }
      comments(first: 100) {
        nodes {
          databaseId
          body
          createdAt
          url
          author { login avatarUrl }
        }
      }
      reviews(first: 100) {
        nodes {
          body
          state
          submittedAt
          author { login avatarUrl }
        }
      }
      commits(first: 100) {
        nodes {
          commit {
            oid
            messageHeadline
            messageBody
            committedDate
            authors(first: 10) {
              nodes {
                name
                email
                user { login }
              }
            }
          }
        }
      }
      commitsForChecks: commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              contexts(first: 100) {
                nodes {
                  __typename
                  ... on CheckRun {
                    name
                    status
                    conclusion
                    startedAt
                    completedAt
                    detailsUrl
                    checkSuite { workflowRun { workflow { name } } }
                  }
                  ... on StatusContext {
                    context
                    state
                    targetUrl
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
"#;

fn run_pr_view(slug: &str, number: u64, token: &str) -> AppResult<GhPullRequestView> {
    let (owner, name) = validate_github_slug(slug)?;
    let value = github_api::graphql(
        token,
        PR_VIEW_QUERY,
        json!({ "owner": owner, "name": name, "number": number as i64 }),
    )?;
    let Some(pr) = value.pointer("/data/repository/pullRequest") else {
        return Err(AppError::Other(format!(
            "GitHub pull request {number} was not found in {slug}"
        )));
    };
    if pr.is_null() {
        return Err(AppError::Other(format!(
            "GitHub pull request {number} was not found in {slug}"
        )));
    }
    Ok(pr_view_from_gql(pr))
}

fn run_pr_refs(slug: &str, number: u64, token: &str) -> AppResult<GhPullRequestRefs> {
    #[derive(Deserialize)]
    struct RestPullRefs {
        head: RestRef,
        base: RestRef,
    }
    #[derive(Deserialize)]
    struct RestRef {
        #[serde(rename = "ref")]
        name: String,
    }

    let pull: RestPullRefs = github_api::json(
        token,
        Method::GET,
        &format!("repos/{slug}/pulls/{number}"),
        None,
    )?;
    Ok(GhPullRequestRefs {
        head_ref_name: pull.head.name,
        base_ref_name: pull.base.name,
    })
}

#[derive(Debug, Default, Clone)]
struct PrActorAvatars {
    by_login: HashMap<String, String>,
}

pub fn get_pull_request_commit_diff(repo_path: &Path, sha: &str) -> AppResult<DiffPayload> {
    validate_commit_oid(sha)?;
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
    validate_commit_oid(sha)?;
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
        let mut variables = json!({ "owner": owner, "name": name });
        for (i, sha) in needed.iter().enumerate() {
            variables[format!("oid{i}")] = json!(sha);
        }
        let v = github_api::graphql(token, &query, variables)?;
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

    #[cfg(test)]
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
    crate::git_ops::validate_relative_git_path(path)?;
    let encoded_path = encode_github_api_path(path);
    let encoded_ref = encode_github_api_segment(git_ref);
    let endpoint = format!("repos/{slug}/contents/{encoded_path}?ref={encoded_ref}");
    let bytes = github_api::raw(token, &endpoint, "application/vnd.github.raw")?;
    enforce_raw_blob_size(bytes, MAX_REMOTE_DIFF_IMAGE_BYTES)
}

fn enforce_raw_blob_size(bytes: Vec<u8>, max_bytes: usize) -> AppResult<Vec<u8>> {
    if bytes.len() > max_bytes {
        return Err(AppError::Other(format!(
            "remote diff image byte limit exceeded (maximum {max_bytes})"
        )));
    }
    Ok(bytes)
}

fn run_commit_diff(slug: &str, sha: &str, token: &str) -> AppResult<String> {
    validate_commit_oid(sha)?;
    let endpoint = format!("repos/{slug}/commits/{sha}");
    let bytes = github_api::raw(token, &endpoint, "application/vnd.github.diff")?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn encode_github_api_path(path: &str) -> String {
    percent_encode_github_api_value(path, true)
}

fn encode_github_api_segment(segment: &str) -> String {
    percent_encode_github_api_value(segment, false)
}

fn percent_encode_github_api_value(value: &str, preserve_slashes: bool) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(byte, b'-' | b'.' | b'_' | b'~')
            || (preserve_slashes && byte == b'/')
        {
            encoded.push(char::from(byte));
        } else {
            encoded.push('%');
            encoded.push(char::from(HEX[usize::from(byte >> 4)]));
            encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
        }
    }
    encoded
}

fn graphql_repo_connection(
    token: &str,
    owner: &str,
    name: &str,
    field: &str,
    states: Option<&str>,
    limit: u32,
    node_fields: &str,
) -> AppResult<Vec<Value>> {
    let states_arg = match states {
        Some(states) => format!("states: {states}, "),
        None => String::new(),
    };
    let query = format!(
        "query($owner:String!, $name:String!, $first:Int!, $after:String) {{\
           repository(owner:$owner, name:$name) {{\
             {field}({states_arg}first:$first, after:$after, orderBy:{{field:CREATED_AT, direction:DESC}}) {{\
               pageInfo {{ hasNextPage endCursor }}\
               nodes {{ {node_fields} }}\
             }}\
           }}\
         }}"
    );
    let mut nodes = Vec::new();
    let mut after: Option<String> = None;
    while nodes.len() < limit as usize {
        let remaining = (limit as usize) - nodes.len();
        let first = remaining.min(100) as i64;
        let mut variables = json!({
            "owner": owner,
            "name": name,
            "first": first,
            "after": Value::Null,
        });
        if let Some(cursor) = &after {
            variables["after"] = json!(cursor);
        }
        let value = github_api::graphql(token, &query, variables)?;
        let connection = value
            .pointer(&format!("/data/repository/{field}"))
            .cloned()
            .unwrap_or(Value::Null);
        let page_nodes = connection
            .get("nodes")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let page_len = page_nodes.len();
        nodes.extend(page_nodes.into_iter().filter(|node| !node.is_null()));
        let has_next = connection
            .pointer("/pageInfo/hasNextPage")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        after = connection
            .pointer("/pageInfo/endCursor")
            .and_then(Value::as_str)
            .map(ToString::to_string);
        if !has_next || page_len == 0 {
            break;
        }
    }
    nodes.truncate(limit as usize);
    Ok(nodes)
}

fn graphql_search_nodes(
    token: &str,
    search_query: &str,
    limit: u32,
    type_name: &str,
) -> AppResult<Vec<Value>> {
    let query = format!(
        "query($q:String!, $first:Int!, $after:String) {{\
           search(query:$q, type:ISSUE, first:$first, after:$after) {{\
             pageInfo {{ hasNextPage endCursor }}\
             nodes {{ ... on {type_name} {{ {fields} }} }}\
           }}\
         }}",
        fields = if type_name == "PullRequest" {
            PR_LIST_FIELDS
        } else {
            ISSUE_LIST_FIELDS
        }
    );
    let mut nodes = Vec::new();
    let mut after: Option<String> = None;
    while nodes.len() < limit as usize {
        let remaining = (limit as usize) - nodes.len();
        let first = remaining.min(100) as i64;
        let mut variables = json!({
            "q": search_query,
            "first": first,
            "after": Value::Null,
        });
        if let Some(cursor) = &after {
            variables["after"] = json!(cursor);
        }
        let value = github_api::graphql(token, &query, variables)?;
        let connection = value
            .pointer("/data/search")
            .cloned()
            .unwrap_or(Value::Null);
        let page_nodes = connection
            .get("nodes")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let page_len = page_nodes.len();
        nodes.extend(page_nodes.into_iter().filter(|node| !node.is_null()));
        let has_next = connection
            .pointer("/pageInfo/hasNextPage")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        after = connection
            .pointer("/pageInfo/endCursor")
            .and_then(Value::as_str)
            .map(ToString::to_string);
        if !has_next || page_len == 0 {
            break;
        }
    }
    nodes.truncate(limit as usize);
    Ok(nodes)
}

fn json_str(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn json_opt_str(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|text| !text.is_empty())
}

fn json_u64(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn json_bool(value: &Value, key: &str, default: bool) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(default)
}

fn json_login(value: &Value) -> String {
    value
        .pointer("/author/login")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string()
}

fn gql_labels(value: &Value) -> Vec<PullRequestLabel> {
    value
        .pointer("/labels/nodes")
        .and_then(Value::as_array)
        .map(|nodes| {
            nodes
                .iter()
                .map(|node| PullRequestLabel {
                    name: json_str(node, "name"),
                    color: json_str(node, "color"),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn gql_author(value: &Value) -> GhAuthor {
    GhAuthor {
        login: value
            .pointer("/author/login")
            .and_then(Value::as_str)
            .map(ToString::to_string),
    }
}

fn collect_actor_avatar(map: &mut HashMap<String, String>, node: &Value) {
    let Some(login) = node.pointer("/author/login").and_then(Value::as_str) else {
        return;
    };
    let Some(url) = node.pointer("/author/avatarUrl").and_then(Value::as_str) else {
        return;
    };
    if !login.is_empty() && !url.is_empty() {
        map.insert(login.to_string(), url.to_string());
    }
}

fn flatten_status_check_rollup(node: &Value) -> Option<ChecksSummary> {
    let checks = status_checks_from_gql(node);
    if checks.is_empty() {
        None
    } else {
        Some(summarize_checks(&checks))
    }
}

fn status_checks_from_gql(node: &Value) -> Vec<GhCheck> {
    let contexts = node
        .pointer("/commits/nodes/0/commit/statusCheckRollup/contexts/nodes")
        .or_else(|| {
            node.pointer("/commitsForChecks/nodes/0/commit/statusCheckRollup/contexts/nodes")
        })
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    contexts.iter().filter_map(gh_check_from_gql).collect()
}

fn gh_check_from_gql(node: &Value) -> Option<GhCheck> {
    match node.get("__typename").and_then(Value::as_str) {
        Some("CheckRun") => Some(GhCheck {
            name: json_opt_str(node, "name"),
            context: None,
            status: json_opt_str(node, "status"),
            conclusion: json_opt_str(node, "conclusion"),
            started_at: json_opt_str(node, "startedAt"),
            completed_at: json_opt_str(node, "completedAt"),
            details_url: json_opt_str(node, "detailsUrl"),
            target_url: None,
            workflow_name: node
                .pointer("/checkSuite/workflowRun/workflow/name")
                .and_then(Value::as_str)
                .map(ToString::to_string),
        }),
        Some("StatusContext") => {
            let state = json_str(node, "state");
            let (status, conclusion) = status_context_state(&state);
            Some(GhCheck {
                name: None,
                context: json_opt_str(node, "context"),
                status: Some(status),
                conclusion,
                started_at: None,
                completed_at: None,
                details_url: None,
                target_url: json_opt_str(node, "targetUrl"),
                workflow_name: None,
            })
        }
        _ => None,
    }
}

fn status_context_state(state: &str) -> (String, Option<String>) {
    match state.to_ascii_uppercase().as_str() {
        "SUCCESS" => ("COMPLETED".into(), Some("SUCCESS".into())),
        "FAILURE" | "ERROR" => ("COMPLETED".into(), Some("FAILURE".into())),
        _ => ("PENDING".into(), None),
    }
}

fn pr_view_from_gql(node: &Value) -> GhPullRequestView {
    let comments = node
        .pointer("/comments/nodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let reviews = node
        .pointer("/reviews/nodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut avatars = PrActorAvatars::default();
    collect_actor_avatar(&mut avatars.by_login, node);
    for comment in &comments {
        collect_actor_avatar(&mut avatars.by_login, comment);
    }
    for review in &reviews {
        collect_actor_avatar(&mut avatars.by_login, review);
    }

    GhPullRequestView {
        title: json_opt_str(node, "title"),
        body: node
            .get("body")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        state: json_opt_str(node, "state"),
        is_draft: node.get("isDraft").and_then(Value::as_bool),
        author: Some(gql_author(node)),
        head_ref_name: json_opt_str(node, "headRefName"),
        base_ref_name: json_opt_str(node, "baseRefName"),
        url: json_opt_str(node, "url"),
        created_at: json_opt_str(node, "createdAt"),
        updated_at: json_opt_str(node, "updatedAt"),
        merged_at: json_opt_str(node, "mergedAt"),
        additions: node.get("additions").and_then(Value::as_u64),
        deletions: node.get("deletions").and_then(Value::as_u64),
        changed_files: node.get("changedFiles").and_then(Value::as_u64),
        mergeable: json_opt_str(node, "mergeable"),
        labels: node
            .pointer("/labels/nodes")
            .and_then(Value::as_array)
            .map(|nodes| {
                nodes
                    .iter()
                    .map(|label| GhLabel {
                        name: json_str(label, "name"),
                        color: json_str(label, "color"),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        comments: Some(
            comments
                .iter()
                .map(|comment| GhComment {
                    database_id: comment.get("databaseId").and_then(Value::as_u64),
                    author: gql_author(comment),
                    body: comment
                        .get("body")
                        .and_then(Value::as_str)
                        .map(ToString::to_string),
                    created_at: comment
                        .get("createdAt")
                        .and_then(Value::as_str)
                        .map(ToString::to_string),
                    url: comment
                        .get("url")
                        .and_then(Value::as_str)
                        .map(ToString::to_string),
                })
                .collect(),
        ),
        reviews: Some(
            reviews
                .iter()
                .map(|review| GhReview {
                    author: gql_author(review),
                    state: json_opt_str(review, "state"),
                    body: review
                        .get("body")
                        .and_then(Value::as_str)
                        .map(ToString::to_string),
                    submitted_at: review
                        .get("submittedAt")
                        .and_then(Value::as_str)
                        .map(ToString::to_string),
                })
                .collect(),
        ),
        status_check_rollup: Some(status_checks_from_gql(node)),
        commits: Some(
            node.pointer("/commits/nodes")
                .and_then(Value::as_array)
                .map(|nodes| {
                    nodes
                        .iter()
                        .filter_map(|entry| entry.get("commit"))
                        .map(|commit| GhCommit {
                            oid: json_opt_str(commit, "oid"),
                            message_headline: json_opt_str(commit, "messageHeadline"),
                            message_body: commit
                                .get("messageBody")
                                .and_then(Value::as_str)
                                .map(ToString::to_string),
                            committed_date: json_opt_str(commit, "committedDate"),
                            authors: commit
                                .pointer("/authors/nodes")
                                .and_then(Value::as_array)
                                .map(|authors| {
                                    authors
                                        .iter()
                                        .map(|author| GhCommitAuthor {
                                            name: json_opt_str(author, "name"),
                                            email: json_opt_str(author, "email"),
                                            login: author
                                                .pointer("/user/login")
                                                .and_then(Value::as_str)
                                                .map(ToString::to_string),
                                        })
                                        .collect()
                                }),
                        })
                        .collect()
                })
                .unwrap_or_default(),
        ),
        actor_avatars: Some(avatars),
    }
}

fn issue_view_from_gql(node: &Value) -> GhIssueView {
    let comments = node
        .pointer("/comments/nodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut avatars = PrActorAvatars::default();
    collect_actor_avatar(&mut avatars.by_login, node);
    for comment in &comments {
        collect_actor_avatar(&mut avatars.by_login, comment);
    }
    GhIssueView {
        title: json_opt_str(node, "title"),
        body: node
            .get("body")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        state: json_opt_str(node, "state"),
        author: Some(gql_author(node)),
        url: json_opt_str(node, "url"),
        created_at: json_opt_str(node, "createdAt"),
        updated_at: json_opt_str(node, "updatedAt"),
        state_reason: json_opt_str(node, "stateReason"),
        labels: node
            .pointer("/labels/nodes")
            .and_then(Value::as_array)
            .map(|nodes| {
                nodes
                    .iter()
                    .map(|label| GhLabel {
                        name: json_str(label, "name"),
                        color: json_str(label, "color"),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        comments: Some(
            comments
                .iter()
                .map(|comment| GhIssueComment {
                    database_id: comment.get("databaseId").and_then(Value::as_u64),
                    author: gql_author(comment),
                    body: comment
                        .get("body")
                        .and_then(Value::as_str)
                        .map(ToString::to_string),
                    created_at: comment
                        .get("createdAt")
                        .and_then(Value::as_str)
                        .map(ToString::to_string),
                    url: comment
                        .get("url")
                        .and_then(Value::as_str)
                        .map(ToString::to_string),
                })
                .collect(),
        ),
        assignees: node
            .pointer("/assignees/nodes")
            .and_then(Value::as_array)
            .map(|nodes| nodes.iter().map(gql_author).collect()),
        milestone: node.get("milestone").and_then(|milestone| {
            if milestone.is_null() {
                None
            } else {
                Some(GhMilestone {
                    title: json_opt_str(milestone, "title"),
                })
            }
        }),
        actor_avatars: Some(avatars),
    }
}

fn run_pr_diff(slug: &str, number: u64, token: &str) -> AppResult<String> {
    let endpoint = format!("repos/{slug}/pulls/{number}");
    let bytes = github_api::raw(token, &endpoint, "application/vnd.github.diff")?;
    // Lossy decode keeps things working for the rare diff containing invalid
    // bytes (binary files, mojibake) — those segments are non-renderable
    // anyway and the parser ultimately routes them into the binary-placeholder
    // branch.
    Ok(String::from_utf8_lossy(&bytes).into_owned())
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
// PR mutations: merge / lifecycle state / AI commit message
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MergeMethod {
    Squash,
    Merge,
    Rebase,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PullRequestStateChange {
    Ready,
    Draft,
    Reopen,
}

impl MergeMethod {
    fn as_api_value(self) -> &'static str {
        match self {
            MergeMethod::Squash => "squash",
            MergeMethod::Merge => "merge",
            MergeMethod::Rebase => "rebase",
        }
    }

    /// Squash and merge commits accept a title/body override. Rebase merges
    /// replay individual commits, so message overrides are not applicable.
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

pub fn change_pull_request_state(
    repo_path: &Path,
    number: u64,
    change: PullRequestStateChange,
) -> AppResult<()> {
    let Some(slug) = github_owner_repo(repo_path)? else {
        return Err(AppError::Other(
            "Origin remote is not a GitHub repository.".to_string(),
        ));
    };

    match try_with_account(repo_path, &slug, |token| {
        run_pr_state_change(&slug, number, token, change)
    })? {
        AccountOutcome::Ok { value, .. } => Ok(value),
        AccountOutcome::NoAccess { .. } => Err(AppError::Other(
            "No logged-in gh account can change this PR's state.".to_string(),
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
    _admin: bool,
) -> AppResult<()> {
    let mut payload = json!({ "merge_method": method.as_api_value() });
    if method.accepts_message_override() {
        if let Some(title) = commit_title.filter(|title| !title.trim().is_empty()) {
            payload["commit_title"] = json!(title);
        }
        if let Some(body) = commit_body {
            payload["commit_message"] = json!(body);
        }
    }
    github_api::send_json(
        token,
        Method::PUT,
        &format!("repos/{slug}/pulls/{number}/merge"),
        &payload,
    )
}

fn run_pr_close(slug: &str, number: u64, token: &str) -> AppResult<()> {
    github_api::send_json(
        token,
        Method::PATCH,
        &format!("repos/{slug}/pulls/{number}"),
        &json!({ "state": "closed" }),
    )
}

fn pr_state_change_endpoint(
    slug: &str,
    number: u64,
    change: PullRequestStateChange,
) -> (Method, String, Option<Value>) {
    match change {
        PullRequestStateChange::Ready => (
            Method::POST,
            format!("repos/{slug}/pulls/{number}/ready_for_review"),
            None,
        ),
        PullRequestStateChange::Draft => (
            Method::POST,
            format!("repos/{slug}/pulls/{number}/convert_to_draft"),
            None,
        ),
        PullRequestStateChange::Reopen => (
            Method::PATCH,
            format!("repos/{slug}/pulls/{number}"),
            Some(json!({ "state": "open" })),
        ),
    }
}

fn run_pr_state_change(
    slug: &str,
    number: u64,
    token: &str,
    change: PullRequestStateChange,
) -> AppResult<()> {
    let (method, path, body) = pr_state_change_endpoint(slug, number, change);
    match body {
        Some(payload) => github_api::send_json(token, method, &path, &payload),
        None => github_api::send(token, method, &path, None),
    }
}

fn run_pr_edit_body(slug: &str, number: u64, token: &str, body: &str) -> AppResult<()> {
    github_api::send_json(
        token,
        Method::PATCH,
        &format!("repos/{slug}/pulls/{number}"),
        &json!({ "body": body }),
    )
}

fn run_gh_comment(
    _target: &str,
    slug: &str,
    number: u64,
    token: &str,
    body: &str,
) -> AppResult<()> {
    github_api::send_json(
        token,
        Method::POST,
        &format!("repos/{slug}/issues/{number}/comments"),
        &json!({ "body": body }),
    )
}

fn run_issue_comment_update(slug: &str, comment_id: u64, token: &str, body: &str) -> AppResult<()> {
    github_api::send_json(
        token,
        Method::PATCH,
        &format!("repos/{slug}/issues/comments/{comment_id}"),
        &json!({ "body": body }),
    )
}

fn run_issue_comment_delete(slug: &str, comment_id: u64, token: &str) -> AppResult<()> {
    github_api::send(
        token,
        Method::DELETE,
        &format!("repos/{slug}/issues/comments/{comment_id}"),
        None,
    )
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
    let raw = crate::ai::run_passive_text(&ai, &prompt, "Settings → Agents")?;
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
        let mut end = MAX_DIFF_BYTES;
        while !diff.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}\n…(diff truncated)…", &diff[..end])
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
    let mut items = Vec::new();
    let mut page = 1u32;
    while items.len() < limit as usize {
        let remaining = (limit as usize) - items.len();
        let per_page = remaining.min(100);
        let path = format!("repos/{slug}/actions/runs?per_page={per_page}&page={page}");
        let payload: RestWorkflowRuns = github_api::json(token, Method::GET, &path, None)?;
        let batch_len = payload.workflow_runs.len();
        for run in payload.workflow_runs {
            items.push(workflow_run_from_rest(run));
            if items.len() >= limit as usize {
                break;
            }
        }
        if batch_len < per_page {
            break;
        }
        page += 1;
    }
    Ok(items)
}

#[derive(Debug, Deserialize, Default)]
struct RestWorkflowRuns {
    #[serde(default)]
    workflow_runs: Vec<RestWorkflowRun>,
}

#[derive(Debug, Deserialize)]
struct RestWorkflowRun {
    id: u64,
    #[serde(default)]
    name: String,
    #[serde(default)]
    display_title: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    conclusion: Option<String>,
    #[serde(default)]
    event: String,
    #[serde(default)]
    head_branch: Option<String>,
    #[serde(default)]
    head_sha: String,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    updated_at: String,
    #[serde(default)]
    run_started_at: Option<String>,
    #[serde(default = "default_attempt")]
    run_attempt: u32,
}

fn workflow_run_from_rest(run: RestWorkflowRun) -> WorkflowRun {
    let workflow_name = if run.name.is_empty() {
        run.display_title.clone()
    } else {
        run.name
    };
    WorkflowRun {
        id: run.id,
        display_title: run.display_title,
        workflow_name,
        status: run.status,
        conclusion: normalize_optional_string(run.conclusion),
        event: run.event,
        head_branch: run.head_branch.filter(|s| !s.is_empty()),
        head_sha: run.head_sha,
        url: run.html_url,
        created_at: run.created_at,
        updated_at: run.updated_at,
        started_at: normalize_github_timestamp(run.run_started_at),
        attempt: run.run_attempt,
    }
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
    let run: RestWorkflowRun = github_api::json(
        token,
        Method::GET,
        &format!("repos/{slug}/actions/runs/{run_id}"),
        None,
    )?;
    let jobs_payload: RestWorkflowJobs = github_api::json(
        token,
        Method::GET,
        &format!("repos/{slug}/actions/runs/{run_id}/jobs?per_page=100"),
        None,
    )?;
    let summary = workflow_run_from_rest(run);
    Ok(WorkflowRunDetail {
        id: summary.id,
        display_title: summary.display_title,
        workflow_name: summary.workflow_name,
        status: summary.status,
        conclusion: summary.conclusion,
        event: summary.event,
        head_branch: summary.head_branch,
        head_sha: summary.head_sha,
        url: summary.url,
        created_at: summary.created_at,
        updated_at: summary.updated_at,
        started_at: summary.started_at,
        attempt: summary.attempt,
        jobs: jobs_payload
            .jobs
            .into_iter()
            .map(|job| WorkflowJob {
                id: job.id,
                name: job.name,
                status: job.status,
                conclusion: normalize_optional_string(job.conclusion),
                started_at: normalize_github_timestamp(job.started_at),
                completed_at: normalize_github_timestamp(job.completed_at),
                url: job.html_url,
                steps: job
                    .steps
                    .into_iter()
                    .map(|step| WorkflowJobStep {
                        name: step.name,
                        number: step.number,
                        status: step.status,
                        conclusion: normalize_optional_string(step.conclusion),
                    })
                    .collect(),
            })
            .collect(),
    })
}

#[derive(Debug, Deserialize, Default)]
struct RestWorkflowJobs {
    #[serde(default)]
    jobs: Vec<RestWorkflowJob>,
}

#[derive(Debug, Deserialize)]
struct RestWorkflowJob {
    id: u64,
    #[serde(default)]
    name: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    conclusion: Option<String>,
    #[serde(default)]
    started_at: Option<String>,
    #[serde(default)]
    completed_at: Option<String>,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    steps: Vec<RestWorkflowJobStep>,
}

#[derive(Debug, Deserialize)]
struct RestWorkflowJobStep {
    #[serde(default)]
    name: String,
    #[serde(default)]
    number: u32,
    #[serde(default)]
    status: String,
    #[serde(default)]
    conclusion: Option<String>,
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
    fn gql_pr_list_node_maps_checks_and_labels() {
        let node = json!({
            "number": 7,
            "title": "Fix login",
            "state": "OPEN",
            "isDraft": false,
            "url": "https://github.com/acme/widgets/pull/7",
            "updatedAt": "2026-07-10T01:00:00Z",
            "closedAt": null,
            "mergedAt": null,
            "author": { "login": "alice" },
            "headRefName": "fix-login",
            "baseRefName": "main",
            "labels": { "nodes": [{ "name": "bug", "color": "d73a4a" }] },
            "commits": {
                "nodes": [{
                    "commit": {
                        "statusCheckRollup": {
                            "contexts": {
                                "nodes": [
                                    {
                                        "__typename": "CheckRun",
                                        "name": "test",
                                        "status": "COMPLETED",
                                        "conclusion": "SUCCESS",
                                        "checkSuite": { "workflowRun": { "workflow": { "name": "CI" } } }
                                    },
                                    {
                                        "__typename": "StatusContext",
                                        "context": "deploy",
                                        "state": "PENDING"
                                    }
                                ]
                            }
                        }
                    }
                }]
            }
        });
        let pr = pull_request_info_from_gql(&node);
        assert_eq!(pr.number, 7);
        assert_eq!(pr.author, "alice");
        assert_eq!(pr.labels[0].name, "bug");
        let checks = pr.checks.expect("rollup");
        assert_eq!(checks.passed, 1);
        assert_eq!(checks.pending, 1);
        assert_eq!(checks.failed, 0);
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
    fn pr_state_changes_map_to_rest_endpoints() {
        let ready = pr_state_change_endpoint("acme/widgets", 42, PullRequestStateChange::Ready);
        assert_eq!(ready.0, Method::POST);
        assert_eq!(ready.1, "repos/acme/widgets/pulls/42/ready_for_review");
        assert!(ready.2.is_none());

        let draft = pr_state_change_endpoint("acme/widgets", 42, PullRequestStateChange::Draft);
        assert_eq!(draft.0, Method::POST);
        assert_eq!(draft.1, "repos/acme/widgets/pulls/42/convert_to_draft");

        let reopen = pr_state_change_endpoint("acme/widgets", 42, PullRequestStateChange::Reopen);
        assert_eq!(reopen.0, Method::PATCH);
        assert_eq!(reopen.1, "repos/acme/widgets/pulls/42");
        assert_eq!(reopen.2, Some(json!({ "state": "open" })));
    }

    #[test]
    fn pr_search_query_scopes_repo_and_state() {
        assert_eq!(
            pr_search_query("acme", "widgets", PrStateFilter::Open, "login form"),
            "repo:acme/widgets is:pr is:open login form"
        );
        assert_eq!(
            pr_search_query("acme", "widgets", PrStateFilter::Merged, ""),
            "repo:acme/widgets is:pr is:merged"
        );
    }

    #[test]
    fn status_context_states_map_to_check_rollup() {
        assert_eq!(
            status_context_state("SUCCESS"),
            ("COMPLETED".into(), Some("SUCCESS".into()))
        );
        assert_eq!(
            status_context_state("error"),
            ("COMPLETED".into(), Some("FAILURE".into()))
        );
        assert_eq!(status_context_state("PENDING"), ("PENDING".into(), None));
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
    fn commit_message_prompt_truncates_diff_on_a_utf8_boundary() {
        let diff = format!("{}é", "a".repeat(11_999));

        let prompt = build_commit_message_prompt(MergeMethod::Squash, "", &fake_view(), &diff);

        assert!(prompt.contains("\n…(diff truncated)…"));
        assert!(!prompt.contains('é'));
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
    fn account_resolution_does_not_report_no_access_when_a_probe_failed() {
        let result = finish_account_resolution(
            Path::new("/tmp/repo"),
            vec![
                Ok(AccountProbe {
                    login: "alice".to_string(),
                    token: Some("alice-token".to_string()),
                    has_access: false,
                }),
                Err(AppError::Other(
                    "failed to invoke gh: Permission denied".to_string(),
                )),
            ],
        );

        match result {
            Err(error) => assert!(error.to_string().contains("Permission denied")),
            Ok(_) => panic!("a failed probe must not become a no-access result"),
        }
    }

    #[test]
    fn account_resolution_uses_an_accessible_sibling_when_another_probe_failed() {
        let resolution = finish_account_resolution(
            Path::new("/tmp/repo"),
            vec![
                Err(AppError::Other("account probe failed".to_string())),
                Ok(AccountProbe {
                    login: "bob".to_string(),
                    token: Some("bob-token".to_string()),
                    has_access: true,
                }),
            ],
        )
        .expect("an accessible account should still service the request");

        let picked = resolution.picked.expect("accessible account");
        assert_eq!(picked.login, "bob");
        assert_eq!(picked.token, "bob-token");
    }

    #[test]
    fn account_access_classification_separates_denial_from_operational_failure() {
        let denied = classify_account_access(
            "acme/widgets",
            404,
            Some(4999),
            b"{\"message\":\"Not Found\"}",
        )
        .expect("404 is a normal inaccessible-account result");
        assert!(!denied);

        let forbidden = classify_account_access(
            "acme/widgets",
            403,
            Some(10),
            b"{\"message\":\"Resource not accessible\"}",
        )
        .expect("403 with remaining quota is inaccessible-account");
        assert!(!forbidden);

        let network_error = classify_account_access("acme/widgets", 502, None, b"")
            .expect_err("server errors must remain operational failures");
        assert!(network_error.to_string().contains("HTTP 502"));

        let rate_limit_error = classify_account_access(
            "acme/widgets",
            403,
            Some(0),
            br#"{"message":"API rate limit exceeded"}"#,
        )
        .expect_err("rate-limit failures must not become access denial");
        assert!(rate_limit_error.to_string().contains("rate limit exceeded"));
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
    fn github_api_path_encoding_separates_path_and_query_data() {
        assert_eq!(
            encode_github_api_path("images/a b?#%/한글.png"),
            "images/a%20b%3F%23%25/%ED%95%9C%EA%B8%80.png"
        );
        assert_eq!(encode_github_api_segment("app/name?#"), "app%2Fname%3F%23");
    }

    #[test]
    fn remote_diff_images_are_rejected_before_data_uri_amplification() {
        assert_eq!(
            enforce_raw_blob_size(vec![0; 4], 4).expect("at-limit image"),
            vec![0; 4]
        );
        let error = enforce_raw_blob_size(vec![0; 5], 4).expect_err("oversized image");
        assert!(error.to_string().contains("byte limit exceeded"));
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
