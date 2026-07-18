//! Shared filesystem path resolution for the Acorn app, daemon, and CLIs.
//!
//! The macOS application identity stays rooted at `io.im-ian.acorn`; runtime
//! state is isolated below that directory with a profile segment.

use std::io;
use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use directories::ProjectDirs;

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
    let Ok(raw) = std::env::var(ENV_PROFILE) else {
        return Ok(None);
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

fn ensure_private_dir(path: &Path) -> io::Result<()> {
    std::fs::create_dir_all(path)?;
    #[cfg(unix)]
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    Ok(())
}

pub fn data_dir() -> io::Result<PathBuf> {
    if let Ok(over) = std::env::var(ENV_DATA_DIR_OVERRIDE) {
        if !over.is_empty() {
            let p = PathBuf::from(over);
            ensure_private_dir(&p)?;
            return Ok(p);
        }
    }

    let base = base_data_dir()?;
    ensure_private_dir(&base)?;
    let profiles = base.join("profiles");
    ensure_private_dir(&profiles)?;
    let dir = profiles.join(effective_profile()?);
    ensure_private_dir(&dir)?;
    Ok(dir)
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
}
