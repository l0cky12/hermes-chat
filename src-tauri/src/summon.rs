//! Bringing the one Hermes Chat window forward: `hermes-chat --show`, `hermes-chat --toggle`, a second launch, and a
//! chat link all come here through remote.rs. There is no global shortcut in the app (ADR 0107 is superseded); anyone
//! who wants a key binds `hermes-chat --toggle` in their desktop's own config, such as a Hyprland `bind`
//! or, on Windows, the Shortcut key of a shortcut that runs it.

use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow};

/// Tells the webview the window was brought forward, so it puts the cursor back in the composer.
pub const SUMMONED_EVENT: &str = "summoned";
/// Where the removed global shortcut kept its setting. Nothing reads it now; it is deleted at startup.
const OLD_SETTING_FILE: &str = "global-shortcut.json";

#[cfg(target_os = "linux")]
pub fn wayland() -> bool {
    std::env::var_os("WAYLAND_DISPLAY").is_some() || std::env::var("XDG_SESSION_TYPE").is_ok_and(|t| t == "wayland")
}

#[cfg(target_os = "linux")]
fn desktop() -> &'static str {
    let current = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default().to_ascii_lowercase();
    if std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_some() || current.contains("hyprland") {
        "hyprland"
    } else if std::env::var_os("SWAYSOCK").is_some() || current.contains("sway") {
        "sway"
    } else {
        "other"
    }
}

/// Deletes the removed global shortcut's setting file from the app's config directory, if an older version left one.
pub fn forget_old_shortcut<R: Runtime>(app: &AppHandle<R>) {
    let Ok(dir) = app.path().app_config_dir() else { return };
    remove_old_setting(&dir);
}

fn remove_old_setting(dir: &std::path::Path) {
    let path = dir.join(OLD_SETTING_FILE);
    match std::fs::remove_file(&path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => eprintln!("hermes-chat: couldn't remove the old shortcut setting {}: {e}", path.display()),
    }
}

/// Brings the one window forward, or hides it when it is already in front and `hide_if_active` (`--toggle`). `token`:
/// a Wayland activation token from the desktop, so the compositor lets the window take focus.
pub fn activate<R: Runtime>(app: &AppHandle<R>, hide_if_active: bool, token: Option<String>) {
    let Some(window) = app.get_webview_window("main") else { return };
    let app = app.clone();
    let w = window.clone();
    let _ = window.run_on_main_thread(move || {
        let focused = w.is_focused().unwrap_or(false);
        let in_front = w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false) && focused;
        if in_front && hide_if_active {
            if w.hide().is_ok() {
                crate::tray::seen(&app, true);
            }
            return;
        }
        let _ = w.unminimize();
        let _ = w.show();
        // Hidden to the tray or not, the tray and the webview learn it is back (tray.rs, ADR 0034).
        crate::tray::seen(&app, false);
        raise(&w, token);
        let _ = app.emit(SUMMONED_EVENT, ());
        #[cfg(target_os = "linux")]
        if !in_front && wayland() {
            std::thread::spawn(nudge_compositor);
        }
    });
}

/// Gives the shown window focus, on the main thread. With a desktop's activation token GTK presents it through
/// xdg-activation, which Hyprland and other Wayland compositors accept as the owner's own request. Windows has no
/// token; Tauri's focus there gets past the foreground lock itself.
pub fn raise<R: Runtime>(w: &WebviewWindow<R>, token: Option<String>) {
    #[cfg(target_os = "linux")]
    if let (Some(token), Ok(gtk)) = (token.as_deref(), w.gtk_window()) {
        use gtk::prelude::GtkWindowExt;
        gtk.set_startup_id(token);
        gtk.present();
        return;
    }
    #[cfg(not(target_os = "linux"))]
    drop(token);
    let _ = w.set_focus();
}

/// Hyprland and Sway keep focus where it is when an app asks for it without a token; their own IPC moves it, to the
/// workspace the window is on.
#[cfg(target_os = "linux")]
fn nudge_compositor() {
    let pid = std::process::id();
    let (cmd, args): (&str, Vec<String>) = match desktop() {
        "hyprland" => ("hyprctl", vec!["dispatch".into(), "focuswindow".into(), format!("pid:{pid}")]),
        "sway" => ("swaymsg", vec![format!("[pid={pid}] focus")]),
        _ => return,
    };
    std::thread::sleep(std::time::Duration::from_millis(80));
    if let Err(e) = std::process::Command::new(cmd).args(&args).output() {
        eprintln!("hermes-chat: couldn't ask {cmd} to focus the window: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_the_old_shortcut_setting_and_leaves_everything_else() {
        let dir = std::env::temp_dir().join(format!("hermes-chat-old-shortcut-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(OLD_SETTING_FILE), r#"{"shortcut":"Ctrl+Alt+H","hideWhenActive":false}"#).unwrap();
        std::fs::write(dir.join("other.json"), "{}").unwrap();
        remove_old_setting(&dir);
        assert!(!dir.join(OLD_SETTING_FILE).exists());
        assert!(dir.join("other.json").exists());
        // Already gone: nothing to do, and no error.
        remove_old_setting(&dir);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
