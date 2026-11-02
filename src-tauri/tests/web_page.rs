//! The preview's framing check and "Open in your browser" against local sites (issue #55).

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
    assert_eq!(
        check("/csp").await.unwrap(),
        Framing::Refused { by: "Content-Security-Policy: frame-ancestors 'none'".into() }
    );
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
    let closed = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap();
    match web_page::check(&format!("http://{closed}/"), UA).await.unwrap() {
        Framing::Unreachable { message } => assert!(message.to_lowercase().contains("refused"), "{message}"),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn checks_only_web_addresses() {
    for bad in ["file:///etc/passwd", "tauri://localhost/", "https://liam:pw@example.com/"] {
        assert!(web_page::check(bad, UA).await.is_err(), "{bad}");
        assert!(web_page::open_with("true", bad).await.is_err(), "{bad}");
    }
}

#[tokio::test]
async fn opens_the_page_with_the_desktop_opener() {
    let dir = std::env::temp_dir().join(format!("hermes-open-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let out = dir.join("args");
    let opener = dir.join("fake-xdg-open");
    std::fs::write(&opener, format!("#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\n", out.display())).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&opener, std::fs::Permissions::from_mode(0o700)).unwrap();

    web_page::open_with(opener.to_str().unwrap(), "https://www.google.com/search?q=a b;$(id)").await.unwrap();
    // One argument, the checked address, with nothing a shell would act on.
    assert_eq!(std::fs::read_to_string(&out).unwrap(), "https://www.google.com/search?q=a%20b;$(id)\n");

    let err = web_page::open_with("false", "https://example.com/").await.unwrap_err();
    assert!(err.contains("exited with 1"), "{err}");
    let err = web_page::open_with("/nonexistent/xdg-open", "https://example.com/").await.unwrap_err();
    assert!(err.contains("xdg-utils"), "{err}");
    std::fs::remove_dir_all(dir).unwrap();
}
