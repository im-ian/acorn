use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use dashmap::DashMap;
use parking_lot::Mutex;
use serde::Serialize;
use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, Emitter, Runtime};
use uuid::Uuid;

/// Daemon/in-process readers emit ~4KB frames. Each Channel send becomes a
/// WKWebView `eval` (and a fetch round-trip above 1KB), so a TUI redraw burst
/// would otherwise pin the UI thread. Idle sessions still lead with an
/// immediate send so a keystroke echo is not delayed by the window.
const MAX_BATCH_BYTES: usize = 64 * 1024;
const FLUSH_DELAY: Duration = Duration::from_millis(8);
/// Remounts leave a brief gap with no Channel. Hold bytes this many flushes
/// before falling back to `emit`, which nobody is listening to during that gap.
const MAX_VACANT_RETRIES: u8 = 6;

#[derive(Serialize, Clone)]
pub struct OutputPayload {
    pub data: String,
}

#[derive(Clone)]
struct OutputSubscription {
    token: u64,
    channel: Channel<Response>,
}

#[derive(Default)]
struct SessionOutputBatch {
    buf: Vec<u8>,
    event: String,
    timer_armed: bool,
    vacant_retries: u8,
}

enum EnqueueEffect {
    Dispatch {
        bytes: Vec<u8>,
        event: String,
        arm_timer: bool,
    },
    Hold,
}

fn enqueue_output(batch: &mut SessionOutputBatch, event: &str, bytes: &[u8]) -> EnqueueEffect {
    if batch.event.is_empty() {
        batch.event = event.to_string();
    }
    if !batch.timer_armed && batch.buf.is_empty() {
        batch.timer_armed = true;
        return EnqueueEffect::Dispatch {
            bytes: bytes.to_vec(),
            event: batch.event.clone(),
            arm_timer: true,
        };
    }
    batch.buf.extend_from_slice(bytes);
    if batch.buf.len() >= MAX_BATCH_BYTES {
        return EnqueueEffect::Dispatch {
            bytes: std::mem::take(&mut batch.buf),
            event: batch.event.clone(),
            arm_timer: false,
        };
    }
    EnqueueEffect::Hold
}

#[derive(Default)]
struct Inner {
    next_token: AtomicU64,
    channels: DashMap<Uuid, OutputSubscription>,
    batches: Mutex<HashMap<Uuid, SessionOutputBatch>>,
    /// Held around take_flush + Channel send so a reader lead-edge cannot
    /// overtake a timer flush of earlier bytes.
    dispatch: DashMap<Uuid, Arc<Mutex<()>>>,
}

#[derive(Clone, Default)]
pub struct PtyOutputRouter {
    inner: Arc<Inner>,
}

impl PtyOutputRouter {
    pub fn subscribe(&self, session_id: Uuid, channel: Channel<Response>) -> u64 {
        let token = self.inner.next_token.fetch_add(1, Ordering::Relaxed) + 1;
        self.inner
            .channels
            .insert(session_id, OutputSubscription { token, channel });
        token
    }

    pub fn unsubscribe(&self, session_id: &Uuid, token: u64) {
        // Token-matched remove only. Flushing here would send held bytes to a
        // Channel the renderer already dropped, and a racing subscribe for
        // the same session would lose the tail. The 8ms timer delivers to
        // whoever is subscribed, or emit-fallback if no one is.
        self.inner
            .channels
            .remove_if(session_id, |_, sub| sub.token == token);
    }

    pub fn current_token(&self, session_id: &Uuid) -> Option<u64> {
        self.inner.channels.get(session_id).map(|entry| entry.token)
    }

    pub fn send_or_emit<R: Runtime + 'static>(
        &self,
        app: &AppHandle<R>,
        event: &str,
        session_id: &Uuid,
        bytes: &[u8],
    ) {
        if bytes.is_empty() {
            return;
        }
        let dispatch = self.dispatch_lock(*session_id);
        let _order = dispatch.lock();
        let effect = {
            let mut batches = self.inner.batches.lock();
            let batch = batches.entry(*session_id).or_default();
            enqueue_output(batch, event, bytes)
        };
        match effect {
            EnqueueEffect::Hold => {}
            EnqueueEffect::Dispatch {
                bytes,
                event,
                arm_timer,
            } => {
                self.deliver(app, &event, session_id, bytes, arm_timer);
            }
        }
    }

    fn dispatch_lock(&self, session_id: Uuid) -> Arc<Mutex<()>> {
        self.inner
            .dispatch
            .entry(session_id)
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    fn try_channel(&self, session_id: &Uuid, bytes: &[u8]) -> bool {
        let Some(entry) = self.inner.channels.get(session_id) else {
            return false;
        };
        let token = entry.token;
        let channel = entry.channel.clone();
        drop(entry);
        if channel.send(Response::new(bytes.to_vec())).is_ok() {
            return true;
        }
        self.unsubscribe(session_id, token);
        false
    }

    fn deliver<R: Runtime + 'static>(
        &self,
        app: &AppHandle<R>,
        event: &str,
        session_id: &Uuid,
        bytes: Vec<u8>,
        arm_timer: bool,
    ) {
        if bytes.is_empty() {
            return;
        }
        if self.try_channel(session_id, &bytes) {
            self.clear_vacant_retries(session_id);
            if arm_timer {
                self.arm_flush(app.clone(), *session_id);
            }
            return;
        }
        match self.requeue_front(*session_id, event, &bytes) {
            Some(need_arm) => {
                if need_arm {
                    self.arm_flush(app.clone(), *session_id);
                }
            }
            None => {
                let payload = OutputPayload {
                    data: base64_encode(&bytes),
                };
                if let Err(err) = app.emit(event, payload) {
                    tracing::warn!(%session_id, error = %err, "failed to emit pty output");
                }
            }
        }
    }

    fn clear_vacant_retries(&self, session_id: &Uuid) {
        let mut batches = self.inner.batches.lock();
        let Some(batch) = batches.get_mut(session_id) else {
            return;
        };
        batch.vacant_retries = 0;
        if batch.buf.is_empty() && !batch.timer_armed {
            batches.remove(session_id);
        }
    }

    /// Put bytes back at the front of the session batch. `Some(need_arm)`
    /// means they are held; `None` means the vacant-channel budget is spent.
    fn requeue_front(&self, session_id: Uuid, event: &str, bytes: &[u8]) -> Option<bool> {
        let mut batches = self.inner.batches.lock();
        let batch = batches.entry(session_id).or_default();
        if batch.vacant_retries >= MAX_VACANT_RETRIES {
            return None;
        }
        batch.vacant_retries += 1;
        if batch.event.is_empty() {
            batch.event = event.to_string();
        }
        let mut combined = bytes.to_vec();
        combined.append(&mut batch.buf);
        batch.buf = combined;
        let need_arm = !batch.timer_armed;
        batch.timer_armed = true;
        Some(need_arm)
    }

    fn arm_flush<R: Runtime + 'static>(&self, app: AppHandle<R>, session_id: Uuid) {
        let router = self.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(FLUSH_DELAY).await;
            router.flush_session(&app, session_id);
        });
    }

    fn flush_session<R: Runtime + 'static>(&self, app: &AppHandle<R>, session_id: Uuid) {
        let dispatch = self.dispatch_lock(session_id);
        let _order = dispatch.lock();
        let (event, bytes) = self.take_flush(&session_id);
        self.deliver(app, &event, &session_id, bytes, false);
    }

    fn take_flush(&self, session_id: &Uuid) -> (String, Vec<u8>) {
        let mut batches = self.inner.batches.lock();
        let Some(batch) = batches.get_mut(session_id) else {
            return (String::new(), Vec::new());
        };
        batch.timer_armed = false;
        let event = std::mem::take(&mut batch.event);
        let bytes = std::mem::take(&mut batch.buf);
        let vacant = batch.vacant_retries;
        if bytes.is_empty() {
            batches.remove(session_id);
            return (event, bytes);
        }
        // Keep vacant_retries on an empty leftover entry so deliver's
        // requeue can see the budget. Stash it on a fresh placeholder.
        *batch = SessionOutputBatch {
            vacant_retries: vacant,
            ..SessionOutputBatch::default()
        };
        (event, bytes)
    }
}

/// Minimal RFC 4648 base64 encoder. Kept local so fallback event delivery
/// stays dependency-free on the hot PTY output path.
pub fn base64_encode(input: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);
    let mut chunks = input.chunks_exact(3);
    for chunk in &mut chunks {
        let n = (u32::from(chunk[0]) << 16) | (u32::from(chunk[1]) << 8) | u32::from(chunk[2]);
        out.push(ALPHABET[((n >> 18) & 0x3f) as usize] as char);
        out.push(ALPHABET[((n >> 12) & 0x3f) as usize] as char);
        out.push(ALPHABET[((n >> 6) & 0x3f) as usize] as char);
        out.push(ALPHABET[(n & 0x3f) as usize] as char);
    }
    let rem = chunks.remainder();
    match rem.len() {
        0 => {}
        1 => {
            let n = u32::from(rem[0]) << 16;
            out.push(ALPHABET[((n >> 18) & 0x3f) as usize] as char);
            out.push(ALPHABET[((n >> 12) & 0x3f) as usize] as char);
            out.push('=');
            out.push('=');
        }
        2 => {
            let n = (u32::from(rem[0]) << 16) | (u32::from(rem[1]) << 8);
            out.push(ALPHABET[((n >> 18) & 0x3f) as usize] as char);
            out.push(ALPHABET[((n >> 12) & 0x3f) as usize] as char);
            out.push(ALPHABET[((n >> 6) & 0x3f) as usize] as char);
            out.push('=');
        }
        _ => unreachable!(),
    }
    out
}

pub fn base64_decode(input: &str) -> Option<Vec<u8>> {
    fn val(b: u8) -> Option<u8> {
        match b {
            b'A'..=b'Z' => Some(b - b'A'),
            b'a'..=b'z' => Some(b - b'a' + 26),
            b'0'..=b'9' => Some(b - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            b'=' => Some(64),
            _ => None,
        }
    }

    let bytes = input.as_bytes();
    if bytes.len() % 4 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for chunk in bytes.chunks_exact(4) {
        let a = val(chunk[0])?;
        let b = val(chunk[1])?;
        let c = val(chunk[2])?;
        let d = val(chunk[3])?;
        if a >= 64 || b >= 64 {
            return None;
        }
        out.push((a << 2) | (b >> 4));
        if c == 64 {
            if d != 64 {
                return None;
            }
            continue;
        }
        if c > 64 {
            return None;
        }
        out.push(((b & 0x0f) << 4) | (c >> 2));
        if d == 64 {
            continue;
        }
        if d > 64 {
            return None;
        }
        out.push(((c & 0x03) << 6) | d);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_encodes_known_vectors() {
        assert_eq!(base64_encode(&[]), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"Man"), "TWFu");
        assert_eq!(base64_encode(b"hello world"), "aGVsbG8gd29ybGQ=");
    }

    #[test]
    fn base64_decodes_known_vectors() {
        assert_eq!(base64_decode("").unwrap(), b"");
        assert_eq!(base64_decode("Zg==").unwrap(), b"f");
        assert_eq!(base64_decode("Zm8=").unwrap(), b"fo");
        assert_eq!(base64_decode("Zm9v").unwrap(), b"foo");
        assert_eq!(base64_decode("TWFu").unwrap(), b"Man");
        assert_eq!(base64_decode("aGVsbG8gd29ybGQ=").unwrap(), b"hello world");
    }

    #[test]
    fn base64_rejects_bad_padding() {
        assert!(base64_decode("Zg=A").is_none());
        assert!(base64_decode("Zg=").is_none());
        assert!(base64_decode("not!").is_none());
    }

    #[test]
    fn first_chunk_dispatches_immediately_and_opens_the_window() {
        let mut batch = SessionOutputBatch::default();
        match enqueue_output(&mut batch, "pty:output:a", b"hi") {
            EnqueueEffect::Dispatch {
                bytes,
                event,
                arm_timer,
            } => {
                assert_eq!(bytes, b"hi");
                assert_eq!(event, "pty:output:a");
                assert!(arm_timer);
            }
            EnqueueEffect::Hold => panic!("idle session should lead with a send"),
        }
        assert!(batch.timer_armed);
        assert!(batch.buf.is_empty());
    }

    #[test]
    fn chunks_inside_the_window_are_held_until_flush() {
        let mut batch = SessionOutputBatch::default();
        let _ = enqueue_output(&mut batch, "pty:output:a", b"a");
        assert!(matches!(
            enqueue_output(&mut batch, "pty:output:a", b"b"),
            EnqueueEffect::Hold
        ));
        assert_eq!(batch.buf, b"b");
    }

    #[test]
    fn oversized_hold_buffer_flushes_without_arming_another_timer() {
        let mut batch = SessionOutputBatch::default();
        let _ = enqueue_output(&mut batch, "pty:output:a", b"lead");
        let payload = vec![b'x'; MAX_BATCH_BYTES];
        match enqueue_output(&mut batch, "pty:output:a", &payload) {
            EnqueueEffect::Dispatch {
                bytes, arm_timer, ..
            } => {
                assert_eq!(bytes.len(), MAX_BATCH_BYTES);
                assert!(!arm_timer);
            }
            EnqueueEffect::Hold => panic!("64KB catch-up should dispatch"),
        }
        assert!(batch.timer_armed);
        assert!(batch.buf.is_empty());
    }
}
