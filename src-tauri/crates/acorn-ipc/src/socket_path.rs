//! Single source of truth for the IPC Unix socket path. The app and the
//! `acorn-ipc` CLI compute it the same way so the CLI does not have to be
//! told where to connect via flag every invocation.
//!
//! Resolution order:
//! 1. `ACORN_IPC_SOCKET` env (override; takes precedence so test harnesses
//!    can point at an isolated path).
//! 2. `<data_dir>/ipc.sock`, where `data_dir` comes from `acorn-paths` and
//!    matches the app and daemon profile layout.

use std::path::PathBuf;

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
    Ok(acorn_paths::data_dir()
        .map_err(|err| err.to_string())?
        .join(SOCKET_FILE))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn env_override_takes_precedence() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        // SAFETY: serialized via ENV_LOCK and restored before returning.
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
        let _guard = ENV_LOCK.lock().expect("env lock");
        let prev = std::env::var(ENV_OVERRIDE).ok();
        let prev_profile = std::env::var(acorn_paths::ENV_PROFILE).ok();
        unsafe {
            std::env::remove_var(ENV_OVERRIDE);
            std::env::set_var(acorn_paths::ENV_PROFILE, "ipc-test");
        }
        let resolved = resolve().expect("default resolves");
        assert!(resolved.ends_with(SOCKET_FILE));
        assert!(
            resolved.ends_with("profiles/ipc-test/ipc.sock"),
            "fallback socket should use the selected profile data dir, got {resolved:?}"
        );
        unsafe {
            if let Some(v) = prev {
                std::env::set_var(ENV_OVERRIDE, v);
            }
            match prev_profile {
                Some(v) => std::env::set_var(acorn_paths::ENV_PROFILE, v),
                None => std::env::remove_var(acorn_paths::ENV_PROFILE),
            }
        }
        let _ = std::fs::remove_dir_all(resolved.parent().unwrap());
    }
}
