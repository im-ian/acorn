//! Track DEC private modes from a PTY stdout stream.
//!
//! Overlay TUIs enable mouse tracking once at start. Reattach replays a
//! ring that may have already dropped those CSI sequences, so the live
//! process still believes the mouse is on while a fresh xterm does not.
//! This tracker is the lossless projection of the subset we restore:
//! mouse protocol, SGR encoding, and bracketed paste. Alt-screen is
//! ignored — replaying `?1049h` blanks xterm.js's alt buffer.

/// Mouse protocol last written by DECSET 9/1000/1002/1003.
/// DECRST of any of those four collapses to `None`, matching xterm.js.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum MouseProtocol {
    #[default]
    None,
    X10,
    Vt200,
    Drag,
    Any,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DecPrivateModes {
    pub mouse: MouseProtocol,
    pub sgr_mouse: bool,
    pub bracketed_paste: bool,
}

impl DecPrivateModes {
    /// CSI to replay into a fresh xterm parser. Empty when all defaults.
    pub fn prelude(self) -> Vec<u8> {
        let mut out = Vec::new();
        match self.mouse {
            MouseProtocol::None => {}
            MouseProtocol::X10 => out.extend_from_slice(b"\x1b[?9h"),
            MouseProtocol::Vt200 => out.extend_from_slice(b"\x1b[?1000h"),
            MouseProtocol::Drag => out.extend_from_slice(b"\x1b[?1002h"),
            MouseProtocol::Any => out.extend_from_slice(b"\x1b[?1003h"),
        }
        if self.sgr_mouse {
            out.extend_from_slice(b"\x1b[?1006h");
        }
        if self.bracketed_paste {
            out.extend_from_slice(b"\x1b[?2004h");
        }
        out
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum State {
    #[default]
    Ground,
    Esc,
    String,
    Csi,
}

#[derive(Clone, Debug)]
struct CsiParse {
    /// `b'?'` for DEC private, `0` for standard, other 0x3C–0x3F ignored.
    private: u8,
    intermediates: u8,
    params: Vec<u16>,
    current: u32,
    got_digit: bool,
    in_subparam: bool,
}

impl Default for CsiParse {
    fn default() -> Self {
        Self {
            private: 0,
            intermediates: 0,
            params: Vec::with_capacity(4),
            current: 0,
            got_digit: false,
            in_subparam: false,
        }
    }
}

impl CsiParse {
    fn finish_param(&mut self) {
        if self.got_digit {
            self.params.push(self.current.min(u16::MAX as u32) as u16);
        } else {
            self.params.push(0);
        }
        self.current = 0;
        self.got_digit = false;
        self.in_subparam = false;
    }

    fn push_param_byte(&mut self, byte: u8) {
        match byte {
            b'?' | b'>' | b'=' | b'<'
                if self.private == 0 && self.params.is_empty() && !self.got_digit =>
            {
                self.private = byte;
            }
            b'0'..=b'9' if !self.in_subparam => {
                self.got_digit = true;
                self.current = self
                    .current
                    .saturating_mul(10)
                    .saturating_add((byte - b'0') as u32);
            }
            b';' => self.finish_param(),
            b':' => self.in_subparam = true,
            _ => {}
        }
    }
}

/// Incremental scanner. Call `push` with every stdout chunk.
#[derive(Clone, Debug, Default)]
pub struct DecModeTracker {
    state: State,
    csi: CsiParse,
    modes: DecPrivateModes,
}

impl DecModeTracker {
    pub fn modes(&self) -> DecPrivateModes {
        self.modes
    }

    pub fn prelude(&self) -> Vec<u8> {
        self.modes.prelude()
    }

    pub fn reset(&mut self) {
        *self = Self::default();
    }

    pub fn push(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            self.feed(byte);
        }
    }

    fn feed(&mut self, byte: u8) {
        match self.state {
            State::Ground => {
                if byte == 0x1b {
                    self.state = State::Esc;
                }
            }
            State::Esc => match byte {
                b'[' => {
                    self.csi = CsiParse::default();
                    self.state = State::Csi;
                }
                b']' | b'P' | b'X' | b'^' | b'_' => self.state = State::String,
                b'c' => {
                    self.modes = DecPrivateModes::default();
                    self.state = State::Ground;
                }
                0x1b => self.state = State::Esc,
                _ => self.state = State::Ground,
            },
            State::String => match byte {
                0x07 => self.state = State::Ground,
                // xterm.js ends OSC/DCS on ESC and re-enters ESCAPE, so an
                // unterminated title cannot wedge mode tracking for the
                // rest of the PTY. ST's `\` is then absorbed in Esc.
                0x1b => self.state = State::Esc,
                _ => {}
            },
            State::Csi => match byte {
                0x30..=0x3f => {
                    if self.csi.intermediates == 0 {
                        self.csi.push_param_byte(byte);
                    } else {
                        self.state = State::Ground;
                    }
                }
                0x20..=0x2f => self.csi.intermediates = byte,
                0x40..=0x7e => {
                    self.apply_csi(byte);
                    self.state = State::Ground;
                }
                0x1b => self.state = State::Esc,
                _ => self.state = State::Ground,
            },
        }
    }

    fn apply_csi(&mut self, final_byte: u8) {
        self.csi.finish_param();
        if self.csi.intermediates == b'!' && final_byte == b'p' {
            return;
        }
        if self.csi.private != b'?' || self.csi.intermediates != 0 {
            return;
        }
        let enable = match final_byte {
            b'h' => true,
            b'l' => false,
            _ => return,
        };
        let params = std::mem::take(&mut self.csi.params);
        for param in params {
            self.apply_dec(param, enable);
        }
    }

    fn apply_dec(&mut self, param: u16, enable: bool) {
        match param {
            9 | 1000 | 1002 | 1003 => {
                if enable {
                    self.modes.mouse = match param {
                        9 => MouseProtocol::X10,
                        1000 => MouseProtocol::Vt200,
                        1002 => MouseProtocol::Drag,
                        _ => MouseProtocol::Any,
                    };
                } else {
                    self.modes.mouse = MouseProtocol::None;
                }
            }
            1006 => self.modes.sgr_mouse = enable,
            2004 => self.modes.bracketed_paste = enable,
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(chunks: &[&[u8]]) -> DecPrivateModes {
        let mut tracker = DecModeTracker::default();
        for chunk in chunks {
            tracker.push(chunk);
        }
        tracker.modes()
    }

    #[test]
    fn grok_startup_mouse_sgr() {
        let modes = track(&[b"\x1b[?1049h\x1b[?1000h\x1b[?1006hhello"]);
        assert_eq!(
            modes,
            DecPrivateModes {
                mouse: MouseProtocol::Vt200,
                sgr_mouse: true,
                bracketed_paste: false,
            }
        );
        assert_eq!(modes.prelude(), b"\x1b[?1000h\x1b[?1006h");
    }

    #[test]
    fn multi_param_set_and_last_write_wins() {
        let modes = track(&[b"\x1b[?1000;1006h"]);
        assert_eq!(modes.mouse, MouseProtocol::Vt200);
        assert!(modes.sgr_mouse);
        let modes = track(&[b"\x1b[?1002h\x1b[?1000h"]);
        assert_eq!(modes.mouse, MouseProtocol::Vt200);
    }

    #[test]
    fn decrst_any_mouse_protocol_clears() {
        let modes = track(&[b"\x1b[?1002h\x1b[?1000l"]);
        assert_eq!(modes.mouse, MouseProtocol::None);
        assert_eq!(modes.prelude(), b"");
    }

    #[test]
    fn claude_toggle_off_then_on() {
        let modes = track(&[b"\x1b[?1000h\x1b[?1006h\x1b[?1000l\x1b[?1006l"]);
        assert_eq!(modes, DecPrivateModes::default());
        let modes = track(&[b"\x1b[?1000h\x1b[?1006h\x1b[?1000l\x1b[?1006l\x1b[?1002h\x1b[?1006h"]);
        assert_eq!(modes.mouse, MouseProtocol::Drag);
        assert!(modes.sgr_mouse);
        assert_eq!(modes.prelude(), b"\x1b[?1002h\x1b[?1006h");
    }

    #[test]
    fn ris_clears_decstr_does_not() {
        // xterm.js softReset clears bracketed paste via CoreService but
        // leaves mouse on. The tracker keeps both: DECSTR does not
        // touch DEC private modes the child still believes are on.
        let modes = track(&[b"\x1b[?1000h\x1b[?1006h\x1b[?2004h\x1b[!p"]);
        assert_eq!(modes.mouse, MouseProtocol::Vt200);
        assert!(modes.sgr_mouse);
        assert!(modes.bracketed_paste);
        let modes = track(&[b"\x1b[?1000h\x1b[?1006h\x1bc"]);
        assert_eq!(modes, DecPrivateModes::default());
    }

    #[test]
    fn csi_looking_text_inside_osc_is_ignored() {
        let modes = track(&[b"\x1b]0;title ?1000h\x07\x1b[?1002h"]);
        assert_eq!(modes.mouse, MouseProtocol::Drag);
    }

    #[test]
    fn unterminated_osc_recovers_on_next_esc() {
        let modes = track(&[b"\x1b]0;title-no-st\x1b[?1000h"]);
        assert_eq!(modes.mouse, MouseProtocol::Vt200);
    }

    #[test]
    fn utf8_continuation_0x9b_is_not_csi() {
        // U+C548 "안" is EC 95 88; 0x9B is a legal UTF-8 continuation.
        let modes = track(&[b"\xec\x95\x88\x9b?1000h"]);
        assert_eq!(modes.mouse, MouseProtocol::None);
    }

    #[test]
    fn split_across_chunks() {
        let modes = track(&[b"\x1b[?", b"1000", b";1006h"]);
        assert_eq!(modes.mouse, MouseProtocol::Vt200);
        assert!(modes.sgr_mouse);
    }

    #[test]
    fn subparams_are_ignored() {
        let modes = track(&[b"\x1b[?1000:1;1006h"]);
        assert_eq!(modes.mouse, MouseProtocol::Vt200);
        assert!(modes.sgr_mouse);
    }

    #[test]
    fn alt_screen_is_not_in_prelude() {
        let modes = track(&[b"\x1b[?1049h\x1b[?1000h"]);
        assert_eq!(modes.prelude(), b"\x1b[?1000h");
    }

    #[test]
    fn reset_clears_tracker_state() {
        let mut tracker = DecModeTracker::default();
        tracker.push(b"\x1b[?1000h\x1b[?");
        tracker.reset();
        tracker.push(b"1006h");
        assert!(!tracker.modes().sgr_mouse);
        assert_eq!(tracker.modes().mouse, MouseProtocol::None);
    }
}
