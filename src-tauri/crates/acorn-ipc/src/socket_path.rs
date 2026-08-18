//! Single source of truth for the IPC local endpoint. The app and the
//! `acorn-ipc` CLI compute it the same way so the CLI does not have to be
//! told where to connect via flag every invocation.
//!
//! Resolution order:
//! 1. `ACORN_IPC_SOCKET` env (override; takes precedence so test harnesses
//!    can point at an isolated path).
//! 2. `<data_dir>/ipc.sock` on Unix or a profile-scoped named pipe on
//!    Windows, derived by `acorn-paths`.

use std::path::PathBuf;

#[cfg(all(test, unix))]
const SOCKET_FILE: &str = "ipc.sock";
const ENV_OVERRIDE: &str = "ACORN_IPC_SOCKET";

/// Resolve the canonical socket path. Errors as a plain `String` so the CLI
/// (which has no access to `AppError`) can print it directly.
pub fn resolve() -> Result<PathBuf, String> {
    if let Some(override_path) = std::env::var_os(ENV_OVERRIDE) {
        if !override_path.is_empty() {
            return Ok(PathBuf::from(override_path));
        }
    }
    acorn_paths::local_ipc_endpoint("ipc").map_err(|err| err.to_string())
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
        let prev = std::env::var_os(ENV_OVERRIDE);
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

    #[cfg(unix)]
    #[test]
    fn env_override_preserves_non_unicode_os_paths() {
        use std::ffi::OsString;
        use std::os::unix::ffi::OsStringExt;

        let _guard = ENV_LOCK.lock().expect("env lock");
        let prev = std::env::var_os(ENV_OVERRIDE);
        let expected = PathBuf::from(OsString::from_vec(b"/tmp/acorn-ipc-\xff.sock".to_vec()));
        unsafe { std::env::set_var(ENV_OVERRIDE, &expected) };

        assert_eq!(resolve().expect("override resolves"), expected);

        unsafe {
            match prev {
                Some(value) => std::env::set_var(ENV_OVERRIDE, value),
                None => std::env::remove_var(ENV_OVERRIDE),
            }
        }
    }

    #[test]
    fn falls_back_to_data_dir() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        let prev = std::env::var_os(ENV_OVERRIDE);
        let prev_data_dir = std::env::var_os(acorn_paths::ENV_DATA_DIR_OVERRIDE);
        let prev_profile = std::env::var_os(acorn_paths::ENV_PROFILE);
        unsafe {
            std::env::remove_var(ENV_OVERRIDE);
            std::env::remove_var(acorn_paths::ENV_DATA_DIR_OVERRIDE);
            std::env::set_var(acorn_paths::ENV_PROFILE, "ipc-test");
        }
        let resolved = resolve().expect("default resolves");
        #[cfg(unix)]
        {
            assert!(resolved.ends_with(SOCKET_FILE));
            assert!(
                resolved.ends_with("profiles/ipc-test/ipc.sock"),
                "fallback socket should use the selected profile data dir, got {resolved:?}"
            );
        }
        #[cfg(windows)]
        assert!(resolved.to_string_lossy().starts_with(r"\\.\pipe\acorn-"));
        unsafe {
            if let Some(v) = prev {
                std::env::set_var(ENV_OVERRIDE, v);
            }
            match prev_data_dir {
                Some(v) => std::env::set_var(acorn_paths::ENV_DATA_DIR_OVERRIDE, v),
                None => std::env::remove_var(acorn_paths::ENV_DATA_DIR_OVERRIDE),
            }
            match prev_profile {
                Some(v) => std::env::set_var(acorn_paths::ENV_PROFILE, v),
                None => std::env::remove_var(acorn_paths::ENV_PROFILE),
            }
        }
        #[cfg(unix)]
        let _ = std::fs::remove_dir_all(resolved.parent().unwrap());
    }
}
