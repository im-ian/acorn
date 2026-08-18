//! Daemon handshake token persistence.
//!
//! The token is not treated as a complete same-user identity boundary: the
//! server additionally verifies the kernel-reported peer process and, for
//! session CLIs, its ancestry beneath the claimed PTY. It lets a daemon that
//! survives an app restart authenticate the replacement app without exposing
//! authority in protocol fields alone.

use std::io::{self, Read};

use uuid::Uuid;

const MAX_AUTH_TOKEN_BYTES: u64 = 64;

pub fn load_or_create() -> io::Result<Uuid> {
    match read() {
        Ok(token) => Ok(token),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let token = Uuid::new_v4();
            let path = super::paths::auth_token_path()?;
            acorn_platform::fs::write_atomic_private(&path, token.simple().to_string().as_bytes())?;
            // Reopen through the verified descriptor path. This catches an
            // unexpected publication race instead of trusting what we wrote.
            let loaded = read()?;
            if loaded != token {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "daemon authentication token changed during creation",
                ));
            }
            Ok(token)
        }
        Err(error) => Err(error),
    }
}

pub fn read() -> io::Result<Uuid> {
    let path = super::paths::auth_token_path()?;
    let (file, metadata) = acorn_platform::fs::open_regular_nofollow(&path)?;
    if metadata.len() == 0 || metadata.len() > MAX_AUTH_TOKEN_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "daemon authentication token has an invalid size",
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_AUTH_TOKEN_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_AUTH_TOKEN_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "daemon authentication token exceeds its byte limit",
        ));
    }
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "token is not UTF-8"))?;
    Uuid::parse_str(text.trim())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "token is not a UUID"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_env::ENV_LOCK;

    #[test]
    fn token_is_private_stable_and_bounded() {
        let _guard = ENV_LOCK.lock();
        let root = std::env::temp_dir().join(format!(
            "acorn-daemon-auth-{}",
            uuid::Uuid::new_v4().simple()
        ));
        unsafe { std::env::set_var(crate::paths::ENV_DATA_DIR_OVERRIDE, &root) };

        let first = load_or_create().unwrap();
        let second = load_or_create().unwrap();
        assert_eq!(first, second);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(crate::paths::auth_token_path().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }

        std::fs::write(
            crate::paths::auth_token_path().unwrap(),
            vec![b'x'; (MAX_AUTH_TOKEN_BYTES + 1) as usize],
        )
        .unwrap();
        assert_eq!(read().unwrap_err().kind(), io::ErrorKind::InvalidData);

        unsafe { std::env::remove_var(crate::paths::ENV_DATA_DIR_OVERRIDE) };
        let _ = std::fs::remove_dir_all(root);
    }
}
