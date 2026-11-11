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
