//! Acorn-managed shell rc files materialised under the data dir.
//!
//! Set `ZDOTDIR` on PTY spawn to point zsh at our staged `.zshenv` +
//! `.zshrc`. The `.zshrc` registers an OSC 7 emitter so the host learns
//! the live cwd every prompt without polling, and the `.zshenv` forwards
//! to the user's real `.zshenv` so rustup / asdf style env bootstrap
//! still runs (zsh resolves both files via `$ZDOTDIR`, not `$HOME`).
//! The same pattern iTerm2 / Wezterm / VS Code use; `ZDOTDIR` is the
//! only env handle zsh provides for "load an extra interactive rc
//! before the user's".
//!
//! bash and fish are out of scope today — bash supports `PROMPT_COMMAND`
//! from the env directly, and fish emits OSC 7 by default. zsh is the
//! macOS default and the only shell that needs file-side help.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

const SHELL_INIT_DIR_NAME: &str = "shell-init";
const ZSHENV_NAME: &str = ".zshenv";
const ZSHRC_NAME: &str = ".zshrc";

const ZSHENV_BODY: &str = include_str!("../shell-init/zshenv");
const ZSHRC_BODY: &str = include_str!("../shell-init/zshrc");

/// Materialise the shell-init dir under Acorn's data dir, returning the
/// path callers should hand to `ZDOTDIR` on PTY spawn. Idempotent — the
/// body is rewritten every call so a shipped fix lands without a data
/// dir version bump (same convention as `agent_shim::ensure_shim_dir`).
pub fn ensure_shell_init_dir() -> io::Result<PathBuf> {
    ensure_shell_init_dir_at(&crate::daemon::paths::data_dir()?)
}

fn ensure_shell_init_dir_at(base: &Path) -> io::Result<PathBuf> {
    let dir = base.join(SHELL_INIT_DIR_NAME);
    fs::create_dir_all(&dir)?;
    fs::write(dir.join(ZSHENV_NAME), ZSHENV_BODY)?;
    fs::write(dir.join(ZSHRC_NAME), ZSHRC_BODY)?;
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
    fn writes_zshrc_with_osc7_emitter() {
        let base = ScratchDir::new("zshrc");
        let dir = ensure_shell_init_dir_at(base.path()).unwrap();
        let zshrc = dir.join(ZSHRC_NAME);
        assert!(zshrc.exists());
        let body = fs::read_to_string(&zshrc).unwrap();
        assert!(body.contains("_acorn_osc7"));
        assert!(body.contains("precmd_functions"));
        assert!(body.contains("ACORN_USER_ZDOTDIR"));
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
    fn is_idempotent() {
        let base = ScratchDir::new("idem");
        let a = ensure_shell_init_dir_at(base.path()).unwrap();
        let b = ensure_shell_init_dir_at(base.path()).unwrap();
        assert_eq!(a, b);
    }
}
