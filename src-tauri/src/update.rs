// Updates. How this copy of the app was installed decides who may replace it:
// - pacman owns it (the hermes-chat-git PKGBUILD): only the package manager replaces its files. The app reports the
//   package's version, and notices when pacman has installed a newer one, so a restart picks it up.
// - a standalone AppImage built with an update key: Tauri's updater downloads the release, checks its signature against
//   the key built into the app, and swaps the AppImage. Nothing else ever goes through the updater, because with no
//   bundle type it would overwrite whatever file the binary runs from.
// - anything else (a build from source): nothing here updates it.
// The webview checks GitHub for the pacman case itself (src/hermes/updates.ts).
use serde::Serialize;
use std::path::PathBuf;
use tauri::ipc::Channel;
use tauri::utils::config::BundleType;
use tauri::utils::platform::{bundle_type, current_exe};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::{Mutex, OnceCell};

#[derive(Default)]
pub struct Updates {
    /// The owning package and its version when the app started, read once: after pacman replaces the binary the running
    /// process is still the old one.
    started: OnceCell<Option<(String, String)>>,
    /// The update the last check found, for the owner to install.
    found: Mutex<Option<Update>>,
    /// The owner asked to restart: start the app again once this one has exited (`relaunch`).
    restart: AtomicBool,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Install {
    /// `running`: the package version the app started from. `installed`: the version pacman has now, `None` if the
    /// package is gone.
    Pacman { package: String, running: String, installed: Option<String> },
    /// `updater`: built with an update key and endpoint, so it can update itself.
    AppImage { version: String, updater: bool },
    Unmanaged { version: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Available {
    version: String,
    current: String,
    notes: Option<String>,
    date: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum Progress {
    Downloading { downloaded: u64, total: Option<u64> },
    Installing,
}

/// `pacman -Q` prints `name version`.
fn parse_query(stdout: &str) -> Option<String> {
    let mut words = stdout.split_whitespace();
    words.next()?;
    words.next().map(str::to_owned)
}

async fn pacman(args: &[&std::ffi::OsStr]) -> Option<String> {
    let out = Command::new("pacman").args(args).output().await.ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

async fn package_version(package: &str) -> Option<String> {
    parse_query(&pacman(&["-Q".as_ref(), package.as_ref()]).await?)
}

/// The package that owns the binary the app started from, and its version. None without pacman, or for a file no
/// package owns.
async fn owner(exe: PathBuf) -> Option<(String, String)> {
    let package = pacman(&["-Qqo".as_ref(), exe.as_os_str()]).await?;
    let version = package_version(&package).await?;
    Some((package, version))
}

/// Running from an AppImage, which the updater replaces in place. A binary pulled out of one has no `APPIMAGE`.
fn is_appimage() -> bool {
    bundle_type() == Some(BundleType::AppImage) && std::env::var_os("APPIMAGE").is_some()
}

/// Whether this build has the updater's key and endpoints, so the plugin is registered (lib.rs).
pub fn configured(config: &tauri::Config) -> bool {
    config.plugins.0.contains_key("updater")
}

impl Updates {
    /// Reads the owning package now, before anything can replace it.
    pub async fn start(&self) {
        self.started.get_or_init(|| async { owner(current_exe().ok()?).await }).await;
    }
}

#[tauri::command]
pub async fn update_install_kind(app: AppHandle, state: State<'_, Updates>) -> Result<Install, String> {
    let version = app.package_info().version.to_string();
    if is_appimage() {
        return Ok(Install::AppImage { version, updater: configured(app.config()) });
    }
    state.start().await;
    Ok(match state.started.get().cloned().flatten() {
        Some((package, running)) => Install::Pacman { installed: package_version(&package).await, package, running },
        None => Install::Unmanaged { version },
    })
}

#[tauri::command]
pub async fn update_check(app: AppHandle, state: State<'_, Updates>) -> Result<Option<Available>, String> {
    if !is_appimage() || !configured(app.config()) {
        return Err("This copy of Hermes Chat can't update itself.".into());
    }
    let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    let available = update.as_ref().map(|u| Available {
        version: u.version.clone(),
        current: u.current_version.clone(),
        notes: u.body.clone(),
        date: u.date.map(|d| d.to_string()),
    });
    *state.found.lock().await = update;
    Ok(available)
}

/// Downloads the update the last check found, verifies its signature and replaces the AppImage. The app keeps running
/// the old version until it restarts.
#[tauri::command]
pub async fn update_download_and_install(state: State<'_, Updates>, on_progress: Channel<Progress>) -> Result<(), String> {
    // Taken out while it installs, so a second click can't start another; put back if it fails, to try again.
    let Some(update) = state.found.lock().await.take() else {
        return Err("Check for updates again first.".into());
    };
    let (mut downloaded, mut sent) = (0u64, 0u64);
    let result = update
        .download_and_install(
            |chunk, total| {
                downloaded += chunk as u64;
                // About 200 messages for a 100 MB download, rather than one per chunk.
                if downloaded - sent >= 512 * 1024 || Some(downloaded) == total {
                    sent = downloaded;
                    let _ = on_progress.send(Progress::Downloading { downloaded, total });
                }
            },
            || {
                let _ = on_progress.send(Progress::Installing);
            },
        )
        .await;
    if let Err(e) = result {
        *state.found.lock().await = Some(update);
        return Err(e.to_string());
    }
    Ok(())
}

fn drafts_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("restart-drafts.json"))
}

/// Restarts the app. `drafts` (every draft and outbox, from localStorage; updates.ts `DRAFT_PREFIXES`) is written to disk first, and nothing
/// restarts if that fails; the next launch puts them back (`restart_drafts_read`), in case the webview hadn't saved
/// the last keystrokes when the process ended.
#[tauri::command]
pub async fn app_restart(app: AppHandle, state: State<'_, Updates>, drafts: String) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let path = drafts_file(&app)?;
    let save = || -> std::io::Result<()> {
        std::fs::create_dir_all(path.parent().expect("a file in a directory"))?;
        let mut file = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&path)?;
        file.write_all(drafts.as_bytes())?;
        file.sync_all()
    };
    save().map_err(|e| format!("Couldn't save your drafts before restarting, so the app didn't restart: {e}"))?;
    // Not `app.restart()`: that starts the app with the same arguments, and a copy started by the desktop shortcut
    // (`--screenshot`) would hand the screenshot to this one as it exits, and quit (main.rs).
    state.restart.store(true, Ordering::Relaxed);
    app.exit(0);
    Ok(())
}

/// The arguments to start the app again with: the same, less `--screenshot`.
fn relaunch_args(args: impl IntoIterator<Item = std::ffi::OsString>) -> Vec<std::ffi::OsString> {
    args.into_iter().skip(1).filter(|a| a != "--screenshot").collect()
}

/// Starts the app again, if the owner asked to restart, from the binary it started from (or the AppImage, which the
/// updater may have replaced). Called as the app exits (lib.rs).
pub fn relaunch(app: &AppHandle) {
    if !app.state::<Updates>().restart.load(Ordering::Relaxed) {
        return;
    }
    let env = app.env();
    match tauri::process::current_binary(&env) {
        Ok(exe) => {
            if let Err(e) = std::process::Command::new(exe).args(relaunch_args(env.args_os)).spawn() {
                eprintln!("hermes-chat: couldn't start again after the update: {e}");
            }
        }
        Err(e) => eprintln!("hermes-chat: couldn't find the app to start again after the update: {e}"),
    }
}

/// The drafts saved by the last restart, if any. The file stays until the webview has put them all back
/// (`restart_drafts_clear`), so a crash or a full store at launch doesn't lose them. An error if it is there but can't
/// be read: the app doesn't open over it.
#[tauri::command]
pub async fn restart_drafts_read(app: AppHandle) -> Result<Option<String>, String> {
    let path = drafts_file(&app)?;
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

#[tauri::command]
pub async fn restart_drafts_clear(app: AppHandle) -> Result<(), String> {
    let path = drafts_file(&app)?;
    match std::fs::remove_file(&path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("{}: {e}", path.display())),
        _ => Ok(()),
    }
}

/// Moves the drafts saved by the last restart to a file of their own, never put back, when the webview couldn't put
/// them all back (its storage is full), so they can't later overwrite what the owner types. Returns its path.
#[tauri::command]
pub async fn restart_drafts_set_aside(app: AppHandle) -> Result<String, String> {
    let from = drafts_file(&app)?;
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
    let to = from.with_file_name(format!("restart-drafts-{secs}.json"));
    std::fs::rename(&from, &to).map_err(|e| format!("{}: {e}", from.display()))?;
    Ok(to.display().to_string())
}

/// The screenshots that drafts saved for a restart and not put back yet (`restart-drafts*.json`) attach, for screenshot
/// cleanup to keep (lib.rs `screenshot_sync_outbox`) until the owner moves or deletes the file.
// ponytail: reads every such file on each outbox sync; they exist only after a restore failed, so there is rarely one.
pub fn saved_attachment_paths(app: &AppHandle) -> Vec<PathBuf> {
    let mut paths = vec![];
    let Ok(entries) = app.path().app_data_dir().and_then(|dir| Ok(std::fs::read_dir(dir)?)) else {
        return paths;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with("restart-drafts") && name.ends_with(".json") {
            if let Ok(text) = std::fs::read_to_string(entry.path()) {
                attachment_paths(&text, &mut paths);
            }
        }
    }
    paths
}

/// Every `"path"` in `json`, looking into string values that are JSON themselves: each outbox is kept as one.
fn attachment_paths(json: &str, out: &mut Vec<PathBuf>) {
    use serde_json::Value;
    fn walk(v: &Value, out: &mut Vec<PathBuf>) {
        match v {
            Value::Object(fields) => {
                for (k, v) in fields {
                    match v {
                        Value::String(s) if k == "path" => out.push(s.into()),
                        _ => walk(v, out),
                    }
                }
            }
            Value::Array(items) => items.iter().for_each(|v| walk(v, out)),
            Value::String(s) if s.starts_with(['[', '{']) => {
                if let Ok(v) = serde_json::from_str(s) {
                    walk(&v, out)
                }
            }
            _ => {}
        }
    }
    if let Ok(v) = serde_json::from_str(json) {
        walk(&v, out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_version_from_pacman_query() {
        assert_eq!(parse_query("hermes-chat-git r312.ef433a2-1\n"), Some("r312.ef433a2-1".into()));
        assert_eq!(parse_query("hermes-chat 1:0.2.0-3"), Some("1:0.2.0-3".into()));
        assert_eq!(parse_query("hermes-chat-git"), None);
        assert_eq!(parse_query(""), None);
    }

    #[test]
    fn restarts_without_asking_for_a_screenshot() {
        let args = ["/usr/bin/hermes-chat", "--screenshot", "--other"].map(std::ffi::OsString::from);
        assert_eq!(relaunch_args(args), ["--other"]);
    }

    #[test]
    fn finds_the_screenshots_saved_outboxes_attach() {
        let outbox = r#"[{"kind":"user","text":"look","outgoing":{"state":"unsent","attachments":[{"name":"a.png","path":"/c/1/a.png"}]}}]"#;
        let saved = serde_json::json!({ "hermes-chat.outbox.x": outbox, "hermes-chat.draft.y": "[not json" }).to_string();
        let mut paths = vec![];
        attachment_paths(&saved, &mut paths);
        assert_eq!(paths, [PathBuf::from("/c/1/a.png")]);
    }

    #[test]
    fn install_serializes_for_the_webview() {
        let i = Install::Pacman { package: "hermes-chat-git".into(), running: "r1.abc1234-1".into(), installed: None };
        assert_eq!(
            serde_json::to_string(&i).unwrap(),
            r#"{"kind":"pacman","package":"hermes-chat-git","running":"r1.abc1234-1","installed":null}"#
        );
        let i = Install::AppImage { version: "0.1.0".into(), updater: false };
        assert_eq!(serde_json::to_string(&i).unwrap(), r#"{"kind":"appImage","version":"0.1.0","updater":false}"#);
    }
}
