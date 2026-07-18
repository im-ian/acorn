//! Per-session terminal scrollback persistence.
//!
//! Stores the serialized xterm buffer (ANSI text) for each session under
//! `<data_dir>/scrollback/<session_id>.txt`. Frontend serializes via
//! `@xterm/addon-serialize` and writes through `scrollback_save`; on Terminal
//! mount it loads via `scrollback_load` and `term.write`s the bytes back into
//! xterm before spawning the PTY.
//!
//! Atomic writes use a temp file + rename. Files are best-effort: read errors
//! return `None` so the UI can proceed with an empty buffer.
//!
//! Callers pass the application's data directory in explicitly so this crate
//! does not depend on the main `acorn` crate's `persistence::data_dir()`
//! resolver. The single per-process data dir is resolved once at boot and
//! threaded through.

use std::fs;
use std::io;
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

fn scrollback_dir(data_dir: &Path) -> ScrollbackResult<PathBuf> {
    let dir = data_dir.join(SCROLLBACK_DIR);
    fs::create_dir_all(&dir)?;
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
    if !path.exists() {
        return Ok(None);
    }
    match fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(err) => {
            tracing::warn!(path = %path.display(), error = %err, "failed to read scrollback");
            Ok(None)
        }
    }
}

pub fn delete(data_dir: &Path, session_id: &str) -> ScrollbackResult<()> {
    let path = session_file(data_dir, session_id)?;
    if path.exists() {
        fs::remove_file(&path)?;
    }
    Ok(())
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
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(err) => {
            tracing::warn!(path = %dir.display(), error = %err, "scrollback prune: read_dir failed");
            return Ok(0);
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
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
        if let Err(err) = fs::remove_file(&path) {
            tracing::warn!(path = %path.display(), error = %err, "scrollback prune: remove failed");
        } else {
            removed += 1;
        }
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
/// surfaces the reclaimable portion. Returns 0 on read errors.
pub fn orphan_size_bytes<I, S>(data_dir: &Path, keep: I) -> ScrollbackResult<u64>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let dir = scrollback_dir(data_dir)?;
    let keep_set: std::collections::HashSet<String> =
        keep.into_iter().map(|s| s.as_ref().to_string()).collect();
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(0),
    };
    let mut total: u64 = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("txt") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if keep_set.contains(stem) {
            continue;
        }
        if let Ok(meta) = entry.metadata() {
            total = total.saturating_add(meta.len());
        }
    }
    Ok(total)
}

fn write_atomic(final_path: &Path, bytes: &[u8]) -> ScrollbackResult<()> {
    let tmp_path = final_path.with_extension("txt.tmp");
    fs::write(&tmp_path, bytes)?;
    fs::rename(&tmp_path, final_path)?;
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

    fn tempdir_path() -> PathBuf {
        use std::time::{SystemTime, UNIX_EPOCH};
        let ns = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let p = std::env::temp_dir().join(format!("acorn-session-scrollback-{ns}"));
        fs::create_dir_all(&p).unwrap();
        p
    }
}
