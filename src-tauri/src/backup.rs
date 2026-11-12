//! Backups of what this computer keeps (src/hermes/backup.ts, ADR 0038): a plain zip of JSON files, one of them a
//! manifest with each other file's SHA-256. The webview builds and checks the JSON; this side only writes the zip where
//! the owner picks, or into the app's own recovery folder, and reads a zip the owner picked, refusing anything that
//! isn't a small, flat archive of JSON files: entries are stored, never compressed, named without folders, and read
//! no further than the limits below whatever their headers claim. Nothing in an archive is ever run or written out.
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

/// The most an archive can be on disk, the most entries it can have, and the most one entry and all of them can be
/// once read. Entries are stored, so what is read can't outgrow the file.
pub const MAX_ARCHIVE_BYTES: u64 = 32 * 1024 * 1024;
pub const MAX_ENTRIES: usize = 32;
pub const MAX_ENTRY_BYTES: u64 = 16 * 1024 * 1024;
/// Recovery backups kept in the app's data folder; the oldest go first.
const RECOVERY_KEPT: usize = 5;

/// One JSON file in an archive.
#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct Entry {
    pub name: String,
    pub text: String,
}

/// A name an entry may have: a flat `name.json` of lower-case letters, digits and dashes. No folder, no `..`, no
/// absolute path, no backslash, so no entry can name a place outside the archive.
pub fn safe_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".json") else { return false };
    !stem.is_empty() && stem.len() <= 64 && stem.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') && !stem.starts_with('-')
}

fn check_entries(entries: &[Entry]) -> Result<(), String> {
    if entries.is_empty() || entries.len() > MAX_ENTRIES {
        return Err(format!("A backup holds 1 to {MAX_ENTRIES} files."));
    }
    let mut total = 0u64;
    for (i, e) in entries.iter().enumerate() {
        if !safe_name(&e.name) {
            return Err(format!("“{}” isn't a name a backup file can have.", e.name));
        }
        if entries[..i].iter().any(|o| o.name == e.name) {
            return Err(format!("“{}” is in the backup twice.", e.name));
        }
        // The reader's limits, so nothing is written that a restore would refuse.
        if e.text.len() as u64 > MAX_ENTRY_BYTES {
            return Err(format!("“{}” would be over {} MB, more than a backup file can hold.", e.name, MAX_ENTRY_BYTES / 1024 / 1024));
        }
        total += e.text.len() as u64;
    }
    if total > MAX_ARCHIVE_BYTES - 64 * 1024 {
        return Err(format!("The backup would be over {} MB.", MAX_ARCHIVE_BYTES / 1024 / 1024));
    }
    Ok(())
}

/// Writes `entries` as a zip at `path`, whole and private (`private_file::write_with`), so a failure leaves whatever
/// was there.
pub fn write_zip(path: &Path, entries: &[Entry]) -> Result<(), String> {
    check_entries(entries)?;
    crate::private_file::write_with(path, |file| {
        let write = || -> zip::result::ZipResult<()> {
            let mut zip = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored).unix_permissions(0o600);
            for e in entries {
                zip.start_file(e.name.as_str(), options)?;
                zip.write_all(e.text.as_bytes())?;
            }
            zip.finish()?;
            Ok(())
        };
        write().map_err(io::Error::other)
    })
    .map_err(|e| format!("Couldn't write the backup: {e}"))
}

/// The JSON files in the zip at `path`, read whole and checked: see the module comment for what is refused.
pub fn read_zip(path: &Path) -> Result<Vec<Entry>, String> {
    let file = fs::File::open(path).map_err(|e| format!("Couldn't open it: {e}"))?;
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("It isn't a file.".into());
    }
    if meta.len() > MAX_ARCHIVE_BYTES {
        return Err(format!("It's over {} MB, bigger than any backup Hermes Chat makes.", MAX_ARCHIVE_BYTES / 1024 / 1024));
    }
    let mut zip =
        zip::ZipArchive::new(io::BufReader::new(file)).map_err(|e| format!("It isn't a readable zip archive ({e}). It may be damaged or cut short."))?;
    if zip.is_empty() || zip.len() > MAX_ENTRIES {
        return Err(format!("It has {} files; a backup has 1 to {MAX_ENTRIES}.", zip.len()));
    }
    let mut out: Vec<Entry> = Vec::new();
    let mut total = 0u64;
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).map_err(|e| format!("Couldn't read file {} in it: {e}", i + 1))?;
        let name = String::from_utf8(f.name_raw().to_vec()).map_err(|_| "A file in it has a name that isn't text.".to_string())?;
        if !safe_name(&name) || f.is_dir() || f.is_symlink() || f.enclosed_name().is_none() {
            return Err(format!("It holds “{}”, which no backup has: only JSON files, with no folders.", name.escape_debug()));
        }
        if out.iter().any(|e| e.name == name) {
            return Err(format!("“{name}” is in it twice."));
        }
        if f.compression() != zip::CompressionMethod::Stored {
            return Err(format!("“{name}” is compressed; Hermes Chat stores backup files uncompressed and reads only those."));
        }
        if f.size() > MAX_ENTRY_BYTES {
            return Err(format!("“{name}” is over {} MB.", MAX_ENTRY_BYTES / 1024 / 1024));
        }
        // The header's size isn't trusted: read one byte past the limit to know it was passed.
        let mut bytes = Vec::new();
        (&mut f).take(MAX_ENTRY_BYTES + 1).read_to_end(&mut bytes).map_err(|e| format!("“{name}” couldn't be read whole ({e}). The backup may be damaged."))?;
        total += bytes.len() as u64;
        if bytes.len() as u64 > MAX_ENTRY_BYTES || total > MAX_ARCHIVE_BYTES {
            return Err("It holds more than any backup Hermes Chat makes.".into());
        }
        let text = String::from_utf8(bytes).map_err(|_| format!("“{name}” isn't UTF-8 text."))?;
        out.push(Entry { name, text });
    }
    Ok(out)
}

/// The recovery backups' folder, and the newest kept: `recovery-<ms>.zip`, past RECOVERY_KEPT the oldest deleted.
fn save_recovery(dir: &Path, entries: &[Entry], now_ms: u128) -> Result<PathBuf, String> {
    fs::create_dir_all(dir).map_err(|e| format!("Couldn't make the recovery folder: {e}"))?;
    let path = dir.join(format!("recovery-{now_ms}.zip"));
    write_zip(&path, entries)?;
    let mut old: Vec<PathBuf> = fs::read_dir(dir)
        .map(|r| {
            r.flatten()
                .map(|e| e.path())
                .filter(|p| p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("recovery-") && n.to_string_lossy().ends_with(".zip")))
                .collect()
        })
        .unwrap_or_default();
    old.sort();
    for p in old.iter().take(old.len().saturating_sub(RECOVERY_KEPT)) {
        let _ = fs::remove_file(p);
    }
    Ok(path)
}

/// Saves a backup where the owner picks in the native Save dialog, which asks before replacing a file. The webview
/// never names the path. `None`: the owner cancelled, and nothing was written.
#[tauri::command]
pub async fn backup_export(app: AppHandle, entries: Vec<Entry>, file_name: String) -> Result<Option<String>, String> {
    check_entries(&entries)?;
    let file_name = if file_name.ends_with(".zip") && file_name.len() <= 80 && file_name.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)) {
        file_name
    } else {
        "hermes-chat-backup.zip".into()
    };
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Export backup — it holds your drafts and other personal data")
        .set_file_name(file_name)
        .add_filter("Zip archive", &["zip"]);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    dialog.save_file(move |path| {
        let _ = tx.send(path);
    });
    let Some(path) = rx.await.map_err(|e| e.to_string())? else { return Ok(None) };
    let path = path.into_path().map_err(|e| e.to_string())?;
    let shown = path.display().to_string();
    tokio::task::spawn_blocking(move || write_zip(&path, &entries)).await.map_err(|e| e.to_string())??;
    Ok(Some(shown))
}

/// A backup the owner picked to restore.
#[derive(Serialize)]
pub struct PickedBackup {
    name: String,
    path: String,
    bytes: u64,
    entries: Vec<Entry>,
}

/// Opens the native Open dialog for a backup and reads the archive picked (`read_zip`). `None`: cancelled.
#[tauri::command]
pub async fn backup_pick(app: AppHandle) -> Result<Option<PickedBackup>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app.dialog().file().set_title("Restore a backup").add_filter("Zip archive", &["zip"]);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    dialog.pick_file(move |path| {
        let _ = tx.send(path);
    });
    let Some(path) = rx.await.map_err(|e| e.to_string())? else { return Ok(None) };
    let path = path.into_path().map_err(|e| e.to_string())?;
    let name = path.file_name().map_or_else(|| path.display().to_string(), |n| n.to_string_lossy().into_owned());
    let bytes = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let entries = tokio::task::spawn_blocking({
        let path = path.clone();
        move || read_zip(&path)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(Some(PickedBackup { name, path: path.display().to_string(), bytes, entries }))
}

/// Saves a backup of this computer's data as it is before a restore, in the app's data folder (`backups/`), and
/// answers where. A restore goes ahead only once this has worked.
#[tauri::command]
pub async fn backup_save_recovery(app: AppHandle, entries: Vec<Entry>) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("backups");
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_millis();
    let path = tokio::task::spawn_blocking(move || save_recovery(&dir, &entries, now)).await.map_err(|e| e.to_string())??;
    Ok(path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("hc-backup-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }
    fn entry(name: &str, text: &str) -> Entry {
        Entry { name: name.into(), text: text.into() }
    }
    /// A zip built by hand, for archives this app would never write.
    fn raw_zip(path: &Path, files: &[(&str, &[u8], zip::CompressionMethod)]) {
        let mut zip = zip::ZipWriter::new(fs::File::create(path).unwrap());
        for (name, bytes, method) in files {
            zip.start_file(*name, zip::write::SimpleFileOptions::default().compression_method(*method)).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn names_are_flat_json_files() {
        for ok in ["manifest.json", "drafts.json", "project-defaults.json"] {
            assert!(safe_name(ok), "{ok}");
        }
        for bad in ["../x.json", "/etc/x.json", "a/b.json", "a\\b.json", ".json", "-x.json", "X.json", "x.json.exe", "x.sh", "x .json", "x.JSON"] {
            assert!(!safe_name(bad), "{bad}");
        }
    }

    #[test]
    fn round_trips_and_keeps_the_file_private() {
        let d = temp_dir("round");
        let p = d.join("b.zip");
        let files = vec![entry("manifest.json", "{\"a\":1}"), entry("drafts.json", "{\"records\":[\"é\"]}")];
        write_zip(&p, &files).unwrap();
        assert_eq!(read_zip(&p).unwrap(), files);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
        }
        assert!(fs::read_dir(&d).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(".tmp")));
    }

    #[test]
    fn refuses_what_it_would_never_write() {
        let d = temp_dir("refuse");
        assert!(write_zip(&d.join("x.zip"), &[entry("../evil.json", "{}")]).is_err());
        assert!(write_zip(&d.join("x.zip"), &[entry("a.json", "1"), entry("a.json", "2")]).is_err());
        assert!(!d.join("x.zip").exists());

        let traversal = d.join("traversal.zip");
        raw_zip(&traversal, &[("../../escape.json", b"{}", zip::CompressionMethod::Stored)]);
        assert!(read_zip(&traversal).unwrap_err().contains("no folders"));
        let folder = d.join("folder.zip");
        raw_zip(&folder, &[("data/x.json", b"{}", zip::CompressionMethod::Stored)]);
        assert!(read_zip(&folder).is_err());
        let script = d.join("script.zip");
        raw_zip(&script, &[("run.sh", b"rm -rf ~", zip::CompressionMethod::Stored)]);
        assert!(read_zip(&script).is_err());

        let truncated = d.join("truncated.zip");
        write_zip(&truncated, &[entry("manifest.json", &"x".repeat(5000))]).unwrap();
        let bytes = fs::read(&truncated).unwrap();
        fs::write(&truncated, &bytes[..bytes.len() / 2]).unwrap();
        assert!(read_zip(&truncated).unwrap_err().contains("damaged or cut short"));

        // A flipped byte in an entry's data fails its CRC as it is read to the end.
        let corrupt = d.join("corrupt.zip");
        write_zip(&corrupt, &[entry("manifest.json", &"y".repeat(5000))]).unwrap();
        let mut bytes = fs::read(&corrupt).unwrap();
        let at = bytes.windows(4).position(|w| w == b"yyyy").unwrap() + 100;
        bytes[at] = b'z';
        fs::write(&corrupt, &bytes).unwrap();
        assert!(read_zip(&corrupt).unwrap_err().contains("damaged"));

        let big = d.join("big.zip");
        fs::write(&big, vec![0u8; (MAX_ARCHIVE_BYTES + 1) as usize]).unwrap();
        assert!(read_zip(&big).unwrap_err().contains("over 32 MB"));

        let many = d.join("many.zip");
        let names: Vec<String> = (0..=MAX_ENTRIES).map(|i| format!("f{i}.json")).collect();
        raw_zip(&many, &names.iter().map(|n| (n.as_str(), &b"{}"[..], zip::CompressionMethod::Stored)).collect::<Vec<_>>());
        assert!(read_zip(&many).unwrap_err().contains("files"));

        let binary = d.join("binary.zip");
        raw_zip(&binary, &[("manifest.json", &[0xff, 0xfe, 0x00], zip::CompressionMethod::Stored)]);
        assert!(read_zip(&binary).unwrap_err().contains("UTF-8"));
    }

    #[test]
    fn never_writes_through_a_file_planted_beside_it() {
        let d = temp_dir("planted");
        let victim = d.join("victim.txt");
        fs::write(&victim, "keep me").unwrap();
        let p = d.join("b.zip");
        let planted = d.join(format!(".b.zip.{}.0.tmp", std::process::id()));
        // A symlink needs a privilege on Windows; a plain file there is the same test of never opening what exists.
        #[cfg(unix)]
        std::os::unix::fs::symlink(&victim, &planted).unwrap();
        #[cfg(not(unix))]
        fs::copy(&victim, &planted).unwrap();
        write_zip(&p, &[entry("manifest.json", "{}")]).unwrap();
        assert_eq!(fs::read_to_string(&victim).unwrap(), "keep me");
        assert_eq!(fs::read_to_string(&planted).unwrap(), "keep me");
        assert_eq!(read_zip(&p).unwrap(), vec![entry("manifest.json", "{}")]);
    }

    #[test]
    fn writes_nothing_a_restore_would_refuse() {
        let d = temp_dir("writer-limit");
        let big = " ".repeat((MAX_ENTRY_BYTES + 1) as usize);
        assert!(write_zip(&d.join("x.zip"), &[entry("manifest.json", "{}"), entry("drafts.json", &big)]).unwrap_err().contains("over 16 MB"));
        assert!(!d.join("x.zip").exists());
    }

    #[test]
    fn an_entry_past_the_limit_is_refused() {
        // Entries are stored, so a bomb can't be smaller on disk than it reads; one past the limit is refused anyway.
        let d = temp_dir("bomb");
        let p = d.join("bomb.zip");
        let big = vec![b' '; (MAX_ENTRY_BYTES + 10) as usize];
        raw_zip(&p, &[("manifest.json", &big, zip::CompressionMethod::Stored)]);
        assert!(read_zip(&p).unwrap_err().contains("over 16 MB"));
    }

    #[test]
    fn keeps_only_the_newest_recovery_backups() {
        let d = temp_dir("recovery");
        for ms in 1..=7u128 {
            save_recovery(&d, &[entry("manifest.json", "{}")], 1_000_000_000_000 + ms).unwrap();
        }
        let mut names: Vec<String> = fs::read_dir(&d).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        assert_eq!(names.len(), RECOVERY_KEPT);
        assert_eq!(names[0], "recovery-1000000000003.zip");
    }
}
