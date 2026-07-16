//! Session-state primitives shared across the Acorn app and its sibling
//! tools. Pulled out of the main `acorn` crate so changes to unrelated
//! Tauri command surfaces do not force a recompile of these stable types.
//!
//! Three submodules:
//!
//! - [`session`] — `Project` / `Session` records and their in-memory stores.
//! - [`status`] — JSONL-transcript-tail parser that maps the last meaningful
//!   line to a `SessionStatus`.
//! - [`scrollback`] — per-session terminal scrollback persistence under a
//!   caller-provided data directory.

pub mod scrollback;
pub mod session;
pub mod status;

pub use session::{
    AgentStatusSource, Project, ProjectStore, Session, SessionAgentProvider, SessionError,
    SessionKind, SessionMode, SessionOwner, SessionResult, SessionStatus, SessionStore,
    SessionTitleSource,
};
