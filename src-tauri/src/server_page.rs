//! Pages on the Hermes server's own loopback in the Preview (ADR 0114): `http://localhost:3000` in a reply means the
//! server's port 3000, where Hermes ran the dev server, not this computer's.
//!
//! Each page gets a tunnel of its own, made of two parts:
//!
//! - The owner's `ssh` to the signed-in connection's SSH target, forwarding a Unix socket in a private folder (0700) to
//!   the page's loopback host and port on the server: `ssh -N -L <socket>:<host>:<port> -- <target>`. Every argument is
//!   one `Command` argument: the host is one of three fixed strings, the port a number, the socket a path this module
//!   made, and the target is the one Rust signed in with, checked as the sign-in tunnel checks it. No shell runs.
//!   Windows' OpenSSH can't listen on a Unix socket, so there ssh listens on a loopback port instead (`LocalEnd`), and
//!   each connection to it is used only if ssh holds its far end (ADR 0140).
//! - A TCP listener Rust binds on `127.0.0.1:0` and keeps, so the port is ephemeral and never released for another
//!   program to take before ssh binds it. Each connection the frame makes is copied to and from ssh's socket. On
//!   Linux and Windows, a connection from a program run by another account is closed unanswered (`loopback_peer`,
//!   ADR 0105).
//!
//! The webview names only the page's address. Rust parses it again and refuses anything that isn't an http(s) address
//! on the server's loopback, or is on a port that isn't for web pages; it never takes an ssh host, option or socket
//! path from the webview.
//!
//! A tunnel is registered before ssh starts, and ends when the webview closes it (the page leaves the Preview, even
//! while it is still connecting), when ssh exits, when the sign-in goes or moves to another SSH target, and when the
//! app exits: ssh is started with `PR_SET_PDEATHSIG` from a thread that lives as long as the app (on Windows, in a job
//! object that is closed with the app), so even an app that crashes takes it along.

use crate::loopback_peer::{self, Peers};
use serde::Serialize;
use std::collections::HashMap;
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

/// How long ssh has to sign in and listen on its socket.
const READY_TIMEOUT: Duration = Duration::from_secs(20);
/// How long the first request through a new tunnel waits for any answer before the page is shown anyway.
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

    /// The same page through the tunnel's local end: only the host and port change.
    pub fn local_url(&self, local_port: u16) -> Url {
        let mut u = self.url.clone();
        u.set_host(Some("127.0.0.1")).expect("an http(s) URL takes an IP host");
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

/// An SSH target as the sign-in tunnel takes it: no leading '-', which ssh would read as an option, and no whitespace.
pub fn checked_target(target: &str) -> Option<&str> {
    let target = target.trim();
    (!target.is_empty() && !target.starts_with('-') && !target.contains(char::is_whitespace)).then_some(target)
}

/// ssh's arguments for a tunnel from `socket` to `page` on `target`'s loopback.
///
/// - `-N`, `-T`: no command, no terminal; stdin is closed.
/// - `BatchMode`: nothing to answer a prompt with, so a key that needs one fails rather than waiting.
/// - No `StrictHostKeyChecking=accept-new`: the sign-in already knows this host's key; a new one is refused.
/// - `ControlMaster=no`, `ControlPath=none`: with the owner's ControlMaster, the forward would be set up in that
///   master and outlive this ssh. Now it ends with it.
/// - `ForkAfterAuthentication=no`: the owner's config can't send ssh to the background, where it would leave this
///   process (and its death signal) behind. `PermitLocalCommand=no`: nor run a command of its own here.
/// - `ExitOnForwardFailure=no`: a `LocalForward` in the owner's config for this host is opened by every ssh to it, and
///   the sign-in tunnel holds its port already, so with `yes` it would end every tunnel. Whether this tunnel's own
///   forward works is seen directly: its socket accepts, or ssh names the socket in an error (`open`).
/// - `StreamLocalBindMask=0177`: only the owner can connect to the socket (its folder is 0700 as well).
pub fn ssh_args(target: &str, socket: &Path, page: &ServerPage) -> Result<Vec<OsString>, ServerPageError> {
    let target = checked_target(target).ok_or_else(|| ServerPageError::Ssh("The sign-in's SSH target isn't one ssh can take.".into()))?;
    let socket = socket.to_str().filter(|s| socket_path_ok(s)).ok_or_else(|| ServerPageError::Io("The tunnel's socket path isn't usable.".into()))?;
    Ok(forward_args(target, socket, page))
}

/// `ssh_args` with ssh listening on `127.0.0.1:<port>` of this computer instead of a socket, as on Windows.
pub fn tcp_ssh_args(target: &str, port: u16, page: &ServerPage) -> Result<Vec<OsString>, ServerPageError> {
    let target = checked_target(target).ok_or_else(|| ServerPageError::Ssh("The sign-in's SSH target isn't one ssh can take.".into()))?;
    if port == 0 {
        return Err(ServerPageError::Io("The tunnel's local port isn't usable.".into()));
    }
    Ok(forward_args(target, &format!("127.0.0.1:{port}"), page))
}

fn forward_args(target: &str, listen: &str, page: &ServerPage) -> Vec<OsString> {
    let forward = format!("{listen}:{}:{}", page.host.forward_host(), page.port);
    let mut args: Vec<OsString> = ["-N"].iter().chain(SSH_OPTIONS).chain(&["-L"]).map(OsString::from).collect();
    args.push(forward.into());
    args.push("--".into());
    args.push(target.into());
    args
}

pub fn listening_args(target: &str) -> Result<Vec<OsString>, ServerPageError> {
    let target = checked_target(target).ok_or_else(|| ServerPageError::Ssh("The sign-in's SSH target isn't one ssh can take.".into()))?;
    Ok(SSH_OPTIONS.iter().copied().chain(["--", target, "ss", "-ltnpH"]).map(OsString::from).collect())
}

const SSH_OPTIONS: &[&str] = &[
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
    "ForkAfterAuthentication=no",
    "-o",
    "PermitLocalCommand=no",
    "-o",
    "ExitOnForwardFailure=no",
    "-o",
    "StreamLocalBindMask=0177",
    "-o",
    "StreamLocalBindUnlink=yes",
];

/// ssh said it couldn't listen on `127.0.0.1:<port>`: `bind [127.0.0.1]:<port>: Address already in use`, or
/// `channel_setup_fwd_listener_tcpip: cannot listen to port: <port>`. With `ExitOnForwardFailure=no` it runs on, and
/// whatever else holds the port must not be taken for it.
pub fn cannot_listen_on(said: &str, port: u16) -> bool {
    let (bind, listen) = (format!("]:{port}:"), format!("cannot listen to port: {port}"));
    said.lines().any(|l| l.contains(&bind) || l.trim_end().ends_with(&listen))
}

/// A socket path ssh's `-L` reads as one path: absolute, short enough for `sun_path`, and only characters that can't
/// split the forward spec (`:`) or be read as anything but a path.
fn socket_path_ok(s: &str) -> bool {
    s.starts_with('/') && s.len() < 100 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"/_.-".contains(&b))
}

/// This computer's end of ssh's forward, for a server page and for the sign-in tunnel (tunnel.rs, ADR 0098). On Linux,
/// a Unix socket in a private folder (`SocketDir`) that only the owner can connect to. On Windows, a loopback port
/// picked just before ssh binds it: any program on this computer could connect to it, as to the relay's own port, and
/// could take it before ssh binds it, so `connect` checks that ssh holds each connection's far end (ADR 0140).
#[cfg(unix)]
pub(crate) struct LocalEnd(SocketDir);
#[cfg(windows)]
pub(crate) struct LocalEnd(u16);

/// What the relay connects each frame connection to.
#[cfg(unix)]
pub(crate) type Address = PathBuf;
/// What the relay connects each frame connection to: ssh's port, and the ssh that must hold it.
#[cfg(windows)]
#[derive(Clone)]
pub(crate) struct Address {
    port: u16,
    ssh: crate::loopback_owner::SshProcess,
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

    /// Where to reach `_ssh`'s end of the forward.
    pub(crate) fn address(&self, _ssh: &Child) -> std::io::Result<Address> {
        Ok(self.0.socket())
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

#[cfg(windows)]
impl LocalEnd {
    pub(crate) const COULDNT: &str = "Couldn't find a free port for the tunnel";

    pub(crate) fn new() -> std::io::Result<Self> {
        Ok(LocalEnd(std::net::TcpListener::bind(("127.0.0.1", 0))?.local_addr()?.port()))
    }

    pub(crate) fn listen(&self) -> String {
        format!("127.0.0.1:{}", self.0)
    }

    fn ssh_args(&self, target: &str, page: &ServerPage) -> Result<Vec<OsString>, ServerPageError> {
        tcp_ssh_args(target, self.0, page)
    }

    /// Where to reach `ssh`'s end of the forward.
    pub(crate) fn address(&self, ssh: &Child) -> std::io::Result<Address> {
        Ok(Address { port: self.0, ssh: crate::loopback_owner::SshProcess::of(ssh)? })
    }

    fn named_in(&self, said: &str) -> bool {
        cannot_listen_on(said, self.0)
    }
}

/// A connection to ssh's port. Fails with `ErrorKind::PermissionDenied`, sending nothing, when another program holds
/// its far end: one that bound the port before ssh did.
#[cfg(windows)]
pub(crate) async fn connect(address: &Address) -> std::io::Result<tokio::net::TcpStream> {
    let stream = tokio::net::TcpStream::connect(("127.0.0.1", address.port)).await?;
    crate::loopback_owner::check(&stream, address.ssh)?;
    Ok(stream)
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
        .lock()
        .unwrap()
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
    /// Starts `command`. On Windows it starts suspended, goes into the app's job, so it ends with the app, and into a
    /// job of its own, so it ends with this `Ssh`, and only then runs: nothing it starts can be outside both.
    #[cfg(windows)]
    pub(crate) fn start(command: &mut Command) -> std::io::Result<Ssh> {
        const CREATE_SUSPENDED: u32 = 0x0000_0004;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let child = command.kill_on_drop(true).creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED).spawn()?;
        let (Some(handle), Some(pid)) = (child.raw_handle(), child.id()) else {
            return Err(std::io::Error::other("ssh exited as it started"));
        };
        job::ends_with_app(handle)?;
        let own = job::Own::new()?;
        own.add(handle)?;
        job::resume(pid)?;
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

#[cfg(windows)]
mod job {
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

    /// Puts the process `handle` in the app's job, so it ends with this app.
    pub fn ends_with_app(handle: std::os::windows::io::RawHandle) -> std::io::Result<()> {
        add(the_job()?, handle)
    }

    /// A job of one process's own, nested in the app's. Dropping it ends that process and everything it started.
    pub struct Own(usize);

    impl Own {
        pub fn new() -> std::io::Result<Own> {
            killing_job().map(|job| Own(job as usize))
        }

        pub fn add(&self, process: std::os::windows::io::RawHandle) -> std::io::Result<()> {
            add(self.0 as HANDLE, process)
        }
    }

    impl Drop for Own {
        fn drop(&mut self) {
            // SAFETY: the job handle `new` made, closed once.
            unsafe { CloseHandle(self.0 as HANDLE) };
        }
    }

    /// Lets process `pid`, started suspended, run.
    pub fn resume(pid: u32) -> std::io::Result<()> {
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
            Err(std::io::Error::other("couldn't let ssh run after putting it in its job"))
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
                let mut k = kept.lock().unwrap();
                k.extend_from_slice(&buf[..n]);
                let over = k.len().saturating_sub(STDERR_KEPT);
                k.drain(..over);
            }
        })
    }

    pub(crate) fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().unwrap()).trim().to_owned()
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
    target: String,
    /// Ends the tunnel, starting or open, with what to tell the webview (`None`: the webview asked).
    stop: oneshot::Sender<Option<String>>,
    served: Option<Served>,
}

struct Served {
    local_port: u16,
    jar: Jar,
}

/// Every server page is served at `127.0.0.1`, and cookies don't tell ports apart, so in one jar each page would get
/// every other server page's cookies.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Jar {
    target: String,
    origin: url::Origin,
}

#[cfg(test)]
impl Jar {
    pub fn of(target: &str, url: &str) -> Jar {
        Jar { target: target.into(), origin: Url::parse(url).unwrap().origin() }
    }
}

/// The most keys of pages closed before Rust heard of them kept, so a late `open` with one is refused.
const STOPPED_KEPT: usize = 256;

/// A tunnel `begin` registered: it counts towards the limit, and `close`, `close_all` and `close_other_targets` end
/// it, from before ssh starts until it closes.
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
    child: Ssh,
    end: LocalEnd,
    address: Address,
    stderr: Stderr,
    listener: TcpListener,
}

impl ServerPages {
    /// Registers a tunnel for `key` through `target`, before anything starts. Called while the connection that names
    /// `target` is locked, so a sign-out or another sign-in after it closes this one too.
    pub fn begin(&self, key: &str, target: &str) -> Result<Starting, ServerPageError> {
        if !key_ok(key) {
            return Err(ServerPageError::Io("That page key isn't one Hermes Chat makes.".into()));
        }
        let target = checked_target(target).ok_or(ServerPageError::NoSshTarget)?.to_owned();
        let mut open = self.open.lock().unwrap();
        {
            let mut stopped = self.stopped.lock().unwrap();
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
        open.insert(key.to_owned(), Open { target: target.clone(), stop, served: None });
        Ok(Starting { key: key.to_owned(), target, stopped })
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
        let Started { mut child, end, address, stderr, listener } = match started {
            Ok(s) => s,
            Err(e) => {
                self.open.lock().unwrap().remove(&key);
                return Err(e);
            }
        };
        let local_port = listener.local_addr().map_err(|e| ServerPageError::Io(e.to_string()))?.port();
        if let Some(open) = self.open.lock().unwrap().get_mut(&key) {
            open.served = Some(Served { local_port, jar: Jar { target: target.clone(), origin: page.url.origin() } });
        }

        let pages = Arc::clone(self);
        let task_key = key.clone();
        tokio::spawn(async move {
            // Everything the tunnel holds lives in this task: ending it drops the listener, the copies, ssh (killed on
            // drop) and the socket's folder.
            let _end = end;
            let serving = serve(listener, address, Peers::Account(loopback_peer::this_account()));
            tokio::pin!(serving);
            let why = tokio::select! {
                status = child.wait() => {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    let said = stderr.text();
                    Some(match status {
                        Ok(s) if said.is_empty() => format!("ssh ended ({s})."),
                        _ => format!("ssh ended: {said}"),
                    })
                }
                why = stopped => {
                    let _ = child.start_kill();
                    let _ = child.wait().await;
                    why.unwrap_or(None)
                }
                () = &mut serving => Some("The tunnel stopped listening.".into()),
            };
            pages.open.lock().unwrap().remove(&task_key);
            if let Some(message) = why {
                on_event(PageEvent::Closed { message });
            }
        });

        Ok(Opened { id: key, url: page.local_url(local_port).to_string(), target, at: page.at() })
    }

    /// Closes the tunnel `key`, starting or open. The webview asked, so it isn't told. A key not seen yet is kept, so
    /// the `open` the webview sent before it is refused when it arrives.
    pub fn close(&self, key: &str) {
        // `open` stays locked until the key is kept, in the order `begin` locks them, so a `begin` for the same key can't
        // slip in between finding nothing and keeping it.
        let mut open = self.open.lock().unwrap();
        match open.remove(key) {
            Some(o) => {
                drop(open);
                let _ = o.stop.send(None);
            }
            None if key_ok(key) => {
                let mut stopped = self.stopped.lock().unwrap();
                if stopped.len() >= STOPPED_KEPT {
                    stopped.pop_front();
                }
                stopped.push_back(key.to_owned());
            }
            None => {}
        }
    }

    /// Closes every tunnel, starting or open, telling each page `why`: on sign-out, and at exit.
    pub fn close_all(&self, why: &str) {
        for (_, o) in self.open.lock().unwrap().drain() {
            let _ = o.stop.send(Some(why.to_owned()));
        }
    }

    /// Closes the tunnels, starting or open, that don't go through `target`, once the app is signed in somewhere else.
    pub fn close_other_targets(&self, target: Option<&str>, why: &str) {
        let target = target.and_then(checked_target);
        let mut open = self.open.lock().unwrap();
        let others: Vec<String> = open.iter().filter(|(_, o)| Some(o.target.as_str()) != target).map(|(k, _)| k.clone()).collect();
        for key in others {
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
        self.open.lock().unwrap().values().find_map(|o| o.served.as_ref().filter(|s| s.local_port == port)).map(|s| s.jar.clone())
    }

    pub fn len(&self) -> usize {
        self.open.lock().unwrap().len()
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
async fn start(program: &str, target: &str, page: &ServerPage) -> Result<Started, ServerPageError> {
    let end = LocalEnd::new().map_err(|e| ServerPageError::Io(format!("{}: {e}", LocalEnd::COULDNT)))?;
    let mut child = spawn_ssh(program, &end.ssh_args(target, page)?, Stdio::null()).await?;
    let address = end.address(&child).map_err(|e| ServerPageError::Spawn(e.to_string()))?;
    let stderr = Stderr::default();
    if let Some(e) = child.stderr.take() {
        stderr.drain(e);
    }

    // Ready once ssh accepts on its socket; then one try finds out whether anything answers on the port.
    let deadline = tokio::time::Instant::now() + READY_TIMEOUT;
    let probe = loop {
        if child.try_wait().map_err(|e| ServerPageError::Spawn(e.to_string()))?.is_some() {
            // Let the drain catch ssh's last words.
            tokio::time::sleep(Duration::from_millis(50)).await;
            let said = stderr.text();
            return Err(ServerPageError::Ssh(if said.is_empty() { "ssh exited without saying why.".into() } else { said }));
        }
        match connect(&address).await {
            Ok(s) => break s,
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
                return Err(ServerPageError::Io(format!("The page didn't open through the SSH tunnel: {e}")));
            }
            Err(_) => {}
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
    if !answers(probe, page).await {
        tokio::time::sleep(Duration::from_millis(100)).await;
        return Err(ServerPageError::PortClosed { at: page.at(), detail: stderr.open_failed() });
    }
    // On Windows something else may have held the port while ssh failed to bind it; the probe would have reached that.
    let said = stderr.text();
    if end.named_in(&said) {
        return Err(ServerPageError::Ssh(said));
    }
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| ServerPageError::Io(e.to_string()))?;
    Ok(Started { child, end, address, stderr, listener })
}

/// Whether anything answers through a new tunnel. ssh closing the connection with nothing said means the server
/// couldn't connect to the port. Any bytes back, or no answer within `PROBE_TIMEOUT` (a slow server), count.
///
/// A TLS server may drop plain text without a word but answers a ClientHello at once, with its ServerHello or an alert.
async fn answers(mut s: impl tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin, page: &ServerPage) -> bool {
    let request =
        if page.url.scheme() == "https" { client_hello() } else { format!("HEAD / HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n", page.at()).into_bytes() };
    if s.write_all(&request).await.is_err() {
        return false;
    }
    let mut b = [0u8; 1];
    match tokio::time::timeout(PROBE_TIMEOUT, s.read(&mut b)).await {
        Ok(Ok(0)) => false,
        Ok(Ok(_)) => true,
        // A reset: ssh dropped it as it does for a refused forward.
        Ok(Err(_)) => false,
        Err(_) => true,
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

/// Accepts connections on `listener` and copies each one to and from ssh's `socket`. Runs until dropped; returns only
/// if accepting fails. A connection from anyone but `peers` is closed unanswered (ADR 0105, ADR 0138).
pub(crate) async fn serve(listener: TcpListener, socket: Address, peers: Peers) {
    let listener = &listener;
    serve_with(move || listener.accept(), socket, peers).await
}

/// `serve`, taking each connection from `accept`.
async fn serve_with<A, F>(mut accept: A, socket: Address, peers: Peers)
where
    A: FnMut() -> F,
    F: std::future::Future<Output = std::io::Result<(tokio::net::TcpStream, std::net::SocketAddr)>>,
{
    let mut conns = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            accepted = accept() => {
                let Ok((mut tcp, _)) = accepted else { return };
                let socket = socket.clone();
                conns.spawn(async move {
                    if !loopback_peer::admits(peers, &tcp) {
                        return;
                    }
                    if let Ok(mut unix) = connect(&socket).await {
                        let _ = tokio::io::copy_bidirectional(&mut tcp, &mut unix).await;
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
        assert_eq!(page("http://localhost:3000/a/b?q=1#f").local_url(41234).as_str(), "http://127.0.0.1:41234/a/b?q=1#f");
        assert_eq!(page("https://[::1]/x").local_url(40000).as_str(), "https://127.0.0.1:40000/x");
        assert_eq!(page("http://0.0.0.0:8000").at(), "0.0.0.0:8000");
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
                "ForkAfterAuthentication=no",
                "-o",
                "PermitLocalCommand=no",
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
    fn on_windows_ssh_listens_on_a_loopback_port_with_the_same_options() {
        let p = page("http://[::1]:8080/");
        let tcp = tcp_ssh_args("liam@hermes", 51234, &p).unwrap();
        let socket = ssh_args("liam@hermes", Path::new("/tmp/d/s"), &p).unwrap();
        assert_eq!(tcp[..tcp.len() - 3], socket[..socket.len() - 3]);
        assert_eq!(tcp[tcp.len() - 3], "127.0.0.1:51234:[::1]:8080");
        assert_eq!(tcp[tcp.len() - 2..], ["--", "liam@hermes"]);
        assert!(tcp_ssh_args("-oProxyCommand=x", 51234, &p).is_err());
        assert!(tcp_ssh_args("hermes", 0, &p).is_err());
    }

    #[test]
    fn lists_what_listens_on_the_server_with_the_tunnels_options_and_no_forward() {
        let p = page("http://localhost:3000/");
        let listing = listening_args(" liam@hermes ").unwrap();
        let tunnel = ssh_args("liam@hermes", Path::new("/tmp/d/s"), &p).unwrap();
        assert_eq!(listing[listing.len() - 4..], ["--", "liam@hermes", "ss", "-ltnpH"]);
        assert!(!listing.iter().any(|a| a == "-L" || a == "-N"));
        assert_eq!(listing[..listing.len() - 4], tunnel[1..tunnel.len() - 4]);
        assert!(listening_args("-oProxyCommand=x").is_err());
    }

    #[test]
    fn ssh_failing_to_listen_on_the_port_is_noticed() {
        // What Windows' OpenSSH prints when the port was taken meanwhile.
        let said = "bind [127.0.0.1]:51234: Address already in use\r\nchannel_setup_fwd_listener_tcpip: cannot listen to port: 51234\r\nCould not request local forwarding.";
        assert!(cannot_listen_on(said, 51234));
        assert!(cannot_listen_on("channel_setup_fwd_listener_tcpip: cannot listen to port: 51234", 51234));
        assert!(!cannot_listen_on(said, 5123));
        assert!(!cannot_listen_on("bind [127.0.0.1]:3000: Address already in use", 51234));
        assert!(!cannot_listen_on("channel 2: open failed: connect failed: Connection refused", 51234));
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
        let starting = pages.begin(&key, target)?;
        pages.open(program, starting, page(raw), on_event).await
    }

    #[cfg(unix)]
    type Events = Arc<Mutex<Vec<PageEvent>>>;

    #[cfg(unix)]
    fn events() -> (Events, impl Fn(PageEvent) + Send + 'static) {
        let got: Events = Arc::default();
        let into = got.clone();
        (got, move |e| into.lock().unwrap().push(e))
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
        assert!(got.lock().unwrap().is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_port_nothing_listens_on_says_so_and_leaves_nothing_running() {
        let fake = Fake::new("closed-port", "ok");
        let port = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port();
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
        until("the page hears", || !got.lock().unwrap().is_empty()).await;
        assert!(matches!(&got.lock().unwrap()[0], PageEvent::Closed { message } if message.starts_with("ssh ended")));
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

        // Signed in through `a` again: only `b`'s page goes.
        pages.close_other_targets(Some("a"), "moved");
        until("b's ssh ends", || ended(pid_b)).await;
        assert_eq!(*got_b.lock().unwrap(), [PageEvent::Closed { message: "moved".into() }]);
        assert!(!ended(pid_a));
        assert_eq!(pages.len(), 1);

        pages.close_all("signed out");
        until("a's ssh ends", || ended(pid_a)).await;
        assert_eq!(*got_a.lock().unwrap(), [PageEvent::Closed { message: "signed out".into() }]);
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
        let starting = pages.begin("starting-1", "hermes").unwrap();
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
            let starting = pages.begin(&format!("leave-{leave}"), "old-server").unwrap();
            let p = Arc::clone(&pages);
            let program = fake.program.clone();
            let opening = tokio::spawn(async move { p.open(&program, starting, page("http://localhost:3000/"), |_| {}).await });
            until("ssh starts", || fake.started()).await;
            let pid = fake.ran().0;
            if leave == "all" {
                pages.close_all("signed out");
            } else {
                pages.close_other_targets(Some("new-server"), "moved");
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
        assert_eq!(pages.begin("early-1", "hermes").err(), Some(ServerPageError::Closed(None)));
        // Only once: the key may be used again after.
        let starting = pages.begin("early-1", "hermes").unwrap();
        pages.close("early-1");
        assert!(pages.open(&fake.program, starting, page("http://localhost:3000/"), |_| {}).await.is_err());
        assert!(!fake.dir.join("ran").exists());
        // Keys are short and plain.
        for bad in ["", "a b", "../x", &"k".repeat(65)] {
            assert!(matches!(pages.begin(bad, "hermes"), Err(ServerPageError::Io(_))), "{bad:?}");
        }
        assert!(pages.is_empty());
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
            let began = pages.begin(&key, "hermes");
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
        assert!(answers(probe, &page("https://localhost:8443/")).await);
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
        let closed = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port();
        let e = open_page(&pages, &fake.program, "hermes", &format!("https://localhost:{closed}/"), |_| {}).await.unwrap_err();
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

    /// The relay's port, in front of a stand-in for ssh's end that answers every request with `body`, serving programs
    /// run by `account`. The second value keeps the stand-in's end open.
    async fn relay_for(body: &'static str, account: loopback_peer::Account) -> (u16, impl Sized) {
        let (address, end) = ssh_stand_in(body).await;
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(serve(listener, address, Peers::Account(account)));
        (port, end)
    }

    /// A stand-in for ssh's end that answers every request with `body`. The second value keeps it open.
    async fn ssh_stand_in(body: &'static str) -> (Address, impl Sized) {
        #[cfg(unix)]
        let (ssh, address, end) = {
            let dir = SocketDir::new().unwrap();
            (tokio::net::UnixListener::bind(dir.socket()).unwrap(), dir.socket(), dir)
        };
        #[cfg(windows)]
        let (ssh, address, end) = {
            let ssh = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let port = ssh.local_addr().unwrap().port();
            // The stand-in runs in this process, so this process is the ssh the relay checks for.
            let this = crate::loopback_owner::SshProcess { pid: std::process::id(), started: 0 };
            (ssh, Address { port, ssh: this }, ())
        };
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
        (address, end)
    }

    /// A failed accept (a connection reset before it was taken, or no file descriptors left) doesn't end the relay: the
    /// next connection is still relayed.
    #[cfg(any(target_os = "linux", windows))]
    #[tokio::test]
    async fn the_relay_outlives_a_failed_accept() {
        let (address, _end) = ssh_stand_in("the dashboard").await;
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
            serve_with(accept, address, Peers::Account(loopback_peer::this_account())).await
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
        let (port, _end) = relay_for("the dashboard", loopback_peer::this_account()).await;
        let mine = get(&format!("http://127.0.0.1:{port}/")).await.unwrap();
        assert!(mine.ends_with("the dashboard"), "this account's program is relayed: {mine:?}");

        // A relay that serves another account: this program's real connection is then a stranger's.
        let (port, _end) = relay_for("the dashboard", another_account()).await;
        let theirs = get(&format!("http://127.0.0.1:{port}/")).await.unwrap_or_default();
        assert_eq!(theirs, "", "another account's program gets nothing");
    }

    /// The relay, serving this account, for `.github/windows-relay/other-account.ps1`: it writes the port to
    /// `$RELAY_DIR/port` and serves until the script writes `$RELAY_DIR/done`.
    #[cfg(windows)]
    #[tokio::test]
    #[ignore]
    async fn the_relay_for_a_program_run_by_another_account() {
        let (port, _end) = relay_for("the dashboard", loopback_peer::this_account()).await;
        let dir = std::path::PathBuf::from(std::env::var("RELAY_DIR").expect("RELAY_DIR"));
        std::fs::write(dir.join("port"), port.to_string()).unwrap();
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
