//! The tray icon and Close to tray (issue #77, ADR 0034; the icon's design: issue #177, ADR 0049).
//!
//! The tray icon offers Show/Hide, New chat, Open Inbox (with how many entries need the owner, never chat text) and
//! Quit. Its icon gets a dot while the Inbox has something. Closing the window quits, as it always has, unless the owner
//! turned on Close to tray in Settings and this desktop has somewhere to show the icon now; then closing hides the
//! window, and the tray icon, a second launch (remote.rs `Show`) or New chat bring the same window back.
//!
//! On Windows the notification area is always there. On Linux whether the desktop can show the icon is checked every
//! two seconds: a StatusNotifierItem host on the session bus
//! (KDE Plasma, Xfce, waybar, GNOME with the AppIndicator extension), or, on X11, an XEmbed tray (i3bar, stalonetray).
//! If the host goes away while the window is hidden, the window comes back, so the app never ends up hidden with no
//! way back. The library that draws the icon (libayatana-appindicator) re-registers when the host returns.
//!
//! The setting lives in `window.json` in the app's config folder, for this computer, not per connection or profile.
//! Nothing here keeps running after Quit: it is the same process as the window.

use crate::lock::Locked;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime, WindowEvent};

/// Tells the webview the window was hidden or shown: `{ hidden: bool }`.
pub const VISIBILITY_EVENT: &str = "window-visibility";
/// The owner picked New chat in the tray menu.
pub const NEW_CHAT_EVENT: &str = "tray-new-chat";
/// The owner picked Open Inbox in the tray menu.
pub const INBOX_EVENT: &str = "tray-open-inbox";
/// The tray's state changed: a `TrayStatus`.
pub const STATUS_EVENT: &str = "tray-status";

const SETTINGS_FILE: &str = "window.json";

/// Whether the desktop shows the tray icon now.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TrayState {
    /// The icon is in the desktop's tray.
    Shown,
    /// The icon is made, but nothing on this desktop shows tray icons right now.
    NoTray,
    /// The icon couldn't be made at all; `why` says why.
    Unavailable,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayStatus {
    /// The owner's setting, as stored.
    pub close_to_tray: bool,
    pub tray: TrayState,
    /// Why the tray is `Unavailable`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
}

#[derive(Default, Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
struct Settings {
    #[serde(default)]
    close_to_tray: bool,
}

/// The tray's state, managed by Tauri.
pub struct Tray {
    settings: Mutex<Option<PathBuf>>,
    close_to_tray: AtomicBool,
    state: Mutex<(TrayState, Option<String>)>,
    /// The window is hidden by this app (not merely minimized).
    hidden: AtomicBool,
    /// The webview has an unsaved edit that closing would drop, so Quit closes through the webview's question.
    unsaved: AtomicBool,
    /// The next close request comes from Quit: it closes, never hides.
    quitting: AtomicBool,
    inbox: AtomicU32,
    parts: Mutex<Option<Parts>>,
}

/// Cloned out of the lock before use: menu and icon calls wait on the main thread, which may be waiting on the lock.
#[derive(Clone)]
struct Parts {
    icon: TrayIcon,
    show: MenuItem<tauri::Wry>,
    inbox: MenuItem<tauri::Wry>,
    plain: Image<'static>,
    dotted: Image<'static>,
}

impl Default for Tray {
    fn default() -> Self {
        Tray {
            settings: Mutex::new(None),
            close_to_tray: AtomicBool::new(false),
            state: Mutex::new((TrayState::Unavailable, Some("The tray hasn't started yet.".into()))),
            hidden: AtomicBool::new(false),
            unsaved: AtomicBool::new(false),
            quitting: AtomicBool::new(false),
            inbox: AtomicU32::new(0),
            parts: Mutex::new(None),
        }
    }
}

impl Tray {
    pub fn status(&self) -> TrayStatus {
        let (tray, why) = self.state.locked().clone();
        TrayStatus { close_to_tray: self.close_to_tray.load(Ordering::SeqCst), tray, why }
    }

    fn parts(&self) -> Option<Parts> {
        self.parts.locked().clone()
    }

    /// Closing the window hides it now.
    fn close_hides(&self) -> bool {
        closing_hides(self.close_to_tray.load(Ordering::SeqCst), self.state.locked().0)
    }
}

/// Closing hides the window only when the owner asked for it and the icon is on screen to bring it back.
pub fn closing_hides(close_to_tray: bool, tray: TrayState) -> bool {
    close_to_tray && tray == TrayState::Shown
}

/// The window must come back: it is hidden and nothing shows the icon that would bring it back.
pub fn must_reappear(hidden: bool, tray: TrayState) -> bool {
    hidden && tray != TrayState::Shown
}

/// The Inbox line of the tray menu: a count only, never what a chat says.
pub fn inbox_label(count: u32) -> String {
    if count == 0 {
        "Open Inbox".into()
    } else {
        format!("Open Inbox ({count})")
    }
}

/// The tray icon, drawn for panels (assets/icons/tray.svg, ADR 0049): the app's clay tile and H, full-bleed, with a
/// darker rim so it stands apart from light and dark panels alike. One 64px image, which the panel scales to its size.
const TRAY_ICON: &[u8] = include_bytes!("../icons/tray.png");
/// The same icon with the Inbox dot (assets/icons/tray-inbox.svg): a red dot top-right, ringed clear of the tile.
const TRAY_INBOX_ICON: &[u8] = include_bytes!("../icons/tray-inbox.png");

fn read_settings(path: &PathBuf) -> Settings {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
            eprintln!("hermes-chat: {} isn't readable, so Close to tray is off: {e}", path.display());
            Settings::default()
        }),
        Err(_) => Settings::default(),
    }
}

fn write_settings(path: &Path, settings: &Settings) -> Result<(), String> {
    let dir = path.parent().ok_or("No folder for the window settings.")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let text = serde_json::to_string(settings).map_err(|e| e.to_string())?;
    crate::private_file::write(path, text.as_bytes()).map_err(|e| format!("{}: {e}", path.display()))
}

/// Shows the window, brings it forward and tells the webview, which puts focus back where it was.
pub fn show<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    seen(app, false);
}

/// Hides the window to the tray and tells the webview, which stops Dictation and Read aloud.
pub fn hide<R: Runtime>(app: &AppHandle<R>) {
    let tray = app.state::<Tray>();
    if let Some(window) = app.get_webview_window("main") {
        if window.hide().is_err() {
            return;
        }
    }
    seen(app, true);
    // The tray may have gone between deciding to hide and hiding: the watcher, which saw the window still showing,
    // won't bring it back, so this does.
    if must_reappear(true, tray.state.locked().0) {
        show(app);
    }
}

/// The window was just shown or hidden, here or by `--show`/`--toggle` (summon.rs): the tray's Show/Hide line and the
/// webview, which stops Dictation and Read aloud while hidden, follow it.
pub fn seen<R: Runtime>(app: &AppHandle<R>, hidden: bool) {
    let Some(tray) = app.try_state::<Tray>() else { return };
    tray.hidden.store(hidden, Ordering::SeqCst);
    let _ = app.emit(VISIBILITY_EVENT, serde_json::json!({ "hidden": hidden }));
    set_show_label(&tray, hidden);
}

fn set_show_label(tray: &Tray, hidden: bool) {
    if let Some(parts) = tray.parts() {
        let _ = parts.show.set_text(if hidden { "Show Hermes Chat" } else { "Hide Hermes Chat" });
    }
}

fn toggle<R: Runtime>(app: &AppHandle<R>) {
    let tray = app.state::<Tray>();
    let shown = app.get_webview_window("main").is_some_and(|w| w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false));
    if shown && !tray.hidden.load(Ordering::SeqCst) {
        hide(app)
    } else {
        show(app)
    }
}

/// Quit always exits, never hides. With an unsaved edit the window comes forward and closes through the webview's own
/// question (LeaveMemoryEdit.tsx), whose Discard closes the window and so the app.
fn quit<R: Runtime>(app: &AppHandle<R>) {
    let tray = app.state::<Tray>();
    let window = app.get_webview_window("main");
    match window {
        Some(window) if tray.unsaved.load(Ordering::SeqCst) => {
            show(app);
            tray.quitting.store(true, Ordering::SeqCst);
            if window.close().is_err() {
                tray.quitting.store(false, Ordering::SeqCst);
                app.exit(0);
            }
        }
        _ => app.exit(0),
    }
}

/// Closing the window: hides it when Close to tray is on and the icon is on screen; otherwise Tauri closes it as before.
pub fn on_window_event<R: Runtime>(window: &tauri::Window<R>, event: &WindowEvent) {
    if window.label() != "main" {
        return;
    }
    if let WindowEvent::CloseRequested { api, .. } = event {
        let tray = window.state::<Tray>();
        if tray.quitting.swap(false, Ordering::SeqCst) {
            return;
        }
        if tray.close_hides() {
            api.prevent_close();
            hide(window.app_handle());
        }
    }
}

/// Reads the setting, makes the icon and starts watching for the desktop's tray. Never fails the app: without a tray
/// the window works as before, and Settings says why.
pub fn start(app: &AppHandle) {
    let tray = app.state::<Tray>();
    match app.path().app_config_dir() {
        Ok(dir) => {
            let path = dir.join(SETTINGS_FILE);
            tray.close_to_tray.store(read_settings(&path).close_to_tray, Ordering::SeqCst);
            *tray.settings.locked() = Some(path);
        }
        Err(e) => eprintln!("hermes-chat: no config folder, so Close to tray can't be kept: {e}"),
    }
    if let Some(why) = host::missing() {
        *tray.state.locked() = (TrayState::Unavailable, Some(why));
        return;
    }
    match make(app) {
        Ok(parts) => {
            *tray.parts.locked() = Some(parts);
            *tray.state.locked() = (TrayState::NoTray, None);
            host::watch(app.clone());
        }
        Err(e) => {
            *tray.state.locked() = (TrayState::Unavailable, Some(format!("The tray icon couldn't be made: {e}")));
        }
    }
}

fn make(app: &AppHandle) -> tauri::Result<Parts> {
    let plain = Image::from_bytes(TRAY_ICON)?.to_owned();
    let dotted = Image::from_bytes(TRAY_INBOX_ICON)?.to_owned();
    let show_item = MenuItem::with_id(app, "show", "Hide Hermes Chat", true, None::<&str>)?;
    let new_chat = MenuItem::with_id(app, "new-chat", "New chat", true, None::<&str>)?;
    let inbox = MenuItem::with_id(app, "inbox", inbox_label(0), true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit Hermes Chat", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &new_chat, &inbox, &PredefinedMenuItem::separator(app)?, &quit_item])?;
    let icon = TrayIconBuilder::with_id("hermes-chat")
        .icon(plain.clone())
        .tooltip("Hermes Chat")
        .menu(&menu)
        .show_menu_on_left_click(host::MENU_ON_LEFT_CLICK)
        .on_tray_icon_event(|icon, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                if !host::MENU_ON_LEFT_CLICK {
                    toggle(icon.app_handle());
                }
            }
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => toggle(app),
            "new-chat" => {
                show(app);
                let _ = app.emit(NEW_CHAT_EVENT, ());
            }
            "inbox" => {
                show(app);
                let _ = app.emit(INBOX_EVENT, ());
            }
            "quit" => quit(app),
            _ => {}
        })
        .build(app)?;
    Ok(Parts { icon, show: show_item, inbox, plain, dotted })
}

/// A tray seen by either check is there; with neither seeing one, it is gone only if both answered.
pub fn either(a: Option<bool>, b: Option<bool>) -> Option<bool> {
    match (a, b) {
        (Some(true), _) | (_, Some(true)) => Some(true),
        (Some(false), Some(false)) => Some(false),
        _ => None,
    }
}

/// How many checks in a row must find no tray before a tray that was there counts as gone (about four seconds).
const GONE_AFTER: u32 = 2;

/// The tray's state after a check. `None`: the check didn't answer in time (a busy main thread or bus), which changes
/// nothing. A tray that was showing counts as gone only after `GONE_AFTER` empty checks in a row, so one slow or missed
/// check never brings a hidden window back; a tray that appears counts at once.
pub fn next_state(now: TrayState, reading: Option<bool>, misses: &mut u32) -> TrayState {
    match reading {
        None => now,
        Some(true) => {
            *misses = 0;
            if now == TrayState::Unavailable {
                now
            } else {
                TrayState::Shown
            }
        }
        Some(false) => {
            *misses += 1;
            match now {
                TrayState::Shown if *misses < GONE_AFTER => TrayState::Shown,
                TrayState::Unavailable => now,
                _ => TrayState::NoTray,
            }
        }
    }
}

fn changed<R: Runtime>(app: &AppHandle<R>, now: TrayState) {
    let tray = app.state::<Tray>();
    {
        let mut state = tray.state.locked();
        if state.0 == now {
            return;
        }
        *state = (now, None);
    }
    if must_reappear(tray.hidden.load(Ordering::SeqCst), now) {
        eprintln!("hermes-chat: the desktop's tray went away, so the hidden window is shown again");
        show(app);
    }
    let _ = app.emit(STATUS_EVENT, tray.status());
}

/// How this desktop shows tray icons. On Linux a panel may come and go: a StatusNotifierItem host on the session bus
/// (KDE Plasma, Xfce, waybar, GNOME with the AppIndicator extension) or, on X11, an XEmbed tray (i3bar, stalonetray).
#[cfg(target_os = "linux")]
mod host {
    use super::{changed, either, next_state, Tray};
    use crate::lock::Locked;
    use std::time::Duration;
    use tauri::{AppHandle, Manager};

    const POLL: Duration = Duration::from_secs(2);
    /// The panel's own menu opens on a click; appindicator has no click of its own to give.
    pub const MENU_ON_LEFT_CLICK: bool = true;

    /// Why the icon can't be made at all, if it can't.
    pub fn missing() -> Option<String> {
        (!indicator_library()).then(|| "libayatana-appindicator isn't installed, so Hermes Chat can't put an icon in the tray.".into())
    }

    /// Whether libayatana-appindicator (or libappindicator) is installed: the icon library panics without one.
    fn indicator_library() -> bool {
        ["libayatana-appindicator3.so.1", "libappindicator3.so.1", "libayatana-appindicator3.so", "libappindicator3.so"].iter().any(|name| {
            let c = std::ffi::CString::new(*name).unwrap();
            // SAFETY: dlopen with a valid C string; the handle is closed again at once.
            unsafe {
                let h = libc::dlopen(c.as_ptr(), libc::RTLD_LAZY | libc::RTLD_LOCAL);
                if h.is_null() {
                    false
                } else {
                    libc::dlclose(h);
                    true
                }
            }
        })
    }

    /// Checks for a tray every two seconds and reacts when that changes.
    pub fn watch(app: AppHandle) {
        std::thread::spawn(move || {
            let mut bus = None;
            let mut misses = 0;
            loop {
                let sni = sni_host(&mut bus);
                let reading = if sni == Some(true) { Some(true) } else { either(sni, xembed_tray(&app)) };
                let now = app.state::<Tray>().state.locked().0;
                changed(&app, next_state(now, reading, &mut misses));
                std::thread::sleep(POLL);
            }
        });
    }

    /// A StatusNotifierItem host is registered on the session bus. `None` when the bus didn't answer.
    fn sni_host(bus: &mut Option<dbus::blocking::Connection>) -> Option<bool> {
        use dbus::blocking::stdintf::org_freedesktop_dbus::Properties;
        const WATCHER: &str = "org.kde.StatusNotifierWatcher";
        if bus.is_none() {
            *bus = dbus::blocking::Connection::new_session().ok();
        }
        // No session bus at all: nothing can host a StatusNotifierItem.
        let Some(conn) = bus.as_ref() else { return Some(false) };
        let owned: Result<(bool,), _> = conn.with_proxy("org.freedesktop.DBus", "/org/freedesktop/DBus", Duration::from_secs(2)).method_call(
            "org.freedesktop.DBus",
            "NameHasOwner",
            (WATCHER,),
        );
        match owned {
            // A watcher that can't say whether a host is registered decides nothing: a watcher alone shows no icon, so
            // taking it at its word could hide the window with no way back.
            Ok((true,)) => {
                conn.with_proxy(WATCHER, "/StatusNotifierWatcher", Duration::from_secs(2)).get::<bool>(WATCHER, "IsStatusNotifierHostRegistered").ok()
            }
            Ok(_) => Some(false),
            Err(_) => {
                *bus = None;
                None
            }
        }
    }

    /// On X11, something owns the XEmbed system tray selection for the window's screen. Asked on the main thread, through
    /// GDK's own X connection.
    /// `None` when the main thread didn't answer within two seconds.
    fn xembed_tray(app: &AppHandle) -> Option<bool> {
        let (tx, rx) = std::sync::mpsc::channel();
        app.run_on_main_thread(move || {
            let _ = tx.send(xembed_tray_now());
        })
        .ok()?;
        rx.recv_timeout(Duration::from_secs(2)).ok()
    }

    fn xembed_tray_now() -> bool {
        use gtk::glib::object::Cast;
        use gtk::glib::translate::ToGlibPtr;
        let Some(display) = gtk::gdk::Display::default() else { return false };
        let screen = display.default_screen();
        let Ok(x11) = display.downcast::<gdkx11::X11Display>() else { return false };
        let screen = match screen.downcast::<gdkx11::X11Screen>() {
            Ok(s) => s.screen_number(),
            Err(_) => 0,
        };
        let atom = gtk::gdk::Atom::intern(&format!("_NET_SYSTEM_TRAY_S{screen}"));
        let xatom = gdkx11::functions::x11_atom_to_xatom_for_display(&x11, &atom);
        // SAFETY: GDK's own Display pointer, used on the main thread that owns it.
        unsafe {
            let xdisplay = gdkx11::ffi::gdk_x11_display_get_xdisplay(x11.to_glib_none().0);
            x11::xlib::XGetSelectionOwner(xdisplay as *mut x11::xlib::Display, xatom) != 0
        }
    }
}

/// On Windows the notification area is part of the taskbar and always there; the icon library puts the icon back
/// when Explorer restarts. A left click shows or hides the window and a right click opens the menu, as Windows apps do.
#[cfg(not(target_os = "linux"))]
mod host {
    use tauri::AppHandle;

    pub const MENU_ON_LEFT_CLICK: bool = false;

    pub fn missing() -> Option<String> {
        None
    }

    pub fn watch(app: AppHandle) {
        super::changed(&app, super::TrayState::Shown);
    }
}

#[tauri::command]
pub fn tray_status(tray: tauri::State<'_, Tray>) -> TrayStatus {
    tray.status()
}

/// Turns Close to tray on or off, and answers what the file holds once written. The file is written off the main
/// thread.
#[tauri::command]
pub async fn tray_set_close_to_tray(app: AppHandle, on: bool) -> Result<TrayStatus, String> {
    tokio::task::spawn_blocking(move || set_close_to_tray(&app.state::<Tray>(), on)).await.map_err(|e| e.to_string())?
}

fn set_close_to_tray(tray: &Tray, on: bool) -> Result<TrayStatus, String> {
    // Held until the file is read back, so a second switch can't write between this one's write and read.
    let settings = tray.settings.locked();
    let path = settings.as_ref().ok_or("There's no config folder to keep the setting in.")?;
    write_settings(path, &Settings { close_to_tray: on })?;
    let kept = read_settings(path).close_to_tray;
    tray.close_to_tray.store(kept, Ordering::SeqCst);
    if kept != on {
        return Err(format!("{} didn't keep the setting.", path.display()));
    }
    Ok(tray.status())
}

/// How many Inbox entries need the owner: the menu says the number and the icon gets a dot. No chat text comes here.
#[tauri::command]
pub fn tray_inbox(tray: tauri::State<'_, Tray>, count: u32) {
    if tray.inbox.swap(count, Ordering::SeqCst) == count {
        return;
    }
    if let Some(parts) = tray.parts() {
        let _ = parts.inbox.set_text(inbox_label(count));
        let _ = parts.icon.set_icon(Some(if count > 0 { parts.dotted.clone() } else { parts.plain.clone() }));
    }
}

/// Whether the window is hidden to the tray now, for a webview that starts listening after it was hidden.
#[tauri::command]
pub fn window_hidden(tray: tauri::State<'_, Tray>) -> bool {
    tray.hidden.load(Ordering::SeqCst)
}

/// The webview has an unsaved edit that closing would drop (or no longer has).
#[tauri::command]
pub fn window_unsaved(tray: tauri::State<'_, Tray>, unsaved: bool) {
    tray.unsaved.store(unsaved, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closing_hides_only_when_asked_and_the_icon_is_on_screen() {
        assert!(closing_hides(true, TrayState::Shown));
        assert!(!closing_hides(false, TrayState::Shown));
        assert!(!closing_hides(true, TrayState::NoTray));
        assert!(!closing_hides(true, TrayState::Unavailable));
    }

    #[test]
    fn a_hidden_window_comes_back_when_the_tray_goes_away() {
        assert!(must_reappear(true, TrayState::NoTray));
        assert!(must_reappear(true, TrayState::Unavailable));
        assert!(!must_reappear(true, TrayState::Shown));
        assert!(!must_reappear(false, TrayState::NoTray));
    }

    #[test]
    fn a_slow_or_single_missed_check_doesnt_count_as_the_tray_going_away() {
        let mut misses = 0;
        // No answer changes nothing.
        assert_eq!(next_state(TrayState::Shown, None, &mut misses), TrayState::Shown);
        // One empty check isn't enough; the second in a row is.
        assert_eq!(next_state(TrayState::Shown, Some(false), &mut misses), TrayState::Shown);
        assert_eq!(next_state(TrayState::Shown, Some(false), &mut misses), TrayState::NoTray);
        // A tray appearing counts at once, and resets the count.
        assert_eq!(next_state(TrayState::NoTray, Some(true), &mut misses), TrayState::Shown);
        assert_eq!(misses, 0);
        assert_eq!(next_state(TrayState::Shown, Some(false), &mut misses), TrayState::Shown);
        assert_eq!(next_state(TrayState::Shown, Some(true), &mut misses), TrayState::Shown);
        assert_eq!(next_state(TrayState::Shown, Some(false), &mut misses), TrayState::Shown);
        // An icon that couldn't be made stays unavailable whatever the desktop has.
        assert_eq!(next_state(TrayState::Unavailable, Some(true), &mut misses), TrayState::Unavailable);
        assert_eq!(next_state(TrayState::NoTray, Some(false), &mut misses), TrayState::NoTray);
    }

    #[test]
    fn either_check_finding_a_tray_is_enough_and_silence_decides_nothing() {
        assert_eq!(either(Some(true), None), Some(true));
        assert_eq!(either(None, Some(true)), Some(true));
        assert_eq!(either(Some(false), Some(false)), Some(false));
        assert_eq!(either(Some(false), None), None);
        assert_eq!(either(None, None), None);
    }

    #[test]
    fn the_inbox_line_is_a_count_only() {
        assert_eq!(inbox_label(0), "Open Inbox");
        assert_eq!(inbox_label(3), "Open Inbox (3)");
    }

    #[test]
    fn the_inbox_icon_is_the_tray_icon_with_a_dot_top_right() {
        let plain = Image::from_bytes(TRAY_ICON).unwrap();
        let dotted = Image::from_bytes(TRAY_INBOX_ICON).unwrap();
        assert_eq!((plain.width(), plain.height()), (64, 64));
        assert_eq!((dotted.width(), dotted.height()), (64, 64));
        let at = |img: &Image, x: u32, y: u32| {
            let i = ((y * img.width() + x) * 4) as usize;
            img.rgba()[i..i + 4].to_vec()
        };
        // The dot's centre (52, 12): red in the Inbox icon, the clay tile in the plain one.
        assert_eq!(at(&dotted, 52, 12), [0xe5, 0x48, 0x3a, 0xff]);
        assert_eq!(at(&plain, 52, 12), [0xd0, 0x8b, 0x6e, 0xff]);
        // The clear ring between dot and tile.
        assert_eq!(at(&dotted, 52, 26)[3], 0);
        // Away from the corner the two are the same picture: the H doesn't move when the Inbox fills.
        for (x, y) in [(20, 40), (32, 32), (8, 56), (44, 48)] {
            assert_eq!(at(&plain, x, y), at(&dotted, x, y), "({x}, {y})");
        }
        // The H is dark on the tile.
        assert_eq!(at(&plain, 20, 40), [0x19, 0x11, 0x0d, 0xff]);
    }

    #[test]
    fn the_setting_is_off_unless_the_file_says_on_and_survives_a_round_trip() {
        let dir = std::env::temp_dir().join(format!("hermes-chat-tray-{}", std::process::id()));
        let path = dir.join(SETTINGS_FILE);
        let _ = std::fs::remove_dir_all(&dir);
        assert!(!read_settings(&path).close_to_tray, "missing file");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&path, "not json").unwrap();
        assert!(!read_settings(&path).close_to_tray, "unreadable file");
        std::fs::write(&path, "{}").unwrap();
        assert!(!read_settings(&path).close_to_tray, "no key");
        write_settings(&path, &Settings { close_to_tray: true }).unwrap();
        assert!(read_settings(&path).close_to_tray);
        write_settings(&path, &Settings { close_to_tray: false }).unwrap();
        assert!(!read_settings(&path).close_to_tray);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
