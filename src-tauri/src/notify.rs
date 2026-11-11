//! Desktop notifications. Clicking one brings the app's window forward.
//!
//! On Linux they go straight over the freedesktop Notifications D-Bus service that mako, dunst and swaync provide, and
//! a click comes with the Wayland activation token the service hands over, so the compositor lets the window take
//! focus. On Windows they are toasts, shown under the app's AppUserModelID, which the installer puts on its Start menu
//! shortcut; a copy run without installing has no such shortcut, and Windows then shows nothing.

use std::collections::VecDeque;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

/// How long a click on a notification still brings the app forward. Most services close it well before then.
const CLICKABLE_FOR: Duration = Duration::from_secs(30 * 60);
/// How many notifications a click is listened for at once. Past that the oldest is let go, and a click on it does
/// nothing: an app that posts more than this in half an hour isn't one the owner clicks back through.
const CLICKABLE_KEPT: usize = 64;

/// Shows a notification. Rejects when there is no notification service, or it refuses.
pub async fn show(app: AppHandle, title: String, body: String) -> Result<(), String> {
    desktop::show(app, title, body).await
}

/// Brings the window forward, with the desktop's activation token if it gave one.
fn focus(app: &AppHandle, token: Option<String>) {
    let Some(window) = app.get_webview_window("main") else { return };
    let _ = window.unminimize();
    let _ = window.show();
    let w = window.clone();
    let _ = window.run_on_main_thread(move || crate::summon::raise(&w, token));
}

/// The notifications a click is still listened for, oldest first: at most `CLICKABLE_KEPT`, none older than
/// `CLICKABLE_FOR`.
#[cfg_attr(not(any(target_os = "linux", windows)), allow(dead_code))]
struct Clickable<T>(VecDeque<(Instant, T)>);

#[cfg_attr(not(any(target_os = "linux", windows)), allow(dead_code))]
impl<T> Clickable<T> {
    const fn new() -> Self {
        Clickable(VecDeque::new())
    }

    /// Keeps `item`, posted `now`, letting go of the stale and then the oldest past `CLICKABLE_KEPT`.
    fn add(&mut self, now: Instant, item: T) {
        self.prune(now);
        if self.0.len() >= CLICKABLE_KEPT {
            self.0.pop_front();
        }
        self.0.push_back((now, item));
    }

    /// Lets go of those posted `CLICKABLE_FOR` or longer before `now`.
    fn prune(&mut self, now: Instant) {
        while self.0.front().is_some_and(|(at, _)| now.duration_since(*at) >= CLICKABLE_FOR) {
            self.0.pop_front();
        }
    }

    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    fn find(&mut self, is: impl Fn(&T) -> bool) -> Option<&mut T> {
        self.0.iter_mut().map(|(_, t)| t).find(|t| is(t))
    }

    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    fn take(&mut self, is: impl Fn(&T) -> bool) -> Option<T> {
        let i = self.0.iter().position(|(_, t)| is(t))?;
        self.0.remove(i).map(|(_, t)| t)
    }

    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// A toast's content: the title and body as text, never markup.
#[cfg_attr(not(windows), allow(dead_code))]
fn toast_xml(title: &str, body: &str) -> String {
    let text = |s: &str| {
        s.chars().fold(String::with_capacity(s.len()), |mut out, c| {
            match c {
                '&' => out.push_str("&amp;"),
                '<' => out.push_str("&lt;"),
                '>' => out.push_str("&gt;"),
                '"' => out.push_str("&quot;"),
                '\'' => out.push_str("&apos;"),
                // XML 1.0 can't carry other control characters at all.
                c if c.is_control() && !matches!(c, '\n' | '\t') => {}
                c => out.push(c),
            }
            out
        })
    };
    format!(r#"<toast><visual><binding template="ToastGeneric"><text>{}</text><text>{}</text></binding></visual></toast>"#, text(title), text(body))
}

/// Linux: one thread posts every notification and hears its click, started by the first. It holds one connection to
/// the session bus while any notification it posted is still clickable, and none while none is; a connection that
/// fails is let go, with the clicks it was hearing, and the next notification opens another.
#[cfg(target_os = "linux")]
mod desktop {
    use super::Clickable;
    use dbus::arg::{PropMap, Variant};
    use dbus::blocking::Connection;
    use dbus::message::MatchRule;
    use std::sync::{mpsc, OnceLock};
    use std::time::{Duration, Instant};
    use tauri::AppHandle;

    const SERVICE: &str = "org.freedesktop.Notifications";
    const PATH: &str = "/org/freedesktop/Notifications";
    const CALL_TIMEOUT: Duration = Duration::from_secs(5);
    /// How long the thread listens before it looks for a new notification to post: how late one may show.
    const LISTEN: Duration = Duration::from_millis(200);
    const ENDED: &str = "The notification thread ended.";

    struct Post {
        app: AppHandle,
        title: String,
        body: String,
        posted: tokio::sync::oneshot::Sender<Result<(), String>>,
    }

    enum Signal {
        Token(u32, String),
        Action(u32, String),
        Closed(u32),
    }

    static POSTS: OnceLock<mpsc::Sender<Post>> = OnceLock::new();

    pub(super) async fn show(app: AppHandle, title: String, body: String) -> Result<(), String> {
        let posts = POSTS.get_or_init(|| {
            let (posts, received) = mpsc::channel();
            std::thread::spawn(move || run(received));
            posts
        });
        let (posted, outcome) = tokio::sync::oneshot::channel();
        posts.send(Post { app, title, body, posted }).map_err(|_| ENDED.to_owned())?;
        outcome.await.map_err(|_| ENDED.to_owned())?
    }

    fn run(posts: mpsc::Receiver<Post>) {
        let mut bus: Option<Bus> = None;
        loop {
            let next: Vec<Post> = match &mut bus {
                None => match posts.recv() {
                    Ok(post) => vec![post],
                    Err(_) => return,
                },
                Some(b) => {
                    if !b.listen() {
                        bus = None;
                    }
                    posts.try_iter().collect()
                }
            };
            for Post { app, title, body, posted } in next {
                let opened = match bus.take() {
                    Some(b) => Ok(b),
                    None => Bus::open(app),
                };
                let shown = opened.and_then(|mut b| {
                    let id = b.notify(&title, &body);
                    bus = Some(b);
                    id
                });
                let _ = posted.send(shown.map_err(|e| e.to_string()));
            }
        }
    }

    /// The session bus, and the notifications posted on it whose click is still listened for, with the activation
    /// token each was given.
    struct Bus {
        conn: Connection,
        signals: mpsc::Receiver<Signal>,
        app: AppHandle,
        clickable: Clickable<(u32, Option<String>)>,
    }

    impl Bus {
        /// Listens for what happens to notifications; listening before posting means no signal is missed.
        fn open(app: AppHandle) -> Result<Bus, dbus::Error> {
            let conn = Connection::new_session()?;
            let (tx, signals) = mpsc::channel();
            let rule = |member: &'static str| MatchRule::new_signal(SERVICE, member).with_path(PATH);
            let token = tx.clone();
            conn.add_match(rule("ActivationToken"), move |(id, t): (u32, String), _, _| token.send(Signal::Token(id, t)).is_ok())?;
            let action = tx.clone();
            conn.add_match(rule("ActionInvoked"), move |(id, key): (u32, String), _, _| action.send(Signal::Action(id, key)).is_ok())?;
            conn.add_match(rule("NotificationClosed"), move |(id, _): (u32, u32), _, _| tx.send(Signal::Closed(id)).is_ok())?;
            Ok(Bus { conn, signals, app, clickable: Clickable::new() })
        }

        fn notify(&mut self, title: &str, body: &str) -> Result<(), dbus::Error> {
            let mut hints = PropMap::new();
            hints.insert("desktop-entry".into(), Variant(Box::new("hermes-chat".to_owned())));
            let proxy = self.conn.with_proxy(SERVICE, PATH, CALL_TIMEOUT);
            let (id,): (u32,) =
                proxy.method_call(SERVICE, "Notify", ("Hermes Chat", 0u32, "", title, body, vec!["default", "Open Hermes Chat"], hints, -1i32))?;
            self.clickable.add(Instant::now(), (id, None));
            Ok(())
        }

        /// Listens for a while, bringing the window forward for a click. False once the connection has failed or no
        /// notification is clickable any more.
        fn listen(&mut self) -> bool {
            if self.conn.process(LISTEN).is_err() {
                return false;
            }
            for s in self.signals.try_iter() {
                match s {
                    Signal::Token(n, t) => {
                        if let Some((_, token)) = self.clickable.find(|(id, _)| *id == n) {
                            *token = Some(t);
                        }
                    }
                    Signal::Action(n, key) if key == "default" => {
                        if let Some((_, token)) = self.clickable.take(|(id, _)| *id == n) {
                            super::focus(&self.app, token);
                        }
                    }
                    Signal::Action(..) => {}
                    Signal::Closed(n) => drop(self.clickable.take(|(id, _)| *id == n)),
                }
            }
            self.clickable.prune(Instant::now());
            !self.clickable.is_empty()
        }
    }
}

/// Windows: the toast's own click handler brings the window forward. A handler lives as long as its toast, so the
/// toasts still clickable are kept here.
#[cfg(windows)]
mod desktop {
    use super::Clickable;
    use std::sync::{Mutex, PoisonError};
    use std::time::Instant;
    use tauri::AppHandle;
    use windows::core::HSTRING;
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::Foundation::TypedEventHandler;
    use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};

    /// A development build has no Start menu shortcut of its own, so its toasts borrow PowerShell's, which every
    /// Windows has.
    const DEV_APP_ID: &str = r"{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe";

    static SHOWN: Mutex<Clickable<ToastNotification>> = Mutex::new(Clickable::new());

    pub(super) async fn show(app: AppHandle, title: String, body: String) -> Result<(), String> {
        let posted = tokio::task::spawn_blocking(move || post(&app, &title, &body)).await.map_err(|e| e.to_string())?;
        posted.map_err(|e| format!("Windows wouldn't show the notification: {}", e.message()))
    }

    fn post(app: &AppHandle, title: &str, body: &str) -> windows::core::Result<()> {
        let xml = XmlDocument::new()?;
        xml.LoadXml(&HSTRING::from(super::toast_xml(title, body)))?;
        let toast = ToastNotification::CreateToastNotification(&xml)?;
        let clicked = app.clone();
        toast.Activated(&TypedEventHandler::new(move |_, _| {
            super::focus(&clicked, None);
            Ok(())
        }))?;
        let id = if tauri::is_dev() { DEV_APP_ID.to_owned() } else { app.config().identifier.clone() };
        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(id))?.Show(&toast)?;
        SHOWN.lock().unwrap_or_else(PoisonError::into_inner).add(Instant::now(), toast);
        Ok(())
    }
}

#[cfg(not(any(target_os = "linux", windows)))]
mod desktop {
    pub(super) async fn show(_: tauri::AppHandle, _: String, _: String) -> Result<(), String> {
        Err("Desktop notifications aren't made on this system.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_toast_shows_its_text_as_text() {
        assert_eq!(
            toast_xml("Hermes <done>", "Tom & \"Jerry\"'s\u{7}\nnext"),
            "<toast><visual><binding template=\"ToastGeneric\"><text>Hermes &lt;done&gt;</text>\
             <text>Tom &amp; &quot;Jerry&quot;&apos;s\nnext</text></binding></visual></toast>"
        );
    }

    #[test]
    fn clicks_are_listened_for_on_the_newest_64_for_half_an_hour() {
        let start = Instant::now();
        let mut c = Clickable::new();
        for n in 0..CLICKABLE_KEPT as u32 + 1 {
            c.add(start, n);
        }
        assert!(c.take(|&n| n == 0).is_none(), "the oldest was let go for the 65th");
        assert!(c.take(|&n| n == 1).is_some(), "the next oldest is still clickable");
        assert!(c.find(|&n| n == 64).is_some());

        c.add(start + CLICKABLE_FOR / 2, 100);
        c.prune(start + CLICKABLE_FOR);
        assert!(c.find(|&n| n == 64).is_none(), "half an hour on, the first ones are stale");
        assert!(c.take(|&n| n == 100).is_some(), "a later one is still clickable");
        assert!(c.is_empty());
    }
}
