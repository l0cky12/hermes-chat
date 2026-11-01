//! The Rust transport against a local stub of the dashboard's sign-in routes, `/api/ws` and REST.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, RawQuery};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{AppendHeaders, IntoResponse, Response};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use hermes_chat::transport::{self, Dashboard, LocalFile, PipeEvent, SignIn, TransportError};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::IpAddr;
use std::path::PathBuf;
use std::time::Duration;
use tokio::sync::mpsc;
use url::Url;

const READY: &str = r#"{"jsonrpc":"2.0","method":"event","params":{"type":"gateway.ready","payload":{"skin":{},"change_events":true,"heartbeat":true,"replay_epoch":"e1"}}}"#;

async fn login(Json(body): Json<Value>) -> Response {
    if body == json!({"provider": "basic", "username": "liam", "password": "hunter2"}) {
        (
            AppendHeaders([
                (header::SET_COOKIE, "hermes_session_at=AT; Path=/; HttpOnly; SameSite=Lax"),
                (header::SET_COOKIE, "hermes_session_rt=RT; Path=/auth; HttpOnly"),
            ]),
            Json(json!({"ok": true, "next": "/"})),
        )
            .into_response()
    } else if body["password"] == "slow-down" {
        StatusCode::TOO_MANY_REQUESTS.into_response()
    } else {
        (StatusCode::UNAUTHORIZED, Json(json!({"detail": "Invalid credentials"}))).into_response()
    }
}

async fn ws_ticket(headers: HeaderMap) -> Response {
    let cookie = headers.get(header::COOKIE).and_then(|v| v.to_str().ok()).unwrap_or("");
    if cookie.split("; ").any(|c| c == "hermes_session_at=AT") {
        Json(json!({"ticket": "TICKET-1", "ttl_seconds": 30})).into_response()
    } else {
        (StatusCode::UNAUTHORIZED, Json(json!({"error": "unauthenticated", "reason": "no_cookie"}))).into_response()
    }
}

fn cookie(headers: &HeaderMap) -> String {
    headers.get(header::COOKIE).and_then(|v| v.to_str().ok()).unwrap_or("").to_owned()
}

/// Signed-in REST: accepts the first access cookie or the rotated one, and echoes what it got.
async fn list_sessions(headers: HeaderMap, RawQuery(query): RawQuery) -> Response {
    let cookie = cookie(&headers);
    if !cookie.split("; ").any(|c| c == "hermes_session_at=AT" || c == "hermes_session_at=AT2") {
        return (StatusCode::UNAUTHORIZED, Json(json!({"error": "session_expired"}))).into_response();
    }
    Json(json!({"query": query, "cookie": cookie})).into_response()
}

async fn patch_session(Path(id): Path<String>, headers: HeaderMap, body: String) -> Response {
    let content_type = headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("");
    Json(json!({"id": id, "content_type": content_type, "body": serde_json::from_str::<Value>(&body).unwrap()})).into_response()
}

/// The dashboard rotating an expired access token through the refresh cookie (dashboard_auth middleware).
async fn rotate() -> Response {
    (AppendHeaders([(header::SET_COOKIE, "hermes_session_at=AT2; Path=/; HttpOnly")]), Json(json!({}))).into_response()
}

/// A refresh that failed: the dashboard clears the access cookie.
async fn expire() -> Response {
    (AppendHeaders([(header::SET_COOKIE, "hermes_session_at=; Max-Age=0; Path=/")]), Json(json!({}))).into_response()
}

async fn busy() -> Response {
    (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"detail": "Session store is busy"}))).into_response()
}

async fn api_ws(ws: WebSocketUpgrade, Query(q): Query<HashMap<String, String>>) -> Response {
    if q.get("ticket").map(String::as_str) != Some("TICKET-1") {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let profile = q.get("profile").cloned();
    ws.on_upgrade(move |ws| session(ws, profile))
}

/// Sends `gateway.ready`, then answers `echo` requests, splits a `pair` request into two frames in one
/// WS message, says which `?profile=` the socket was opened with on `profile`, and closes on `bye`.
async fn session(mut ws: WebSocket, profile: Option<String>) {
    ws.send(Message::text(READY)).await.unwrap();
    while let Some(Ok(Message::Text(text))) = ws.recv().await {
        let req: Value = serde_json::from_str(&text).unwrap();
        let id = req["id"].clone();
        match req["method"].as_str() {
            Some("echo") => {
                let reply = json!({"jsonrpc": "2.0", "id": id, "result": req["params"]});
                ws.send(Message::text(reply.to_string())).await.unwrap();
            }
            Some("pair") => {
                let a = json!({"jsonrpc": "2.0", "id": id, "result": {"n": 1}});
                let b = json!({"jsonrpc": "2.0", "method": "event", "params": {"type": "message.start", "session_id": "s1", "payload": {}}});
                ws.send(Message::text(format!("{a}\n{b}\n"))).await.unwrap();
            }
            Some("profile") => {
                let reply = json!({"jsonrpc": "2.0", "id": id, "result": {"profile": profile}});
                ws.send(Message::text(reply.to_string())).await.unwrap();
            }
            Some("bye") => {
                let _ = ws.send(Message::Close(None)).await;
                return;
            }
            _ => {}
        }
    }
}

async fn stub() -> Url {
    let app = Router::new()
        .route("/auth/password-login", post(login))
        .route("/api/auth/ws-ticket", post(ws_ticket))
        .route("/api/ws", get(api_ws))
        .route("/api/sessions", get(list_sessions))
        .route("/api/sessions/{id}", patch(patch_session))
        .route("/api/rotate", get(rotate))
        .route("/api/expire", get(expire))
        .route("/api/busy", get(busy));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Url::parse(&format!("http://{addr}/")).unwrap()
}

fn sign_in(password: &str) -> SignIn {
    SignIn { username: "liam".into(), password: password.into() }
}

async fn next(rx: &mut mpsc::UnboundedReceiver<PipeEvent>) -> PipeEvent {
    tokio::time::timeout(Duration::from_secs(5), rx.recv()).await.expect("event in time").expect("pipe open")
}

fn frame(event: PipeEvent) -> Value {
    match event {
        PipeEvent::Frame { text } => serde_json::from_str(&text).unwrap(),
        other => panic!("expected a frame, got {other:?}"),
    }
}

async fn signed_in() -> Dashboard {
    Dashboard::sign_in(&stub().await, &sign_in("hunter2")).await.expect("signed in")
}

async fn open_stub() -> (transport::Pipe, mpsc::UnboundedReceiver<PipeEvent>) {
    open_stub_for("default").await
}

async fn open_stub_for(profile: &str) -> (transport::Pipe, mpsc::UnboundedReceiver<PipeEvent>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let pipe = signed_in()
        .await
        .open_pipe(profile, move |e| {
            let _ = tx.send(e);
        })
        .await
        .expect("pipe open");
    (pipe, rx)
}

async fn get_json(dashboard: &Dashboard, path: &str) -> Value {
    serde_json::from_str(&dashboard.request("GET", path, None).await.expect("2xx")).unwrap()
}

#[tokio::test]
async fn signs_in_and_receives_gateway_ready_first() {
    let (_pipe, mut rx) = open_stub().await;
    assert_eq!(frame(next(&mut rx).await)["params"]["type"], "gateway.ready");
}

#[tokio::test]
async fn relays_frames_both_ways() {
    let (pipe, mut rx) = open_stub().await;
    next(&mut rx).await;
    pipe.send(json!({"jsonrpc": "2.0", "id": 7, "method": "echo", "params": {"hi": "there"}}).to_string()).unwrap();
    assert_eq!(frame(next(&mut rx).await), json!({"jsonrpc": "2.0", "id": 7, "result": {"hi": "there"}}));
}

#[tokio::test]
async fn splits_newline_delimited_messages_into_frames() {
    let (pipe, mut rx) = open_stub().await;
    next(&mut rx).await;
    pipe.send(json!({"jsonrpc": "2.0", "id": 1, "method": "pair"}).to_string()).unwrap();
    assert_eq!(frame(next(&mut rx).await)["result"], json!({"n": 1}));
    assert_eq!(frame(next(&mut rx).await)["params"]["type"], "message.start");
}

#[tokio::test]
async fn opens_the_socket_for_the_profile() {
    let (pipe, mut rx) = open_stub_for("work email").await;
    next(&mut rx).await;
    pipe.send(json!({"jsonrpc": "2.0", "id": 1, "method": "profile"}).to_string()).unwrap();
    assert_eq!(frame(next(&mut rx).await)["result"], json!({"profile": "work email"}));
}

#[tokio::test]
async fn reports_when_the_server_closes_the_socket() {
    let (pipe, mut rx) = open_stub().await;
    next(&mut rx).await;
    pipe.send(json!({"jsonrpc": "2.0", "id": 1, "method": "bye"}).to_string()).unwrap();
    assert!(matches!(next(&mut rx).await, PipeEvent::Closed { .. }));
}

#[tokio::test]
async fn wrong_password_is_bad_credentials() {
    let base = stub().await;
    let err = Dashboard::sign_in(&base, &sign_in("nope")).await.err().unwrap();
    assert!(matches!(err, TransportError::BadCredentials), "{err:?}");
}

#[tokio::test]
async fn rate_limited_sign_in_is_reported() {
    let base = stub().await;
    let err = Dashboard::sign_in(&base, &sign_in("slow-down")).await.err().unwrap();
    assert!(matches!(err, TransportError::RateLimited), "{err:?}");
}

#[tokio::test]
async fn nothing_listening_is_unreachable() {
    let port = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap().port();
    let base = Url::parse(&format!("http://127.0.0.1:{port}/")).unwrap();
    let err = Dashboard::sign_in(&base, &sign_in("hunter2")).await.err().unwrap();
    assert!(matches!(err, TransportError::Unreachable(_)), "{err:?}");
}

#[tokio::test]
async fn relays_a_rest_get_with_the_sign_in_cookies() {
    let dashboard = signed_in().await;
    let got = get_json(&dashboard, "api/sessions?profile=default&order=recent&limit=100").await;
    assert_eq!(got["query"], "profile=default&order=recent&limit=100");
    assert_eq!(got["cookie"], "hermes_session_at=AT; hermes_session_rt=RT");
}

#[tokio::test]
async fn relays_a_rest_patch_with_a_json_body() {
    let dashboard = signed_in().await;
    let body = json!({"pinned": true, "profile": "default"}).to_string();
    let got: Value = serde_json::from_str(&dashboard.request("PATCH", "api/sessions/20261031_120000_abc", Some(body)).await.unwrap()).unwrap();
    assert_eq!(got, json!({"id": "20261031_120000_abc", "content_type": "application/json", "body": {"pinned": true, "profile": "default"}}));
}

#[tokio::test]
async fn keeps_cookies_the_dashboard_rotates() {
    let dashboard = signed_in().await;
    get_json(&dashboard, "api/rotate").await;
    assert_eq!(get_json(&dashboard, "api/sessions").await["cookie"], "hermes_session_rt=RT; hermes_session_at=AT2");
}

#[tokio::test]
async fn an_expired_sign_in_is_signed_out() {
    let dashboard = signed_in().await;
    get_json(&dashboard, "api/expire").await;
    let err = dashboard.request("GET", "api/sessions", None).await.err().unwrap();
    assert!(matches!(err, TransportError::SignedOut), "{err:?}");
}

#[tokio::test]
async fn a_failed_rest_call_reports_status_and_body() {
    let dashboard = signed_in().await;
    let err = dashboard.request("GET", "api/busy", None).await.err().unwrap();
    assert!(matches!(&err, TransportError::Unexpected { status: 503, body } if body.contains("busy")), "{err:?}");
}

#[tokio::test]
async fn relays_only_get_and_patch_under_api() {
    let dashboard = signed_in().await;
    for (method, path) in [("GET", "auth/logout"), ("GET", "api/../auth/logout"), ("DELETE", "api/sessions/x"), ("POST", "api/sessions")] {
        let err = dashboard.request(method, path, None).await.err().unwrap();
        assert!(matches!(err, TransportError::NotRelayed(_)), "{method} {path}: {err:?}");
    }
}

/// A fresh folder under the system temp dir for one test's files.
fn scratch(test: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("hermes-chat-{test}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn path_of(p: &PathBuf) -> String {
    p.to_str().unwrap().to_owned()
}

#[tokio::test]
async fn stats_files_to_attach() {
    let dir = scratch("stat");
    let png = dir.join("rack.png");
    std::fs::write(&png, b"\x89PNG fake").unwrap();
    let got = transport::stat_files(&[path_of(&png), path_of(&dir), path_of(&dir.join("gone.txt"))]).await;
    let name = dir.file_name().unwrap().to_str().unwrap().to_owned();
    assert_eq!(
        got,
        vec![
            LocalFile { path: path_of(&png), name: "rack.png".into(), size: Some(9), error: None },
            LocalFile { path: path_of(&dir), name, size: None, error: Some("it's a folder".into()) },
            LocalFile {
                path: path_of(&dir.join("gone.txt")),
                name: "gone.txt".into(),
                size: None,
                error: Some("No such file or directory (os error 2)".into()),
            },
        ]
    );
}

#[tokio::test]
async fn sends_a_file_as_base64_inside_one_frame() {
    let dir = scratch("send");
    let file = dir.join("notes.txt");
    std::fs::write(&file, b"sda 92%").unwrap();
    let (pipe, mut rx) = open_stub().await;
    next(&mut rx).await;
    let head = r#"{"jsonrpc":"2.0","id":3,"method":"echo","params":{"name":"notes.txt","data_url":"data:application/octet-stream;base64,"#;
    pipe.send_file(head, &path_of(&file), r#""}}"#, 1024).await.unwrap();
    assert_eq!(
        frame(next(&mut rx).await)["result"],
        json!({"name": "notes.txt", "data_url": "data:application/octet-stream;base64,c2RhIDkyJQ=="})
    );
}

#[tokio::test]
async fn refuses_to_send_a_file_over_the_limit() {
    let dir = scratch("too-big");
    let file = dir.join("big.png");
    std::fs::write(&file, vec![0u8; 3 * 1024 * 1024 / 2]).unwrap();
    let (pipe, mut rx) = open_stub().await;
    next(&mut rx).await;
    let err = pipe.send_file(r#"{"id":1,"method":"echo","params":{"b":""#, &path_of(&file), r#""}}"#, 1024 * 1024).await.err().unwrap();
    assert_eq!(err.to_string(), "it's 1.5 MB now, over the 1 MB limit");

    // Nothing went out: the next frame back answers the next request.
    pipe.send(json!({"jsonrpc": "2.0", "id": 2, "method": "echo", "params": {}}).to_string()).unwrap();
    assert_eq!(frame(next(&mut rx).await)["id"], 2);
}

#[tokio::test]
async fn reports_a_file_that_is_gone() {
    let dir = scratch("gone");
    let (pipe, mut rx) = open_stub().await;
    next(&mut rx).await;
    let err = pipe.send_file("", &path_of(&dir.join("gone.txt")), "", 1024).await.err().unwrap();
    assert_eq!(err.to_string(), "No such file or directory (os error 2)");
}

#[tokio::test]
async fn resolves_the_host_name_of_a_direct_url() {
    let direct = transport::resolve_direct("http://localhost:9119").await.expect("resolved");
    assert_eq!(direct.base.as_str(), "http://localhost:9119/");
    assert!(!direct.addresses.is_empty());
    assert!(direct.addresses.iter().all(IpAddr::is_loopback), "{:?}", direct.addresses);
}

#[tokio::test]
async fn a_direct_url_to_an_ip_address_needs_no_lookup() {
    let direct = transport::resolve_direct(" http://100.100.64.121:9119/ ").await.expect("parsed");
    assert_eq!(direct.base.as_str(), "http://100.100.64.121:9119/");
    assert!(direct.addresses.is_empty());
}

#[tokio::test]
async fn a_direct_ws_url_is_signed_in_to_over_http() {
    let base = stub().await;
    let typed = format!("ws://{}:{}/?ignored=1", base.host_str().unwrap(), base.port().unwrap());
    let direct = transport::resolve_direct(&typed).await.expect("parsed");
    assert_eq!(direct.base, base);
    let (tx, mut rx) = mpsc::unbounded_channel();
    let dashboard = Dashboard::sign_in(&direct.base, &sign_in("hunter2")).await.expect("signed in");
    let _pipe = dashboard.open_pipe("default", move |e| drop(tx.send(e))).await.expect("pipe open");
    assert_eq!(frame(next(&mut rx).await)["params"]["type"], "gateway.ready");

    let secure = transport::resolve_direct("wss://127.0.0.1/hermes/").await.expect("parsed");
    assert_eq!(secure.base.as_str(), "https://127.0.0.1/hermes/");
}

#[tokio::test]
async fn refuses_a_direct_url_that_is_not_http_or_ws() {
    // A user or password in the URL would be saved and shown; the password field is for that.
    for typed in ["hermes:9119", "liam@hermes", "ftp://hermes/", "file:///etc/passwd", "", "http://liam:hunter2@hermes:9119"] {
        let err = transport::resolve_direct(typed).await.err().unwrap();
        assert!(matches!(err, TransportError::BadUrl), "{typed}: {err:?}");
    }
}

#[tokio::test]
async fn a_direct_url_whose_name_does_not_resolve_is_unreachable() {
    let err = transport::resolve_direct("http://no-such-host.invalid:9119").await.err().unwrap();
    assert!(matches!(err, TransportError::Unreachable(_)), "{err:?}");
}
