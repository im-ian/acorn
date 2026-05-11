//! Bundled `acorn-ipc` CLI discovery for control-session PTYs.
//!
//! Acorn ships a copy of `acorn-ipc` next to the main app binary via
//! Tauri's `externalBin` mechanism. For control sessions, we prepend that
//! directory onto the PTY's `PATH` so the agent inside can just type
//! `acorn-ipc list-sessions` instead of resorting to an absolute path or
//! relying on a user-installed shim. Regular (non-control) sessions never
//! receive this addition — they stay sandboxed from the IPC surface.
//!
//! In `tauri dev` the same `current_exe().parent()` resolves to
//! `src-tauri/target/debug/`, where `cargo build --bin acorn-ipc` writes
//! the dev binary, so dev and production converge without a code path
//! split.

use std::path::{Path, PathBuf};

/// Directory containing the bundled `acorn-ipc` binary.
///
/// Returns `None` only when `std::env::current_exe()` fails, which on
/// supported platforms is a broken-process-table edge case we treat as
/// "skip the injection rather than crash".
pub fn bundled_cli_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
}

/// Prepend `dir` to a `PATH`-shaped string. Empty entries (which match
/// the legacy "`.` in PATH" Unix wart) are stripped, and an entry equal
/// to `dir` is de-duplicated so repeated PTY spawns within one app run
/// don't grow a stack of identical entries. Uses the platform's path
/// separator.
pub fn prepend_to_path(dir: &Path, existing: &str) -> String {
    let mut entries = vec![dir.to_path_buf()];
    entries.extend(
        std::env::split_paths(existing)
            .filter(|p| !p.as_os_str().is_empty() && p != dir),
    );
    std::env::join_paths(entries)
        .map(|s| s.to_string_lossy().into_owned())
        // join_paths only errors on entries containing the platform
        // separator. A `current_exe().parent()` path on any supported
        // platform will not, so this fallback is theoretical — but it keeps
        // us in `PATH` in even that pathological case.
        .unwrap_or_else(|_| dir.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sep() -> &'static str {
        if cfg!(windows) {
            ";"
        } else {
            ":"
        }
    }

    #[test]
    fn prepend_puts_dir_at_front() {
        let dir = PathBuf::from("/opt/acorn/bin");
        let existing = format!("/usr/bin{}/bin", sep());
        let out = prepend_to_path(&dir, &existing);
        let parts: Vec<_> = std::env::split_paths(&out).collect();
        assert_eq!(parts.first(), Some(&dir));
        assert!(parts.iter().any(|p| p == Path::new("/usr/bin")));
        assert!(parts.iter().any(|p| p == Path::new("/bin")));
    }

    #[test]
    fn prepend_deduplicates_existing_occurrences() {
        let dir = PathBuf::from("/opt/acorn/bin");
        let existing = format!("/opt/acorn/bin{0}/usr/bin{0}/opt/acorn/bin", sep());
        let out = prepend_to_path(&dir, &existing);
        let count = std::env::split_paths(&out).filter(|p| p == &dir).count();
        assert_eq!(count, 1, "expected exactly one /opt/acorn/bin, got {out}");
    }

    #[test]
    fn prepend_handles_empty_existing() {
        let dir = PathBuf::from("/opt/acorn/bin");
        let out = prepend_to_path(&dir, "");
        let parts: Vec<_> = std::env::split_paths(&out).collect();
        assert_eq!(parts, vec![dir]);
    }

    #[test]
    fn prepend_strips_empty_entries() {
        let dir = PathBuf::from("/opt/acorn/bin");
        // Trailing separator → split_paths yields a final empty entry,
        // which historically meant "current dir" — we never want that
        // injected silently.
        let existing = format!("/usr/bin{}", sep());
        let out = prepend_to_path(&dir, &existing);
        let parts: Vec<_> = std::env::split_paths(&out).collect();
        assert_eq!(parts, vec![dir, PathBuf::from("/usr/bin")]);
    }

    #[test]
    fn prepend_preserves_order_after_dir() {
        let dir = PathBuf::from("/opt/acorn/bin");
        let existing = format!("/a{0}/b{0}/c", sep());
        let out = prepend_to_path(&dir, &existing);
        let parts: Vec<_> = std::env::split_paths(&out).collect();
        assert_eq!(
            parts,
            vec![
                dir,
                PathBuf::from("/a"),
                PathBuf::from("/b"),
                PathBuf::from("/c"),
            ]
        );
    }
}
