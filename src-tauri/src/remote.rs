//! `hermes-chat --screenshot`, for a desktop shortcut that works while another window is focused. Wayland doesn't let
//! an app listen for keys it isn't focused for, so the owner binds a key in their desktop to run that command. It
//! asks the Hermes Chat already running to take a screenshot; with none running, the app starts and takes one once it
//! is signed in. Either way the request waits in Rust until a signed-in window takes it, so one made at the sign-in
//! screen isn't lost (lib.rs, `screenshot_pending_request`).
//!
//! `hermes-chat --show` and `hermes-chat --toggle` are the same idea for the window itself (summon.rs): a key bound in
//! the desktop (a Hyprland `bind`, say, or a Windows shortcut's key) runs one, and the running app brings its one
//! window forward (or, for `--toggle`, hides it when it is already in front). With none running, the app starts. A
//! plain `hermes-chat` with one already running shows that one too, so there is only ever one Hermes Chat.
//!
//! `hermes-chat <link>` is how the desktop opens a chat link (links.rs, ADR 0037): with Hermes Chat running, the link
//! goes to it and its window comes forward; with none running, the app starts and keeps the link for its window.
//!
//! The requests travel over the session bus on Linux (remote/bus.rs) and over a named pipe of this user's on Windows
//! (remote/pipe.rs); either way only this user's own programs can send one, and a launch hands its request only to
//! this user's own Hermes Chat. A screenshot request only opens the
//! picker: nothing is captured until the owner picks, and nothing is sent until they send the message. A link only
//! shows a chat, once the window has checked it. On Wayland `Show`, `Toggle` and `OpenLink` take the activation token
//! the desktop gave the command, if any, so the compositor lets the window take focus.

#[cfg(target_os = "linux")]
mod bus;
#[cfg(target_os = "linux")]
use crate::lock::Locked;
use bus as desktop;
#[cfg(windows)]
mod pipe;
#[cfg(windows)]
use pipe as desktop;
#[cfg(not(any(target_os = "linux", windows)))]
mod desktop {
    pub(super) fn hand_over(_: Option<super::Request>, _: &'static super::Inbox) -> bool {
        false
    }
}

use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
use std::time::{Duration, Instant};

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
        let mut pending = self.pending.locked();
        *pending = Some((self.next.fetch_add(1, Ordering::Relaxed), Instant::now()));
    }

    pub fn pending(&self) -> Option<u64> {
        self.pending_at(Instant::now())
    }

    fn pending_at(&self, now: Instant) -> Option<u64> {
        let mut pending = self.pending.locked();
        if pending.is_some_and(|(_, at)| now.duration_since(at) >= Duration::from_secs(120)) {
            *pending = None;
        }
        pending.map(|(id, _)| id)
    }

    pub fn acknowledge(&self, id: u64) {
        let mut pending = self.pending.locked();
        if pending.is_some_and(|(current, _)| current == id) {
            *pending = None;
        }
    }
}

/// What the command line asks the running app for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Request {
    Screenshot,
    /// Bring the window forward. `token`: the desktop's Wayland activation token, if it gave one.
    Show {
        token: Option<String>,
    },
    /// Bring it forward, or hide it if it is already in front.
    Toggle {
        token: Option<String>,
    },
    /// Open a chat link (links.rs) and bring the window forward. Only something that could be a link gets here.
    OpenLink {
        link: String,
        token: Option<String>,
    },
}

/// Set by an update's restart (update.rs), so the new app starts even though the old one still owns the bus name.
pub const NEW_INSTANCE: &str = "HERMES_CHAT_NEW_INSTANCE";

/// The command line asks for a screenshot.
pub fn asked(args: impl IntoIterator<Item = String>) -> bool {
    args.into_iter().skip(1).any(|a| a == "--screenshot")
}

/// What to ask a running Hermes Chat for, from the command line. A plain launch asks it to show itself, unless
/// `new_instance` (an update's restart, or a developer's second copy). A chat link on the command line is always
/// passed on, as an explicit ask is.
pub fn request_of(args: impl IntoIterator<Item = String>, token: Option<String>, new_instance: bool) -> Option<Request> {
    let args: Vec<String> = args.into_iter().collect();
    let link = crate::links::from_args(args.iter().cloned());
    let args = &args[args.len().min(1)..];
    let has = |f: &str| args.iter().any(|a| a == f);
    if has("--screenshot") {
        Some(Request::Screenshot)
    } else if let Some(link) = link {
        Some(Request::OpenLink { link, token })
    } else if has("--toggle") {
        Some(Request::Toggle { token })
    } else if has("--show") || !new_instance {
        Some(Request::Show { token })
    } else {
        None
    }
}

/// Hands the command line's request to the Hermes Chat already running, or, when this one is the first, starts
/// answering requests for its window. True when the running one took it, so this process has nothing left to do.
/// `None` (an update's restart, a developer's second copy): this one starts and takes over once the other exits.
pub fn hand_over(request: Option<Request>) -> bool {
    desktop::hand_over(request, &INBOX)
}

/// The longest request a running app reads from the pipe: a link at its longest, with room for the rest.
#[cfg_attr(not(windows), allow(dead_code))]
const WIRE_MAX: usize = crate::links::MAX_LEN + 1024;

/// One request as one line on the pipe.
#[cfg_attr(not(windows), allow(dead_code))]
fn encode(request: &Request) -> String {
    serde_json::to_string(request).expect("a request is plain strings")
}

/// A request read off the pipe, held to what the bus allows: a link must be one that could be a chat link, and an
/// empty token is no token.
#[cfg_attr(not(windows), allow(dead_code))]
fn decode(line: &str) -> Result<Request, String> {
    if line.len() > WIRE_MAX {
        return Err("That request is too long.".into());
    }
    let request: Request = serde_json::from_str(line.trim_end()).map_err(|_| "Hermes Chat only answers screenshot, show, toggle and openLink.".to_owned())?;
    let token = |t: Option<String>| t.filter(|t| !t.is_empty());
    Ok(match request {
        Request::Screenshot => Request::Screenshot,
        Request::Show { token: t } => Request::Show { token: token(t) },
        Request::Toggle { token: t } => Request::Toggle { token: token(t) },
        Request::OpenLink { link, token: t } if crate::links::candidate(&link) => Request::OpenLink { link, token: token(t) },
        Request::OpenLink { .. } => return Err("That isn't a Hermes Chat link.".into()),
    })
}

/// The pipe the running app listens on: one per Windows user and sign-in session, so a request never reaches another
/// user's app, nor this user's app in another session. Pipe names allow anything but a backslash; the rest is folded
/// so the same user always gets the same name.
#[cfg_attr(not(windows), allow(dead_code))]
fn pipe_name(domain: &str, user: &str, session: &str) -> String {
    let part =
        |s: &str| -> String { s.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '.' { c.to_ascii_lowercase() } else { '_' }).collect() };
    format!(r"\\.\pipe\net.l0cky12.HermesChat-{}-{}-{}", part(domain), part(user), part(session))
}

/// What the app does with a request once it is set up.
type Handler = Box<dyn Fn(Request) + Send>;

/// Where requests go: the app's handler once it is set up, and until then a list it takes over, so a request that
/// arrives while the app starts (a second launch, a shortcut pressed early) isn't lost.
#[derive(Default)]
pub struct Inbox {
    handler: Mutex<Option<Handler>>,
    early: Mutex<Vec<Request>>,
}

impl Inbox {
    fn dispatch(&self, r: Request) {
        let handler = self.handler.locked();
        match &*handler {
            Some(f) => f(r),
            None => self.early.locked().push(r),
        }
    }

    pub fn set_handler(&self, f: impl Fn(Request) + Send + 'static) {
        let mut handler = self.handler.locked();
        for r in self.early.locked().drain(..) {
            f(r);
        }
        *handler = Some(Box::new(f));
    }
}

static INBOX: std::sync::LazyLock<Inbox> = std::sync::LazyLock::new(Inbox::default);

/// Sends requests to `f` from now on, after any that came while the app started.
pub fn set_handler(f: impl Fn(Request) + Send + 'static) {
    INBOX.set_handler(f);
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
    fn reads_what_the_command_line_asks_a_running_app_for() {
        let args = |a: &[&str]| std::iter::once("hermes-chat").chain(a.iter().copied()).map(str::to_owned).collect::<Vec<_>>();
        let tok = Some("t".to_owned());
        assert_eq!(request_of(args(&["--screenshot"]), tok.clone(), false), Some(Request::Screenshot));
        assert_eq!(request_of(args(&["--show"]), tok.clone(), false), Some(Request::Show { token: tok.clone() }));
        assert_eq!(request_of(args(&["--toggle"]), None, false), Some(Request::Toggle { token: None }));
        // A plain launch shows the running one; an update's restart starts anew.
        assert_eq!(request_of(args(&[]), None, false), Some(Request::Show { token: None }));
        assert_eq!(request_of(args(&[]), None, true), None);
        // Asked for explicitly, the running one is asked even from a restart.
        assert_eq!(request_of(args(&["--toggle"]), None, true), Some(Request::Toggle { token: None }));
        // A chat link goes to the running one, with the desktop's token, from any launch.
        let link = "hermes-chat://chat?v=1&connection=abcdefghijklmnopqrst&profile=default&id=c1".to_owned();
        let open = Some(Request::OpenLink { link: link.clone(), token: tok.clone() });
        assert_eq!(request_of(args(&[&link]), tok.clone(), false), open);
        assert_eq!(request_of(args(&[&link]), tok.clone(), true), open);
        assert_eq!(request_of(args(&["--show", &link]), tok.clone(), false), open);
        // The program's own path is never read as a link.
        assert_eq!(request_of(vec![link.clone()], None, false), Some(Request::Show { token: None }));
    }

    #[test]
    fn a_request_crosses_the_pipe_as_it_was_sent() {
        let link = "hermes-chat://chat?v=1&connection=abcdefghijklmnopqrst&profile=work&id=c9".to_owned();
        for request in [
            Request::Screenshot,
            Request::Show { token: None },
            Request::Toggle { token: Some("t".into()) },
            Request::OpenLink { link: link.clone(), token: None },
        ] {
            let line = encode(&request);
            assert!(!line.contains('\n'), "{line}");
            assert_eq!(decode(&format!("{line}\n")), Ok(request));
        }
        assert_eq!(encode(&Request::Screenshot), r#"{"kind":"screenshot"}"#);
        assert_eq!(decode(r#"{"kind":"show","token":""}"#), Ok(Request::Show { token: None }));
    }

    #[test]
    fn the_pipe_refuses_what_the_bus_refuses() {
        assert!(decode(r#"{"kind":"openLink","link":"https://example.com","token":null}"#).is_err());
        let long = format!(r#"{{"kind":"openLink","link":"hermes-chat://{}","token":null}}"#, "a".repeat(2000));
        assert!(decode(&long).is_err());
        assert!(decode(r#"{"kind":"quit"}"#).is_err());
        assert!(decode("not json").is_err());
        assert!(decode(&"x".repeat(WIRE_MAX + 1)).is_err());
    }

    #[test]
    fn each_user_and_session_has_a_pipe_of_its_own() {
        let name = pipe_name("WORKGROUP", "Liam O'Neil", "Console");
        assert_eq!(name, r"\\.\pipe\net.l0cky12.HermesChat-workgroup-liam_o_neil-console");
        assert_eq!(name, pipe_name("workgroup", "LIAM O'NEIL", "console"));
        assert_ne!(name, pipe_name("WORKGROUP", "Liam O'Neil", "RDP-Tcp#3"));
        assert_ne!(name, pipe_name("WORKGROUP", "Ann", "Console"));
        // A backslash would start a new path part; it never gets through.
        assert_eq!(pipe_name(r"A\B", "u", "s").matches('\\').count(), 4);
    }

    #[test]
    fn an_unhandled_request_expires_after_two_minutes() {
        let requests = Requests::default();
        requests.ask();
        assert_eq!(requests.pending_at(Instant::now() + Duration::from_secs(120)), None);
    }
}
