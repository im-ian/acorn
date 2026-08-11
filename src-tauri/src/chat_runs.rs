use std::collections::HashMap;
use std::process::{Child, ExitStatus};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use acorn_platform::process::ProcessTree;

#[derive(Clone)]
pub struct ChatCancellation {
    inner: Arc<ChatCancellationInner>,
}

struct ChatCancellationInner {
    turn_id: String,
    cancelled: AtomicBool,
    child: Mutex<Option<TrackedChild>>,
}

struct TrackedChild {
    child: Child,
    tree: Arc<ProcessTree>,
}

impl ChatCancellation {
    pub(crate) fn new(turn_id: String) -> Self {
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

    pub fn set_child(&self, child: Child, tree: Arc<ProcessTree>) {
        *self.inner.child.lock() = Some(TrackedChild { child, tree });
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
            .child
            .try_wait()
            .map_err(|e| AppError::Other(format!("failed waiting for {command}: {e}")))
    }

    pub fn cancel(&self) {
        self.inner.cancelled.store(true, Ordering::SeqCst);
        if let Some(tracked) = self.inner.child.lock().as_mut() {
            let _ = tracked.tree.terminate();
            let _ = tracked.child.kill();
        }
    }

    pub fn kill_and_wait(&self) {
        if let Some(tracked) = self.inner.child.lock().as_mut() {
            let _ = tracked.tree.terminate();
            let _ = tracked.child.kill();
            let _ = tracked.child.wait();
        }
    }
}

#[derive(Clone)]
pub struct GraphCancellation {
    inner: Arc<GraphCancellationInner>,
}

struct GraphCancellationInner {
    run_id: String,
    cancelled: AtomicBool,
    children: Mutex<HashMap<String, ChatCancellation>>,
}

impl GraphCancellation {
    fn new(run_id: String) -> Self {
        Self {
            inner: Arc::new(GraphCancellationInner {
                run_id,
                cancelled: AtomicBool::new(false),
                children: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub fn run_id(&self) -> &str {
        &self.inner.run_id
    }

    pub fn is_cancelled(&self) -> bool {
        self.inner.cancelled.load(Ordering::SeqCst)
    }

    pub fn register_child(&self, key: String) -> ChatCancellation {
        let cancellation = ChatCancellation::new(key.clone());
        self.inner.children.lock().insert(key, cancellation.clone());
        if self.is_cancelled() {
            cancellation.cancel();
        }
        cancellation
    }

    pub fn finish_child(&self, key: &str) {
        self.inner.children.lock().remove(key);
    }

    pub fn cancel(&self) {
        self.inner.cancelled.store(true, Ordering::SeqCst);
        let children = self
            .inner
            .children
            .lock()
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for child in children {
            child.cancel();
        }
    }
}

enum ActiveRun {
    Chat(ChatCancellation),
    Graph(GraphCancellation),
}

#[derive(Default)]
pub struct ChatRunRegistry {
    active: Mutex<HashMap<Uuid, ActiveRun>>,
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
        active.insert(session_id, ActiveRun::Chat(cancellation.clone()));
        Ok(cancellation)
    }

    pub fn cancel(&self, session_id: &Uuid) -> Option<ChatCancellation> {
        let active = self.active.lock();
        let ActiveRun::Chat(cancellation) = active.get(session_id)? else {
            return None;
        };
        let cancellation = cancellation.clone();
        drop(active);
        cancellation.cancel();
        Some(cancellation)
    }

    pub fn start_graph(&self, session_id: Uuid, run_id: String) -> AppResult<GraphCancellation> {
        let mut active = self.active.lock();
        if active.contains_key(&session_id) {
            return Err(AppError::Other(format!(
                "session is already running: {session_id}"
            )));
        }
        let cancellation = GraphCancellation::new(run_id);
        active.insert(session_id, ActiveRun::Graph(cancellation.clone()));
        Ok(cancellation)
    }

    pub fn cancel_graph(&self, session_id: &Uuid, run_id: &str) -> Option<GraphCancellation> {
        let active = self.active.lock();
        let ActiveRun::Graph(cancellation) = active.get(session_id)? else {
            return None;
        };
        if cancellation.run_id() != run_id {
            return None;
        }
        let cancellation = cancellation.clone();
        drop(active);
        cancellation.cancel();
        Some(cancellation)
    }

    pub fn cancel_active(&self, session_id: &Uuid) -> bool {
        let active = self.active.lock();
        let Some(active) = active.get(session_id) else {
            return false;
        };
        match active {
            ActiveRun::Chat(cancellation) => cancellation.cancel(),
            ActiveRun::Graph(cancellation) => cancellation.cancel(),
        }
        true
    }

    pub fn is_active(&self, session_id: &Uuid) -> bool {
        self.active.lock().contains_key(session_id)
    }

    pub fn finish(&self, session_id: &Uuid, turn_id: &str) {
        let mut active = self.active.lock();
        let should_remove = active
            .get(session_id)
            .and_then(|active| match active {
                ActiveRun::Chat(cancellation) => Some(cancellation.turn_id() == turn_id),
                ActiveRun::Graph(_) => None,
            })
            .unwrap_or(false);
        if should_remove {
            active.remove(session_id);
        }
    }

    pub fn finish_graph(&self, session_id: &Uuid, run_id: &str) {
        let mut active = self.active.lock();
        let should_remove = active
            .get(session_id)
            .and_then(|active| match active {
                ActiveRun::Graph(cancellation) => Some(cancellation.run_id() == run_id),
                ActiveRun::Chat(_) => None,
            })
            .unwrap_or(false);
        if should_remove {
            active.remove(session_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ChatRunRegistry;
    use uuid::Uuid;

    #[test]
    fn registry_reports_active_sessions() {
        let registry = ChatRunRegistry::default();
        let session_id = Uuid::new_v4();

        assert!(!registry.is_active(&session_id));
        let cancellation = registry
            .start(session_id, "turn-1".to_string())
            .expect("start chat run");
        assert!(registry.is_active(&session_id));

        registry.finish(&session_id, cancellation.turn_id());

        assert!(!registry.is_active(&session_id));
    }

    #[test]
    fn graph_cancellation_reaches_every_registered_node() {
        let registry = ChatRunRegistry::default();
        let session_id = Uuid::new_v4();
        let graph = registry
            .start_graph(session_id, "run-1".to_string())
            .expect("start graph run");
        let first = graph.register_child("node-a:1".to_string());
        let second = graph.register_child("node-b:1".to_string());

        registry
            .cancel_graph(&session_id, "run-1")
            .expect("active graph cancellation");

        assert!(first.is_cancelled());
        assert!(second.is_cancelled());
        registry.finish_graph(&session_id, "run-1");
        assert!(!registry.is_active(&session_id));
    }

    #[test]
    fn active_session_cancellation_handles_chat_turns_without_a_turn_id() {
        let registry = ChatRunRegistry::default();
        let session_id = Uuid::new_v4();
        let cancellation = registry
            .start(session_id, "turn-1".to_string())
            .expect("start chat run");

        assert!(registry.cancel_active(&session_id));
        assert!(cancellation.is_cancelled());

        registry.finish(&session_id, cancellation.turn_id());
        assert!(!registry.cancel_active(&session_id));
    }
}
