//! Size-bounded log file rotation for the daemon.
//!
//! * `daemon.log` ≤ 10 MB before rotation
//! * Up to 3 prior files retained (`daemon.log.1`, `.2`, `.3`)
//! * Older rotations are deleted, not gzipped — debugging convenience
//!   trumps disk savings here (~40 MB worst case is negligible)
//!
//! Why not `tracing-appender::rolling`: pulling in that crate adds an
//! async runtime tie-in we do not need (the daemon's log volume is low —
//! a few hundred KB per session at most). A 60-line `Write` impl with a
//! manual size check does the job and keeps the dependency graph lean.

use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::Mutex;

use super::paths;

/// 10 MB rotation threshold. Three rotations × 10 MB ≈ 40 MB worst-case
/// disk footprint, which is well under the noise floor of an Acorn
/// install and still long enough to capture multi-day usage.
const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;
/// Keep three rotations (`.1`, `.2`, `.3`); older files are deleted on
/// the next rotation.
const KEEP_ROTATIONS: u32 = 3;

/// Thread-safe rotating file writer. Plug it into a `tracing-subscriber`
/// fmt layer via `with_writer(|| writer.clone())`.
pub struct RotatingFile {
    inner: Mutex<Inner>,
}

struct Inner {
    path: PathBuf,
    file: File,
    written: u64,
}

impl RotatingFile {
    /// Open (or create+append to) the canonical daemon log path. Returns
    /// an error if the data dir cannot be resolved or the file cannot
    /// be opened — the daemon falls back to stderr in that case so we
    /// never silently drop logs.
    pub fn open_default() -> io::Result<Self> {
        let path = paths::log_file_path()?;
        Self::open(path)
    }

    /// Variant for tests / non-default paths.
    pub fn open(path: PathBuf) -> io::Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)?;
        let written = file.metadata().map(|m| m.len()).unwrap_or(0);
        Ok(Self {
            inner: Mutex::new(Inner {
                path,
                file,
                written,
            }),
        })
    }

    fn rotate(inner: &mut Inner) -> io::Result<()> {
        // Walk back-to-front so .N → .N+1 moves do not clobber a file
        // we still need to read.
        for i in (1..KEEP_ROTATIONS).rev() {
            let src = with_suffix(&inner.path, i);
            let dst = with_suffix(&inner.path, i + 1);
            if src.exists() {
                let _ = std::fs::rename(&src, &dst);
            }
        }
        let first_rotation = with_suffix(&inner.path, 1);
        if inner.path.exists() {
            let _ = std::fs::rename(&inner.path, &first_rotation);
        }
        // Reopen the live log fresh.
        inner.file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&inner.path)?;
        inner.written = 0;
        // Drop anything beyond the keep budget.
        let stale = with_suffix(&inner.path, KEEP_ROTATIONS + 1);
        if stale.exists() {
            let _ = std::fs::remove_file(&stale);
        }
        Ok(())
    }
}

impl Write for &RotatingFile {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let mut inner = self.inner.lock().unwrap();
        if inner.written + buf.len() as u64 > MAX_FILE_BYTES {
            RotatingFile::rotate(&mut inner)?;
        }
        let n = inner.file.write(buf)?;
        inner.written += n as u64;
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.lock().unwrap().file.flush()
    }
}

fn with_suffix(base: &PathBuf, n: u32) -> PathBuf {
    let mut name = base
        .file_name()
        .map(|s| s.to_owned())
        .unwrap_or_else(|| "daemon.log".into());
    name.push(format!(".{n}"));
    base.with_file_name(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotates_at_size_threshold() {
        let dir = std::env::temp_dir().join(format!("acorn-log-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("daemon.log");
        let writer = RotatingFile::open(path.clone()).unwrap();
        // Force >10 MB by writing 11 × 1 MB chunks.
        let chunk = vec![b'A'; 1024 * 1024];
        for _ in 0..11 {
            let mut w = &writer;
            w.write_all(&chunk).unwrap();
        }
        // After rotation the current file should be shorter than the
        // threshold; the `.1` rotation should exist with the older data.
        let live_size = std::fs::metadata(&path).unwrap().len();
        assert!(
            live_size < MAX_FILE_BYTES,
            "live log expected < {MAX_FILE_BYTES}, got {live_size}"
        );
        assert!(dir.join("daemon.log.1").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn drops_files_beyond_keep_budget() {
        let dir = std::env::temp_dir().join(format!("acorn-log-keep-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("daemon.log");
        let writer = RotatingFile::open(path.clone()).unwrap();
        let chunk = vec![b'B'; 1024 * 1024];
        // 4 full rotations = current + .1 + .2 + .3 retained, anything
        // beyond .3 deleted. Force 5 rotations by writing 55 MB.
        for _ in 0..55 {
            let mut w = &writer;
            w.write_all(&chunk).unwrap();
        }
        assert!(dir.join("daemon.log.1").exists());
        assert!(dir.join("daemon.log.2").exists());
        assert!(dir.join("daemon.log.3").exists());
        assert!(!dir.join("daemon.log.4").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
