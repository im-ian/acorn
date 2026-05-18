//! Single source of truth for the IPC Unix socket path. The app and the
//! `acorn-ipc` CLI compute it the same way so the CLI does not have to be
//! told where to connect via flag every invocation.
//!
//! Resolution order:
//! 1. `ACORN_IPC_SOCKET` env (override; takes precedence so test harnesses
//!    can point at an isolated path).
//! 2. `<data_dir>/ipc.sock`, where `data_dir` matches what the app uses for
//!    `sessions.json` and friends (see `crate::persistence::data_dir`).
//!
//! The CLI cannot link `persistence::data_dir` without dragging the app's
//! full module graph into the bin target, so this file re-derives the
//! same `directories` lookup directly — the two paths must stay in lockstep.
//!
//! Debug vs release: `cfg!(debug_assertions)` swaps the project name to
//! `acorn-dev` so `pnpm run tauri dev` cannot collide with the installed
//! app. The sidecar `acorn-ipc` CLI is normally built `--release` (see
//! `scripts/build-sidecar.sh`), so its fallback resolves to `acorn` even
//! when the host runs debug. This is fine in practice because every
//! control-session PTY gets `ACORN_IPC_SOCKET` injected and never reaches
//! the fallback branch.

use std::path::PathBuf;

use directories::ProjectDirs;

const SOCKET_FILE: &str = "ipc.sock";
const ENV_OVERRIDE: &str = "ACORN_IPC_SOCKET";

/// Resolve the canonical socket path. Errors as a plain `String` so the CLI
/// (which has no access to `AppError`) can print it directly.
pub fn resolve() -> Result<PathBuf, String> {
    if let Ok(override_path) = std::env::var(ENV_OVERRIDE) {
        if !override_path.is_empty() {
            return Ok(PathBuf::from(override_path));
        }
    }
    let app_name = if cfg!(debug_assertions) {
        "acorn-dev"
    } else {
        "acorn"
    };
    let project_dirs = ProjectDirs::from("io", "im-ian", app_name)
        .ok_or_else(|| "could not resolve project data directory".to_string())?;
    Ok(project_dirs.data_dir().join(SOCKET_FILE))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_override_takes_precedence() {
        // SAFETY: tests run on a single thread inside this test process and
        // we restore the previous value before returning so neighbouring
        // tests are not perturbed.
        let prev = std::env::var(ENV_OVERRIDE).ok();
        unsafe {
            std::env::set_var(ENV_OVERRIDE, "/tmp/acorn-test.sock");
        }
        let resolved = resolve().expect("override resolves");
        assert_eq!(resolved, PathBuf::from("/tmp/acorn-test.sock"));
        unsafe {
            match prev {
                Some(v) => std::env::set_var(ENV_OVERRIDE, v),
                None => std::env::remove_var(ENV_OVERRIDE),
            }
        }
    }

    #[test]
    fn falls_back_to_data_dir() {
        let prev = std::env::var(ENV_OVERRIDE).ok();
        unsafe {
            std::env::remove_var(ENV_OVERRIDE);
        }
        let resolved = resolve().expect("default resolves");
        assert!(resolved.ends_with(SOCKET_FILE));
        unsafe {
            if let Some(v) = prev {
                std::env::set_var(ENV_OVERRIDE, v);
            }
        }
    }
}
