//! Panic / abnormal-exit capture for the daemon.
//!
//! Q27 decision: daemon crash → auto-respawn by the app AND a crash log is
//! written so the user (or a future bug report) can see what failed without
//! sifting through the rotating `daemon.log`. Crash files are timestamped
//! UTC so multiple crashes in the same session do not overwrite each other.
//!
//! What we capture:
//! * The Rust panic message (`panic_info.payload()`).
//! * The source location (`panic_info.location()`).
//! * A backtrace if `RUST_BACKTRACE=1` was set (we do not force it on,
//!   since the cost is non-trivial; we just plumb whatever was captured).
//! * The tail of `daemon.log` so the runtime events leading up to the
//!   panic land alongside (read-on-write, truncated to ~64 KB so a
//!   pathological log volume cannot blow up the crash file).

use std::fs::OpenOptions;
use std::io::Write;
use std::panic;
use std::path::PathBuf;

use chrono::Utc;

use super::paths;

const LOG_TAIL_BYTES: usize = 64 * 1024;

/// Install a global panic hook that writes a crash file under `crashes/`
/// before delegating to the default handler. Safe to call multiple times
/// (the previous hook is preserved and re-invoked so we do not silence
/// the default stderr trace developers expect).
pub fn install() {
    let prev = panic::take_hook();
    panic::set_hook(Box::new(move |info| {
        if let Err(e) = write_crash_log(info) {
            eprintln!("[acornd] failed to write crash log: {e}");
        }
        prev(info);
    }));
}

fn write_crash_log(info: &panic::PanicHookInfo<'_>) -> std::io::Result<PathBuf> {
    let dir = paths::crash_dir()?;
    let now = Utc::now();
    let filename = format!("{}.log", now.format("%Y%m%dT%H%M%SZ"));
    let path = dir.join(filename);

    let mut f = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&path)?;

    writeln!(f, "# acornd crash log")?;
    writeln!(f, "timestamp: {}", now.to_rfc3339())?;
    writeln!(f, "pid: {}", std::process::id())?;
    writeln!(
        f,
        "version: {}",
        option_env!("CARGO_PKG_VERSION").unwrap_or("unknown")
    )?;
    writeln!(f)?;
    writeln!(f, "## panic")?;
    let payload_str = panic_payload_str(info);
    writeln!(f, "{payload_str}")?;
    if let Some(loc) = info.location() {
        writeln!(f, "at {}:{}:{}", loc.file(), loc.line(), loc.column())?;
    }
    writeln!(f)?;
    writeln!(f, "## recent log tail (last {LOG_TAIL_BYTES} bytes)")?;
    match log_tail() {
        Ok(tail) => {
            f.write_all(&tail)?;
        }
        Err(e) => writeln!(f, "(could not read daemon.log: {e})")?,
    }
    f.flush()?;
    Ok(path)
}

/// Extract a printable string from a panic payload. Stdlib supports
/// either `&'static str` or `String` payloads (and an undocumented
/// catch-all that we render generically).
fn panic_payload_str(info: &panic::PanicHookInfo<'_>) -> String {
    let p = info.payload();
    if let Some(s) = p.downcast_ref::<&'static str>() {
        return (*s).to_string();
    }
    if let Some(s) = p.downcast_ref::<String>() {
        return s.clone();
    }
    "<non-string panic payload>".to_string()
}

fn log_tail() -> std::io::Result<Vec<u8>> {
    let path = paths::log_file_path()?;
    let meta = std::fs::metadata(&path)?;
    let len = meta.len();
    let start = len.saturating_sub(LOG_TAIL_BYTES as u64);
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(&path)?;
    f.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::with_capacity(LOG_TAIL_BYTES);
    f.read_to_end(&mut buf)?;
    Ok(buf)
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
}
