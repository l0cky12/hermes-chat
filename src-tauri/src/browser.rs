//! Opening a page in the owner's default browser on Linux (ADR 0082). GIO picks the browser from `mimeapps.list`, the
//! way `xdg-open` does, and starts it here, so the browser's own exit status and error output come back. On Hyprland,
//! Sway and every other desktop without its own opener, `xdg-open` runs the browser and then reports success whatever
//! the browser did.

use crate::lock::Locked;
use gio::prelude::*;
use std::io::Read;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// How long a started browser has to fail before it counts as showing the page. A browser that is already running
/// takes the address and exits at once; one that wasn't keeps running.
const OPEN_WAIT: Duration = Duration::from_secs(3);
/// How long a failed browser's error output may take to end, since its helper processes can hold it open.
const SAID_WAIT: Duration = Duration::from_millis(500);
const MAX_SAID: usize = 4096;

/// A browser started on a page. Its process is reaped and its error output read from the start, so dropping this
/// leaves nothing behind.
pub struct Launched {
    name: String,
    exit: tokio::sync::oneshot::Receiver<std::io::Result<libc::c_int>>,
    said: Arc<Mutex<Vec<u8>>>,
    said_end: tokio::sync::oneshot::Receiver<()>,
}

/// The browser the desktop opens `url` with, as `x-scheme-handler/http(s)` in `mimeapps.list` names it.
pub fn default_browser(url: &str) -> Result<gio::DesktopAppInfo, String> {
    let url = crate::web_page::web_url(url)?;
    gio::AppInfo::default_for_uri_scheme(url.scheme()).and_then(|app| app.downcast::<gio::DesktopAppInfo>().ok()).ok_or_else(|| {
        "No default browser is set. Pick one in your desktop's settings, or run `xdg-settings set default-web-browser` with its .desktop file.".to_owned()
    })
}

/// Starts `browser` on `url`, as one argument and never through a shell. `context`: the display's launch context, which
/// gets the browser a Wayland activation token or an X11 startup id so the desktop may bring it forward.
pub fn launch(browser: &gio::DesktopAppInfo, url: &str, context: Option<&gio::AppLaunchContext>) -> Result<Launched, String> {
    let url = crate::web_page::web_url(url)?;
    let name = browser.display_name().to_string();
    let couldnt = |e: &dyn std::fmt::Display| format!("Couldn't start {name}: {e}");
    let browser = by_exec(browser).ok_or_else(|| couldnt(&"its .desktop file has no Exec line"))?;
    let (said, mut stderr) = std::io::pipe().map_err(|e| couldnt(&e))?;
    let mut stdin = std::fs::File::open("/dev/null").map_err(|e| couldnt(&e))?;
    let mut stdout = std::fs::OpenOptions::new().write(true).open("/dev/null").map_err(|e| couldnt(&e))?;
    let mut pid = None;
    browser
        .launch_uris_as_manager_with_fds(
            &[url.as_str()],
            context,
            gio::glib::SpawnFlags::SEARCH_PATH | gio::glib::SpawnFlags::DO_NOT_REAP_CHILD,
            None,
            Some(&mut |_, p: gio::glib::Pid| pid = Some(p.0)),
            &mut stdin,
            &mut stdout,
            &mut stderr,
        )
        .map_err(|e| couldnt(&e.message()))?;
    let pid = pid.ok_or_else(|| couldnt(&"GIO gave no process"))?;
    let kept = Arc::new(Mutex::new(Vec::new()));
    let (said_all, said_end) = tokio::sync::oneshot::channel();
    let keep = kept.clone();
    // Read to the end even past MAX_SAID, so a browser that keeps running never blocks on a full pipe.
    std::thread::spawn(move || {
        keep_tail(said, &keep);
        let _ = said_all.send(());
    });
    let (exited, exit) = tokio::sync::oneshot::channel();
    // Waits for as long as the browser runs, so it never stays a zombie.
    std::thread::spawn(move || {
        let _ = exited.send(wait(pid));
    });
    Ok(Launched { name, exit, said: kept, said_end })
}

/// `browser` as one GIO starts from its `Exec` line. A `DBusActivatable` app would otherwise be sent the page over
/// D-Bus without waiting for an answer, so a failure there would be silent.
fn by_exec(browser: &gio::DesktopAppInfo) -> Option<gio::DesktopAppInfo> {
    if !browser.boolean("DBusActivatable") {
        return Some(browser.clone());
    }
    let path = browser.filename()?;
    let file = gio::glib::KeyFile::new();
    file.load_from_file(&path, gio::glib::KeyFileFlags::NONE).ok()?;
    file.remove_key("Desktop Entry", "DBusActivatable").ok()?;
    // An entry made from a key file has no file name, so `%k` would expand to nothing.
    let exec = file.string("Desktop Entry", "Exec").ok()?;
    file.set_string("Desktop Entry", "Exec", &with_file_name(&exec, &path.to_string_lossy()));
    gio::DesktopAppInfo::from_keyfile(&file)
}

/// `exec` with each `%k` field code replaced by `path`, quoted as the Desktop Entry spec quotes an argument.
fn with_file_name(exec: &str, path: &str) -> String {
    let mut quoted = String::from('"');
    for c in path.chars() {
        if matches!(c, '"' | '`' | '$' | '\\') {
            quoted.push('\\');
        }
        quoted.push(c);
    }
    quoted.push('"');
    let mut out = String::new();
    let mut chars = exec.chars();
    while let Some(c) = chars.next() {
        if c != '%' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('k') => out.push_str(&quoted),
            Some(code) => {
                out.push('%');
                out.push(code);
            }
            None => out.push('%'),
        }
    }
    out
}

impl Launched {
    /// Waits until the browser fails or outlasts `OPEN_WAIT`, and gives its name. A failure says why, in the
    /// browser's own words when it gave any.
    pub async fn settle(self) -> Result<String, String> {
        let Launched { name, exit, said: kept, said_end } = self;
        let status = match tokio::time::timeout(OPEN_WAIT, exit).await {
            Err(_) => return Ok(name),
            Ok(status) => status.map_err(|e| e.to_string())?.map_err(|e| format!("Couldn't tell whether {name} started: {e}"))?,
        };
        if libc::WIFEXITED(status) && libc::WEXITSTATUS(status) == 0 {
            return Ok(name);
        }
        let _ = tokio::time::timeout(SAID_WAIT, said_end).await;
        let said = String::from_utf8_lossy(&kept.locked()).into_owned();
        Err(failure(&name, status, last_line(&said)))
    }
}

fn wait(pid: libc::pid_t) -> std::io::Result<libc::c_int> {
    let mut status = 0;
    loop {
        // SAFETY: `pid` is this process's own child, started without being reaped by anything else.
        if unsafe { libc::waitpid(pid, &mut status, 0) } == pid {
            return Ok(status);
        }
        let e = std::io::Error::last_os_error();
        if e.kind() != std::io::ErrorKind::Interrupted {
            return Err(e);
        }
    }
}

/// Reads `from` to its end, keeping the last `MAX_SAID` bytes.
fn keep_tail(mut from: impl Read, kept: &Mutex<Vec<u8>>) {
    let mut buf = [0; 1024];
    while let Ok(n @ 1..) = from.read(&mut buf) {
        let mut kept = kept.locked();
        kept.extend_from_slice(&buf[..n]);
        let over = kept.len().saturating_sub(MAX_SAID);
        kept.drain(..over);
    }
}

fn last_line(said: &str) -> Option<&str> {
    said.lines().map(str::trim).rfind(|l| !l.is_empty())
}

fn failure(name: &str, status: libc::c_int, said: Option<&str>) -> String {
    let how = if libc::WIFSIGNALED(status) {
        format!("{name} was stopped by signal {}", libc::WTERMSIG(status))
    } else {
        format!("{name} stopped with exit code {}", libc::WEXITSTATUS(status))
    };
    match said {
        Some(said) => format!("{how}: {}", said.chars().take(300).collect::<String>()),
        None => format!("{how} and gave no reason."),
    }
}
