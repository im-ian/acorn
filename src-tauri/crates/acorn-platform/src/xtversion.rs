//! XTVERSION (CSI > 0 q) matching for PTY reader threads.
//!
//! Overlay TUIs such as Grok probe `CSI > 0 q` and treat a late DCS reply as
//! leftover input, which paints `>|xterm.js` into the viewport.

use std::io::Write;

/// DCS `>|xterm.js` ST. Grok keys off the `xterm.js` name to stay on the
/// non-kitty overlay path.
pub const XTVERSION_REPLY: &[u8] = b"\x1bP>|xterm.js\x1b\\";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
enum State {
    #[default]
    Ground,
    Esc,
    Csi,
    Gt,
    GtZero,
}

/// Incremental scanner for `CSI > 0 q` / `CSI > q`, including 8-bit CSI and
/// probes split across reads.
#[derive(Debug, Default)]
pub struct XtversionProbe {
    state: State,
}

impl XtversionProbe {
    pub fn push(&mut self, bytes: &[u8]) -> usize {
        let mut hits = 0;
        for &byte in bytes {
            if self.feed(byte) {
                hits += 1;
            }
        }
        hits
    }

    fn feed(&mut self, byte: u8) -> bool {
        match self.state {
            State::Ground => {
                self.state = match byte {
                    0x1b => State::Esc,
                    0x9b => State::Csi,
                    _ => State::Ground,
                };
                false
            }
            State::Esc => {
                self.state = match byte {
                    b'[' => State::Csi,
                    0x1b => State::Esc,
                    0x9b => State::Csi,
                    _ => State::Ground,
                };
                false
            }
            State::Csi => {
                self.state = match byte {
                    b'>' => State::Gt,
                    0x1b => State::Esc,
                    0x9b => State::Csi,
                    _ => State::Ground,
                };
                false
            }
            State::Gt => match byte {
                b'q' => {
                    self.state = State::Ground;
                    true
                }
                b'0' => {
                    self.state = State::GtZero;
                    false
                }
                0x1b => {
                    self.state = State::Esc;
                    false
                }
                0x9b => {
                    self.state = State::Csi;
                    false
                }
                _ => {
                    self.state = State::Ground;
                    false
                }
            },
            State::GtZero => match byte {
                b'q' => {
                    self.state = State::Ground;
                    true
                }
                b'0' => false,
                0x1b => {
                    self.state = State::Esc;
                    false
                }
                0x9b => {
                    self.state = State::Csi;
                    false
                }
                _ => {
                    self.state = State::Ground;
                    false
                }
            },
        }
    }
}

pub fn write_replies(hits: usize, writer: &mut dyn Write) {
    for _ in 0..hits {
        if writer.write_all(XTVERSION_REPLY).is_err() {
            return;
        }
    }
    if hits > 0 {
        let _ = writer.flush();
    }
}

pub fn answer_probes(probe: &mut XtversionProbe, bytes: &[u8], writer: &mut dyn Write) {
    write_replies(probe.push(bytes), writer);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hits(chunks: &[&[u8]]) -> usize {
        let mut probe = XtversionProbe::default();
        chunks.iter().map(|chunk| probe.push(chunk)).sum()
    }

    #[test]
    fn matches_explicit_and_default_zero() {
        assert_eq!(hits(&[b"\x1b[>0q"]), 1);
        assert_eq!(hits(&[b"\x1b[>q"]), 1);
        assert_eq!(hits(&[b"\x1b[>00q"]), 1);
        assert_eq!(hits(&[b"\x9b>0q"]), 1);
    }

    #[test]
    fn ignores_other_version_queries() {
        assert_eq!(hits(&[b"\x1b[>1q"]), 0);
        assert_eq!(hits(&[b"\x1b[>0;1q"]), 0);
        assert_eq!(hits(&[b"\x1b[6n"]), 0);
    }

    #[test]
    fn matches_across_reads_and_surrounding_output() {
        assert_eq!(hits(&[b"\x1b[", b">0q"]), 1);
        assert_eq!(hits(&[b"\x1b", b"[>0", b"q"]), 1);
        assert_eq!(hits(&[b"hello\x1b[>0qworld"]), 1);
        assert_eq!(hits(&[b"\x1b[2J\x1b[>0q"]), 1);
        assert_eq!(hits(&[b"\x1b[>0q\x1b[>q"]), 2);
    }

    #[test]
    fn own_reply_does_not_retrigger() {
        assert_eq!(hits(&[XTVERSION_REPLY]), 0);
    }

    #[test]
    fn writes_one_reply_per_hit() {
        let mut probe = XtversionProbe::default();
        let mut out = Vec::new();
        answer_probes(&mut probe, b"pre\x1b[>0qmid\x1b[>qpost", &mut out);
        assert_eq!(out, [XTVERSION_REPLY, XTVERSION_REPLY].concat());
    }

    #[test]
    fn write_replies_is_a_noop_without_hits() {
        let mut out = Vec::new();
        write_replies(0, &mut out);
        assert!(out.is_empty());
    }
}
