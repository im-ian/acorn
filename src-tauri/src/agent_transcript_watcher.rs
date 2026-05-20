use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::agent_resume;
use crate::state::AppState;

pub const AGENT_TRANSCRIPT_ADVANCED_EVENT: &str = "acorn:agent-transcript-advanced";

const POLL_INTERVAL: Duration = Duration::from_millis(300);
const MAPPING_REFRESH_INTERVAL: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTranscriptAdvancedPayload {
    pub session_id: String,
    pub transcript_path: String,
    pub size: u64,
    pub updated_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TranscriptCursor {
    path: PathBuf,
    size: u64,
    modified: Option<SystemTime>,
}

impl TranscriptCursor {
    fn updated_at(&self) -> u64 {
        self.modified
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs())
            .unwrap_or(0)
    }
}

pub fn spawn(app: AppHandle, state: AppState) {
    std::thread::Builder::new()
        .name("acorn-transcript-watcher".into())
        .spawn(move || run(app, state))
        .map(drop)
        .unwrap_or_else(|err| {
            tracing::warn!(error = %err, "agent_transcript_watcher: thread spawn failed");
        });
}

fn run(app: AppHandle, state: AppState) {
    let mut cursors = HashMap::new();
    let mut last_mapping_refresh = Instant::now() - MAPPING_REFRESH_INTERVAL;
    loop {
        std::thread::sleep(POLL_INTERVAL);
        let refresh_mappings = last_mapping_refresh.elapsed() >= MAPPING_REFRESH_INTERVAL;
        tick(&app, &state, &mut cursors, refresh_mappings);
        if refresh_mappings {
            last_mapping_refresh = Instant::now();
        }
    }
}

fn tick(
    app: &AppHandle,
    state: &AppState,
    cursors: &mut HashMap<Uuid, TranscriptCursor>,
    refresh_mappings: bool,
) {
    let sessions = state.sessions.list();
    let live_ids = sessions
        .iter()
        .map(|session| session.id)
        .collect::<HashSet<_>>();
    cursors.retain(|session_id, _| live_ids.contains(session_id));

    for session in sessions {
        let path = match (refresh_mappings, cursors.get(&session.id)) {
            (true, _) | (_, None) => match agent_resume::live_transcript(session.id) {
                Some(transcript) => transcript.path,
                None => {
                    cursors.remove(&session.id);
                    continue;
                }
            },
            (false, Some(cursor)) => cursor.path.clone(),
        };

        let Some(next) = stat_cursor(path) else {
            cursors.remove(&session.id);
            continue;
        };

        if !transcript_advanced(cursors.get(&session.id), &next) {
            cursors.insert(session.id, next);
            continue;
        }

        let payload = AgentTranscriptAdvancedPayload {
            session_id: session.id.to_string(),
            transcript_path: next.path.display().to_string(),
            size: next.size,
            updated_at: next.updated_at(),
        };

        if let Err(err) = app.emit(AGENT_TRANSCRIPT_ADVANCED_EVENT, payload) {
            tracing::warn!(
                error = %err,
                event = AGENT_TRANSCRIPT_ADVANCED_EVENT,
                "agent_transcript_watcher: emit failed",
            );
        }

        cursors.insert(session.id, next);
    }
}

fn stat_cursor(path: PathBuf) -> Option<TranscriptCursor> {
    let metadata = fs::metadata(&path).ok()?;
    Some(TranscriptCursor {
        path,
        size: metadata.len(),
        modified: metadata.modified().ok(),
    })
}

fn transcript_advanced(previous: Option<&TranscriptCursor>, next: &TranscriptCursor) -> bool {
    match previous {
        None => next.size > 0,
        Some(previous) => {
            previous.path != next.path
                || previous.size != next.size
                || previous.modified != next.modified
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{transcript_advanced, TranscriptCursor};
    use std::path::PathBuf;
    use std::time::{Duration, UNIX_EPOCH};

    fn cursor(path: &str, size: u64, seconds: u64) -> TranscriptCursor {
        TranscriptCursor {
            path: PathBuf::from(path),
            size,
            modified: Some(UNIX_EPOCH + Duration::from_secs(seconds)),
        }
    }

    #[test]
    fn first_non_empty_cursor_counts_as_advanced() {
        assert!(transcript_advanced(None, &cursor("a.jsonl", 1, 1)));
        assert!(!transcript_advanced(None, &cursor("a.jsonl", 0, 1)));
    }

    #[test]
    fn size_mtime_or_path_change_counts_as_advanced() {
        let previous = cursor("a.jsonl", 10, 1);

        assert!(!transcript_advanced(
            Some(&previous),
            &cursor("a.jsonl", 10, 1)
        ));
        assert!(transcript_advanced(
            Some(&previous),
            &cursor("a.jsonl", 11, 1)
        ));
        assert!(transcript_advanced(
            Some(&previous),
            &cursor("a.jsonl", 10, 2)
        ));
        assert!(transcript_advanced(
            Some(&previous),
            &cursor("b.jsonl", 10, 1)
        ));
    }
}
