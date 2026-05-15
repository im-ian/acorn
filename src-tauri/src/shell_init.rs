//! Acorn-managed shell rc files materialised under the data dir.
//!
//! Acorn spawns the user's `$SHELL` with `-l` (matching macOS
//! Terminal.app / iTerm2 / VS Code) and points `ZDOTDIR` at this
//! staged dir so zsh sees all four rc files we own (`.zshenv`,
//! `.zprofile`, `.zshrc`, `.zlogin`). Each forwarder sources the
//! user's real counterpart so version managers, `brew shellenv`,
//! `nvm`, ssh-agent bootstrap, etc. run normally; `.zshrc`
//! additionally installs an OSC 7 emitter so the host learns the
//! live cwd every prompt without polling, and re-prepends Acorn's
//! shim / IPC CLI dirs if the user's rc reset PATH.
//!
//! `ZDOTDIR` is the only env handle zsh provides for "load an extra
//! interactive rc before the user's" — same pattern iTerm2 / Wezterm
//! / VS Code use.
//!
//! bash and fish are out of scope today. bash handles its own
//! `.bash_profile` / `.bashrc` resolution off `$HOME` and we already
//! pass `-l` so login mode runs. fish emits OSC 7 by default. zsh is
//! the macOS default and the only shell that needs file-side help.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

const SHELL_INIT_DIR_NAME: &str = "shell-init";
const ZSHENV_NAME: &str = ".zshenv";
const ZPROFILE_NAME: &str = ".zprofile";
const ZSHRC_NAME: &str = ".zshrc";
const ZLOGIN_NAME: &str = ".zlogin";

const ZSHENV_BODY: &str = include_str!("../shell-init/zshenv");
const ZPROFILE_BODY: &str = include_str!("../shell-init/zprofile");
const ZSHRC_BODY: &str = include_str!("../shell-init/zshrc");
const ZLOGIN_BODY: &str = include_str!("../shell-init/zlogin");

/// Fingerprint of the staged dotfile bodies, computed at build time by
/// `build.rs` (FNV-1a over the four files in declaration order). Used
/// as the value of the `ACORN_STAGED_REV` env stamped into every PTY
/// child env, so a boot-time reconcile can detect a daemon session
/// spawned against an older build's dotfile bodies and force-respawn
/// it before the user's ZLE state collides with the new staged
/// `.zshrc` / `.zprofile` / `.zlogin`.
pub const STAGED_REV: &str = env!("ACORN_STAGED_REV");

/// Materialise the shell-init dir under Acorn's data dir, returning the
/// path callers should hand to `ZDOTDIR` on PTY spawn. Idempotent — the
/// body is rewritten every call so a shipped fix lands without a data
/// dir version bump.
pub fn ensure_shell_init_dir() -> io::Result<PathBuf> {
    ensure_shell_init_dir_at(&crate::daemon::paths::data_dir()?)
}

fn ensure_shell_init_dir_at(base: &Path) -> io::Result<PathBuf> {
    let dir = base.join(SHELL_INIT_DIR_NAME);
    fs::create_dir_all(&dir)?;
    fs::write(dir.join(ZSHENV_NAME), ZSHENV_BODY)?;
    fs::write(dir.join(ZPROFILE_NAME), ZPROFILE_BODY)?;
    fs::write(dir.join(ZSHRC_NAME), ZSHRC_BODY)?;
    fs::write(dir.join(ZLOGIN_NAME), ZLOGIN_BODY)?;
    Ok(dir)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    struct ScratchDir(PathBuf);
    impl ScratchDir {
        fn new(tag: &str) -> Self {
            let p = PathBuf::from("/tmp").join(format!(
                "acn-shell-init-{tag}-{}",
                uuid::Uuid::new_v4().simple()
            ));
            fs::create_dir_all(&p).unwrap();
            Self(p)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for ScratchDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn writes_zshrc_with_osc7_emitter_and_path_guard() {
        let base = ScratchDir::new("zshrc");
        let dir = ensure_shell_init_dir_at(base.path()).unwrap();
        let zshrc = dir.join(ZSHRC_NAME);
        assert!(zshrc.exists());
        let body = fs::read_to_string(&zshrc).unwrap();
        assert!(body.contains("_acorn_osc7"));
        assert!(body.contains("precmd_functions"));
        assert!(body.contains("ACORN_USER_ZDOTDIR"));
        assert!(body.contains("ACORN_CLI_DIR"));
        // Restore ZDOTDIR before .zlogin runs (otherwise the staged
        // .zlogin would resolve to the user's dir on its own).
        assert!(body.contains("_acorn_zd_save"));
    }

    #[test]
    fn writes_zshenv_forwarding_to_user() {
        let base = ScratchDir::new("zshenv");
        let dir = ensure_shell_init_dir_at(base.path()).unwrap();
        let zshenv = dir.join(ZSHENV_NAME);
        assert!(zshenv.exists());
        let body = fs::read_to_string(&zshenv).unwrap();
        assert!(body.contains("ACORN_USER_ZDOTDIR"));
        assert!(body.contains(".zshenv"));
        assert!(body.contains("ZDOTDIR=$_acorn_zd"));
    }

    #[test]
    fn writes_zprofile_forwarding_to_user() {
        let base = ScratchDir::new("zprofile");
        let dir = ensure_shell_init_dir_at(base.path()).unwrap();
        let zprofile = dir.join(ZPROFILE_NAME);
        assert!(zprofile.exists());
        let body = fs::read_to_string(&zprofile).unwrap();
        assert!(body.contains("ACORN_USER_ZDOTDIR"));
        assert!(body.contains(".zprofile"));
        // Restore ZDOTDIR so subsequent stage files keep resolving to
        // our forwarders.
        assert!(body.contains("_acorn_zd_save"));
    }

    #[test]
    fn writes_zlogin_forwarding_to_user() {
        let base = ScratchDir::new("zlogin");
        let dir = ensure_shell_init_dir_at(base.path()).unwrap();
        let zlogin = dir.join(ZLOGIN_NAME);
        assert!(zlogin.exists());
        let body = fs::read_to_string(&zlogin).unwrap();
        assert!(body.contains("ACORN_USER_ZDOTDIR"));
        assert!(body.contains(".zlogin"));
    }

    #[test]
    fn is_idempotent() {
        let base = ScratchDir::new("idem");
        let a = ensure_shell_init_dir_at(base.path()).unwrap();
        let b = ensure_shell_init_dir_at(base.path()).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn staged_rev_is_nonempty_hex() {
        // 16-char lowercase hex — the format `build.rs` commits to.
        assert_eq!(STAGED_REV.len(), 16, "expected 16-char hex, got {:?}", STAGED_REV);
        assert!(
            STAGED_REV.chars().all(|c| c.is_ascii_hexdigit()),
            "expected hex chars only, got {:?}",
            STAGED_REV,
        );
    }
}
