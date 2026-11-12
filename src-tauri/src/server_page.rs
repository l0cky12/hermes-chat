//! Pages on the Hermes server's own loopback in the Preview (ADR 0114): `http://localhost:3000` in a reply means the
//! server's port 3000, where Hermes ran the dev server, not this computer's.
//!
//! Each page gets a tunnel of its own, made of two parts:
//!
//! - The owner's `ssh` to the signed-in connection's SSH target, forwarding a Unix socket in a private folder (0700) to
//!   the page's loopback host and port on the server: `ssh -N -L <socket>:<host>:<port> -- <target>`. Every argument is
//!   one `Command` argument: the host is one of three fixed strings, the port a number, the socket a path this module
//!   made, and the target is the one Rust signed in with, checked as the sign-in tunnel checks it. No shell runs.
//!   Windows' OpenSSH can't listen on a Unix socket, so there nothing on this computer listens for ssh: each connection
//!   the relay takes is an `ssh -W <host>:<port>` of its own, carried on its stdin and stdout (`connect`, #506).
//! - A TCP listener Rust binds on `127.0.0.1:0` and keeps, so the port is ephemeral and never released for another
//!   program to take. Each connection the frame makes is copied to and from ssh. On Linux and Windows, a connection
//!   from a program run by another account is closed unanswered (`loopback_peer`, ADR 0105).
//!
//! The webview names only the page's address. Rust parses it again and refuses anything that isn't an http(s) address
//! on the server's loopback, or is on a port that isn't for web pages; it never takes an ssh host, option or socket
//! path from the webview.
//!
//! A tunnel is registered before ssh starts, and ends when the webview closes it (the page leaves the Preview, even
//! while it is still connecting), when ssh exits, when the sign-in goes or moves to another SSH target, and when the
//! app exits: ssh is started with `PR_SET_PDEATHSIG` from a thread that lives as long as the app (on Windows, in a job
//! object that is closed with the app), so even an app that crashes takes it along.

use crate::live::ConnectionId;
use crate::lock::Locked;
use crate::loopback_peer::{self, Peers};
use crate::ssh_guard::{self, ForwardFailure, HostKeys, Kind, Local, Target};
use serde::Serialize;
use std::collections::HashMap;
use std::convert::Infallible;
use std::ffi::OsString;
use std::path::Path;
#[cfg(unix)]
use std::path::PathBuf;
use std::process::Stdio;
#[cfg(unix)]
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
#[cfg(unix)]
use tokio::net::UnixStream;
use tokio::process::{Child, Command};
use tokio::sync::oneshot;
use url::{Host, Url};

/// How long a new tunnel has to be ready: on Linux for ssh to sign in and listen on its socket, on Windows for ssh to
/// sign in and the page to send its first answer.
const READY_TIMEOUT: Duration = Duration::from_secs(20);
/// How long the first request through a new tunnel waits for any answer before the page is shown anyway.
#[cfg(any(unix, test))]
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// The most server pages open at once, so a runaway webview can't start ssh after ssh.
pub const MAX_OPEN: usize = 8;
/// How much of what ssh printed is kept, to say why it stopped.
const STDERR_KEPT: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ServerPageError {
    /// The address isn't a web page the preview opens at all.
    #[error("{0}")]
    NotWeb(String),
    /// A web address, but not on loopback: it opens on this computer, as any web page does.
    #[error("Only localhost, 127.0.0.1 and [::1] addresses open through SSH on the Hermes server.")]
    NotLoopback,
    #[error("Hermes Chat isn't connected to the Hermes server right now. Try again once it is.")]
    NotConnected,
    #[error("This sign-in uses a dashboard URL, so Hermes Chat has no SSH target to reach the server's own pages.")]
    NoSshTarget,
    #[error("{MAX_OPEN} server pages are open already. Close one first.")]
    TooMany,
    #[error("Couldn't start ssh: {0}")]
    Spawn(String),
    #[error("SSH failed: {0}")]
    Ssh(String),
    #[error("SSH didn't connect within {}s.", READY_TIMEOUT.as_secs())]
    Timeout,
    /// The server refused the forward, or something there took the connection and closed it without a word.
    #[error("Nothing on the Hermes server answered at {at}.{}", detail.as_deref().map(|d| format!(" ssh said: {d}")).unwrap_or_default())]
    PortClosed { at: String, detail: Option<String> },
    #[error("{0}")]
    Io(String),
    /// Closed before it opened: by the webview (`None`), or because the app left the server.
    #[error("{}", .0.as_deref().unwrap_or("The page was closed before its tunnel opened."))]
    Closed(Option<String>),
}

impl ServerPageError {
    fn kind(&self) -> &'static str {
        match self {
            Self::NotWeb(_) => "notWeb",
            Self::NotLoopback => "notLoopback",
            Self::NotConnected => "notConnected",
            Self::NoSshTarget => "noSshTarget",
            Self::TooMany => "tooMany",
            Self::Spawn(_) => "spawn",
            Self::Ssh(_) => "ssh",
            Self::Timeout => "timeout",
            Self::PortClosed { .. } => "portClosed",
            Self::Io(_) => "io",
            Self::Closed(_) => "closed",
        }
    }
}

/// `{ kind, message }`, so the webview can pick what to offer (the switch, Reload) without reading the words.
impl Serialize for ServerPageError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("ServerPageError", 2)?;
        st.serialize_field("kind", self.kind())?;
        st.serialize_field("message", &self.to_string())?;
        st.end()
    }
}

/// Which loopback a page's address names. `Any` is `0.0.0.0`, which servers print for "every address"; it is
/// reached on the server's `127.0.0.1`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Loopback {
    Localhost,
    V4,
    V6,
    Any,
}

impl Loopback {
    /// The host ssh connects to on the server. `localhost` is resolved there, as the page's own address means, so a
    /// server listening on `::1` only is reached too.
    pub fn forward_host(self) -> &'static str {
        match self {
            Loopback::Localhost => "localhost",
            Loopback::V4 | Loopback::Any => "127.0.0.1",
            Loopback::V6 => "[::1]",
        }
    }
}

/// A page on the server's loopback: its address as given, which loopback, and the port (the scheme's default if none).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerPage {
    pub url: Url,
    pub host: Loopback,
    pub port: u16,
}

impl ServerPage {
    /// `localhost:3000`, for messages.
    pub fn at(&self) -> String {
        let host = match self.host {
            Loopback::Localhost => "localhost",
            Loopback::V4 => "127.0.0.1",
            Loopback::V6 => "[::1]",
            Loopback::Any => "0.0.0.0",
        };
        format!("{host}:{}", self.port)
    }

    /// Where ssh connects on the server: `localhost:3000`, `127.0.0.1:8000` or `[::1]:8080`.
    pub fn far_end(&self) -> String {
        format!("{}:{}", self.host.forward_host(), self.port)
    }

    /// The same page through the tunnel's local end at `host`: only the host and port change.
    pub fn local_url(&self, host: &str, local_port: u16) -> Url {
        let mut u = self.url.clone();
        u.set_host(Some(host)).expect("an http(s) URL takes a loopback host");
        u.set_port(Some(local_port)).expect("an http(s) URL takes a port");
        u
    }
}

/// The Fetch standard's bad ports: browsers never load a page from them. The frame loads every server page from an
/// ephemeral port on this computer, so WebKit's own block never sees the server's port (ADR 0138).
const BAD_PORTS: &[u16] = &[
    1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
    139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
    2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
];

/// Parses a page address the webview sent and keeps it only if it is an http(s) address, without a username or
/// password, on `localhost`, `127.0.0.1`, `[::1]` or `0.0.0.0`, at a port for web pages: not the dashboard's, a
/// database's (`dev_servers::NOT_WEB`) or a bad port (`BAD_PORTS`).
pub fn server_page(raw: &str) -> Result<ServerPage, ServerPageError> {
    let url = Url::parse(raw.trim()).map_err(|_| ServerPageError::NotWeb("That isn't a web address.".into()))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(ServerPageError::NotWeb(format!("Only http:// and https:// pages open in the preview, and {}: isn't one.", url.scheme())));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(ServerPageError::NotWeb("Web addresses with a username or password in them don't open in the preview.".into()));
    }
    let host = match url.host() {
        Some(Host::Domain(d)) if d.eq_ignore_ascii_case("localhost") => Loopback::Localhost,
        Some(Host::Ipv4(ip)) if ip == std::net::Ipv4Addr::LOCALHOST => Loopback::V4,
        Some(Host::Ipv4(ip)) if ip.is_unspecified() => Loopback::Any,
        Some(Host::Ipv6(ip)) if ip.is_loopback() => Loopback::V6,
        _ => return Err(ServerPageError::NotLoopback),
    };
    let port = url.port_or_known_default().ok_or_else(|| ServerPageError::NotWeb("That isn't a web address.".into()))?;
    if port == 0 {
        return Err(ServerPageError::NotWeb("Port 0 isn't a port a page can be on.".into()));
    }
    if port == crate::DASHBOARD_PORT {
        return Err(ServerPageError::NotWeb(format!("Port {port} is the Hermes dashboard's own, and the Preview doesn't open it.")));
    }
    if BAD_PORTS.contains(&port) || crate::dev_servers::NOT_WEB.contains(&port) {
        return Err(ServerPageError::NotWeb(format!("Port {port} is for a service other than web pages, so the Preview doesn't open it.")));
    }
    Ok(ServerPage { url, host, port })
}

fn ssh_target(raw: &str) -> Result<Target<'_>, ServerPageError> {
    Target::parse(raw).ok_or_else(|| ServerPageError::Ssh("The sign-in's SSH target isn't one ssh can take.".into()))
}

/// ssh's arguments for a tunnel from `socket` to `page` on `target`'s loopback (`ssh_guard::Kind::Forward`).
///
/// - Host keys are the owner's config's: the sign-in already knows this host's key.
/// - `ExitOnForwardFailure=no`: a `LocalForward` in the owner's config for this host is opened by every ssh to it, and
///   the sign-in tunnel holds its port already, so with `yes` it would end every tunnel. Whether this tunnel's own
///   forward works is seen directly: its socket accepts, or ssh names the socket in an error (`open`).
pub fn ssh_args(target: &str, socket: &Path, page: &ServerPage) -> Result<Vec<OsString>, ServerPageError> {
    let target = ssh_target(target)?;
    let socket = socket.to_str().filter(|s| socket_path_ok(s)).ok_or_else(|| ServerPageError::Io("The tunnel's socket path isn't usable.".into()))?;
    Ok(forward_args(target, Local::Socket(socket), page))
}

/// ssh's arguments for one connection to `page` on Windows, where ssh carries it on its stdin and stdout and listens
/// on nothing (`ssh_guard::Local::Stdio`), with the same options as `ssh_args`.
pub fn stdio_args(target: &str, page: &ServerPage) -> Result<Vec<OsString>, ServerPageError> {
    Ok(forward_args(ssh_target(target)?, Local::Stdio, page))
}

fn forward_args(target: Target, local: Local, page: &ServerPage) -> Vec<OsString> {
    let far_end = page.far_end();
    let kind = Kind::Forward { local, far_end: &far_end, host_keys: HostKeys::OwnersConfig, on_failure: ForwardFailure::KeepGoing };
    ssh_guard::args(target, kind, Some(SSH_CONNECT_TIMEOUT))
}

pub fn listening_args(target: &str) -> Result<Vec<OsString>, ServerPageError> {
    Ok(ssh_guard::args(ssh_target(target)?, Kind::Command { remote: &["ss", "-ltnpH"] }, Some(SSH_CONNECT_TIMEOUT)))
}

const SSH_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// A socket path ssh's `-L` reads as one path: absolute, short enough for `sun_path`, and only characters that can't
/// split the forward spec (`:`) or be read as anything but a path.
fn socket_path_ok(s: &str) -> bool {
    s.starts_with('/') && s.len() < 100 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"/_.-".contains(&b))
}

/// This computer's end of ssh's forward on Linux, for a server page and for the sign-in tunnel (tunnel.rs, ADR 0098):
/// a Unix socket in a private folder (`SocketDir`) that only the owner can connect to.
#[cfg(unix)]
pub(crate) struct LocalEnd(SocketDir);

/// What the relay connects each frame connection to: ssh's socket.
#[cfg(unix)]
pub(crate) type Address = PathBuf;

/// What the relay connects each frame connection to on Windows: the ssh to start for it, which carries it on its stdin
/// and stdout. Windows' OpenSSH can't listen on a Unix socket, and a port it listened on would take every account's
/// connections (#506), so ssh listens on nothing.
#[cfg(windows)]
#[derive(Clone)]
pub(crate) struct Address {
    program: Arc<str>,
    args: Arc<[OsString]>,
}

#[cfg(windows)]
impl Address {
    /// Each connection starts `program` with `args`, ssh's for a `Local::Stdio` forward.
    pub(crate) fn new(program: &str, args: Vec<OsString>) -> Address {
        Address { program: program.into(), args: args.into() }
    }
}

#[cfg(unix)]
impl LocalEnd {
    pub(crate) const COULDNT: &str = "Couldn't make a folder for the tunnel";

    pub(crate) fn new() -> std::io::Result<Self> {
        SocketDir::new().map(LocalEnd)
    }

    /// Where ssh's `-L` listens: the socket's path, which `SocketDir` made one that ssh reads as one path.
    pub(crate) fn listen(&self) -> String {
        self.0.socket().to_string_lossy().into_owned()
    }

    fn ssh_args(&self, target: &str, page: &ServerPage) -> Result<Vec<OsString>, ServerPageError> {
        ssh_args(target, &self.0.socket(), page)
    }

    /// Where to reach ssh's end of the forward.
    pub(crate) fn address(&self) -> Address {
        self.0.socket()
    }

    /// ssh couldn't make this tunnel's socket (`unix_listener: cannot bind to path …`).
    fn named_in(&self, said: &str) -> bool {
        self.0.socket().to_str().is_some_and(|p| said.contains(p))
    }
}

#[cfg(unix)]
pub(crate) async fn connect(address: &Address) -> std::io::Result<UnixStream> {
    UnixStream::connect(address).await
}

/// A new connection through `address`: an ssh of its own, started now. Whether it signed in and reached the far end
/// shows only once something comes back (`first_byte`), or ssh ends and says why (`Through::refusal`).
#[cfg(windows)]
pub(crate) async fn connect(address: &Address) -> std::io::Result<Through> {
    let mut command = Command::new(&*address.program);
    command.args(&*address.args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut ssh = Ssh::start(&mut command)?;
    let (Some(to), Some(from), Some(stderr)) = (ssh.stdin.take(), ssh.stdout.take(), ssh.stderr.take()) else {
        return Err(std::io::Error::other("ssh's input and output aren't connected"));
    };
    let said = Stderr::default();
    let drained = said.drain(stderr);
    Ok(Through { ssh, to: Some(to), from, said, drained })
}

/// One connection through a Windows tunnel: `ssh -W`, whose stdin and stdout are the connection. Dropping it ends ssh
/// and everything ssh started.
#[cfg(windows)]
pub(crate) struct Through {
    ssh: Ssh,
    to: Option<tokio::process::ChildStdin>,
    from: tokio::process::ChildStdout,
    said: Stderr,
    drained: tokio::task::JoinHandle<()>,
}

/// Why a connection through a Windows tunnel closed with nothing sent back.
#[cfg(windows)]
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Refusal {
    /// ssh signed in, and nothing on the server answered at the port: the line ssh printed about it, if any.
    NothingAnswered(Option<String>),
    /// ssh itself failed, signing in or starting: what it said.
    Ssh(String),
}

#[cfg(windows)]
impl Through {
    /// Why ssh closed this connection unanswered. ssh with `-W` exits 255 when it can't sign in or the server can't
    /// open the forward, and names a forward the server refused (`channel 0: open failed: …`).
    pub(crate) async fn refusal(mut self) -> Refusal {
        let status = tokio::time::timeout(Duration::from_secs(2), self.ssh.wait()).await;
        let _ = tokio::time::timeout(Duration::from_secs(1), self.drained).await;
        if let Some(line) = self.said.open_failed() {
            return Refusal::NothingAnswered(Some(line));
        }
        match status {
            Ok(Ok(s)) if !s.success() => {
                let said = self.said.text();
                Refusal::Ssh(if said.is_empty() { format!("ssh exited with {s}.") } else { said })
            }
            _ => Refusal::NothingAnswered(None),
        }
    }
}

#[cfg(windows)]
impl tokio::io::AsyncRead for Through {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.from).poll_read(cx, buf)
    }
}

#[cfg(windows)]
impl tokio::io::AsyncWrite for Through {
    fn poll_write(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>, buf: &[u8]) -> std::task::Poll<std::io::Result<usize>> {
        match self.to.as_mut() {
            Some(to) => std::pin::Pin::new(to).poll_write(cx, buf),
            None => std::task::Poll::Ready(Err(std::io::ErrorKind::BrokenPipe.into())),
        }
    }

    fn poll_flush(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<std::io::Result<()>> {
        match self.to.as_mut() {
            Some(to) => std::pin::Pin::new(to).poll_flush(cx),
            None => std::task::Poll::Ready(Ok(())),
        }
    }

    /// Closes ssh's stdin, which ssh passes on as the end of what this side sends.
    fn poll_shutdown(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<std::io::Result<()>> {
        if let Some(to) = self.to.as_mut() {
            std::task::ready!(std::pin::Pin::new(to).poll_flush(cx))?;
        }
        self.to = None;
        std::task::Poll::Ready(Ok(()))
    }
}

/// A private folder for one tunnel's socket: `$XDG_RUNTIME_DIR` (the owner's own, 0700) when it is usable, else the
/// temporary folder. Made with mode 0700 and a new name, never reusing a folder that is already there. Removed with
/// what is in it when dropped.
#[cfg(unix)]
struct SocketDir(PathBuf);

#[cfg(unix)]
impl SocketDir {
    fn bases() -> [Option<PathBuf>; 2] {
        [std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from), Some(std::env::temp_dir())]
    }

    fn new() -> std::io::Result<Self> {
        use std::os::unix::fs::DirBuilderExt;
        static SEQ: AtomicU64 = AtomicU64::new(0);
        static SWEPT: std::sync::Once = std::sync::Once::new();
        SWEPT.call_once(|| {
            for base in Self::bases().into_iter().flatten() {
                sweep(&base, |pid| Path::new(&format!("/proc/{pid}")).exists());
            }
        });
        let bases = Self::bases();
        let mut last = std::io::Error::other("no usable folder for the tunnel's socket");
        for base in bases.into_iter().flatten().filter(|b| b.is_absolute() && b.is_dir()) {
            for _ in 0..8 {
                let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
                let name = format!("hermes-chat-page-{}-{}-{nanos:x}", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed));
                let dir = base.join(name);
                if !dir.join("s").to_str().is_some_and(socket_path_ok) {
                    break;
                }
                match std::fs::DirBuilder::new().mode(0o700).create(&dir) {
                    Ok(()) => return Ok(SocketDir(dir)),
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(e) => {
                        last = e;
                        break;
                    }
                }
            }
        }
        Err(last)
    }

    fn socket(&self) -> PathBuf {
        self.0.join("s")
    }
}

/// Removes the socket folders in `base` that an app no longer running left behind (one that was killed, so its drops
/// never ran; its ssh went with it). Only folders named as `SocketDir` names them, owned by this user, whose app's
/// pid `alive` says is gone; and only their socket and the folder itself, never anything else in them.
#[cfg(unix)]
fn sweep(base: &Path, alive: impl Fn(u32) -> bool) {
    use std::os::unix::fs::MetadataExt;
    let Ok(entries) = std::fs::read_dir(base) else { return };
    let me = unsafe { libc::getuid() };
    for e in entries.flatten() {
        let name = e.file_name();
        let Some(pid) = name.to_str().and_then(|n| n.strip_prefix("hermes-chat-page-")).and_then(|r| r.split('-').next()).and_then(|p| p.parse::<u32>().ok())
        else {
            continue;
        };
        let Ok(meta) = std::fs::symlink_metadata(e.path()) else { continue };
        if !meta.is_dir() || meta.uid() != me || pid == std::process::id() || alive(pid) {
            continue;
        }
        let _ = std::fs::remove_file(e.path().join("s"));
        let _ = std::fs::remove_dir(e.path());
    }
}

#[cfg(unix)]
impl Drop for SocketDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(self.socket());
        let _ = std::fs::remove_dir(&self.0);
    }
}

#[cfg(unix)]
type Job = Box<dyn FnOnce() + Send>;

/// The thread every ssh is started from. `PR_SET_PDEATHSIG` follows the thread that forked, not the process, and a
/// tokio worker can retire while the app runs on (after `block_in_place`, which downloads use). This thread lives
/// until the process ends, so an ssh started here dies with the app and not before.
#[cfg(unix)]
fn spawner() -> std::sync::mpsc::Sender<Job> {
    static SPAWNER: std::sync::OnceLock<Mutex<std::sync::mpsc::Sender<Job>>> = std::sync::OnceLock::new();
    SPAWNER
        .get_or_init(|| {
            let (tx, rx) = std::sync::mpsc::channel::<Job>();
            std::thread::Builder::new()
                .name("hermes-ssh-spawner".into())
                .spawn(move || {
                    for job in rx {
                        job();
                    }
                })
                .expect("start the ssh spawner thread");
            Mutex::new(tx)
        })
        .locked()
        .clone()
}

/// `ssh` with `args`: stdin closed, stdout to `stdout`, stderr kept. It is killed when dropped, and, through
/// `PR_SET_PDEATHSIG`, when the app ends, since it is started from `spawner`'s thread.
#[cfg(unix)]
async fn spawn_ssh(program: &str, args: &[OsString], stdout: Stdio) -> Result<Ssh, ServerPageError> {
    let mut command = Command::new(program);
    command.args(args).stdin(Stdio::null()).stdout(stdout).stderr(Stdio::piped()).kill_on_drop(true);
    let parent = std::process::id() as libc::pid_t;
    // SAFETY: only async-signal-safe calls between fork and exec.
    unsafe {
        command.pre_exec(move || {
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM as libc::c_ulong, 0, 0, 0) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            // The app may have gone between fork and prctl; then nothing would ever signal this one.
            if libc::getppid() != parent {
                libc::_exit(1);
            }
            Ok(())
        });
    }
    let runtime = tokio::runtime::Handle::current();
    let (tx, rx) = oneshot::channel();
    spawner()
        .send(Box::new(move || {
            // The child is reaped by this runtime, wherever it was forked from.
            let _in = runtime.enter();
            let _ = tx.send(command.spawn());
        }))
        .map_err(|_| ServerPageError::Spawn("the ssh spawner thread is gone".into()))?;
    let child = rx.await.map_err(|_| ServerPageError::Spawn("the ssh spawner thread is gone".into()))?.map_err(|e| ServerPageError::Spawn(e.to_string()))?;
    Ok(Ssh { child })
}

#[cfg(windows)]
async fn spawn_ssh(program: &str, args: &[OsString], stdout: Stdio) -> Result<Ssh, ServerPageError> {
    let mut command = Command::new(program);
    command.args(args).stdin(Stdio::null()).stdout(stdout).stderr(Stdio::piped());
    Ssh::start(&mut command).map_err(|e| ServerPageError::Spawn(e.to_string()))
}

/// A running ssh, ended when dropped. On Windows that includes every process ssh started, such as the real ssh.exe
/// behind a Scoop or Chocolatey shim, which killing the shim alone would leave holding the forward.
pub(crate) struct Ssh {
    child: Child,
    #[cfg(windows)]
    _job: job::Own,
}

impl Ssh {
    /// Starts `command`, in a job of its own that ends with this `Ssh` (`job::start`).
    #[cfg(windows)]
    pub(crate) fn start(command: &mut Command) -> std::io::Result<Ssh> {
        let (child, own) = job::start(command)?;
        Ok(Ssh { child, _job: own })
    }

    #[cfg(unix)]
    pub(crate) fn start(command: &mut Command) -> std::io::Result<Ssh> {
        Ok(Ssh { child: command.kill_on_drop(true).spawn()? })
    }
}

impl std::ops::Deref for Ssh {
    type Target = Child;
    fn deref(&self) -> &Child {
        &self.child
    }
}

impl std::ops::DerefMut for Ssh {
    fn deref_mut(&mut self) -> &mut Child {
        &mut self.child
    }
}

/// Windows jobs, which end a program together with everything it started: ssh here, and a speech-to-text engine
/// (local_stt.rs).
#[cfg(windows)]
pub(crate) mod job {
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};

    /// A new job that kills what is in it once its last handle closes.
    fn killing_job() -> std::io::Result<HANDLE> {
        // SAFETY: plain Win32 calls; the limits struct outlives the call that reads it.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let set = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if set == 0 {
                let e = std::io::Error::last_os_error();
                CloseHandle(job);
                return Err(e);
            }
            Ok(job)
        }
    }

    fn add(job: HANDLE, process: std::os::windows::io::RawHandle) -> std::io::Result<()> {
        // SAFETY: `process` is a live process handle the caller's Child owns.
        if unsafe { AssignProcessToJobObject(job, process as HANDLE) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }

    /// The app's job. Its handle is never closed, so Windows closes it when this process ends, crashed or not.
    fn the_job() -> std::io::Result<HANDLE> {
        static JOB: OnceLock<Result<usize, i32>> = OnceLock::new();
        let made = JOB.get_or_init(|| killing_job().map(|job| job as usize).map_err(|e| e.raw_os_error().unwrap_or(0)));
        made.map(|h| h as HANDLE).map_err(std::io::Error::from_raw_os_error)
    }

    /// Starts `command` with no console window. It starts suspended, goes into the app's job, so it ends with the app,
    /// and into a job of its own, so it ends with the `Own` returned, and only then runs: nothing it starts can be
    /// outside both.
    pub(crate) fn start(command: &mut tokio::process::Command) -> std::io::Result<(tokio::process::Child, Own)> {
        const CREATE_SUSPENDED: u32 = 0x0000_0004;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let child = command.kill_on_drop(true).creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED).spawn()?;
        let (Some(handle), Some(pid)) = (child.raw_handle(), child.id()) else {
            return Err(std::io::Error::other("it exited as it started"));
        };
        add(the_job()?, handle)?;
        let own = Own(killing_job()? as usize);
        add(own.0 as HANDLE, handle)?;
        resume(pid)?;
        Ok((child, own))
    }

    /// A job of one process's own, nested in the app's. Dropping it ends that process and everything it started.
    pub(crate) struct Own(usize);

    impl Drop for Own {
        fn drop(&mut self) {
            // SAFETY: the job handle `new` made, closed once.
            unsafe { CloseHandle(self.0 as HANDLE) };
        }
    }

    /// Lets process `pid`, started suspended, run.
    fn resume(pid: u32) -> std::io::Result<()> {
        let mut resumed = false;
        // SAFETY: plain Win32 calls on handles opened and closed here; `entry` is sized as Thread32First asks.
        unsafe {
            let threads = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
            if threads == INVALID_HANDLE_VALUE {
                return Err(std::io::Error::last_os_error());
            }
            let mut entry: THREADENTRY32 = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
            let mut more = Thread32First(threads, &mut entry) != 0;
            while more {
                if entry.th32OwnerProcessID == pid {
                    let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                    if !thread.is_null() {
                        resumed |= ResumeThread(thread) != u32::MAX;
                        CloseHandle(thread);
                    }
                }
                more = Thread32Next(threads, &mut entry) != 0;
            }
            CloseHandle(threads);
        }
        if resumed {
            Ok(())
        } else {
            Err(std::io::Error::other("couldn't let it run after putting it in its job"))
        }
    }
}

/// The last `STDERR_KEPT` bytes ssh printed, read as it prints, so a chatty ssh never blocks on a full pipe.
#[derive(Clone, Default)]
pub(crate) struct Stderr(Arc<Mutex<Vec<u8>>>);

impl Stderr {
    pub(crate) fn drain(&self, mut from: tokio::process::ChildStderr) -> tokio::task::JoinHandle<()> {
        let kept = self.0.clone();
        tokio::spawn(async move {
            let mut buf = [0u8; 1024];
            while let Ok(n) = from.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                let mut k = kept.locked();
                k.extend_from_slice(&buf[..n]);
                let over = k.len().saturating_sub(STDERR_KEPT);
                k.drain(..over);
            }
        })
    }

    pub(crate) fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.locked()).trim().to_owned()
    }

    /// The last line about a forward the server couldn't open (`channel 2: open failed: connect failed: …`).
    fn open_failed(&self) -> Option<String> {
        self.text().lines().rev().find(|l| l.contains("open failed")).map(|l| l.trim().to_owned())
    }
}

/// What the webview gets back from opening a page: its id for `close`, the address to load in the frame, the SSH
/// target it goes through, and the page's place on the server (`localhost:3000`).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
    pub id: String,
    pub url: String,
    pub target: String,
    pub at: String,
}

/// Sent once when a tunnel ends without the webview closing it: ssh exited, or the sign-in went or changed.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PageEvent {
    Closed { message: String },
}

struct Open {
    /// The connection it was opened for, which it closes with.
    connection: ConnectionId,
    target: String,
    /// Ends the tunnel, starting or open, with what to tell the webview (`None`: the webview asked).
    stop: oneshot::Sender<Option<String>>,
    served: Option<Served>,
}

struct Served {
    local_port: u16,
    jar: Jar,
}

/// Every server page's tunnel listens on `127.0.0.1`, and cookies don't tell ports apart, so in one jar each page would
/// get every other server page's cookies. On Linux each jar is a WebKit context of its own (`page_view`). On Windows the
/// page is a frame in the app's one WebView2, so each jar is a host name instead (`host`, ADR 0144).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Jar {
    target: String,
    origin: url::Origin,
}

/// Keyed afresh each run, so the names, and the cookies WebView2 keeps on disk under them, last only the run, as Linux's
/// jars do (ADR 0081).
static RUN: std::sync::LazyLock<std::hash::RandomState> = std::sync::LazyLock::new(std::hash::RandomState::new);

impl Jar {
    /// The jar's own name under `localhost`, which WebView2 resolves to loopback (RFC 6761): `p` and 16 hex digits.
    pub fn host(&self) -> String {
        use std::hash::BuildHasher;
        format!("p{:016x}.localhost", RUN.hash_one(self))
    }
}

#[cfg(test)]
impl Jar {
    pub fn of(target: &str, url: &str) -> Jar {
        Jar { target: target.into(), origin: Url::parse(url).unwrap().origin() }
    }
}

/// The most keys of pages closed before Rust heard of them kept, so a late `open` with one is refused.
const STOPPED_KEPT: usize = 256;

/// A tunnel `begin` registered: it counts towards the limit, and `close`, `close_all` and `close_for` end it, from
/// before ssh starts until it closes.
pub struct Starting {
    key: String,
    target: String,
    stopped: oneshot::Receiver<Option<String>>,
}

/// The server pages starting or open now, by the webview's key for each.
#[derive(Default)]
pub struct ServerPages {
    open: Mutex<HashMap<String, Open>>,
    /// Keys the webview closed before `begin` saw them.
    stopped: Mutex<std::collections::VecDeque<String>>,
}

/// A key the webview names a page by: short, and only letters, digits, `-` and `_`.
fn key_ok(key: &str) -> bool {
    (1..=64).contains(&key.len()) && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// What `start` made, handed to the task that keeps the tunnel.
struct Started {
    forward: Forward,
    address: Address,
    listener: TcpListener,
    ipv6: Option<TcpListener>,
}

/// What a page's tunnel keeps running between connections. On Linux, ssh forwarding the socket in its private folder,
/// ended with the folder when dropped. On Windows nothing: each connection is an ssh of its own (`connect`).
#[cfg(unix)]
struct Forward {
    ssh: Ssh,
    _end: LocalEnd,
    stderr: Stderr,
}

#[cfg(windows)]
struct Forward;

impl Forward {
    /// What to tell the page once ssh ends on its own. Never, on Windows.
    async fn ended(&mut self) -> String {
        #[cfg(unix)]
        {
            let status = self.ssh.wait().await;
            tokio::time::sleep(Duration::from_millis(50)).await;
            let said = self.stderr.text();
            match status {
                Ok(s) if said.is_empty() => format!("ssh ended ({s})."),
                _ => format!("ssh ended: {said}"),
            }
        }
        #[cfg(windows)]
        std::future::pending().await
    }

    /// Ends ssh now, and waits for it.
    async fn stop(&mut self) {
        #[cfg(unix)]
        {
            let _ = self.ssh.start_kill();
            let _ = self.ssh.wait().await;
        }
    }
}

impl ServerPages {
    /// Registers a tunnel for `key` through `target`, for `connection`, before anything starts, so `close_for` after
    /// it closes this one too. A `close_for` that ran just before can't have: the caller checks its connection is
    /// still held once this returns, and lets the tunnel go (`give_up`) if it isn't.
    pub fn begin(&self, key: &str, connection: &ConnectionId, target: &str) -> Result<Starting, ServerPageError> {
        if !key_ok(key) {
            return Err(ServerPageError::Io("That page key isn't one Hermes Chat makes.".into()));
        }
        let target = Target::parse(target).ok_or(ServerPageError::NoSshTarget)?.as_str().to_owned();
        let mut open = self.open.locked();
        {
            let mut stopped = self.stopped.locked();
            if let Some(i) = stopped.iter().position(|k| k == key) {
                stopped.remove(i);
                return Err(ServerPageError::Closed(None));
            }
        }
        if open.contains_key(key) {
            return Err(ServerPageError::Io("That page is open already.".into()));
        }
        if open.len() >= MAX_OPEN {
            return Err(ServerPageError::TooMany);
        }
        let (stop, stopped) = oneshot::channel();
        open.insert(key.to_owned(), Open { connection: connection.clone(), target: target.clone(), stop, served: None });
        Ok(Starting { key: key.to_owned(), target, stopped })
    }

    /// Lets go of a tunnel `begin` registered that won't be opened: its connection went meanwhile.
    pub fn give_up(&self, starting: Starting) {
        self.open.locked().remove(&starting.key);
    }

    /// Opens the tunnel `begin` registered, to `page`: waits until ssh listens and the page's port answers, then
    /// serves it on `127.0.0.1` at an ephemeral port. Closing it meanwhile stops it at once, and ends ssh. `on_event`
    /// hears once if it ends after opening without `close`.
    pub async fn open(
        self: &Arc<Self>,
        program: &str,
        starting: Starting,
        page: ServerPage,
        on_event: impl Fn(PageEvent) + Send + 'static,
    ) -> Result<Opened, ServerPageError> {
        let Starting { key, target, mut stopped } = starting;
        let started = tokio::select! {
            started = start(program, &target, &page) => started,
            why = &mut stopped => Err(ServerPageError::Closed(why.unwrap_or(None))),
        };
        let Started { mut forward, address, listener, ipv6 } = match started {
            Ok(s) => s,
            Err(e) => {
                self.open.locked().remove(&key);
                return Err(e);
            }
        };
        let local_port = listener.local_addr().map_err(|e| ServerPageError::Io(e.to_string()))?.port();
        let jar = Jar { target: target.clone(), origin: page.url.origin() };
        let host = if cfg!(windows) { jar.host() } else { "127.0.0.1".to_owned() };
        if let Some(open) = self.open.locked().get_mut(&key) {
            open.served = Some(Served { local_port, jar });
        }

        let pages = Arc::clone(self);
        let task_key = key.clone();
        tokio::spawn(async move {
            // Everything the tunnel holds lives in this task: ending it drops the listener, the copies, ssh (killed on
            // drop) and the socket's folder.
            let peers = Peers::Account(loopback_peer::this_account());
            let on_ipv6 = {
                let address = address.clone();
                async move {
                    match ipv6 {
                        Some(ipv6) => serve(ipv6, address, peers).await,
                        None => std::future::pending().await,
                    }
                }
            };
            let serving = async move {
                tokio::select! {
                    never = serve(listener, address, peers) => never,
                    never = on_ipv6 => never,
                }
            };
            tokio::pin!(serving);
            let why = tokio::select! {
                said = forward.ended() => Some(said),
                why = stopped => {
                    forward.stop().await;
                    why.unwrap_or(None)
                }
                never = &mut serving => match never {},
            };
            pages.open.locked().remove(&task_key);
            if let Some(message) = why {
                on_event(PageEvent::Closed { message });
            }
        });

        Ok(Opened { id: key, url: page.local_url(&host, local_port).to_string(), target, at: page.at() })
    }

    /// Closes the tunnel `key`, starting or open. The webview asked, so it isn't told. A key not seen yet is kept, so
    /// the `open` the webview sent before it is refused when it arrives.
    pub fn close(&self, key: &str) {
        // `open` stays locked until the key is kept, in the order `begin` locks them, so a `begin` for the same key can't
        // slip in between finding nothing and keeping it.
        let mut open = self.open.locked();
        match open.remove(key) {
            Some(o) => {
                drop(open);
                let _ = o.stop.send(None);
            }
            None if key_ok(key) => {
                let mut stopped = self.stopped.locked();
                if stopped.len() >= STOPPED_KEPT {
                    stopped.pop_front();
                }
                stopped.push_back(key.to_owned());
            }
            None => {}
        }
    }

    /// Closes every tunnel, starting or open, telling each page `why`: at exit.
    pub fn close_all(&self, why: &str) {
        for (_, o) in self.open.locked().drain() {
            let _ = o.stop.send(Some(why.to_owned()));
        }
    }

    /// Closes `connection`'s tunnels, starting or open, telling each page `why`: all of them once it is closed, or,
    /// once it is opened again, those that don't go through `keep_target`, the SSH target it has now. Another
    /// connection's tunnels stay.
    pub fn close_for(&self, connection: &ConnectionId, keep_target: Option<&str>, why: &str) {
        let keep = keep_target.and_then(Target::parse).map(Target::as_str);
        let mut open = self.open.locked();
        let going: Vec<String> = open.iter().filter(|(_, o)| o.connection == *connection && Some(o.target.as_str()) != keep).map(|(k, _)| k.clone()).collect();
        for key in going {
            if let Some(o) = open.remove(&key) {
                let _ = o.stop.send(Some(why.to_owned()));
            }
        }
    }

    pub fn jar(&self, url: &Url) -> Option<Jar> {
        if url.host() != Some(Host::Ipv4(std::net::Ipv4Addr::LOCALHOST)) {
            return None;
        }
        let port = url.port_or_known_default()?;
        self.open.locked().values().find_map(|o| o.served.as_ref().filter(|s| s.local_port == port)).map(|s| s.jar.clone())
    }

    pub fn len(&self) -> usize {
        self.open.locked().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

const LISTENING_TIMEOUT: Duration = Duration::from_secs(10);
const LISTENING_KEPT: u64 = 64 * 1024;

pub async fn listening(program: &str, target: &str) -> Result<String, ServerPageError> {
    let mut child = spawn_ssh(program, &listening_args(target)?, Stdio::piped()).await?;
    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        return Err(ServerPageError::Spawn("ssh's output isn't readable".into()));
    };
    let (mut out, mut said) = (Vec::new(), Vec::new());
    let run = async {
        let (o, e) = tokio::join!(read_kept(stdout, LISTENING_KEPT, &mut out), read_kept(stderr, STDERR_KEPT as u64, &mut said));
        if o? {
            out.truncate(out.iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1));
        }
        e?;
        child.wait().await
    };
    let status = match tokio::time::timeout(LISTENING_TIMEOUT, run).await {
        Err(_) => return Err(ServerPageError::Ssh(format!("The server didn't answer within {}s.", LISTENING_TIMEOUT.as_secs()))),
        Ok(r) => r.map_err(|e| ServerPageError::Io(e.to_string()))?,
    };
    if !status.success() {
        let said = String::from_utf8_lossy(&said).trim().to_owned();
        return Err(ServerPageError::Ssh(if said.is_empty() { format!("ssh exited with {status}.") } else { said }));
    }
    Ok(String::from_utf8_lossy(&out).into_owned())
}

/// Reads `from` to its end into `into`, keeping only its first `kept` bytes and dropping the rest, so the writer never
/// blocks on a full pipe. True if anything was dropped.
async fn read_kept(mut from: impl tokio::io::AsyncRead + Unpin, kept: u64, into: &mut Vec<u8>) -> std::io::Result<bool> {
    (&mut from).take(kept).read_to_end(into).await?;
    Ok(tokio::io::copy(&mut from, &mut tokio::io::sink()).await? > 0)
}

/// Starts ssh for `page` through `target` and waits until it listens and the page's port answers. Everything made is
/// dropped, ending ssh, if this fails or is dropped part-way.
#[cfg(unix)]
async fn start(program: &str, target: &str, page: &ServerPage) -> Result<Started, ServerPageError> {
    let end = LocalEnd::new().map_err(|e| ServerPageError::Io(format!("{}: {e}", LocalEnd::COULDNT)))?;
    let mut ssh = spawn_ssh(program, &end.ssh_args(target, page)?, Stdio::null()).await?;
    let address = end.address();
    let stderr = Stderr::default();
    if let Some(e) = ssh.stderr.take() {
        stderr.drain(e);
    }

    // Ready once ssh accepts on its socket; then one try finds out whether anything answers on the port.
    let deadline = tokio::time::Instant::now() + READY_TIMEOUT;
    let probe = loop {
        if ssh.try_wait().map_err(|e| ServerPageError::Spawn(e.to_string()))?.is_some() {
            // Let the drain catch ssh's last words.
            tokio::time::sleep(Duration::from_millis(50)).await;
            let said = stderr.text();
            return Err(ServerPageError::Ssh(if said.is_empty() { "ssh exited without saying why.".into() } else { said }));
        }
        if let Ok(s) = connect(&address).await {
            break s;
        }
        // ssh couldn't make this tunnel's socket (`unix_listener: cannot bind to path …`); it keeps running for the
        // rest, so say so now rather than at the timeout.
        let said = stderr.text();
        if end.named_in(&said) {
            return Err(ServerPageError::Ssh(said));
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(ServerPageError::Timeout);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    if !answers(probe, page, PROBE_TIMEOUT).await {
        tokio::time::sleep(Duration::from_millis(100)).await;
        return Err(ServerPageError::PortClosed { at: page.at(), detail: stderr.open_failed() });
    }
    let (listener, ipv6) = listen(false).await.map_err(|e| ServerPageError::Io(e.to_string()))?;
    Ok(Started { forward: Forward { ssh, _end: end, stderr }, address, listener, ipv6 })
}

/// Windows: one connection through ssh finds out whether ssh signs in and anything answers on the page's port. ssh
/// has `READY_TIMEOUT` to sign in and the page to answer; no answer by then, with ssh still running, opens the page.
#[cfg(windows)]
async fn start(program: &str, target: &str, page: &ServerPage) -> Result<Started, ServerPageError> {
    let address = Address::new(program, stdio_args(target, page)?);
    let mut probe = connect(&address).await.map_err(|e| ServerPageError::Spawn(e.to_string()))?;
    if !answers(&mut probe, page, READY_TIMEOUT).await {
        return Err(match probe.refusal().await {
            Refusal::NothingAnswered(detail) => ServerPageError::PortClosed { at: page.at(), detail },
            Refusal::Ssh(said) => ServerPageError::Ssh(said),
        });
    }
    let (listener, ipv6) = listen(true).await.map_err(|e| ServerPageError::Io(e.to_string()))?;
    Ok(Started { forward: Forward, address, listener, ipv6 })
}

/// The tunnel's listeners: on `127.0.0.1`, and with `ipv6` on `[::1]` at the same port. On Windows a page's name under
/// `localhost` (`Jar::host`) resolves to both, so a program that listened on `[::1]` at the port would otherwise get the
/// frame's requests and cookies (ADR 0144). The second is `None` without `ipv6`, and when this computer has no `::1`,
/// where nothing can listen. Any other failure there tries another port, since something may hold that one.
async fn listen(ipv6: bool) -> std::io::Result<(TcpListener, Option<TcpListener>)> {
    for _ in 0..16 {
        let ipv4 = TcpListener::bind(("127.0.0.1", 0)).await?;
        if !ipv6 {
            return Ok((ipv4, None));
        }
        let port = ipv4.local_addr()?.port();
        match TcpListener::bind((std::net::Ipv6Addr::LOCALHOST, port)).await {
            Ok(ipv6) => return Ok((ipv4, Some(ipv6))),
            Err(e) if no_ipv6(&e) => return Ok((ipv4, None)),
            Err(_) => continue,
        }
    }
    Err(std::io::Error::new(std::io::ErrorKind::AddrInUse, "no port was free on both 127.0.0.1 and [::1]"))
}

/// Whether binding `[::1]` failed because this computer has no IPv6 or no `::1`.
fn no_ipv6(e: &std::io::Error) -> bool {
    #[cfg(unix)]
    const NO_FAMILY: i32 = libc::EAFNOSUPPORT;
    #[cfg(windows)]
    const NO_FAMILY: i32 = windows_sys::Win32::Networking::WinSock::WSAEAFNOSUPPORT;
    e.kind() == std::io::ErrorKind::AddrNotAvailable || e.raw_os_error() == Some(NO_FAMILY)
}

/// Whether anything answers through a new tunnel. ssh closing the connection with nothing said means the server
/// couldn't connect to the port. Any bytes back, or no answer `within` (a slow server), count.
///
/// A TLS server may drop plain text without a word but answers a ClientHello at once, with its ServerHello or an alert.
async fn answers(s: impl tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin, page: &ServerPage, within: Duration) -> bool {
    let request =
        if page.url.scheme() == "https" { client_hello() } else { format!("HEAD / HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n", page.at()).into_bytes() };
    first_byte(s, &request, within).await != Reply::Closed
}

/// What came back on a new connection after a request.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Reply {
    /// At least one byte.
    Came,
    /// The connection closed or was reset first: ssh drops a connection that way when the server refused the forward.
    Closed,
    /// Nothing yet.
    Silent,
}

/// Sends `request` on `s` and waits `within` for the first byte back.
pub(crate) async fn first_byte(mut s: impl tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin, request: &[u8], within: Duration) -> Reply {
    if s.write_all(request).await.is_err() {
        return Reply::Closed;
    }
    let mut b = [0u8; 1];
    match tokio::time::timeout(within, s.read(&mut b)).await {
        Ok(Ok(1..)) => Reply::Came,
        Ok(_) => Reply::Closed,
        Err(_) => Reply::Silent,
    }
}

/// A TLS record holding a ClientHello for TLS 1.3 or 1.2, with suites, groups and signatures every common TLS library
/// takes. No server name: the page's host may be an IP address.
fn client_hello() -> Vec<u8> {
    fn sized(body: &[u8]) -> Vec<u8> {
        [&(body.len() as u16).to_be_bytes()[..], body].concat()
    }
    let extension = |kind: u16, body: &[u8]| [&kind.to_be_bytes()[..], &sized(body)].concat();
    let key_share = [&[0x00, 0x1d][..], &sized(&[9; 32])].concat();
    let extensions = [
        extension(0x000a, &sized(&[0x00, 0x1d, 0x00, 0x17])),
        extension(0x000d, &sized(&[0x04, 0x03, 0x08, 0x04, 0x04, 0x01])),
        extension(0x002b, &[0x04, 0x03, 0x04, 0x03, 0x03]),
        extension(0x0033, &sized(&key_share)),
    ]
    .concat();
    let suites = [0x13, 0x01, 0x13, 0x02, 0x13, 0x03, 0xc0, 0x2b, 0xc0, 0x2f, 0xc0, 0x2c, 0xc0, 0x30];
    let hello = [&[0x03, 0x03][..], &[7; 32], &[0], &sized(&suites), &[0x01, 0x00], &sized(&extensions)].concat();
    let handshake = [&[0x01][..], &(hello.len() as u32).to_be_bytes()[1..], &hello].concat();
    [&[0x16, 0x03, 0x01][..], &sized(&handshake)].concat()
}

/// How long the relay waits after a failed accept before the next, so running out of file descriptors doesn't spin.
const ACCEPT_RETRY: Duration = Duration::from_millis(100);

/// Accepts connections on `listener` and copies each one to and from ssh at `address`, until dropped: it never returns.
/// A failed accept (a connection reset before it was taken, or no file descriptors left) passes, so it is logged and
/// the next tried a moment later. A connection from anyone but `peers` is closed unanswered (ADR 0105, ADR 0138), before
/// anything reaches ssh.
pub(crate) async fn serve(listener: TcpListener, address: Address, peers: Peers) -> Infallible {
    let listener = &listener;
    serve_with(
        move || listener.accept(),
        move || {
            let address = address.clone();
            async move { connect(&address).await }
        },
        peers,
    )
    .await
}

/// `serve`, taking each connection from `accept` and making its other end with `through`.
async fn serve_with<A, F, T, G, S>(mut accept: A, through: T, peers: Peers) -> Infallible
where
    A: FnMut() -> F,
    F: std::future::Future<Output = std::io::Result<(tokio::net::TcpStream, std::net::SocketAddr)>>,
    T: Fn() -> G + Send + Sync + 'static,
    G: std::future::Future<Output = std::io::Result<S>> + Send + 'static,
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let through = Arc::new(through);
    let mut conns = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            accepted = accept() => {
                let (mut tcp, _) = match accepted {
                    Ok(accepted) => accepted,
                    Err(e) => {
                        eprintln!("hermes-chat: a relay couldn't accept a connection, and will try again: {e}");
                        tokio::time::sleep(ACCEPT_RETRY).await;
                        continue;
                    }
                };
                let through = Arc::clone(&through);
                conns.spawn(async move {
                    if !loopback_peer::admits(peers, &tcp) {
                        return;
                    }
                    if let Ok(mut far) = through().await {
                        let _ = tokio::io::copy_bidirectional(&mut tcp, &mut far).await;
                    }
                });
            }
            Some(_) = conns.join_next(), if !conns.is_empty() => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(raw: &str) -> ServerPage {
        server_page(raw).unwrap()
    }

    /// The connection the pages of most tests belong to.
    fn one() -> ConnectionId {
        ConnectionId::parse("server-one").unwrap()
    }

    #[test]
    fn loopback_web_addresses_are_server_pages() {
        let p = page("http://localhost:3000/app?x=1#top");
        assert_eq!((p.host, p.port), (Loopback::Localhost, 3000));
        assert_eq!(page("http://LOCALHOST:5173").host, Loopback::Localhost);
        assert_eq!(page("http://127.0.0.1:8000/").host, Loopback::V4);
        // WHATWG URL parsing normalises the other spellings of 127.0.0.1.
        assert_eq!(page("http://127.1:8000/").host, Loopback::V4);
        assert_eq!(page("http://[::1]:8080/").host, Loopback::V6);
        assert_eq!(page("http://0.0.0.0:8000/").host, Loopback::Any);
        assert_eq!(page("http://localhost/").port, 80);
        assert_eq!(page("https://localhost/").port, 443);
    }

    #[test]
    fn anything_else_is_refused_and_says_why() {
        for raw in ["ftp://localhost:21/", "file:///etc/passwd", "ssh://localhost:22", "javascript:alert(1)", "postgres://localhost:5432/db"] {
            let e = server_page(raw).unwrap_err();
            assert!(matches!(e, ServerPageError::NotWeb(ref m) if m.contains("http://")), "{raw}: {e:?}");
        }
        assert!(matches!(server_page("not a url"), Err(ServerPageError::NotWeb(_))));
        assert!(matches!(server_page("http://user:pw@localhost:3000/"), Err(ServerPageError::NotWeb(ref m)) if m.contains("username")));
        assert!(matches!(server_page("http://localhost:0/"), Err(ServerPageError::NotWeb(_))));
        for raw in ["https://example.com/", "http://10.0.0.5:3000/", "http://127.0.0.2:3000/", "http://localhost.evil.com/", "http://app.localhost:3000/"] {
            assert_eq!(server_page(raw), Err(ServerPageError::NotLoopback), "{raw}");
        }
    }

    #[test]
    fn ports_for_the_dashboard_and_other_services_than_web_pages_are_refused() {
        for port in [9119, 22, 25, 110, 6000, 10080, 5432, 6379, 27017] {
            let raw = format!("http://localhost:{port}/");
            assert!(matches!(server_page(&raw), Err(ServerPageError::NotWeb(ref m)) if m.contains(&port.to_string())), "{raw}");
        }
        for port in [80, 443, 3000, 5173, 8000, 8080, 9118, 9120] {
            assert_eq!(page(&format!("http://127.0.0.1:{port}/")).port, port);
        }
    }

    #[test]
    fn the_frame_loads_the_same_page_on_the_local_end() {
        assert_eq!(page("http://localhost:3000/a/b?q=1#f").local_url("127.0.0.1", 41234).as_str(), "http://127.0.0.1:41234/a/b?q=1#f");
        assert_eq!(page("https://[::1]/x").local_url("127.0.0.1", 40000).as_str(), "https://127.0.0.1:40000/x");
        let host = Jar::of("hermes", "http://localhost:3000").host();
        assert_eq!(page("http://localhost:3000/a").local_url(&host, 41234).as_str(), format!("http://{host}:41234/a"));
        assert_eq!(page("http://0.0.0.0:8000").at(), "0.0.0.0:8000");
    }

    #[cfg(any(target_os = "linux", windows))]
    #[tokio::test]
    async fn the_tunnel_listens_on_both_loopbacks_at_one_port_and_relays_both() {
        let (ipv4, ipv6) = listen(true).await.unwrap();
        let ipv6 = ipv6.expect("this computer has ::1");
        let port = ipv4.local_addr().unwrap().port();
        assert_eq!(ipv6.local_addr().unwrap(), (std::net::Ipv6Addr::LOCALHOST, port).into());
        assert!(TcpListener::bind((std::net::Ipv6Addr::LOCALHOST, port)).await.is_err(), "no other program can listen at [::1] on the port");

        let peers = Peers::Account(loopback_peer::this_account());
        let (ipv4, ipv6) = (relay_answering(ipv4, "the page", peers).await, relay_answering(ipv6, "the page", peers).await);
        for host in ["127.0.0.1", "[::1]"] {
            let mut s = tokio::net::TcpStream::connect(format!("{host}:{port}")).await.unwrap();
            s.write_all(b"GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").await.unwrap();
            let mut got = String::new();
            s.read_to_string(&mut got).await.unwrap();
            assert!(got.ends_with("the page"), "this account's program is relayed on {host}: {got:?}");
        }
        ipv4.abort();
        ipv6.abort();
    }

    #[tokio::test]
    async fn a_computer_without_ipv6_gets_the_ipv4_listener_alone() {
        #[cfg(unix)]
        let no_family = libc::EAFNOSUPPORT;
        #[cfg(windows)]
        let no_family = windows_sys::Win32::Networking::WinSock::WSAEAFNOSUPPORT;
        assert!(no_ipv6(&std::io::Error::from_raw_os_error(no_family)), "IPv6 is off");
        assert!(no_ipv6(&std::io::ErrorKind::AddrNotAvailable.into()), "no ::1");
        assert!(!no_ipv6(&std::io::ErrorKind::AddrInUse.into()), "something holds [::1] at the port: try another");
        assert!(!no_ipv6(&std::io::ErrorKind::PermissionDenied.into()));
        let (_, ipv6) = listen(false).await.unwrap();
        assert!(ipv6.is_none(), "Linux serves its pages at 127.0.0.1 alone");
    }

    #[test]
    fn each_jar_has_a_host_name_of_its_own_and_keeps_it() {
        let a = Jar::of("hermes", "http://localhost:3000");
        assert_eq!(a.host(), Jar::of("hermes", "http://localhost:3000").host(), "opened again, the same name");
        let names: std::collections::HashSet<String> =
            [&a, &Jar::of("hermes", "http://localhost:8080"), &Jar::of("other", "http://localhost:3000"), &Jar::of("hermes", "https://localhost:3000")]
                .map(Jar::host)
                .into();
        assert_eq!(names.len(), 4, "another port, server or scheme gets another name: {names:?}");
        for name in &names {
            let label = name.strip_suffix(".localhost").unwrap();
            assert!(label.len() == 17 && label.starts_with('p') && label[1..].bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()), "{name}");
        }
    }

    #[test]
    fn ssh_arguments_are_fixed_options_one_forward_and_the_target_last() {
        let args = ssh_args("liam@hermes", Path::new("/run/user/1000/hermes-chat-page-1-1-a/s"), &page("http://localhost:3000/")).unwrap();
        let args: Vec<&str> = args.iter().map(|a| a.to_str().unwrap()).collect();
        assert_eq!(
            args,
            [
                "-N",
                "-T",
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=15",
                "-o",
                "ServerAliveInterval=15",
                "-o",
                "ServerAliveCountMax=3",
                "-o",
                "ControlMaster=no",
                "-o",
                "ControlPath=none",
                "-o",
                "PermitLocalCommand=no",
                "-o",
                "ForwardAgent=no",
                "-o",
                "ForwardX11=no",
                "-o",
                "ForkAfterAuthentication=no",
                "-o",
                "ExitOnForwardFailure=no",
                "-o",
                "StreamLocalBindMask=0177",
                "-o",
                "StreamLocalBindUnlink=yes",
                "-L",
                "/run/user/1000/hermes-chat-page-1-1-a/s:localhost:3000",
                "--",
                "liam@hermes",
            ]
        );
        let fwd = |raw: &str| {
            let a = ssh_args("h", Path::new("/tmp/d/s"), &page(raw)).unwrap();
            a[a.len() - 3].to_str().unwrap().to_owned()
        };
        assert_eq!(fwd("http://127.0.0.1:8000/"), "/tmp/d/s:127.0.0.1:8000");
        assert_eq!(fwd("http://0.0.0.0:8000/"), "/tmp/d/s:127.0.0.1:8000");
        assert_eq!(fwd("http://[::1]:8080/"), "/tmp/d/s:[::1]:8080");
        assert_eq!(fwd("https://localhost/"), "/tmp/d/s:localhost:443");
    }

    #[test]
    fn a_target_that_could_be_an_option_or_more_than_one_argument_is_refused() {
        let p = page("http://localhost:3000/");
        for t in ["", "  ", "-oProxyCommand=sh", "liam@hermes -L 1:2:3", "a\tb", "a\nb"] {
            assert!(ssh_args(t, Path::new("/tmp/d/s"), &p).is_err(), "{t:?}");
        }
        // Surrounding whitespace is trimmed, as the sign-in does.
        let a = ssh_args("  hermes  ", Path::new("/tmp/d/s"), &p).unwrap();
        assert_eq!(a.last().unwrap(), "hermes");
    }

    #[test]
    fn on_windows_each_connection_is_an_ssh_with_the_same_options_that_listens_on_nothing() {
        let p = page("http://[::1]:8080/");
        let stdio = stdio_args("liam@hermes", &p).unwrap();
        let socket = ssh_args("liam@hermes", Path::new("/tmp/d/s"), &p).unwrap();
        assert_eq!(stdio[..stdio.len() - 8], socket[2..socket.len() - 8], "the same options, without -N -T");
        assert_eq!(stdio[stdio.len() - 4..], ["-W", "[::1]:8080", "--", "liam@hermes"]);
        assert!(!stdio.iter().any(|a| a == "-L" || a == "-D" || a == "-R"), "ssh listens on nothing: {stdio:?}");
    }

    #[test]
    fn a_connections_ssh_keeps_no_forward_and_reads_stdin_whatever_the_owners_config_says() {
        let config = std::env::temp_dir().join(format!("hc-ssh-config-{}", std::process::id()));
        std::fs::write(
            &config,
            "Host hermes\n  ClearAllForwardings no\n  StdinNull yes\n  LocalForward 127.0.0.1:47111 127.0.0.1:22\n  \
             DynamicForward 127.0.0.1:47112\n  RemoteForward 47113 127.0.0.1:22\n",
        )
        .unwrap();
        let p = page("http://localhost:3000/");
        let resolved =
            std::process::Command::new("ssh").arg("-F").arg(&config).arg("-G").args(stdio_args("hermes", &p).unwrap()).output().expect("ssh on PATH");
        std::fs::remove_file(&config).unwrap();
        let resolved = String::from_utf8_lossy(&resolved.stdout).to_lowercase();
        let lines: Vec<&str> = resolved.lines().collect();
        assert!(lines.contains(&"clearallforwardings yes"), "{resolved}");
        assert!(lines.contains(&"stdinnull no"), "{resolved}");
        let forwards: Vec<&str> =
            lines.into_iter().filter(|l| ["localforward ", "dynamicforward ", "remoteforward "].iter().any(|f| l.starts_with(f))).collect();
        assert!(forwards.is_empty(), "ssh would listen: {forwards:?}");
    }

    #[test]
    fn lists_what_listens_on_the_server_with_the_tunnels_options_and_no_forward() {
        let p = page("http://localhost:3000/");
        let listing = listening_args(" liam@hermes ").unwrap();
        let tunnel = ssh_args("liam@hermes", Path::new("/tmp/d/s"), &p).unwrap();
        assert_eq!(listing[listing.len() - 4..], ["--", "liam@hermes", "ss", "-ltnpH"]);
        assert!(!listing.iter().any(|a| a == "-L" || a == "-N"));
        let forwarding = tunnel.iter().position(|a| a == "ForkAfterAuthentication=no").unwrap() - 1;
        assert_eq!(listing[..listing.len() - 6], tunnel[1..forwarding], "the tunnel's options up to a tunnel's own");
        assert_eq!(listing[listing.len() - 6..listing.len() - 4], ["-o", "ClearAllForwardings=yes"], "and no forward from the owner's config");
        assert!(listening_args("-oProxyCommand=x").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_socket_path_that_could_split_the_forward_is_refused() {
        let p = page("http://localhost:3000/");
        for s in ["relative/s", "/tmp/a:b/s", "/tmp/a b/s", &format!("/{}", "x".repeat(120))] {
            assert!(ssh_args("h", Path::new(s), &p).is_err(), "{s}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn socket_folders_are_private_new_and_removed() {
        use std::os::unix::fs::PermissionsExt;
        let a = SocketDir::new().unwrap();
        let b = SocketDir::new().unwrap();
        assert_ne!(a.0, b.0);
        assert_eq!(std::fs::metadata(&a.0).unwrap().permissions().mode() & 0o777, 0o700);
        let path = a.0.clone();
        std::fs::write(a.socket(), b"").unwrap();
        drop(a);
        assert!(!path.exists());
    }

    /// A stand-in for `ssh` that really forwards: it listens on the `-L` socket and connects each connection to the
    /// forward's host and port here, saying what real ssh says when that fails. It writes its pid and socket to
    /// `<dir>/ran`. With `fail`, it prints a real ssh error and exits 255 instead.
    #[cfg(unix)]
    const FAKE_SSH: &str = r#"
import os, socket, sys, threading
d, mode = sys.argv[1], sys.argv[2]
args = sys.argv[3:]
if mode == "fail":
    sys.stderr.write("ssh: Could not resolve hostname nowhere: Name or service not known\n")
    sys.exit(255)
sock, rest = args[args.index("-L") + 1].split(":", 1)
host, port = rest.rsplit(":", 1)
host = {"localhost": "127.0.0.1", "[::1]": "::1"}.get(host, host)
with open(os.path.join(d, "ran"), "w") as f:
    f.write(f"{os.getpid()}\n{sock}\n{' '.join(args)}\n")
if mode == "slow":
    import time
    time.sleep(30)
os.umask(0o177)
srv = socket.socket(socket.AF_UNIX)
srv.bind(sock)
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
    try:
        r = socket.create_connection((host, int(port)))
    except OSError as e:
        sys.stderr.write(f"channel 2: open failed: connect failed: {e.strerror}\n")
        sys.stderr.flush()
        c.close()
        return
    threading.Thread(target=pump, args=(c, r), daemon=True).start()
    pump(r, c)
while True:
    c, _ = srv.accept()
    threading.Thread(target=handle, args=(c,), daemon=True).start()
"#;

    /// A fake ssh program for one test: a script that runs `FAKE_SSH` with this test's folder and `mode`.
    #[cfg(unix)]
    struct Fake {
        dir: PathBuf,
        program: String,
    }

    #[cfg(unix)]
    impl Fake {
        fn new(name: &str, mode: &str) -> Fake {
            let dir = std::env::temp_dir().join(format!("hermes-chat-fake-ssh-{}-{name}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("fake.py"), FAKE_SSH).unwrap();
            let program = dir.join("ssh");
            crate::test_common::write_executable(&program, &format!("#!/bin/sh\nexec python3 {}/fake.py {} {mode} \"$@\"\n", dir.display(), dir.display()));
            Fake { program: program.to_str().unwrap().to_owned(), dir }
        }

        /// Whether the fake has started and written down what it was given.
        fn started(&self) -> bool {
            std::fs::read_to_string(self.dir.join("ran")).is_ok_and(|t| t.lines().count() == 3)
        }

        /// The fake's pid, its socket, and the arguments it was given.
        fn ran(&self) -> (i32, PathBuf, String) {
            let text = std::fs::read_to_string(self.dir.join("ran")).unwrap();
            let mut lines = text.lines();
            (lines.next().unwrap().parse().unwrap(), lines.next().unwrap().into(), lines.next().unwrap().into())
        }
    }

    #[cfg(unix)]
    impl Drop for Fake {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// Whether `pid` has ended (gone, or a zombie no one reaped yet).
    #[cfg(unix)]
    fn ended(pid: i32) -> bool {
        match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            Err(_) => true,
            Ok(stat) => stat.rsplit(')').next().is_some_and(|rest| rest.trim_start().starts_with('Z')),
        }
    }

    #[cfg(unix)]
    async fn until(what: &str, mut f: impl FnMut() -> bool) {
        for _ in 0..100 {
            if f() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("timed out waiting until {what}");
    }

    /// A web server on this computer's loopback, standing in for the dev server on the server's, answering every
    /// request with `body`.
    #[cfg(unix)]
    async fn web_server(body: &'static str) -> u16 {
        let l = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let Ok((mut s, _)) = l.accept().await else { return };
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    let _ = s.read(&mut buf).await;
                    let reply = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                    let _ = s.write_all(reply.as_bytes()).await;
                });
            }
        });
        port
    }

    async fn get(url: &str) -> std::io::Result<String> {
        let u = Url::parse(url).unwrap();
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", u.port().unwrap())).await?;
        s.write_all(format!("GET {} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n", u.path()).as_bytes()).await?;
        let mut out = String::new();
        s.read_to_string(&mut out).await?;
        Ok(out)
    }

    #[cfg(unix)]
    static KEYS: AtomicU64 = AtomicU64::new(0);

    /// Registers and opens a page, as `preview_server_open` does, under a new key.
    #[cfg(unix)]
    async fn open_page(
        pages: &Arc<ServerPages>,
        program: &str,
        target: &str,
        raw: &str,
        on_event: impl Fn(PageEvent) + Send + 'static,
    ) -> Result<Opened, ServerPageError> {
        let key = format!("k{}", KEYS.fetch_add(1, Ordering::Relaxed));
        let starting = pages.begin(&key, &one(), target)?;
        pages.open(program, starting, page(raw), on_event).await
    }

    #[cfg(unix)]
    type Events = Arc<Mutex<Vec<PageEvent>>>;

    #[cfg(unix)]
    fn events() -> (Events, impl Fn(PageEvent) + Send + 'static) {
        let got: Events = Arc::default();
        let into = got.clone();
        (got, move |e| into.locked().push(e))
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_page_opens_through_ssh_on_its_own_local_port_and_closing_it_ends_ssh() {
        let fake = Fake::new("open-close", "ok");
        let port = web_server("from the server").await;
        let pages = Arc::new(ServerPages::default());
        let (got, on_event) = events();
        let opened = open_page(&pages, &fake.program, "liam@hermes", &format!("http://localhost:{port}/app"), on_event).await.unwrap();

        let local = Url::parse(&opened.url).unwrap();
        assert_eq!(local.host_str(), Some("127.0.0.1"));
        assert_ne!(local.port(), Some(port));
        assert_eq!(local.path(), "/app");
        assert_eq!((opened.target.as_str(), opened.at.clone()), ("liam@hermes", format!("localhost:{port}")));
        assert!(get(&opened.url).await.unwrap().ends_with("from the server"));

        let (pid, socket, args) = fake.ran();
        assert!(args.ends_with(&format!(":localhost:{port} -- liam@hermes")), "{args}");
        assert!(!ended(pid));
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(socket.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
        assert_eq!(pages.len(), 1);

        pages.close(&opened.id);
        until("ssh ends", || ended(pid)).await;
        until("the socket's folder is gone", || !socket.parent().unwrap().exists()).await;
        until("the local port closes", || std::net::TcpStream::connect(("127.0.0.1", local.port().unwrap())).is_err()).await;
        assert!(pages.is_empty());
        // The webview closed it, so it isn't told.
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(got.locked().is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_port_nothing_listens_on_says_so_and_leaves_nothing_running() {
        let fake = Fake::new("closed-port", "ok");
        let closed = crate::test_common::refusing();
        let port = closed.addr.port();
        let pages = Arc::new(ServerPages::default());
        let e = open_page(&pages, &fake.program, "hermes", &format!("http://127.0.0.1:{port}/"), |_| {}).await.unwrap_err();
        match &e {
            ServerPageError::PortClosed { at, detail } => {
                assert_eq!(at, &format!("127.0.0.1:{port}"));
                assert!(detail.as_deref().is_some_and(|d| d.contains("open failed")), "{detail:?}");
            }
            e => panic!("{e:?}"),
        }
        let (pid, socket, _) = fake.ran();
        until("ssh ends", || ended(pid)).await;
        assert!(!socket.parent().unwrap().exists());
        assert!(pages.is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn ssh_failing_says_what_ssh_said() {
        let fake = Fake::new("fails", "fail");
        let pages = Arc::new(ServerPages::default());
        let e = open_page(&pages, &fake.program, "nowhere", "http://localhost:3000/", |_| {}).await.unwrap_err();
        assert_eq!(e, ServerPageError::Ssh("ssh: Could not resolve hostname nowhere: Name or service not known".into()));
        assert!(pages.is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn no_ssh_target_is_refused_before_ssh_runs() {
        let fake = Fake::new("no-target", "ok");
        let pages = Arc::new(ServerPages::default());
        for t in ["", "-oProxyCommand=x"] {
            let e = open_page(&pages, &fake.program, t, "http://localhost:3000/", |_| {}).await.unwrap_err();
            assert_eq!(e, ServerPageError::NoSshTarget);
        }
        assert!(!fake.dir.join("ran").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn ssh_ending_on_its_own_tells_the_page() {
        let fake = Fake::new("ssh-dies", "ok");
        let port = web_server("x").await;
        let pages = Arc::new(ServerPages::default());
        let (got, on_event) = events();
        let opened = open_page(&pages, &fake.program, "hermes", &format!("http://localhost:{port}/"), on_event).await.unwrap();
        let (pid, socket, _) = fake.ran();
        unsafe { libc::kill(pid, libc::SIGKILL) };
        until("the page hears", || !got.locked().is_empty()).await;
        assert!(matches!(&got.locked()[0], PageEvent::Closed { message } if message.starts_with("ssh ended")));
        until("the socket's folder is gone", || !socket.parent().unwrap().exists()).await;
        assert!(pages.is_empty());
        pages.close(&opened.id);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn leaving_the_server_closes_its_pages_and_says_why() {
        let a = Fake::new("leave-a", "ok");
        let b = Fake::new("leave-b", "ok");
        let port = web_server("x").await;
        let pages = Arc::new(ServerPages::default());
        let (got_a, on_a) = events();
        let (got_b, on_b) = events();
        open_page(&pages, &a.program, "a", &format!("http://localhost:{port}/"), on_a).await.unwrap();
        open_page(&pages, &b.program, "b", &format!("http://localhost:{port}/"), on_b).await.unwrap();
        let (pid_a, pid_b) = (a.ran().0, b.ran().0);

        // Another connection going takes neither.
        pages.close_for(&ConnectionId::parse("server-two").unwrap(), None, "elsewhere");
        assert_eq!(pages.len(), 2);
        // Signed in through `a` again: only `b`'s page goes.
        pages.close_for(&one(), Some("a"), "moved");
        until("b's ssh ends", || ended(pid_b)).await;
        assert_eq!(*got_b.locked(), [PageEvent::Closed { message: "moved".into() }]);
        assert!(!ended(pid_a));
        assert_eq!(pages.len(), 1);

        pages.close_for(&one(), None, "signed out");
        until("a's ssh ends", || ended(pid_a)).await;
        assert_eq!(*got_a.locked(), [PageEvent::Closed { message: "signed out".into() }]);
        assert!(pages.is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn several_pages_open_at_once_up_to_the_limit() {
        let port = web_server("x").await;
        let pages = Arc::new(ServerPages::default());
        let fakes: Vec<Fake> = (0..MAX_OPEN).map(|i| Fake::new(&format!("many-{i}"), "ok")).collect();
        let mut ids = Vec::new();
        for f in &fakes {
            ids.push(open_page(&pages, &f.program, "hermes", &format!("http://localhost:{port}/"), |_| {}).await.unwrap().id);
        }
        assert_eq!(pages.len(), MAX_OPEN);
        let extra = Fake::new("many-extra", "ok");
        let e = open_page(&pages, &extra.program, "hermes", &format!("http://localhost:{port}/"), |_| {}).await.unwrap_err();
        assert_eq!(e, ServerPageError::TooMany);
        assert!(!extra.dir.join("ran").exists());
        // Each closes on its own.
        pages.close(&ids[0]);
        until("one closes", || pages.len() == MAX_OPEN - 1).await;
        pages.close_all("done");
        until("all close", || pages.is_empty()).await;
        for f in &fakes {
            let pid = f.ran().0;
            until("ssh ends", || ended(pid)).await;
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn each_page_has_a_cookie_jar_of_its_own_and_gets_it_back_when_opened_again() {
        let (a, b) = (web_server("a").await, web_server("b").await);
        let pages = Arc::new(ServerPages::default());
        let fakes: Vec<Fake> = (0..4).map(|i| Fake::new(&format!("jar-{i}"), "ok")).collect();
        let url = |port: u16| format!("http://localhost:{port}/");
        let jar = |opened: &Opened| pages.jar(&Url::parse(&opened.url).unwrap());
        let first_a = open_page(&pages, &fakes[0].program, "hermes", &url(a), |_| {}).await.unwrap();
        let on_b = open_page(&pages, &fakes[1].program, "hermes", &url(b), |_| {}).await.unwrap();
        let elsewhere_a = open_page(&pages, &fakes[2].program, "other", &url(a), |_| {}).await.unwrap();
        assert!(jar(&first_a).is_some());
        assert_ne!(jar(&first_a), jar(&on_b), "another port on the same server");
        assert_ne!(jar(&first_a), jar(&elsewhere_a), "the same port on another server");

        let first_jar = jar(&first_a);
        pages.close(&first_a.id);
        until("it closes", || pages.len() == 2).await;
        assert_eq!(jar(&first_a), None, "a closed page's local port is no page's");
        let again_a = open_page(&pages, &fakes[3].program, "hermes", &url(a), |_| {}).await.unwrap();
        assert_eq!(jar(&again_a), first_jar, "opened again, on another local port");

        let b_port = Url::parse(&on_b.url).unwrap().port().unwrap();
        for not_local in [format!("http://localhost:{b_port}/"), format!("http://127.0.0.1:{a}/"), "https://example.com/".into()] {
            assert_eq!(pages.jar(&Url::parse(&not_local).unwrap()), None, "{not_local}");
        }
        pages.close_all("done");
        until("all close", || pages.is_empty()).await;
    }

    #[cfg(unix)]
    #[test]
    fn ssh_outlives_the_thread_that_asked_for_it() {
        // Asked for from a thread that then ends, as a tokio worker can after `block_in_place`. The child is forgotten,
        // so only the death signal could end it, and that follows the spawner thread, which lives on.
        let pid = std::thread::spawn(|| {
            let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
            rt.block_on(async {
                let child = spawn_ssh("sleep", &["1000".into()], Stdio::null()).await.unwrap();
                let pid = child.id().unwrap() as i32;
                std::mem::forget(child);
                pid
            })
        })
        .join()
        .unwrap();
        std::thread::sleep(Duration::from_millis(500));
        let alive = !ended(pid);
        unsafe {
            libc::kill(pid, libc::SIGKILL);
            libc::waitpid(pid, std::ptr::null_mut(), 0);
        }
        assert!(alive, "sleep died with the thread that asked for it");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn closing_a_page_while_ssh_connects_ends_ssh_at_once() {
        let fake = Fake::new("close-starting", "slow");
        let pages = Arc::new(ServerPages::default());
        let starting = pages.begin("starting-1", &one(), "hermes").unwrap();
        let p = Arc::clone(&pages);
        let program = fake.program.clone();
        let opening = tokio::spawn(async move { p.open(&program, starting, page("http://localhost:3000/"), |_| {}).await });
        until("ssh starts", || fake.started()).await;
        let (pid, socket, _) = fake.ran();
        assert_eq!(pages.len(), 1);

        pages.close("starting-1");
        assert_eq!(opening.await.unwrap().unwrap_err(), ServerPageError::Closed(None));
        until("ssh ends", || ended(pid)).await;
        until("the socket's folder is gone", || !socket.parent().unwrap().exists()).await;
        assert!(pages.is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn leaving_the_server_while_a_page_connects_ends_it_and_says_why() {
        for leave in ["all", "other"] {
            let fake = Fake::new(&format!("leave-starting-{leave}"), "slow");
            let pages = Arc::new(ServerPages::default());
            let starting = pages.begin(&format!("leave-{leave}"), &one(), "old-server").unwrap();
            let p = Arc::clone(&pages);
            let program = fake.program.clone();
            let opening = tokio::spawn(async move { p.open(&program, starting, page("http://localhost:3000/"), |_| {}).await });
            until("ssh starts", || fake.started()).await;
            let pid = fake.ran().0;
            if leave == "all" {
                pages.close_for(&one(), None, "signed out");
            } else {
                pages.close_for(&one(), Some("new-server"), "moved");
            }
            let why = if leave == "all" { "signed out" } else { "moved" };
            assert_eq!(opening.await.unwrap().unwrap_err(), ServerPageError::Closed(Some(why.into())));
            until("ssh ends", || ended(pid)).await;
            assert!(pages.is_empty());
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_page_closed_before_rust_heard_of_it_never_starts() {
        let fake = Fake::new("closed-early", "ok");
        let pages = Arc::new(ServerPages::default());
        pages.close("early-1");
        assert_eq!(pages.begin("early-1", &one(), "hermes").err(), Some(ServerPageError::Closed(None)));
        // Only once: the key may be used again after.
        let starting = pages.begin("early-1", &one(), "hermes").unwrap();
        pages.close("early-1");
        assert!(pages.open(&fake.program, starting, page("http://localhost:3000/"), |_| {}).await.is_err());
        assert!(!fake.dir.join("ran").exists());
        // Keys are short and plain.
        for bad in ["", "a b", "../x", &"k".repeat(65)] {
            assert!(matches!(pages.begin(bad, &one(), "hermes"), Err(ServerPageError::Io(_))), "{bad:?}");
        }
        assert!(pages.is_empty());
    }

    #[test]
    fn a_tunnel_given_up_before_it_opens_leaves_nothing_registered() {
        let pages = ServerPages::default();
        let starting = pages.begin("lost-1", &one(), "hermes").unwrap();
        pages.give_up(starting);
        assert!(pages.is_empty());
        assert!(pages.begin("lost-1", &one(), "hermes").is_ok(), "its key is free again");
    }

    #[test]
    fn a_close_racing_its_own_open_always_ends_it() {
        // Whichever runs first, a page closed while it begins either never registers or is told to stop.
        let pages = Arc::new(ServerPages::default());
        for i in 0..3000 {
            let key = format!("race-{i}");
            let barrier = Arc::new(std::sync::Barrier::new(2));
            let (p, b, k) = (Arc::clone(&pages), Arc::clone(&barrier), key.clone());
            let closer = std::thread::spawn(move || {
                b.wait();
                p.close(&k);
            });
            barrier.wait();
            let began = pages.begin(&key, &one(), "hermes");
            closer.join().unwrap();
            match began {
                Err(e) => assert_eq!(e, ServerPageError::Closed(None)),
                Ok(mut starting) => {
                    assert_eq!(starting.stopped.try_recv(), Ok(None), "{key} was registered and never stopped");
                }
            }
            assert!(pages.is_empty(), "{key} is still registered");
        }
    }

    /// A TLS alert record, as a server sends when it can't agree on a handshake.
    const TLS_ALERT: [u8; 7] = [0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x28];

    /// A stand-in for a TLS server: it says nothing until spoken to, answers a ClientHello, and drops plain text without
    /// a word, as OpenSSL does with an HTTP request.
    #[cfg(unix)]
    async fn tls_like_server() -> u16 {
        let l = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let Ok((mut s, _)) = l.accept().await else { return };
                tokio::spawn(async move {
                    let mut buf = [0u8; 6];
                    if s.read_exact(&mut buf).await.is_ok() && buf[0] == 0x16 && buf[5] == 0x01 {
                        let _ = s.write_all(&TLS_ALERT).await;
                    }
                });
            }
        });
        port
    }

    #[tokio::test]
    async fn a_tls_server_answers_the_https_probe_without_a_fixed_wait() {
        let (probe, mut server) = tokio::io::duplex(4096);
        tokio::spawn(async move {
            let mut head = [0u8; 6];
            server.read_exact(&mut head).await.unwrap();
            assert_eq!((head[0], head[5]), (0x16, 0x01), "a handshake record holding a ClientHello");
            server.write_all(&TLS_ALERT).await.unwrap();
        });
        let start = std::time::Instant::now();
        assert!(answers(probe, &page("https://localhost:8443/"), PROBE_TIMEOUT).await);
        assert!(start.elapsed() < Duration::from_secs(1), "{:?}", start.elapsed());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn an_https_page_opens_without_plain_text_being_sent_to_it() {
        let fake = Fake::new("https", "ok");
        let port = tls_like_server().await;
        let pages = Arc::new(ServerPages::default());
        let opened = open_page(&pages, &fake.program, "hermes", &format!("https://localhost:{port}/"), |_| {}).await.unwrap();
        assert!(opened.url.starts_with("https://127.0.0.1:"));
        pages.close(&opened.id);
        // The same server over http gets a HEAD, drops it, and counts as not answering.
        let e = open_page(&pages, &fake.program, "hermes", &format!("http://localhost:{port}/"), |_| {}).await.unwrap_err();
        assert!(matches!(e, ServerPageError::PortClosed { .. }), "{e:?}");
        // A closed https port is still found out.
        let closed = crate::test_common::refusing();
        let e = open_page(&pages, &fake.program, "hermes", &format!("https://localhost:{}/", closed.addr.port()), |_| {}).await.unwrap_err();
        assert!(matches!(e, ServerPageError::PortClosed { .. }), "{e:?}");
    }

    /// Against real OpenSSH, when `HERMES_REAL_SSH` names an ssh program (a wrapper with its own `-F`) and
    /// `HERMES_REAL_SSH_TARGET` a target whose loopback serves a page on `localhost:5173` (IPv6 only, as Vite binds)
    /// and `127.0.0.1:8000`, with nothing on port 5999. Run with `--ignored`.
    #[cfg(unix)]
    #[tokio::test]
    #[ignore = "needs a real sshd: HERMES_REAL_SSH and HERMES_REAL_SSH_TARGET"]
    async fn real_ssh_forwards_to_the_servers_loopback_and_cleans_up() {
        let (Ok(program), Ok(target)) = (std::env::var("HERMES_REAL_SSH"), std::env::var("HERMES_REAL_SSH_TARGET")) else {
            panic!("set HERMES_REAL_SSH and HERMES_REAL_SSH_TARGET");
        };
        let pages = Arc::new(ServerPages::default());
        for raw in ["http://localhost:5173/", "http://[::1]:5173/", "http://127.0.0.1:8000/", "http://0.0.0.0:8000/"] {
            let opened = open_page(&pages, &program, &target, raw, |_| {}).await.unwrap_or_else(|e| panic!("{raw}: {e}"));
            let body = get(&opened.url).await.unwrap();
            assert!(body.starts_with("HTTP/1.0 200") || body.starts_with("HTTP/1.1 200"), "{raw}: {body}");
            pages.close(&opened.id);
        }
        until("every tunnel closes", || pages.is_empty()).await;
        let e = open_page(&pages, &program, &target, "http://localhost:5999/", |_| {}).await.unwrap_err();
        assert!(matches!(&e, ServerPageError::PortClosed { detail: Some(d), .. } if d.contains("open failed")), "{e:?}");
        // Nothing of this process's is left running (another Hermes Chat's tunnels may be).
        let ours = || {
            std::fs::read_dir("/proc")
                .unwrap()
                .filter_map(|e| std::fs::read_to_string(e.ok()?.path().join("cmdline")).ok())
                .filter(|c| c.contains(&format!("hermes-chat-page-{}-", std::process::id())))
                .map(|c| c.replace('\0', " "))
                .collect::<Vec<_>>()
        };
        eprintln!("right after: {:?}", ours());
        for _ in 0..100 {
            if ours().is_empty() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("still running: {:?}", ours());
    }

    #[cfg(unix)]
    #[test]
    fn folders_left_by_an_app_that_is_gone_are_swept_and_nothing_else() {
        let base = std::env::temp_dir().join(format!("hermes-chat-sweep-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let make = |name: &str, files: &[&str]| {
            let d = base.join(name);
            std::fs::create_dir(&d).unwrap();
            for f in files {
                std::fs::write(d.join(f), b"").unwrap();
            }
            d
        };
        let gone = make("hermes-chat-page-111-0-abc", &["s"]);
        let running = make("hermes-chat-page-222-0-abc", &["s"]);
        let mine = make(&format!("hermes-chat-page-{}-0-abc", std::process::id()), &["s"]);
        // A folder with more than ssh's socket in it isn't ours to empty.
        let other = make("hermes-chat-page-333-0-abc", &["s", "notes.txt"]);
        let unrelated = make("something-else-111", &["s"]);
        sweep(&base, |pid| pid == 222);
        assert!(!gone.exists());
        assert!(running.join("s").exists());
        assert!(mine.join("s").exists());
        assert!(other.join("notes.txt").exists());
        assert!(unrelated.join("s").exists());
        std::fs::remove_dir_all(&base).unwrap();
    }

    /// The relay's port, in front of a stand-in for ssh that answers every request with `body`, serving programs run by
    /// `account`.
    async fn relay_for(body: &'static str, account: loopback_peer::Account) -> u16 {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        relay_answering(listener, body, Peers::Account(account)).await;
        port
    }

    /// The relay on `listener`, for `peers`, in front of a stand-in for ssh that answers every request with `body`.
    async fn relay_answering(listener: TcpListener, body: &'static str, peers: Peers) -> tokio::task::JoinHandle<Infallible> {
        let ssh = ssh_answering(body).await;
        tokio::spawn(async move {
            let listener = &listener;
            serve_with(|| listener.accept(), move || tokio::net::TcpStream::connect(("127.0.0.1", ssh)), peers).await
        })
    }

    /// A stand-in for ssh's end of a tunnel, answering every request with `body`: its port.
    async fn ssh_answering(body: &'static str) -> u16 {
        let ssh = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = ssh.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut s, _)) = ssh.accept().await {
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    let _ = s.read(&mut buf).await;
                    let reply = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                    let _ = s.write_all(reply.as_bytes()).await;
                });
            }
        });
        port
    }

    /// A failed accept (a connection reset before it was taken, or no file descriptors left) doesn't end the relay: the
    /// next connection is still relayed.
    #[cfg(any(target_os = "linux", windows))]
    #[tokio::test]
    async fn the_relay_outlives_a_failed_accept() {
        let ssh = ssh_answering("the dashboard").await;
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let mut failed = false;
            let accept = || {
                let fail = !std::mem::replace(&mut failed, true);
                let listener = &listener;
                async move {
                    if fail {
                        return Err(std::io::Error::from(std::io::ErrorKind::ConnectionAborted));
                    }
                    listener.accept().await
                }
            };
            serve_with(accept, move || tokio::net::TcpStream::connect(("127.0.0.1", ssh)), Peers::Account(loopback_peer::this_account())).await
        });
        let got = tokio::time::timeout(Duration::from_secs(5), get(&format!("http://127.0.0.1:{port}/"))).await.expect("the relay didn't answer");
        assert!(got.as_deref().is_ok_and(|g| g.ends_with("the dashboard")), "{got:?}");
    }

    /// An account this test never runs as.
    #[cfg(any(target_os = "linux", windows))]
    fn another_account() -> loopback_peer::Account {
        #[cfg(target_os = "linux")]
        return loopback_peer::this_account() + 1;
        #[cfg(windows)]
        return loopback_peer::local_system();
    }

    #[cfg(any(target_os = "linux", windows))]
    #[tokio::test]
    async fn the_relay_answers_this_accounts_programs_and_closes_on_any_other_accounts() {
        let port = relay_for("the dashboard", loopback_peer::this_account()).await;
        let mine = get(&format!("http://127.0.0.1:{port}/")).await.unwrap();
        assert!(mine.ends_with("the dashboard"), "this account's program is relayed: {mine:?}");

        // A relay that serves another account: this program's real connection is then a stranger's.
        let port = relay_for("the dashboard", another_account()).await;
        let theirs = get(&format!("http://127.0.0.1:{port}/")).await.unwrap_or_default();
        assert_eq!(theirs, "", "another account's program gets nothing");
    }

    /// A real sign-in tunnel and a real server page, through the `ssh` on PATH to `$TUNNEL_TARGET`, for
    /// `.github/windows-relay/other-account.ps1`. The tunnel reaches the server's port `$TUNNEL_DASHBOARD_PORT`, the
    /// page `http://127.0.0.1:$TUNNEL_PAGE_PORT/`. It writes this process's id and both relay ports to
    /// `$RELAY_DIR/ports`, and keeps both open until the script writes `$RELAY_DIR/done`. First, a page on
    /// `$TUNNEL_CLOSED_PORT`, where nothing listens, and a tunnel and a page through `$TUNNEL_UNREACHABLE_TARGET`,
    /// where no sshd listens, must each fail and say why.
    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "run by .github/windows-relay/other-account.ps1"]
    async fn real_tunnels_for_a_program_run_by_another_account() {
        let var = |name: &str| std::env::var(name).unwrap_or_else(|_| panic!("{name} isn't set"));
        let dir = std::path::PathBuf::from(var("RELAY_DIR"));
        let target = var("TUNNEL_TARGET");
        let pages = Arc::new(ServerPages::default());
        let open = |key: &str, target: &str, raw: String| {
            let starting = pages.begin(key, &one(), target).unwrap();
            pages.open("ssh", starting, page(&raw), |_| {})
        };

        let closed = open("closed", &target, format!("http://127.0.0.1:{}/", var("TUNNEL_CLOSED_PORT"))).await.unwrap_err();
        assert!(matches!(&closed, ServerPageError::PortClosed { detail: Some(d), .. } if d.contains("open failed")), "{closed:?}");
        let unreachable = var("TUNNEL_UNREACHABLE_TARGET");
        let no_sshd = open("no-sshd", &unreachable, format!("http://127.0.0.1:{}/", var("TUNNEL_PAGE_PORT"))).await.unwrap_err();
        assert!(matches!(&no_sshd, ServerPageError::Ssh(said) if said.contains("port")), "{no_sshd:?}");
        let no_sshd = crate::tunnel::open(&unreachable, 8765).await.err().expect("no tunnel opens without an sshd");
        assert!(matches!(&no_sshd, crate::tunnel::TunnelError::Ssh(said) if said.contains("port")), "{no_sshd:?}");

        let dashboard = crate::tunnel::open(&target, var("TUNNEL_DASHBOARD_PORT").parse().unwrap()).await.expect("the sign-in tunnel opens");
        let opened = open("probe", &target, format!("http://127.0.0.1:{}/", var("TUNNEL_PAGE_PORT"))).await.expect("the page opens");
        let page_port = Url::parse(&opened.url).unwrap().port().unwrap();
        std::fs::write(dir.join("ports"), format!("{} {} {page_port}", std::process::id(), dashboard.local_port)).unwrap();
        for _ in 0..600 {
            if dir.join("done").exists() {
                return;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        panic!("the script never wrote done");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_listing_longer_than_kept_is_cut_at_a_whole_line() {
        const LINE: &str = r#"LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:(("node",pid=1,fd=1))"#;
        let dir = std::env::temp_dir().join(format!("hermes-chat-long-ss-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let program = dir.join("ssh");
        crate::test_common::write_executable(&program, &format!("#!/bin/sh\nyes '{LINE}' | head -c 300000\n"));
        let out = listening(program.to_str().unwrap(), "liam@hermes").await.expect("a long listing is cut, not failed");
        assert!(out.len() as u64 <= LISTENING_KEPT);
        assert!(out.lines().all(|l| l == LINE), "every line kept is whole");
        assert_eq!(crate::dev_servers::parse_ss(&out).iter().map(|l| l.port).collect::<Vec<_>>(), [5173]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn errors_reach_the_webview_with_a_kind() {
        let v = serde_json::to_value(ServerPageError::NoSshTarget).unwrap();
        assert_eq!(v["kind"], "noSshTarget");
        assert!(v["message"].as_str().unwrap().contains("dashboard URL"));
        let v = serde_json::to_value(ServerPageError::PortClosed { at: "localhost:3000".into(), detail: None }).unwrap();
        assert_eq!(v["kind"], "portClosed");
        assert_eq!(v["message"], "Nothing on the Hermes server answered at localhost:3000.");
    }
}
