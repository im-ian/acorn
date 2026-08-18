//! Panic / abnormal-exit capture for the daemon.
//!
//! On daemon crash the app auto-respawns and a crash log is written so
//! the user (or a future bug report) can see what failed without
//! sifting through the rotating `daemon.log`. Crash files are
//! timestamped UTC so multiple crashes in the same session do not
//! overwrite each other.
//!
//! What we capture:
//! * The Rust panic message (`panic_info.payload()`).
//! * The source location (`panic_info.location()`).
//! * A backtrace if `RUST_BACKTRACE=1` was set (we do not force it on,
//!   since the cost is non-trivial; we just plumb whatever was captured).
//! * The tail of `daemon.log` so the runtime events leading up to the
//!   panic land alongside (read-on-write, truncated to ~64 KB so a
//!   pathological log volume cannot blow up the crash file).

use std::io::Write;
use std::panic;
use std::path::PathBuf;

use chrono::Utc;

use super::paths;

const LOG_TAIL_BYTES: usize = 64 * 1024;
const PANIC_PAYLOAD_BYTES: usize = 16 * 1024;

/// Install a global panic hook that writes a crash file under `crashes/`
/// before delegating to the default handler. Safe to call multiple times
/// (the previous hook is preserved and re-invoked so we do not silence
/// the default stderr trace developers expect).
pub fn install(daemon_version: impl Into<String>) {
    let daemon_version = daemon_version.into();
    let prev = panic::take_hook();
    panic::set_hook(Box::new(move |info| {
        if let Err(e) = write_crash_log(info, &daemon_version) {
            eprintln!("[acornd] failed to write crash log: {e}");
        }
        prev(info);
    }));
}

fn write_crash_log(
    info: &panic::PanicHookInfo<'_>,
    daemon_version: &str,
) -> std::io::Result<PathBuf> {
    let dir = paths::crash_dir()?;
    let now = Utc::now();
    let nonce = now.timestamp_nanos_opt().unwrap_or_default();
    let filename = format!(
        "{}-{}-{nonce}.log",
        now.format("%Y%m%dT%H%M%SZ"),
        std::process::id()
    );
    let path = dir.join(filename);

    let mut body = Vec::with_capacity(LOG_TAIL_BYTES + 4096);

    writeln!(body, "# acornd crash log")?;
    writeln!(body, "timestamp: {}", now.to_rfc3339())?;
    writeln!(body, "pid: {}", std::process::id())?;
    writeln!(body, "version: {daemon_version}")?;
    writeln!(body)?;
    writeln!(body, "## panic")?;
    let payload_str = panic_payload_str(info);
    let (payload_str, truncated) = utf8_prefix(payload_str, PANIC_PAYLOAD_BYTES);
    writeln!(body, "{payload_str}")?;
    if truncated {
        writeln!(body, "[panic payload truncated]")?;
    }
    if let Some(loc) = info.location() {
        writeln!(body, "at {}:{}:{}", loc.file(), loc.line(), loc.column())?;
    }
    writeln!(body)?;
    writeln!(body, "## recent log tail (last {LOG_TAIL_BYTES} bytes)")?;
    match log_tail() {
        Ok(tail) => {
            body.write_all(&tail)?;
        }
        Err(e) => writeln!(body, "(could not read daemon.log: {e})")?,
    }
    acorn_platform::fs::write_atomic_private(&path, &body)?;
    Ok(path)
}

/// Extract a printable string from a panic payload. Stdlib supports
/// either `&'static str` or `String` payloads (and an undocumented
/// catch-all that we render generically).
fn panic_payload_str<'a>(info: &'a panic::PanicHookInfo<'_>) -> &'a str {
    let p = info.payload();
    if let Some(s) = p.downcast_ref::<&'static str>() {
        return s;
    }
    if let Some(s) = p.downcast_ref::<String>() {
        return s;
    }
    "<non-string panic payload>"
}

fn utf8_prefix(value: &str, max_bytes: usize) -> (&str, bool) {
    if value.len() <= max_bytes {
        return (value, false);
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    (&value[..end], true)
}

fn log_tail() -> std::io::Result<Vec<u8>> {
    let path = paths::log_file_path()?;
    let before = std::fs::symlink_metadata(&path)?;
    if !before.file_type().is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "daemon log is not a regular file",
        ));
    }
    let mut f = std::fs::File::open(&path)?;
    let opened = f.metadata()?;
    if !opened.is_file() || !same_opened_file(&before, &opened) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "daemon log changed while opening",
        ));
    }
    let len = opened.len();
    let start = len.saturating_sub(LOG_TAIL_BYTES as u64);
    use std::io::{Read, Seek, SeekFrom};
    f.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::with_capacity(LOG_TAIL_BYTES);
    f.take(LOG_TAIL_BYTES as u64).read_to_end(&mut buf)?;
    Ok(buf)
}

#[cfg(unix)]
fn same_opened_file(before: &std::fs::Metadata, opened: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;

    before.dev() == opened.dev() && before.ino() == opened.ino()
}

#[cfg(not(unix))]
fn same_opened_file(_before: &std::fs::Metadata, _opened: &std::fs::Metadata) -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payload_extraction_handles_static_str() {
        // We can't easily synthesize a real PanicHookInfo, but the
        // downcast logic is independently testable via the panic
        // catcher.
        let result = std::panic::catch_unwind(|| panic!("hello, crash"));
        let err = result.expect_err("panic expected");
        let s = err
            .downcast_ref::<&'static str>()
            .map(|s| (*s).to_string())
            .or_else(|| err.downcast_ref::<String>().cloned())
            .unwrap_or_default();
        assert_eq!(s, "hello, crash");
    }

    #[test]
    fn panic_payload_prefix_preserves_utf8_boundaries() {
        assert_eq!(utf8_prefix("한글", 4), ("한", true));
        assert_eq!(utf8_prefix("short", 16), ("short", false));
    }

    #[cfg(unix)]
    #[test]
    fn log_tail_rejects_symlinked_log_file() {
        use crate::test_env::ENV_LOCK;
        use std::os::unix::fs::symlink;

        let _guard = ENV_LOCK.lock();
        let root = PathBuf::from("/tmp").join(format!("acn-crash-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        unsafe { std::env::set_var(paths::ENV_DATA_DIR_OVERRIDE, &root) };
        let sentinel = root.join("sentinel");
        std::fs::write(&sentinel, "secret").unwrap();
        symlink(&sentinel, paths::log_file_path().unwrap()).unwrap();

        assert!(log_tail().is_err());

        unsafe { std::env::remove_var(paths::ENV_DATA_DIR_OVERRIDE) };
        let _ = std::fs::remove_dir_all(root);
    }
}
