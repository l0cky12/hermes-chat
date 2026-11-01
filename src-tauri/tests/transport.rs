//! The Rust transport against a local stub of the dashboard's sign-in routes, `/api/ws` and REST.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, RawQuery};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{AppendHeaders, IntoResponse, Response};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use hermes_chat::transport::{self, Dashboard, PipeEvent, SignIn, TransportError};
use serde_json::{json, Value};
use std::collections::HashMap;
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
    ws.on_upgrade(session)
}

/// Sends `gateway.ready`, then answers `echo` requests, splits a `pair` request into two frames in one
/// WS message, and closes on `bye`.
async fn session(mut ws: WebSocket) {
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
    let (tx, rx) = mpsc::unbounded_channel();
    let pipe = signed_in()
        .await
        .open_pipe(move |e| {
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
