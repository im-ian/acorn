//! Shared env layering for PTY child spawn. Used by both the in-process
//! [`crate::pty::PtyManager`] and the daemon-side
//! [`crate::daemon::pty::PtyManager`] so the two spawn paths produce
//! identical child env regardless of which one services a session — the
//! daemon used to skip the layering entirely, which left zsh with empty
//! `TERM` whenever the daemon process inherited a sanitized env from
//! launchd-launched Acorn (see #165 / #166 follow-up).

use std::collections::{HashMap, HashSet};

use portable_pty::CommandBuilder;

/// Render-capability env we advertise to the child shell so zsh's terminfo
/// lookups (used by zsh-autosuggestions for cursor save/restore) and
/// color-aware CLIs (claude, fzf, …) emit sequences xterm.js can paint.
/// Treated as a non-empty contract: leaving either of these empty
/// collapses zsh to dumb terminfo (no `el`, no cursor moves, no
/// truecolor), which surfaces as plugin redraw artifacts, prompt parser
/// leaks, broken Backspace render, and color-aware CLIs falling back to
/// plain output.
pub const RENDER_CAPABILITY: &[(&str, &str)] =
    &[("TERM", "xterm-256color"), ("COLORTERM", "truecolor")];

/// Apply layered env to `cmd`, lowest-to-highest priority:
///   * (A) Render capability — TERM / COLORTERM defaults.
///   * (B) System locale — LANG default.
///   * (C) Login-shell dotfile env — `~/.zshenv` exports captured by
///     [`crate::shell_env::resolve`].
///   * (D) Caller env — `env` argument trumps everything above.
///
/// Followed by [`apply_render_capability_backstop`] which refuses empty
/// `TERM` / `COLORTERM` regardless of source.
///
/// `SHELL_SESSIONS_DISABLE=1` is stamped first so macOS zsh's per-session
/// restore (`/etc/zshrc_Apple_Terminal`) stays out of acorn's way; a
/// caller can opt back in by passing `SHELL_SESSIONS_DISABLE=0` in `env`,
/// which still wins via layer (D).
pub fn apply_layered_env(cmd: &mut CommandBuilder, env: HashMap<String, String>) {
    // Suppress macOS zsh's per-session restore. When acorn is launched
    // from Terminal.app the child PTY inherits
    // `TERM_PROGRAM=Apple_Terminal` and zsh treats every fresh PTY as a
    // resumable Terminal.app session, printing "Restored session: ..." /
    // "Saving session...completed." and writing per-session files into
    // `~/.zsh_sessions/`. acorn manages its own session lifecycle and
    // does not want zsh layering its own on top. `~/.zsh_history`
    // (HISTFILE) is unaffected — only the dirstack/last-commands
    // restore feature is disabled.
    cmd.env("SHELL_SESSIONS_DISABLE", "1");

    let shell_env = crate::shell_env::resolve();
    let mut applied: HashSet<String> = env.keys().cloned().collect();

    // (A) Render capability — TERM advertises what xterm.js renders, so
    // zsh's terminfo lookups (used by zsh-autosuggestions for cursor
    // save/restore) and color-aware CLIs (claude, fzf, …) emit
    // sequences we can actually paint. Without this, GUI-launched
    // acorn inherits an empty TERM and color/redraw goes wrong.
    for (k, v) in RENDER_CAPABILITY {
        if !applied.contains(*k) && !shell_env.contains_key(*k) {
            cmd.env(k, v);
            applied.insert((*k).to_string());
        }
    }

    // (B) System locale — Terminal.app's "Set locale environment
    // variables on startup" injects LANG from the user's macOS
    // Language & Region preference. We do the same so PTY children
    // start with a UTF-8 locale even on a fresh macOS install with
    // no LANG in any dotfile.
    if !applied.contains("LANG") && !shell_env.contains_key("LANG") {
        let lang =
            crate::shell_env::system_locale_lang().unwrap_or_else(|| "en_US.UTF-8".to_string());
        cmd.env("LANG", &lang);
        applied.insert("LANG".to_string());
    }

    // (C) Dotfile-set environment captured from the user's login shell
    // (`~/.zshenv` / `~/.zprofile` / `~/.zshrc`). Honors anything the
    // user explicitly exported — LANG, EDITOR, PAGER, TZ, etc. —
    // without acorn having to know each shell's rc-file conventions.
    for (k, v) in &shell_env {
        if !applied.contains(k) {
            cmd.env(k, v);
            applied.insert(k.clone());
        }
    }

    // (D) Caller env wins over everything above. Lets a future
    // per-session settings UI (or a test harness) force-override any
    // value we'd otherwise pick.
    for (k, v) in env {
        cmd.env(k, v);
    }

    apply_render_capability_backstop(cmd);
}

/// Refuse empty `TERM` / `COLORTERM`. Replays after every other layer
/// because earlier layers can deposit empties — caller-supplied
/// `env: { TERM: "" }`, or `CommandBuilder`'s base env inheriting an
/// empty `TERM` from launchd-launched Acorn. Empty `TERM` collapses
/// zsh's terminfo lookup to dumb (no `el`, no cursor moves, no
/// truecolor), which surfaces downstream as plugin redraw artifacts,
/// prompt parser leaks, broken Backspace render, and color-aware CLIs
/// falling back to plain output.
pub fn apply_render_capability_backstop(cmd: &mut CommandBuilder) {
    for (k, v) in RENDER_CAPABILITY {
        if cmd.get_env(*k).map_or(true, |s| s.is_empty()) {
            cmd.env(k, v);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_capability_backstop_fills_missing_keys() {
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.env_clear();
        apply_render_capability_backstop(&mut cmd);
        assert_eq!(
            cmd.get_env("TERM").and_then(|s| s.to_str()),
            Some("xterm-256color"),
        );
        assert_eq!(
            cmd.get_env("COLORTERM").and_then(|s| s.to_str()),
            Some("truecolor"),
        );
    }

    #[test]
    fn render_capability_backstop_overrides_empty_string() {
        // Reproduces the bug shape: a layer wrote `TERM=""` to the child
        // env. Without the backstop, zsh would inherit empty TERM and
        // collapse terminfo to dumb.
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.env_clear();
        cmd.env("TERM", "");
        cmd.env("COLORTERM", "");
        apply_render_capability_backstop(&mut cmd);
        assert_eq!(
            cmd.get_env("TERM").and_then(|s| s.to_str()),
            Some("xterm-256color"),
        );
        assert_eq!(
            cmd.get_env("COLORTERM").and_then(|s| s.to_str()),
            Some("truecolor"),
        );
    }

    #[test]
    fn render_capability_backstop_preserves_caller_nonempty() {
        // A caller (test harness, future per-session UI) that explicitly
        // wants a non-default TERM should not be clobbered by the backstop.
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.env_clear();
        cmd.env("TERM", "screen-256color");
        cmd.env("COLORTERM", "24bit");
        apply_render_capability_backstop(&mut cmd);
        assert_eq!(
            cmd.get_env("TERM").and_then(|s| s.to_str()),
            Some("screen-256color"),
        );
        assert_eq!(
            cmd.get_env("COLORTERM").and_then(|s| s.to_str()),
            Some("24bit"),
        );
    }
}
