//! `hermes-chat --screenshot`, for a desktop shortcut that works while another window is focused. Wayland doesn't let
//! an app listen for keys it isn't focused for, so the owner binds a key in their desktop to run that command. It
//! asks the Hermes Chat already running, over the session bus, to take a screenshot; with none running, the app starts
//! and takes one once it is signed in. Either way the request waits in Rust until a signed-in window takes it, so one
//! made at the sign-in screen isn't lost (lib.rs, `screenshot_pending_request`).
//!
//! The running app owns the bus name `net.l0cky12.HermesChat` and answers one method, `Screenshot`. Only this user's
//! own programs can reach their session bus, and a request only opens the picker: nothing is captured until the owner
//! picks, and nothing is sent until they send the message.

use dbus::blocking::Connection;
use dbus::channel::MatchingReceiver;
use dbus::message::{MatchRule, MessageType};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
use std::time::{Duration, Instant};

pub const NAME: &str = "net.l0cky12.HermesChat";
const PATH: &str = "/net/l0cky12/HermesChat";
const IFACE: &str = "net.l0cky12.HermesChat";
/// The event that tells the webview a desktop shortcut asked for a screenshot.
pub const EVENT: &str = "screenshot-requested";

/// A desktop request stays pending until a live signed-in window has started handling it.
/// IDs let an acknowledgement leave a newer request alone; peeking never consumes a request.
#[derive(Default)]
pub struct Requests {
    next: AtomicU64,
    pending: Mutex<Option<(u64, Instant)>>,
}

impl Requests {
    pub fn ask(&self) {
        let mut pending = self.pending.lock().unwrap();
        *pending = Some((self.next.fetch_add(1, Ordering::Relaxed), Instant::now()));
    }

    pub fn pending(&self) -> Option<u64> {
        self.pending_at(Instant::now())
    }

    fn pending_at(&self, now: Instant) -> Option<u64> {
        let mut pending = self.pending.lock().unwrap();
        if pending.is_some_and(|(_, at)| now.duration_since(at) >= Duration::from_secs(120)) {
            *pending = None;
        }
        pending.map(|(id, _)| id)
    }

    pub fn acknowledge(&self, id: u64) {
        let mut pending = self.pending.lock().unwrap();
        if pending.is_some_and(|(current, _)| current == id) {
            *pending = None;
        }
    }
}

/// The command line asks for a screenshot.
pub fn asked(args: impl IntoIterator<Item = String>) -> bool {
    args.into_iter().skip(1).any(|a| a == "--screenshot")
}

/// Asks the running app for a screenshot. An error when no Hermes Chat is running (or the bus can't be reached).
pub fn forward() -> Result<(), dbus::Error> {
    let conn = Connection::new_session()?;
    conn.with_proxy(NAME, PATH, Duration::from_secs(5))
        .method_call(IFACE, "Screenshot", ())
}

/// Takes the bus name and answers `Screenshot` calls with `asked`, on a thread of its own. If another Hermes Chat
/// already has the name, the desktop shortcut goes to that one, and this one takes over once it exits.
pub fn serve(asked: impl Fn() + Send + 'static) {
    std::thread::spawn(move || {
        let conn = match Connection::new_session() {
            Ok(c) => c,
            Err(e) => return eprintln!("hermes-chat: no session bus, so the desktop screenshot shortcut won't reach this window: {e}"),
        };
        use dbus::blocking::stdintf::org_freedesktop_dbus::RequestNameReply;
        // Queued behind another Hermes Chat, rather than giving up: the bus hands this one the name once that one
        // exits, as the one an update's restart replaces does just after starting this one (update.rs `relaunch`).
        match conn.request_name(NAME, false, false, false) {
            Ok(RequestNameReply::PrimaryOwner) | Ok(RequestNameReply::AlreadyOwner) => {}
            Ok(RequestNameReply::InQueue) => {
                eprintln!("hermes-chat: another Hermes Chat is running; the desktop screenshot shortcut goes to it until it closes")
            }
            Ok(_) => return eprintln!("hermes-chat: another Hermes Chat is running; the desktop screenshot shortcut goes to it"),
            Err(e) => return eprintln!("hermes-chat: couldn't take {NAME}: {e}"),
        }
        conn.start_receive(
            MatchRule::new_method_call(),
            Box::new(move |msg, conn| {
                if msg.msg_type() != MessageType::MethodCall {
                    return true;
                }
                let iface = msg.interface().map(|i| i.to_string());
                let member = msg.member().map(|m| m.to_string());
                let path = msg.path().map(|p| p.to_string());
                let reply = match (iface.as_deref(), member.as_deref(), path.as_deref()) {
                    (Some(IFACE) | None, Some("Screenshot"), Some(PATH)) => {
                        asked();
                        msg.method_return()
                    }
                    (Some("org.freedesktop.DBus.Peer"), Some("Ping"), _) => msg.method_return(),
                    _ => msg.error(
                        &"org.freedesktop.DBus.Error.UnknownMethod".into(),
                        &std::ffi::CString::new("Hermes Chat only answers Screenshot.").unwrap(),
                    ),
                };
                use dbus::channel::Sender;
                let _ = conn.send(reply);
                true
            }),
        );
        loop {
            if let Err(e) = conn.process(Duration::from_secs(3600)) {
                return eprintln!(
                    "hermes-chat: the desktop screenshot shortcut stopped listening: {e}"
                );
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn peeking_preserves_a_request_until_a_live_window_acknowledges_it() {
        let requests = Requests::default();
        requests.ask();
        let first = requests.pending().unwrap();
        assert_eq!(requests.pending(), Some(first));
        requests.ask();
        let second = requests.pending().unwrap();
        assert_ne!(first, second);
        requests.acknowledge(first);
        assert_eq!(requests.pending(), Some(second));
        requests.acknowledge(second);
        assert_eq!(requests.pending(), None);
    }

    #[test]
    fn an_unhandled_request_expires_after_two_minutes() {
        let requests = Requests::default();
        requests.ask();
        assert_eq!(
            requests.pending_at(Instant::now() + Duration::from_secs(120)),
            None
        );
    }
}
