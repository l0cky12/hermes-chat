//! Desktop notifications. Clicking one brings the app's window forward. One about a waiting card is tagged by the
//! webview, and the click tells the webview, which opens the card; one about an Approval also offers Deny (ADR 0171).
//!
//! On Linux they go straight over the freedesktop Notifications D-Bus service that mako, dunst and swaync provide, and
//! a click comes with the Wayland activation token the service hands over, so the compositor lets the window take
//! focus. On Windows they are toasts, shown under the app's AppUserModelID, which the installer puts on its Start menu
//! shortcut; a copy run without installing has no such shortcut, and Windows then shows nothing.

use serde::Serialize;
use std::collections::VecDeque;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// Tells the webview the owner acted on a notification it tagged: `{ tag, action }`.
pub const ACTION_EVENT: &str = "notification-action";

/// How long a click on a notification still brings the app forward. Most services close it well before then.
const CLICKABLE_FOR: Duration = Duration::from_secs(30 * 60);
/// How many notifications a click is listened for at once. Past that the oldest is let go, and a click on it does
/// nothing: an app that posts more than this in half an hour isn't one the owner clicks back through.
const CLICKABLE_KEPT: usize = 64;

/// Shows a notification. `tag`: the webview's name for it, sent back with what the owner does with it. `deny`: offer
/// Deny beside the click, where the notification service shows actions. Rejects when there is no notification service,
/// or it refuses.
pub async fn show(app: AppHandle, title: String, body: String, tag: Option<String>, deny: bool) -> Result<(), String> {
    desktop::show(app, title, body, tag, deny).await
}

/// What the owner did with a notification: opened it, or chose Deny.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
#[cfg_attr(not(any(target_os = "linux", windows)), allow(dead_code))]
enum Action {
    Open,
    Deny,
}

#[derive(Serialize, Clone)]
struct Acted {
    tag: String,
    action: Action,
}

/// A freedesktop notification's actions, key then label. `default` is the click on the notification itself. Deny comes
/// with Review, so a service that draws actions as buttons never shows Deny as the only answer.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn actions(deny: bool) -> Vec<&'static str> {
    let mut keys = vec!["default", "Open Hermes Chat"];
    if deny {
        keys.extend(["review", "Review", "deny", "Deny"]);
    }
    keys
}

/// The action an invoked key stands for.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn invoked(key: &str) -> Option<Action> {
    match key {
        "default" | "review" => Some(Action::Open),
        "deny" => Some(Action::Deny),
        _ => None,
    }
}

/// Opening brings the window forward; Deny leaves it where it is. A tagged notification tells the webview either way.
#[cfg_attr(not(any(target_os = "linux", windows)), allow(dead_code))]
fn act(app: &AppHandle, action: Action, token: Option<String>, tag: Option<String>) {
    if action == Action::Open {
        focus(app, token);
    }
    if let Some(tag) = tag {
        let _ = app.emit(ACTION_EVENT, Acted { tag, action });
    }
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
    /// How many notifications may wait while the thread posts one. A post can take `CALL_TIMEOUT` when the service
    /// stalls, and one that has waited eight of those, 40 s, isn't news any more: past it, a new one is refused.
    const WAITING: usize = 8;
    const TOO_MANY: &str = "The notification service isn't keeping up, so this notification wasn't shown.";

    struct Post {
        app: AppHandle,
        title: String,
        body: String,
        tag: Option<String>,
        deny: bool,
        posted: tokio::sync::oneshot::Sender<Result<(), String>>,
    }

    /// A notification posted, with the activation token the service gave it and the webview's tag.
    struct Shown {
        id: u32,
        token: Option<String>,
        tag: Option<String>,
    }

    enum Signal {
        Token(u32, String),
        Action(u32, String),
        Closed(u32),
    }

    static POSTS: OnceLock<mpsc::SyncSender<Post>> = OnceLock::new();

    pub(super) async fn show(app: AppHandle, title: String, body: String, tag: Option<String>, deny: bool) -> Result<(), String> {
        let posts = POSTS.get_or_init(|| {
            let (posts, received) = mpsc::sync_channel(WAITING);
            std::thread::spawn(move || run(received));
            posts
        });
        let (posted, outcome) = tokio::sync::oneshot::channel();
        admit(posts, Post { app, title, body, tag, deny, posted })?;
        outcome.await.map_err(|_| ENDED.to_owned())?
    }

    fn admit<T>(posts: &mpsc::SyncSender<T>, post: T) -> Result<(), String> {
        posts.try_send(post).map_err(|e| match e {
            mpsc::TrySendError::Full(_) => TOO_MANY.to_owned(),
            mpsc::TrySendError::Disconnected(_) => ENDED.to_owned(),
        })
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
            for Post { app, title, body, tag, deny, posted } in next {
                let opened = match bus.take() {
                    Some(b) => Ok(b),
                    None => Bus::open(app),
                };
                let shown = opened.and_then(|mut b| {
                    let id = b.notify(&title, &body, tag, deny);
                    bus = Some(b);
                    id
                });
                let _ = posted.send(shown.map_err(|e| e.to_string()));
            }
        }
    }

    /// The session bus, and the notifications posted on it whose click is still listened for.
    struct Bus {
        conn: Connection,
        signals: mpsc::Receiver<Signal>,
        app: AppHandle,
        clickable: Clickable<Shown>,
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

        fn notify(&mut self, title: &str, body: &str, tag: Option<String>, deny: bool) -> Result<(), dbus::Error> {
            let mut hints = PropMap::new();
            hints.insert("desktop-entry".into(), Variant(Box::new("hermes-chat".to_owned())));
            let proxy = self.conn.with_proxy(SERVICE, PATH, CALL_TIMEOUT);
            let (id,): (u32,) = proxy.method_call(SERVICE, "Notify", ("Hermes Chat", 0u32, "", title, body, super::actions(deny), hints, -1i32))?;
            self.clickable.add(Instant::now(), Shown { id, token: None, tag });
            Ok(())
        }

        /// Listens for a while, acting on a click or an action. False once the connection has failed or no
        /// notification is clickable any more.
        fn listen(&mut self) -> bool {
            if self.conn.process(LISTEN).is_err() {
                return false;
            }
            for s in self.signals.try_iter() {
                match s {
                    Signal::Token(n, t) => {
                        if let Some(shown) = self.clickable.find(|s| s.id == n) {
                            shown.token = Some(t);
                        }
                    }
                    Signal::Action(n, key) => {
                        if let Some(action) = super::invoked(&key) {
                            if let Some(Shown { token, tag, .. }) = self.clickable.take(|s| s.id == n) {
                                super::act(&self.app, action, token, tag);
                            }
                        }
                    }
                    Signal::Closed(n) => drop(self.clickable.take(|s| s.id == n)),
                }
            }
            self.clickable.prune(Instant::now());
            !self.clickable.is_empty()
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn past_8_waiting_on_a_stalled_service_a_notification_is_refused() {
            let (posts, stalled) = mpsc::sync_channel(WAITING);
            for n in 0..WAITING {
                admit(&posts, n).unwrap();
            }
            assert_eq!(admit(&posts, WAITING), Err(TOO_MANY.to_owned()));
            stalled.recv().unwrap();
            assert_eq!(admit(&posts, WAITING), Ok(()), "room again once the thread takes one");
            drop(stalled);
            assert_eq!(admit(&posts, 0), Err(ENDED.to_owned()));
        }
    }
}

/// Windows: the toast's own click handler brings the window forward. A handler lives as long as its toast, so the
/// toasts still clickable are kept here.
#[cfg(windows)]
mod desktop {
    use super::Clickable;
    use crate::lock::Locked;
    use std::sync::Mutex;
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

    /// A toast offers no Deny: its click opens the card (ADR 0171).
    pub(super) async fn show(app: AppHandle, title: String, body: String, tag: Option<String>, _deny: bool) -> Result<(), String> {
        let posted = tokio::task::spawn_blocking(move || post(&app, &title, &body, tag)).await.map_err(|e| e.to_string())?;
        posted.map_err(|e| format!("Windows wouldn't show the notification: {}", e.message()))
    }

    fn post(app: &AppHandle, title: &str, body: &str, tag: Option<String>) -> windows::core::Result<()> {
        let xml = XmlDocument::new()?;
        xml.LoadXml(&HSTRING::from(super::toast_xml(title, body)))?;
        let toast = ToastNotification::CreateToastNotification(&xml)?;
        let clicked = app.clone();
        toast.Activated(&TypedEventHandler::new(move |_, _| {
            super::act(&clicked, super::Action::Open, None, tag.clone());
            Ok(())
        }))?;
        let id = if tauri::is_dev() { DEV_APP_ID.to_owned() } else { app.config().identifier.clone() };
        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(id))?.Show(&toast)?;
        SHOWN.locked().add(Instant::now(), toast);
        Ok(())
    }
}

#[cfg(not(any(target_os = "linux", windows)))]
mod desktop {
    pub(super) async fn show(_: tauri::AppHandle, _: String, _: String, _: Option<String>, _: bool) -> Result<(), String> {
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
    fn an_approval_offers_deny_beside_review_and_anything_else_only_the_click() {
        assert_eq!(actions(false), ["default", "Open Hermes Chat"]);
        assert_eq!(actions(true), ["default", "Open Hermes Chat", "review", "Review", "deny", "Deny"]);
        assert_eq!(invoked("default"), Some(Action::Open));
        assert_eq!(invoked("review"), Some(Action::Open));
        assert_eq!(invoked("deny"), Some(Action::Deny));
        assert_eq!(invoked("approve"), None, "no key approves");
        assert_eq!(invoked("inline-reply"), None);
        assert_eq!(serde_json::to_string(&Acted { tag: "3".into(), action: Action::Deny }).unwrap(), r#"{"tag":"3","action":"deny"}"#);
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
