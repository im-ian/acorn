//! Shared newline-delimited JSON framing helpers for daemon sockets.
//!
//! `BufRead::read_line` grows its destination until it sees a newline or EOF.
//! Every daemon socket is reachable by child processes in Acorn sessions, so
//! accepting an unbounded line would let a misbehaving process exhaust the app
//! or daemon's memory before JSON parsing gets a chance to reject the frame.

use std::io::{self, BufRead, Read};

/// Maximum encoded client-to-daemon request size, including its newline.
/// Requests are normally tiny; 1 MiB preserves large paste/spawn payloads
/// while limiting JSON allocation amplification on an untrusted request.
pub const MAX_REQUEST_FRAME_BYTES: usize = 1024 * 1024;

/// Maximum encoded daemon-to-client response size, including its newline.
/// A 4 MiB scrollback snapshot expands to about 5.4 MiB after base64, so 8 MiB
/// leaves room for its JSON envelope while keeping allocation finite.
pub const MAX_RESPONSE_FRAME_BYTES: usize = 8 * 1024 * 1024;

/// Read one client-to-daemon frame while bounding destination growth.
pub fn read_request_frame_line<R: BufRead>(reader: &mut R, line: &mut String) -> io::Result<usize> {
    read_frame_line_with_limit(reader, line, MAX_REQUEST_FRAME_BYTES)
}

/// Read one daemon-to-client frame while bounding destination growth.
pub fn read_response_frame_line<R: BufRead>(
    reader: &mut R,
    line: &mut String,
) -> io::Result<usize> {
    read_frame_line_with_limit(reader, line, MAX_RESPONSE_FRAME_BYTES)
}

fn read_frame_line_with_limit<R: BufRead>(
    reader: &mut R,
    line: &mut String,
    max_bytes: usize,
) -> io::Result<usize> {
    line.clear();
    let mut limited = reader.take((max_bytes + 1) as u64);
    let bytes_read = limited.read_line(line)?;
    if bytes_read > max_bytes {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("daemon protocol frame exceeds {max_bytes}-byte limit"),
        ));
    }
    Ok(bytes_read)
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    #[test]
    fn bounded_reader_accepts_a_frame_at_the_limit() {
        let mut reader = Cursor::new(b"1234567\nnext\n");
        let mut line = String::from("stale");

        assert_eq!(
            read_frame_line_with_limit(&mut reader, &mut line, 8).unwrap(),
            8
        );
        assert_eq!(line, "1234567\n");
    }

    #[test]
    fn bounded_reader_rejects_an_oversized_frame() {
        let mut reader = Cursor::new(b"12345678\n");
        let mut line = String::new();

        let error = read_frame_line_with_limit(&mut reader, &mut line, 8).unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert_eq!(line.len(), 9);
    }

    #[test]
    fn bounded_reader_accepts_a_final_frame_without_a_newline() {
        let mut reader = Cursor::new(b"final");
        let mut line = String::new();

        assert_eq!(
            read_frame_line_with_limit(&mut reader, &mut line, 8).unwrap(),
            5
        );
        assert_eq!(line, "final");
    }
}
