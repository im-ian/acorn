use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("git error: {0}")]
    Git(#[from] git2::Error),

    #[error("session not found: {0}")]
    SessionNotFound(String),

    #[error("invalid path: {0}")]
    InvalidPath(String),

    #[error("pty error: {0}")]
    Pty(String),

    #[error("{0}")]
    Other(String),
}

impl From<anyhow::Error> for AppError {
    fn from(value: anyhow::Error) -> Self {
        AppError::Other(value.to_string())
    }
}

impl From<acorn_session::SessionError> for AppError {
    fn from(value: acorn_session::SessionError) -> Self {
        match value {
            acorn_session::SessionError::NotFound(id) => AppError::SessionNotFound(id),
        }
    }
}

impl From<acorn_session::scrollback::ScrollbackError> for AppError {
    fn from(value: acorn_session::scrollback::ScrollbackError) -> Self {
        match value {
            acorn_session::scrollback::ScrollbackError::Io(err) => AppError::Io(err),
            acorn_session::scrollback::ScrollbackError::InvalidSessionId(id) => {
                AppError::Other(format!("invalid session id: {id}"))
            }
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
