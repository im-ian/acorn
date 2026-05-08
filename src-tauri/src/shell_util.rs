//! Small POSIX shell helpers shared across modules that have to splice values
//! into a `$SHELL -c '...'` script (e.g. PTY command wrapping in `commands.rs`
//! and CLI absolute-path resolution in `cli_resolver.rs`).

/// Quote `s` so a POSIX shell parses it as a single argument verbatim.
/// Returns `s` unquoted when it is composed solely of safe characters that
/// the shell would not interpret (alphanumerics and a small allow-list);
/// otherwise wraps it in single quotes with embedded `'` escaped as `'\''`.
pub fn shell_quote(s: &str) -> String {
    if s.is_empty() {
        return "''".to_string();
    }
    let safe = s.bytes().all(|b| {
        b.is_ascii_alphanumeric()
            || matches!(
                b,
                b'_' | b'-' | b'/' | b'.' | b'=' | b':' | b',' | b'@' | b'+'
            )
    });
    if safe {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        if c == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(c);
        }
    }
    out.push('\'');
    out
}

#[cfg(test)]
mod tests {
    use super::shell_quote;

    #[test]
    fn safe_inputs_pass_through() {
        assert_eq!(shell_quote("claude"), "claude");
        assert_eq!(shell_quote("--session-id"), "--session-id");
        assert_eq!(shell_quote("a1b2-c3d4"), "a1b2-c3d4");
        assert_eq!(shell_quote("/usr/local/bin/foo"), "/usr/local/bin/foo");
        assert_eq!(shell_quote("KEY=value"), "KEY=value");
    }

    #[test]
    fn empty_becomes_empty_quotes() {
        assert_eq!(shell_quote(""), "''");
    }

    #[test]
    fn space_triggers_quoting() {
        assert_eq!(shell_quote("hello world"), "'hello world'");
    }

    #[test]
    fn embedded_single_quote_is_escaped() {
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
    }

    #[test]
    fn shell_metacharacters_are_quoted() {
        assert_eq!(shell_quote("a;b"), "'a;b'");
        assert_eq!(shell_quote("$HOME"), "'$HOME'");
        assert_eq!(shell_quote("`ls`"), "'`ls`'");
        assert_eq!(shell_quote("a|b"), "'a|b'");
    }
}
