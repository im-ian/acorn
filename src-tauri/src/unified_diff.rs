//! Parse the unified-diff text gh emits (e.g. from `gh pr diff <num>`)
//! into the same `DiffPayload` shape we render elsewhere. Lets the PR
//! detail viewer reuse `DiffSplitView` without standing up a new format.
//!
//! This is intentionally simple: it preserves hunk lines verbatim with
//! their leading prefix (' ', '+', '-') so the renderer can colour them
//! the same way it colours libgit2-produced patches.

use crate::git_ops::{DiffFile, DiffPayload};

/// File-extension list mirrors the one in `git_ops::is_image_path` — we
/// can't reach across module privacy without churning that file, and
/// keeping a small standalone copy is cheaper than exposing it.
fn looks_like_image(path: &str) -> bool {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    matches!(
        ext.as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "ico" | "avif"
    )
}

fn parse_diff_marker(rest: &str) -> Option<String> {
    let trimmed = rest.trim();
    if trimmed == "/dev/null" {
        return None;
    }
    // Marker lines look like: `--- a/path` or `+++ b/path`. Strip the
    // `a/` / `b/` prefix so the path matches what libgit2 emits.
    let path = trimmed
        .strip_prefix("a/")
        .or_else(|| trimmed.strip_prefix("b/"))
        .unwrap_or(trimmed);
    if path.is_empty() {
        None
    } else {
        Some(path.to_string())
    }
}

/// Best-effort split of a `diff --git a/X b/Y` header into (old_path, new_path).
/// `--- a/...` / `+++ b/...` markers below override these, but headers are
/// the only signal we have when one side of the pair is absent (e.g. binary
/// diffs that never emit `---`/`+++`).
fn split_diff_git_header(rest: &str) -> (Option<String>, Option<String>) {
    // Naive split on " b/": good enough for paths that don't contain that
    // exact substring, which is the overwhelming majority. Quoted paths
    // (filenames with spaces) would land here too — gh emits them
    // unquoted so we accept the same.
    let mut old_path = None;
    let mut new_path = None;
    if let Some(idx) = rest.find(" b/") {
        let (left, right) = rest.split_at(idx);
        let l = left.trim().trim_start_matches("a/");
        let r = right[1..].trim().trim_start_matches("b/");
        if !l.is_empty() {
            old_path = Some(l.to_string());
        }
        if !r.is_empty() {
            new_path = Some(r.to_string());
        }
    }
    (old_path, new_path)
}

/// Convert a unified-diff text blob into a `DiffPayload`. Unknown metadata
/// lines (`index ...`, `new file mode ...`, etc.) are dropped from the
/// patch body to match libgit2's hunk-only view; `Binary files ...` lines
/// are kept so the renderer can fall back to a "binary" placeholder.
pub fn parse_unified_diff(text: &str) -> DiffPayload {
    let mut files: Vec<DiffFile> = Vec::new();
    let mut current: Option<DiffFile> = None;

    for line in text.split('\n') {
        if let Some(rest) = line.strip_prefix("diff --git ") {
            if let Some(prev) = current.take() {
                files.push(prev);
            }
            let (old_path, new_path) = split_diff_git_header(rest);
            let is_image = looks_like_image(
                new_path.as_deref().or(old_path.as_deref()).unwrap_or(""),
            );
            current = Some(DiffFile {
                old_path,
                new_path,
                patch: String::new(),
                old_image: None,
                new_image: None,
                is_image,
            });
            continue;
        }

        let Some(file) = current.as_mut() else {
            continue;
        };

        if let Some(rest) = line.strip_prefix("--- ") {
            file.old_path = parse_diff_marker(rest);
            continue;
        }
        if let Some(rest) = line.strip_prefix("+++ ") {
            file.new_path = parse_diff_marker(rest);
            // Recompute is_image now that the actual path is known.
            let path_for_type = file
                .new_path
                .as_deref()
                .or(file.old_path.as_deref())
                .unwrap_or("");
            file.is_image = looks_like_image(path_for_type);
            continue;
        }
        if line.starts_with("index ")
            || line.starts_with("new file mode")
            || line.starts_with("deleted file mode")
            || line.starts_with("old mode")
            || line.starts_with("new mode")
            || line.starts_with("similarity ")
            || line.starts_with("dissimilarity ")
            || line.starts_with("rename ")
            || line.starts_with("copy ")
        {
            continue;
        }

        // Hunk header (`@@ -1,3 +1,4 @@`), context, additions, removals,
        // and the "Binary files differ" sentinel all flow into the patch
        // body verbatim. Append a newline because we split on '\n'.
        file.patch.push_str(line);
        file.patch.push('\n');
    }

    if let Some(prev) = current.take() {
        files.push(prev);
    }
    DiffPayload { files }
}
