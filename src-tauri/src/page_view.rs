//! Web pages in the Preview on Linux (ADR 0081): a WebKitGTK view of their own, laid over the Preview pane where the
//! frame was (ADR 0007). The page is the top level of its view, so a site that refuses framing (`X-Frame-Options`,
//! CSP `frame-ancestors`) shows.
//!
//! The view isn't Tauri's. Tauri puts its IPC bootstrap and the per-launch invoke key into every webview it makes, and
//! that key is what keeps the app's own frames from its commands (ADR 0007). This view has no Tauri script, no IPC
//! handler and none of the app's URI schemes, and its web context is new and ephemeral: the page shares no storage
//! with the app, and its cookies last only while the app runs.
//!
//! The Preview's Back and Forward are the app's own list (ADR 0103); a view only says where its page went, and is
//! asked to go somewhere. One view lasts while the Preview shows web pages one after another, so a page's own
//! back-forward list holds only those, and ends with them.
//!
//! The webview names the page and where it shows; Rust checks the address as the pane does (`web_page::web_url`).

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
    /// It couldn't load, or its web process ended. The view hides; the pane says why.
    Failed { message: String },
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

/// Makes a new, hidden, empty view for `key`, ending the one before it: its page, its web process and its back and
/// forward lists go with it. `key` names this view from now on: a `go`, `place` or `close` for any other key is
/// ignored, so a view that went away can't move or close the next one. Nothing loads until `go`.
pub fn open(app: &tauri::AppHandle, key: String, on_event: Channel<PageEvent>) -> Result<(), String> {
    imp::open(app, key, on_event)
}

/// Shows `url` in `key`'s view: by going back or forward in WebKit's own list when that is where `url` is, so the page
/// comes back as a browser brings it back, and by loading it otherwise. Rust checks the address as the pane does
/// (`web_page::web_url`).
pub fn go(app: &tauri::AppHandle, key: String, url: &str) -> Result<(), String> {
    let url = crate::web_page::web_url(url)?;
    imp::go(app, key, url);
    Ok(())
}

/// Loads `key`'s page again.
pub fn reload(app: &tauri::AppHandle, key: String) {
    imp::reload(app, key)
}

/// Shows the page at `placement`, or hides it (`None`), if `key` is the page shown.
pub fn place(app: &tauri::AppHandle, key: String, placement: Option<Placement>) {
    imp::place(app, key, placement)
}

/// Ends `key`'s view, if it is the one shown (ADR 0039: a page runs only while it is on screen).
pub fn close(app: &tauri::AppHandle, key: String) {
    imp::close(app, key)
}

#[cfg(not(target_os = "linux"))]
mod imp {
    use super::*;

    pub fn open(_: &tauri::AppHandle, _: String, _: Channel<PageEvent>) -> Result<(), String> {
        Err("Pages open in their own view only on Linux.".into())
    }
    pub fn go(_: &tauri::AppHandle, _: String, _: url::Url) {}
    pub fn reload(_: &tauri::AppHandle, _: String) {}
    pub fn place(_: &tauri::AppHandle, _: String, _: Option<Placement>) {}
    pub fn close(_: &tauri::AppHandle, _: String) {}
}

#[cfg(target_os = "linux")]
mod imp {
    use super::*;
    use gtk::prelude::*;
    use std::cell::{Cell, RefCell};
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
        /// The app run's one ephemeral web context. Every view shares it, so a site's sign-in lasts the run.
        static CONTEXT: RefCell<Option<webkit2gtk::WebContext>> = const { RefCell::new(None) };
        /// The view shown, if any.
        static PAGE: RefCell<Option<Page>> = const { RefCell::new(None) };
        /// Where the overlay puts the view, in whole pixels.
        static AT: Cell<(i32, i32, i32, i32)> = const { Cell::new((0, 0, 1, 1)) };
    }

    struct Page {
        key: String,
        view: webkit2gtk::WebView,
        moves: Rc<Moves>,
    }

    /// What a view reports about where it is, and what that takes. The view's signals hold it.
    pub(super) struct Moves {
        /// Where events go, until the view ends; a late signal after that reaches nobody.
        events: RefCell<Option<Channel<PageEvent>>>,
        /// The address of the load the app asked for (`go`, `reload`), until it lands: where it lands replaces.
        asked: RefCell<Option<url::Url>>,
        /// Between a load's start (or the app asking for one) and its commit, the view's `uri` is the request's, and
        /// changes again on each redirect, so nothing is reported.
        loading: Cell<bool>,
        /// The address and WebKit's back and forward list lengths at the last report. Lengths both unchanged means the
        /// page replaced its entry; the address unchanged too means nothing moved (WebKit puts a stopped load's address
        /// back, and says so).
        last: RefCell<(Option<String>, (usize, usize))>,
        /// Whether what the app last asked for has committed: a download after that leaves the page shown.
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

        /// Where the view is now. `replace` when the app asked for it, or when the page kept its place in the lists.
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

    /// The view's signals, reported through `moves`.
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
        view.connect_load_failed(move |view, _, _, error| {
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
                    m.send(PageEvent::Failed { message: "It's a file to download, and the Preview doesn't save files.".into() });
                }
                return true;
            }
            m.send(PageEvent::Failed { message: error.message().to_owned() });
            true
        });
        let m = moves.clone();
        view.connect_web_process_terminated(move |_, _| {
            m.send(PageEvent::Failed { message: "The page stopped: WebKit's process for it ended.".into() });
        });
    }

    /// Asks `view` for `url`: back or forward in its own list when its neighbour there is `url`, else a load.
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

    /// The view and its reports, if `key` is the page shown. Cloned out, so no borrow is held while WebKit runs the
    /// signals it fires at once.
    fn shown(key: &str) -> Option<(webkit2gtk::WebView, Rc<Moves>)> {
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

    /// Ends `page`: its channel first, then the view, which goes from the overlay and is dropped.
    fn end(overlay: &gtk::Overlay, page: Page) {
        drop(page.moves.events.take());
        hide(overlay, &page.view);
        overlay.remove(&page.view);
    }

    pub fn open(app: &tauri::AppHandle, key: String, on_event: Channel<PageEvent>) -> Result<(), String> {
        let overlay = overlay(app).ok_or("Hermes Chat's window has no place for the page.")?;
        if let Some(before) = PAGE.with(|p| p.take()) {
            end(&overlay, before);
        }
        let context = CONTEXT.with(|c| c.borrow_mut().get_or_insert_with(page_context).clone());
        let view = page_webview(&context);
        view.set_no_show_all(true);
        let moves = Moves::new(on_event);
        watch(&view, &moves);
        overlay.add_overlay(&view);
        PAGE.with(|p| *p.borrow_mut() = Some(Page { key, view, moves }));
        Ok(())
    }

    pub fn go(_: &tauri::AppHandle, key: String, url: url::Url) {
        if let Some((view, moves)) = shown(&key) {
            go_in(&view, &moves, url);
        }
    }

    pub fn reload(_: &tauri::AppHandle, key: String) {
        if let Some((view, moves)) = shown(&key) {
            reload_in(&view, &moves);
        }
    }

    pub fn place(_: &tauri::AppHandle, key: String, placement: Option<Placement>) {
        let (Some(overlay), Some((view, _))) = (OVERLAY.with(|o| o.borrow().clone()), shown(&key)) else { return };
        let Some(placement) = placement else {
            hide(&overlay, &view);
            return;
        };
        AT.with(|at| at.set(pixels(&placement.rect)));
        overlay.queue_resize();
        let holes = holes_in_page(&placement);
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
            None => hide(&overlay, &view),
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

    /// Moves Tauri's webview into an overlay, where the page's views go over it.
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

    /// The run's web context for pages: ephemeral, so a page shares no storage with the app and its cookies last only
    /// while the app runs. No `allow-downloads`: a download stops as soon as it starts.
    pub(super) fn page_context() -> webkit2gtk::WebContext {
        let context = webkit2gtk::WebContext::new_ephemeral();
        context.connect_download_started(|_, download| {
            use webkit2gtk::DownloadExt;
            download.cancel();
        });
        context
    }

    /// A view that lets the page do no more than ADR 0007's frame did (`sandbox="allow-scripts allow-forms
    /// allow-same-origin"`, and every feature in its `allow` list `'none'`). ADR 0081 lists each.
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
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(serde_json::to_value(PageEvent::Failed { message: "m".into() }).unwrap(), serde_json::json!({ "kind": "failed", "message": "m" }));
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

    /// What a view reports as its page moves, against a stand-in server: one `at` per move, `replace` only where the
    /// entry's place is taken, and a load the app asked for reported where it lands, not where it was sent.
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
        let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap();

        gtk::init().expect("a display");
        let sent = Arc::new(Mutex::new(Vec::<Value>::new()));
        let into = sent.clone();
        let channel = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(text) = body {
                into.lock().unwrap().push(serde_json::from_str(&text).unwrap());
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
            let got: Vec<Value> = std::mem::take(&mut *sent.lock().unwrap());
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
        let unreachable = url::Url::parse(&format!("http://{closed}/")).unwrap();
        imp::go_in(&view, &moves, unreachable);
        run(1500);
        let got: Vec<Value> = std::mem::take(&mut *sent.lock().unwrap());
        assert!(matches!(got.as_slice(), [e] if e["kind"] == "failed"), "a load that fails says so, and nothing else: {got:?}");
        step("the page moves after a failed load", &script("history.pushState({}, '', '/after-failing')"), vec![at("/after-failing", false)]);
        step("a load the page stops", &script("document.getElementById('slow').click(); setTimeout(() => window.stop(), 300)"), vec![]);
        run(1500);
        step("the page moves after a stopped load", &script("history.pushState({}, '', '/after-stopping')"), vec![at("/after-stopping", false)]);
    }
}
