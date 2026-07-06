use serde::{Deserialize, Serialize};

/// Interactive CLI agents Acorn can classify across session, transcript,
/// resume, and hook flows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentKind {
    Claude,
    Codex,
    Antigravity,
}

impl AgentKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Antigravity => "antigravity",
        }
    }

    pub const fn supports_hooks(self) -> bool {
        matches!(self, Self::Claude | Self::Codex | Self::Antigravity)
    }

    pub const fn hook_provider_env_value(self) -> &'static str {
        self.as_str()
    }
}
