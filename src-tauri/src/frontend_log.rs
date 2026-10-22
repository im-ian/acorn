//! Append-only log for webview-side failures. Release builds ship without
//! devtools, so an exception inside the terminal renderer would otherwise
//! leave no trace at all.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::Path;
use std::sync::Mutex;

use crate::error::AppResult;
use crate::persistence;

const LOG_DIR: &str = "logs";
const LOG_FILE: &str = "frontend.log";
const ROTATED_LOG_FILE: &str = "frontend.log.1";
const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;
const MAX_ENTRY_BYTES: usize = 16 * 1024;

/// Two entries landing at the size limit would both rotate and drop the
/// first one's line.
static APPEND_LOCK: Mutex<()> = Mutex::new(());

fn not_a_real_path(what: &str) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        format!("{what} is a symlink or not a regular path"),
    )
}

fn append(data_dir: &Path, entry: &str) -> io::Result<()> {
    let _guard = APPEND_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let dir = data_dir.join(LOG_DIR);
    match fs::symlink_metadata(&dir) {
        Ok(meta) if meta.file_type().is_dir() => {}
        Ok(_) => return Err(not_a_real_path("frontend log directory")),
        Err(err) if err.kind() == io::ErrorKind::NotFound => fs::create_dir_all(&dir)?,
        Err(err) => return Err(err),
    }
    let path = dir.join(LOG_FILE);
    match fs::symlink_metadata(&path) {
        Ok(meta) if !meta.file_type().is_file() => return Err(not_a_real_path("frontend log")),
        Ok(meta) if meta.len() > MAX_LOG_BYTES => fs::rename(&path, dir.join(ROTATED_LOG_FILE))?,
        _ => {}
    }

    let mut end = entry.len().min(MAX_ENTRY_BYTES);
    while !entry.is_char_boundary(end) {
        end -= 1;
    }
    // One entry per line, so a reader can split on newlines.
    let mut line = entry[..end].replace(['\r', '\n'], " ");
    line.push('\n');
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?
        .write_all(line.as_bytes())
}

#[tauri::command]
pub async fn frontend_log(entry: String) -> AppResult<()> {
    let dir = persistence::data_dir()?;
    append(&dir, &entry)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_one_line_per_entry_and_rotates_when_full() {
        let dir = std::env::temp_dir().join(format!("acorn-frontend-log-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();

        append(&dir, "{\"event\":\"a\",\"stack\":\"line1\nline2\"}").unwrap();
        append(&dir, &"가".repeat(MAX_ENTRY_BYTES)).unwrap();
        let log = fs::read_to_string(dir.join(LOG_DIR).join(LOG_FILE)).unwrap();
        let lines: Vec<&str> = log.lines().collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0], "{\"event\":\"a\",\"stack\":\"line1 line2\"}");
        assert!(lines[1].len() <= MAX_ENTRY_BYTES);

        fs::write(
            dir.join(LOG_DIR).join(LOG_FILE),
            vec![b'x'; MAX_LOG_BYTES as usize + 1],
        )
        .unwrap();
        append(&dir, "fresh").unwrap();
        assert_eq!(
            fs::read_to_string(dir.join(LOG_DIR).join(LOG_FILE)).unwrap(),
            "fresh\n"
        );
        assert!(dir.join(LOG_DIR).join(ROTATED_LOG_FILE).exists());

        fs::remove_dir_all(&dir).unwrap();
    }
}
