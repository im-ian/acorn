//! Generates the "control session primer" — a short system-prompt blurb
//! that teaches an agent spawned inside a control session about the
//! `acorn-ipc` CLI, its env vars, and the commands it can issue.
//!
//! The primer is injected two ways at PTY spawn time:
//!
//!   1. Per-agent CLI flag, when the spawn command is one Acorn knows how
//!      to prime (Claude Code's `--append-system-prompt`, llm CLI's `-s`).
//!      This is the strongest signal because it lands directly in the
//!      agent's system prompt before the conversation starts.
//!   2. A `<cwd>/.acorn-control.md` marker file written unconditionally
//!      for every control session. Agents that read project-local docs
//!      (Claude Code follows CLAUDE.md, Aider follows .aider config, …)
//!      can discover it; humans `cat`-ing the file get the same content.

use std::path::Path;

use crate::session::Session;

/// Distinguishes our few well-known agent CLIs from arbitrary user commands.
/// Detection is by file-basename, so paths like
/// `/Users/me/.bun/bin/claude` still match.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentFlavor {
    Claude,
    Llm,
    Unknown,
}

impl AgentFlavor {
    pub fn detect(command: &str) -> Self {
        let basename = Path::new(command)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(command);
        match basename {
            "claude" => Self::Claude,
            "llm" => Self::Llm,
            _ => Self::Unknown,
        }
    }
}

/// Build the primer string for a given control session. Substitutes the
/// session id and socket path so the agent can copy-paste examples
/// verbatim. Kept short on purpose — every byte goes into every
/// agent-call's system prompt.
pub fn primer_for(session: &Session, socket_path: &Path) -> String {
    format!(
        "You are running inside an Acorn \"control session\". You can orchestrate \
         other terminal sessions in the same project ({repo}) via the `acorn-ipc` \
         CLI.\n\
         \n\
         Your session id: {session_id}\n\
         IPC socket:      {socket}\n\
         \n\
         Available commands (project-scoped — other projects are not reachable):\n\
         \n\
           acorn-ipc list-sessions                       # see siblings + self\n\
           acorn-ipc send-keys     -t <uuid> --data '…' --enter\n\
           acorn-ipc read-buffer   -t <uuid> [--max-bytes N]\n\
           acorn-ipc new-session   <name> [--isolated]   # prints the new uuid\n\
           acorn-ipc select-session -t <uuid>            # focus a tab in the UI\n\
           acorn-ipc kill-session  -t <uuid>             # destructive — last resort\n\
         \n\
         Tips:\n\
         - Pass `--json` to any command for machine-parseable output.\n\
         - Prefer delegating CPU-bound or long-running work to sibling sessions \
         instead of running it serially here; this seat is the orchestrator.\n\
         - `read-buffer` after a `send-keys` may need a brief wait — the sibling \
         is a real PTY, not a synchronous RPC.",
        repo = session.repo_path.display(),
        session_id = session.id,
        socket = socket_path.display(),
    )
}

/// Augment `(command, args)` with the agent-specific flag that injects the
/// primer into the spawned agent's system prompt. Returns the modified
/// `args` vector. For unknown flavors the args are returned unchanged —
/// those agents still see the env vars and the `.acorn-control.md`
/// marker, just not an in-system-prompt nudge.
pub fn inject_primer_args(
    flavor: AgentFlavor,
    args: Vec<String>,
    primer: &str,
) -> Vec<String> {
    match flavor {
        AgentFlavor::Claude => prepend(args, &["--append-system-prompt", primer]),
        AgentFlavor::Llm => insert_llm_system_arg(args, primer),
        AgentFlavor::Unknown => args,
    }
}

fn prepend(mut args: Vec<String>, head: &[&str]) -> Vec<String> {
    let mut out = Vec::with_capacity(args.len() + head.len());
    out.extend(head.iter().map(|s| (*s).to_string()));
    out.append(&mut args);
    out
}

/// `llm` invocations land as either `llm` (one-shot) or `llm chat …`
/// (interactive). The `-s/--system` flag is only valid on certain
/// subcommands. We insert it right after `chat` when present, otherwise
/// prepend — the worst case is `-s` flagged onto a subcommand that does
/// not accept it, which surfaces as an immediate CLI error the user can
/// see and fix.
fn insert_llm_system_arg(args: Vec<String>, primer: &str) -> Vec<String> {
    if let Some(idx) = args.iter().position(|a| a == "chat") {
        let mut out = args.clone();
        out.insert(idx + 1, "-s".to_string());
        out.insert(idx + 2, primer.to_string());
        out
    } else {
        prepend(args, &["-s", primer])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::SessionKind;
    use std::path::PathBuf;

    fn session() -> Session {
        Session::new(
            "ctl".to_string(),
            PathBuf::from("/tmp/repo"),
            PathBuf::from("/tmp/repo"),
            "main".to_string(),
            false,
            None,
            SessionKind::Control,
        )
    }

    #[test]
    fn detect_recognizes_known_agents() {
        assert_eq!(AgentFlavor::detect("claude"), AgentFlavor::Claude);
        assert_eq!(
            AgentFlavor::detect("/usr/local/bin/claude"),
            AgentFlavor::Claude
        );
        assert_eq!(AgentFlavor::detect("llm"), AgentFlavor::Llm);
        assert_eq!(AgentFlavor::detect("bash"), AgentFlavor::Unknown);
        assert_eq!(AgentFlavor::detect("/bin/zsh"), AgentFlavor::Unknown);
    }

    #[test]
    fn primer_substitutes_session_and_socket() {
        let s = session();
        let p = primer_for(&s, &PathBuf::from("/tmp/ipc.sock"));
        assert!(p.contains(&s.id.to_string()));
        assert!(p.contains("/tmp/ipc.sock"));
        assert!(p.contains("/tmp/repo"));
        assert!(p.contains("acorn-ipc list-sessions"));
    }

    #[test]
    fn inject_claude_prepends_append_system_prompt() {
        let args = vec!["--resume".to_string()];
        let out = inject_primer_args(AgentFlavor::Claude, args, "PRIMER_TEXT");
        assert_eq!(
            out,
            vec![
                "--append-system-prompt".to_string(),
                "PRIMER_TEXT".to_string(),
                "--resume".to_string(),
            ]
        );
    }

    #[test]
    fn inject_llm_chat_inserts_dash_s_after_chat() {
        let args = vec!["chat".to_string(), "-m".to_string(), "gpt-4o".to_string()];
        let out = inject_primer_args(AgentFlavor::Llm, args, "PRIMER_TEXT");
        assert_eq!(
            out,
            vec![
                "chat".to_string(),
                "-s".to_string(),
                "PRIMER_TEXT".to_string(),
                "-m".to_string(),
                "gpt-4o".to_string(),
            ]
        );
    }

    #[test]
    fn inject_llm_oneshot_prepends_dash_s() {
        let args = vec!["-m".to_string(), "gpt-4o".to_string()];
        let out = inject_primer_args(AgentFlavor::Llm, args, "PRIMER_TEXT");
        assert_eq!(out[0], "-s");
        assert_eq!(out[1], "PRIMER_TEXT");
    }

    #[test]
    fn inject_unknown_is_passthrough() {
        let args = vec!["arg1".to_string(), "arg2".to_string()];
        let out =
            inject_primer_args(AgentFlavor::Unknown, args.clone(), "PRIMER_TEXT");
        assert_eq!(out, args);
    }
}
