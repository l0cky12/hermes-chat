//! The dashboard client goes straight to the dashboard even when the environment names a proxy (#479). Its own test
//! binary, because the proxy variables are read for the whole process.

use hermes_chat::transport;
use reqwest::header::HeaderMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// A listener that writes down the first bytes of every connection and answers each with an empty 200.
async fn recording() -> (u16, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let kept = seen.clone();
    tokio::spawn(async move {
        while let Ok((mut s, _)) = listener.accept().await {
            let kept = kept.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 16384];
                let n = s.read(&mut buf).await.unwrap_or(0);
                kept.lock().unwrap().push(String::from_utf8_lossy(&buf[..n]).into_owned());
                let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}").await;
            });
        }
    });
    (port, seen)
}

#[tokio::test]
async fn a_proxy_in_the_environment_never_sees_a_dashboard_request() {
    let (proxy_port, proxy) = recording().await;
    let (dashboard_port, dashboard) = recording().await;
    let proxy_url = format!("http://127.0.0.1:{proxy_port}");
    for name in ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"] {
        // SAFETY: this binary's only test sets these before any client reads them.
        unsafe { std::env::set_var(name, &proxy_url) };
    }
    for name in ["NO_PROXY", "no_proxy"] {
        // SAFETY: as above.
        unsafe { std::env::remove_var(name) };
    }
    let http = transport::client(&HeaderMap::new()).unwrap();

    // The SSH route: the sign-in tunnel's local end.
    let sign_in = http
        .post(format!("http://127.0.0.1:{dashboard_port}/api/auth/password-login"))
        .body(r#"{"username":"liam","password":"correct-horse-battery-staple"}"#)
        .timeout(Duration::from_secs(5))
        .send()
        .await;
    assert!(sign_in.is_ok(), "the sign-in reached the tunnel: {sign_in:?}");
    let to_proxy = proxy.lock().unwrap().clone();
    assert!(to_proxy.is_empty(), "the proxy saw the sign-in: {to_proxy:?}");
    assert!(dashboard.lock().unwrap().iter().any(|r| r.contains("correct-horse-battery-staple")), "the tunnel got the sign-in");

    // A URL route: its socket never goes through a proxy, so its requests don't either.
    let _ = http.get("http://hermes.invalid/api/status").timeout(Duration::from_secs(5)).send().await;

    let seen = proxy.lock().unwrap().clone();
    assert!(seen.is_empty(), "the proxy saw dashboard requests: {seen:?}");
}
