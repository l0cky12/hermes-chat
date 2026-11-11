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

use crate::annotate::{AnnotateError, Answer, Pick, Still};
use crate::screenshot::Captures;
use crate::server_page::Jar;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
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

/// Takes a still of the page shown as `key` (ADR 0094) and writes it to the captures folder. The page keeps it, to check
/// picks against, until the next still or the page closes.
pub async fn annotate_still(app: &tauri::AppHandle, key: String, captures: Arc<Captures>) -> Result<Still, AnnotateError> {
    imp::annotate_still(app, key, captures).await
}

/// What is under `(x, y)` on still `still`, `up` parents above the element there. `None`: nothing is.
pub async fn annotate_query(app: &tauri::AppHandle, key: String, still: u64, x: f64, y: f64, up: u32) -> Result<Option<Answer>, AnnotateError> {
    imp::annotate_query(app, key, still, x, y, up).await
}

/// Picks what is under `(x, y)` on still `still`: the element, if the page's pixels in its box still match the still's,
/// or else its box as a region.
pub async fn annotate_pick(app: &tauri::AppHandle, key: String, still: u64, x: f64, y: f64, up: u32) -> Result<Pick, AnnotateError> {
    imp::annotate_pick(app, key, still, x, y, up).await
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

    fn unsupported() -> AnnotateError {
        AnnotateError::Unsupported("Annotations need the page's own view, which only Linux has for now.".into())
    }
    pub async fn annotate_still(_: &tauri::AppHandle, _: String, _: Arc<Captures>) -> Result<Still, AnnotateError> {
        Err(unsupported())
    }
    pub async fn annotate_query(_: &tauri::AppHandle, _: String, _: u64, _: f64, _: f64, _: u32) -> Result<Option<Answer>, AnnotateError> {
        Err(unsupported())
    }
    pub async fn annotate_pick(_: &tauri::AppHandle, _: String, _: u64, _: f64, _: f64, _: u32) -> Result<Pick, AnnotateError> {
        Err(unsupported())
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use super::*;
    use crate::annotate::{self, Pixels, QueryArgs, RegionWhy, Target};
    use gtk::prelude::*;
    use std::cell::{Cell, RefCell};
    use std::collections::HashMap;
    use std::rc::Rc;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Duration;
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
        still: Option<Kept>,
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
        /// Goes up each time the page moves, starts a load or loses its web process, so a still from before is stale.
        generation: Cell<u64>,
    }

    impl Moves {
        pub(super) fn new(events: Channel<PageEvent>) -> Rc<Self> {
            Rc::new(Self {
                events: RefCell::new(Some(events)),
                asked: RefCell::default(),
                loading: Cell::new(false),
                last: RefCell::default(),
                answered: Cell::new(false),
                generation: Cell::new(0),
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
            self.moved();
            if let Some(url) = url.filter(|u| crate::web_page::web_url(u).is_ok()) {
                self.send(PageEvent::At { url, replace: asked || kept });
            }
        }

        fn moved(&self) {
            self.generation.set(self.generation.get() + 1);
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
            LoadEvent::Started => {
                m.loading.set(true);
                m.moved();
            }
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
            m.moved();
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
        Page { key, view, moves, jar, placement: None, still: None }
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

    // ---- annotations (ADR 0094) ----

    /// How long the page has to answer a query, or to give the snapshot a pick checks against.
    const ANSWER_WITHIN: Duration = Duration::from_secs(1);
    /// How long the still itself may take.
    const STILL_WITHIN: Duration = Duration::from_secs(3);
    static NEXT_STILL: AtomicU64 = AtomicU64::new(1);

    /// The still the page's annotation is being picked on, kept to check a pick's pixels against.
    #[derive(Clone)]
    pub(super) struct Kept {
        pub id: u64,
        pub generation: u64,
        pub width: f64,
        pub height: f64,
        pub scale: f64,
        pub pixels: Arc<Pixels>,
    }

    pub(super) struct Taken {
        pub kept: Kept,
        pub url: String,
        pub taken_at_ms: u64,
    }

    type Done<T> = Box<dyn FnOnce(Result<T, AnnotateError>)>;

    /// Starts `ask` with a cancellable and a callback, and calls `done` once: with what `ask` gives, or with `NoAnswer`
    /// once `limit` passes, when the call is cancelled. A web process busy with the page's own script may never give
    /// WebKit's callback back.
    fn within<T: 'static>(limit: Duration, done: impl FnOnce(Result<T, AnnotateError>) + 'static, ask: impl FnOnce(&gio::Cancellable, Done<T>)) {
        let cancellable = gio::Cancellable::new();
        let done: Rc<RefCell<Option<Done<T>>>> = Rc::new(RefCell::new(Some(Box::new(done))));
        let timer = Rc::new(Cell::new(None::<gtk::glib::SourceId>));
        let (d, c, t) = (done.clone(), cancellable.clone(), timer.clone());
        timer.set(Some(gtk::glib::timeout_add_local_once(limit, move || {
            t.take();
            c.cancel();
            if let Some(done) = d.take() {
                done(Err(AnnotateError::NoAnswer));
            }
        })));
        ask(
            &cancellable,
            Box::new(move |answer| {
                if let Some(timer) = timer.take() {
                    timer.remove();
                }
                if let Some(done) = done.take() {
                    done(answer);
                }
            }),
        );
    }

    fn snapshot(view: &webkit2gtk::WebView, cancellable: &gio::Cancellable, done: Done<Pixels>) {
        use webkit2gtk::{SnapshotOptions, SnapshotRegion};
        view.snapshot(SnapshotRegion::Visible, SnapshotOptions::NONE, Some(cancellable), move |surface| {
            let failed = |e: &dyn std::fmt::Display| AnnotateError::Failed(format!("Couldn't take a still of the page: {e}"));
            let pixels = surface.map_err(|e| failed(&e)).and_then(|surface| {
                let mut image = cairo::ImageSurface::try_from(surface).map_err(|_| failed(&"it isn't an image"))?;
                image.flush();
                let (width, height, stride) = (image.width() as usize, image.height() as usize, image.stride() as usize);
                let data = image.data().map_err(|e| failed(&e))?.to_vec();
                Pixels::new(width, height, stride, data).ok_or_else(|| failed(&"its size is wrong"))
            });
            done(pixels);
        });
    }

    /// Takes a still of the page shown as `key`, and keeps it to check picks against.
    pub(super) fn still_in(key: &str, done: impl FnOnce(Result<Taken, AnnotateError>) + 'static) {
        let Some((view, moves)) = shown(key) else { return done(Err(AnnotateError::NoPage)) };
        let Some(url) = view.uri().map(String::from).filter(|u| crate::web_page::web_url(u).is_ok()) else { return done(Err(AnnotateError::NoPage)) };
        let generation = moves.generation.get();
        let (width, height, scale) = (f64::from(view.allocated_width()), f64::from(view.allocated_height()), f64::from(view.scale_factor()));
        let key = key.to_owned();
        let keep = move |pixels: Result<Pixels, AnnotateError>| {
            let pixels = pixels?;
            if moves.generation.get() != generation {
                return Err(AnnotateError::Stale);
            }
            let taken_at_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
            let kept = Kept { id: NEXT_STILL.fetch_add(1, Ordering::Relaxed), generation, width, height, scale, pixels: Arc::new(pixels) };
            let page = PAGE.with(|p| p.borrow_mut().as_mut().filter(|p| p.key == key).map(|p| p.still = Some(kept.clone())));
            page.ok_or(AnnotateError::NoPage)?;
            Ok(Taken { kept, url, taken_at_ms })
        };
        within(STILL_WITHIN, move |pixels| done(keep(pixels)), |cancellable, got| snapshot(&view, cancellable, got));
    }

    /// The page shown as `key`, and its still `still`, if the page hasn't moved since.
    fn on_still(key: &str, still: u64) -> Result<(webkit2gtk::WebView, Rc<Moves>, Kept), AnnotateError> {
        let found = PAGE.with(|p| {
            let p = p.borrow();
            let page = p.as_ref().filter(|p| p.key == key)?;
            let kept = page.still.clone().filter(|k| k.id == still)?;
            Some((page.view.clone(), page.moves.clone(), kept))
        });
        let (view, moves, kept) = found.ok_or(AnnotateError::NoPage)?;
        if moves.generation.get() != kept.generation {
            return Err(AnnotateError::Stale);
        }
        Ok((view, moves, kept))
    }

    fn ask(view: &webkit2gtk::WebView, moves: Rc<Moves>, generation: u64, args: QueryArgs, done: impl FnOnce(Result<Option<Answer>, AnnotateError>) + 'static) {
        use javascriptcore::ValueExt;
        let arguments = gtk::glib::VariantDict::new(None);
        arguments.insert("x", args.x);
        arguments.insert("y", args.y);
        arguments.insert("up", f64::from(args.up));
        let arguments = arguments.end();
        within(ANSWER_WITHIN, done, |cancellable, done| {
            view.call_async_javascript_function(annotate::QUERY, Some(&arguments), Some(annotate::WORLD), None, Some(cancellable), move |answer| {
                if moves.generation.get() != generation {
                    return done(Err(AnnotateError::Stale));
                }
                let json = answer.ok().filter(|v| v.is_string()).map(|v| v.to_str());
                done(json.ok_or(AnnotateError::NoAnswer).and_then(|json| annotate::parse_answer(&json).map_err(|_| AnnotateError::NoAnswer)));
            });
        });
    }

    /// What is at `(x, y)` on still `still` of the page shown as `key`, `up` parents above the element there.
    pub(super) fn query_in(key: &str, still: u64, x: f64, y: f64, up: u32, done: impl FnOnce(Result<Option<Answer>, AnnotateError>) + 'static) {
        let asked = on_still(key, still).and_then(|(view, moves, kept)| Ok((QueryArgs::new(x, y, up, kept.width, kept.height)?, view, moves, kept)));
        match asked {
            Ok((args, view, moves, kept)) => ask(&view, moves, kept.generation, args, done),
            Err(e) => done(Err(e)),
        }
    }

    /// Picks what is at `(x, y)` on still `still`: the element, if the page's pixels in its box still match the still's;
    /// otherwise its box as a region.
    pub(super) fn pick_in(key: &str, still: u64, x: f64, y: f64, up: u32, done: impl FnOnce(Result<Pick, AnnotateError>) + 'static) {
        let asked = on_still(key, still).and_then(|(view, moves, kept)| Ok((QueryArgs::new(x, y, up, kept.width, kept.height)?, view, moves, kept)));
        let (args, view, moves, kept) = match asked {
            Ok(asked) => asked,
            Err(e) => return done(Err(e)),
        };
        let check = view.clone();
        ask(&view, moves.clone(), kept.generation, args, move |answer| {
            let answer = match answer {
                Ok(Some(answer)) => answer,
                Ok(None) => return done(Err(AnnotateError::NoAnswer)),
                Err(e) => return done(Err(e)),
            };
            let rect = answer.rect;
            if let Target::OtherSite { host } = &answer.target {
                return done(Ok(Pick::Region { rect, why: RegionWhy::OtherSite { host: host.clone() } }));
            }
            let compare = move |now: Result<Pixels, AnnotateError>| {
                if moves.generation.get() != kept.generation {
                    return done(Err(AnnotateError::Stale));
                }
                let why = match now {
                    Err(_) => Some(RegionWhy::NoAnswer),
                    Ok(now) if annotate::box_changed(&kept.pixels, &now, rect, kept.scale) => Some(RegionWhy::Changed),
                    Ok(_) => None,
                };
                done(Ok(match why {
                    Some(why) => Pick::Region { rect, why },
                    None => Pick::Element(answer),
                }));
            };
            within(ANSWER_WITHIN, compare, |cancellable, got| snapshot(&check, cancellable, got));
        });
    }

    /// Runs `start` on the main thread, GTK's, and waits for what it gives `done`.
    async fn on_main<T: Send + 'static>(app: &tauri::AppHandle, start: impl FnOnce(Done<T>) + Send + 'static) -> Result<T, AnnotateError> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            start(Box::new(move |answer| {
                let _ = tx.send(answer);
            }))
        })
        .map_err(|e| AnnotateError::Failed(e.to_string()))?;
        rx.await.unwrap_or(Err(AnnotateError::NoAnswer))
    }

    pub async fn annotate_still(app: &tauri::AppHandle, key: String, captures: Arc<Captures>) -> Result<Still, AnnotateError> {
        let Taken { kept, url, taken_at_ms } = on_main(app, move |done| still_in(&key, done)).await?;
        let pixels = kept.pixels.clone();
        let path = tokio::task::spawn_blocking(move || {
            let png = annotate::png(&pixels)?;
            captures.write("still", &png).map_err(|e| AnnotateError::Failed(e.to_string()))
        })
        .await
        .map_err(|e| AnnotateError::Failed(e.to_string()))??;
        Ok(Still {
            id: kept.id,
            generation: kept.generation,
            path: path.to_string_lossy().into_owned(),
            url,
            taken_at_ms,
            width: kept.width,
            height: kept.height,
            scale: kept.scale,
        })
    }

    pub async fn annotate_query(app: &tauri::AppHandle, key: String, still: u64, x: f64, y: f64, up: u32) -> Result<Option<Answer>, AnnotateError> {
        on_main(app, move |done| query_in(&key, still, x, y, up, done)).await
    }

    pub async fn annotate_pick(app: &tauri::AppHandle, key: String, still: u64, x: f64, y: f64, up: u32) -> Result<Pick, AnnotateError> {
        on_main(app, move |done| pick_in(&key, still, x, y, up, done)).await
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::time::Instant;

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

        /// Serves `body_for(path)` as HTML on a port of its own.
        fn serve(body_for: impl Fn(&str) -> String + Send + 'static) -> u16 {
            use std::io::{Read, Write};
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            std::thread::spawn(move || {
                for mut stream in listener.incoming().flatten() {
                    let mut request = [0u8; 4096];
                    let n = stream.read(&mut request).unwrap_or(0);
                    let path = String::from_utf8_lossy(&request[..n]).split_whitespace().nth(1).unwrap_or("/").to_owned();
                    let body = body_for(&path);
                    let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                    let _ = stream.write_all(response.as_bytes());
                }
            });
            port
        }

        fn run_until(mut done: impl FnMut() -> bool, secs: u64, what: &str) {
            let end = Instant::now() + Duration::from_secs(secs);
            while !done() {
                assert!(Instant::now() < end, "timed out: {what}");
                gtk::main_iteration_do(false);
                std::thread::sleep(Duration::from_millis(1));
            }
        }

        fn run_for(ms: u64) {
            let end = Instant::now() + Duration::from_millis(ms);
            while Instant::now() < end {
                gtk::main_iteration_do(false);
                std::thread::sleep(Duration::from_millis(1));
            }
        }

        /// A page that tries to fool or read from a picker: secrets in a password field, a hidden input, a data
        /// attribute, a session-like class and a signed background address, 10,000 characters of text, a same-origin and
        /// a cross-origin frame, and its own versions of everything a picker calls.
        fn hostile_page(cross_port: u16) -> String {
            format!(
                r#"<!doctype html><html><head><style>
body {{ margin: 0; font: 14px sans-serif; }}
#save {{ position: absolute; left: 40px; top: 40px; width: 120px; height: 36px; background: rgb(37,99,235); color: white; border: 0; }}
#secret {{ position: absolute; left: 200px; top: 40px; }}
#bg {{ position: absolute; left: 40px; top: 100px; width: 100px; height: 40px; background-image: url("https://cdn.example/a.png?sig=SECRETSIG"); }}
#same {{ position: absolute; left: 40px; top: 160px; width: 200px; height: 100px; border: 0; }}
#cross {{ position: absolute; left: 260px; top: 160px; width: 200px; height: 100px; border: 0; }}
#long {{ position: absolute; left: 40px; top: 300px; width: 400px; height: 60px; overflow: hidden; }}
</style></head><body>
<button id="save" class="primary session-8f3a9b2c" data-token="TOK123">Save changes</button>
<input id="secret" type="password" value="hunter2">
<input type="hidden" name="csrf" value="CSRF999">
<div id="bg"></div>
<iframe id="same" src="/frame"></iframe>
<iframe id="cross" src="http://localhost:{cross_port}/frame"></iframe>
<div id="long">{long}</div>
<script>
document.elementFromPoint = () => document.body;
Element.prototype.getBoundingClientRect = () => ({{left: 0, top: 0, width: 1, height: 1, x: 0, y: 0}});
window.getComputedStyle = () => ({{ color: 'evil', backgroundImage: 'evil', display: 'evil' }});
JSON.stringify = () => '"evil"';
Object.defineProperty(document.getElementById('save'), 'innerText', {{ get() {{ return 'EVIL TEXT'; }} }});
</script></body></html>"#,
                long = "x".repeat(10_000)
            )
        }

        const KEY: &str = "page";

        /// The page at `url`, opened and shown as the app shows one: at 640×480 in an overlay over the app's view.
        fn open_page(url: &str) -> (gtk::Window, gtk::Overlay, webkit2gtk::WebView) {
            gtk::init().expect("a display");
            let overlay = gtk::Overlay::new();
            overlay.add(&gtk::Label::new(Some("app")));
            overlay.connect_get_child_position(|_, _| {
                let (x, y, w, h) = AT.with(Cell::get);
                Some(gtk::gdk::Rectangle::new(x, y, w, h))
            });
            let window = gtk::Window::new(gtk::WindowType::Toplevel);
            window.set_default_size(1000, 700);
            window.add(&overlay);
            window.show_all();
            open_in(&overlay, KEY.into(), Channel::new(|_| Ok(())));
            let (view, _) = shown(KEY).unwrap();
            let loaded = Rc::new(Cell::new(false));
            let l = loaded.clone();
            view.connect_load_changed(move |_, event| l.set(l.get() || event == LoadEvent::Finished));
            go(KEY, url::Url::parse(url).unwrap(), None);
            show_at(&overlay, &view, Some(&Placement { rect: Rect { x: 100.0, y: 50.0, width: 640.0, height: 480.0 }, holes: vec![] }));
            run_until(|| loaded.get(), 120, "the page loads");
            run_for(1000);
            (window, overlay, view)
        }

        fn hostile_view() -> (gtk::Window, gtk::Overlay, webkit2gtk::WebView) {
            let cross = serve(|_| "<button style='width:100%;height:100%'>Cross</button>".into());
            let port = serve(move |path| match path {
                "/frame" => "<body style='margin:0'><button id=inner style='width:150px;height:50px'>Inner button</button></body>".into(),
                _ => hostile_page(cross),
            });
            open_page(&format!("http://127.0.0.1:{port}/"))
        }

        fn plain_view() -> (gtk::Window, gtk::Overlay, webkit2gtk::WebView) {
            let port = serve(|_| "<body style='margin:0;background:rgb(10,20,30)'><button style='width:100px;height:40px'>Go</button></body>".into());
            open_page(&format!("http://127.0.0.1:{port}/"))
        }

        fn wait<T: 'static>(start: impl FnOnce(Done<T>)) -> Result<T, AnnotateError> {
            let out = Rc::new(RefCell::new(None));
            let o = out.clone();
            start(Box::new(move |answer| {
                o.replace(Some(answer));
            }));
            run_until(|| out.borrow().is_some(), 20, "an answer");
            out.take().unwrap()
        }

        /// A still of the page, which then hides behind it, as the Preview hides it.
        fn take_still(overlay: &gtk::Overlay, view: &webkit2gtk::WebView) -> Taken {
            let taken = wait(|done| still_in(KEY, done)).expect("a still");
            hide(overlay, view);
            run_for(300);
            taken
        }

        fn query(still: u64, x: f64, y: f64, up: u32) -> Result<Option<Answer>, AnnotateError> {
            wait(|done| query_in(KEY, still, x, y, up, done))
        }

        fn pick(still: u64, x: f64, y: f64, up: u32) -> Result<Pick, AnnotateError> {
            wait(|done| pick_in(KEY, still, x, y, up, done))
        }

        fn in_page(view: &webkit2gtk::WebView, js: &str) -> String {
            use javascriptcore::ValueExt;
            let out: Rc<RefCell<Option<String>>> = Rc::default();
            let o = out.clone();
            view.evaluate_javascript(js, None, None, None::<&gio::Cancellable>, move |r| {
                o.replace(Some(r.map(|v| v.to_str().to_string()).unwrap_or_else(|e| format!("error: {e}"))));
            });
            run_until(|| out.borrow().is_some(), 20, "the page's answer");
            out.take().unwrap()
        }

        fn element(pick: &Pick) -> (&Answer, Option<&str>, &str, &std::collections::BTreeMap<annotate::StyleProp, annotate::Text<80>>) {
            match pick {
                Pick::Element(answer @ Answer { target: Target::Element { label, selector, styles, .. }, .. }) => {
                    (answer, label.as_ref().map(|l| l.as_str()), selector.as_str(), styles)
                }
                other => panic!("not an element: {other:?}"),
            }
        }

        fn rect(x: f64, y: f64, width: f64, height: f64) -> annotate::Rect {
            annotate::Rect { x, y, width, height }
        }

        /// A hidden page answers the query from its isolated world, which the page's own replacements of
        /// elementFromPoint, getBoundingClientRect, getComputedStyle, JSON.stringify and innerText don't reach, and its
        /// snapshot matches the still. Nothing the page holds in a field, a hidden input, a data attribute, a
        /// secret-looking class or a signed background address comes out.
        #[test]
        #[ignore = "needs a display, a session bus and GTK on one thread, so one test a process: xvfb-run -a dbus-run-session -- cargo test --lib page_view::imp::tests::a_hidden_page -- --ignored"]
        fn a_hidden_page_answers_from_an_isolated_world_and_snapshots() {
            let (_window, overlay, view) = hostile_view();
            let started = Instant::now();
            let taken = wait(|done| still_in(KEY, done)).expect("a still");
            let scale = taken.kept.scale;
            eprintln!("scale {scale}: still {}×{} in {:?}", taken.kept.pixels.width(), taken.kept.pixels.height(), started.elapsed());
            hide(&overlay, &view);
            run_for(300);
            assert!(!view.is_visible(), "the page hides behind the still");
            let id = taken.kept.id;

            let started = Instant::now();
            let save = pick(id, 60.0, 50.0, 0).expect("a pick");
            eprintln!("scale {scale}: a pick (query and check snapshot) in {:?}", started.elapsed());
            let (answer, label, selector, styles) = element(&save);
            assert_eq!(answer.rect, rect(40.0, 40.0, 120.0, 36.0), "the real box, not the page's");
            assert_eq!(label, Some("Save changes"), "the real text, not the page's getter");
            assert_eq!(selector, "html > body > button#save.primary", "no session-like class");
            assert_eq!(styles[&annotate::StyleProp::Color].as_str(), "rgb(255, 255, 255)", "the real computed style");
            assert_eq!(answer.view.scale, scale);

            let password = query(id, 210.0, 45.0, 0).unwrap().unwrap();
            assert!(matches!(password.target, Target::Field { field: annotate::Field::Password, label: None, .. }), "{password:?}");
            let background = pick(id, 50.0, 110.0, 0).unwrap();
            let (_, _, selector, _) = element(&background);
            assert_eq!(selector, "html > body > div#bg");
            let same = pick(id, 60.0, 180.0, 0).unwrap();
            let (answer, label, selector, _) = element(&same);
            assert_eq!(
                (answer.rect, label, selector),
                (rect(40.0, 160.0, 150.0, 50.0), Some("Inner button"), "html > body > button#inner"),
                "a same-origin frame is entered"
            );
            let frame = query(id, 60.0, 180.0, 3).unwrap().unwrap();
            assert!(matches!(&frame.target, Target::Element { tag, .. } if tag.as_str() == "iframe"), "up climbs out of the frame: {frame:?}");
            assert_eq!(frame.rect, rect(40.0, 160.0, 200.0, 100.0));
            let cross = pick(id, 300.0, 180.0, 0).unwrap();
            assert!(
                matches!(&cross, Pick::Region { rect: r, why: RegionWhy::OtherSite { host } } if *r == rect(260.0, 160.0, 200.0, 100.0) && serde_json::to_value(host).unwrap().as_str().unwrap().starts_with("localhost:")),
                "another site's frame is a region named by its host: {cross:?}"
            );
            let long = query(id, 50.0, 310.0, 0).unwrap().unwrap();
            let Target::Element { label: Some(long_label), .. } = &long.target else { panic!("{long:?}") };
            assert_eq!(long_label.as_str().chars().count(), 80);
            let body = query(id, 60.0, 50.0, 1).unwrap().unwrap();
            assert!(matches!(&body.target, Target::Element { tag, .. } if tag.as_str() == "body"), "up climbs to the parent");

            let said = serde_json::to_string(&(&save, &password, &background, &same, &frame, &cross, &long, &body)).unwrap();
            for secret in ["hunter2", "CSRF999", "SECRETSIG", "TOK123", "session-8f3a", "EVIL", "evil"] {
                assert!(!said.contains(secret), "{secret} came out: {said}");
            }
            assert_eq!(in_page(&view, "JSON.stringify({})"), "\"evil\"", "the page's own replacements were in place");
            assert_eq!(in_page(&view, "document.visibilityState"), "hidden");

            let mut latency: Vec<Duration> = (0..20)
                .map(|_| {
                    let started = Instant::now();
                    query(id, 60.0, 50.0, 0).unwrap();
                    started.elapsed()
                })
                .collect();
            latency.sort();
            eprintln!("scale {scale}: hidden query min {:?}, median {:?}, max {:?}", latency[0], latency[10], latency[19]);

            in_page(&view, "document.getElementById('save').style.background = 'rgb(200, 0, 0)'");
            run_for(300);
            let moved = pick(id, 60.0, 50.0, 0).unwrap();
            assert!(matches!(moved, Pick::Region { why: RegionWhy::Changed, .. }), "a page that changed under the still gives a region: {moved:?}");
        }

        #[test]
        #[ignore = "needs a display, a session bus and GTK on one thread, so one test a process: xvfb-run -a dbus-run-session -- cargo test --lib page_view::imp::tests::a_still_is -- --ignored"]
        fn a_still_is_in_device_pixels() {
            let (_window, _overlay, view) = plain_view();
            let scale = f64::from(view.scale_factor());
            let taken = wait(|done| still_in(KEY, done)).expect("a still");
            assert!(taken.url.starts_with("http://127.0.0.1:"), "{}", taken.url);
            assert_eq!((taken.kept.width, taken.kept.height, taken.kept.scale), (640.0, 480.0, scale), "the view's size in CSS pixels, and its scale");
            let device = ((640.0 * scale) as usize, (480.0 * scale) as usize);
            assert_eq!((taken.kept.pixels.width(), taken.kept.pixels.height()), device);
            let png = annotate::png(&taken.kept.pixels).unwrap();
            let image = cairo::ImageSurface::create_from_png(&mut png.as_slice()).unwrap();
            assert_eq!((image.width() as usize, image.height() as usize), device, "the PNG too");
            eprintln!("scale {scale}: still {}×{} device pixels for a 640×480 view, PNG {} bytes", device.0, device.1, png.len());
        }

        #[test]
        #[ignore = "needs a display, a session bus and GTK on one thread, so one test a process: xvfb-run -a dbus-run-session -- cargo test --lib page_view::imp::tests::a_page_that_moves -- --ignored"]
        fn a_page_that_moves_makes_its_still_stale() {
            let (_window, overlay, view) = plain_view();
            let first = take_still(&overlay, &view).kept.id;
            assert!(query(first, 20.0, 20.0, 0).unwrap().is_some());
            in_page(&view, "history.pushState({}, '', '/moved')");
            run_for(300);
            assert_eq!(query(first, 20.0, 20.0, 0), Err(AnnotateError::Stale), "pushState after the still");
            assert_eq!(pick(first, 20.0, 20.0, 0), Err(AnnotateError::Stale));

            let second = take_still(&overlay, &view).kept.id;
            assert!(query(second, 20.0, 20.0, 0).unwrap().is_some(), "a new still works");
            assert_eq!(query(first, 20.0, 20.0, 0), Err(AnnotateError::NoPage), "the page keeps only its latest still");
            assert!(matches!(query(second, 640.0, 20.0, 0), Err(AnnotateError::Failed(_))), "a point off the still");
            in_page(&view, "location.hash = 'there'");
            run_for(300);
            assert_eq!(query(second, 20.0, 20.0, 0), Err(AnnotateError::Stale), "a fragment after the still");
            let third = take_still(&overlay, &view).kept.id;
            in_page(&view, "location.reload()");
            run_for(1000);
            assert_eq!(query(third, 20.0, 20.0, 0), Err(AnnotateError::Stale), "a load after the still");
        }

        #[test]
        #[ignore = "needs a display, a session bus and GTK on one thread, so one test a process: xvfb-run -a dbus-run-session -- cargo test --lib page_view::imp::tests::a_busy_page -- --ignored"]
        fn a_busy_page_gives_no_answer_within_a_second() {
            let (_window, overlay, view) = plain_view();
            let id = take_still(&overlay, &view).kept.id;
            view.evaluate_javascript("const end = Date.now() + 4000; while (Date.now() < end) {}", None, None, None::<&gio::Cancellable>, |_| {});
            let started = Instant::now();
            let busy = query(id, 20.0, 20.0, 0);
            let took = started.elapsed();
            eprintln!("a busy page: {busy:?} after {took:?}");
            assert_eq!(busy, Err(AnnotateError::NoAnswer));
            assert!(took >= Duration::from_millis(950) && took < Duration::from_millis(1800), "{took:?}");
            let started = Instant::now();
            assert_eq!(pick(id, 20.0, 20.0, 0), Err(AnnotateError::NoAnswer));
            assert!(started.elapsed() < Duration::from_millis(1800));
            run_for(4000);
            assert!(query(id, 20.0, 20.0, 0).unwrap().is_some(), "it answers once it is free");
        }
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
                    log.lock().unwrap().push(format!("{path} {cookie}"));
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
                into.lock().unwrap().push(serde_json::from_str(&text).unwrap());
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
            sent_cookies.lock().unwrap().clear();
            imp::go("page", url::Url::parse(&url).unwrap(), jar.clone());
            let (view, _) = imp::shown("page").unwrap();
            let deadline = Instant::now() + Duration::from_secs(20);
            loop {
                if let Some(title) = view.title().filter(|t| t.starts_with("cookie:") && !view.is_loading()) {
                    assert_eq!(overlay.children().len(), 1, "the view in the jar before it is gone");
                    let asked = sent_cookies.lock().unwrap().iter().rev().find(|r| !r.starts_with("/favicon")).cloned().unwrap();
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
        let last = sent.lock().unwrap().last().cloned();
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
        let unreachable = url::Url::parse(&format!("http://{}/", closed.addr)).unwrap();
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
