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
use std::path::{Path, PathBuf};
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
    // `Option` lets rotation take and drop the live handle before renaming.
    // Windows rejects a rename while this process still has the file open.
    file: Option<File>,
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
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        let written = file.metadata().map(|m| m.len()).unwrap_or(0);
        Ok(Self {
            inner: Mutex::new(Inner {
                path,
                file: Some(file),
                written,
            }),
        })
    }

    fn rotate(inner: &mut Inner) -> io::Result<()> {
        // Flush, then close the live handle before any rename. Keeping the
        // handle open happened to work on Unix but fails with a sharing
        // violation on Windows.
        let close_result = match inner.file.take() {
            Some(mut file) => file.flush(),
            None => Ok(()),
        };

        let rotation_result = close_result.and_then(|()| rotate_paths(&inner.path));

        // Always attempt to restore a writable live file, even when a remove
        // or rename failed. A single rotation error must not permanently turn
        // off daemon logging for the rest of the process lifetime.
        Self::reopen(inner)?;
        rotation_result
    }

    fn reopen(inner: &mut Inner) -> io::Result<()> {
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&inner.path)?;
        inner.written = file.metadata().map(|metadata| metadata.len()).unwrap_or(0);
        inner.file = Some(file);
        Ok(())
    }

    fn file_mut(inner: &mut Inner) -> io::Result<&mut File> {
        if inner.file.is_none() {
            Self::reopen(inner)?;
        }
        inner
            .file
            .as_mut()
            .ok_or_else(|| io::Error::other("daemon log file unavailable after reopen attempt"))
    }
}

impl Write for &RotatingFile {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let mut inner = self.inner.lock().unwrap();
        if inner.written + buf.len() as u64 > MAX_FILE_BYTES {
            RotatingFile::rotate(&mut inner)?;
        }
        let n = RotatingFile::file_mut(&mut inner)?.write(buf)?;
        inner.written += n as u64;
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> {
        let mut inner = self.inner.lock().unwrap();
        RotatingFile::file_mut(&mut inner)?.flush()
    }
}

fn rotate_paths(path: &Path) -> io::Result<()> {
    // Delete the oldest destination first. The remaining back-to-front
    // renames now always target a missing path, which is required by Windows
    // (unlike Unix, rename does not replace an existing file there).
    // `.4` is also removed for compatibility with files left by the previous
    // rotation implementation.
    remove_file_if_exists(&with_suffix(path, KEEP_ROTATIONS + 1))?;
    remove_file_if_exists(&with_suffix(path, KEEP_ROTATIONS))?;
    for i in (1..KEEP_ROTATIONS).rev() {
        rename_if_exists(&with_suffix(path, i), &with_suffix(path, i + 1))?;
    }
    rename_if_exists(path, &with_suffix(path, 1))
}

fn remove_file_if_exists(path: &Path) -> io::Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn rename_if_exists(source: &Path, destination: &Path) -> io::Result<()> {
    match std::fs::rename(source, destination) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn with_suffix(base: &Path, n: u32) -> PathBuf {
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
        drop(writer);
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
        drop(writer);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rotation_replaces_existing_history_in_order() {
        let dir = std::env::temp_dir().join(format!("acorn-log-order-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("daemon.log");
        std::fs::write(&path, b"live").unwrap();
        std::fs::write(with_suffix(&path, 1), b"one").unwrap();
        std::fs::write(with_suffix(&path, 2), b"two").unwrap();
        std::fs::write(with_suffix(&path, 3), b"three").unwrap();
        std::fs::write(with_suffix(&path, 4), b"stale").unwrap();

        let writer = RotatingFile::open(path.clone()).unwrap();
        RotatingFile::rotate(&mut writer.inner.lock().unwrap()).unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), b"");
        assert_eq!(std::fs::read(with_suffix(&path, 1)).unwrap(), b"live");
        assert_eq!(std::fs::read(with_suffix(&path, 2)).unwrap(), b"one");
        assert_eq!(std::fs::read(with_suffix(&path, 3)).unwrap(), b"two");
        assert!(!with_suffix(&path, 4).exists());
        drop(writer);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rotation_error_reopens_live_log_for_later_writes() {
        let dir = std::env::temp_dir().join(format!("acorn-log-recover-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("daemon.log");
        std::fs::write(&path, b"before").unwrap();
        // A directory at the oldest rotation path makes remove_file fail on
        // every supported OS and exercises the reopen-on-error path.
        std::fs::create_dir(with_suffix(&path, KEEP_ROTATIONS)).unwrap();

        let writer = RotatingFile::open(path.clone()).unwrap();
        assert!(RotatingFile::rotate(&mut writer.inner.lock().unwrap()).is_err());
        std::fs::remove_dir(with_suffix(&path, KEEP_ROTATIONS)).unwrap();

        let mut output = &writer;
        output.write_all(b"-after").unwrap();
        output.flush().unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"before-after");
        drop(writer);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
