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

use std::fs;
use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};
use crate::persistence;

const SCROLLBACK_DIR: &str = "scrollback";
/// Hard upper bound on a single session's persisted buffer. Frontend caps the
/// serialized output via SerializeAddon's `scrollback` row limit; this is a
/// belt-and-braces guard against runaway payloads.
const MAX_PAYLOAD_BYTES: usize = 4 * 1024 * 1024; // 4 MiB

fn scrollback_dir() -> AppResult<PathBuf> {
    let dir = persistence::data_dir()?.join(SCROLLBACK_DIR);
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn session_file(session_id: &str) -> AppResult<PathBuf> {
    if !is_safe_session_id(session_id) {
        return Err(AppError::Other(format!(
            "invalid session id: {session_id}"
        )));
    }
    Ok(scrollback_dir()?.join(format!("{session_id}.txt")))
}

/// UUIDs only. Reject anything that could traverse paths.
fn is_safe_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

pub fn save(session_id: &str, data: &str) -> AppResult<()> {
    let final_path = session_file(session_id)?;
    let payload = if data.len() > MAX_PAYLOAD_BYTES {
        // Drop the oldest bytes; xterm-rendered ANSI may break mid-sequence
        // here, but the frontend re-clears the screen on full restore so a
        // few corrupted glyphs at the very top are tolerable.
        &data[data.len() - MAX_PAYLOAD_BYTES..]
    } else {
        data
    };
    write_atomic(&final_path, payload.as_bytes())
}

pub fn load(session_id: &str) -> AppResult<Option<String>> {
    let path = session_file(session_id)?;
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

pub fn delete(session_id: &str) -> AppResult<()> {
    let path = session_file(session_id)?;
    if path.exists() {
        fs::remove_file(&path)?;
    }
    Ok(())
}

/// Remove scrollback files for any session id not present in `keep`.
/// Called at boot to evict files belonging to sessions that were deleted
/// while the app was offline (or before this feature existed).
pub fn prune_orphans<I, S>(keep: I) -> AppResult<usize>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let dir = scrollback_dir()?;
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

fn write_atomic(final_path: &Path, bytes: &[u8]) -> AppResult<()> {
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
}
