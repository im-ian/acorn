//! Per-session terminal scrollback persistence.
//!
//! Stores the serialized xterm buffer (ANSI text) for each session under
//! `<data_dir>/scrollback/<session_id>.txt`. Frontend serializes via
//! `@xterm/addon-serialize` and writes through `scrollback_save`; on Terminal
//! mount it loads via `scrollback_load` and `term.write`s the bytes back into
//! xterm before spawning the PTY.
//!
//! Atomic writes use same-directory replace semantics. A missing file is an
//! empty buffer; other read failures remain errors so the UI does not enable
//! saves over a snapshot it could not restore.
//!
//! Callers pass the application's data directory in explicitly so this crate
//! does not depend on the main `acorn` crate's `persistence::data_dir()`
//! resolver. The single per-process data dir is resolved once at boot and
//! threaded through.

use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

const SCROLLBACK_DIR: &str = "scrollback";
/// Hard upper bound on a single session's persisted buffer. Frontend caps the
/// serialized output via SerializeAddon's `scrollback` row limit; this is a
/// belt-and-braces guard against runaway payloads.
const MAX_PAYLOAD_BYTES: usize = 4 * 1024 * 1024; // 4 MiB

/// Errors surfaced by the scrollback API. Path-traversal rejection and
/// unrecoverable IO failures bubble up here; ordinary missing-file reads
/// short-circuit to `Ok(None)` instead.
#[derive(Debug, thiserror::Error)]
pub enum ScrollbackError {
    #[error("io error: {0}")]
    Io(#[from] io::Error),
    #[error("invalid session id: {0}")]
    InvalidSessionId(String),
}

pub type ScrollbackResult<T> = Result<T, ScrollbackError>;

fn path_io_error(operation: &str, path: &Path, error: io::Error) -> ScrollbackError {
    ScrollbackError::Io(io::Error::new(
        error.kind(),
        format!(
            "failed to {operation} scrollback path {}: {error}",
            path.display()
        ),
    ))
}

fn scrollback_dir(data_dir: &Path) -> ScrollbackResult<PathBuf> {
    let dir = data_dir.join(SCROLLBACK_DIR);
    match fs::symlink_metadata(&dir) {
        Ok(metadata) if metadata.file_type().is_dir() => {}
        Ok(_) => {
            return Err(path_io_error(
                "inspect",
                &dir,
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "scrollback path is not a real directory",
                ),
            ));
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            fs::create_dir_all(data_dir)
                .map_err(|error| path_io_error("create", data_dir, error))?;
            match fs::create_dir(&dir) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(path_io_error("create", &dir, error)),
            }
            let metadata = fs::symlink_metadata(&dir)
                .map_err(|error| path_io_error("inspect", &dir, error))?;
            if !metadata.file_type().is_dir() {
                return Err(path_io_error(
                    "inspect",
                    &dir,
                    io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "scrollback path is not a real directory",
                    ),
                ));
            }
        }
        Err(error) => return Err(path_io_error("inspect", &dir, error)),
    }
    Ok(dir)
}

fn session_file(data_dir: &Path, session_id: &str) -> ScrollbackResult<PathBuf> {
    if !is_safe_session_id(session_id) {
        return Err(ScrollbackError::InvalidSessionId(session_id.to_string()));
    }
    Ok(scrollback_dir(data_dir)?.join(format!("{session_id}.txt")))
}

/// UUIDs only. Reject anything that could traverse paths.
fn is_safe_session_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

pub fn save(data_dir: &Path, session_id: &str, data: &str) -> ScrollbackResult<()> {
    let final_path = session_file(data_dir, session_id)?;
    let payload = trailing_utf8_slice(data, MAX_PAYLOAD_BYTES);
    write_atomic(&final_path, payload.as_bytes())
}

fn trailing_utf8_slice(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }

    // Drop the oldest bytes, then advance at most three more bytes so slicing
    // never lands in the middle of a UTF-8 scalar value. ANSI may still start
    // mid-sequence, but a non-ASCII terminal buffer must not panic the app.
    let mut start = value.len() - max_bytes;
    while !value.is_char_boundary(start) {
        start += 1;
    }
    &value[start..]
}

pub fn load(data_dir: &Path, session_id: &str) -> ScrollbackResult<Option<String>> {
    let path = session_file(data_dir, session_id)?;
    let (file, metadata) = match acorn_platform::fs::open_regular_nofollow(&path) {
        Ok(opened) => opened,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(path_io_error("read", &path, error)),
    };
    if metadata.len() > MAX_PAYLOAD_BYTES as u64 {
        return Err(path_io_error(
            "read",
            &path,
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("scrollback exceeds its {MAX_PAYLOAD_BYTES}-byte limit"),
            ),
        ));
    }

    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_PAYLOAD_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| path_io_error("read", &path, error))?;
    if bytes.len() > MAX_PAYLOAD_BYTES {
        return Err(path_io_error(
            "read",
            &path,
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("scrollback exceeds its {MAX_PAYLOAD_BYTES}-byte limit"),
            ),
        ));
    }
    String::from_utf8(bytes).map(Some).map_err(|error| {
        path_io_error(
            "read",
            &path,
            io::Error::new(io::ErrorKind::InvalidData, error),
        )
    })
}

pub fn delete(data_dir: &Path, session_id: &str) -> ScrollbackResult<()> {
    let path = session_file(data_dir, session_id)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(path_io_error("delete", &path, error)),
    }
}

/// Remove scrollback files for any session id not present in `keep`.
/// Called at boot to evict files left behind by sessions that no longer exist.
pub fn prune_orphans<I, S>(data_dir: &Path, keep: I) -> ScrollbackResult<usize>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let dir = scrollback_dir(data_dir)?;
    let keep_set: std::collections::HashSet<String> =
        keep.into_iter().map(|s| s.as_ref().to_string()).collect();
    let mut removed = 0usize;
    let entries = fs::read_dir(&dir).map_err(|error| path_io_error("read", &dir, error))?;
    for entry in entries {
        let entry = entry.map_err(|error| path_io_error("read entry in", &dir, error))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| path_io_error("inspect", &path, error))?;
        if !file_type.is_file() {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        // Skip leftover atomic-write temp files — the .txt extension check
        // below also rejects them, but be explicit.
        if path.extension().and_then(|s| s.to_str()) != Some("txt") {
            continue;
        }
        if keep_set.contains(stem) {
            continue;
        }
        fs::remove_file(&path).map_err(|error| path_io_error("delete", &path, error))?;
        removed += 1;
    }
    if removed > 0 {
        tracing::info!(removed, "pruned orphan scrollback files");
    }
    Ok(removed)
}

/// Sum of bytes used by orphan scrollback files — files whose session
/// id no longer exists in `keep`. Files for live sessions are not
/// counted because they cannot be safely reclaimed without losing the
/// session's restorable buffer; the user-facing "Clear cache" UI only
/// surfaces the reclaimable portion. Access and directory-entry failures
/// remain errors so the UI does not display an authoritative zero for an
/// unreadable cache.
pub fn orphan_size_bytes<I, S>(data_dir: &Path, keep: I) -> ScrollbackResult<u64>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let dir = scrollback_dir(data_dir)?;
    let keep_set: std::collections::HashSet<String> =
        keep.into_iter().map(|s| s.as_ref().to_string()).collect();
    let entries = fs::read_dir(&dir).map_err(|error| path_io_error("read", &dir, error))?;
    let mut total: u64 = 0;
    for entry in entries {
        let entry = entry.map_err(|error| path_io_error("read entry in", &dir, error))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| path_io_error("inspect", &path, error))?;
        if !file_type.is_file() {
            continue;
        }
        if path.extension().and_then(|s| s.to_str()) != Some("txt") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if keep_set.contains(stem) {
            continue;
        }
        let metadata = entry
            .metadata()
            .map_err(|error| path_io_error("inspect", &path, error))?;
        total = total.saturating_add(metadata.len());
    }
    Ok(total)
}

fn write_atomic(final_path: &Path, bytes: &[u8]) -> ScrollbackResult<()> {
    acorn_platform::fs::write_atomic(final_path, bytes)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unsafe_session_ids() {
        assert!(!is_safe_session_id(""));
        assert!(!is_safe_session_id("../etc/passwd"));
        assert!(!is_safe_session_id("a/b"));
        assert!(!is_safe_session_id("a.b"));
        assert!(!is_safe_session_id(&"x".repeat(65)));
        assert!(is_safe_session_id("550e8400-e29b-41d4-a716-446655440000"));
        assert!(is_safe_session_id("abcdef0123456789"));
    }

    #[test]
    fn save_and_load_round_trip() {
        let tmp = tempdir_path();
        let id = "550e8400-e29b-41d4-a716-446655440000";
        save(&tmp, id, "hello\n\x1b[31mred\x1b[0m\n").expect("save");
        let got = load(&tmp, id).expect("load").expect("some");
        assert!(got.contains("hello"));
        // Cleanup
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn payload_truncation_advances_to_a_utf8_boundary() {
        assert_eq!(trailing_utf8_slice("é1234", 5), "1234");
        assert_eq!(trailing_utf8_slice("한글", 3), "글");
    }

    #[test]
    fn load_returns_none_for_missing() {
        let tmp = tempdir_path();
        let id = "550e8400-e29b-41d4-a716-446655440001";
        let got = load(&tmp, id).expect("load");
        assert!(got.is_none());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn load_reports_oversized_files() {
        let tmp = tempdir_path();
        let id = "550e8400-e29b-41d4-a716-446655440002";
        let path = session_file(&tmp, id).expect("scrollback path");
        fs::write(&path, vec![b'x'; MAX_PAYLOAD_BYTES + 1]).expect("oversized scrollback");

        assert!(load(&tmp, id).is_err());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[cfg(unix)]
    #[test]
    fn load_reports_symlinks() {
        use std::os::unix::fs::symlink;

        let tmp = tempdir_path();
        let id = "550e8400-e29b-41d4-a716-446655440003";
        let target = tmp.join("outside.txt");
        fs::write(&target, "do not read").expect("symlink target");
        let path = session_file(&tmp, id).expect("scrollback path");
        symlink(&target, &path).expect("scrollback symlink");

        assert!(load(&tmp, id).is_err());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[cfg(unix)]
    #[test]
    fn save_rejects_symlinked_scrollback_directory() {
        use std::os::unix::fs::symlink;

        let tmp = tempdir_path();
        let outside = tmp.join("outside");
        fs::create_dir(&outside).unwrap();
        symlink(&outside, tmp.join(SCROLLBACK_DIR)).unwrap();

        let result = save(&tmp, "550e8400-e29b-41d4-a716-446655440004", "secret");
        assert!(result.is_err());
        assert!(fs::read_dir(&outside).unwrap().next().is_none());

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn prune_orphans_drops_unknown_ids() {
        let tmp = tempdir_path();
        let kept = "550e8400-e29b-41d4-a716-44665544000a";
        let orphan = "550e8400-e29b-41d4-a716-44665544000b";
        save(&tmp, kept, "k").expect("kept");
        save(&tmp, orphan, "o").expect("orphan");
        let removed = prune_orphans(&tmp, [kept]).expect("prune");
        assert_eq!(removed, 1);
        assert!(load(&tmp, kept).expect("load kept").is_some());
        assert!(load(&tmp, orphan).expect("load orphan").is_none());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[cfg(unix)]
    #[test]
    fn load_reports_an_unreadable_snapshot_instead_of_empty() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempdir_path();
        let id = "550e8400-e29b-41d4-a716-44665544000c";
        save(&tmp, id, "preserve me").expect("save");
        let path = tmp.join(SCROLLBACK_DIR).join(format!("{id}.txt"));
        fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).expect("deny read");
        let permission_bits_enforced = fs::File::open(&path).is_err();
        let result = load(&tmp, id);
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("restore read");

        if permission_bits_enforced {
            let error = result.expect_err("unreadable snapshot must remain an error");
            assert!(error.to_string().contains("failed to read scrollback path"));
            assert!(error.to_string().contains(&path.display().to_string()));
            assert_eq!(fs::read_to_string(&path).unwrap(), "preserve me");
        }
        let _ = fs::remove_dir_all(&tmp);
    }

    #[cfg(unix)]
    #[test]
    fn prune_reports_remove_failures_instead_of_partial_success() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempdir_path();
        let id = "550e8400-e29b-41d4-a716-44665544000d";
        save(&tmp, id, "orphan").expect("save");
        let dir = tmp.join(SCROLLBACK_DIR);
        let path = dir.join(format!("{id}.txt"));
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o500)).expect("deny delete");
        let result = prune_orphans(&tmp, std::iter::empty::<&str>());
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).expect("restore delete");

        if path.exists() {
            let error = result.expect_err("failed orphan deletion must remain an error");
            assert!(error
                .to_string()
                .contains("failed to delete scrollback path"));
            assert!(error.to_string().contains(&path.display().to_string()));
        }
        let _ = fs::remove_dir_all(&tmp);
    }

    #[cfg(unix)]
    #[test]
    fn orphan_size_reports_an_unreadable_directory_instead_of_zero() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempdir_path();
        let id = "550e8400-e29b-41d4-a716-44665544000e";
        save(&tmp, id, "orphan").expect("save");
        let dir = tmp.join(SCROLLBACK_DIR);
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o000)).expect("deny scan");
        let permission_bits_enforced = fs::read_dir(&dir).is_err();
        let result = orphan_size_bytes(&tmp, std::iter::empty::<&str>());
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).expect("restore scan");

        if permission_bits_enforced {
            let error = result.expect_err("unreadable cache must not report zero bytes");
            assert!(error.to_string().contains("scrollback path"));
            assert!(error.to_string().contains(&dir.display().to_string()));
        }
        let _ = fs::remove_dir_all(&tmp);
    }

    fn tempdir_path() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "acorn-session-scrollback-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&p).unwrap();
        p
    }
}
