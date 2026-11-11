//! A terminal on the server: the system `ssh` run in a pseudo-terminal, so the owner's ~/.ssh/config, agent and keys
//! apply, and ssh can ask in the terminal for a passphrase, a password or a new host key (ADR 0022). The webview draws
//! the screen (xterm.js); Rust only moves bytes. What the owner types goes to ssh as typed, and what ssh prints comes
//! back as raw bytes, base64 in a channel event, so a UTF-8 character split across reads isn't mangled.
//!
//! Each terminal is a session of its own, closed by `close`, by ssh exiting, or by the app exiting (the PTY closes, and
//! ssh gets a hangup).
//!
//! What the owner types is written to the PTY by a thread of the session's own, so a program that isn't reading holds
//! up only that thread. Up to `INPUT_BUDGET` waits for it, in order; past that a write is refused, and says why.
//!
//! The PTY is the platform's own (`pty`): openpty on Linux, ConPTY on Windows. On Windows, closing the pseudo console
//! sends everything still attached to it a close event, which is that platform's hangup.

use crate::backlog::Backlog;
use crate::lock::Locked;
use base64::Engine;
use serde::Serialize;
use std::collections::HashMap;
use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot};

/// How much typed or pasted input may wait for a program that isn't reading it. A program that is reads what it is
/// sent at once, and a megabyte is far more than anyone types; one paste larger than this still goes when nothing waits.
const INPUT_BUDGET: usize = 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum TerminalError {
    #[error("Enter an SSH target such as liam@hermes or a host alias from ~/.ssh/config.")]
    BadTarget,
    #[error("Couldn't open a terminal: {0}")]
    Pty(String),
    #[error("Couldn't start ssh: {0}")]
    Spawn(String),
    #[error("That terminal has closed.")]
    Gone,
    #[error("The program in this terminal isn't taking input, so that wasn't sent. Wait for it, or close the terminal.")]
    NotTakingInput,
}

impl Serialize for TerminalError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// What a terminal tells the webview: output as it comes, then, once, how it ended.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TerminalEvent {
    /// Bytes ssh wrote, base64.
    Output { data: String },
    /// ssh exited: `code` is its exit status, or none if a signal ended it (as `close` does).
    Exit { code: Option<i32> },
}

struct Session {
    /// The PTY's master side, sized from here.
    master: pty::Master,
    /// What the owner typed, on its way to the writing thread. Dropped, the thread ends once it has written what waits.
    input: mpsc::UnboundedSender<Vec<u8>>,
    waiting: Arc<Backlog>,
    /// Ends ssh. Dropped with the session, which ends it too.
    kill: Option<oneshot::Sender<()>>,
}

/// A program just started in a new PTY.
struct Started {
    master: pty::Master,
    /// What the program prints. It ends once the program, and anything else holding the PTY, is gone.
    reader: Box<dyn Read + Send>,
    /// How it ended: its exit status, or none if a signal or `close` ended it.
    exit: oneshot::Receiver<Option<i32>>,
    /// Ends it, when sent or dropped.
    kill: oneshot::Sender<()>,
}

/// The terminals open now, by id.
#[derive(Default)]
pub struct Terminals {
    next: Mutex<u64>,
    open: Mutex<HashMap<u64, Session>>,
}

/// `ssh` to `target` in a terminal of `cols` × `rows`. A leading '-' would be read as an option, and whitespace would
/// make it more than a target, so both are refused, as the tunnel refuses them.
pub fn ssh_command(target: &str) -> Result<Command, TerminalError> {
    let target = target.trim();
    if target.is_empty() || target.starts_with('-') || target.contains(char::is_whitespace) {
        return Err(TerminalError::BadTarget);
    }
    let mut command = Command::new("ssh");
    command.args(crate::tunnel::PLATFORM_SSH_OPTIONS);
    // `-t`: a login shell in a terminal even if the owner's config sets a RemoteCommand. Host key checking is left to
    // the owner's config: in a terminal ssh can ask, and the owner answers.
    command.args(["-t", "-o", "ServerAliveInterval=15", "--", target]);
    Ok(command)
}

/// A shell on this computer: the program, its arguments, and the folder it starts in.
#[derive(Debug, PartialEq)]
struct LocalShell {
    program: PathBuf,
    args: &'static [&'static str],
    home: Option<PathBuf>,
}

/// Linux (ADR 0039): the owner's login shell, `$SHELL` when it names a program by its full path, else `/bin/sh`, in
/// `$HOME`.
#[cfg_attr(windows, allow(dead_code))]
fn unix_shell(var: impl Fn(&str) -> Option<OsString>, is_file: impl Fn(&Path) -> bool) -> LocalShell {
    let program = var("SHELL").map(PathBuf::from).filter(|p| p.is_absolute() && is_file(p)).unwrap_or_else(|| "/bin/sh".into());
    LocalShell { program, args: &["-l"], home: var("HOME").map(PathBuf::from) }
}

/// Windows has no login shell. Windows PowerShell, which every Windows 10 and 11 has, else `%ComSpec%` when it names a
/// program by its full path, else cmd, in the user's profile folder.
#[cfg_attr(not(windows), allow(dead_code))]
fn windows_shell(var: impl Fn(&str) -> Option<OsString>, is_file: impl Fn(&Path) -> bool) -> LocalShell {
    let system = var("SystemRoot").map(PathBuf::from).unwrap_or_else(|| r"C:\Windows".into()).join("System32");
    let powershell = system.join("WindowsPowerShell").join("v1.0").join("powershell.exe");
    let (program, args): (PathBuf, &'static [&'static str]) = if is_file(&powershell) {
        (powershell, &["-NoLogo"])
    } else {
        let comspec = var("ComSpec").map(PathBuf::from).filter(|p| p.is_absolute() && is_file(p));
        (comspec.unwrap_or_else(|| system.join("cmd.exe")), &[])
    };
    LocalShell { program, args, home: var("USERPROFILE").map(PathBuf::from) }
}

/// The owner's own shell on this computer, started in their home folder (ADR 0039). Nothing the webview sends picks
/// the program or its arguments.
pub fn local_shell_command() -> Command {
    #[cfg(windows)]
    let shell = windows_shell(|k| std::env::var_os(k), Path::is_file);
    #[cfg(not(windows))]
    let shell = unix_shell(|k| std::env::var_os(k), Path::is_file);
    let mut command = Command::new(shell.program);
    command.args(shell.args);
    if let Some(home) = shell.home.filter(|h| h.is_dir()) {
        command.current_dir(home);
    }
    command
}

impl Terminals {
    /// Starts `command` in a new PTY of `cols` × `rows`, sending what it prints, then how it ended, to `on_event`.
    pub fn open(&self, mut command: Command, cols: u16, rows: u16, on_event: impl Fn(TerminalEvent) + Send + 'static) -> Result<u64, TerminalError> {
        command.env("TERM", "xterm-256color").env("COLORTERM", "truecolor");
        let Started { master, mut reader, exit, kill } = pty::start(command, cols, rows)?;
        std::thread::spawn(move || {
            let mut buf = vec![0u8; 16 * 1024];
            loop {
                match reader.read(&mut buf) {
                    // Linux reads EIO once the slave side has no one left.
                    Ok(0) | Err(_) => break,
                    Ok(n) => on_event(TerminalEvent::Output { data: base64::engine::general_purpose::STANDARD.encode(&buf[..n]) }),
                }
            }
            // Everything ssh wrote has gone out; how it ended comes last.
            let code = exit.blocking_recv().unwrap_or(None);
            on_event(TerminalEvent::Exit { code });
        });

        let (input, mut typed) = mpsc::unbounded_channel::<Vec<u8>>();
        let waiting = Arc::new(Backlog::new(INPUT_BUDGET));
        let (pty, written) = (master.clone(), waiting.clone());
        std::thread::spawn(move || {
            while let Some(data) = typed.blocking_recv() {
                let wrote = pty.write(&data);
                written.written(data.len());
                // The PTY has closed, so nothing more can go.
                if wrote.is_err() {
                    break;
                }
            }
        });

        let mut next = self.next.locked();
        *next += 1;
        self.open.locked().insert(*next, Session { master, input, waiting, kill: Some(kill) });
        Ok(*next)
    }

    /// Sends what the owner typed or pasted to terminal `id`, without waiting for the program to read it.
    pub fn write(&self, id: u64, data: &[u8]) -> Result<(), TerminalError> {
        let open = self.open.locked();
        let session = open.get(&id).filter(|s| !s.input.is_closed()).ok_or(TerminalError::Gone)?;
        if !session.waiting.take(data.len()) {
            return Err(TerminalError::NotTakingInput);
        }
        session.input.send(data.to_vec()).map_err(|_| TerminalError::Gone)
    }

    /// Tells terminal `id`, and so the shell on the server, its new size.
    pub fn resize(&self, id: u64, cols: u16, rows: u16) -> Result<(), TerminalError> {
        let master = self.open.locked().get(&id).map(|s| s.master.clone()).ok_or(TerminalError::Gone)?;
        master.resize(cols, rows).map_err(|e| TerminalError::Pty(e.to_string()))
    }

    /// Ends terminal `id`'s ssh. Its Exit event still comes. Closing one that has gone does nothing.
    pub fn close(&self, id: u64) {
        if let Some(mut s) = self.open.locked().remove(&id) {
            if let Some(kill) = s.kill.take() {
                let _ = kill.send(());
            }
        }
    }
}

#[cfg(unix)]
mod pty {
    use super::{Started, TerminalError};
    use std::fs::File;
    use std::io::Write;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::process::Stdio;
    use std::sync::Arc;
    use tokio::process::Command;
    use tokio::sync::oneshot;

    #[derive(Clone)]
    pub struct Master(Arc<File>);

    impl Master {
        pub fn write(&self, data: &[u8]) -> std::io::Result<()> {
            (&*self.0).write_all(data)
        }

        pub fn resize(&self, cols: u16, rows: u16) -> std::io::Result<()> {
            set_size(self.0.as_raw_fd(), cols, rows)
        }
    }

    pub fn start(mut command: Command, cols: u16, rows: u16) -> Result<Started, TerminalError> {
        let (master, slave) = open_pty(cols, rows).map_err(|e| TerminalError::Pty(e.to_string()))?;
        let stdio = |fd: &OwnedFd| fd.try_clone().map(Stdio::from).map_err(|e| TerminalError::Pty(e.to_string()));
        command.stdin(stdio(&slave)?).stdout(stdio(&slave)?).stderr(stdio(&slave)?).kill_on_drop(true);
        // SAFETY: only async-signal-safe calls between fork and exec. A session of its own, with the PTY as its
        // controlling terminal, so ssh can read a passphrase from it and gets a hangup when it closes.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::ioctl(0, libc::TIOCSCTTY as _, 0) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = command.spawn().map_err(|e| TerminalError::Spawn(e.to_string()))?;
        // Only ssh holds the slave now, so reading the master ends once ssh has exited.
        drop(slave);
        drop(command);

        let master = Arc::new(File::from(master));
        let (kill, killed) = oneshot::channel::<()>();
        let (exited, exit) = oneshot::channel::<Option<i32>>();
        tokio::spawn(async move {
            let status = tokio::select! {
                status = child.wait() => status,
                _ = killed => {
                    let _ = child.start_kill();
                    child.wait().await
                }
            };
            let _ = exited.send(status.ok().and_then(|s| s.code()));
        });
        let reader = master.try_clone().map_err(|e| TerminalError::Pty(e.to_string()))?;
        Ok(Started { master: Master(master), reader: Box::new(reader), exit, kill })
    }

    fn winsize(cols: u16, rows: u16) -> libc::winsize {
        libc::winsize { ws_row: rows.max(1), ws_col: cols.max(1), ws_xpixel: 0, ws_ypixel: 0 }
    }

    /// A new PTY pair of `cols` × `rows`: (master, slave), both closed on exec.
    fn open_pty(cols: u16, rows: u16) -> std::io::Result<(OwnedFd, OwnedFd)> {
        let (mut master, mut slave) = (-1, -1);
        let size = winsize(cols, rows);
        // SAFETY: openpty writes two new descriptors, which are owned from here on.
        let r = unsafe { libc::openpty(&mut master, &mut slave, std::ptr::null_mut(), std::ptr::null(), &size) };
        if r == -1 {
            return Err(std::io::Error::last_os_error());
        }
        let (master, slave) = unsafe { (OwnedFd::from_raw_fd(master), OwnedFd::from_raw_fd(slave)) };
        for fd in [&master, &slave] {
            // SAFETY: plain fcntl on a descriptor owned here.
            if unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } == -1 {
                return Err(std::io::Error::last_os_error());
            }
        }
        Ok((master, slave))
    }

    fn set_size(fd: i32, cols: u16, rows: u16) -> std::io::Result<()> {
        let size = winsize(cols, rows);
        // SAFETY: TIOCSWINSZ reads one winsize.
        if unsafe { libc::ioctl(fd, libc::TIOCSWINSZ, &size) } == -1 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
}

#[cfg(windows)]
mod pty {
    use super::{Started, TerminalError};
    use crate::lock::Locked;
    use portable_pty::{CommandBuilder, MasterPty, PtySize};
    use std::io::Write;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use tokio::process::Command;
    use tokio::sync::oneshot;

    /// The pseudo console, until the program has exited, and its input.
    #[derive(Clone)]
    pub struct Master {
        console: Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>,
        input: Arc<Mutex<Box<dyn Write + Send>>>,
    }

    impl Master {
        pub fn write(&self, data: &[u8]) -> std::io::Result<()> {
            let mut input = self.input.locked();
            input.write_all(data)?;
            input.flush()
        }

        pub fn resize(&self, cols: u16, rows: u16) -> std::io::Result<()> {
            let console = self.console.locked();
            let console = console.as_ref().ok_or_else(|| std::io::Error::other("the terminal has closed"))?;
            console.resize(size(cols, rows)).map_err(|e| std::io::Error::other(e.to_string()))
        }
    }

    fn size(cols: u16, rows: u16) -> PtySize {
        PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 }
    }

    /// The same program, arguments, environment changes and folder, for ConPTY.
    fn builder(command: &std::process::Command) -> CommandBuilder {
        let mut b = CommandBuilder::new(command.get_program());
        b.args(command.get_args());
        for (key, value) in command.get_envs() {
            match value {
                Some(value) => b.env(key, value),
                None => b.env_remove(key),
            }
        }
        if let Some(dir) = command.get_current_dir() {
            b.cwd(dir);
        }
        b
    }

    pub fn start(command: Command, cols: u16, rows: u16) -> Result<Started, TerminalError> {
        let pty_error = |e: &dyn std::fmt::Display| TerminalError::Pty(e.to_string());
        let pair = portable_pty::native_pty_system().openpty(size(cols, rows)).map_err(|e| pty_error(&e))?;
        let mut child = pair.slave.spawn_command(builder(command.as_std())).map_err(|e| TerminalError::Spawn(e.to_string()))?;
        drop(pair.slave);
        let ends = pair.master.try_clone_reader().and_then(|r| Ok((r, pair.master.take_writer()?)));
        let (reader, input) = match ends {
            Ok(ends) => ends,
            Err(e) => {
                let _ = child.kill();
                return Err(pty_error(&e));
            }
        };

        let console = Arc::new(Mutex::new(Some(pair.master)));
        // TerminateProcess leaves an exit status of its own choosing, so an end by `close` is told apart here.
        let closed = Arc::new(AtomicBool::new(false));
        let (kill, killed) = oneshot::channel::<()>();
        let (exited, exit) = oneshot::channel::<Option<i32>>();
        let (done, ended) = oneshot::channel::<()>();
        let mut killer = child.clone_killer();
        let closing = closed.clone();
        tokio::spawn(async move {
            tokio::select! {
                _ = killed => {
                    closing.store(true, Ordering::SeqCst);
                    if killer.kill().is_err() {
                        closing.store(false, Ordering::SeqCst);
                    }
                }
                _ = ended => {}
            }
        });
        let open = console.clone();
        std::thread::spawn(move || {
            let status = child.wait();
            let _ = done.send(());
            // ConPTY keeps the output open until the console closes: closing it now ends what else is still attached
            // to it, and then the reader.
            drop(open.locked().take());
            let code = if closed.load(Ordering::SeqCst) { None } else { status.ok().map(|s| s.exit_code() as i32) };
            let _ = exited.send(code);
        });
        Ok(Started { master: Master { console, input: Arc::new(Mutex::new(input)) }, reader, exit, kill })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::time::Duration;
    #[cfg(unix)]
    use tokio::sync::mpsc;

    #[cfg(unix)]
    /// Runs `script` in `sh` in a terminal, and gives back the terminal's id, everything it printed and how it ended.
    async fn run(terminals: &Terminals, script: &str, cols: u16, rows: u16, input: Option<&[u8]>) -> (String, Option<i32>) {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut command = Command::new("sh");
        command.args(["-c", script]);
        let id = terminals.open(command, cols, rows, move |e| drop(tx.send(e))).unwrap();
        if let Some(input) = input {
            terminals.write(id, input).unwrap();
        }
        let mut out = Vec::new();
        loop {
            match tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.expect("terminal timed out") {
                Some(TerminalEvent::Output { data }) => out.extend(base64::engine::general_purpose::STANDARD.decode(data).unwrap()),
                Some(TerminalEvent::Exit { code }) => return (String::from_utf8_lossy(&out).into_owned(), code),
                None => panic!("events ended without an exit"),
            }
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn runs_in_a_terminal_of_the_given_size_and_reports_the_exit_status() {
        let t = Terminals::default();
        let (out, code) = run(&t, "test -t 0 && echo tty; stty size; echo $TERM; exit 3", 101, 33, None).await;
        assert!(out.contains("tty"), "{out:?}");
        assert!(out.contains("33 101"), "{out:?}");
        assert!(out.contains("xterm-256color"), "{out:?}");
        assert_eq!(code, Some(3));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn what_is_typed_reaches_the_program() {
        let t = Terminals::default();
        let (out, code) = run(&t, "read line; echo \"got:$line\"", 80, 24, Some(b"h\xc3\xa9llo\r")).await;
        assert!(out.contains("got:héllo"), "{out:?}");
        assert_eq!(code, Some(0));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn resizing_reaches_the_program() {
        let t = Terminals::default();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut command = Command::new("sh");
        command.args(["-c", "read _; stty size"]);
        let id = t.open(command, 80, 24, move |e| drop(tx.send(e))).unwrap();
        t.resize(id, 132, 50).unwrap();
        t.write(id, b"\r").unwrap();
        let mut out = String::new();
        while let Some(e) = tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.unwrap() {
            match e {
                TerminalEvent::Output { data } => out.push_str(&String::from_utf8_lossy(&base64::engine::general_purpose::STANDARD.decode(data).unwrap())),
                TerminalEvent::Exit { .. } => break,
            }
        }
        assert!(out.contains("50 132"), "{out:?}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn closing_ends_the_program_and_still_reports_the_end() {
        let t = Terminals::default();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 30"]);
        let id = t.open(command, 80, 24, move |e| drop(tx.send(e))).unwrap();
        t.close(id);
        let end = loop {
            match tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.unwrap() {
                Some(TerminalEvent::Exit { code }) => break code,
                Some(_) => continue,
                None => panic!("no exit"),
            }
        };
        assert_eq!(end, None, "a signal ended it");
        assert!(matches!(t.write(id, b"x"), Err(TerminalError::Gone)));
        t.close(id);
    }

    /// A program that never reads: what the owner types waits for it without holding up the caller, until a megabyte
    /// waits; then the terminal refuses more and says why.
    #[cfg(unix)]
    #[tokio::test]
    async fn input_a_program_isnt_reading_waits_without_holding_up_the_caller_and_is_refused_past_a_megabyte() {
        let t = std::sync::Arc::new(Terminals::default());
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 30"]);
        let id = t.open(command, 80, 24, |_| {}).unwrap();
        let (done, writes) = std::sync::mpsc::channel();
        let writer = t.clone();
        std::thread::spawn(move || {
            let chunk = vec![b'x'; 64 * 1024];
            let mut taken = 0;
            let refused = loop {
                match writer.write(id, &chunk) {
                    Ok(()) => taken += chunk.len(),
                    Err(e) => break e,
                }
                if taken > 16 * 1024 * 1024 {
                    panic!("16 MiB taken and nothing refused");
                }
            };
            let _ = done.send((taken, refused));
        });
        let (taken, refused) = writes.recv_timeout(Duration::from_secs(5)).expect("a write held up the caller");
        assert!(matches!(refused, TerminalError::NotTakingInput), "{refused:?}");
        assert!((1024 * 1024..=2 * 1024 * 1024).contains(&taken), "refused after {taken} bytes");
        t.close(id);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_local_shell_is_a_login_shell_in_the_home_folder() {
        let c = local_shell_command();
        let args: Vec<_> = c.as_std().get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(args, ["-l"]);
        assert!(std::path::Path::new(c.as_std().get_program()).is_absolute());
        // It runs, in a terminal, where it was started.
        let t = Terminals::default();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let id = t.open(local_shell_command(), 80, 24, move |e| drop(tx.send(e))).unwrap();
        t.write(id, b"echo \"at:$PWD\"; exit 4\r").unwrap();
        let mut out = String::new();
        let code = loop {
            match tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.unwrap() {
                Some(TerminalEvent::Output { data }) => {
                    out.push_str(&String::from_utf8_lossy(&base64::engine::general_purpose::STANDARD.decode(data).unwrap()))
                }
                Some(TerminalEvent::Exit { code }) => break code,
                None => panic!("no exit"),
            }
        };
        assert!(out.contains(&format!("at:{}", std::env::var("HOME").unwrap())), "{out:?}");
        assert_eq!(code, Some(4));
    }

    #[cfg(unix)]
    fn vars(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<OsString> {
        move |k| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| OsString::from(v))
    }

    #[cfg(unix)]
    #[test]
    fn the_unix_shell_is_shell_by_its_full_path_else_sh() {
        let any = |_: &Path| true;
        let shell = unix_shell(vars(&[("SHELL", "/usr/bin/zsh"), ("HOME", "/home/me")]), any);
        assert_eq!(shell, LocalShell { program: "/usr/bin/zsh".into(), args: &["-l"], home: Some("/home/me".into()) });
        assert_eq!(unix_shell(vars(&[("SHELL", "zsh")]), any).program, PathBuf::from("/bin/sh"));
        assert_eq!(unix_shell(vars(&[("SHELL", "/gone")]), |_| false).program, PathBuf::from("/bin/sh"));
    }

    #[test]
    fn the_windows_shell_is_powershell_else_comspec_else_cmd() {
        let root = std::env::temp_dir().join("Windows");
        let system = root.join("System32");
        let powershell = system.join("WindowsPowerShell").join("v1.0").join("powershell.exe");
        let comspec = std::env::temp_dir().join("tcc.exe");
        let env = |k: &str| match k {
            "SystemRoot" => Some(root.clone().into_os_string()),
            "ComSpec" => Some(comspec.clone().into_os_string()),
            "USERPROFILE" => Some("C:\\Users\\me".into()),
            _ => None,
        };
        let shell = windows_shell(env, |_| true);
        assert_eq!(shell, LocalShell { program: powershell.clone(), args: &["-NoLogo"], home: Some("C:\\Users\\me".into()) });
        let no_powershell = |p: &Path| p != powershell;
        assert_eq!(windows_shell(env, no_powershell).program, comspec);
        assert_eq!(windows_shell(env, |p| p != powershell && p != comspec).program, system.join("cmd.exe"));
        assert_eq!(windows_shell(env, no_powershell).args, &[] as &[&str]);
    }

    #[test]
    fn refuses_a_target_ssh_would_read_as_an_option() {
        for bad in ["", "  ", "-oProxyCommand=evil", "liam@hermes ls"] {
            assert!(matches!(ssh_command(bad), Err(TerminalError::BadTarget)), "{bad:?}");
        }
        let c = ssh_command(" liam@hermes ").unwrap();
        let args: Vec<_> = c.as_std().get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(args.last().map(String::as_str), Some("liam@hermes"));
        assert_eq!(args[args.len() - 2], "--");
    }
}
