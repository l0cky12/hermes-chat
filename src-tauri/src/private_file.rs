//! Files only their owner can read, put in place whole.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// Opens files only their owner can read: mode 0600 on Unix. On Windows a new file takes its folder's access list, and
/// the app's data folder in the user's profile is already the user's own.
pub(crate) fn owner_only(options: &mut OpenOptions) -> &mut OpenOptions {
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(options, 0o600);
    options
}

/// Puts `bytes` at `path`, as `write_with` does.
pub(crate) fn write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    write_with(path, |file| file.write_all(bytes))
}

/// Puts what `fill` writes at `path` (mode 0600) whole: into a new private file beside it, flushed to disk, then
/// renamed over it, and the folder flushed so the rename lasts. A crash leaves the old file or the new one, and a
/// failure leaves the old one and no temporary file.
pub(crate) fn write_with(path: &Path, fill: impl FnOnce(&mut File) -> io::Result<()>) -> io::Result<()> {
    let (tmp, mut file) = create_temp(path)?;
    let written = fill(&mut file).and_then(|()| file.sync_all()).and_then(|()| {
        drop(file);
        fs::rename(&tmp, path)
    });
    if written.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    written?;
    // Best effort: the file is in place now, and only a power cut could still lose the rename. Windows can't open a
    // folder this way, and NTFS journals the rename itself.
    #[cfg(unix)]
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        let _ = File::open(dir).and_then(|d| d.sync_all());
    }
    Ok(())
}

/// A new private file beside `path`, made with O_EXCL (CREATE_NEW on Windows): it never opens a file or symlink already
/// there, so nothing planted in the folder can redirect the write or keep its own permissions.
fn create_temp(path: &Path) -> io::Result<(PathBuf, File)> {
    let dir = path.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let name = path.file_name().map_or("file".into(), |n| n.to_string_lossy());
    for n in 0..100 {
        let tmp = dir.join(format!(".{name}.{}.{n}.tmp", std::process::id()));
        match owner_only(OpenOptions::new().write(true).create_new(true)).open(&tmp) {
            Ok(f) => return Ok((tmp, f)),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(io::Error::new(io::ErrorKind::AlreadyExists, "no free temporary name beside it"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hermes-chat-private-file-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        names
    }

    #[test]
    fn replaces_the_file_whole_and_private() {
        let dir = scratch("whole");
        let path = dir.join("settings.json");
        fs::write(&path, "an older, longer copy that must not show through").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        }
        write(&path, br#"{"a":"b"}"#).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), r#"{"a":"b"}"#);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        assert_eq!(names(&dir), ["settings.json"]);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_failed_write_keeps_the_old_file_and_leaves_no_temporary_one() {
        let dir = scratch("fill-fails");
        let path = dir.join("settings.json");
        fs::write(&path, "old").unwrap();
        let failed = write_with(&path, |file| {
            file.write_all(b"half")?;
            Err(io::Error::other("disk full"))
        });
        assert_eq!(failed.unwrap_err().to_string(), "disk full");
        assert_eq!(fs::read_to_string(&path).unwrap(), "old");
        assert_eq!(names(&dir), ["settings.json"]);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_failed_rename_leaves_no_temporary_file() {
        let dir = scratch("rename-fails");
        let path = dir.join("settings.json");
        // The rename can't replace a folder: it fails after the temporary file was written.
        fs::create_dir(&path).unwrap();
        assert!(write(&path, b"{}").is_err());
        assert_eq!(names(&dir), ["settings.json"]);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn never_writes_through_a_file_planted_where_the_temporary_one_goes() {
        let dir = scratch("planted");
        let victim = dir.join("victim.txt");
        fs::write(&victim, "keep me").unwrap();
        let path = dir.join("settings.json");
        let planted = dir.join(format!(".settings.json.{}.0.tmp", std::process::id()));
        // A symlink needs a privilege on Windows; a plain file there is the same test of never opening what exists.
        #[cfg(unix)]
        std::os::unix::fs::symlink(&victim, &planted).unwrap();
        #[cfg(not(unix))]
        fs::copy(&victim, &planted).unwrap();
        write(&path, b"new").unwrap();
        assert_eq!(fs::read_to_string(&victim).unwrap(), "keep me");
        assert_eq!(fs::read_to_string(&path).unwrap(), "new");
        fs::remove_dir_all(&dir).unwrap();
    }
}
