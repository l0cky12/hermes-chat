//! The session bus carries requests on Linux: the running app owns `net.l0cky12.HermesChat` and answers `Screenshot`,
//! `Show`, `Toggle` and `OpenLink`. Only this user's own programs can reach their session bus.

use super::{Inbox, Request};
use dbus::blocking::Connection;
use dbus::channel::MatchingReceiver;
use dbus::message::{MatchRule, MessageType};
use std::time::Duration;

const NAME: &str = "net.l0cky12.HermesChat";
const PATH: &str = "/net/l0cky12/HermesChat";
const IFACE: &str = "net.l0cky12.HermesChat";

pub(super) fn hand_over(request: Option<Request>, inbox: &'static Inbox) -> bool {
    match (Connection::new_session(), request) {
        // Taken atomically before there is a window, so two launches at once can't both open one.
        (Ok(conn), Some(request)) => match claim(&conn) {
            Ok(true) => serve_into(conn, false, inbox),
            Ok(false) => {
                if send(&request).is_ok() {
                    return true;
                }
                eprintln!("hermes-chat: the Hermes Chat already running didn't answer, so this one starts too");
                serve_into(conn, true, inbox);
            }
            Err(e) => eprintln!("hermes-chat: couldn't ask the session bus for {NAME}: {e}"),
        },
        // An update's restart, or a development copy: start, and take the name once the other one exits.
        (Ok(conn), None) => serve_into(conn, true, inbox),
        (Err(e), _) => eprintln!("hermes-chat: no session bus, so desktop shortcuts won't reach this window: {e}"),
    }
    false
}

/// Asks the running app. An error when no Hermes Chat is running (or the bus can't be reached).
fn send(request: &Request) -> Result<(), dbus::Error> {
    send_on(&Connection::new_session()?, request)
}

fn send_on(conn: &Connection, request: &Request) -> Result<(), dbus::Error> {
    let proxy = conn.with_proxy(NAME, PATH, Duration::from_secs(5));
    match request {
        Request::Screenshot => proxy.method_call(IFACE, "Screenshot", ()),
        Request::Show { token } => proxy.method_call(IFACE, "Show", (token.clone().unwrap_or_default(),)),
        Request::Toggle { token } => proxy.method_call(IFACE, "Toggle", (token.clone().unwrap_or_default(),)),
        Request::OpenLink { link, token } => proxy.method_call(IFACE, "OpenLink", (link.as_str(), token.clone().unwrap_or_default())),
    }
}

/// Takes the bus name unless another Hermes Chat has it. The bus decides atomically, so of two apps starting at once
/// exactly one gets it, before either has a window. Whether this one did.
fn claim(conn: &Connection) -> Result<bool, dbus::Error> {
    use dbus::blocking::stdintf::org_freedesktop_dbus::RequestNameReply;
    Ok(matches!(conn.request_name(NAME, false, false, true)?, RequestNameReply::PrimaryOwner | RequestNameReply::AlreadyOwner))
}

/// Answers calls on `conn`, on a thread of its own. `queue`: the name is another Hermes Chat's, so this one waits in
/// line and takes over once that one exits, as after an update's restart (update.rs `relaunch`).
fn serve_into(conn: Connection, queue: bool, inbox: &'static Inbox) {
    std::thread::spawn(move || {
        if queue {
            use dbus::blocking::stdintf::org_freedesktop_dbus::RequestNameReply;
            match conn.request_name(NAME, false, false, false) {
                Ok(RequestNameReply::PrimaryOwner) | Ok(RequestNameReply::AlreadyOwner) => {}
                Ok(RequestNameReply::InQueue) => {
                    eprintln!("hermes-chat: another Hermes Chat is running; desktop shortcuts go to it until it closes")
                }
                Ok(_) => return eprintln!("hermes-chat: another Hermes Chat is running; desktop shortcuts go to it"),
                Err(e) => return eprintln!("hermes-chat: couldn't take {NAME}: {e}"),
            }
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
                        inbox.dispatch(Request::Screenshot);
                        msg.method_return()
                    }
                    (Some(IFACE) | None, Some(m @ ("Show" | "Toggle")), Some(PATH)) => {
                        let token = msg.read1::<&str>().ok().filter(|t| !t.is_empty()).map(str::to_owned);
                        inbox.dispatch(if m == "Show" { Request::Show { token } } else { Request::Toggle { token } });
                        msg.method_return()
                    }
                    // Anything that can't be a link is refused here, and the window reads the rest (chatLinks.ts).
                    (Some(IFACE) | None, Some("OpenLink"), Some(PATH)) => match msg.get2::<&str, &str>() {
                        (Some(link), token) if crate::links::candidate(link) => {
                            let token = token.filter(|t| !t.is_empty()).map(str::to_owned);
                            inbox.dispatch(Request::OpenLink { link: link.to_owned(), token });
                            msg.method_return()
                        }
                        _ => msg.error(&"org.freedesktop.DBus.Error.InvalidArgs".into(), &std::ffi::CString::new("That isn't a Hermes Chat link.").unwrap()),
                    },
                    (Some("org.freedesktop.DBus.Peer"), Some("Ping"), _) => msg.method_return(),
                    _ => msg.error(
                        &"org.freedesktop.DBus.Error.UnknownMethod".into(),
                        &std::ffi::CString::new("Hermes Chat only answers Screenshot, Show, Toggle and OpenLink.").unwrap(),
                    ),
                };
                use dbus::channel::Sender;
                let _ = conn.send(reply);
                true
            }),
        );
        loop {
            if let Err(e) = conn.process(Duration::from_secs(3600)) {
                return eprintln!("hermes-chat: desktop shortcuts stopped reaching this window: {e}");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lock::Locked;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Mutex;

    /// A private session bus of its own, so tests never touch the owner's.
    struct PrivateBus {
        address: String,
        daemon: std::process::Child,
        dir: std::path::PathBuf,
    }

    impl Drop for PrivateBus {
        fn drop(&mut self) {
            let _ = self.daemon.kill();
            let _ = self.daemon.wait();
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn private_bus() -> PrivateBus {
        use std::io::BufRead;
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("hermes-chat-test-bus-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = dir.join("bus.conf");
        std::fs::write(
            &config,
            format!(
                r#"<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig><type>session</type><listen>unix:dir={}</listen><auth>EXTERNAL</auth>
<policy context="default"><allow send_destination="*" eavesdrop="true"/><allow eavesdrop="true"/><allow own="*"/></policy></busconfig>"#,
                dir.display()
            ),
        )
        .unwrap();
        let mut daemon = std::process::Command::new("dbus-daemon")
            .arg(format!("--config-file={}", config.display()))
            .args(["--nofork", "--print-address=1"])
            .stdout(std::process::Stdio::piped())
            .spawn()
            .expect("dbus-daemon");
        let mut line = String::new();
        std::io::BufReader::new(daemon.stdout.take().unwrap()).read_line(&mut line).unwrap();
        PrivateBus { address: line.trim().to_owned(), daemon, dir }
    }

    fn connect(address: &str) -> Connection {
        let mut ch = dbus::channel::Channel::open_private(address).unwrap();
        ch.register().unwrap();
        Connection::from(ch)
    }

    #[test]
    fn of_apps_starting_at_once_exactly_one_owns_the_name() {
        let bus = private_bus();
        let start = std::sync::Arc::new(std::sync::Barrier::new(8));
        let launches: Vec<_> = (0..8)
            .map(|_| {
                let (address, start) = (bus.address.clone(), start.clone());
                std::thread::spawn(move || {
                    let conn = connect(&address);
                    start.wait();
                    let owner = claim(&conn).unwrap();
                    // Kept alive until every launch has asked, as a running app keeps it.
                    std::thread::sleep(Duration::from_millis(500));
                    owner
                })
            })
            .collect();
        let owners = launches.into_iter().map(|t| t.join().unwrap()).filter(|o| *o).count();
        assert_eq!(owners, 1);
    }

    #[test]
    fn a_second_launch_reaches_the_first_while_it_is_still_starting() {
        let bus = private_bus();
        let first = connect(&bus.address);
        assert!(claim(&first).unwrap());
        let inbox: &'static Inbox = Box::leak(Box::default());
        serve_into(first, false, inbox);
        // The second launch can't take the name, so it asks the first, whose window isn't set up yet.
        let second = connect(&bus.address);
        assert!(!claim(&second).unwrap());
        send_on(&second, &Request::Show { token: Some("tok".into()) }).unwrap();
        send_on(&second, &Request::Toggle { token: None }).unwrap();
        // Once it is, it gets both, in order.
        let got = std::sync::Arc::new(Mutex::new(vec![]));
        let g = got.clone();
        inbox.set_handler(move |r| g.locked().push(r));
        send_on(&second, &Request::Screenshot).unwrap();
        assert_eq!(*got.locked(), vec![Request::Show { token: Some("tok".into()) }, Request::Toggle { token: None }, Request::Screenshot]);
    }

    #[test]
    fn a_link_reaches_the_running_app_and_anything_else_is_refused_on_the_bus() {
        let bus = private_bus();
        let first = connect(&bus.address);
        assert!(claim(&first).unwrap());
        let inbox: &'static Inbox = Box::leak(Box::default());
        let got = std::sync::Arc::new(Mutex::new(vec![]));
        let g = got.clone();
        inbox.set_handler(move |r| g.locked().push(r));
        serve_into(first, false, inbox);
        let second = connect(&bus.address);
        let link = "hermes-chat://chat?v=1&connection=abcdefghijklmnopqrst&profile=work&id=c9".to_owned();
        send_on(&second, &Request::OpenLink { link: link.clone(), token: Some("tok".into()) }).unwrap();
        let proxy = second.with_proxy(NAME, PATH, Duration::from_secs(5));
        let refused: Result<(), dbus::Error> = proxy.method_call(IFACE, "OpenLink", ("https://example.com", ""));
        assert_eq!(refused.unwrap_err().name(), Some("org.freedesktop.DBus.Error.InvalidArgs"));
        let long: Result<(), dbus::Error> = proxy.method_call(IFACE, "OpenLink", (format!("hermes-chat://{}", "a".repeat(2000)), ""));
        assert!(long.is_err());
        assert_eq!(*got.locked(), vec![Request::OpenLink { link, token: Some("tok".into()) }]);
    }
}
