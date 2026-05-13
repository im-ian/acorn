//! Shared helpers for working with Claude Code's on-disk layout.
//!
//! Claude buckets transcripts under `~/.claude/projects/<slug>/`, where
//! `<slug>` is the working directory with `/` and `.` replaced by `-`
//! and a leading `-` prepended. Multiple call sites need this mapping
//! (`detect_session_agent` to locate the transcript, `prepare_claude_fork`
//! to stage a parent transcript into a fork's worktree slug), so we
//! keep the derivation in one place.

use std::path::Path;

/// Convert a filesystem cwd into the dash-slug directory name Claude
/// uses to bucket its JSONL transcripts.
///
/// Examples:
///   `/Users/me/proj`                          → `-Users-me-proj`
///   `/Users/me/proj/.claude/worktrees/foo`    → `-Users-me-proj--claude-worktrees-foo`
pub fn slug_for_cwd(cwd: &Path) -> String {
    let s = cwd.to_string_lossy();
    let trimmed = s.trim_start_matches('/');
    let mut slug = String::with_capacity(s.len() + 1);
    slug.push('-');
    for ch in trimmed.chars() {
        if ch == '/' || ch == '.' {
            slug.push('-');
        } else {
            slug.push(ch);
        }
    }
    slug
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_for_simple_cwd() {
        assert_eq!(slug_for_cwd(Path::new("/Users/me/proj")), "-Users-me-proj");
    }

    #[test]
    fn slug_for_cwd_with_dot_dirs() {
        // Claude doubles the leading dash before any `.` segment.
        assert_eq!(
            slug_for_cwd(Path::new("/Users/me/proj/.claude/worktrees/foo")),
            "-Users-me-proj--claude-worktrees-foo"
        );
    }
}
