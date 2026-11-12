//! A project's defaults for new chats (ADR 0017) live in one JSON file in the app's data folder, which every running
//! Hermes Chat on this computer shares. The webview only reads it, and changes it by compare-and-swap: the new text is
//! written only if the file still holds what the webview read, checked and written while holding an exclusive lock
//! (`flock`, or `LockFileEx` on Windows) on a lock file beside it. Separate app instances have separate webview storage and lock registries, so this is
//! what keeps one instance's save from silently replacing another's. Tags and Saved filters (ADR 0106) are kept the
//! same way, in a file of their own.
use std::fs::{self, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::private_file::{self, owner_only};

/// The files kept this way, by name: `<name>.json`, swapped under `<name>.lock`.
const DEFAULTS: &str = "project-defaults";
const TAGS: &str = "tags";

/// What a swap did: `swapped`, or not because the file held `current` instead of what was expected.
#[derive(Debug, Serialize, PartialEq)]
pub struct Swap {
    pub swapped: bool,
    pub current: Option<String>,
}

fn read_file(path: &Path) -> io::Result<Option<String>> {
    match fs::read_to_string(path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// The file's text, or `None` when there is none yet.
pub fn read(dir: &Path, name: &str) -> io::Result<Option<String>> {
    read_file(&dir.join(format!("{name}.json")))
}

/// Writes `next` if the file holds exactly `expected` (`None`: no file yet), under an exclusive lock that every
/// instance takes. The write goes to a private temporary file renamed over the old one, so a crash leaves either.
pub fn swap(dir: &Path, name: &str, expected: Option<&str>, next: &str) -> io::Result<Swap> {
    fs::create_dir_all(dir)?;
    let lock = owner_only(OpenOptions::new().create(true).truncate(false).write(true)).open(dir.join(format!("{name}.lock")))?;
    // Released when `lock` is closed at the end.
    lock.lock()?;
    let path = dir.join(format!("{name}.json"));
    let current = read_file(&path)?;
    if current.as_deref() != expected {
        return Ok(Swap { swapped: false, current });
    }
    private_file::write(&path, next.as_bytes())?;
    Ok(Swap { swapped: true, current: Some(next.to_owned()) })
}

fn dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

async fn read_named(app: AppHandle, name: &'static str) -> Result<Option<String>, String> {
    let dir = dir(&app)?;
    tokio::task::spawn_blocking(move || read(&dir, name)).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())
}

async fn swap_named(app: AppHandle, name: &'static str, expected: Option<String>, next: String) -> Result<Swap, String> {
    let dir = dir(&app)?;
    tokio::task::spawn_blocking(move || swap(&dir, name, expected.as_deref(), &next)).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn project_defaults_read(app: AppHandle) -> Result<Option<String>, String> {
    read_named(app, DEFAULTS).await
}

#[tauri::command]
pub async fn project_defaults_swap(app: AppHandle, expected: Option<String>, next: String) -> Result<Swap, String> {
    swap_named(app, DEFAULTS, expected, next).await
}

#[tauri::command]
pub async fn tags_read(app: AppHandle) -> Result<Option<String>, String> {
    read_named(app, TAGS).await
}

#[tauri::command]
pub async fn tags_swap(app: AppHandle, expected: Option<String>, next: String) -> Result<Swap, String> {
    swap_named(app, TAGS, expected, next).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("hc-defaults-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn swaps_only_over_what_was_read() {
        let d = temp_dir("cas");
        assert_eq!(read(&d, DEFAULTS).unwrap(), None);
        assert!(swap(&d, DEFAULTS, None, "one").unwrap().swapped);
        assert_eq!(swap(&d, DEFAULTS, None, "two").unwrap(), Swap { swapped: false, current: Some("one".into()) });
        assert!(swap(&d, DEFAULTS, Some("one"), "two").unwrap().swapped);
        assert_eq!(read(&d, DEFAULTS).unwrap().as_deref(), Some("two"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(d.join("project-defaults.json")).unwrap().permissions().mode() & 0o777, 0o600);
        }
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn lets_one_of_many_racing_writers_win() {
        // As separate instances would: each read the same text, and all try to replace it at once.
        let d = temp_dir("race");
        swap(&d, TAGS, None, "base").unwrap();
        let won: Vec<bool> = (0..16)
            .map(|i| {
                let d = d.clone();
                std::thread::spawn(move || swap(&d, TAGS, Some("base"), &format!("writer {i}")).unwrap().swapped)
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|t| t.join().unwrap())
            .collect();
        assert_eq!(won.iter().filter(|w| **w).count(), 1);
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn keeps_each_file_apart() {
        let d = temp_dir("apart");
        assert!(swap(&d, TAGS, None, "tags").unwrap().swapped);
        assert_eq!(read(&d, DEFAULTS).unwrap(), None);
        assert!(swap(&d, DEFAULTS, None, "defaults").unwrap().swapped);
        assert_eq!(read(&d, TAGS).unwrap().as_deref(), Some("tags"));
        fs::remove_dir_all(&d).unwrap();
    }
}
