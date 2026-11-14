//! Helpers shared by the integration tests and, through `#[path]` in `lib.rs`, the unit tests.
#![allow(dead_code, reason = "each test crate uses only some of these")]

use std::net::SocketAddr;

/// Writes `text` to `path` as an executable that can be run straight away (issue #331).
///
/// A file this process writes may not be: another test thread can fork while the write handle is open, the child keeps
/// that handle until it execs, and running the file meanwhile fails with "Text file busy". Close-on-exec and renaming
/// don't help. A child shell writes the file instead, so this process never holds a handle to it.
#[cfg(unix)]
pub fn write_executable(path: &std::path::Path, text: &str) {
    let status = std::process::Command::new("sh").args(["-c", r#"printf %s "$1" > "$2" && chmod 755 "$2""#, "sh", text]).arg(path).status().unwrap();
    assert!(status.success(), "couldn't write {}", path.display());
}

/// A loopback address that refuses connections for as long as this lives (issue #393).
///
/// Its socket holds the port without listening, so a connect is refused. A port freed by dropping a listener can be
/// taken by another test's server before the connect. This one can't: the socket doesn't set `SO_REUSEADDR`, so
/// nothing else can bind the port while it is held.
pub struct Refusing {
    _held: tokio::net::TcpSocket,
    pub addr: SocketAddr,
}

pub fn refusing() -> Refusing {
    let held = tokio::net::TcpSocket::new_v4().unwrap();
    held.bind(([127, 0, 0, 1], 0).into()).unwrap();
    Refusing { addr: held.local_addr().unwrap(), _held: held }
}

/// A private session bus of its own, so tests never touch the owner's.
#[cfg(target_os = "linux")]
pub struct PrivateBus {
    pub address: String,
    daemon: std::process::Child,
    dir: std::path::PathBuf,
}

#[cfg(target_os = "linux")]
impl Drop for PrivateBus {
    fn drop(&mut self) {
        let _ = self.daemon.kill();
        let _ = self.daemon.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[cfg(target_os = "linux")]
pub fn private_bus() -> PrivateBus {
    use std::io::BufRead;
    use std::sync::atomic::{AtomicU64, Ordering};
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

/// A connection to the private bus at `address`, registered with it.
#[cfg(target_os = "linux")]
pub fn connect(address: &str) -> dbus::blocking::Connection {
    let mut ch = dbus::channel::Channel::open_private(address).unwrap();
    ch.register().unwrap();
    dbus::blocking::Connection::from(ch)
}
