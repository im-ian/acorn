use std::sync::atomic::{AtomicU64, Ordering};

use dashmap::DashMap;
use serde::Serialize;
use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, Emitter, Runtime};
use uuid::Uuid;

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
pub struct PtyOutputRouter {
    next_token: AtomicU64,
    channels: DashMap<Uuid, OutputSubscription>,
}

impl PtyOutputRouter {
    pub fn subscribe(&self, session_id: Uuid, channel: Channel<Response>) -> u64 {
        let token = self.next_token.fetch_add(1, Ordering::Relaxed) + 1;
        self.channels
            .insert(session_id, OutputSubscription { token, channel });
        token
    }

    pub fn unsubscribe(&self, session_id: &Uuid, token: u64) {
        let should_remove = self
            .channels
            .get(session_id)
            .map(|entry| entry.token == token)
            .unwrap_or(false);
        if should_remove {
            self.channels.remove(session_id);
        }
    }

    pub fn current_token(&self, session_id: &Uuid) -> Option<u64> {
        self.channels.get(session_id).map(|entry| entry.token)
    }

    pub fn send_or_emit<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        event: &str,
        session_id: &Uuid,
        bytes: &[u8],
    ) {
        if let Some(entry) = self.channels.get(session_id) {
            let token = entry.token;
            let channel = entry.channel.clone();
            drop(entry);

            if channel.send(Response::new(bytes.to_vec())).is_ok() {
                return;
            }

            self.unsubscribe(session_id, token);
        }

        let payload = OutputPayload {
            data: base64_encode(bytes),
        };
        if let Err(err) = app.emit(event, payload) {
            tracing::warn!(%session_id, error = %err, "failed to emit pty output");
        }
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
}
