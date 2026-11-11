//! Web pages in the Preview on Linux (ADR 0081): a WebKitGTK view of their own, laid over the Preview pane where the
//! frame was (ADR 0007). The page is the top level of its view, so a site that refuses framing (`X-Frame-Options`,
//! CSP `frame-ancestors`) shows.
//!
//! The view isn't Tauri's. Tauri puts its IPC bootstrap and the per-launch invoke key into every webview it makes, and
//! that key is what keeps the app's own frames from its commands (ADR 0007). This view has no Tauri script, no IPC
//! handler and none of the app's URI schemes, and its web context is new and ephemeral: the page shares no storage
//! with the app, and its cookies last only while the app runs. Its web process runs in WebKit's bubblewrap sandbox
//! (ADR 0138).
//!
//! The webview names the page and where it shows; Rust checks the address as the pane does (`web_page::web_url`).

use crate::server_page::Jar;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

/// A rectangle in the window's CSS pixels, which are GTK's logical pixels: the app's page is never zoomed.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Where the page shows, and the parts of that the app's own layers cover (a menu, a dialog, a toast): the page
/// leaves those bare, so the layer shows and takes the pointer.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Placement {
    pub rect: Rect,
    #[serde(default)]
    pub holes: Vec<Rect>,
}

/// What the page says, sent to the webview as `{ kind, … }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PageEvent {
    /// The view shows `url` now: a load committed, or the page changed its own address after one (pushState,
    /// replaceState, a fragment, its own history.back()). `replace`: it takes the current entry's place, because it is
    /// where a `go` or `reload` the app asked for landed, or because WebKit's back and forward lists kept their lengths
    /// (replaceState, location.replace). Otherwise the page moved by itself. Only addresses `web_page::web_url` passes
    /// are sent.
    At { url: String, replace: bool },
    /// It couldn't load, or its web process ended. The view hides; the pane says why. `url`: the address that failed
    /// to load, when WebKit names one `web_page::web_url` passes. A link followed inside the page can fail while the
    /// view keeps the page it was on.
    Failed {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        url: Option<String>,
    },
    /// The owner pressed Escape in the page, and the page didn't use it. The keyboard is back with the app, so the
    /// next Escape reaches the Preview as it would anywhere else in the app.
    Escaped,
}

/// A rectangle in whole pixels, `(x, y, width, height)`. Edges are rounded rather than sizes, so a rectangle and the
/// one beside it still meet.
pub fn pixels(r: &Rect) -> (i32, i32, i32, i32) {
    let (x0, y0) = (r.x.round(), r.y.round());
    let (x1, y1) = ((r.x + r.width).round(), (r.y + r.height).round());
    (x0 as i32, y0 as i32, (x1 - x0).max(0.0) as i32, (y1 - y0).max(0.0) as i32)
}

/// The holes of `placement`, in whole pixels from the page's own top-left corner, cut to the page. Holes that miss it
/// are left out.
pub fn holes_in_page(placement: &Placement) -> Vec<(i32, i32, i32, i32)> {
    let (px, py, pw, ph) = pixels(&placement.rect);
    placement
        .holes
        .iter()
        .filter_map(|hole| {
            let (hx, hy, hw, hh) = pixels(hole);
            let (x0, y0) = (hx.max(px), hy.max(py));
            let (x1, y1) = ((hx + hw).min(px + pw), (hy + hh).min(py + ph));
            (x1 > x0 && y1 > y0).then(|| (x0 - px, y0 - py, x1 - x0, y1 - y0))
        })
        .collect()
}

pub fn open(app: &tauri::AppHandle, key: String, on_event: Channel<PageEvent>) -> Result<(), String> {
    imp::open(app, key, on_event)
}

pub fn go(key: String, url: &str, pages: &crate::server_page::ServerPages) -> Result<(), String> {
    let url = crate::web_page::web_url(url)?;
    let jar = pages.jar(&url);
    imp::go(&key, url, jar);
    Ok(())
}

pub fn reload(app: &tauri::AppHandle, key: String) {
    imp::reload(app, key)
}

/// Shows the page at `placement`, or hides it (`None`), if `key` is the page shown.
pub fn place(app: &tauri::AppHandle, key: String, placement: Option<Placement>) {
    imp::place(app, key, placement)
}

pub fn close(app: &tauri::AppHandle, key: String) {
    imp::close(app, key)
}

#[cfg(not(target_os = "linux"))]
mod imp {
    use super::*;

    pub fn open(_: &tauri::AppHandle, _: String, _: Channel<PageEvent>) -> Result<(), String> {
        Err("Pages open in their own view only on Linux.".into())
    }
    pub fn go(_: &str, _: url::Url, _: Option<Jar>) {}
    pub fn reload(_: &tauri::AppHandle, _: String) {}
    pub fn place(_: &tauri::AppHandle, _: String, _: Option<Placement>) {}
    pub fn close(_: &tauri::AppHandle, _: String) {}
}

#[cfg(target_os = "linux")]
mod imp {
    use super::*;
    use gtk::prelude::*;
    use std::cell::{Cell, RefCell};
    use std::collections::HashMap;
    use std::rc::Rc;
    use tauri::Manager;
    use webkit2gtk::{
        BackForwardListExt, BackForwardListItemExt, FileChooserRequestExt, LoadEvent, NetworkError, PermissionRequestExt, PolicyError, ScriptDialogType,
        SettingsExt, URIRequestExt, WebContextExt, WebViewExt,
    };

    thread_local! {
        /// The overlay that holds Tauri's webview and the page's view. Made on first use. The commands that touch it
        /// have no `async`, so Tauri runs them on the main thread, GTK's.
        static OVERLAY: RefCell<Option<gtk::Overlay>> = const { RefCell::new(None) };
        static CONTEXTS: RefCell<HashMap<Option<Jar>, webkit2gtk::WebContext>> = RefCell::default();
        static PAGE: RefCell<Option<Page>> = const { RefCell::new(None) };
        /// Where the overlay puts the view, in whole pixels.
        static AT: Cell<(i32, i32, i32, i32)> = const { Cell::new((0, 0, 1, 1)) };
    }

    struct Page {
        key: String,
        view: webkit2gtk::WebView,
        moves: Rc<Moves>,
        jar: Option<Jar>,
        placement: Option<Placement>,
    }

    pub(super) struct Moves {
        events: RefCell<Option<Channel<PageEvent>>>,
        asked: RefCell<Option<url::Url>>,
        /// Between a load's start (or the app asking for one) and its commit, the view's `uri` is the request's, and
        /// changes again on each redirect, so nothing is reported.
        loading: Cell<bool>,
        /// The address and WebKit's back and forward list lengths at the last report. Lengths both unchanged means the
        /// page replaced its entry; the address unchanged too means nothing moved (WebKit puts a stopped load's address
        /// back, and says so).
        last: RefCell<(Option<String>, (usize, usize))>,
        answered: Cell<bool>,
    }

    impl Moves {
        pub(super) fn new(events: Channel<PageEvent>) -> Rc<Self> {
            Rc::new(Self {
                events: RefCell::new(Some(events)),
                asked: RefCell::default(),
                loading: Cell::new(false),
                last: RefCell::default(),
                answered: Cell::new(false),
            })
        }

        fn send(&self, event: PageEvent) {
            if let Some(events) = self.events.borrow().clone() {
                let _ = events.send(event);
            }
        }

        fn report(&self, view: &webkit2gtk::WebView, asked: bool) {
            let lengths = view.back_forward_list().map(|l| (l.back_list().len(), l.forward_list().len())).unwrap_or_default();
            let url = view.uri().map(String::from);
            let (was, was_lengths) = self.last.replace((url.clone(), lengths));
            let kept = was_lengths == lengths;
            if !asked && kept && was == url {
                return;
            }
            if let Some(url) = url.filter(|u| crate::web_page::web_url(u).is_ok()) {
                self.send(PageEvent::At { url, replace: asked || kept });
            }
        }

        fn ask(&self, url: url::Url) {
            self.asked.replace(Some(url));
            self.loading.set(true);
            self.answered.set(false);
        }

        fn settle(&self) {
            self.asked.take();
            self.loading.set(false);
        }
    }

    fn same_address(a: Option<impl AsRef<str>>, b: &url::Url) -> bool {
        a.and_then(|a| url::Url::parse(a.as_ref()).ok()).is_some_and(|a| a == *b)
    }

    pub(super) fn watch(view: &webkit2gtk::WebView, moves: &Rc<Moves>) {
        let m = moves.clone();
        view.connect_load_changed(move |view, event| match event {
            LoadEvent::Started => m.loading.set(true),
            LoadEvent::Committed => {
                m.loading.set(false);
                m.answered.set(true);
                let asked = m.asked.take().is_some();
                m.report(view, asked);
            }
            _ => {}
        });
        let m = moves.clone();
        view.connect_uri_notify(move |view| {
            if !m.loading.get() {
                m.report(view, false);
            }
        });
        // A move within the page the app asked for (a fragment, or back to a pushState entry) never starts or commits a
        // load: it ends when the view stops loading at that address. A load that failed has its address put back by
        // then, and `load-failed` follows.
        let m = moves.clone();
        view.connect_is_loading_notify(move |view| {
            if view.is_loading() {
                return;
            }
            let asked = m.asked.borrow().clone();
            match asked {
                None => m.loading.set(false),
                Some(url) if same_address(view.uri(), &url) => {
                    m.settle();
                    m.report(view, true);
                }
                Some(_) => {}
            }
        });
        let m = moves.clone();
        view.connect_load_failed(move |view, _, failing, error| {
            // Cancelled: another load replaced it, and that one's report follows; or the page stopped, and none does.
            if error.matches(NetworkError::Cancelled) {
                if !view.is_loading() {
                    m.settle();
                }
                return true;
            }
            m.settle();
            // Interrupted: the response was a download, which stops. A page already shown stays, as in a browser.
            if error.matches(PolicyError::FrameLoadInterruptedByPolicyChange) {
                if !m.answered.get() {
                    m.send(PageEvent::Failed { message: "It's a file to download, and the Preview doesn't save files.".into(), url: None });
                }
                return true;
            }
            let url = Some(failing.to_owned()).filter(|u| crate::web_page::web_url(u).is_ok());
            m.send(PageEvent::Failed { message: error.message().to_owned(), url });
            true
        });
        let m = moves.clone();
        view.connect_web_process_terminated(move |_, _| {
            m.send(PageEvent::Failed { message: "The page stopped: WebKit's process for it ended.".into(), url: None });
        });
    }

    pub(super) fn go_in(view: &webkit2gtk::WebView, moves: &Moves, url: url::Url) {
        moves.ask(url.clone());
        let list = view.back_forward_list();
        let neighbour = |item: Option<webkit2gtk::BackForwardListItem>| same_address(item.and_then(|i| i.uri()), &url);
        if neighbour(list.as_ref().and_then(|l| l.back_item())) {
            view.go_back();
        } else if neighbour(list.as_ref().and_then(|l| l.forward_item())) {
            view.go_forward();
        } else {
            view.load_uri(url.as_str());
        }
    }

    pub(super) fn reload_in(view: &webkit2gtk::WebView, moves: &Moves) {
        let Some(url) = view.uri().and_then(|u| url::Url::parse(&u).ok()) else { return };
        moves.ask(url);
        view.reload();
    }

    pub(super) fn shown(key: &str) -> Option<(webkit2gtk::WebView, Rc<Moves>)> {
        PAGE.with(|p| p.borrow().as_ref().filter(|p| p.key == key).map(|p| (p.view.clone(), p.moves.clone())))
    }

    /// Hides the page. A hidden view gets no keys, so if it had the keyboard, the app takes it back.
    fn hide(overlay: &gtk::Overlay, view: &webkit2gtk::WebView) {
        if view.is_focus() {
            if let Some(app) = overlay.child() {
                app.grab_focus();
            }
        }
        view.hide();
    }

    fn end(overlay: &gtk::Overlay, page: Page) {
        drop(page.moves.events.take());
        hide(overlay, &page.view);
        overlay.remove(&page.view);
    }

    fn new_page(overlay: &gtk::Overlay, key: String, jar: Option<Jar>, on_event: Channel<PageEvent>) -> Page {
        let context = CONTEXTS.with(|c| c.borrow_mut().entry(jar.clone()).or_insert_with(page_context).clone());
        let view = page_webview(&context);
        view.set_no_show_all(true);
        let moves = Moves::new(on_event);
        watch(&view, &moves);
        overlay.add_overlay(&view);
        Page { key, view, moves, jar, placement: None }
    }

    pub fn open(app: &tauri::AppHandle, key: String, on_event: Channel<PageEvent>) -> Result<(), String> {
        let overlay = overlay(app).ok_or("Hermes Chat's window has no place for the page.")?;
        open_in(&overlay, key, on_event);
        Ok(())
    }

    pub(super) fn open_in(overlay: &gtk::Overlay, key: String, on_event: Channel<PageEvent>) {
        if let Some(before) = PAGE.with(|p| p.take()) {
            end(overlay, before);
        }
        let page = new_page(overlay, key, None, on_event);
        PAGE.with(|p| *p.borrow_mut() = Some(page));
    }

    /// A view's context is fixed, so a page in another jar gets a new view.
    fn into_jar(key: &str, jar: &Option<Jar>) {
        let Some(old) = PAGE.with(|p| p.borrow_mut().take_if(|p| p.key == key && p.jar != *jar)) else { return };
        let (overlay, events) = (old.view.parent().and_downcast::<gtk::Overlay>(), old.moves.events.borrow().clone());
        let (Some(overlay), Some(events)) = (overlay, events) else {
            PAGE.with(|p| *p.borrow_mut() = Some(old));
            return;
        };
        let mut page = new_page(&overlay, old.key.clone(), jar.clone(), events);
        page.placement = old.placement.clone();
        end(&overlay, old);
        show_at(&overlay, &page.view, page.placement.as_ref());
        PAGE.with(|p| *p.borrow_mut() = Some(page));
    }

    pub fn go(key: &str, url: url::Url, jar: Option<Jar>) {
        into_jar(key, &jar);
        let in_jar = PAGE.with(|p| p.borrow().as_ref().filter(|p| p.key == key && p.jar == jar).map(|p| (p.view.clone(), p.moves.clone())));
        if let Some((view, moves)) = in_jar {
            go_in(&view, &moves, url);
        }
    }

    pub fn reload(_: &tauri::AppHandle, key: String) {
        if let Some((view, moves)) = shown(&key) {
            reload_in(&view, &moves);
        }
    }

    pub fn place(_: &tauri::AppHandle, key: String, placement: Option<Placement>) {
        let Some(overlay) = OVERLAY.with(|o| o.borrow().clone()) else { return };
        let shown = PAGE.with(|p| {
            p.borrow_mut().as_mut().filter(|p| p.key == key).map(|p| {
                p.placement.clone_from(&placement);
                p.view.clone()
            })
        });
        if let Some(view) = shown {
            show_at(&overlay, &view, placement.as_ref());
        }
    }

    fn show_at(overlay: &gtk::Overlay, view: &webkit2gtk::WebView, placement: Option<&Placement>) {
        let Some(placement) = placement else {
            hide(overlay, view);
            return;
        };
        AT.with(|at| at.set(pixels(&placement.rect)));
        overlay.queue_resize();
        let holes = holes_in_page(placement);
        // The overlay's window for the view, which it moves and sizes. On X11 it can be a native window, whose shape
        // the X server clips the page to and passes the pointer through. Elsewhere (Wayland's GTK has no native child
        // windows) the page hides while it has a hole.
        let x11 = view.parent_window().filter(|w| w.display().is::<gdkx11::X11Display>() && w.ensure_native());
        match x11 {
            Some(window) => {
                let (_, _, width, height) = pixels(&placement.rect);
                let shape = gtk::cairo::Region::create_rectangle(&gtk::cairo::RectangleInt::new(0, 0, width, height));
                for (x, y, w, h) in holes {
                    let _ = shape.subtract_rectangle(&gtk::cairo::RectangleInt::new(x, y, w, h));
                }
                window.shape_combine_region(Some(&shape), 0, 0);
                window.input_shape_combine_region(&shape, 0, 0);
                view.show();
            }
            None if holes.is_empty() => view.show(),
            None => hide(overlay, view),
        }
    }

    pub fn close(_: &tauri::AppHandle, key: String) {
        let Some(overlay) = OVERLAY.with(|o| o.borrow().clone()) else { return };
        if let Some(page) = PAGE.with(|p| p.borrow_mut().take_if(|p| p.key == key)) {
            end(&overlay, page);
        }
    }

    /// The overlay, made the first time from Tauri's webview. `with_webview` runs at once on the main thread, holding a
    /// lock that any Tauri call on that webview takes again (a channel's send or drop does), so nothing in it touches a
    /// channel.
    fn overlay(app: &tauri::AppHandle) -> Option<gtk::Overlay> {
        if OVERLAY.with(|o| o.borrow().is_none()) {
            let window = app.get_webview_window("main")?;
            window.with_webview(|w| make_overlay(&w.inner())).ok()?;
        }
        OVERLAY.with(|o| o.borrow().clone())
    }

    fn make_overlay(main: &webkit2gtk::WebView) {
        let Some(parent) = main.parent().and_then(|p| p.downcast::<gtk::Box>().ok()) else { return };
        let overlay = gtk::Overlay::new();
        overlay.connect_get_child_position(|_, _| {
            let (x, y, w, h) = AT.with(Cell::get);
            Some(gtk::gdk::Rectangle::new(x, y, w, h))
        });
        // A key the page doesn't use comes back from WebKit up through the overlay. An Escape the page didn't use
        // gives the keyboard back to the app.
        let app_view = main.clone();
        overlay.connect_key_press_event(move |_, key| {
            let chord = gtk::gdk::ModifierType::CONTROL_MASK | gtk::gdk::ModifierType::SHIFT_MASK | gtk::gdk::ModifierType::MOD1_MASK;
            let from_page = PAGE.with(|p| p.borrow().as_ref().filter(|p| p.view.has_focus()).map(|p| p.moves.clone()));
            let Some(moves) = from_page.filter(|_| key.keyval() == gtk::gdk::keys::constants::Escape && !key.state().intersects(chord)) else {
                return gtk::glib::Propagation::Proceed;
            };
            app_view.grab_focus();
            moves.send(PageEvent::Escaped);
            gtk::glib::Propagation::Stop
        });
        // Taking the webview out of its box drops the window's keyboard focus, which Escape and every shortcut need.
        let focused = main.has_focus();
        parent.remove(main);
        overlay.add(main);
        parent.pack_start(&overlay, true, true, 0);
        overlay.show_all();
        if focused {
            main.grab_focus();
        }
        OVERLAY.with(|o| *o.borrow_mut() = Some(overlay));
    }

    pub(super) fn page_context() -> webkit2gtk::WebContext {
        let context = webkit2gtk::WebContext::new_ephemeral();
        // Off by default in the 4.1 API. A page from any site then runs without the owner's files (ADR 0138).
        context.set_sandbox_enabled(true);
        context.connect_download_started(|_, download| {
            use webkit2gtk::DownloadExt;
            download.cancel();
        });
        context
    }

    pub(super) fn page_webview(context: &webkit2gtk::WebContext) -> webkit2gtk::WebView {
        let view = webkit2gtk::WebView::with_context(context);
        // No fullscreen API, no window opened without a click, no script reads of the clipboard, no Web Inspector.
        if let Some(settings) = WebViewExt::settings(&view) {
            settings.set_enable_fullscreen(false);
            settings.set_javascript_can_open_windows_automatically(false);
            settings.set_javascript_can_access_clipboard(false);
            settings.set_enable_developer_extras(false);
        }
        // No `allow-modals`: alert returns at once, confirm says no, prompt gives null, leaving a page asks nothing, and
        // print() does nothing. WebKit's own dialogs held the page's process, and every page after it, until the owner
        // answered; its print dialog held the whole window.
        view.connect_script_dialog(|_, dialog| {
            if dialog.dialog_type() == ScriptDialogType::BeforeUnloadConfirm {
                dialog.confirm_set_confirmed(true);
            }
            true
        });
        view.connect_print(|_, _| true);
        // Nothing else that asks for fullscreen gets the app's window either.
        view.connect_enter_fullscreen(|_| true);
        // No file picker: a file input opened none in the frame.
        view.connect_run_file_chooser(|_, request| {
            request.cancel();
            true
        });
        // Camera, microphone, display capture, location, notifications, pointer lock, clipboard reads, storage access.
        view.connect_permission_request(|_, request| {
            request.deny();
            true
        });
        // No `allow-popups`: a link the owner opens in a new window (target=_blank, or the page's menu) opens here.
        view.connect_create(|view, action| {
            if let Some(uri) = action.clone().request().and_then(|r| r.uri()) {
                if crate::web_page::web_url(&uri).is_ok() {
                    view.load_uri(&uri);
                }
            }
            None
        });
        view
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::time::{Duration, Instant};

        /// The name and parent of process `pid`.
        fn stat(pid: u32) -> Option<(String, u32)> {
            let s = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
            let (head, rest) = s.rsplit_once(") ")?;
            Some((head.split_once(" (")?.1.to_owned(), rest.split_whitespace().nth(1)?.parse().ok()?))
        }

        /// For each WebKit web process this process started, the names of the processes between the two.
        fn web_processes() -> Vec<Vec<String>> {
            let me = std::process::id();
            let between = |pid: u32| {
                let mut names = Vec::new();
                let mut at = stat(pid)?.1;
                while at != me {
                    let (name, up) = stat(at).filter(|_| at > 1)?;
                    names.push(name);
                    at = up;
                }
                Some(names)
            };
            std::fs::read_dir("/proc")
                .into_iter()
                .flatten()
                .flatten()
                .filter_map(|e| e.file_name().to_str()?.parse::<u32>().ok())
                // Not by name: in the sandbox the process calls itself `Web`.
                .filter(|&pid| {
                    std::fs::read(format!("/proc/{pid}/cmdline"))
                        .is_ok_and(|c| c.split(|&b| b == 0).next().is_some_and(|argv0| argv0.ends_with(b"/WebKitWebProcess")))
                })
                .filter_map(between)
                .collect()
        }

        #[test]
        #[ignore = "needs a display and a session bus: xvfb-run -a dbus-run-session -- cargo test --lib page_view -- --ignored"]
        fn a_page_runs_inside_webkits_bubblewrap_sandbox() {
            gtk::init().expect("a display");
            let view = page_webview(&page_context());
            let window = gtk::OffscreenWindow::new();
            window.add(&view);
            window.show_all();
            let loaded = Rc::new(Cell::new(false));
            let l = loaded.clone();
            view.connect_load_changed(move |_, event| l.set(l.get() || event == LoadEvent::Finished));
            view.load_html("<p>A page</p>", None);
            let end = Instant::now() + Duration::from_secs(120);
            while !loaded.get() {
                assert!(Instant::now() < end, "the page never loaded");
                gtk::main_iteration_do(false);
                std::thread::sleep(Duration::from_millis(5));
            }
            let found = web_processes();
            assert!(!found.is_empty(), "the page has a web process of its own");
            assert!(found.iter().all(|between| between.iter().any(|name| name == "bwrap")), "a web process runs outside bubblewrap: {found:?}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lock::Locked;

    fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
        Rect { x, y, width, height }
    }

    #[test]
    fn rounds_edges_so_neighbours_still_meet() {
        assert_eq!(pixels(&rect(800.6, 91.5, 479.4, 728.2)), (801, 92, 479, 728));
        let (left, right) = (rect(0.0, 0.0, 10.4, 5.0), rect(10.4, 0.0, 10.4, 5.0));
        let (lx, _, lw, _) = pixels(&left);
        let (rx, _, _, _) = pixels(&right);
        assert_eq!(lx + lw, rx);
    }

    #[test]
    fn holes_are_cut_to_the_page_and_measured_from_its_corner() {
        let placement = Placement {
            rect: rect(800.0, 100.0, 400.0, 600.0),
            holes: vec![
                // A toast across the page's left edge.
                rect(600.0, 600.0, 300.0, 40.0),
                // A dialog's backdrop over the whole window.
                rect(0.0, 0.0, 1280.0, 820.0),
                // A menu beside the page, not over it.
                rect(500.0, 100.0, 200.0, 300.0),
            ],
        };
        assert_eq!(holes_in_page(&placement), vec![(0, 500, 100, 40), (0, 0, 400, 600)]);
    }

    #[test]
    fn placement_reads_the_webviews_json() {
        let p: Placement = serde_json::from_str(r#"{"rect":{"x":1,"y":2,"width":3,"height":4}}"#).unwrap();
        assert_eq!(p, Placement { rect: rect(1.0, 2.0, 3.0, 4.0), holes: vec![] });
        assert_eq!(
            serde_json::to_value(PageEvent::Failed { message: "m".into(), url: None }).unwrap(),
            serde_json::json!({ "kind": "failed", "message": "m" })
        );
        assert_eq!(
            serde_json::to_value(PageEvent::Failed { message: "m".into(), url: Some("http://127.0.0.1:41234/b".into()) }).unwrap(),
            serde_json::json!({ "kind": "failed", "message": "m", "url": "http://127.0.0.1:41234/b" })
        );
        assert_eq!(serde_json::to_value(PageEvent::Escaped).unwrap(), serde_json::json!({ "kind": "escaped" }));
        assert_eq!(
            serde_json::to_value(PageEvent::At { url: "http://127.0.0.1:41234/a".into(), replace: true }).unwrap(),
            serde_json::json!({ "kind": "at", "url": "http://127.0.0.1:41234/a", "replace": true })
        );
    }

    /// What a page that tries everything on load, with no click, gets in the view: what the frame gave it.
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "WebKitGTK needs a display, and GTK one thread: DISPLAY=:N cargo test --lib page_view::tests::a_page_in_the_view -- --ignored"]
    fn a_page_in_the_view_gets_no_more_than_the_frame() {
        use gtk::prelude::*;
        use std::time::{Duration, Instant};
        use webkit2gtk::{SettingsExt, WebViewExt};
        const PROBE: &str = r#"<script>
            (async () => {
              const r = {};
              const t = Date.now();
              r.alert = String(alert("a"));
              r.confirm = confirm("c");
              r.prompt = prompt("p", "x");
              window.print();
              r.answeredAtOnce = Date.now() - t < 2000;
              r.fullscreen = document.fullscreenEnabled === true || typeof document.documentElement.requestFullscreen === "function";
              r.popup = window.open("https://policy.test/other") !== null;
              r.notification = await Notification.requestPermission();
              r.location = await new Promise((done) => navigator.geolocation.getCurrentPosition(() => done("granted"), (e) => done(e.code)));
              r.camera = await navigator.mediaDevices.getUserMedia({ video: true }).then(() => "granted", (e) => e.name);
              document.title = JSON.stringify(r);
            })();
        </script>"#;
        gtk::init().expect("a display");
        // WebKit's print dialog runs a loop of its own, which the deadline below can't break.
        let (_running, finished) = std::sync::mpsc::channel::<()>();
        std::thread::spawn(move || {
            if finished.recv_timeout(Duration::from_secs(90)) == Err(std::sync::mpsc::RecvTimeoutError::Timeout) {
                eprintln!("the probe page never finished: a dialog is open");
                std::process::abort();
            }
        });
        let view = imp::page_webview(&imp::page_context());
        // WebKit's stand-in camera, as the box may have none.
        WebViewExt::settings(&view).unwrap().set_enable_mock_capture_devices(true);
        // A window on screen: WebKit holds a camera request until its page is visible.
        let window = gtk::Window::new(gtk::WindowType::Toplevel);
        window.add(&view);
        window.show_all();
        view.load_html(PROBE, Some("https://policy.test/"));
        let deadline = Instant::now() + Duration::from_secs(60);
        let title = loop {
            if let Some(title) = view.title().filter(|t| t.starts_with('{')) {
                break title;
            }
            assert!(Instant::now() < deadline, "the probe page never finished");
            gtk::main_iteration_do(false);
            std::thread::sleep(Duration::from_millis(5));
        };
        let got: serde_json::Value = serde_json::from_str(&title).unwrap();
        assert_eq!(
            got,
            serde_json::json!({
                "alert": "undefined",
                "confirm": false,
                "prompt": null,
                "answeredAtOnce": true,
                "fullscreen": false,
                "popup": false,
                "notification": "denied",
                "location": 1,
                "camera": "NotAllowedError",
            })
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "WebKitGTK needs a display, and GTK one thread: DISPLAY=:N cargo test --lib page_view::tests::each_server_page -- --ignored"]
    fn each_server_page_keeps_its_cookies_to_itself() {
        use crate::server_page::Jar;
        use gtk::prelude::*;
        use std::io::{Read, Write};
        use std::sync::{Arc, Mutex};
        use std::time::{Duration, Instant};
        use webkit2gtk::WebViewExt;
        let sent_cookies = Arc::new(Mutex::new(Vec::<String>::new()));
        let mut ports = Vec::new();
        for _ in 0..2 {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            ports.push(listener.local_addr().unwrap().port());
            let log = sent_cookies.clone();
            std::thread::spawn(move || {
                for mut stream in listener.incoming().flatten() {
                    let mut request = [0u8; 4096];
                    let n = stream.read(&mut request).unwrap_or(0);
                    let request = String::from_utf8_lossy(&request[..n]).into_owned();
                    let path = request.split_whitespace().nth(1).unwrap_or("/").to_owned();
                    let cookie = request.lines().find_map(|l| l.strip_prefix("Cookie: ")).unwrap_or("");
                    log.locked().push(format!("{path} {cookie}"));
                    let set = if path == "/sign-in" { "Set-Cookie: session=a; Path=/; HttpOnly\r\nSet-Cookie: seen=a; Path=/\r\n" } else { "" };
                    let body = "<script>document.title = 'cookie:' + document.cookie</script>";
                    let response =
                        format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n{set}Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                    let _ = stream.write_all(response.as_bytes());
                }
            });
        }
        let (a, b) = (format!("http://127.0.0.1:{}", ports[0]), format!("http://127.0.0.1:{}", ports[1]));

        gtk::init().expect("a display");
        let sent = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
        let into = sent.clone();
        let channel = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(text) = body {
                into.locked().push(serde_json::from_str(&text).unwrap());
            }
            Ok(())
        });
        let overlay = gtk::Overlay::new();
        let window = gtk::Window::new(gtk::WindowType::Toplevel);
        window.add(&overlay);
        window.show_all();
        imp::open_in(&overlay, "page".into(), channel);

        let (jar_a, jar_b) = (Some(Jar::of("hermes", "http://localhost:3000")), Some(Jar::of("hermes", "http://localhost:8080")));
        let load = |url: String, jar: &Option<Jar>| {
            sent_cookies.locked().clear();
            imp::go("page", url::Url::parse(&url).unwrap(), jar.clone());
            let (view, _) = imp::shown("page").unwrap();
            let deadline = Instant::now() + Duration::from_secs(20);
            loop {
                if let Some(title) = view.title().filter(|t| t.starts_with("cookie:") && !view.is_loading()) {
                    assert_eq!(overlay.children().len(), 1, "the view in the jar before it is gone");
                    let asked = sent_cookies.locked().iter().rev().find(|r| !r.starts_with("/favicon")).cloned().unwrap();
                    break (title.trim_start_matches("cookie:").to_owned(), asked);
                }
                assert!(Instant::now() < deadline, "{url} never loaded");
                gtk::main_iteration_do(false);
                std::thread::sleep(Duration::from_millis(5));
            }
        };

        assert_eq!(load(format!("{a}/sign-in"), &jar_a), ("seen=a".into(), "/sign-in ".into()), "page A signs in");
        assert_eq!(load(format!("{b}/"), &jar_b), ("".into(), "/ ".into()), "page B, on another port, gets none of A's cookies");
        assert_eq!(load(format!("{b}/"), &None), ("".into(), "/ ".into()), "nor does a page that isn't a server page");
        assert_eq!(load(format!("{b}/"), &jar_a), ("seen=a".into(), "/ session=a; seen=a".into()), "page A, opened again on another port, is still signed in");
        let last = sent.locked().last().cloned();
        assert_eq!(last, Some(serde_json::json!({ "kind": "at", "url": format!("{b}/"), "replace": true })), "the page's events follow it to each view");
    }

    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "WebKitGTK needs a display, and GTK one thread: DISPLAY=:N cargo test --lib page_view::tests::a_view_reports -- --ignored"]
    fn a_view_reports_each_move_once() {
        use gtk::prelude::*;
        use serde_json::{json, Value};
        use std::io::{Read, Write};
        use std::sync::{Arc, Mutex};
        use std::time::{Duration, Instant};
        use webkit2gtk::WebViewExt;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                let mut request = [0u8; 4096];
                let n = stream.read(&mut request).unwrap_or(0);
                let path = String::from_utf8_lossy(&request[..n]).split_whitespace().nth(1).unwrap_or("/").to_owned();
                if path == "/slow" {
                    std::thread::sleep(Duration::from_millis(1500));
                }
                let response = match path.strip_prefix("/redirect-to-") {
                    Some(to) => format!("HTTP/1.1 302 Found\r\nLocation: /{to}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
                    None => {
                        let body = "<a id=a href=/a>a</a><a id=b href=/redirect-to-b>b</a><a id=slow href=/slow>slow</a>\
                             <script>addEventListener('pageshow', e => document.title = location.pathname + (e.persisted ? ' from the page cache' : ''))</script>";
                        format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
                    }
                };
                let _ = stream.write_all(response.as_bytes());
            }
        });
        let closed = crate::test_common::refusing();

        gtk::init().expect("a display");
        let sent = Arc::new(Mutex::new(Vec::<Value>::new()));
        let into = sent.clone();
        let channel = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(text) = body {
                into.locked().push(serde_json::from_str(&text).unwrap());
            }
            Ok(())
        });
        let view = imp::page_webview(&imp::page_context());
        let moves = imp::Moves::new(channel);
        imp::watch(&view, &moves);
        let window = gtk::Window::new(gtk::WindowType::Toplevel);
        window.add(&view);
        window.show_all();

        let run = |ms: u64| {
            let until = Instant::now() + Duration::from_millis(ms);
            while Instant::now() < until {
                gtk::main_iteration_do(false);
                std::thread::sleep(Duration::from_millis(2));
            }
        };
        let step = |what: &str, act: &dyn Fn(), want: Vec<Value>| {
            act();
            run(200);
            let deadline = Instant::now() + Duration::from_secs(10);
            while view.is_loading() && Instant::now() < deadline {
                run(20);
            }
            run(300);
            let got: Vec<Value> = std::mem::take(&mut *sent.locked());
            assert_eq!(got, want, "{what}");
        };
        let script = |js: &'static str| {
            let view = view.clone();
            move || view.evaluate_javascript(js, None, None, None::<&gio::Cancellable>, |_| {})
        };
        let go = |path: &str| {
            let url = url::Url::parse(&format!("{base}{path}")).unwrap();
            let (view, moves) = (view.clone(), moves.clone());
            move || imp::go_in(&view, &moves, url.clone())
        };
        let at = |path: &str, replace: bool| json!({ "kind": "at", "url": format!("{base}{path}"), "replace": replace });

        step("a load the app asks for", &go("/"), vec![at("/", true)]);
        step("pushState", &script("history.pushState({}, '', '/pushed')"), vec![at("/pushed", false)]);
        step("replaceState", &script("history.replaceState({}, '', '/replaced')"), vec![at("/replaced", true)]);
        step("the page's own history.back()", &script("history.back()"), vec![at("/", false)]);
        step("a link the page follows", &script("document.getElementById('a').click()"), vec![at("/a", false)]);
        step("going to the entry behind", &go("/"), vec![at("/", true)]);
        assert_eq!(view.title().as_deref(), Some("/ from the page cache"), "the app's go to the entry behind went back, as a browser does");
        step("going to the entry ahead", &go("/a"), vec![at("/a", true)]);
        step("a fragment the app asks for", &go("/a#notes"), vec![at("/a#notes", true)]);
        step("back to the entry the fragment came from", &go("/a"), vec![at("/a", true)]);
        step("a link the page follows that redirects", &script("document.getElementById('b').click()"), vec![at("/b", false)]);
        step("a redirect the app asks for", &go("/redirect-to-c"), vec![at("/c", true)]);
        step("Reload", &|| imp::reload_in(&view, &moves), vec![at("/c", true)]);
        let unreachable = url::Url::parse(&format!("http://{}/", closed.addr)).unwrap();
        imp::go_in(&view, &moves, unreachable);
        run(1500);
        let got: Vec<Value> = std::mem::take(&mut *sent.locked());
        assert!(matches!(got.as_slice(), [e] if e["kind"] == "failed"), "a load that fails says so, and nothing else: {got:?}");
        step("the page moves after a failed load", &script("history.pushState({}, '', '/after-failing')"), vec![at("/after-failing", false)]);
        step("a load the page stops", &script("document.getElementById('slow').click(); setTimeout(() => window.stop(), 300)"), vec![]);
        run(1500);
        step("the page moves after a stopped load", &script("history.pushState({}, '', '/after-stopping')"), vec![at("/after-stopping", false)]);
    }
}
