//! Cross-platform executable naming helpers.

use std::io;
use std::path::PathBuf;

const EXECUTABLE_SUFFIXES: &[&str] = &[".exe", ".cmd", ".bat", ".com", ".js", ".mjs", ".cjs"];

/// Resolve an executable shipped beside the current Acorn process.
pub fn sibling_executable(stem: &str) -> io::Result<PathBuf> {
    let current = std::env::current_exe()?;
    let parent = current.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            "current executable has no parent directory",
        )
    })?;
    Ok(parent.join(format!("{stem}{}", std::env::consts::EXE_SUFFIX)))
}

/// Match a process-table value against a logical executable name.
///
/// Process APIs vary between full paths, argv[0], and bare names. Windows
/// also reports launchable script suffixes and uses case-insensitive names.
pub fn executable_name_matches(value: &str, target: &str) -> bool {
    let candidate = basename(value);
    let candidate = strip_known_suffix(candidate);
    let target = strip_known_suffix(basename(target));
    if cfg!(windows) {
        candidate.eq_ignore_ascii_case(target)
    } else {
        candidate == target
    }
}

fn basename(value: &str) -> &str {
    value
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(value)
        .trim_matches('"')
}

fn strip_known_suffix(value: &str) -> &str {
    EXECUTABLE_SUFFIXES
        .iter()
        .find_map(|suffix| {
            value
                .get(value.len().saturating_sub(suffix.len())..)
                .filter(|ending| ending.eq_ignore_ascii_case(suffix))
                .map(|_| &value[..value.len() - suffix.len()])
        })
        .unwrap_or(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_paths_and_launchable_suffixes() {
        assert!(executable_name_matches("/opt/bin/claude", "claude"));
        assert!(executable_name_matches(r"C:\\Tools\\acornd.exe", "acornd"));
        assert!(executable_name_matches("C:/Tools/codex.CMD", "codex"));
        assert!(executable_name_matches("/opt/bin/agy.js", "agy"));
        assert!(!executable_name_matches("/opt/bin/claude-helper", "claude"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_names_are_case_insensitive() {
        assert!(executable_name_matches("ACORND.EXE", "acornd"));
    }
}
