//! Same-directory atomic file publication.

use std::fs;
use std::io::{self, Write};
use std::path::Path;

use tempfile::NamedTempFile;

/// Read an optional file without collapsing filesystem errors into absence.
///
/// `None` means no directory entry exists at `path`. In particular, a
/// dangling symlink remains an error even though following it produces
/// `NotFound`; callers must not treat an occupied but unreadable state-file
/// path as a fresh file that is safe to replace.
pub fn read_optional(path: &Path) -> io::Result<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(read_error) if read_error.kind() == io::ErrorKind::NotFound => {
            match fs::symlink_metadata(path) {
                Ok(_) => Err(read_error),
                Err(metadata_error) if metadata_error.kind() == io::ErrorKind::NotFound => Ok(None),
                Err(metadata_error) => Err(metadata_error),
            }
        }
        Err(error) => Err(error),
    }
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

    #[test]
    fn optional_read_distinguishes_missing_from_existing_files() {
        let scratch = tempfile::tempdir().unwrap();
        let path = scratch.path().join("state.json");

        assert_eq!(read_optional(&path).unwrap(), None);
        fs::write(&path, b"state").unwrap();
        assert_eq!(read_optional(&path).unwrap(), Some(b"state".to_vec()));
    }

    #[cfg(unix)]
    #[test]
    fn optional_read_rejects_a_dangling_symlink() {
        use std::os::unix::fs::symlink;

        let scratch = tempfile::tempdir().unwrap();
        let path = scratch.path().join("state.json");
        symlink(scratch.path().join("missing-target"), &path).unwrap();

        let error = read_optional(&path).expect_err("dangling symlink occupies the path");
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
        assert!(fs::symlink_metadata(path).unwrap().file_type().is_symlink());
    }

    #[cfg(unix)]
    #[test]
    fn optional_read_propagates_permission_denied() {
        use std::os::unix::fs::PermissionsExt;

        let scratch = tempfile::tempdir().unwrap();
        let path = scratch.path().join("state.json");
        fs::write(&path, b"state").unwrap();
        let original_permissions = fs::metadata(&path).unwrap().permissions();
        let mut denied_permissions = original_permissions.clone();
        denied_permissions.set_mode(0o000);
        fs::set_permissions(&path, denied_permissions).unwrap();

        let result = read_optional(&path);

        fs::set_permissions(&path, original_permissions).unwrap();
        let error = result.expect_err("permission failure must not look missing");
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    }

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
}
