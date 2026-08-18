//! Same-directory atomic file publication.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::Path;

use tempfile::NamedTempFile;

/// Open an existing regular file without following a final symlink/reparse
/// point, then verify that the descriptor still names the file inspected
/// immediately before open. Callers retain the descriptor for all reads so a
/// later path replacement cannot redirect validated content.
pub fn open_regular_nofollow(path: &Path) -> io::Result<(File, fs::Metadata)> {
    let before = fs::symlink_metadata(path)?;
    if !before.file_type().is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "expected a regular file without symlinks: {}",
                path.display()
            ),
        ));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(nix::libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path)?;
    let opened = file.metadata()?;
    if !opened.file_type().is_file() || !same_opened_file(&before, &opened) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("file changed while opening: {}", path.display()),
        ));
    }
    Ok((file, opened))
}

#[cfg(unix)]
fn same_opened_file(before: &fs::Metadata, opened: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;

    before.dev() == opened.dev() && before.ino() == opened.ino()
}

#[cfg(not(unix))]
fn same_opened_file(_before: &fs::Metadata, _opened: &fs::Metadata) -> bool {
    // FILE_FLAG_OPEN_REPARSE_POINT prevents final-component redirection on
    // Windows. Stable std does not expose the by-handle file id fields yet.
    true
}

/// Atomically replace `path` with `contents` after flushing it to disk.
pub fn write_atomic(path: &Path, contents: &[u8]) -> io::Result<()> {
    write_atomic_with_mode(path, contents, false)
}

/// Atomically replace `path` with owner-only contents on Unix.
pub fn write_atomic_private(path: &Path, contents: &[u8]) -> io::Result<()> {
    write_atomic_with_mode(path, contents, true)
}

/// Copy a file through a same-directory staging file and atomically publish
/// it. This avoids exposing a partially copied executable after interruption.
pub fn copy_atomic(source: &Path, destination: &Path) -> io::Result<u64> {
    let parent = parent_dir(destination)?;
    fs::create_dir_all(parent)?;
    let mut staging = NamedTempFile::new_in(parent)?;
    let mut input = fs::File::open(source)?;
    let copied = io::copy(&mut input, staging.as_file_mut())?;
    staging.as_file_mut().flush()?;
    staging.as_file().sync_all()?;
    persist(staging, destination)?;
    Ok(copied)
}

fn write_atomic_with_mode(path: &Path, contents: &[u8], private: bool) -> io::Result<()> {
    let parent = parent_dir(path)?;
    fs::create_dir_all(parent)?;
    let mut staging = NamedTempFile::new_in(parent)?;
    staging.write_all(contents)?;
    staging.flush()?;
    if private {
        set_private(staging.path())?;
    }
    staging.as_file().sync_all()?;
    persist(staging, path)
}

fn parent_dir(path: &Path) -> io::Result<&Path> {
    path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "atomic destination has no parent directory",
        )
    })
}

fn persist(staging: NamedTempFile, destination: &Path) -> io::Result<()> {
    staging
        .persist(destination)
        .map(|_| ())
        .map_err(|err| err.error)
}

#[cfg(unix)]
fn set_private(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn set_private(_path: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn replaces_an_existing_destination_repeatedly() {
        let scratch = tempfile::tempdir().unwrap();
        let path = scratch.path().join("state.json");
        write_atomic(&path, b"one").unwrap();
        write_atomic(&path, b"two").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"two");
    }

    #[test]
    fn copy_publishes_complete_contents() {
        let scratch = tempfile::tempdir().unwrap();
        let source = scratch.path().join("source.bin");
        let destination = scratch.path().join("nested/destination.bin");
        fs::write(&source, b"complete").unwrap();
        assert_eq!(copy_atomic(&source, &destination).unwrap(), 8);
        assert_eq!(fs::read(destination).unwrap(), b"complete");
    }

    #[cfg(unix)]
    #[test]
    fn regular_open_rejects_symlinks() {
        use std::os::unix::fs::symlink;

        let scratch = tempfile::tempdir().unwrap();
        let target = scratch.path().join("target");
        let link = scratch.path().join("link");
        fs::write(&target, b"secret").unwrap();
        symlink(&target, &link).unwrap();

        assert!(open_regular_nofollow(&link).is_err());
        let (mut file, _) = open_regular_nofollow(&target).unwrap();
        let mut contents = String::new();
        file.read_to_string(&mut contents).unwrap();
        assert_eq!(contents, "secret");
    }
}
