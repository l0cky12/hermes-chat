//! SSH local forward to the dashboard on the server's loopback, using the system `ssh` so the
//! owner's ~/.ssh/config, agent and keys apply (ADR 0003; research doc §9 "SSH mode").
//!
//! The local end is made as a server page's is (ADR 0114, ADR 0098): ssh forwards a Unix socket in a private folder,
//! and Rust binds `127.0.0.1:0`, keeps the listener and relays each connection to the socket. The port the sign-in
//! sends the password to is never free for another program to take while ssh signs in.

use crate::server_page::{self, LocalEnd};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::net::TcpListener;
use tokio::process::{Child, Command};

const READY_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, thiserror::Error)]
pub enum TunnelError {
    #[error("Enter an SSH target such as liam@hermes or a host alias from ~/.ssh/config.")]
    BadTarget,
    #[error("Couldn't start ssh: {0}")]
    Spawn(String),
    #[error("SSH failed: {0}")]
    Ssh(String),
    #[error("SSH didn't open the tunnel within {0}s.")]
    Timeout(u64),
}

/// A running `ssh -N -L` and the relay to it on `local_port`. Dropping it kills ssh and closes the relay.
pub struct Tunnel {
    _child: Child,
    _end: LocalEnd,
    relay: tokio::task::AbortHandle,
    pub local_port: u16,
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        self.relay.abort();
    }
}

pub async fn open(target: &str, remote_port: u16) -> Result<Tunnel, TunnelError> {
    open_within(target, remote_port, None).await
}

/// `open`, giving up sooner when `quick` is set: ssh's TCP connect after `quick`, and the whole tunnel after twice
/// that. A connection with several routes uses it, so a route that is down doesn't hold up the next (ADR 0120).
pub async fn open_within(target: &str, remote_port: u16, quick: Option<Duration>) -> Result<Tunnel, TunnelError> {
    open_through("ssh", target, remote_port, quick).await
}

/// `open_within` with `program` as ssh.
async fn open_through(program: &str, target: &str, remote_port: u16, quick: Option<Duration>) -> Result<Tunnel, TunnelError> {
    let target = target.trim();
    // A leading '-' would be read as an ssh option.
    if target.is_empty() || target.starts_with('-') || target.contains(char::is_whitespace) {
        return Err(TunnelError::BadTarget);
    }
    let end = LocalEnd::new().map_err(|e| TunnelError::Spawn(format!("{}: {e}", LocalEnd::COULDNT)))?;
    let ready_within = quick.map_or(READY_TIMEOUT, |q| q * 2);
    let connect_timeout = quick.map(|q| format!("ConnectTimeout={}", q.as_secs().max(1)));
    let mut child = background(program);
    if let Some(option) = &connect_timeout {
        child.args(["-o", option]);
    }
    let mut child = child
        .args([
            "-N",
            "-o",
            "BatchMode=yes",
            "-o",
            "ExitOnForwardFailure=yes",
            "-o",
            "ServerAliveInterval=15",
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-o",
            "StreamLocalBindMask=0177",
            "-o",
            "StreamLocalBindUnlink=yes",
            "-L",
            &format!("{}:127.0.0.1:{remote_port}", end.listen()),
            "--",
            target,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| TunnelError::Spawn(e.to_string()))?;

    let deadline = tokio::time::Instant::now() + ready_within;
    loop {
        if let Some(_status) = child.try_wait().map_err(|e| TunnelError::Spawn(e.to_string()))? {
            let mut err = String::new();
            if let Some(mut stderr) = child.stderr.take() {
                let _ = stderr.read_to_string(&mut err).await;
            }
            return Err(TunnelError::Ssh(err.trim().to_owned()));
        }
        if server_page::connect(&end.address()).await.is_ok() {
            break;
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(TunnelError::Timeout(ready_within.as_secs()));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| TunnelError::Spawn(e.to_string()))?;
    let local_port = listener.local_addr().map_err(|e| TunnelError::Spawn(e.to_string()))?.port();
    let relay = tokio::spawn(server_page::serve(listener, end.address())).abort_handle();
    Ok(Tunnel { _child: child, _end: end, relay, local_port })
}

/// Options every `ssh` this app starts gets on this platform. Windows's OpenSSH can't share connections
/// (ControlMaster needs a Unix socket), so an ~/.ssh/config written for Linux that turns sharing on would make every
/// connection fail; there each ssh opens its own connection instead.
#[cfg(windows)]
pub const PLATFORM_SSH_OPTIONS: &[&str] = &["-o", "ControlMaster=no", "-o", "ControlPath=none"];
#[cfg(not(windows))]
pub const PLATFORM_SSH_OPTIONS: &[&str] = &[];

/// `ssh` with `PLATFORM_SSH_OPTIONS`, run in the background: on Windows without a console window of its own, which
/// the app (a windowed program) would otherwise open for it.
pub fn background_ssh() -> Command {
    background("ssh")
}

fn background(program: &str) -> Command {
    let mut command = Command::new(program);
    command.args(PLATFORM_SSH_OPTIONS);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};
    use tokio::io::AsyncWriteExt;
    use tokio::net::TcpStream;

    /// A stand-in for ssh: it writes the local end it was told to listen on (`-L <listen>:<host>:<port>`) to
    /// `<dir>/listen`, takes a second to "sign in", then listens there and forwards each connection to `<host>:<port>`
    /// here. As real ssh with `ExitOnForwardFailure=yes`, it exits 255 if it can't listen.
    const FAKE_SSH: &str = r#"
import os, socket, sys, threading, time
d, args = sys.argv[1], sys.argv[2:]
listen, host, port = args[args.index("-L") + 1].rsplit(":", 2)
with open(os.path.join(d, "listen.tmp"), "w") as f:
    f.write(listen)
os.rename(os.path.join(d, "listen.tmp"), os.path.join(d, "listen"))
time.sleep(1)
if listen.startswith("/"):
    os.umask(0o177)
    srv = socket.socket(socket.AF_UNIX)
    srv.bind(listen)
else:
    h, p = listen.rsplit(":", 1)
    srv = socket.socket()
    try:
        srv.bind((h, int(p)))
    except OSError:
        sys.stderr.write(f"bind [{h}]:{p}: Address already in use\nCould not request local forwarding.\n")
        sys.exit(255)
srv.listen(16)
def pump(a, b):
    try:
        while True:
            data = a.recv(65536)
            if not data:
                break
            b.sendall(data)
    except OSError:
        pass
    for s in (a, b):
        try:
            s.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
def handle(c):
    r = socket.create_connection((host, int(port)))
    threading.Thread(target=pump, args=(c, r), daemon=True).start()
    pump(r, c)
while True:
    c, _ = srv.accept()
    threading.Thread(target=handle, args=(c,), daemon=True).start()
"#;

    struct FakeSsh {
        dir: PathBuf,
        program: String,
    }

    impl FakeSsh {
        fn new(name: &str) -> FakeSsh {
            let dir = std::env::temp_dir().join(format!("hermes-chat-fake-tunnel-ssh-{}-{name}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("fake.py"), FAKE_SSH).unwrap();
            let program = dir.join("ssh");
            crate::test_common::write_executable(&program, &format!("#!/bin/sh\nexec python3 {}/fake.py {} \"$@\"\n", dir.display(), dir.display()));
            FakeSsh { program: program.to_str().unwrap().to_owned(), dir }
        }

        async fn listen(&self) -> String {
            for _ in 0..200 {
                if let Ok(listen) = std::fs::read_to_string(self.dir.join("listen")) {
                    return listen;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            panic!("the fake ssh never started");
        }
    }

    impl Drop for FakeSsh {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// One HTTP request off `s`: its head and a `Content-Length` body.
    async fn read_request(s: &mut TcpStream) -> String {
        let mut got = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            let text = String::from_utf8_lossy(&got).into_owned();
            if let Some(head_end) = text.find("\r\n\r\n") {
                let length = text[..head_end].lines().find_map(|l| l.strip_prefix("Content-Length: ")).map_or(0, |n| n.trim().parse().unwrap());
                if got.len() >= head_end + 4 + length {
                    return text;
                }
            }
            match s.read(&mut buf).await {
                Ok(0) | Err(_) => return String::from_utf8_lossy(&got).into_owned(),
                Ok(n) => got.extend_from_slice(&buf[..n]),
            }
        }
    }

    /// A Hermes-shaped HTTP server on `listener` that writes down every request it gets.
    fn serve_http(listener: TcpListener) -> Arc<Mutex<Vec<String>>> {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let kept = seen.clone();
        tokio::spawn(async move {
            while let Ok((mut s, _)) = listener.accept().await {
                let kept = kept.clone();
                tokio::spawn(async move {
                    let request = read_request(&mut s).await;
                    kept.lock().unwrap().push(request);
                    let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}").await;
                });
            }
        });
        seen
    }

    /// Sends a request to `127.0.0.1:<port>` from another program of this account, as a page in the Preview does from
    /// WebKit's network process, and prints whatever comes back.
    const OTHER_PROGRAM: &str = r#"
import socket, sys
try:
    s = socket.create_connection(("127.0.0.1", int(sys.argv[1])), timeout=5)
    s.sendall(b"GET /api/status HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
    got = b""
    while True:
        data = s.recv(65536)
        if not data:
            break
        got += data
    sys.stdout.write(got.decode("latin-1"))
except OSError:
    pass
"#;

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn only_this_app_reaches_the_dashboard_through_the_tunnel_not_another_program_of_the_owners() {
        let dashboard = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let dashboard_port = dashboard.local_addr().unwrap().port();
        let seen = serve_http(dashboard);
        let ssh = FakeSsh::new("only-this-app");
        let tunnel = open_through(&ssh.program, "me@hermes", dashboard_port, None).await.expect("the tunnel opens");

        let other = tokio::process::Command::new("python3").args(["-c", OTHER_PROGRAM, &tunnel.local_port.to_string()]).output().await.expect("python3");
        assert_eq!(String::from_utf8_lossy(&other.stdout), "", "another program of the owner's got an answer");
        let requests = || seen.lock().unwrap().iter().filter(|r| r.starts_with("GET /api/status")).count();
        assert_eq!(requests(), 0, "another program's request reached the dashboard");

        let mut s = TcpStream::connect(("127.0.0.1", tunnel.local_port)).await.unwrap();
        s.write_all(b"GET /api/status HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").await.unwrap();
        let mut answer = String::new();
        tokio::time::timeout(Duration::from_secs(5), s.read_to_string(&mut answer)).await.expect("an answer").unwrap();
        assert!(answer.starts_with("HTTP/1.1 200 OK"), "this app's own request is relayed: {answer:?}");
        assert_eq!(requests(), 1);
    }

    #[tokio::test]
    async fn a_program_that_takes_the_tunnels_port_first_never_gets_the_password() {
        let dashboard = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let dashboard_port = dashboard.local_addr().unwrap().port();
        let dashboard = serve_http(dashboard);
        let ssh = FakeSsh::new("port-race");

        let opening = tokio::spawn({
            let program = ssh.program.clone();
            async move { open_through(&program, "me@hermes", dashboard_port, None).await }
        });
        // Another program on this computer watches for the tunnel's local end and takes it while ssh signs in.
        let listen = ssh.listen().await;
        let mut thief = None;
        if let Some(port) = listen.strip_prefix("127.0.0.1:") {
            thief = Some(serve_http(TcpListener::bind(("127.0.0.1", port.parse::<u16>().unwrap())).await.unwrap()));
        }
        let tunnel = opening.await.unwrap().expect("the tunnel opens");

        let password = "correct-horse-battery-staple";
        let body = format!(r#"{{"username":"liam","password":"{password}"}}"#);
        let mut s = TcpStream::connect(("127.0.0.1", tunnel.local_port)).await.unwrap();
        s.write_all(
            format!("POST /api/auth/password-login HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
                .as_bytes(),
        )
        .await
        .unwrap();
        let mut answer = String::new();
        tokio::time::timeout(Duration::from_secs(5), s.read_to_string(&mut answer)).await.expect("an answer").unwrap();

        let stolen: Vec<String> = thief.map(|t| t.lock().unwrap().clone()).unwrap_or_default();
        assert!(stolen.iter().all(|r| !r.contains(password)), "the password went to the program that took the port: {stolen:?}");
        assert!(dashboard.lock().unwrap().iter().any(|r| r.contains(password)), "the sign-in reached the dashboard through ssh");
        assert!(TcpListener::bind(("127.0.0.1", tunnel.local_port)).await.is_err(), "the tunnel's port is held, so no other program can listen on it");
    }
}
