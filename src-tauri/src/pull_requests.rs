//! GitHub pull request listing via the `gh` CLI.
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

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::cli_resolver;
use crate::error::{AppError, AppResult};
use crate::git_ops::{github_owner_repo, DiffPayload};

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
    /// Aggregate of status checks on the head sha, mirroring the detail
    /// modal's badge logic. `None` when gh returned no rollup entries.
    pub checks: Option<ChecksSummary>,
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
    #[serde(rename = "isDraft", default)]
    is_draft: bool,
    #[serde(rename = "statusCheckRollup", default)]
    status_check_rollup: Option<Vec<GhCheck>>,
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

const GH_HOST: &str = "github.com";

/// How long a successful (login, repo) resolution stays trusted before we
/// re-probe access. Picked to be long enough to make periodic refreshes
/// cheap, short enough that a `gh auth login` for a new account becomes
/// usable without restarting the app.
const RESOLUTION_TTL: Duration = Duration::from_secs(10 * 60);

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

/// Per-repo cache of which gh login was last seen with access. Keyed by
/// the repo path the frontend sent (the worktree). The token itself is
/// re-fetched on every call — that's a fast local `gh auth token` spawn,
/// no network — so we never store secrets in this cache.
fn resolution_cache() -> &'static Mutex<HashMap<PathBuf, CachedResolution>> {
    use std::sync::OnceLock;
    static CELL: OnceLock<Mutex<HashMap<PathBuf, CachedResolution>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cached_login(repo_path: &Path) -> Option<CachedResolution> {
    let cache = resolution_cache().lock().ok()?;
    let entry = cache.get(repo_path)?;
    if entry.fresh() {
        Some(entry.clone())
    } else {
        None
    }
}

fn store_resolution(repo_path: &Path, login: &str) {
    let Ok(mut cache) = resolution_cache().lock() else {
        return;
    };
    cache.insert(
        repo_path.to_path_buf(),
        CachedResolution {
            login: login.to_string(),
            cached_at: Instant::now(),
        },
    );
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
                 isDraft,statusCheckRollup",
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

    Ok(raw
        .into_iter()
        .map(|pr| {
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
                is_draft: pr.is_draft,
                checks,
            }
        })
        .collect())
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
    pub author: String,
    pub body: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PullRequestReview {
    pub author: String,
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
    pub comments: Vec<PullRequestComment>,
    pub reviews: Vec<PullRequestReview>,
    pub checks: Vec<PullRequestCheck>,
    pub commits: Vec<PullRequestCommit>,
    pub diff: DiffPayload,
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

pub fn get_pull_request_detail(
    repo_path: &Path,
    number: u64,
) -> AppResult<PullRequestDetailListing> {
    let Some(slug) = github_owner_repo(repo_path)? else {
        return Ok(PullRequestDetailListing::NotGithub);
    };

    match try_with_account(repo_path, &slug, |token| {
        let view = run_pr_view(&slug, number, token)?;
        let diff_text = run_pr_diff(&slug, number, token)?;
        Ok((view, diff_text))
    })? {
        AccountOutcome::Ok {
            account,
            value: (view, diff_text),
        } => {
            let detail = build_detail(number, view, diff_text);
            Ok(PullRequestDetailListing::Ok { account, detail })
        }
        AccountOutcome::NoAccess { accounts } => {
            Ok(PullRequestDetailListing::NoAccess { slug, accounts })
        }
    }
}

fn build_detail(number: u64, view: GhPullRequestView, diff_text: String) -> PullRequestDetail {
    let comments = view
        .comments
        .unwrap_or_default()
        .into_iter()
        .map(|c| PullRequestComment {
            author: c.author.login.unwrap_or_else(|| "unknown".to_string()),
            body: c.body.unwrap_or_default(),
            created_at: c.created_at.unwrap_or_default(),
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
        .map(|r| PullRequestReview {
            author: r.author.login.unwrap_or_else(|| "unknown".to_string()),
            state: r.state.unwrap_or_default(),
            body: r.body.unwrap_or_default(),
            submitted_at: r.submitted_at.unwrap_or_default(),
        })
        .collect();

    let checks = view
        .status_check_rollup
        .unwrap_or_default()
        .into_iter()
        .map(|c| PullRequestCheck {
            name: c.name.unwrap_or_else(|| c.context.unwrap_or_default()),
            status: c.status.unwrap_or_default(),
            conclusion: c.conclusion,
            started_at: c.started_at,
            completed_at: c.completed_at,
            url: c.details_url.or(c.target_url),
            workflow_name: c.workflow_name,
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
        comments,
        reviews,
        checks,
        commits,
        diff: crate::unified_diff::parse_unified_diff(&diff_text),
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
                 mergeable,comments,reviews,statusCheckRollup,commits",
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

    serde_json::from_slice(&output.stdout)
        .map_err(|e| AppError::Other(format!("failed to parse gh output: {e}")))
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
    comments: Option<Vec<GhComment>>,
    reviews: Option<Vec<GhReview>>,
    #[serde(rename = "statusCheckRollup")]
    status_check_rollup: Option<Vec<GhCheck>>,
    commits: Option<Vec<GhCommit>>,
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
    #[serde(default)]
    author: GhAuthor,
    body: Option<String>,
    #[serde(rename = "createdAt")]
    created_at: Option<String>,
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

#[derive(Debug, Clone, Serialize)]
pub struct GeneratedCommitMessage {
    pub title: String,
    pub body: String,
}

/// Generate a squash/merge commit message by spawning a one-shot headless
/// AI CLI invocation. The provider command + args are resolved on the
/// frontend (so each provider's invocation conventions live in one place,
/// alongside the Settings UI) and passed in here. The CLI is expected to
/// follow the standard `stdin = prompt, stdout = response` convention —
/// `claude -p --output-format text`, `gemini -p`, `ollama run <model>`,
/// `llm -m <model>`, or any user-supplied custom command all fit.
pub fn generate_pr_commit_message(
    repo_path: &Path,
    number: u64,
    method: MergeMethod,
    command: String,
    args: Vec<String>,
) -> AppResult<GeneratedCommitMessage> {
    if command.trim().is_empty() {
        return Err(AppError::Other(
            "No AI command configured. Open Settings → Commit message AI to pick a provider."
                .to_string(),
        ));
    }

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
    let prompt = build_commit_message_prompt(method, &view, &diff);
    let raw = run_ai_oneshot(&command, &args, &prompt)?;
    Ok(parse_commit_message_response(&raw))
}

fn build_commit_message_prompt(
    method: MergeMethod,
    view: &GhPullRequestView,
    diff: &str,
) -> String {
    let style = match method {
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

    // Cap diff size — claude has a context budget and the user can refine
    // afterwards if details are missing.
    const MAX_DIFF_BYTES: usize = 12_000;
    let trimmed_diff = if diff.len() > MAX_DIFF_BYTES {
        format!("{}\n…(diff truncated)…", &diff[..MAX_DIFF_BYTES])
    } else {
        diff.to_string()
    };

    format!(
        "You are generating a git commit message for merging a pull request.\n\n\
         {style}\n\n\
         Output format (strict): the subject line ALONE on the first line, then a blank line, \
         then the body. Do not wrap the message in code fences or backticks. Do not add \
         commentary before or after.\n\n\
         PR title: {title}\n\
         PR description:\n{body}\n\n\
         Diff:\n{diff}\n",
        style = style,
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

/// Provider-agnostic one-shot CLI invocation: `command` is spawned with
/// `args`, the prompt is piped in via stdin, and stdout is returned. We
/// surface a typed error when the binary is missing so the frontend can
/// point the user at install instructions for the configured provider.
///
/// Routes through `cli_resolver` so user-installed AI CLIs (claude, gemini,
/// ollama, llm, …) resolve correctly even under the sanitized PATH that
/// macOS hands GUI-launched apps.
fn run_ai_oneshot(command: &str, args: &[String], prompt: &str) -> AppResult<String> {
    use std::io::Write;
    use std::process::Stdio;

    let resolved = cli_resolver::resolve(command).map_err(|_| {
        AppError::Other(format!(
            "`{command}` not found. Install the configured AI CLI or change the provider in Settings → Commit message AI."
        ))
    })?;
    let mut child = Command::new(&resolved)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                cli_resolver::invalidate(command);
                AppError::Other(format!(
                    "`{command}` not found. Install the configured AI CLI or change the provider in Settings → Commit message AI."
                ))
            } else {
                AppError::Other(format!("failed to invoke {command}: {e}"))
            }
        })?;

    {
        let stdin = child
            .stdin
            .as_mut()
            .ok_or_else(|| AppError::Other(format!("{command} stdin missing")))?;
        stdin
            .write_all(prompt.as_bytes())
            .map_err(|e| AppError::Other(format!("failed to write to {command}: {e}")))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| AppError::Other(format!("failed waiting for {command}: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let msg = if stderr.is_empty() {
            format!("{command} exited with status {}", output.status)
        } else {
            stderr
        };
        return Err(AppError::Other(msg));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}
