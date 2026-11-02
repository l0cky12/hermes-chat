//! The Rust transport against a local stub of the dashboard's sign-in routes, `/api/ws` and REST.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, RawQuery};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{AppendHeaders, IntoResponse, Response};
use axum::routing::{get, patch, post, put};
use axum::{Json, Router};
use axum::extract::{Request, State};
use axum::middleware::{self, Next};
use axum::response::Redirect;
use hermes_chat::transport::{self, Dashboard, ExtraHeader, LocalFile, PipeEvent, SignIn, TransportError};
use std::sync::{Arc, Mutex};
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
    Json(json!({"id": id, "content_type": content_type, "body": serde_json::from_str::<Value>(&body).unwrap_or(Value::Null)})).into_response()
}

async fn delete_session(Path(id): Path<String>, RawQuery(query): RawQuery) -> Response {
    Json(json!({"deleted": id, "query": query})).into_response()
}

/// Settings → Model's writes: `POST /api/model/set` and `PUT /api/config` echo what they got.
async fn echo_write(axum::extract::OriginalUri(uri): axum::extract::OriginalUri, headers: HeaderMap, body: String) -> Response {
    let content_type = headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("");
    Json(json!({"uri": uri.to_string(), "content_type": content_type, "body": serde_json::from_str::<Value>(&body).unwrap_or(Value::Null)})).into_response()
}

/// The dashboard rotating an expired access token through the refresh cookie (dashboard_auth middleware).
async fn rotate() -> Response {
    (AppendHeaders([(header::SET_COOKIE, "hermes_session_at=AT2; Path=/; HttpOnly")]), Json(json!({}))).into_response()
}

/// A refresh that failed: the dashboard clears the access cookie.
async fn expire() -> Response {
    (AppendHeaders([(header::SET_COOKIE, "hermes_session_at=; Max-Age=0; Path=/")]), Json(json!({}))).into_response()
}

/// `GET /api/files/read` as a stand-in for a big answer: `n` bytes of JSON, sent with a Content-Length, or in
/// chunks without one when `chunked` is set. Echoes the query and cookie in the first bytes.
async fn read_file(headers: HeaderMap, Query(q): Query<HashMap<String, String>>) -> Response {
    let n: usize = q.get("n").and_then(|n| n.parse().ok()).unwrap_or(0);
    let head = json!({"path": q.get("path"), "cookie": cookie(&headers)}).to_string();
    let body = format!("{}{}", &head[..head.len() - 1], format!(r#","pad":"{}"}}"#, "x".repeat(n.saturating_sub(head.len() + 9))));
    if q.contains_key("chunked") {
        let chunks: Vec<Result<String, std::io::Error>> = body.as_bytes().chunks(1024).map(|c| Ok(String::from_utf8(c.to_vec()).unwrap())).collect();
        axum::body::Body::from_stream(futures_util::stream::iter(chunks)).into_response()
    } else {
        body.into_response()
    }
}

/// A 500 whose body never ends (`?endless`) or is 50 MB with a Content-Length.
async fn flood(Query(q): Query<HashMap<String, String>>) -> Response {
    let body = if q.contains_key("endless") {
        axum::body::Body::from_stream(futures_util::stream::repeat_with(|| Ok::<_, std::io::Error>("x".repeat(64 * 1024))))
    } else {
        axum::body::Body::from("x".repeat(50 * 1024 * 1024))
    };
    (StatusCode::INTERNAL_SERVER_ERROR, body).into_response()
}

async fn busy() -> Response {
    (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"detail": "Session store is busy"}))).into_response()
}

/// The audio routes and config as `hermes_cli/web_routers/audio.py` and `config_env.py` answer them at the deployed
/// `bf0203a`. Profile `old` stands for a server without them (FastAPI's own 404); profile `nobody` doesn't exist.
fn audio_gate(headers: &HeaderMap, q: &HashMap<String, String>) -> Option<Response> {
    if !cookie(headers).split("; ").any(|c| c == "hermes_session_at=AT") {
        return Some((StatusCode::UNAUTHORIZED, Json(json!({"error": "session_expired"}))).into_response());
    }
    match q.get("profile").map(String::as_str) {
        Some("old") => Some((StatusCode::NOT_FOUND, Json(json!({"detail": "Not Found"}))).into_response()),
        // The deployed dashboard's catch-all GET route makes a POST to a path it lacks a 405 (checked live).
        Some("older") => Some((StatusCode::METHOD_NOT_ALLOWED, Json(json!({"detail": "Method Not Allowed"}))).into_response()),
        Some("nobody") => Some((StatusCode::NOT_FOUND, Json(json!({"detail": "Profile 'nobody' not found"}))).into_response()),
        _ => None,
    }
}

/// What the deployed `bf0203a` answers when the profile has no working transcriber (checked live, 2026-11-02).
const NO_STT: &str = "No STT provider available. Install faster-whisper for free local transcription, configure HERMES_LOCAL_STT_COMMAND or install a local whisper CLI, set GROQ_API_KEY for free Groq Whisper, set MISTRAL_API_KEY for Mistral Voxtral Transcribe, configure xAI OAuth or set XAI_API_KEY for xAI Grok STT, set ELEVENLABS_API_KEY for ElevenLabs Scribe, or set VOICE_TOOLS_OPENAI_KEY or OPENAI_API_KEY for the OpenAI Whisper API.";

async fn transcribe(headers: HeaderMap, Query(q): Query<HashMap<String, String>>, Json(body): Json<Value>) -> Response {
    if let Some(r) = audio_gate(&headers, &q) {
        return r;
    }
    let data_url = body["data_url"].as_str().unwrap_or("");
    let Some((head, encoded)) = data_url.strip_prefix("data:").and_then(|u| u.split_once(',')) else {
        return (StatusCode::BAD_REQUEST, Json(json!({"detail": "Invalid audio payload"}))).into_response();
    };
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).unwrap();
    if bytes == b"quiet" {
        return Json(json!({"ok": true, "transcript": "", "provider": "local"})).into_response();
    }
    if bytes == b"no-stt" {
        return (StatusCode::BAD_REQUEST, Json(json!({"detail": NO_STT}))).into_response();
    }
    if bytes == b"broken" {
        return (StatusCode::BAD_REQUEST, Json(json!({"detail": "No STT provider available. Install faster-whisper"}))).into_response();
    }
    let said = format!("  {} bytes of {head} as {} for {}  ", bytes.len(), body["mime_type"], q["profile"]);
    Json(json!({"ok": true, "transcript": said, "provider": "local"})).into_response()
}

async fn speak(headers: HeaderMap, Query(q): Query<HashMap<String, String>>, Json(body): Json<Value>) -> Response {
    if let Some(r) = audio_gate(&headers, &q) {
        return r;
    }
    use base64::Engine;
    match body["text"].as_str().unwrap_or("").trim() {
        "" => (StatusCode::BAD_REQUEST, Json(json!({"detail": "Text is required"}))).into_response(),
        "fail" => (StatusCode::BAD_REQUEST, Json(json!({"detail": "edge-tts is not installed"}))).into_response(),
        "html" => Json(json!({"ok": true, "data_url": "data:text/html;base64,PGI+", "mime_type": "text/html"})).into_response(),
        text => {
            let audio = base64::engine::general_purpose::STANDARD.encode(format!("ID3:{text}"));
            Json(json!({"ok": true, "data_url": format!("data:audio/mpeg;base64,{audio}"), "mime_type": "audio/mpeg", "provider": "edge"})).into_response()
        }
    }
}

/// `GET /api/config` answers the whole config, unredacted: provider sections can hold API keys.
async fn config(headers: HeaderMap, Query(q): Query<HashMap<String, String>>) -> Response {
    if let Some(r) = audio_gate(&headers, &q) {
        return r;
    }
    Json(json!({
        "model": {"default": "glm-5.3-flash", "api_key": "sk-model-SECRET"},
        "stt": {"enabled": false, "provider": "groq", "groq": {"api_key": "gsk-SECRET"}},
        "tts": {"provider": "openai", "openai": {"api_key": "sk-tts-SECRET", "voice": "alloy"}},
    }))
    .into_response()
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
    serve(stub_routes()).await
}

/// The stub dashboard served under a path prefix, such as `team%20one`, as a reverse proxy might.
async fn stub_under(prefix: &str) -> Url {
    let base = serve(Router::new().nest(&format!("/{prefix}"), stub_routes())).await;
    base.join(&format!("{prefix}/")).unwrap()
}

fn stub_routes() -> Router {
    Router::new()
        .route("/auth/password-login", post(login))
        .route("/api/auth/ws-ticket", post(ws_ticket))
        .route("/api/ws", get(api_ws))
        .route("/api/sessions", get(list_sessions))
        .route("/api/sessions/{id}", patch(patch_session).delete(delete_session))
        .route("/api/model/set", post(echo_write))
        .route("/api/config", put(echo_write).get(config))
        .route("/api/model/moa", put(echo_write).post(echo_write))
        .route("/api/cron/jobs", post(echo_write))
        .route("/api/cron/jobs/{id}", put(echo_write))
        .route("/api/cron/jobs/{id}/{action}", post(echo_write))
        .route("/api/rotate", get(rotate))
        .route("/api/expire", get(expire))
        .route("/api/busy", get(busy))
        .route("/api/audio/transcribe", post(transcribe))
        .route("/api/audio/speak", post(speak))
        .route("/api/files/read", get(read_file))
        .route("/api/flood", get(flood))
}

async fn serve(app: Router) -> Url {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Url::parse(&format!("http://{addr}/")).unwrap()
}

fn sign_in(password: &str) -> SignIn {
    SignIn { username: "liam".into(), password: password.into(), headers: Default::default() }
}

fn header(name: &str, value: &str) -> ExtraHeader {
    ExtraHeader { name: name.into(), value: value.into() }
}

/// Every request a stub got: its path, and the value of `cf-access-client-secret` it carried.
type Seen = Arc<Mutex<Vec<(String, Option<String>)>>>;

/// Notes every request in `seen`, then refuses any without the Cloudflare Access service token, as Access would.
async fn access_gate(State(seen): State<Seen>, req: Request, next: Next) -> Response {
    let (id, secret) = (header_of(&req, "cf-access-client-id"), header_of(&req, "cf-access-client-secret"));
    seen.lock().unwrap().push((req.uri().path().to_owned(), secret.clone()));
    if id.as_deref() == Some("id.access") && secret.as_deref() == Some("s3cret") {
        next.run(req).await
    } else {
        (StatusCode::FORBIDDEN, "Forbidden. You don't have permission to view this.").into_response()
    }
}

/// A server on another origin that notes every request it gets.
async fn other_site() -> (Url, Seen) {
    let seen = Seen::default();
    let app = Router::new().fallback(|| async { "elsewhere" }).layer(middleware::from_fn_with_state(seen.clone(), note));
    (serve(app).await, seen)
}

async fn note(State(seen): State<Seen>, req: Request, next: Next) -> Response {
    let secret = header_of(&req, "cf-access-client-secret");
    seen.lock().unwrap().push((req.uri().path().to_owned(), secret));
    next.run(req).await
}

fn header_of(req: &Request, name: &str) -> Option<String> {
    req.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_owned)
}

/// The stub behind an Access-style gate, with one redirect within the dashboard and one to `elsewhere`.
async fn gated_stub(elsewhere: &Url) -> (Url, Seen) {
    let seen = Seen::default();
    let away = elsewhere.join("steal").unwrap().to_string();
    let app = stub_routes()
        .route("/api/moved", get(|| async { Redirect::temporary("/api/sessions?moved=1") }))
        .route("/api/away", get(move || async move { Redirect::temporary(&away) }))
        .layer(middleware::from_fn_with_state(seen.clone(), access_gate));
    (serve(app).await, seen)
}

fn access_sign_in() -> SignIn {
    let headers = transport::extra_headers(&[header("CF-Access-Client-Id", "id.access"), header("CF-Access-Client-Secret", "s3cret")]).unwrap();
    SignIn { headers, ..sign_in("hunter2") }
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
async fn relays_a_rest_delete() {
    let dashboard = signed_in().await;
    let got: Value = serde_json::from_str(&dashboard.request("DELETE", "api/sessions/20261031_120000_abc?profile=default", None).await.unwrap()).unwrap();
    assert_eq!(got, json!({"deleted": "20261031_120000_abc", "query": "profile=default"}));
}

#[tokio::test]
async fn relays_the_model_settings_writes() {
    let dashboard = signed_in().await;
    let body = json!({"scope": "main", "provider": "nous", "model": "m"}).to_string();
    let got: Value = serde_json::from_str(&dashboard.request("POST", "api/model/set?profile=default", Some(body)).await.unwrap()).unwrap();
    assert_eq!(got, json!({"uri": "/api/model/set?profile=default", "content_type": "application/json", "body": {"scope": "main", "provider": "nous", "model": "m"}}));
    let body = json!({"config": {"agent": {"reasoning_effort": "low"}}}).to_string();
    let got: Value = serde_json::from_str(&dashboard.request("PUT", "api/config?profile=default", Some(body)).await.unwrap()).unwrap();
    assert_eq!(got, json!({"uri": "/api/config?profile=default", "content_type": "application/json", "body": {"config": {"agent": {"reasoning_effort": "low"}}}}));
}

#[tokio::test]
async fn relays_the_scheduled_job_writes() {
    let dashboard = signed_in().await;
    let body = json!({"schedule": "0 9 * * *", "prompt": "p"}).to_string();
    let got: Value = serde_json::from_str(&dashboard.request("POST", "api/cron/jobs?profile=default", Some(body)).await.unwrap()).unwrap();
    assert_eq!(got["uri"], "/api/cron/jobs?profile=default");
    let body = json!({"updates": {"name": "n"}}).to_string();
    let got: Value = serde_json::from_str(&dashboard.request("PUT", "api/cron/jobs/f8f9e9ea90bc?profile=default", Some(body)).await.unwrap()).unwrap();
    assert_eq!(got, json!({"uri": "/api/cron/jobs/f8f9e9ea90bc?profile=default", "content_type": "application/json", "body": {"updates": {"name": "n"}}}));
    for action in ["pause", "resume", "trigger"] {
        let got: Value = serde_json::from_str(&dashboard.request("POST", &format!("api/cron/jobs/f8f9e9ea90bc/{action}?profile=default"), None).await.unwrap()).unwrap();
        assert_eq!(got["uri"], format!("/api/cron/jobs/f8f9e9ea90bc/{action}?profile=default"));
    }
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
async fn relays_only_get_patch_and_delete_under_api_the_two_model_writes_and_the_job_writes() {
    let dashboard = signed_in().await;
    for (method, path) in [
        ("GET", "auth/logout"),
        ("GET", "api/../auth/logout"),
        ("DELETE", "auth/logout"),
        ("PUT", "api/sessions/x"),
        ("POST", "api/sessions"),
        ("POST", "api/model/moa"),
        ("PUT", "api/model/moa"),
        ("PUT", "api/model/set"),
        ("POST", "api/config"),
        ("POST", "api/model/set/../../auth/logout"),
        ("OPTIONS", "api/config"),
        ("PUT", "api/cron/jobs"),
        ("POST", "api/cron/jobs/x"),
        ("POST", "api/cron/jobs/x/run"),
        ("POST", "api/cron/jobs/x/pause/now"),
        ("POST", "api/cron/jobs/../../auth/logout"),
        ("POST", "api/cron/jobs/x/../../../auth/logout"),
        ("PUT", "api/cron/jobs/a%2Fb"),
        ("PUT", "api/cron/jobs/x/pause"),
        ("POST", "api/cron/jobsx"),
        ("POST", "api/cron/fire"),
        ("POST", "api/cron/blueprints/instantiate"),
    ] {
        let err = dashboard.request(method, path, None).await.err().unwrap();
        assert!(matches!(err, TransportError::NotRelayed(_)), "{method} {path}: {err:?}");
    }
}

#[tokio::test]
async fn a_limited_get_relays_an_answer_within_the_limit_with_the_sign_in_cookies() {
    let dashboard = signed_in().await;
    for chunked in ["", "&chunked=1"] {
        let got = dashboard.get_limited(&format!("api/files/read?path=%2Fsrv%2Fa.txt&n=5000{chunked}"), 5000).await.expect("within the limit");
        assert_eq!(got.len(), 5000, "{chunked}");
        let got: Value = serde_json::from_str(&got).unwrap();
        assert_eq!(got["path"], "/srv/a.txt");
        assert_eq!(got["cookie"], "hermes_session_at=AT; hermes_session_rt=RT");
    }
}

#[tokio::test]
async fn a_limited_get_refuses_an_answer_over_the_limit() {
    let dashboard = signed_in().await;
    // With a Content-Length it is refused before reading; without one, as soon as the bytes read pass the limit.
    for chunked in ["", "&chunked=1"] {
        let err = dashboard.get_limited(&format!("api/files/read?path=%2Fa&n=5001{chunked}"), 5000).await.err().unwrap();
        assert!(matches!(err, TransportError::FileTooLarge { max: 5000, size } if size > 5000), "{chunked}: {err:?}");
    }
}

#[tokio::test]
async fn a_limited_get_reports_errors_like_any_rest_call() {
    let dashboard = signed_in().await;
    let err = dashboard.get_limited("api/busy", 1000).await.err().unwrap();
    assert!(matches!(&err, TransportError::Unexpected { status: 503, body } if body.contains("busy")), "{err:?}");
    get_json(&dashboard, "api/expire").await;
    let err = dashboard.get_limited("api/sessions", 1000).await.err().unwrap();
    assert!(matches!(err, TransportError::SignedOut), "{err:?}");
}

#[tokio::test]
async fn a_limited_get_stays_under_api() {
    let dashboard = signed_in().await;
    for path in ["auth/logout", "api/../auth/logout", "/api/files/read"] {
        let err = dashboard.get_limited(path, 1000).await.err().unwrap();
        assert!(matches!(err, TransportError::NotRelayed(_)), "{path}: {err:?}");
    }
}

#[tokio::test]
async fn never_relays_a_change_to_the_servers_files() {
    let dashboard = signed_in().await;
    for (method, path) in [
        ("DELETE", "api/files"),
        ("DELETE", "api/files/"),
        ("PATCH", "api/files/mkdir"),
        ("DELETE", "api/fs/write-text"),
        ("PATCH", "api/fs"),
        // Spelled so the server still routes them to the file routes.
        ("DELETE", "api/./files?path=/tmp/x"),
        ("DELETE", "api/%2e/files"),
        ("DELETE", "api/%66iles"),
        ("DELETE", "api%2Ffiles"),
        ("DELETE", "api//files"),
        ("PATCH", "api/f%73/write-text"),
        ("DELETE", "api/sessions/%2E%2E/files"),
    ] {
        let err = dashboard.request(method, path, Some("{}".into())).await.err().unwrap();
        assert!(matches!(err, TransportError::NotRelayed(_)), "{method} {path}: {err:?}");
    }
    // A chat id is still percent-encoded into its path.
    dashboard.request("DELETE", "api/sessions/a%20b", None).await.unwrap();
}

#[tokio::test]
async fn relays_under_a_dashboard_whose_path_is_percent_encoded() {
    for prefix in ["team%20one", "caf%C3%A9"] {
        let base = stub_under(prefix).await;
        let dashboard = Dashboard::sign_in(&base, &sign_in("hunter2")).await.expect(prefix);
        assert_eq!(get_json(&dashboard, "api/sessions?profile=default").await["query"], "profile=default", "{prefix}");
        dashboard.request("DELETE", "api/sessions/a%20b", None).await.expect(prefix);
        assert!(dashboard.get_limited("api/files/read?path=/srv/a&n=10", 1024).await.is_ok(), "{prefix}");
        for path in ["api/./files", "api/%66iles", "api/%2e%2e/%2e%2e/files"] {
            let err = dashboard.request("DELETE", path, None).await.err().unwrap();
            assert!(matches!(err, TransportError::NotRelayed(_)), "{prefix} {path}: {err:?}");
        }
    }
}

#[tokio::test]
async fn reads_only_the_start_of_a_huge_error_answer() {
    let dashboard = signed_in().await;
    for path in ["api/flood", "api/flood?endless"] {
        let call = async {
            let rest = dashboard.request("GET", path, None).await.err().unwrap();
            let limited = dashboard.get_limited(path, 1024).await.err().unwrap();
            (rest, limited)
        };
        let (rest, limited) = tokio::time::timeout(std::time::Duration::from_secs(10), call).await.expect(path);
        for err in [rest, limited] {
            match err {
                TransportError::Unexpected { status: 500, body } => assert_eq!(body.len(), 300, "{path}"),
                other => panic!("{path}: {other:?}"),
            }
        }
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

#[tokio::test]
async fn reads_a_staged_image_for_its_preview() {
    let dir = scratch("preview");
    let png = dir.join("rack.PNG");
    std::fs::write(&png, b"\x89PNG\r\n\x1a\nrest").unwrap();
    assert_eq!(transport::read_preview(&path_of(&png)).await.unwrap(), b"\x89PNG\r\n\x1a\nrest");
    let webp = dir.join("cat.webp");
    std::fs::write(&webp, b"RIFF\0\0\0\0WEBPVP8 ").unwrap();
    assert!(transport::read_preview(&path_of(&webp)).await.is_ok());
}

#[tokio::test]
async fn previews_only_images() {
    let dir = scratch("preview-not-image");
    let txt = dir.join("notes.txt");
    std::fs::write(&txt, b"\x89PNG\r\n\x1a\n").unwrap();
    // Named like an image but isn't one, e.g. a secret renamed.
    let fake = dir.join("id_rsa.png");
    std::fs::write(&fake, b"-----BEGIN OPENSSH PRIVATE KEY-----").unwrap();
    for p in [path_of(&txt), path_of(&fake), "rack.png".into()] {
        assert_eq!(transport::read_preview(&p).await.err().unwrap().to_string(), "it isn't an image", "{p}");
    }
}

#[tokio::test]
async fn refuses_to_preview_a_missing_or_oversized_image() {
    let dir = scratch("preview-refused");
    let err = transport::read_preview(&path_of(&dir.join("gone.png"))).await.err().unwrap();
    assert_eq!(err.to_string(), "No such file or directory (os error 2)");

    let big = dir.join("big.png");
    let f = std::fs::File::create(&big).unwrap();
    f.set_len(transport::PREVIEW_MAX_BYTES + 1).unwrap();
    let err = transport::read_preview(&path_of(&big)).await.err().unwrap();
    assert_eq!(err.to_string(), "it's 25.0 MB now, over the 25 MB limit");
}

#[tokio::test]
async fn transcribes_a_recording_as_a_data_url_for_the_profile() {
    let dashboard = signed_in().await;
    let got = dashboard.transcribe("work email", "audio/wav; codecs=1", b"RIFF....WAVE").await.unwrap();
    assert_eq!(got.text, r#"12 bytes of audio/wav;base64 as "audio/wav" for work email"#);
    assert_eq!(got.provider.as_deref(), Some("local"));
}

#[tokio::test]
async fn hearing_no_speech_is_an_empty_transcript() {
    let got = signed_in().await.transcribe("default", "audio/wav", b"quiet").await.unwrap();
    assert_eq!(got, transport::Transcript { text: String::new(), provider: Some("local".into()) });
}

#[tokio::test]
async fn refuses_a_recording_that_is_not_audio_empty_or_too_long_without_sending_it() {
    let dashboard = signed_in().await;
    for (mime, len) in [("text/plain", 10), ("audio/", 10), ("audio/wav\r\nx: y", 10), ("audio/wav", 0), ("audio/wav", 25 * 1024 * 1024 + 1)] {
        let err = dashboard.transcribe("old", mime, &vec![0u8; len]).await.err().unwrap();
        // Profile `old` would answer 404; these never reach it.
        assert!(matches!(err, TransportError::Voice(_)), "{mime} {len}: {err:?}");
    }
}

#[tokio::test]
async fn a_server_without_the_audio_routes_says_so() {
    let dashboard = signed_in().await;
    let err = dashboard.transcribe("old", "audio/wav", b"RIFF").await.err().unwrap();
    assert_eq!(err.to_string(), "This Hermes server can't transcribe recordings: it has no /api/audio/transcribe route. Updating Hermes adds it.");
    let err = dashboard.speak("old", "Hello").await.err().unwrap();
    assert!(matches!(err, TransportError::NoVoiceRoute("read replies aloud", _)), "{err:?}");
}

#[tokio::test]
async fn a_refusal_carries_hermess_reason() {
    let dashboard = signed_in().await;
    let err = dashboard.transcribe("default", "audio/wav", b"broken").await.err().unwrap();
    assert_eq!(err.to_string(), "Hermes couldn't transcribe the recording: No STT provider available. Install faster-whisper");
    let err = dashboard.transcribe("nobody", "audio/wav", b"RIFF").await.err().unwrap();
    assert_eq!(err.to_string(), "Hermes couldn't transcribe the recording: Profile 'nobody' not found");
    let err = dashboard.speak("default", "fail").await.err().unwrap();
    assert_eq!(err.to_string(), "Hermes couldn't read it aloud: edge-tts is not installed");
}

#[tokio::test]
async fn reads_a_reply_aloud_as_audio_bytes() {
    let speech = signed_in().await.speak("default", "Hello there").await.unwrap();
    assert_eq!(speech, transport::Speech { mime: "audio/mpeg".into(), audio: b"ID3:Hello there".to_vec(), provider: Some("edge".into()) });
}

#[tokio::test]
async fn refuses_speech_that_is_not_audio_or_has_no_text() {
    let dashboard = signed_in().await;
    assert!(matches!(dashboard.speak("default", "html").await, Err(TransportError::Voice(_))));
    assert!(matches!(dashboard.speak("old", "  ").await, Err(TransportError::Voice(_))));
}

#[tokio::test]
async fn an_expired_sign_in_is_signed_out_for_voice_too() {
    let dashboard = signed_in().await;
    get_json(&dashboard, "api/expire").await;
    assert!(matches!(dashboard.transcribe("default", "audio/wav", b"RIFF").await, Err(TransportError::SignedOut)));
    assert!(matches!(dashboard.voice_setup("default").await, Err(TransportError::SignedOut)));
}

#[tokio::test]
async fn reads_the_voice_setup_without_passing_on_any_key() {
    let setup = signed_in().await.voice_setup("default").await.unwrap();
    assert_eq!(
        setup,
        transport::VoiceSetup { transcribe: true, speak: true, stt_enabled: Some(false), stt_provider: Some("groq".into()), tts_provider: Some("openai".into()) }
    );
    let json = serde_json::to_string(&setup).unwrap();
    assert!(!json.contains("SECRET"), "{json}");
    assert_eq!(json, r#"{"transcribe":true,"speak":true,"sttEnabled":false,"sttProvider":"groq","ttsProvider":"openai"}"#);
}

#[tokio::test]
async fn a_server_without_voice_has_neither_route() {
    for profile in ["old", "older"] {
        let setup = signed_in().await.voice_setup(profile).await.unwrap();
        assert_eq!(setup, transport::VoiceSetup { transcribe: false, speak: false, stt_enabled: None, stt_provider: None, tts_provider: None }, "{profile}");
    }
}

#[tokio::test]
async fn reads_the_start_of_a_local_file_for_the_preview() {
    let dir = scratch("local-text");
    let notes = dir.join("notes.md");
    std::fs::write(&notes, "# Notes\n\nCafé ☕\n").unwrap();
    let t = transport::read_local_text(&path_of(&notes)).await.unwrap();
    assert_eq!(t, transport::LocalText { size: 19, truncated: false, binary: false, text: "# Notes\n\nCafé ☕\n".into() });

    // Only the first 512 KB is read, and the size says how big the file is.
    let big = dir.join("big.log");
    std::fs::write(&big, "x".repeat(transport::LOCAL_TEXT_MAX_BYTES as usize + 10)).unwrap();
    let t = transport::read_local_text(&path_of(&big)).await.unwrap();
    assert!(t.truncated);
    assert_eq!(t.size, transport::LOCAL_TEXT_MAX_BYTES + 10);
    assert_eq!(t.text.len() as u64, transport::LOCAL_TEXT_MAX_BYTES);
}

#[tokio::test]
async fn a_binary_local_file_comes_back_without_its_bytes() {
    let dir = scratch("local-binary");
    let bin = dir.join("disk.img");
    std::fs::write(&bin, b"\x7fELF\x02\x01\x01\0\0\0\0\0\0\0\0\0").unwrap();
    let t = transport::read_local_text(&path_of(&bin)).await.unwrap();
    assert!(t.binary);
    assert_eq!(t.text, "");
    assert_eq!(t.size, 16);
}

#[tokio::test]
async fn refuses_a_folder_a_missing_file_or_a_relative_path_for_the_preview() {
    let dir = scratch("local-refused");
    let err = |p: String| async move { transport::read_local_text(&p).await.err().unwrap().to_string() };
    assert_eq!(err(path_of(&dir)).await, "it's a folder");
    assert_eq!(err(path_of(&dir.join("gone.txt"))).await, "No such file or directory (os error 2)");
    assert_eq!(err("notes.txt".into()).await, "it isn't a full path");
}

#[tokio::test]
async fn only_files_picked_in_the_open_dialog_can_be_read_for_the_preview() {
    let picked = transport::PickedFiles::default();
    assert_eq!(picked.read("/home/liam/.ssh/id_ed25519").await.err().unwrap().to_string(), "it wasn't picked in the Open dialog");
    let dir = scratch("picked-files");
    let notes = dir.join("notes.md");
    std::fs::write(&notes, "notes").unwrap();
    let path = picked.allow(&path_of(&notes)).unwrap();
    assert_eq!(picked.read(&path).await.unwrap().text, "notes");
    assert!(picked.read(&format!("{path}/../secret")).await.is_err());
}

#[tokio::test]
async fn reload_uses_the_picked_file_even_after_path_or_symlink_replacement() {
    use std::os::unix::fs::symlink;
    let dir = scratch("picked-replaced");
    let notes = dir.join("notes.md");
    let secret = dir.join("secret");
    std::fs::write(&notes, "picked").unwrap();
    std::fs::write(&secret, "not picked").unwrap();
    let picked = transport::PickedFiles::default();
    let path = picked.allow(&path_of(&notes)).unwrap();
    std::fs::rename(&notes, dir.join("original")).unwrap();
    symlink(&secret, &notes).unwrap();
    assert_eq!(picked.read(&path).await.unwrap().text, "picked");
    std::fs::remove_file(&notes).unwrap();
    std::fs::write(&notes, "replacement").unwrap();
    assert_eq!(picked.read(&path).await.unwrap().text, "picked");
    // In-place changes to the actual picked file still appear on Reload, even with simultaneous reads.
    std::fs::write(dir.join("original"), "updated").unwrap();
    let (a, b) = tokio::join!(picked.read(&path), picked.read(&path));
    assert_eq!(a.unwrap().text, "updated");
    assert_eq!(b.unwrap().text, "updated");
}

#[tokio::test]
async fn local_preview_refuses_fifos_and_devices_without_waiting_for_a_writer() {
    let dir = scratch("picked-fifo");
    let fifo = dir.join("pipe");
    let cpath = std::ffi::CString::new(path_of(&fifo)).unwrap();
    assert_eq!(unsafe { libc::mkfifo(cpath.as_ptr(), 0o600) }, 0);
    for path in [path_of(&fifo), "/dev/zero".into()] {
        let read = tokio::time::timeout(Duration::from_secs(2), transport::read_local_text(&path)).await.unwrap();
        assert_eq!(read.err().unwrap().to_string(), "it isn't a regular file");
        assert!(transport::PickedFiles::default().allow(&path).is_err());
    }
}

#[tokio::test]
async fn passes_on_hermess_whole_reason_for_having_no_transcriber() {
    let err = signed_in().await.transcribe("default", "audio/wav", b"no-stt").await.err().unwrap();
    assert_eq!(err.to_string(), format!("Hermes couldn't transcribe the recording: {NO_STT}"));
}

#[tokio::test]
async fn voice_requests_carry_the_gate_headers_too() {
    let (elsewhere, _) = other_site().await;
    let (base, seen) = gated_stub(&elsewhere).await;
    let dashboard = Dashboard::sign_in(&base, &access_sign_in()).await.unwrap();
    dashboard.transcribe("default", "audio/wav", b"RIFF").await.unwrap();
    dashboard.speak("default", "Hello").await.unwrap();
    assert!(dashboard.voice_setup("default").await.unwrap().speak);
    let seen = seen.lock().unwrap();
    let paths: Vec<&str> = seen.iter().map(|(path, _)| path.as_str()).collect();
    assert_eq!(paths, ["/auth/password-login", "/api/audio/transcribe", "/api/audio/speak", "/api/audio/transcribe", "/api/audio/speak", "/api/config"]);
    assert!(seen.iter().all(|(_, secret)| secret.as_deref() == Some("s3cret")));
}

#[tokio::test]
async fn voice_redirects_to_another_origin_stop_without_sending_credentials_or_audio() {
    let (elsewhere, other_seen) = other_site().await;
    let away = elsewhere.join("steal").unwrap().to_string();
    let speak_away = away.clone();
    let app = Router::new()
        .route("/auth/password-login", post(login))
        .route("/api/audio/transcribe", post(move || async move { Redirect::temporary(&away) }))
        .route("/api/audio/speak", post(move || async move { Redirect::temporary(&speak_away) }));
    let dashboard = Dashboard::sign_in(&serve(app).await, &access_sign_in()).await.unwrap();
    for err in [
        dashboard.transcribe("default", "audio/wav", b"private audio").await.err().unwrap(),
        dashboard.speak("default", "private reply").await.err().unwrap(),
    ] {
        assert!(matches!(&err, TransportError::Redirected(to) if *to == elsewhere.origin().ascii_serialization()), "{err:?}");
        assert!(!err.to_string().contains("s3cret"));
    }
    assert!(other_seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn local_image_preview_keeps_the_picked_handle_and_checks_its_content_and_size() {
    let dir = scratch("picked-image");
    let image = dir.join("image.png");
    std::fs::write(&image, b"\x89PNG\r\n\x1a\noriginal").unwrap();
    let picked = transport::PickedFiles::default();
    assert!(picked.read_image(&path_of(&image)).await.is_err());
    let path = picked.allow(&path_of(&image)).unwrap();
    std::fs::rename(&image, dir.join("original.png")).unwrap();
    std::fs::write(&image, b"\x89PNG\r\n\x1a\nreplacement").unwrap();
    assert_eq!(picked.read_image(&path).await.unwrap(), b"\x89PNG\r\n\x1a\noriginal");
    std::fs::write(dir.join("original.png"), "secret text").unwrap();
    assert_eq!(picked.read_image(&path).await.err().unwrap().to_string(), "it isn't an image");
    let f = std::fs::OpenOptions::new().write(true).open(dir.join("original.png")).unwrap();
    f.set_len(transport::PREVIEW_MAX_BYTES + 1).unwrap();
    assert!(matches!(picked.read_image(&path).await, Err(TransportError::FileTooLarge { .. })));
}

#[tokio::test]
async fn extra_headers_go_with_the_sign_in_rest_calls_and_the_socket() {
    let (elsewhere, _) = other_site().await;
    let (base, seen) = gated_stub(&elsewhere).await;
    let dashboard = Dashboard::sign_in(&base, &access_sign_in()).await.expect("signed in through the gate");
    let (tx, mut rx) = mpsc::unbounded_channel();
    let _pipe = dashboard.open_pipe("default", move |e| drop(tx.send(e))).await.expect("socket opened through the gate");
    assert_eq!(frame(next(&mut rx).await)["params"]["type"], "gateway.ready");
    assert_eq!(get_json(&dashboard, "api/sessions?order=recent").await["query"], "order=recent");

    let seen = seen.lock().unwrap().clone();
    let paths: Vec<&str> = seen.iter().map(|(p, _)| p.as_str()).collect();
    assert_eq!(paths, ["/auth/password-login", "/api/auth/ws-ticket", "/api/ws", "/api/sessions"]);
    assert!(seen.iter().all(|(_, secret)| secret.as_deref() == Some("s3cret")), "{seen:?}");
}

#[tokio::test]
async fn without_the_extra_headers_the_gate_refuses() {
    let (elsewhere, _) = other_site().await;
    let (base, _) = gated_stub(&elsewhere).await;
    let err = Dashboard::sign_in(&base, &sign_in("hunter2")).await.err().unwrap();
    assert!(matches!(err, TransportError::Unexpected { status: 403, .. }), "{err:?}");
}

#[tokio::test]
async fn extra_headers_follow_a_redirect_within_the_dashboard_only() {
    let (elsewhere, other_seen) = other_site().await;
    let (base, _) = gated_stub(&elsewhere).await;
    let dashboard = Dashboard::sign_in(&base, &access_sign_in()).await.expect("signed in");
    assert_eq!(get_json(&dashboard, "api/moved").await["query"], "moved=1");

    let err = dashboard.request("GET", "api/away", None).await.err().unwrap();
    let origin = elsewhere.origin().ascii_serialization();
    assert!(matches!(&err, TransportError::Redirected(to) if *to == origin), "{err:?}");
    assert!(!err.to_string().contains("s3cret"));
    assert!(other_seen.lock().unwrap().is_empty(), "the other site was asked: {:?}", other_seen.lock().unwrap());
}

#[tokio::test]
async fn a_sign_in_redirected_to_another_site_stops_there() {
    // Cloudflare Access sends a request without a valid token to its login page, on another origin.
    let (elsewhere, other_seen) = other_site().await;
    let login = elsewhere.join("cdn-cgi/access/login").unwrap().to_string();
    let base = serve(Router::new().route("/auth/password-login", post(move || async move { Redirect::to(&login) }))).await;
    let err = Dashboard::sign_in(&base, &access_sign_in()).await.err().unwrap();
    assert!(matches!(err, TransportError::Redirected(_)), "{err:?}");
    assert!(other_seen.lock().unwrap().is_empty());
}

#[test]
fn builds_extra_headers_and_marks_their_values_sensitive() {
    let map = transport::extra_headers(&[header(" CF-Access-Client-Id ", " id.access\t"), header("Authorization", "Bearer abc")]).unwrap();
    assert_eq!(map.len(), 2);
    let id = map.get("cf-access-client-id").unwrap();
    assert_eq!(id.to_str().unwrap(), "id.access");
    assert!(id.is_sensitive());
    assert!(!format!("{map:?}").contains("Bearer abc"), "{map:?}");
    assert!(transport::extra_headers(&[]).unwrap().is_empty());
}

#[test]
fn refuses_extra_headers_that_are_malformed_reserved_or_set_twice() {
    let cases = [
        (vec![header("", "v")], "Extra request header 1: enter its name."),
        (vec![header("X-Ok", "v"), header("Bad Header", "v")], "Extra request header 2: \"Bad Header\" isn't a header name."),
        (vec![header("X-A\r\nX-Evil", "v")], "Extra request header 1: \"X-A\\r\\nX-Evil\" isn't a header name."),
        (vec![header("X-A", "ok\r\nX-Evil: 1")], "Extra request header 1: the value of X-A can only hold"),
        (vec![header("X-A", "ok\nmore")], "Extra request header 1: the value of X-A can only hold"),
        (vec![header("X-A", "caf\u{e9}")], "Extra request header 1: the value of X-A can only hold"),
        (vec![header("X-A", "  ")], "Extra request header 1: enter a value for X-A."),
        (vec![header("X-A", &"a".repeat(8 * 1024 + 1))], "Extra request header 1: the value of X-A is over 8 KB."),
        (vec![header("X-A", "1"), header("x-a", "2")], "Extra request header 2: x-a is set twice."),
        (vec![header("Host", "evil")], "Extra request header 1: Hermes Chat sets Host itself."),
        (vec![header("Cookie", "a=b")], "Extra request header 1: Hermes Chat sets Cookie itself."),
        (vec![header("content-length", "0")], "Extra request header 1: Hermes Chat sets content-length itself."),
        (vec![header("Sec-WebSocket-Key", "x")], "Extra request header 1: Hermes Chat sets Sec-WebSocket-Key itself."),
        (vec![header("Proxy-Authorization", "x")], "Extra request header 1: Hermes Chat sets Proxy-Authorization itself."),
        ((0..33).map(|i| header(&format!("X-{i}"), "v")).collect(), "Hermes Chat sends at most 32 extra request headers."),
    ];
    for (headers, want) in cases {
        let err = transport::extra_headers(&headers).err().unwrap_or_else(|| panic!("accepted {:?}", headers.iter().map(|h| (&h.name, &h.value)).collect::<Vec<_>>())).to_string();
        assert!(err.starts_with(want), "got {err:?}, want {want:?}");
        // An error names the header, never its value.
        for h in &headers {
            if h.value.trim().len() > 1 && !h.name.is_empty() {
                assert!(!err.contains(h.value.trim()), "{err:?} shows the value of {}", h.name);
            }
        }
    }
}

#[test]
fn stages_a_pasted_file_as_a_private_temp_file() {
    use std::os::unix::fs::PermissionsExt;
    let png = b"\x89PNG\r\n\x1a\npasted";
    let a = transport::stage_clipboard_file("clipboard-2026-11-02T153000.png", png).unwrap();
    let b = transport::stage_clipboard_file("clipboard-2026-11-02T153000.png", png).unwrap();
    for p in [&a, &b] {
        assert!(p.is_absolute(), "{p:?}");
        assert!(p.starts_with(std::env::temp_dir().join("hermes-chat")), "{p:?}");
        assert_eq!(p.file_name().unwrap(), "clipboard-2026-11-02T153000.png");
        assert_eq!(std::fs::read(p).unwrap(), png);
        let folder = std::fs::metadata(p.parent().unwrap()).unwrap();
        assert_eq!(folder.permissions().mode() & 0o777, 0o700, "{p:?}");
    }
    // The same screenshot pasted twice is two files, so both attach.
    assert_ne!(a, b);
    // Each staged file attaches like any other local file.
    let got = tokio::runtime::Runtime::new().unwrap().block_on(transport::stat_files(&[path_of(&a)]));
    assert_eq!(got[0].size, Some(png.len() as u64));
    for p in [a, b] {
        std::fs::remove_dir_all(p.parent().unwrap()).unwrap();
    }
}

#[test]
fn a_pasted_file_name_stays_a_plain_basename() {
    for (hostile, want) in [
        ("../../etc/passwd.png", "passwd.png"),
        ("/etc/passwd", "passwd"),
        ("..\\..\\boot.ini", "boot.ini"),
        ("..", "clipboard"),
        ("", "clipboard"),
        ("  ", "clipboard"),
        ("rack\n\u{7}photo.JPG", "rackphoto.JPG"),
        (".bashrc", "bashrc"),
        ("notes.tar.gz", "notes.tar.gz"),
        ("report.<script>", "report.<script>"),
        ("Résumé 2026.pdf", "Résumé 2026.pdf"),
    ] {
        let p = transport::stage_clipboard_file(hostile, b"x").unwrap();
        assert_eq!(p.file_name().unwrap(), want, "{hostile:?}");
        // Still inside its own fresh folder, not somewhere the name pointed.
        assert_eq!(p.parent().unwrap().parent().unwrap(), std::env::temp_dir().join("hermes-chat"), "{hostile:?}");
        std::fs::remove_dir_all(p.parent().unwrap()).unwrap();
    }
    let long = transport::stage_clipboard_file(&format!("{}.png", "é".repeat(300)), b"x").unwrap();
    let name = long.file_name().unwrap().to_str().unwrap();
    assert!(name.len() <= 255 && name.ends_with(".png"), "{name}");
    std::fs::remove_dir_all(long.parent().unwrap()).unwrap();
}
