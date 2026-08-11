//! Resolve the native interactive shell and its startup arguments.

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellKind {
    Zsh,
    Posix,
    PowerShell,
    Cmd,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InteractiveShell {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub kind: ShellKind,
}

pub fn interactive_shell() -> InteractiveShell {
    #[cfg(windows)]
    {
        return windows_shell();
    }
    #[cfg(not(windows))]
    {
        let program = std::env::var_os("SHELL")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/bin/sh"));
        shell_from_program(program)
    }
}

fn shell_from_program(program: PathBuf) -> InteractiveShell {
    let kind = classify(&program);
    let rendered = program.to_string_lossy();
    let args = match kind {
        ShellKind::Zsh | ShellKind::Posix => crate::shell_args::login_args_for(&rendered),
        ShellKind::PowerShell => vec!["-NoLogo".to_string()],
        ShellKind::Cmd => vec!["/Q".to_string()],
        ShellKind::Other => Vec::new(),
    };
    InteractiveShell {
        program,
        args,
        kind,
    }
}

fn classify(program: &Path) -> ShellKind {
    let rendered = program.to_string_lossy();
    let name = rendered
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(rendered.as_ref())
        .trim_matches('"');
    let stem = name
        .rsplit_once('.')
        .filter(|(_, extension)| extension.eq_ignore_ascii_case("exe"))
        .map(|(stem, _)| stem)
        .unwrap_or(name);
    if stem.eq_ignore_ascii_case("zsh") {
        ShellKind::Zsh
    } else if ["sh", "bash", "dash", "ash", "ksh", "mksh", "fish"]
        .iter()
        .any(|candidate| stem.eq_ignore_ascii_case(candidate))
    {
        ShellKind::Posix
    } else if stem.eq_ignore_ascii_case("pwsh") || stem.eq_ignore_ascii_case("powershell") {
        ShellKind::PowerShell
    } else if stem.eq_ignore_ascii_case("cmd") {
        ShellKind::Cmd
    } else {
        ShellKind::Other
    }
}

#[cfg(windows)]
fn windows_shell() -> InteractiveShell {
    if let Some(shell) = std::env::var_os("SHELL")
        .filter(|value| !value.is_empty())
        .and_then(resolve_windows_program)
    {
        return shell_from_program(shell);
    }
    for candidate in ["pwsh.exe", "powershell.exe"] {
        if let Some(program) = find_on_windows_path(candidate) {
            return shell_from_program(program);
        }
    }
    if let Some(program) = std::env::var_os("COMSPEC")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_file())
    {
        return shell_from_program(program);
    }
    shell_from_program(PathBuf::from("cmd.exe"))
}

#[cfg(windows)]
fn resolve_windows_program(value: std::ffi::OsString) -> Option<PathBuf> {
    let path = PathBuf::from(&value);
    if path.is_file() {
        return Some(path);
    }
    if path.components().count() == 1 {
        return find_on_windows_path(&value.to_string_lossy());
    }
    None
}

#[cfg(windows)]
fn find_on_windows_path(name: &str) -> Option<PathBuf> {
    let raw = Path::new(name);
    let has_extension = raw.extension().is_some();
    let extensions = if has_extension {
        vec![String::new()]
    } else {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string())
            .split(';')
            .filter(|extension| !extension.eq_ignore_ascii_case(".PS1"))
            .map(str::to_string)
            .collect()
    };
    let path = std::env::var_os("PATH")?;
    for directory in std::env::split_paths(&path) {
        for extension in &extensions {
            let candidate = directory.join(format!("{name}{extension}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_native_shell_families() {
        assert_eq!(classify(Path::new("/bin/zsh")), ShellKind::Zsh);
        assert_eq!(classify(Path::new("/bin/bash")), ShellKind::Posix);
        assert_eq!(
            classify(Path::new(
                r"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
            )),
            ShellKind::PowerShell
        );
        assert_eq!(
            classify(Path::new(r"C:\\Windows\\System32\\cmd.exe")),
            ShellKind::Cmd
        );
        assert_eq!(
            classify(Path::new(r"C:\\Tools\\PwSh.ExE")),
            ShellKind::PowerShell
        );
    }

    #[test]
    fn assigns_platform_shell_arguments() {
        assert_eq!(
            shell_from_program(PathBuf::from("powershell.exe")).args,
            vec!["-NoLogo"]
        );
        assert_eq!(
            shell_from_program(PathBuf::from("cmd.exe")).args,
            vec!["/Q"]
        );
        assert_eq!(
            shell_from_program(PathBuf::from("/bin/zsh")).args,
            vec!["-l"]
        );
    }
}
