//! Capture a small whitelist of environment variables out of the user's
//! login+interactive shell so PTY children we spawn see the same locale,
//! editor, pager, etc. that the user gets in Terminal.app — without acorn
//! having to know each shell's rc-file conventions.
//!
//! ## Why
//!
//! When acorn is launched from Finder/Dock/Spotlight, macOS LaunchServices
//! hands the parent process a sanitized environment: no `LANG`, no `EDITOR`,
//! no `LC_*`. portable-pty's `CommandBuilder` then inherits that sanitized
//! env into every PTY child, so:
//!   * zsh treats UTF-8 input bytes as Latin-1 single bytes, rendering
//!     Korean/Japanese/Chinese as `<0085><0087>...`,
//!   * zsh-autosuggestions' redraw escapes go out of sync with xterm.js'
//!     real cursor position, scrambling typed input, and
//!   * tools that respect `EDITOR` / `PAGER` (git, less, kubectl, …) fall
//!     back to system defaults instead of the user's nvim/less/etc.
//!
//! Real terminal emulators (Terminal.app, iTerm2, Ghostty) work around this
//! by injecting the relevant env vars themselves — partly from the system
//! locale, partly inherited from the user's shell. We follow the same model:
//!   * [`system_locale_lang`] handles the locale half (mirrors Terminal.app's
//!     "Set locale environment variables on startup" preference),
//!   * [`resolve`] handles the dotfile half by capturing a whitelisted set
//!     of vars from the user's shell.
//!
//! ## Pattern
//!
//! Mirrors [`crate::cli_resolver`]'s shell-bootstrap-and-cache approach:
//!   1. Run `$SHELL -l -i -c` with a script that prints each whitelisted
//!      variable, base64-encoded so newlines/spaces in values can't break
//!      parsing, between known marker pairs.
//!   2. Parse the output bracketed by markers, base64-decode each value.
//!   3. Cache the resulting map in a `OnceLock`-backed `Mutex` so subsequent
//!      PTY spawns pay zero shell-startup cost.
//!
//! [`invalidate`] drops the cache so the next [`resolve`] call re-runs the
//! shell. The frontend exposes this as the `pty_reload_shell_env` Tauri
//! command, bound to `Cmd+Shift+,` — the same "reload config" gesture
//! Ghostty uses. Existing PTY children are unaffected: their environment is
//! fixed at fork time. New sessions spawned after the reload pick up the
//! refreshed values.

use std::collections::HashMap;
use std::process::Command;
use std::sync::{Mutex, OnceLock};

use base64::Engine;

use crate::shell_util::shell_quote;

/// Environment variables we propagate from the user's shell into PTY
/// children. Restricted to a known-safe set so we don't accidentally leak
/// shell-internal bookkeeping (`SHLVL`, `OLDPWD`, …) or sensitive secrets
/// the user might keep in their shell.
///
/// Categories:
///   * Locale family — what zsh's ZLE and tools use to interpret bytes,
///     pick message languages, and sort.
///   * Tool prefs — what editor / pager / man pager subcommands honor.
///   * Misc — `TZ` for time-aware tools, `HISTFILE` so the user's expected
///     history file location is honored.
const CAPTURED_VARS: &[&str] = &[
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LANGUAGE",
    "LC_COLLATE",
    "LC_MESSAGES",
    "LC_NUMERIC",
    "LC_TIME",
    "LC_MONETARY",
    "EDITOR",
    "VISUAL",
    "PAGER",
    "MANPAGER",
    "TZ",
    "HISTFILE",
];

const ENV_BEGIN: &str = "<<<ACORN_ENV_BEGIN>>>";
const ENV_END: &str = "<<<ACORN_ENV_END>>>";

fn cache() -> &'static Mutex<Option<HashMap<String, String>>> {
    static CACHE: OnceLock<Mutex<Option<HashMap<String, String>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

/// Return the cached shell environment, running the shell once on miss.
///
/// Returns an empty map if the shell can't be invoked or its output can't
/// be parsed — PTY spawn falls back to the hardcoded defaults in
/// [`crate::pty`] in that case, so a missing shell never blocks session
/// startup.
pub fn resolve() -> HashMap<String, String> {
    if let Some(cached) = cache().lock().unwrap().as_ref() {
        return cached.clone();
    }
    // Resolve outside the lock — shell startup can take 50–200ms and
    // holding the mutex would serialize concurrent first-time spawns.
    let resolved = shell_capture().unwrap_or_default();
    *cache().lock().unwrap() = Some(resolved.clone());
    resolved
}

/// Drop the cached snapshot. Subsequent [`resolve`] calls re-run the
/// shell, picking up dotfile edits the user has made since the last
/// capture.
pub fn invalidate() {
    *cache().lock().unwrap() = None;
}

/// macOS-only: read the system preferred locale and turn it into a `LANG`
/// value (e.g. `ko_KR` → `ko_KR.UTF-8`). Returns `None` on non-macOS or
/// when `defaults` isn't available / returns an empty string.
///
/// Mirrors Terminal.app's "Set locale environment variables on startup"
/// behavior: the user's macOS Language & Region preference, not their
/// dotfile, drives the value. Dotfile-set `LANG` overrides this via the
/// [`resolve`] (C) layer in PTY spawn.
pub fn system_locale_lang() -> Option<String> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let out = Command::new("defaults")
        .args(["read", "-g", "AppleLocale"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let locale = String::from_utf8(out.stdout).ok()?.trim().to_string();
    if locale.is_empty() {
        return None;
    }
    Some(format!("{locale}.UTF-8"))
}

/// Run `$SHELL -l -i -c '<script>'` and parse the marker-bracketed output
/// into a `HashMap<String, String>`. The script base64-encodes each
/// captured value so values containing newlines, spaces, or shell
/// metacharacters round-trip cleanly.
fn shell_capture() -> Option<HashMap<String, String>> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let script = build_capture_script(CAPTURED_VARS);
    let out = Command::new(&shell)
        .args(["-l", "-i", "-c", &script])
        .output()
        .ok()?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    parse_env_block(&stdout)
}

/// Build the shell script that prints the captured vars between markers.
/// `printenv` is POSIX-portable; `base64 | tr -d '\n'` works identically
/// on macOS BSD `base64` (no wrapping) and Linux GNU `base64` (default
/// 76-col wrap removed by `tr`).
fn build_capture_script(vars: &[&str]) -> String {
    let mut script = String::with_capacity(256 + vars.len() * 64);
    script.push_str("printf '%s' ");
    script.push_str(&shell_quote(ENV_BEGIN));
    script.push_str("; for var in ");
    for (i, v) in vars.iter().enumerate() {
        if i > 0 {
            script.push(' ');
        }
        script.push_str(&shell_quote(v));
    }
    // Each var: emit "KEY=<b64>\n" only when the var is set. We avoid
    // `set -u` and `${VAR:-}` expansion so this works in the most
    // permissive shell mode possible.
    script.push_str(
        "; do val=$(printenv \"$var\" 2>/dev/null); \
         if [ -n \"$val\" ]; then \
           enc=$(printf '%s' \"$val\" | base64 | tr -d '\\n'); \
           printf '%s=%s\\n' \"$var\" \"$enc\"; \
         fi; done; ",
    );
    script.push_str("printf '%s' ");
    script.push_str(&shell_quote(ENV_END));
    script
}

/// Pull the marker-bracketed env block out of `stdout`, base64-decode each
/// `KEY=value` line, and collect into a map. Returns `None` only when both
/// markers can't be found (shell crashed before printing anything useful);
/// any malformed line within the block is skipped silently rather than
/// failing the whole capture.
fn parse_env_block(stdout: &str) -> Option<HashMap<String, String>> {
    let start = stdout.find(ENV_BEGIN)? + ENV_BEGIN.len();
    let rest = &stdout[start..];
    let end = rest.find(ENV_END)?;
    let body = &rest[..end];
    let mut map = HashMap::new();
    for line in body.lines() {
        if let Some((key, value)) = parse_env_line(line) {
            map.insert(key, value);
        }
    }
    Some(map)
}

/// Parse a single `KEY=base64_value` line. Returns `None` for empty lines,
/// missing `=`, or invalid base64 — the caller skips silently so one bad
/// var doesn't drop the rest.
fn parse_env_line(line: &str) -> Option<(String, String)> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let (key, encoded) = line.split_once('=')?;
    if key.is_empty() {
        return None;
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .ok()?;
    let value = String::from_utf8(bytes).ok()?;
    Some((key.to_string(), value))
}

#[cfg(test)]
fn seed_cache(map: HashMap<String, String>) {
    *cache().lock().unwrap() = Some(map);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b64(s: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(s)
    }

    #[test]
    fn parse_env_line_round_trips_simple_value() {
        let line = format!("LANG={}", b64("en_US.UTF-8"));
        let (k, v) = parse_env_line(&line).expect("valid");
        assert_eq!(k, "LANG");
        assert_eq!(v, "en_US.UTF-8");
    }

    #[test]
    fn parse_env_line_handles_value_with_spaces_and_equals() {
        // `EDITOR="code --wait"` is a real-world value containing both a
        // space and characters that would confuse a naive parser.
        let line = format!("EDITOR={}", b64("code --wait"));
        let (k, v) = parse_env_line(&line).expect("valid");
        assert_eq!(k, "EDITOR");
        assert_eq!(v, "code --wait");
    }

    #[test]
    fn parse_env_line_rejects_empty_or_malformed() {
        assert_eq!(parse_env_line(""), None);
        assert_eq!(parse_env_line("   "), None);
        assert_eq!(parse_env_line("no_equals_sign"), None);
        assert_eq!(parse_env_line("=missing_key"), None);
        assert_eq!(parse_env_line("LANG=not!valid!base64!"), None);
    }

    #[test]
    fn parse_env_block_extracts_lines_between_markers() {
        let stdout = format!(
            "p10k instant-prompt banner here\n\
             {ENV_BEGIN}LANG={lang}\n\
             EDITOR={editor}\n\
             {ENV_END}\n\
             trailing rc-file noise",
            lang = b64("ko_KR.UTF-8"),
            editor = b64("nvim"),
        );
        let map = parse_env_block(&stdout).expect("markers found");
        assert_eq!(map.get("LANG").unwrap(), "ko_KR.UTF-8");
        assert_eq!(map.get("EDITOR").unwrap(), "nvim");
        assert_eq!(map.len(), 2);
    }

    #[test]
    fn parse_env_block_returns_none_when_markers_missing() {
        assert!(parse_env_block("garbage output").is_none());
        assert!(parse_env_block("").is_none());
        // Begin without End is also unusable.
        assert!(parse_env_block(&format!("{ENV_BEGIN}LANG=ZW4=\n")).is_none());
    }

    #[test]
    fn parse_env_block_skips_malformed_lines_without_aborting() {
        let stdout = format!(
            "{ENV_BEGIN}LANG={lang}\n\
             totally_bogus_line\n\
             EDITOR={editor}\n\
             {ENV_END}",
            lang = b64("en_US.UTF-8"),
            editor = b64("vim"),
        );
        let map = parse_env_block(&stdout).expect("markers found");
        assert_eq!(map.get("LANG").unwrap(), "en_US.UTF-8");
        assert_eq!(map.get("EDITOR").unwrap(), "vim");
        assert_eq!(map.len(), 2);
    }

    #[test]
    fn build_capture_script_includes_each_var() {
        let script = build_capture_script(&["LANG", "EDITOR"]);
        assert!(script.contains(ENV_BEGIN));
        assert!(script.contains(ENV_END));
        assert!(script.contains("LANG"));
        assert!(script.contains("EDITOR"));
        assert!(script.contains("printenv"));
        assert!(script.contains("base64"));
    }

    #[test]
    fn resolve_returns_cached_snapshot_without_shelling_out() {
        let mut seeded = HashMap::new();
        seeded.insert("LANG".to_string(), "ko_KR.UTF-8".to_string());
        seed_cache(seeded);

        let resolved = resolve();
        assert_eq!(resolved.get("LANG").unwrap(), "ko_KR.UTF-8");
    }

    /// End-to-end smoke test: actually invoke the user's shell, capture
    /// LANG, and round-trip it through our parser. Marked `#[ignore]` so
    /// CI does not depend on the runner having LANG exported in its
    /// dotfiles. Run locally with `cargo test -- --ignored` to verify the
    /// shell-script generation + parsing pipeline against a real shell.
    #[test]
    #[ignore]
    fn shell_capture_round_trips_against_real_shell() {
        // Force a known value into the shell's startup env so this test
        // is independent of the developer's dotfile content.
        // SAFETY: Single-threaded test — `set_var` is unsafe in
        // multi-threaded contexts but we only run one test at a time per
        // process for shell_capture (no other test touches the same env).
        unsafe {
            std::env::set_var("ACORN_SHELL_ENV_TEST", "round-trip-ok");
        }

        // Re-purpose CAPTURED_VARS to include our marker var temporarily.
        let probe_vars = ["LANG", "ACORN_SHELL_ENV_TEST"];
        let script = build_capture_script(&probe_vars);
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        let out = Command::new(&shell)
            .args(["-l", "-i", "-c", &script])
            .output()
            .expect("shell should run");
        let stdout = String::from_utf8_lossy(&out.stdout);
        let map = parse_env_block(&stdout)
            .expect("markers present in real shell output");
        assert_eq!(
            map.get("ACORN_SHELL_ENV_TEST").map(String::as_str),
            Some("round-trip-ok")
        );
    }

    #[test]
    fn invalidate_drops_cached_snapshot() {
        let mut seeded = HashMap::new();
        seeded.insert("LANG".to_string(), "en_US.UTF-8".to_string());
        seed_cache(seeded);
        assert!(cache().lock().unwrap().is_some());

        invalidate();
        assert!(cache().lock().unwrap().is_none());
    }
}
