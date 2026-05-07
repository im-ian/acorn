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
    static CELL: OnceLock<Mutex<HashMap<PathBuf, CachedResolution>>> =
        OnceLock::new();
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
) -> AppResult<PullRequestListing> {
    let Some(slug) = github_owner_repo(repo_path)? else {
        return Ok(PullRequestListing::NotGithub);
    };

    // Fast path: a recently-resolved login for this repo. Skip every probe
    // and only pay for `gh auth token` (local) + `gh pr list` (network).
    if let Some(cached) = cached_login(repo_path) {
        if let Some(token) = gh_token_for(&cached.login) {
            match run_pr_list(&slug, &token, state, limit) {
                Ok(items) => {
                    return Ok(PullRequestListing::Ok {
                        items,
                        account: cached.login,
                    });
                }
                Err(_) => {
                    // Cached login lost access (token expired, removed from
                    // org, etc.) — drop the cache and fall through to a
                    // fresh resolution below.
                    invalidate_resolution(repo_path);
                }
            }
        } else {
            // Login disappeared from gh between calls — re-resolve.
            invalidate_resolution(repo_path);
        }
    }

    let resolution = resolve_account_for_repo(repo_path, &slug)?;
    let Some(picked) = resolution.picked else {
        return Ok(PullRequestListing::NoAccess {
            slug,
            accounts: resolution.candidates,
        });
    };

    let items = run_pr_list(&slug, &picked.token, state, limit)?;
    store_resolution(repo_path, &picked.login);
    Ok(PullRequestListing::Ok {
        items,
        account: picked.login,
    })
}

fn run_pr_list(
    slug: &str,
    token: &str,
    state: PrStateFilter,
    limit: u32,
) -> AppResult<Vec<PullRequestInfo>> {
    let limit = limit.clamp(1, 200);
    let output = Command::new("gh")
        .env("GH_TOKEN", token)
        // gh treats GH_HOST + GH_TOKEN as an "external" auth source and skips
        // its own keyring lookup, so this isolates the run to the picked
        // identity even when a different `gh auth status` account is active.
        .env("GH_HOST", GH_HOST)
        .args([
            "pr",
            "list",
            "--repo",
            slug,
            "--state",
            state.as_gh_arg(),
            "--limit",
            &limit.to_string(),
            "--json",
            "number,title,state,author,headRefName,baseRefName,url,updatedAt,isDraft",
        ])
        .output()
        .map_err(map_gh_spawn_error)?;

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
        .collect())
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

fn pick_from_multiple(
    repo_path: &Path,
    accessible: &[(String, String)],
) -> PickedAccount {
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
        if let Some((login, token)) =
            accessible.iter().find(|(_, t)| t == &active)
        {
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

fn map_gh_spawn_error(e: std::io::Error) -> AppError {
    if e.kind() == std::io::ErrorKind::NotFound {
        AppError::Other(
            "`gh` CLI not found. Install it from https://cli.github.com and run `gh auth login`."
                .to_string(),
        )
    } else {
        AppError::Other(format!("failed to invoke gh: {e}"))
    }
}

/// Parse `gh auth status --hostname <host>` output and pull out logins.
/// gh writes the human-readable status block to *stderr*, so we read both
/// streams. Lines look like:
///   "  ✓ Logged in to github.com account jtf-ian (keyring)"
fn enumerate_logins(host: &str) -> AppResult<Vec<String>> {
    let out = Command::new("gh")
        .args(["auth", "status", "--hostname", host])
        .output()
        .map_err(map_gh_spawn_error)?;
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
        let Some(idx) = line.find(needle) else { continue };
        let after = &line[idx + needle.len()..];
        let login: String = after
            .chars()
            .take_while(|c| !c.is_whitespace())
            .collect();
        if !login.is_empty() && !logins.iter().any(|l| l == &login) {
            logins.push(login);
        }
    }
    Ok(logins)
}

fn gh_token_for(login: &str) -> Option<String> {
    let out = Command::new("gh")
        .args(["auth", "token", "--user", login])
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

fn gh_active_token() -> Option<String> {
    let out = Command::new("gh").args(["auth", "token"]).output().ok()?;
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
    let out = Command::new("gh")
        .env("GH_TOKEN", token)
        .env("GH_HOST", GH_HOST)
        .args(["api", &endpoint, "--silent"])
        .output();
    match out {
        Ok(o) => o.status.success(),
        Err(_) => false,
    }
}

fn primary_email_for(token: &str) -> Option<String> {
    let out = Command::new("gh")
        .env("GH_TOKEN", token)
        .env("GH_HOST", GH_HOST)
        .args(["api", "user", "--jq", ".email"])
        .output()
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
