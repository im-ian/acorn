use std::collections::HashMap;
use std::process::{Child, ExitStatus};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use uuid::Uuid;

use crate::error::{AppError, AppResult};

#[derive(Clone)]
pub struct ChatCancellation {
    inner: Arc<ChatCancellationInner>,
}

struct ChatCancellationInner {
    turn_id: String,
    cancelled: AtomicBool,
    child: Mutex<Option<Child>>,
}

impl ChatCancellation {
    fn new(turn_id: String) -> Self {
        Self {
            inner: Arc::new(ChatCancellationInner {
                turn_id,
                cancelled: AtomicBool::new(false),
                child: Mutex::new(None),
            }),
        }
    }

    pub fn turn_id(&self) -> &str {
        &self.inner.turn_id
    }

    pub fn is_cancelled(&self) -> bool {
        self.inner.cancelled.load(Ordering::SeqCst)
    }

    pub fn set_child(&self, child: Child) {
        *self.inner.child.lock() = Some(child);
    }

    pub fn clear_child(&self) {
        *self.inner.child.lock() = None;
    }

    pub fn try_wait(&self, command: &str) -> AppResult<Option<ExitStatus>> {
        let mut guard = self.inner.child.lock();
        let child = guard
            .as_mut()
            .ok_or_else(|| AppError::Other(format!("{command} child missing")))?;
        child
            .try_wait()
            .map_err(|e| AppError::Other(format!("failed waiting for {command}: {e}")))
    }

    pub fn cancel(&self) {
        self.inner.cancelled.store(true, Ordering::SeqCst);
        if let Some(child) = self.inner.child.lock().as_mut() {
            let _ = child.kill();
        }
    }

    pub fn kill_and_wait(&self) {
        if let Some(child) = self.inner.child.lock().as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[derive(Default)]
pub struct ChatRunRegistry {
    active: Mutex<HashMap<Uuid, ChatCancellation>>,
}

impl ChatRunRegistry {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn start(&self, session_id: Uuid, turn_id: String) -> AppResult<ChatCancellation> {
        let mut active = self.active.lock();
        if active.contains_key(&session_id) {
            return Err(AppError::Other(format!(
                "chat session is already running: {session_id}"
            )));
        }
        let cancellation = ChatCancellation::new(turn_id);
        active.insert(session_id, cancellation.clone());
        Ok(cancellation)
    }

    pub fn cancel(&self, session_id: &Uuid) -> Option<ChatCancellation> {
        let cancellation = self.active.lock().get(session_id).cloned()?;
        cancellation.cancel();
        Some(cancellation)
    }

    pub fn finish(&self, session_id: &Uuid, turn_id: &str) {
        let mut active = self.active.lock();
        let should_remove = active
            .get(session_id)
            .map(|cancellation| cancellation.turn_id() == turn_id)
            .unwrap_or(false);
        if should_remove {
            active.remove(session_id);
        }
    }
}
