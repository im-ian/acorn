//! Shared filesystem path resolution for the Acorn app, daemon, and CLIs.
//!
//! The macOS application identity stays rooted at `io.im-ian.acorn`; runtime
//! state is isolated below that directory with a profile segment.

use std::io;
use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use directories::{ProjectDirs, UserDirs};

pub const ENV_DATA_DIR_OVERRIDE: &str = "ACORN_DATA_DIR";
pub const ENV_PROFILE: &str = "ACORN_PROFILE";

pub const PROD_PROFILE: &str = "prod";
pub const DEV_PROFILE: &str = "dev";

pub fn default_profile() -> &'static str {
    if cfg!(debug_assertions) {
        DEV_PROFILE
    } else {
        PROD_PROFILE
    }
}

fn profile_from_env() -> io::Result<Option<String>> {
    let raw = match std::env::var(ENV_PROFILE) {
        Ok(raw) => raw,
        Err(std::env::VarError::NotPresent) => return Ok(None),
        Err(std::env::VarError::NotUnicode(_)) => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("{ENV_PROFILE} is not valid Unicode"),
            ));
        }
    };
    let profile = raw.trim();
    if profile.is_empty() {
        return Ok(None);
    }
    let valid = profile
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'));
    if !valid {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{ENV_PROFILE} contains unsupported path characters"),
        ));
    }
    Ok(Some(profile.to_string()))
}

pub fn effective_profile() -> io::Result<String> {
    Ok(profile_from_env()?.unwrap_or_else(|| default_profile().to_string()))
}

pub fn base_data_dir() -> io::Result<PathBuf> {
    let pd = ProjectDirs::from("io", "im-ian", "acorn").ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            "could not resolve project data directory",
        )
    })?;
    Ok(pd.data_dir().to_path_buf())
}

/// Resolve the current user's home directory through the OS account APIs.
/// This works for Explorer-launched Windows apps where `HOME` is normally
/// absent, while preserving the conventional home directory on Unix.
pub fn user_home_dir() -> io::Result<PathBuf> {
    UserDirs::new()
        .map(|dirs| dirs.home_dir().to_path_buf())
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "user home directory unavailable"))
}

fn ensure_private_dir(path: &Path) -> io::Result<()> {
    std::fs::create_dir_all(path)?;
    #[cfg(unix)]
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    Ok(())
}

fn data_dir_override_from(raw: Option<std::ffi::OsString>) -> Option<PathBuf> {
    raw.filter(|value| !value.is_empty()).map(PathBuf::from)
}

pub fn data_dir() -> io::Result<PathBuf> {
    if let Some(path) = data_dir_override_from(std::env::var_os(ENV_DATA_DIR_OVERRIDE)) {
        ensure_private_dir(&path)?;
        return Ok(path);
    }

    let base = base_data_dir()?;
    ensure_private_dir(&base)?;
    let profiles = base.join("profiles");
    ensure_private_dir(&profiles)?;
    let dir = profiles.join(effective_profile()?);
    ensure_private_dir(&dir)?;
    Ok(dir)
}

/// Resolve a private local-IPC endpoint for the selected data profile.
///
/// Unix transports are filesystem sockets inside the profile directory.
/// Windows transports are named pipes, whose namespace is independent from
/// the filesystem. The data-directory hash keeps production, development,
/// test, and explicit override profiles isolated without placing user paths
/// (or path separators) in the pipe name.
pub fn local_ipc_endpoint(stem: &str) -> io::Result<PathBuf> {
    if stem.is_empty()
        || !stem
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "local IPC endpoint stem contains unsupported characters",
        ));
    }

    let dir = data_dir()?;
    #[cfg(windows)]
    {
        let identity = dir.to_string_lossy().replace('/', "\\").to_lowercase();
        let hash = fnv1a64(identity.as_bytes());
        return Ok(PathBuf::from(format!(r"\\.\pipe\acorn-{hash:016x}-{stem}")));
    }
    #[cfg(not(windows))]
    {
        Ok(dir.join(format!("{stem}.sock")))
    }
}

#[cfg(windows)]
fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn profile_env_selects_subdir_under_acorn_app_dir() {
        let _guard = ENV_LOCK.lock().unwrap();
        unsafe {
            std::env::remove_var(ENV_DATA_DIR_OVERRIDE);
            std::env::set_var(ENV_PROFILE, "unit-test");
        }

        let dir = data_dir().unwrap();
        let rendered = dir.to_string_lossy();
        assert!(rendered.contains("io.im-ian.acorn") || rendered.contains("acorn"));
        assert!(!rendered.contains("acorn-dev"));
        assert!(dir.ends_with("profiles/unit-test"));

        unsafe { std::env::remove_var(ENV_PROFILE) };
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn data_dir_override_wins_over_profile() {
        let _guard = ENV_LOCK.lock().unwrap();
        let tmp = PathBuf::from("/tmp").join(format!("acorn-paths-{}", std::process::id()));
        unsafe {
            std::env::set_var(ENV_DATA_DIR_OVERRIDE, &tmp);
            std::env::set_var(ENV_PROFILE, "ignored");
        }

        assert_eq!(data_dir().unwrap(), tmp);

        #[cfg(unix)]
        assert_eq!(
            std::fs::metadata(&tmp).unwrap().permissions().mode() & 0o777,
            0o700
        );

        unsafe {
            std::env::remove_var(ENV_DATA_DIR_OVERRIDE);
            std::env::remove_var(ENV_PROFILE);
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[cfg(unix)]
    #[test]
    fn data_dir_override_preserves_non_unicode_os_paths() {
        use std::ffi::OsString;
        use std::os::unix::ffi::OsStringExt;

        let mut component = format!("acorn-paths-non-unicode-{}-", std::process::id()).into_bytes();
        component.push(0xff);
        let tmp = std::env::temp_dir().join(OsString::from_vec(component));

        assert_eq!(
            data_dir_override_from(Some(tmp.clone().into_os_string())),
            Some(tmp)
        );
    }

    #[cfg(unix)]
    #[test]
    fn data_dir_tightens_existing_permissions() {
        let _guard = ENV_LOCK.lock().unwrap();
        let tmp =
            PathBuf::from("/tmp").join(format!("acorn-paths-permissions-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755)).unwrap();
        unsafe { std::env::set_var(ENV_DATA_DIR_OVERRIDE, &tmp) };

        assert_eq!(data_dir().unwrap(), tmp);
        assert_eq!(
            std::fs::metadata(&tmp).unwrap().permissions().mode() & 0o777,
            0o700
        );

        unsafe { std::env::remove_var(ENV_DATA_DIR_OVERRIDE) };
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn profile_rejects_path_traversal() {
        let _guard = ENV_LOCK.lock().unwrap();
        unsafe {
            std::env::remove_var(ENV_DATA_DIR_OVERRIDE);
            std::env::set_var(ENV_PROFILE, "../prod");
        }

        assert_eq!(data_dir().unwrap_err().kind(), io::ErrorKind::InvalidInput);

        unsafe { std::env::remove_var(ENV_PROFILE) };
    }

    #[cfg(unix)]
    #[test]
    fn profile_rejects_non_unicode_values() {
        use std::ffi::OsString;
        use std::os::unix::ffi::OsStringExt;

        let _guard = ENV_LOCK.lock().unwrap();
        unsafe {
            std::env::remove_var(ENV_DATA_DIR_OVERRIDE);
            std::env::set_var(ENV_PROFILE, OsString::from_vec(vec![0xff]));
        }

        assert_eq!(
            effective_profile().unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );

        unsafe { std::env::remove_var(ENV_PROFILE) };
    }

    #[test]
    fn local_ipc_endpoint_uses_selected_data_profile() {
        let _guard = ENV_LOCK.lock().unwrap();
        let tmp = std::env::temp_dir().join(format!("acorn-paths-ipc-{}", std::process::id()));
        unsafe { std::env::set_var(ENV_DATA_DIR_OVERRIDE, &tmp) };

        let endpoint = local_ipc_endpoint("daemon-stream").unwrap();
        #[cfg(unix)]
        assert_eq!(endpoint, tmp.join("daemon-stream.sock"));
        #[cfg(windows)]
        {
            let rendered = endpoint.to_string_lossy();
            assert!(rendered.starts_with(r"\\.\pipe\acorn-"));
            assert!(rendered.ends_with("-daemon-stream"));
        }

        unsafe { std::env::remove_var(ENV_DATA_DIR_OVERRIDE) };
        let _ = std::fs::remove_dir_all(tmp);
    }

    #[test]
    fn local_ipc_endpoint_rejects_path_like_stems() {
        assert_eq!(
            local_ipc_endpoint("../ipc").unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
    }
}
