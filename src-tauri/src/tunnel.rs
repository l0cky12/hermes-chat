//! SSH local forward to the dashboard on the server's loopback, using the system `ssh` so the
//! owner's ~/.ssh/config, agent and keys apply (ADR 0003; research doc §9 "SSH mode").
//!
//! The local end is made as a server page's is (ADR 0114, ADR 0098): ssh forwards a Unix socket in a private folder,
//! and Rust binds `127.0.0.1:0`, keeps the listener and relays each connection to the socket. The port the sign-in
//! sends the password to is never free for another program to take while ssh signs in. Only Rust uses that port, so
//! the relay serves this process alone: a page in the Preview, loaded by WebKit's own process, can't (ADR 0138). On
//! Windows, where ssh can't listen on a Unix socket, ssh listens on nothing: each connection is an `ssh -W` of its own
//! (#506).

use crate::loopback_peer::Peers;
use crate::server_page::{self, Address};
#[cfg(unix)]
use crate::server_page::{LocalEnd, Ssh, Stderr};
use std::ffi::OsString;
#[cfg(unix)]
use std::process::Stdio;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::process::Command;

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

/// The relay on `local_port` and what it reaches the dashboard through. Dropping it closes the relay and ends ssh.
pub struct Tunnel {
    _forward: Forward,
    relay: tokio::task::AbortHandle,
    pub local_port: u16,
}

/// What a tunnel keeps running between connections: on Linux `ssh -N -L` and its socket's folder, on Windows nothing.
#[cfg(unix)]
type Forward = (Ssh, LocalEnd);
#[cfg(windows)]
type Forward = ();

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
    let ready_within = quick.map_or(READY_TIMEOUT, |q| q * 2);
    let mut options: Vec<OsString> = Vec::new();
    if let Some(q) = quick {
        options.extend(["-o".into(), format!("ConnectTimeout={}", q.as_secs().max(1)).into()]);
    }
    options.extend(OPTIONS.iter().map(OsString::from));
    let (forward, address) = reach(program, options, &format!("127.0.0.1:{remote_port}"), target, ready_within).await?;
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| TunnelError::Spawn(e.to_string()))?;
    let local_port = listener.local_addr().map_err(|e| TunnelError::Spawn(e.to_string()))?.port();
    let relay = tokio::spawn(server_page::serve(listener, address, Peers::ThisProcess)).abort_handle();
    Ok(Tunnel { _forward: forward, relay, local_port })
}

const OPTIONS: &[&str] = &[
    "-o",
    "BatchMode=yes",
    // Else the owner's ControlPath joins their shared connection, whose ControlPersist keeps the forward after this ssh.
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    // Nor fork to the background, leaving this process to exit and the forward running.
    "-o",
    "ForkAfterAuthentication=no",
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
];

/// Starts `program` with `options` and `-N -L <socket>:<far_end> -- <target>`, and waits until its socket accepts.
#[cfg(unix)]
async fn reach(program: &str, options: Vec<OsString>, far_end: &str, target: &str, within: Duration) -> Result<(Forward, Address), TunnelError> {
    let end = LocalEnd::new().map_err(|e| TunnelError::Spawn(format!("{}: {e}", LocalEnd::COULDNT)))?;
    let mut command = background(program);
    let mut child = Ssh::start(
        command
            .args(options)
            .args(["-N", "-L", &format!("{}:{far_end}", end.listen()), "--", target])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped()),
    )
    .map_err(|e| TunnelError::Spawn(e.to_string()))?;

    let address = end.address();
    let stderr = Stderr::default();
    let drained = child.stderr.take().map(|e| stderr.drain(e));
    let deadline = tokio::time::Instant::now() + within;
    loop {
        if child.try_wait().map_err(|e| TunnelError::Spawn(e.to_string()))?.is_some() {
            if let Some(drained) = drained {
                let _ = tokio::time::timeout(Duration::from_secs(1), drained).await;
            }
            return Err(TunnelError::Ssh(stderr.text()));
        }
        if server_page::connect(&address).await.is_ok() {
            return Ok(((child, end), address));
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(TunnelError::Timeout(within.as_secs()));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Each connection runs `program` with `options` and `-W <far_end> -- <target>`. One such connection, asking `HEAD /`,
/// waits until the dashboard answers through it, so a sign-in that fails says what ssh said.
#[cfg(windows)]
async fn reach(program: &str, options: Vec<OsString>, far_end: &str, target: &str, within: Duration) -> Result<(Forward, Address), TunnelError> {
    let address = Address::new(program, options, far_end, target);
    let mut probe = server_page::connect(&address).await.map_err(|e| TunnelError::Spawn(e.to_string()))?;
    match server_page::first_byte(&mut probe, b"HEAD / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n", within).await {
        server_page::Reply::Came => Ok(((), address)),
        server_page::Reply::Closed => Err(TunnelError::Ssh(match probe.refusal().await {
            server_page::Refusal::Ssh(said) => said,
            server_page::Refusal::NothingAnswered(said) => said.unwrap_or_else(|| "The dashboard closed the connection without answering.".into()),
        })),
        server_page::Reply::Silent => Err(TunnelError::Timeout(within.as_secs())),
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lock::Locked;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    /// A stand-in for ssh: it takes a second to "sign in", then listens where it was told to (`-L <listen>:<host>:<port>`)
    /// and forwards each connection to `<host>:<port>` here. As real ssh with `ExitOnForwardFailure=yes`, it exits 255
    /// if it can't listen.
    #[cfg(unix)]
    const FAKE_SSH: &str = r#"
import os, socket, sys, threading, time
d, args = sys.argv[1], sys.argv[2:]
with open(os.path.join(d, "args"), "w") as f:
    f.write("\n".join(args))
chatty = os.path.exists(os.path.join(d, "chatty"))
listen, host, port = args[args.index("-L") + 1].rsplit(":", 2)
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
    if chatty:
        sys.stderr.write("debug1: channel 3: new [direct-streamlocal@openssh.com]\n" * 2400)
        sys.stderr.flush()
    r = socket.create_connection((host, int(port)))
    threading.Thread(target=pump, args=(c, r), daemon=True).start()
    pump(r, c)
while True:
    c, _ = srv.accept()
    threading.Thread(target=handle, args=(c,), daemon=True).start()
"#;

    /// The Windows stand-in for ssh, with no Python. Each run adds its process id to `pids` beside itself. With
    /// `-W <host>:<port>` it connects there and copies its stdin and stdout to and from the connection, or exits 255 as
    /// ssh does when the server refuses the forward. With `-L <listen>:<host>:<port>` it waits a second, then listens
    /// and forwards each connection, or exits 255 as ssh does when the port is taken. Named `ssh-shim.exe`, it runs
    /// `ssh.exe` beside it as its child instead, as a Scoop shim does. It exits after a minute, so a copy a test left
    /// running doesn't outlive the test run.
    #[cfg(windows)]
    const FAKE_SSH_RS: &str = r#"
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::{env, fs, process, thread, time::Duration};

fn pump(mut a: TcpStream, mut b: TcpStream) {
    let _ = std::io::copy(&mut a, &mut b);
    let _ = b.shutdown(Shutdown::Write);
}

fn stdio(remote: &str) -> ! {
    let Ok(mut down) = TcpStream::connect(remote) else {
        eprintln!("channel 0: open failed: connect failed: Connection refused\nstdio forwarding failed");
        process::exit(255);
    };
    let mut up = down.try_clone().unwrap();
    thread::spawn(move || {
        let _ = std::io::copy(&mut std::io::stdin(), &mut up);
        let _ = up.shutdown(Shutdown::Write);
    });
    let mut out = std::io::stdout().lock();
    let mut buf = [0u8; 65536];
    while let Ok(n @ 1..) = down.read(&mut buf) {
        if out.write_all(&buf[..n]).and_then(|_| out.flush()).is_err() {
            break;
        }
    }
    process::exit(0);
}

fn main() {
    thread::spawn(|| {
        thread::sleep(Duration::from_secs(60));
        process::exit(0);
    });
    let exe = env::current_exe().unwrap();
    let dir = exe.parent().unwrap().to_owned();
    let args: Vec<String> = env::args().skip(1).collect();
    if exe.file_stem().unwrap() == "ssh-shim" {
        let status = process::Command::new(dir.join("ssh.exe")).args(&args).status().unwrap();
        process::exit(status.code().unwrap_or(1));
    }
    let mut pids = fs::OpenOptions::new().create(true).append(true).open(dir.join("pids")).unwrap();
    writeln!(pids, "{}", process::id()).unwrap();
    drop(pids);
    if let Some(i) = args.iter().position(|a| a == "-W") {
        stdio(&args[i + 1]);
    }
    let spec = &args[args.iter().position(|a| a == "-L").unwrap() + 1];
    let mut parts = spec.rsplitn(3, ':');
    let (port, host, listen) = (parts.next().unwrap(), parts.next().unwrap(), parts.next().unwrap().to_owned());
    let remote = format!("{host}:{port}");
    thread::sleep(Duration::from_secs(1));
    let srv = match TcpListener::bind(&listen) {
        Ok(srv) => srv,
        Err(e) => {
            eprintln!("bind [{listen}]: {e}\nCould not request local forwarding.");
            process::exit(255);
        }
    };
    for c in srv.incoming() {
        let Ok(c) = c else { continue };
        let remote = remote.clone();
        thread::spawn(move || {
            let r = TcpStream::connect(remote).unwrap();
            let (c2, r2) = (c.try_clone().unwrap(), r.try_clone().unwrap());
            thread::spawn(move || pump(c2, r2));
            pump(r, c);
        });
    }
}
"#;

    struct FakeSsh {
        dir: PathBuf,
        program: String,
    }

    impl FakeSsh {
        #[cfg(unix)]
        fn new(name: &str) -> FakeSsh {
            let dir = std::env::temp_dir().join(format!("hermes-chat-fake-tunnel-ssh-{}-{name}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("fake.py"), FAKE_SSH).unwrap();
            let program = dir.join("ssh");
            crate::test_common::write_executable(&program, &format!("#!/bin/sh\nexec python3 {}/fake.py {} \"$@\"\n", dir.display(), dir.display()));
            FakeSsh { program: program.to_str().unwrap().to_owned(), dir }
        }

        /// Windows: `FAKE_SSH_RS` built with rustc (once per test run) and copied to `<dir>/ssh.exe`.
        #[cfg(windows)]
        fn new(name: &str) -> FakeSsh {
            static BUILT: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
            let built = BUILT.get_or_init(|| {
                let dir = std::env::temp_dir().join(format!("hermes-chat-fake-tunnel-ssh-{}-build", std::process::id()));
                std::fs::create_dir_all(&dir).unwrap();
                std::fs::write(dir.join("fake.rs"), FAKE_SSH_RS).unwrap();
                let exe = dir.join("ssh.exe");
                let built = std::process::Command::new("rustc").args(["--edition", "2021", "-o"]).arg(&exe).arg(dir.join("fake.rs")).status().unwrap();
                assert!(built.success(), "rustc built the fake ssh");
                exe
            });
            let dir = std::env::temp_dir().join(format!("hermes-chat-fake-tunnel-ssh-{}-{name}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let program = dir.join("ssh.exe");
            std::fs::copy(built, &program).unwrap();
            FakeSsh { program: program.to_str().unwrap().to_owned(), dir }
        }

        /// The same fake, started through `<dir>/ssh-shim.exe`, which runs `<dir>/ssh.exe` as its child.
        #[cfg(windows)]
        fn through_shim(mut self) -> FakeSsh {
            let shim = self.dir.join("ssh-shim.exe");
            std::fs::copy(&self.program, &shim).unwrap();
            self.program = shim.to_str().unwrap().to_owned();
            self
        }

        /// From now on it prints 128 KiB to stderr for each connection before forwarding it.
        #[cfg(unix)]
        fn chatty(self) -> FakeSsh {
            std::fs::write(self.dir.join("chatty"), "").unwrap();
            self
        }

        #[cfg(unix)]
        fn args(&self) -> Vec<String> {
            std::fs::read_to_string(self.dir.join("args")).unwrap().lines().map(str::to_owned).collect()
        }

        /// The ids of the fake's runs that are still running.
        #[cfg(windows)]
        fn running(&self) -> Vec<u32> {
            let pids = std::fs::read_to_string(self.dir.join("pids")).unwrap_or_default();
            let out = std::process::Command::new("tasklist").args(["/NH", "/FO", "CSV"]).output().unwrap();
            let tasks = String::from_utf8_lossy(&out.stdout).into_owned();
            pids.lines().filter_map(|p| p.trim().parse().ok()).filter(|p| tasks.contains(&format!("\"{p}\""))).collect()
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
                    kept.locked().push(request);
                    let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}").await;
                });
            }
        });
        seen
    }

    /// Sends a request to `127.0.0.1:<port>` from another program of this account, as a page in the Preview does from
    /// WebKit's network process, and prints whatever comes back.
    #[cfg(target_os = "linux")]
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
        let requests = || seen.locked().iter().filter(|r| r.starts_with("GET /api/status")).count();
        assert_eq!(requests(), 0, "another program's request reached the dashboard");

        let mut s = TcpStream::connect(("127.0.0.1", tunnel.local_port)).await.unwrap();
        s.write_all(b"GET /api/status HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").await.unwrap();
        let mut answer = String::new();
        tokio::time::timeout(Duration::from_secs(5), s.read_to_string(&mut answer)).await.expect("an answer").unwrap();
        assert!(answer.starts_with("HTTP/1.1 200 OK"), "this app's own request is relayed: {answer:?}");
        assert_eq!(requests(), 1);
    }

    const PASSWORD: &str = "correct-horse-battery-staple";

    /// What a sign-in through a new tunnel did.
    struct SignIn {
        opened: Result<Tunnel, TunnelError>,
        dashboard: Vec<String>,
    }

    /// Opens a tunnel to a Hermes-shaped dashboard through `ssh` and, if it opens, posts the password through it.
    async fn sign_in(ssh: &FakeSsh) -> SignIn {
        let dashboard = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let dashboard_port = dashboard.local_addr().unwrap().port();
        let dashboard = serve_http(dashboard);
        let opened = open_through(&ssh.program, "me@hermes", dashboard_port, None).await;
        if let Ok(tunnel) = &opened {
            post_password(tunnel.local_port).await;
        }
        let dashboard = dashboard.locked().clone();
        SignIn { opened, dashboard }
    }

    async fn post_password(port: u16) {
        let body = format!(r#"{{"username":"liam","password":"{PASSWORD}"}}"#);
        let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        s.write_all(
            format!("POST /api/auth/password-login HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
                .as_bytes(),
        )
        .await
        .unwrap();
        let mut answer = String::new();
        let _ = tokio::time::timeout(Duration::from_secs(5), s.read_to_string(&mut answer)).await;
    }

    #[tokio::test]
    async fn the_sign_in_reaches_the_dashboard_through_ssh() {
        let ssh = FakeSsh::new("plain");
        let signed = sign_in(&ssh).await;
        let tunnel = signed.opened.expect("the tunnel opens");
        assert!(signed.dashboard.iter().any(|r| r.contains(PASSWORD)), "the sign-in reached the dashboard through ssh");
        assert!(TcpListener::bind(("127.0.0.1", tunnel.local_port)).await.is_err(), "the tunnel's port is held, so no other program can listen on it");
    }

    /// ssh's stderr is a pipe of 64 KiB on Linux. Unread, a chatty ssh fills it and stops forwarding (#479).
    #[cfg(unix)]
    #[tokio::test]
    async fn a_chatty_ssh_keeps_forwarding() {
        let ssh = FakeSsh::new("chatty").chatty();
        let signed = sign_in(&ssh).await;
        signed.opened.expect("the tunnel opens");
        assert!(signed.dashboard.iter().any(|r| r.contains(PASSWORD)), "the sign-in reached the dashboard through a chatty ssh");
    }

    /// The first value ssh reads for an option wins, so options on the command line come before the owner's config.
    #[cfg(unix)]
    #[tokio::test]
    async fn the_tunnels_ssh_takes_no_owner_option_that_would_outlive_it() {
        let ssh = FakeSsh::new("control-master");
        let signed = sign_in(&ssh).await;
        signed.opened.expect("the tunnel opens");
        let args = ssh.args();
        let target = args.iter().position(|a| *a == "--").expect("the target comes after --");
        for option in ["ControlMaster=no", "ControlPath=none", "ForkAfterAuthentication=no"] {
            assert!(args[..target].windows(2).any(|w| w[0] == "-o" && w[1] == option), "ssh got -o {option}: {args:?}");
        }
    }

    #[cfg(target_os = "linux")]
    fn running_with(needle: &str) -> Vec<String> {
        let Ok(procs) = std::fs::read_dir("/proc") else { return Vec::new() };
        procs
            .filter_map(|p| std::fs::read(p.ok()?.path().join("cmdline")).ok())
            .map(|c| String::from_utf8_lossy(&c).replace('\0', " "))
            .filter(|c| c.contains(needle))
            .collect()
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    #[ignore = "needs a real ssh (HERMES_TEST_SSH, a wrapper adding -F <config> is fine) and a host it signs in to without a prompt (HERMES_TEST_SSH_TARGET); its config may turn on ControlMaster auto and ControlPersist"]
    async fn through_a_real_ssh_the_sign_in_works_and_nothing_outlives_the_tunnel() {
        let ssh = std::env::var("HERMES_TEST_SSH").expect("HERMES_TEST_SSH");
        let target = std::env::var("HERMES_TEST_SSH_TARGET").expect("HERMES_TEST_SSH_TARGET");
        let dashboard = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let dashboard_port = dashboard.local_addr().unwrap().port();
        let dashboard = serve_http(dashboard);

        let tunnel = open_through(&ssh, &target, dashboard_port, None).await.expect("the tunnel opens");
        post_password(tunnel.local_port).await;
        assert!(dashboard.locked().iter().any(|r| r.contains(PASSWORD)), "the sign-in reached the dashboard through ssh");

        let forward = tunnel._forward.1.listen();
        assert!(!running_with(&forward).is_empty(), "the tunnel's ssh is found by its forward");
        drop(tunnel);
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !running_with(&forward).is_empty() && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let left = running_with(&forward);
        assert!(left.is_empty(), "ssh still holds the closed tunnel's forward: {left:?}");
    }

    /// A connection through `tunnel` that stays open: a request whose head never ends.
    #[cfg(windows)]
    async fn held(tunnel: &Tunnel) -> TcpStream {
        let mut s = TcpStream::connect(("127.0.0.1", tunnel.local_port)).await.unwrap();
        s.write_all(b"GET /api/status HTTP/1.1\r\n").await.unwrap();
        s
    }

    #[cfg(windows)]
    async fn until(what: &str, mut f: impl FnMut() -> bool) {
        for _ in 0..100 {
            if f() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("{what}");
    }

    /// No other account can connect to anything ssh listens on, because it listens on nothing (#506): each
    /// connection is an ssh of its own.
    #[cfg(windows)]
    #[tokio::test]
    async fn on_windows_the_tunnels_ssh_listens_on_nothing() {
        let ssh = FakeSsh::new("listens-on-nothing");
        let signed = sign_in(&ssh).await;
        let tunnel = signed.opened.expect("the tunnel opens");
        assert!(signed.dashboard.iter().any(|r| r.contains(PASSWORD)), "the sign-in reached the dashboard through ssh");
        let _held = held(&tunnel).await;
        until("an ssh carries the held connection", || !ssh.running().is_empty()).await;

        let running = ssh.running();
        let out = std::process::Command::new("netstat").args(["-ano"]).output().unwrap();
        let listening: Vec<String> = String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter(|l| l.contains("LISTENING") && running.iter().any(|p| l.split_whitespace().last() == Some(&p.to_string())))
            .map(str::to_owned)
            .collect();
        assert!(listening.is_empty(), "ssh listens: {listening:?}");
    }

    /// Scoop and Chocolatey put a shim named ssh.exe on PATH that runs the real ssh.exe as its child.
    #[cfg(windows)]
    #[tokio::test]
    async fn the_sign_in_reaches_the_dashboard_through_an_ssh_a_shim_starts_and_both_end_with_the_tunnel() {
        let ssh = FakeSsh::new("shim").through_shim();
        let signed = sign_in(&ssh).await;
        let tunnel = signed.opened.expect("the tunnel opens");
        assert!(signed.dashboard.iter().any(|r| r.contains(PASSWORD)), "the sign-in reached the dashboard through ssh");

        let _held = held(&tunnel).await;
        until("the real ssh behind the shim runs while a connection is open", || !ssh.running().is_empty()).await;
        drop(tunnel);
        until("the real ssh behind the shim ends with the tunnel", || ssh.running().is_empty()).await;
    }
}
