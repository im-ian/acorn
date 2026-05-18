//! Map a resolved shell path to the argv that makes it behave like a
//! native terminal session — login + interactive — whenever the shell
//! understands `-l`.
//!
//! macOS Terminal.app, iTerm2, WezTerm and VS Code all spawn the user's
//! `$SHELL` as a login shell so `~/.zprofile` / `~/.bash_profile` /
//! `~/.profile` run and version managers, `brew shellenv`, `nvm`, etc.
//! see their normal startup path. Acorn matches that contract: any
//! recognised POSIX-style shell gets `-l`. Unrecognised binaries
//! (pwsh, nushell, xonsh, custom wrappers) get no extra args so we
//! don't pass a flag they may reject.
//!
//! PTY children inherit a tty on stdin, which is the trigger every
//! supported shell uses to flip itself into interactive mode — so we
//! deliberately omit `-i`. zsh in particular emits a noisy warning if
//! `-i` is passed without an attached tty and the cost of guessing
//! wrong is higher than the cost of letting the shell decide.

use std::path::Path;

/// Returns argv flags to pass after the shell binary so it starts in
/// login mode. Empty vec means "no extra args" — used for unknown
/// shells we don't want to risk misconfiguring.
pub fn login_args_for(shell_path: &str) -> Vec<String> {
    let basename = Path::new(shell_path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(shell_path);

    match basename {
        "sh" | "bash" | "zsh" | "dash" | "ash" | "ksh" | "mksh" | "fish" => {
            vec!["-l".to_string()]
        }
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_flag_for_known_posix_shells() {
        for path in [
            "/bin/zsh",
            "/bin/bash",
            "/bin/sh",
            "/bin/dash",
            "/usr/local/bin/fish",
            "/opt/homebrew/bin/zsh",
            "zsh",
            "bash",
            "/usr/bin/ksh",
            "/usr/local/bin/mksh",
        ] {
            assert_eq!(
                login_args_for(path),
                vec!["-l".to_string()],
                "expected -l for {path}",
            );
        }
    }

    #[test]
    fn no_args_for_unknown_shells() {
        for path in [
            "/usr/local/bin/pwsh",
            "pwsh",
            "/usr/local/bin/nu",
            "nu",
            "xonsh",
            "/some/custom/wrapper",
            "",
        ] {
            assert_eq!(
                login_args_for(path),
                Vec::<String>::new(),
                "expected empty args for {path}",
            );
        }
    }
}
