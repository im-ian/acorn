//! Resolve absolute paths of external CLIs (`gh`, AI provider binaries, …)
//! through the user's login+interactive shell, then cache the result.
//!
//! ## Why
//!
//! macOS hands GUI-launched apps a sanitized PATH (`/usr/bin:/bin:/usr/sbin:/sbin`)
//! and never sources the user's shell rc files, so binaries installed via
//! Homebrew, npm, bun, asdf, mise, etc. are invisible to a plain
//! `Command::new("gh")`. The result is the "`gh` CLI not found" error users
//! see in the PRs tab when launching from Dock/Spotlight/Finder.
//!
//! PTY sessions handle this by wrapping every spawn in
//! `$SHELL -l -i -c 'exec <cmd>'`, which is fine for one-shot agent sessions
//! but would add 50–200ms of shell startup *per* gh invocation. The
//! multi-account picker in `pull_requests.rs` makes 5–10 gh calls per refresh
//! — enough to feel sluggish.
//!
//! Instead we resolve `<name>` to an absolute path (`/opt/homebrew/bin/gh`,
//! `~/.local/bin/gh`, etc.) once via the user shell, cache it, and then spawn
//! the binary directly. Subsequent calls skip the shell entirely.
//!
//! ## Self-healing
//!
//! Caches are dropped on the first `NotFound` spawn error so that:
//!   * a binary installed mid-session is picked up on the next attempt,
//!   * a binary uninstalled mid-session surfaces a clean error rather than a
//!     stale-cache mystery.
//!
//! Other errors (auth failures, non-zero exits, network) leave the cache
//! intact — they aren't a path problem.
//!
//! Resolution itself is best-effort: if the user's shell can't find `<name>`
//! either, we surface a "not found in your shell PATH" error so the frontend
//! can show actionable guidance.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Command, Output};
use std::sync::{Mutex, OnceLock};

use crate::error::{AppError, AppResult};
use crate::shell_util::shell_quote;

/// Per-name absolute-path cache. Keyed by the bare CLI name passed to
/// [`resolve`]. Lazily initialized so we don't pay for the HashMap when no
/// CLI has been touched yet (many sessions never open the PRs tab).
fn cache() -> &'static Mutex<HashMap<String, PathBuf>> {
    static CACHE: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Return an absolute path to the binary named `name`, resolving via the
/// user's login+interactive shell on first miss and caching the result for
/// subsequent calls.
///
/// Errors when the shell itself can't locate the binary — surfaces a
/// human-readable message the UI can show as-is.
pub fn resolve(name: &str) -> AppResult<PathBuf> {
    if let Some(cached) = cache().lock().unwrap().get(name).cloned() {
        return Ok(cached);
    }
    // Resolve outside the lock — shell startup can take 50–200ms and
    // holding the mutex would serialize concurrent first-time lookups for
    // unrelated CLIs.
    let resolved = shell_resolve(name)?;
    cache()
        .lock()
        .unwrap()
        .insert(name.to_string(), resolved.clone());
    Ok(resolved)
}

/// Drop the cached resolution for `name`. The next [`resolve`] call will
/// re-consult the user's shell. Call after a spawn returns `NotFound` so
/// freshly-installed binaries are picked up and uninstalled ones surface a
/// clean error instead of a stale path.
pub fn invalidate(name: &str) {
    cache().lock().unwrap().remove(name);
}

/// Spawn `name` and capture its `Output`, retrying once after invalidating
/// the cache if the spawn fails with `NotFound`. Other errors propagate
/// verbatim through [`AppError::Other`].
///
/// `configure` is called with a freshly-built `Command` (already pointed at
/// the resolved absolute path) so callers can stack on `args`, `env`, etc.
/// in their normal builder style. The closure may be invoked twice if a
/// retry happens, so it must be idempotent — don't move values into it.
pub fn run<F>(name: &str, mut configure: F) -> AppResult<Output>
where
    F: FnMut(&mut Command),
{
    let path = resolve(name)?;
    let mut cmd = Command::new(&path);
    configure(&mut cmd);
    match cmd.output() {
        Ok(out) => Ok(out),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // Cache is stale — binary moved/uninstalled since last resolve.
            // Drop the entry and retry once with a fresh shell lookup.
            invalidate(name);
            let path = resolve(name)?;
            let mut cmd = Command::new(&path);
            configure(&mut cmd);
            cmd.output().map_err(|e| spawn_error(name, e))
        }
        Err(e) => Err(spawn_error(name, e)),
    }
}

/// Map a spawn-time IO error into a user-facing message. `NotFound` becomes
/// the canonical "CLI not found" string the frontend keys off of.
pub fn spawn_error(name: &str, e: std::io::Error) -> AppError {
    if e.kind() == std::io::ErrorKind::NotFound {
        AppError::Other(format!(
            "`{name}` CLI not found. Install it and ensure it's on your shell's PATH."
        ))
    } else {
        AppError::Other(format!("failed to invoke {name}: {e}"))
    }
}

/// Run `$SHELL -l -i -c 'command -v <name>'` and parse stdout for the
/// resolved absolute path. The shell sources rc files (so PATH from
/// Homebrew/npm/asdf/etc. is loaded) before running `command -v`, mirroring
/// the rc-loading approach in `commands.rs::pty_spawn`.
fn shell_resolve(name: &str) -> AppResult<PathBuf> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    // Wrap `command -v` in an exclusive marker so we can pull the path out
    // even if the user's rc files print banners (p10k, oh-my-zsh, login
    // greetings) to stdout during shell startup.
    let script = format!(
        "printf '<<<ACORN_CLI_PATH>>>%s<<<END>>>' \"$(command -v {} 2>/dev/null)\"",
        shell_quote(name)
    );
    let out = Command::new(&shell)
        .args(["-l", "-i", "-c", &script])
        .output()
        .map_err(|e| {
            AppError::Other(format!(
                "failed to invoke shell {shell} to resolve {name}: {e}"
            ))
        })?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let extracted = extract_path(&stdout).map(str::trim).unwrap_or("");
    if extracted.is_empty() {
        return Err(AppError::Other(format!(
            "`{name}` not found in your shell PATH. Install it and ensure it's available in your login shell."
        )));
    }
    let path = PathBuf::from(extracted);
    if !path.is_absolute() {
        return Err(AppError::Other(format!(
            "shell returned a non-absolute path for `{name}`: {extracted}"
        )));
    }
    Ok(path)
}

/// Pull the resolved-path payload out of the marker we wrap around
/// `command -v`. Returns `None` if the markers are missing (shell crashed,
/// rc file errored mid-startup, etc.).
fn extract_path(stdout: &str) -> Option<&str> {
    let start_marker = "<<<ACORN_CLI_PATH>>>";
    let end_marker = "<<<END>>>";
    let start = stdout.find(start_marker)? + start_marker.len();
    let rest = &stdout[start..];
    let end = rest.find(end_marker)?;
    Some(&rest[..end])
}

/// Test-only helper to manipulate the cache directly. Production code should
/// go through [`resolve`] / [`invalidate`].
#[cfg(test)]
fn seed_cache(name: &str, path: &std::path::Path) {
    cache()
        .lock()
        .unwrap()
        .insert(name.to_string(), path.to_path_buf());
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn extract_path_pulls_value_between_markers() {
        let stdout = "<<<ACORN_CLI_PATH>>>/opt/homebrew/bin/gh<<<END>>>";
        assert_eq!(extract_path(stdout), Some("/opt/homebrew/bin/gh"));
    }

    #[test]
    fn extract_path_ignores_rc_banner_before_markers() {
        let stdout = "p10k instant-prompt loaded\n\
                      Last login: Mon Jan  1 12:00:00\n\
                      <<<ACORN_CLI_PATH>>>/usr/local/bin/gh<<<END>>>";
        assert_eq!(extract_path(stdout), Some("/usr/local/bin/gh"));
    }

    #[test]
    fn extract_path_returns_none_when_markers_missing() {
        assert_eq!(extract_path("garbage output"), None);
        assert_eq!(extract_path(""), None);
    }

    #[test]
    fn extract_path_handles_empty_payload() {
        // `command -v` prints nothing when the binary is missing; we get an
        // empty payload between markers and the caller treats it as "not
        // found".
        let stdout = "<<<ACORN_CLI_PATH>>><<<END>>>";
        assert_eq!(extract_path(stdout), Some(""));
    }

    #[test]
    fn invalidate_removes_only_the_named_entry() {
        seed_cache("acorn-test-keep", Path::new("/tmp/keep"));
        seed_cache("acorn-test-drop", Path::new("/tmp/drop"));

        invalidate("acorn-test-drop");

        let guard = cache().lock().unwrap();
        assert!(guard.contains_key("acorn-test-keep"));
        assert!(!guard.contains_key("acorn-test-drop"));
    }

    #[test]
    fn invalidate_is_a_noop_for_uncached_name() {
        invalidate("acorn-test-never-existed");
    }

    #[test]
    fn resolve_returns_cached_path_without_shelling_out() {
        // Use an obviously-fake path so any accidental spawn would fail
        // loudly. If the cache is honored we never touch the shell, so the
        // path comes back verbatim.
        seed_cache("acorn-test-cached", Path::new("/never/exists/binary"));

        let resolved = resolve("acorn-test-cached").expect("cached lookup");
        assert_eq!(resolved, Path::new("/never/exists/binary"));
    }

    #[test]
    fn spawn_error_maps_notfound_to_canonical_message() {
        let err = spawn_error("gh", std::io::Error::from(std::io::ErrorKind::NotFound));
        let msg = err.to_string();
        assert!(msg.contains("`gh` CLI not found"), "got: {msg}");
    }

    #[test]
    fn spawn_error_passes_through_other_io_kinds() {
        let err = spawn_error(
            "gh",
            std::io::Error::from(std::io::ErrorKind::PermissionDenied),
        );
        let msg = err.to_string();
        assert!(msg.contains("failed to invoke gh"), "got: {msg}");
    }
}
