//! The preview's framing check and "Open in your browser" against local sites (issue #55).

mod common;

use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::get;
use axum::Router;
use hermes_chat::web_page::{self, Framing};
use std::sync::{Arc, Mutex};

async fn site() -> (String, Arc<Mutex<Vec<HeaderMap>>>) {
    let seen: Arc<Mutex<Vec<HeaderMap>>> = Arc::default();
    let log = seen.clone();
    let app = Router::new()
        .route("/ok", get(|| async { "<h1>ok</h1>" }))
        // What www.google.com sent on 2026-11-02.
        .route("/google", get(|| async { ([(header::X_FRAME_OPTIONS, "SAMEORIGIN")], "<h1>search</h1>") }))
        .route("/csp", get(|| async { ([(header::CONTENT_SECURITY_POLICY, "frame-ancestors 'none'")], "") }))
        .route("/to-google", get(|| async { Redirect::temporary("/google") }))
        .route("/gone", get(|| async { (StatusCode::NOT_FOUND, "<h1>not here</h1>") }))
        .layer(axum::middleware::from_fn(move |req: axum::extract::Request, next: axum::middleware::Next| {
            let log = log.clone();
            async move {
                log.lock().unwrap().push(req.headers().clone());
                Ok::<Response, std::convert::Infallible>(next.run(req).await.into_response())
            }
        }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (base, seen)
}

const UA: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)";

#[tokio::test]
async fn says_a_site_refuses_when_its_answer_does() {
    let (base, seen) = site().await;
    let check = |path: &str| {
        let url = format!("{base}{path}");
        async move { web_page::check(&url, UA).await }
    };

    assert_eq!(check("/google").await.unwrap(), Framing::Refused { by: "X-Frame-Options: SAMEORIGIN".into() });
    assert_eq!(check("/to-google").await.unwrap(), Framing::Refused { by: "X-Frame-Options: SAMEORIGIN".into() });
    assert_eq!(check("/csp").await.unwrap(), Framing::Refused { by: "Content-Security-Policy: frame-ancestors 'none'".into() });
    assert_eq!(check("/ok").await.unwrap(), Framing::NotRefused);
    // An error page still shows in the frame.
    assert_eq!(check("/gone").await.unwrap(), Framing::NotRefused);

    // It asks the way a cross-site frame does, with the webview's user agent and no cookies.
    let first = seen.lock().unwrap()[0].clone();
    assert_eq!(first["sec-fetch-dest"], "iframe");
    assert_eq!(first["sec-fetch-site"], "cross-site");
    assert_eq!(first[header::USER_AGENT], UA);
    assert!(first.get(header::COOKIE).is_none());
}

#[tokio::test]
async fn says_when_the_site_cant_be_reached() {
    // A port nothing listens on: WebKitGTK never fires the frame's `load` for this, so the pane would spin.
    let closed = common::refusing();
    match web_page::check(&format!("http://{}/", closed.addr), UA).await.unwrap() {
        Framing::Unreachable { message } => assert!(message.to_lowercase().contains("refused"), "{message}"),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn checks_only_web_addresses() {
    for bad in ["file:///etc/passwd", "tauri://localhost/", "https://liam:pw@example.com/"] {
        assert!(web_page::check(bad, UA).await.is_err(), "{bad}");
    }
}

/// A browser's `.desktop` file in a fresh folder, running `script` with the address as `%u`.
#[cfg(target_os = "linux")]
fn browser(name: &str, script: &str) -> (std::path::PathBuf, gtk::gio::DesktopAppInfo) {
    browser_with(name, script, "%u", "")
}

/// `browser`, with `args` after the program on its `Exec` line and more lines in its `[Desktop Entry]`.
#[cfg(target_os = "linux")]
fn browser_with(name: &str, script: &str, args: &str, more: &str) -> (std::path::PathBuf, gtk::gio::DesktopAppInfo) {
    let dir = std::env::temp_dir().join(format!("hermes-browser-{}-{}", std::process::id(), name.replace(' ', "-")));
    std::fs::create_dir_all(&dir).unwrap();
    let program = dir.join("browser");
    common::write_executable(&program, &format!("#!/bin/sh\n{script}\n"));
    let desktop = dir.join(format!("{name}.desktop"));
    let entry = format!("[Desktop Entry]\nType=Application\nName={name}\nExec={} {args}\n{more}", program.display());
    std::fs::write(&desktop, entry).unwrap();
    let app = gtk::gio::DesktopAppInfo::from_filename(&desktop).unwrap();
    (dir, app)
}

#[cfg(target_os = "linux")]
async fn open(app: &gtk::gio::DesktopAppInfo, url: &str) -> Result<String, String> {
    hermes_chat::browser::launch(app, url, None)?.settle().await
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn opens_the_page_in_the_browser_and_names_it() {
    let (dir, app) = browser("Helium Browser", r#"printf '%s\n' "$@" > "$(dirname "$0")/args""#);
    assert_eq!(open(&app, "https://www.google.com/search?q=a b;$(id)").await.unwrap(), "Helium Browser");
    // One argument, the checked address, with nothing a shell would act on.
    assert_eq!(std::fs::read_to_string(dir.join("args")).unwrap(), "https://www.google.com/search?q=a%20b;$(id)\n");
    for bad in ["file:///etc/passwd", "tauri://localhost/", "https://liam:pw@example.com/"] {
        assert!(open(&app, bad).await.is_err(), "{bad}");
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn says_why_the_browser_failed_in_its_own_words() {
    let (dir, app) = browser("Failing", "echo 'starting up' >&2; echo 'cannot open display: wayland-1' >&2; exit 1");
    assert_eq!(open(&app, "https://example.com/").await.unwrap_err(), "Failing stopped with exit code 1: cannot open display: wayland-1");
    std::fs::remove_dir_all(dir).unwrap();

    let (dir, app) = browser("Quiet", "exit 3");
    assert_eq!(open(&app, "https://example.com/").await.unwrap_err(), "Quiet stopped with exit code 3 and gave no reason.");
    std::fs::remove_dir_all(dir).unwrap();

    let (dir, app) = browser("Killed", "kill -9 $$");
    assert_eq!(open(&app, "https://example.com/").await.unwrap_err(), "Killed was stopped by signal 9 and gave no reason.");
    std::fs::remove_dir_all(dir).unwrap();
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_browser_still_running_has_the_page() {
    // A browser that wasn't running yet keeps running after it shows the page, and may log far more than a pipe holds.
    let (dir, app) = browser("Starting", r#"head -c 1000000 /dev/zero >&2; touch "$(dirname "$0")/logged"; sleep 5; exit 1"#);
    let started = std::time::Instant::now();
    assert_eq!(open(&app, "https://example.com/").await.unwrap(), "Starting");
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
    assert!(dir.join("logged").exists(), "the browser was left blocked on its error output");
    std::fs::remove_dir_all(dir).unwrap();
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_browser_started_over_d_bus_is_started_from_its_exec_line_instead() {
    // GIO would send a DBusActivatable app the page over D-Bus without waiting for an answer.
    let script = r#"printf '%s\n' "$@" > "$(dirname "$0")/args""#;
    let (dir, app) = browser_with("Web", script, "--desktop-file %k --percent=%% %u", "DBusActivatable=true\n");
    assert!(app.boolean("DBusActivatable"));
    assert_eq!(open(&app, "https://example.com/a").await.unwrap(), "Web");
    let file = dir.join("Web.desktop");
    let args = format!("--desktop-file\n{}\n--percent=%\nhttps://example.com/a\n", file.display());
    assert_eq!(std::fs::read_to_string(dir.join("args")).unwrap(), args);
    std::fs::remove_dir_all(dir).unwrap();

    let (dir, app) = browser_with("Web", "echo 'no such service' >&2; exit 2", "%u", "DBusActivatable=true\n");
    assert_eq!(open(&app, "https://example.com/").await.unwrap_err(), "Web stopped with exit code 2: no such service");
    std::fs::remove_dir_all(dir).unwrap();
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_launch_nobody_waits_for_still_reaps_the_browser() {
    let (dir, app) = browser("Dropped", r#"echo $$ > "$(dirname "$0")/pid""#);
    drop(hermes_chat::browser::launch(&app, "https://example.com/", None).unwrap());
    let started = std::time::Instant::now();
    let pid = loop {
        if let Ok(pid) = std::fs::read_to_string(dir.join("pid")) {
            if !pid.is_empty() {
                break pid.trim().to_owned();
            }
        }
        assert!(started.elapsed() < std::time::Duration::from_secs(5), "the browser never ran");
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    };
    // A zombie keeps its /proc entry until it is reaped.
    while std::path::Path::new(&format!("/proc/{pid}")).exists() {
        assert!(started.elapsed() < std::time::Duration::from_secs(5), "browser {pid} was left a zombie");
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    std::fs::remove_dir_all(dir).unwrap();
}
