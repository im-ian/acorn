//! Per-session scrollback ring buffer kept in RAM by the daemon.
//!
//! Sized to match Acorn's xterm.js `scrollback: 5000` setting so the
//! daemon's replay on reattach is never shorter than what the user
//! could already scroll back to in the live terminal: whichever of
//! `LINE_CAP` rows or `BYTE_CAP` bytes is reached first triggers
//! eviction of the oldest bytes. Newlines are counted, not parsed — escape
//! sequences (`\x1b[…`) pass through verbatim so a stream replay reproduces
//! the user's exact prior screen state on reattach.
//!
//! Why both caps:
//!
//! * `BYTE_CAP` alone allows a build-log session to overflow into hundreds of
//!   thousands of short lines — fast to render in xterm.js when streamed
//!   live, painful when dumped in one replay.
//! * `LINE_CAP` alone is fooled by very long lines (a single 2 MB line
//!   bypasses the row limit) — replay then balloons the daemon's RSS.
//!
//! Both bounds enforced lazily on every append, so the steady-state cost is
//! one `VecDeque::extend` plus an O(n) drain when the cap is crossed (rare).

use parking_lot::Mutex;
use std::collections::VecDeque;

/// Maximum line count retained (xterm.js scrollback parity). Lines are
/// counted by `\n` occurrences in the byte stream; non-terminated trailing
/// data counts as a partial line and is not evicted until it is completed.
pub const LINE_CAP: usize = 5_000;

/// Maximum byte count retained. ~4 MB matches Acorn's previous
/// `TAIL_BUFFER_CAP` so the daemon does not regress memory pressure
/// compared to the in-process implementation.
pub const BYTE_CAP: usize = 4 * 1024 * 1024;

/// Concurrent-safe ring of PTY output bytes for a single session.
///
/// `Mutex<VecDeque<u8>>` was deliberately picked over a lockless ringbuf:
/// the daemon's read loop is the only writer, attach handlers are the only
/// readers, and the contention window is microseconds. A lockless queue
/// would complicate the eviction policy (we need an exact byte count at
/// eviction time, which lockless ring readers cannot observe atomically).
pub struct RingBuffer {
    bytes: Mutex<VecDeque<u8>>,
    newlines: Mutex<VecDeque<usize>>,
}

impl Default for RingBuffer {
    fn default() -> Self {
        Self::new()
    }
}

impl RingBuffer {
    pub fn new() -> Self {
        Self {
            // Pre-reserve to avoid early reallocations during the first
            // burst of PTY output after spawn.
            bytes: Mutex::new(VecDeque::with_capacity(8 * 1024)),
            newlines: Mutex::new(VecDeque::with_capacity(LINE_CAP / 8)),
        }
    }

    /// Append a chunk of bytes. Older bytes/lines are evicted from the
    /// front until both `BYTE_CAP` and `LINE_CAP` invariants hold.
    pub fn push(&self, chunk: &[u8]) {
        if chunk.is_empty() {
            return;
        }
        let mut bytes = self.bytes.lock();
        let mut newlines = self.newlines.lock();

        // 1) Append. Track each new newline by its absolute position
        //    BEFORE eviction (we rebase the indices after byte-eviction
        //    by subtracting the drop count so they remain valid as
        //    offsets into the (now-shorter) deque).
        let base = bytes.len();
        for (i, b) in chunk.iter().enumerate() {
            if *b == b'\n' {
                newlines.push_back(base + i);
            }
        }
        bytes.extend(chunk.iter().copied());

        // 2) Evict by byte cap. Determine drop count once and apply to
        //    both deques. Eviction is allowed to chop mid-line — the
        //    next-newline rebase keeps line counts coherent because we
        //    drop newline indices that fall inside the dropped prefix.
        let overflow = bytes.len().saturating_sub(BYTE_CAP);
        if overflow > 0 {
            drop_front_bytes(&mut bytes, overflow);
            // Rebase newline indices. After dropping `overflow` bytes,
            // every retained newline index N becomes (N - overflow).
            // Drop indices that fell below 0.
            while let Some(&front) = newlines.front() {
                if front < overflow {
                    newlines.pop_front();
                } else {
                    break;
                }
            }
            for n in newlines.iter_mut() {
                *n -= overflow;
            }
        }

        // 3) Evict by line cap. If the line count exceeds LINE_CAP, drop
        //    bytes from the front up to (and including) the oldest
        //    surplus newline. This keeps the ring's "logical row" count
        //    bounded even when individual lines are short.
        while newlines.len() > LINE_CAP {
            // Safe: the while-condition guarantees at least LINE_CAP+1
            // entries; `pop_front` cannot return None here.
            let cutover = newlines.pop_front().expect("invariant: surplus exists");
            // Drop bytes 0..=cutover (inclusive of the newline itself).
            drop_front_bytes(&mut bytes, cutover + 1);
            // Rebase remaining newline indices by (cutover + 1).
            for n in newlines.iter_mut() {
                *n = n.saturating_sub(cutover + 1);
            }
        }
    }

    /// Snapshot up to `max_bytes` of the freshest bytes. Returns
    /// `(bytes, truncated)` where `truncated` is `true` iff the underlying
    /// ring held more bytes than were returned.
    pub fn tail(&self, max_bytes: usize) -> (Vec<u8>, bool) {
        let buf = self.bytes.lock();
        let total = buf.len();
        let take = max_bytes.min(total);
        let start = total - take;
        let slice: Vec<u8> = buf.iter().skip(start).copied().collect();
        (slice, total > take)
    }

    /// Snapshot the entire current ring contents. Used on reattach when
    /// `replay_scrollback = true` so the client sees exactly what the
    /// previous session left on the screen.
    pub fn snapshot(&self) -> Vec<u8> {
        let buf = self.bytes.lock();
        buf.iter().copied().collect()
    }

    /// Current byte length, for status reporting.
    pub fn byte_len(&self) -> usize {
        self.bytes.lock().len()
    }

    /// Current line count (newlines observed), for status reporting.
    pub fn line_count(&self) -> usize {
        self.newlines.lock().len()
    }
}

/// Drop the first `n` bytes from a `VecDeque<u8>`, no-op if `n == 0`.
/// Pulled out so the eviction paths read linearly.
fn drop_front_bytes(buf: &mut VecDeque<u8>, n: usize) {
    if n == 0 {
        return;
    }
    if n >= buf.len() {
        buf.clear();
    } else {
        buf.drain(..n);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_push_is_noop() {
        let r = RingBuffer::new();
        r.push(b"");
        assert_eq!(r.byte_len(), 0);
        assert_eq!(r.line_count(), 0);
    }

    #[test]
    fn appends_under_caps() {
        let r = RingBuffer::new();
        r.push(b"hello\nworld\n");
        assert_eq!(r.byte_len(), 12);
        assert_eq!(r.line_count(), 2);
        let (snap, truncated) = r.tail(1024);
        assert_eq!(snap, b"hello\nworld\n");
        assert!(!truncated);
    }

    #[test]
    fn evicts_oldest_bytes_when_byte_cap_exceeded() {
        let r = RingBuffer::new();
        let chunk_a = vec![1u8; BYTE_CAP];
        let chunk_b = vec![2u8; BYTE_CAP];
        r.push(&chunk_a);
        r.push(&chunk_b);
        assert_eq!(r.byte_len(), BYTE_CAP);
        let snap = r.snapshot();
        assert!(snap.iter().all(|&b| b == 2));
    }

    #[test]
    fn evicts_oldest_lines_when_line_cap_exceeded() {
        let r = RingBuffer::new();
        // Push 2 × LINE_CAP single-char lines; only the last LINE_CAP
        // should remain.
        let many_lines: String = (0..(LINE_CAP * 2))
            .map(|i| format!("L{i}\n"))
            .collect();
        r.push(many_lines.as_bytes());
        assert_eq!(r.line_count(), LINE_CAP);
        let snap = r.snapshot();
        // First retained line must start with "L<LINE_CAP>" because
        // lines 0..LINE_CAP were evicted.
        let head: String = String::from_utf8_lossy(&snap).chars().take(20).collect();
        assert!(head.starts_with(&format!("L{LINE_CAP}\n")), "head was {head:?}");
    }

    #[test]
    fn newline_indices_stay_coherent_across_byte_eviction() {
        // Regression guard: byte-cap eviction must drop newline indices
        // that fall into the evicted prefix and rebase the rest.
        let r = RingBuffer::new();
        // Half-cap of "aa\n" units, then a single jumbo line that
        // pushes the first half out by the byte cap.
        let unit = b"aa\n";
        let units_to_fill_half = (BYTE_CAP / 2) / unit.len();
        let initial: Vec<u8> = unit
            .iter()
            .copied()
            .cycle()
            .take(units_to_fill_half * unit.len())
            .collect();
        r.push(&initial);
        let lines_before = r.line_count();
        // Now push enough bytes (no newlines) to crowd the older content
        // out of the byte cap entirely.
        let crowd = vec![b'X'; BYTE_CAP];
        r.push(&crowd);
        // All original newlines should be gone (they were in the dropped
        // prefix); line_count should be 0 because the trailing crowd
        // contained no '\n'.
        assert_eq!(r.line_count(), 0);
        assert!(lines_before > 0);
        assert!(r.byte_len() <= BYTE_CAP);
    }

    #[test]
    fn tail_returns_truncation_signal_when_buffer_larger_than_max() {
        let r = RingBuffer::new();
        r.push(&vec![b'Z'; 1024]);
        let (snap, truncated) = r.tail(100);
        assert_eq!(snap.len(), 100);
        assert!(truncated);
        assert!(snap.iter().all(|&b| b == b'Z'));
    }
}
