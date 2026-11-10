//! The Rust transport against a local stub of the dashboard's sign-in routes, `/api/ws` and REST.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, RawQuery};
use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::middleware::{self, Next};
use axum::response::Redirect;
use axum::response::{AppendHeaders, IntoResponse, Response};
use axum::routing::{get, patch, post, put};
use axum::{Json, Router};
use hermes_chat::connect_steps::{Step, Steps};
use hermes_chat::display;
use hermes_chat::transport::{self, Credential, Dashboard, ExtraHeader, LocalFile, PipeEvent, SignIn, StepLimits, TransportError};
use hermes_chat::transport::{ProbeFailure, SavedKey, Stage};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;
use url::Url;

const READY: &str =
    r#"{"jsonrpc":"2.0","method":"event","params":{"type":"gateway.ready","payload":{"skin":{},"change_events":true,"heartbeat":true,"replay_epoch":"e1"}}}"#;

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

/// `GET /api/status`, which answers without a sign-in.
async fn status() -> Response {
    Json(json!({"version": "0.22.5", "auth_required": true, "auth_providers": ["basic"]})).into_response()
}

/// Keys `PUT /api/env` saved, as (query, body), for every test; each test uses its own profile.
static SAVED_KEYS: Mutex<Vec<(String, Value)>> = Mutex::new(Vec::new());

/// Keys `DELETE /api/env` removed, as (query, body), for every test; each test uses its own profile.
static REMOVED_KEYS: Mutex<Vec<(String, Value)>> = Mutex::new(Vec::new());

fn removed_for(profile: &str) -> Vec<Value> {
    REMOVED_KEYS.lock().unwrap().iter().filter(|(q, _)| q == &format!("profile={profile}")).map(|(_, b)| b.clone()).collect()
}

/// `GET /api/env`, trimmed: a provider key that is not set, one that is set until a `DELETE` removes it (and is never
/// set for `keys-gone`), a messaging token the Channels page owns, and a base URL.
async fn env_rows(headers: HeaderMap, RawQuery(query): RawQuery) -> Response {
    if !cookie(&headers).contains("hermes_session_at=AT") {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let query = query.unwrap_or_default();
    let anthropic_set = query != "profile=keys-gone" && !REMOVED_KEYS.lock().unwrap().iter().any(|(q, _)| q == &query);
    Json(json!({
        "OPENROUTER_API_KEY": {"is_set": false, "provider": "openrouter", "is_password": true, "channel_managed": false},
        "ANTHROPIC_API_KEY": {"is_set": anthropic_set, "provider": "anthropic", "is_password": true, "channel_managed": false},
        "TELEGRAM_BOT_TOKEN": {"is_set": true, "provider": "", "is_password": true, "channel_managed": true},
        "OPENAI_BASE_URL": {"is_set": false, "provider": "openai-api", "is_password": false, "channel_managed": false},
    }))
    .into_response()
}

/// `PUT /api/env`. A key starting `sk-echo` gets FastAPI's 422, which echoes what it was sent.
async fn save_env(RawQuery(query): RawQuery, Json(body): Json<Value>) -> Response {
    if body["value"].as_str().is_some_and(|v| v.starts_with("sk-echo")) {
        return (StatusCode::UNPROCESSABLE_ENTITY, Json(json!({"detail": [{"msg": "bad", "input": body}]}))).into_response();
    }
    SAVED_KEYS.lock().unwrap().push((query.unwrap_or_default(), body));
    Json(json!({"ok": true})).into_response()
}

/// `DELETE /api/env`. `keys-gone` has no such key, so Hermes answers 404; `keys-stuck` answers 200 and keeps it.
async fn delete_env(RawQuery(query): RawQuery, Json(body): Json<Value>) -> Response {
    let query = query.unwrap_or_default();
    match query.as_str() {
        "profile=keys-gone" => {
            (StatusCode::NOT_FOUND, Json(json!({"detail": format!("{} not found in .env", body["key"].as_str().unwrap_or_default())}))).into_response()
        }
        "profile=keys-stuck" => Json(json!({"ok": true})).into_response(),
        _ => {
            REMOVED_KEYS.lock().unwrap().push((query, body));
            Json(json!({"ok": true})).into_response()
        }
    }
}

/// `POST /api/providers/validate`: `sk-good` passes, `sk-bad` is turned down, `sk-offline` can't be checked, and
/// `sk-garbled` gets an answer that isn't one. Each failure quotes part of the key, as a provider's message can.
async fn validate(Json(body): Json<Value>) -> Response {
    Json(match body["value"].as_str() {
        Some("sk-bad") => json!({"ok": false, "reachable": true, "message": "Incorrect API key provided: sk-b***ad."}),
        Some("sk-offline") => json!({"ok": false, "reachable": false, "message": "Could not reach the provider to verify sk-off…ne."}),
        Some("sk-garbled") => json!({"ok": "sk-garbled", "reachable": true}),
        _ => json!({"ok": true, "reachable": true, "message": ""}),
    })
    .into_response()
}

/// `GET /api/files/read` as a stand-in for a big answer: `n` bytes of JSON, sent with a Content-Length, or in
/// chunks without one when `chunked` is set. Echoes the query and cookie in the first bytes.
async fn read_file(headers: HeaderMap, Query(q): Query<HashMap<String, String>>) -> Response {
    let n: usize = q.get("n").and_then(|n| n.parse().ok()).unwrap_or(0);
    let head = json!({"path": q.get("path"), "cookie": cookie(&headers)}).to_string();
    let body = format!(r#"{},"pad":"{}"}}"#, &head[..head.len() - 1], "x".repeat(n.saturating_sub(head.len() + 9)));
    if q.contains_key("chunked") {
        let chunks: Vec<Result<String, std::io::Error>> = body.as_bytes().chunks(1024).map(|c| Ok(String::from_utf8(c.to_vec()).unwrap())).collect();
        axum::body::Body::from_stream(futures_util::stream::iter(chunks)).into_response()
    } else {
        body.into_response()
    }
}

/// `GET /api/files/download`, as `hermes_cli/web_routers/files.py` answers it at `bf0203a`, for a few made-up files:
/// `/srv/data.bin` (300,000 bytes, with a Content-Length), `/srv/.env` (refused as a credential file), `/srv/cut`
/// (breaks off after 64 KiB) and `/srv/slow` (a chunk every 50 ms, without end).
async fn download_file(headers: HeaderMap, Query(q): Query<HashMap<String, String>>) -> Response {
    if !cookie(&headers).split("; ").any(|c| c == "hermes_session_at=AT") {
        return (StatusCode::UNAUTHORIZED, Json(json!({"detail": "Unauthorized"}))).into_response();
    }
    match q.get("path").map(String::as_str) {
        Some("/srv/data.bin") => (0..300_000u32).map(|i| (i % 251) as u8).collect::<Vec<u8>>().into_response(),
        Some("/srv/.env") => (StatusCode::FORBIDDEN, Json(json!({"detail": "Access to sensitive files is not allowed"}))).into_response(),
        Some("/srv/cut") => {
            let chunks = futures_util::stream::iter([Ok(vec![7u8; 64 * 1024]), Err(std::io::Error::other("connection reset"))]);
            axum::body::Body::from_stream(chunks).into_response()
        }
        Some("/srv/slow") => {
            let chunks = futures_util::stream::unfold((), |_| async {
                tokio::time::sleep(Duration::from_millis(50)).await;
                Some((Ok::<_, std::io::Error>(vec![1u8; 4096]), ()))
            });
            axum::body::Body::from_stream(chunks).into_response()
        }
        _ => (StatusCode::NOT_FOUND, Json(json!({"detail": "File not found"}))).into_response(),
    }
}

/// `POST /api/files/upload-stream`, as `hermes_cli/web_routers/files.py` takes it at `bf0203a`: a multipart form with
/// `file`, `path` and `overwrite`. `/srv/taken.txt` is already there. It answers with what it got, and counts uploads.
async fn upload_stream(State(uploads): State<Arc<Mutex<Vec<String>>>>, headers: HeaderMap, mut form: axum::extract::Multipart) -> Response {
    let (mut path, mut overwrite, mut bytes, mut file_name) = (String::new(), String::new(), Vec::new(), String::new());
    while let Some(field) = form.next_field().await.unwrap() {
        match field.name().unwrap_or_default() {
            "path" => path = field.text().await.unwrap(),
            "overwrite" => overwrite = field.text().await.unwrap(),
            "file" => {
                file_name = field.file_name().unwrap_or_default().to_owned();
                bytes = field.bytes().await.unwrap().to_vec();
            }
            _ => {}
        }
    }
    uploads.lock().unwrap().push(path.clone());
    if path == "/srv/taken.txt" && overwrite == "false" {
        return (StatusCode::CONFLICT, Json(json!({"detail": "File already exists"}))).into_response();
    }
    let sum: u64 = bytes.iter().map(|&b| b as u64).sum();
    Json(json!({"path": path, "overwrite": overwrite, "size": bytes.len(), "sum": sum, "file_name": file_name, "cookie": cookie(&headers)})).into_response()
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
        "stt": {
            "enabled": false, "provider": "groq", "language": "en",
            "groq": {"api_key": "gsk-SECRET", "model": "whisper-large-v3-turbo", "language": ""},
            "elevenlabs": {"model_id": "scribe_v2", "language_code": "eng", "diarize": false, "api_token": "el-SECRET"},
            // A command provider: not Hermes's own, so none of it is passed on.
            "providers": {"mine": {"type": "command", "command": "run --key=cmd-SECRET", "model": "m"}},
            // Not text, too long, or with a control character: left out rather than changed.
            "xai": {"model": 3, "language": "a".repeat(257), "voice": "a\nb"},
            "../x": {"model": "m"},
        },
        "tts": {
            "provider": "openai", "keep_warm_seconds": 60, "streaming": {"min_len": 20},
            "openai": {"api_key": "sk-tts-SECRET", "voice": "alloy", "model": "gpt-4o-mini-tts", "consent_attestation": "c-SECRET"},
            "elevenlabs": {"voice_id": "pNInz6obpgDQGcFmaJgB", "model_id": "eleven_multilingual_v2", "xi_api_key": "xi-SECRET"},
        },
        // `true` is YAML for a typo'd number: Hermes's `_numeric_or` drops it, and so does the app.
        "voice": {"silence_threshold": 350, "silence_duration": 1.5, "max_recording_seconds": true, "gpt_live": {"api_key": "sk-live-SECRET"}},
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

/// The Bot Desktop bridge: `SCREEN-1` echoes each binary frame back reversed and, once the viewer goes, reports the
/// close code it got on `closes`, or None for none; `TAKEN-1` closes at once with Hermes's 4000 `control-taken`; anything else is 4401.
async fn display_ws(ws: WebSocketUpgrade, Query(q): Query<HashMap<String, String>>, State(closes): State<Closes>) -> Response {
    let ticket = q.get("display_ticket").cloned().unwrap_or_default();
    ws.on_upgrade(move |mut ws| async move {
        let close = |code: u16, reason: &'static str| Message::Close(Some(axum::extract::ws::CloseFrame { code, reason: reason.into() }));
        match ticket.as_str() {
            "SCREEN-1" => {
                ws.send(Message::Binary(b"RFB 003.008\n".to_vec().into())).await.unwrap();
                while let Some(Ok(m)) = ws.recv().await {
                    match m {
                        Message::Binary(b) => ws.send(Message::Binary(b.iter().rev().copied().collect::<Vec<u8>>().into())).await.unwrap(),
                        Message::Close(f) => {
                            let _ = closes.send(f.map(|f| f.code));
                            return;
                        }
                        _ => {}
                    }
                }
                // Gone with no close frame.
                let _ = closes.send(None);
            }
            "TAKEN-1" => drop(ws.send(close(4000, "control-taken")).await),
            _ => drop(ws.send(close(4401, "display ticket missing, expired or used")).await),
        }
    })
}

type Closes = mpsc::UnboundedSender<Option<u16>>;

async fn screen_stub() -> (Arc<Dashboard>, mpsc::UnboundedReceiver<Option<u16>>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let app = Router::new().route("/auth/password-login", post(login)).route("/api/display/ws", get(display_ws)).with_state(tx);
    let dashboard = sign_in_at(&serve(app).await, &sign_in("hunter2")).await.expect("signed in");
    (Arc::new(dashboard), rx)
}

async fn next_display(rx: &mut mpsc::UnboundedReceiver<display::DisplayEvent>) -> display::DisplayEvent {
    tokio::time::timeout(Duration::from_secs(5), rx.recv()).await.expect("event in time").expect("socket open")
}

#[tokio::test]
async fn the_screen_relays_rfb_bytes_both_ways_and_closing_it_is_a_normal_close() {
    let (dashboard, mut closes) = screen_stub().await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    let socket = display::open(dashboard, "SCREEN-1", move |e| drop(tx.send(e))).await.expect("open");
    assert_eq!(next_display(&mut rx).await, display::DisplayEvent::Data(b"RFB 003.008\n".to_vec()));
    socket.send(vec![1, 2, 3]).unwrap();
    assert_eq!(next_display(&mut rx).await, display::DisplayEvent::Data(vec![3, 2, 1]));
    // Hermes hands control back only on a normal close.
    drop(socket);
    let got = tokio::time::timeout(Duration::from_secs(5), closes.recv()).await.unwrap().unwrap();
    assert_eq!(got, Some(1000));
}

#[tokio::test]
async fn the_connection_going_drops_each_screen_without_a_close_so_hermes_keeps_the_owner_in_control() {
    let (dashboard, mut closes) = screen_stub().await;
    let displays = display::Displays::default();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let socket = display::open(dashboard, "SCREEN-1", move |e| drop(tx.send(e))).await.expect("open");
    next_display(&mut rx).await;
    displays.keep(displays.epoch(), socket).unwrap();
    displays.close_all();
    // Hermes gets no close frame: a dropped link, not a viewer leaving.
    let got = tokio::time::timeout(Duration::from_secs(5), closes.recv()).await.unwrap().unwrap();
    assert_eq!(got, None);
    match next_display(&mut rx).await {
        display::DisplayEvent::Closed { code, .. } => assert_eq!(code, 1006),
        other => panic!("expected a close, got {other:?}"),
    }
}

#[tokio::test]
async fn the_screen_reports_hermess_own_close_code() {
    let (dashboard, _closes) = screen_stub().await;
    for (ticket, code) in [("TAKEN-1", 4000), ("SPENT", 4401)] {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let _socket = display::open(dashboard.clone(), ticket, move |e| drop(tx.send(e))).await.expect("open");
        match next_display(&mut rx).await {
            display::DisplayEvent::Closed { code: got, reason } => {
                assert_eq!(got, code, "{reason}");
                assert!(!reason.is_empty());
            }
            other => panic!("expected a close, got {other:?}"),
        }
    }
    assert!(display::open(dashboard, "two words", |_| {}).await.is_err(), "a ticket with a space isn't one");
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
        .route("/api/tools/toolsets/{name}", put(echo_write))
        .route("/api/tools/toolsets/{name}/env", put(echo_write))
        .route("/api/tools/toolsets/{name}/provider", put(echo_write))
        .route("/api/tools/toolsets/{name}/post-setup", post(echo_write))
        .route("/api/messaging/platforms/{id}", put(echo_write).post(echo_write))
        .route("/api/messaging/platforms/{id}/test", post(echo_write).put(echo_write))
        .route("/api/profiles/{name}/soul", put(echo_write).post(echo_write))
        .route("/api/skills", post(echo_write))
        .route("/api/skills/toggle", put(echo_write))
        .route("/api/skills/content", put(echo_write))
        .route("/api/skills/hub/install", post(echo_write))
        .route("/api/learning/node", put(echo_write).post(echo_write))
        .route("/api/cron/jobs", post(echo_write))
        .route("/api/sessions/import", post(echo_write))
        .route("/api/cron/jobs/{id}", put(echo_write))
        .route("/api/cron/jobs/{id}/{action}", post(echo_write))
        .route("/api/rotate", get(rotate))
        .route("/api/expire", get(expire))
        .route("/api/busy", get(busy))
        .route("/api/status", get(status))
        .route("/api/env", get(env_rows).put(save_env).delete(delete_env))
        .route("/api/providers/validate", post(validate))
        .route("/api/audio/transcribe", post(transcribe))
        .route("/api/audio/speak", post(speak))
        .route("/api/files/read", get(read_file))
        .route("/api/files/download", get(download_file))
        .route("/api/flood", get(flood))
}

async fn serve(app: Router) -> Url {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Url::parse(&format!("http://{addr}/")).unwrap()
}

/// `Dashboard::sign_in` on a route's own client, as `open_connection` builds one.
async fn sign_in_at(base: &Url, sign_in: &SignIn) -> Result<Dashboard, TransportError> {
    Dashboard::sign_in(transport::client(&sign_in.headers)?, base, sign_in).await
}

fn sign_in(password: &str) -> SignIn {
    SignIn { credential: Credential::password("liam", password), headers: Default::default() }
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
    sign_in_at(&stub().await, &sign_in("hunter2")).await.expect("signed in")
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
async fn the_signed_in_dashboard_opens_the_socket_again_once_hermes_closed_it() {
    let dashboard = signed_in().await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    let pipe = dashboard.open_pipe("default", move |e| drop(tx.send(e))).await.expect("pipe open");
    next(&mut rx).await;
    pipe.send(json!({"jsonrpc": "2.0", "id": 1, "method": "bye"}).to_string()).unwrap();
    assert!(matches!(next(&mut rx).await, PipeEvent::Closed { .. }));

    let (tx, mut rx) = mpsc::unbounded_channel();
    let pipe = dashboard.open_pipe("work", move |e| drop(tx.send(e))).await.expect("opened again without signing in");
    assert_eq!(frame(next(&mut rx).await)["params"]["type"], "gateway.ready");
    pipe.send(json!({"jsonrpc": "2.0", "id": 2, "method": "profile"}).to_string()).unwrap();
    assert_eq!(frame(next(&mut rx).await)["result"], json!({"profile": "work"}));
}

#[tokio::test]
async fn the_socket_does_not_open_again_once_the_sign_in_ended() {
    let dashboard = signed_in().await;
    get_json(&dashboard, "api/expire").await;
    let refused = dashboard.open_pipe("default", |_| {}).await.err().expect("no ticket without a sign-in");
    assert!(refused.to_string().contains("401"), "{refused}");
}

#[tokio::test]
async fn wrong_password_is_bad_credentials() {
    let base = stub().await;
    let err = sign_in_at(&base, &sign_in("nope")).await.err().unwrap();
    assert!(matches!(err, TransportError::BadCredentials), "{err:?}");
}

#[tokio::test]
async fn rate_limited_sign_in_is_reported() {
    let base = stub().await;
    let err = sign_in_at(&base, &sign_in("slow-down")).await.err().unwrap();
    assert!(matches!(err, TransportError::RateLimited), "{err:?}");
}

#[tokio::test]
async fn nothing_listening_is_unreachable() {
    let port = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap().port();
    let base = Url::parse(&format!("http://127.0.0.1:{port}/")).unwrap();
    let err = sign_in_at(&base, &sign_in("hunter2")).await.err().unwrap();
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
    assert_eq!(
        got,
        json!({"uri": "/api/model/set?profile=default", "content_type": "application/json", "body": {"scope": "main", "provider": "nous", "model": "m"}})
    );
    let body = json!({"config": {"agent": {"reasoning_effort": "low"}}}).to_string();
    let got: Value = serde_json::from_str(&dashboard.request("PUT", "api/config?profile=default", Some(body)).await.unwrap()).unwrap();
    assert_eq!(
        got,
        json!({"uri": "/api/config?profile=default", "content_type": "application/json", "body": {"config": {"agent": {"reasoning_effort": "low"}}}})
    );
}

#[tokio::test]
async fn relays_the_toolset_switch_with_only_enabled_in_the_body() {
    let dashboard = signed_in().await;
    let got: Value =
        serde_json::from_str(&dashboard.request("PUT", "api/tools/toolsets/web?profile=work", Some(r#"{"enabled":false}"#.into())).await.unwrap()).unwrap();
    assert_eq!(got, json!({"uri": "/api/tools/toolsets/web?profile=work", "content_type": "application/json", "body": {"enabled": false}}));
    // The write-support check: only the probe name, and only with its invalid body.
    let probe = format!("api/tools/toolsets/{}?profile=work", transport::TOOLSET_PROBE_NAME);
    assert!(dashboard.request("PUT", &probe, Some(r#"{"enabled":"probe"}"#.into())).await.is_ok());
}

#[test]
fn toolset_guards_keep_only_no_mcp_platforms_coding_focus_and_disabled_names() {
    let config = json!({
        "platform_toolsets": {
            "cli": ["web", "no_mcp"],
            "telegram": "['web', 'no_mcp']",
            "discord": ["discord"],
            // Python reads these as `no_mcp`, which a plain read can't be sure of.
            "slack": r#"["web", "no\u005fmcp"]"#,
            "matrix": "['web', 'no_' 'mcp']",
            // Not a list: Hermes ignores it, `no_mcp` and all.
            "signal": "no_mcp",
            // Python's strip() removes U+001C, so Hermes reads this one as a list too.
            "irc": "\u{1c}['web', 'no_mcp']",
            "line": "x['web', 'no_mcp']",
        },
        "agent": {"coding_context": " Lean ", "disabled_toolsets": ["web", " debugging ", ""]},
        "web": {"api_key": "sk-secret"},
    });
    let guards = transport::toolset_guards(&config);
    let none = || transport::ToolsetGuards {
        no_mcp: vec![],
        no_mcp_unclear: vec![],
        saved_lists: vec![],
        coding_focus: false,
        disabled_everywhere: vec![],
        disabled_unclear: false,
    };
    assert_eq!(
        guards,
        transport::ToolsetGuards {
            no_mcp: vec!["cli".into(), "irc".into(), "telegram".into()],
            no_mcp_unclear: vec!["line".into(), "matrix".into(), "slack".into()],
            // `signal` holds a string Hermes doesn't read as a list, so it inherits Hermes's default like an absent one.
            saved_lists: vec!["cli".into(), "discord".into(), "irc".into(), "telegram".into()],
            coding_focus: true,
            disabled_everywhere: vec!["web".into(), "debugging".into()],
            disabled_unclear: false,
        }
    );
    let out = serde_json::to_value(&guards).unwrap();
    assert_eq!(
        out,
        json!({
            "noMcp": ["cli", "irc", "telegram"],
            "noMcpUnclear": ["line", "matrix", "slack"],
            "savedLists": ["cli", "discord", "irc", "telegram"],
            "codingFocus": true,
            "disabledEverywhere": ["web", "debugging"],
            "disabledUnclear": false
        })
    );
    assert!(!out.to_string().contains("sk-secret"));
    assert_eq!(transport::toolset_guards(&json!({})), none());
    // Null, an empty saved list, and a string list literal: inherited, saved (even empty), saved.
    let saved = transport::toolset_guards(&json!({"platform_toolsets": {"cli": null, "discord": [], "slack": "['web']"}})).saved_lists;
    assert_eq!(saved, vec!["discord".to_string(), "slack".to_string()]);
    assert!(!transport::toolset_guards(&json!({"agent": {"coding_context": "auto"}})).coding_focus);
    // As `hermes config set` stores a list, and a single name, both as Hermes's parse_config_string_list reads them.
    let listed = |v: serde_json::Value| {
        let g = transport::toolset_guards(&json!({"agent": {"disabled_toolsets": v}}));
        (g.disabled_everywhere, g.disabled_unclear)
    };
    let clear = |names: &[&str]| (names.iter().map(|n| n.to_string()).collect::<Vec<_>>(), false);
    assert_eq!(listed(json!("['memory', \"web\"]")), clear(&["memory", "web"]));
    assert_eq!(listed(json!("['memory',]")), clear(&["memory"]));
    assert_eq!(listed(json!("memory")), clear(&["memory"]));
    assert_eq!(listed(json!("\u{1c}['web']\u{1f}")), clear(&["web"]));
    assert_eq!(listed(json!("\u{1c}web")), clear(&["web"]));
    assert_eq!(listed(json!("[]")), clear(&[]));
    assert_eq!(listed(json!(null)), clear(&[]));
    // Python reads these as names this can't be sure of (`"\u0077eb"` is `web`), so any toolset may be listed.
    for unsure in [r#"["\u0077eb"]"#, "['we' 'b']", "[web, debugging]", "['a,b']", "['web'"] {
        assert_eq!(listed(json!(unsure)), (vec![], true), "{unsure}");
    }
}

#[tokio::test]
async fn relays_the_two_skill_writes_with_exactly_their_fields() {
    let dashboard = signed_in().await;
    let got: Value = serde_json::from_str(
        &dashboard.request("PUT", "api/skills/toggle?profile=spare", Some(r#"{"name":"cat/notes","enabled":false}"#.into())).await.unwrap(),
    )
    .unwrap();
    assert_eq!(got, json!({"uri": "/api/skills/toggle?profile=spare", "content_type": "application/json", "body": {"name": "cat/notes", "enabled": false}}));
    let body = json!({"name": "notes", "content": "---\nname: notes\n---\nBody\n"}).to_string();
    let got: Value = serde_json::from_str(&dashboard.request("PUT", "api/skills/content?profile=spare", Some(body)).await.unwrap()).unwrap();
    assert_eq!(got["body"], json!({"name": "notes", "content": "---\nname: notes\n---\nBody\n"}));
    // A copy into another profile (ADR 0118): the profile in the query, the body as sent.
    let body = json!({"name": "notes", "content": "---\nname: notes\n---\nBody\n", "category": "writing"}).to_string();
    let got: Value = serde_json::from_str(&dashboard.request("POST", "api/skills?profile=spare", Some(body)).await.unwrap()).unwrap();
    assert_eq!(got["uri"], json!("/api/skills?profile=spare"));
    assert_eq!(got["body"], json!({"name": "notes", "content": "---\nname: notes\n---\nBody\n", "category": "writing"}));
}

#[tokio::test]
async fn relays_a_memory_entry_edit_for_any_profile_and_nothing_else_there() {
    let dashboard = signed_in().await;
    let body = json!({"id": "memory:profile:3:0123456789ab", "content": "Works in UTC+1."}).to_string();
    let got: Value = serde_json::from_str(&dashboard.request("PUT", "api/learning/node?profile=spare", Some(body)).await.unwrap()).unwrap();
    assert_eq!(got["uri"], json!("/api/learning/node?profile=spare"));
    assert_eq!(got["body"], json!({"id": "memory:profile:3:0123456789ab", "content": "Works in UTC+1."}));
    for body in [
        // A skill's id is its name: skill edits go through api/skills/content only.
        r#"{"id":"notes","content":"x"}"#,
        r#"{"id":"memory:profile:3:0123456789ab","content":"x","profile":"other"}"#,
        r#"{"id":"memory:profile:3","content":"x"}"#,
    ] {
        let err = dashboard.request("PUT", "api/learning/node", Some(body.into())).await.err().unwrap();
        assert!(matches!(err, TransportError::NotRelayed(_)), "{body}: {err:?}");
    }
    assert!(matches!(
        dashboard.request("POST", "api/learning/node", Some(r#"{"id":"memory:memory:0:0123456789ab"}"#.into())).await,
        Err(TransportError::NotRelayed(_))
    ));
}

#[tokio::test]
async fn relays_no_other_skill_write() {
    let dashboard = signed_in().await;
    for (method, path, body) in [
        // Creating a skill other than as a copy's exact fields (ADR 0118), and the hub's routes, which fetch and run
        // code from elsewhere.
        ("POST", "api/skills", r#"{"name":"x","content":"y","profile":"other"}"#),
        ("POST", "api/skills", r#"{"name":"../x","content":"y"}"#),
        ("POST", "api/skills", r#"{"name":"X","content":"y"}"#),
        ("POST", "api/skills", r#"{"name":"x","content":"y","category":"a/b"}"#),
        ("POST", "api/skills", r#"{"name":"x"}"#),
        ("POST", "api/skills/hub/install", r#"{"identifier":"github/x"}"#),
        ("POST", "api/skills/toggle", r#"{"name":"x","enabled":true}"#),
        ("PUT", "api/skills/lock", r#"{"name":"x","locked":true}"#),
        // Bodies with anything else, or a profile in the body.
        ("PUT", "api/skills/toggle", r#"{"name":"x","enabled":true,"profile":"other"}"#),
        ("PUT", "api/skills/toggle", r#"{"name":"x","enabled":"yes"}"#),
        ("PUT", "api/skills/toggle", r#"{"name":"x","content":"y"}"#),
        ("PUT", "api/skills/content", r#"{"name":"x","content":7}"#),
        ("PUT", "api/skills/content", r#"{"name":"x","enabled":true}"#),
        ("PUT", "api/skills/content", r#"{"content":"y"}"#),
        ("PUT", "api/skills/content", "not json"),
        // Names that could steer Hermes's lookup out of the skills folders.
        ("PUT", "api/skills/content", r#"{"name":"../../etc","content":"y"}"#),
        ("PUT", "api/skills/content", r#"{"name":"a/../b","content":"y"}"#),
        ("PUT", "api/skills/content", r#"{"name":"/etc/x","content":"y"}"#),
        ("PUT", "api/skills/content", r#"{"name":"a\\b","content":"y"}"#),
        ("PUT", "api/skills/content", r#"{"name":"a\nb","content":"y"}"#),
        ("PUT", "api/skills/content", r#"{"name":"","content":"y"}"#),
        ("PUT", "api/skills/toggle", r#"{"name":"a//b","enabled":true}"#),
        ("PUT", "api/skills/toggle", r#"{"name":"./a","enabled":true}"#),
    ] {
        let err = dashboard.request(method, path, Some(body.into())).await.err().unwrap();
        assert!(matches!(err, TransportError::NotRelayed(_)), "{method} {path} {body}: {err:?}");
    }
    assert!(dashboard.request("PUT", "api/skills/toggle", None).await.is_err());
    let long = format!(r#"{{"name":"{}","enabled":true}}"#, "a".repeat(257));
    assert!(matches!(dashboard.request("PUT", "api/skills/toggle", Some(long)).await, Err(TransportError::NotRelayed(_))));
}

#[tokio::test]
async fn relays_the_voice_provider_pick_and_key_save() {
    let dashboard = signed_in().await;
    for (path, body) in [
        ("api/tools/toolsets/stt/provider?profile=work", json!({"provider": "Local Whisper"})),
        ("api/tools/toolsets/tts/provider?profile=work", json!({"provider": "Mistral (Voxtral TTS)"})),
        ("api/tools/toolsets/tts/env?profile=work", json!({"env": {"ELEVENLABS_API_KEY": "el-key"}})),
        ("api/tools/toolsets/stt/env?profile=work", json!({"env": {"GROQ_API_KEY": "gsk-1", "VOICE_TOOLS_OPENAI_KEY": "sk-2"}})),
    ] {
        let got: Value = serde_json::from_str(&dashboard.request("PUT", path, Some(body.to_string())).await.unwrap()).unwrap();
        assert_eq!(got, json!({"uri": format!("/{path}"), "content_type": "application/json", "body": body}));
    }
}

#[tokio::test]
async fn relays_no_other_voice_provider_write() {
    let dashboard = signed_in().await;
    for (method, path, body) in [
        // Other toolsets' provider and key routes, and the voice toolsets' other routes.
        ("PUT", "api/tools/toolsets/web/provider", r#"{"provider":"Firecrawl Self-Hosted"}"#),
        ("PUT", "api/tools/toolsets/image_gen/env", r#"{"env":{"FAL_KEY":"k"}}"#),
        ("PUT", "api/tools/toolsets/stt/model", r#"{"model":"m"}"#),
        ("POST", "api/tools/toolsets/stt/post-setup", r#"{"key":"faster_whisper"}"#),
        ("POST", "api/tools/toolsets/tts/provider", r#"{"provider":"Piper"}"#),
        ("PUT", "api/tools/toolsets/stt/provider/x", r#"{"provider":"Groq"}"#),
        ("PUT", "api/tools/toolsets/STT/provider", r#"{"provider":"Groq"}"#),
        // Bodies with anything else, a profile in the body, or no provider.
        ("PUT", "api/tools/toolsets/stt/provider", r#"{"provider":"Groq","profile":"other"}"#),
        ("PUT", "api/tools/toolsets/stt/provider", r#"{"provider":""}"#),
        ("PUT", "api/tools/toolsets/stt/provider", r#"{"provider":"  "}"#),
        ("PUT", "api/tools/toolsets/stt/provider", r#"{"provider":7}"#),
        ("PUT", "api/tools/toolsets/stt/provider", r#"{"provider":"a\nb"}"#),
        ("PUT", "api/tools/toolsets/stt/provider", r#"{"env":{"GROQ_API_KEY":"k"}}"#),
        ("PUT", "api/tools/toolsets/stt/provider", "not json"),
        // Keys: never empty, blank, multi-line, or under a name that isn't an env var's.
        ("PUT", "api/tools/toolsets/stt/env", r#"{"env":{}}"#),
        ("PUT", "api/tools/toolsets/stt/env", r#"{"env":{"GROQ_API_KEY":""}}"#),
        ("PUT", "api/tools/toolsets/stt/env", r#"{"env":{"GROQ_API_KEY":"  "}}"#),
        ("PUT", "api/tools/toolsets/stt/env", r#"{"env":{"GROQ_API_KEY":"k\nLD_PRELOAD=x"}}"#),
        ("PUT", "api/tools/toolsets/stt/env", r#"{"env":{"GROQ_API_KEY":7}}"#),
        ("PUT", "api/tools/toolsets/stt/env", r#"{"env":{"groq_api_key":"k"}}"#),
        ("PUT", "api/tools/toolsets/stt/env", r#"{"env":{"1KEY":"k"}}"#),
        ("PUT", "api/tools/toolsets/stt/env", r#"{"env":{"A B":"k"}}"#),
        ("PUT", "api/tools/toolsets/stt/env", r#"{"env":{"GROQ_API_KEY":"k"},"profile":"other"}"#),
        ("PUT", "api/tools/toolsets/stt/env", r#"{"env":["GROQ_API_KEY"]}"#),
    ] {
        let err = dashboard.request(method, path, Some(body.into())).await.err().unwrap();
        assert!(matches!(err, TransportError::NotRelayed(_)), "{method} {path} {body}: {err:?}");
    }
    assert!(matches!(dashboard.request("PUT", "api/tools/toolsets/stt/provider", None).await, Err(TransportError::NotRelayed(_))));
    let long = json!({"env": {"GROQ_API_KEY": "k".repeat(4097)}}).to_string();
    assert!(matches!(dashboard.request("PUT", "api/tools/toolsets/stt/env", Some(long)).await, Err(TransportError::NotRelayed(_))));
    let long = json!({"env": {"A".repeat(129): "k"}}).to_string();
    assert!(matches!(dashboard.request("PUT", "api/tools/toolsets/stt/env", Some(long)).await, Err(TransportError::NotRelayed(_))));
}

#[tokio::test]
async fn relays_the_gateway_save_and_status_check() {
    let dashboard = signed_in().await;
    for (path, body) in [
        (
            "api/messaging/platforms/telegram?profile=work",
            json!({"enabled": true, "env": {"TELEGRAM_BOT_TOKEN": "123456789:AAAAdummydummydummydummydummydummy00"}}),
        ),
        ("api/messaging/platforms/telegram?profile=work", json!({"enabled": false, "clear_env": ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USERS"]})),
        ("api/messaging/platforms/discord?profile=bot", json!({"enabled": true, "env": {"DISCORD_ALLOWED_USERS": "1, 2"}, "clear_env": ["DISCORD_BOT_TOKEN"]})),
        ("api/messaging/platforms/discord", json!({"enabled": false})),
    ] {
        let got: Value = serde_json::from_str(&dashboard.request("PUT", path, Some(body.to_string())).await.unwrap()).unwrap();
        assert_eq!(got, json!({"uri": format!("/{path}"), "content_type": "application/json", "body": body}));
    }
    for path in ["api/messaging/platforms/telegram/test?profile=work", "api/messaging/platforms/discord/test"] {
        let got: Value = serde_json::from_str(&dashboard.request("POST", path, None).await.unwrap()).unwrap();
        assert_eq!(got["uri"], json!(format!("/{path}")));
    }
}

#[tokio::test]
async fn relays_no_other_gateway_write() {
    let dashboard = signed_in().await;
    for (method, path, body) in [
        // Other platforms, other messaging routes, and the wrong method.
        ("PUT", "api/messaging/platforms/slack", Some(r#"{"enabled":true}"#)),
        ("PUT", "api/messaging/platforms/whatsapp", Some(r#"{"env":{"WHATSAPP_MODE":"bot"}}"#)),
        ("PUT", "api/messaging/platforms/Telegram", Some(r#"{"enabled":true}"#)),
        ("PUT", "api/messaging/platforms/telegram/x", Some(r#"{"enabled":true}"#)),
        ("POST", "api/messaging/platforms/telegram", Some(r#"{"enabled":true}"#)),
        ("PUT", "api/messaging/platforms/telegram/test", None),
        ("POST", "api/messaging/platforms/telegram/test", Some("{}")),
        ("POST", "api/messaging/platforms/slack/test", None),
        ("POST", "api/messaging/telegram/onboarding/start", Some("{}")),
        // Bodies with anything else, a profile in the body, or nothing to do.
        ("PUT", "api/messaging/platforms/telegram", Some(r#"{"enabled":true,"profile":"other"}"#)),
        ("PUT", "api/messaging/platforms/telegram", Some(r#"{"enabled":"yes"}"#)),
        ("PUT", "api/messaging/platforms/telegram", Some("{}")),
        ("PUT", "api/messaging/platforms/telegram", Some("not json")),
        ("PUT", "api/messaging/platforms/telegram", None),
        // Another platform's or another program's env vars, and values that aren't one non-blank line.
        ("PUT", "api/messaging/platforms/telegram", Some(r#"{"env":{"DISCORD_BOT_TOKEN":"x"}}"#)),
        ("PUT", "api/messaging/platforms/discord", Some(r#"{"env":{"OPENAI_API_KEY":"x"}}"#)),
        ("PUT", "api/messaging/platforms/discord", Some(r#"{"clear_env":["LD_PRELOAD"]}"#)),
        ("PUT", "api/messaging/platforms/telegram", Some(r#"{"env":{"TELEGRAM_":"x"}}"#)),
        ("PUT", "api/messaging/platforms/telegram", Some(r#"{"env":{"telegram_bot_token":"x"}}"#)),
        ("PUT", "api/messaging/platforms/telegram", Some(r#"{"env":{"TELEGRAM_BOT_TOKEN":""}}"#)),
        ("PUT", "api/messaging/platforms/telegram", Some(r#"{"env":{"TELEGRAM_BOT_TOKEN":"  "}}"#)),
        ("PUT", "api/messaging/platforms/telegram", Some(r#"{"env":{"TELEGRAM_BOT_TOKEN":"1:a\nLD_PRELOAD=x"}}"#)),
        ("PUT", "api/messaging/platforms/telegram", Some(r#"{"env":{"TELEGRAM_BOT_TOKEN":7}}"#)),
        ("PUT", "api/messaging/platforms/telegram", Some(r#"{"env":{}}"#)),
        ("PUT", "api/messaging/platforms/telegram", Some(r#"{"clear_env":[]}"#)),
        ("PUT", "api/messaging/platforms/telegram", Some(r#"{"clear_env":"TELEGRAM_BOT_TOKEN"}"#)),
    ] {
        let err = dashboard.request(method, path, body.map(Into::into)).await.err().unwrap();
        assert!(matches!(err, TransportError::NotRelayed(_)), "{method} {path} {body:?}: {err:?}");
    }
    let long = json!({"env": {"TELEGRAM_BOT_TOKEN": "k".repeat(4097)}}).to_string();
    assert!(matches!(dashboard.request("PUT", "api/messaging/platforms/telegram", Some(long)).await, Err(TransportError::NotRelayed(_))));
}

#[tokio::test]
async fn relays_no_other_toolset_write() {
    let dashboard = signed_in().await;
    let probe = format!("api/tools/toolsets/{}", transport::TOOLSET_PROBE_NAME);
    for (method, path, body) in [
        // Routes under the prefix that write secrets, pick providers or run installs.
        ("PUT", "api/tools/toolsets/web/env", r#"{"enabled":true}"#),
        ("PUT", "api/tools/toolsets/web/provider", r#"{"enabled":true}"#),
        ("POST", "api/tools/toolsets/web/post-setup", r#"{"enabled":true}"#),
        ("POST", "api/tools/toolsets/web", r#"{"enabled":true}"#),
        // Bodies with anything but a boolean `enabled`.
        ("PUT", "api/tools/toolsets/web", r#"{"enabled":true,"profile":"other"}"#),
        ("PUT", "api/tools/toolsets/web", r#"{"enabled":"yes"}"#),
        ("PUT", "api/tools/toolsets/web", r#"{}"#),
        ("PUT", "api/tools/toolsets/web", r#"[true]"#),
        ("PUT", "api/tools/toolsets/web", "not json"),
        ("PUT", probe.as_str(), r#"{"enabled":false}"#),
        ("PUT", "api/tools/toolsets/web", r#"{"enabled":"probe"}"#),
        // Names this app never sends.
        ("PUT", "api/tools/toolsets/", r#"{"enabled":true}"#),
        ("PUT", "api/tools/toolsets/..", r#"{"enabled":true}"#),
        ("PUT", "api/tools/toolsets/a%2Fb", r#"{"enabled":true}"#),
        ("PUT", "api/tools/toolsets", r#"{"enabled":true}"#),
    ] {
        let err = dashboard.request(method, path, Some(body.into())).await.err().unwrap();
        assert!(matches!(err, TransportError::NotRelayed(_)), "{method} {path} {body}: {err:?}");
    }
    assert!(dashboard.request("PUT", "api/tools/toolsets/web", None).await.is_err());
}

#[tokio::test]
async fn relays_the_persona_write_for_a_profile() {
    let dashboard = signed_in().await;
    let body = json!({"content": "# Persona\n"}).to_string();
    let got: Value = serde_json::from_str(&dashboard.request("PUT", "api/profiles/work-2/soul", Some(body)).await.unwrap()).unwrap();
    assert_eq!(got, json!({"uri": "/api/profiles/work-2/soul", "content_type": "application/json", "body": {"content": "# Persona\n"}}));
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
        let got: Value =
            serde_json::from_str(&dashboard.request("POST", &format!("api/cron/jobs/f8f9e9ea90bc/{action}?profile=default"), None).await.unwrap()).unwrap();
        assert_eq!(got["uri"], format!("/api/cron/jobs/f8f9e9ea90bc/{action}?profile=default"));
    }
}

#[tokio::test]
async fn relays_a_session_import_only_when_every_session_is_marked_imported() {
    let dashboard = signed_in().await;
    let body =
        json!({"profile": "default", "request_id": "r", "expected_revision": 0, "sessions": [{"id": "a", "source": "import", "messages": []}]}).to_string();
    let got: Value = serde_json::from_str(&dashboard.request("POST", "api/sessions/import", Some(body)).await.unwrap()).unwrap();
    assert_eq!(got["uri"], "/api/sessions/import");
    assert_eq!(got["body"]["sessions"][0]["source"], "import");
    for body in [
        None,
        Some("not json".to_owned()),
        Some(json!({"sessions": []}).to_string()),
        Some(json!({"sessions": [{"id": "a"}]}).to_string()),
        Some(json!({"sessions": [{"id": "a", "source": "import"}, {"id": "b", "source": "telegram"}]}).to_string()),
        Some(json!({"sessions": "x"}).to_string()),
    ] {
        let err = dashboard.request("POST", "api/sessions/import", body.clone()).await.err().unwrap();
        assert!(matches!(err, TransportError::NotRelayed(_)), "{body:?}: {err:?}");
    }
    let body = json!({"sessions": [{"id": "a", "source": "import"}]}).to_string();
    for path in ["api/sessions/import/../../auth/logout", "api/sessions/importx", "api/sessions/x/import"] {
        let err = dashboard.request("POST", path, Some(body.clone())).await.err().unwrap();
        assert!(matches!(err, TransportError::NotRelayed(_)), "{path}: {err:?}");
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
async fn relays_only_get_patch_and_delete_under_api_and_the_model_job_and_persona_writes() {
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
        ("POST", "api/profiles/default/soul"),
        ("PUT", "api/profiles/soul"),
        ("PUT", "api/profiles//soul"),
        ("PUT", "api/profiles/../soul"),
        ("PUT", "api/profiles/Work/soul"),
        ("PUT", "api/profiles/-work/soul"),
        ("PUT", "api/profiles/a/b/soul"),
        ("PUT", "api/profiles/work%2F..%2Fx/soul"),
        ("PUT", "api/profiles/default/soul/../../../auth/logout"),
        ("PUT", "api/profiles/default"),
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
        let dashboard = sign_in_at(&base, &sign_in("hunter2")).await.expect(prefix);
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

fn path_of(p: &std::path::Path) -> String {
    p.to_str().unwrap().to_owned()
}

#[tokio::test]
async fn stats_files_to_attach() {
    let dir = scratch("stat");
    let png = dir.join("rack.png");
    std::fs::write(&png, b"\x89PNG fake").unwrap();
    let elsewhere = dir.join("id_ed25519");
    std::fs::write(&elsewhere, b"PRIVATE KEY").unwrap();
    let attachable = transport::Attachable::default();
    attachable.add([path_of(&png), path_of(&dir), path_of(&dir.join("gone.txt"))]);
    let got = transport::stat_files(&attachable, &[path_of(&png), path_of(&dir), path_of(&dir.join("gone.txt")), path_of(&elsewhere)]).await;
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
            LocalFile { path: path_of(&elsewhere), name: "id_ed25519".into(), size: None, error: Some("it wasn't attached in this app".into()) },
        ]
    );
}

#[test]
fn attached_files_stay_attachable_after_a_restart() {
    let dir = scratch("attachable");
    let kept = dir.join("data").join("attachable.json");
    let before = transport::Attachable::default();
    before.load(kept.clone());
    before.add(["/home/me/report.pdf".to_owned()]);

    let after = transport::Attachable::default();
    after.load(kept);
    assert!(after.check("/home/me/report.pdf").is_ok());
    assert!(after.check("/home/me/.ssh/id_ed25519").is_err());
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
    assert_eq!(frame(next(&mut rx).await)["result"], json!({"name": "notes.txt", "data_url": "data:application/octet-stream;base64,c2RhIDkyJQ=="}));
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
    let dashboard = sign_in_at(&direct.base, &sign_in("hunter2")).await.expect("signed in");
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

/// Reads `path` for its thumbnail as the composer does, once the owner has attached it.
async fn preview(path: &str) -> Result<Vec<u8>, TransportError> {
    let attachable = transport::Attachable::default();
    attachable.add([path.to_owned()]);
    transport::read_preview(&attachable, path).await
}

#[tokio::test]
async fn previews_only_attached_files() {
    let dir = scratch("preview-unattached");
    let png = dir.join("screen.png");
    std::fs::write(&png, b"\x89PNG\r\n\x1a\nrest").unwrap();
    let attachable = transport::Attachable::default();
    let err = transport::read_preview(&attachable, &path_of(&png)).await.err().unwrap();
    assert_eq!(err.to_string(), "it wasn't attached in this app");
    attachable.add([path_of(&png)]);
    assert_eq!(transport::read_preview(&attachable, &path_of(&png)).await.unwrap(), b"\x89PNG\r\n\x1a\nrest");
}

#[tokio::test]
async fn reads_a_staged_image_for_its_preview() {
    let dir = scratch("preview");
    let png = dir.join("rack.PNG");
    std::fs::write(&png, b"\x89PNG\r\n\x1a\nrest").unwrap();
    assert_eq!(preview(&path_of(&png)).await.unwrap(), b"\x89PNG\r\n\x1a\nrest");
    let webp = dir.join("cat.webp");
    std::fs::write(&webp, b"RIFF\0\0\0\0WEBPVP8 ").unwrap();
    assert!(preview(&path_of(&webp)).await.is_ok());
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
        assert_eq!(preview(&p).await.err().unwrap().to_string(), "it isn't an image", "{p}");
    }
}

#[tokio::test]
async fn refuses_to_preview_a_missing_or_oversized_image() {
    let dir = scratch("preview-refused");
    let err = preview(&path_of(&dir.join("gone.png"))).await.err().unwrap();
    assert_eq!(err.to_string(), "No such file or directory (os error 2)");

    let big = dir.join("big.png");
    let f = std::fs::File::create(&big).unwrap();
    f.set_len(transport::PREVIEW_MAX_BYTES + 1).unwrap();
    let err = preview(&path_of(&big)).await.err().unwrap();
    assert_eq!(err.to_string(), "it's 25.0 MB now, over the 25 MB limit");
}

#[tokio::test]
async fn a_connection_test_reads_the_status_signs_in_and_waits_for_hermes() {
    let probed = transport::probe(&stub().await, &sign_in("hunter2"), "default").await.expect("test passes");
    assert_eq!(serde_json::from_str::<Value>(&probed.status).unwrap()["auth_providers"], json!(["basic"]));
    assert_eq!(serde_json::from_str::<Value>(&probed.ready).unwrap()["params"]["type"], "gateway.ready");
}

#[tokio::test]
async fn a_connection_test_says_the_password_was_wrong_and_keeps_the_status() {
    let failed = transport::probe(&stub().await, &sign_in("nope"), "default").await.unwrap_err();
    assert_eq!((failed.stage, failed.message.as_str()), (Stage::SignIn, "Wrong username or password."));
    assert!(failed.status.unwrap().contains("0.22.5"));
}

#[tokio::test]
async fn a_connection_test_says_when_nothing_answers() {
    let free = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap();
    let failed = transport::probe(&Url::parse(&format!("http://{free}/")).unwrap(), &sign_in("hunter2"), "default").await.unwrap_err();
    assert_eq!(failed.stage, Stage::Reach);
    assert!(failed.message.contains("Can't reach the Hermes dashboard") && failed.message.to_lowercase().contains("refused"), "{}", failed.message);
}

#[tokio::test]
async fn a_connection_test_gives_up_on_a_port_that_never_answers() {
    let silent = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = silent.local_addr().unwrap();
    tokio::spawn(async move {
        let mut held = vec![];
        while let Ok((sock, _)) = silent.accept().await {
            held.push(sock);
        }
    });
    let base = Url::parse(&format!("http://{addr}/")).unwrap();
    let failed = transport::probe_with(&base, &sign_in("hunter2"), "default", Duration::from_millis(300)).await.unwrap_err();
    assert_eq!(failed, ProbeFailure::new(Stage::Reach, "The dashboard didn't answer within 0s."));
}

fn saved_for(profile: &str) -> Vec<Value> {
    SAVED_KEYS.lock().unwrap().iter().filter(|(q, _)| q == &format!("profile={profile}")).map(|(_, b)| b.clone()).collect()
}

#[tokio::test]
async fn saves_a_provider_key_the_provider_accepts() {
    let dashboard = signed_in().await;
    let saved = dashboard.save_provider_key("keys-good", "OPENROUTER_API_KEY", "  sk-good ").await.unwrap();
    assert_eq!(saved, SavedKey { verified: true });
    assert_eq!(saved_for("keys-good"), vec![json!({"key": "OPENROUTER_API_KEY", "value": "sk-good", "provider_setup": true})]);
}

#[tokio::test]
async fn saves_a_key_the_provider_could_not_check_and_says_so() {
    let dashboard = signed_in().await;
    let saved = dashboard.save_provider_key("keys-offline", "OPENROUTER_API_KEY", "sk-offline").await.unwrap();
    assert_eq!(saved, SavedKey { verified: false });
    assert_eq!(saved_for("keys-offline").len(), 1);
}

#[tokio::test]
async fn does_not_save_a_key_the_provider_turns_down() {
    let dashboard = signed_in().await;
    let err = dashboard.save_provider_key("keys-bad", "OPENROUTER_API_KEY", "sk-bad").await.unwrap_err();
    assert_eq!(err.to_string(), transport::KEY_TURNED_DOWN);
    assert!(saved_for("keys-bad").is_empty());
    // An answer that isn't one is neither shown nor saved on.
    let err = dashboard.save_provider_key("keys-bad", "OPENROUTER_API_KEY", "sk-garbled").await.unwrap_err().to_string();
    assert!(!err.contains("sk-"), "{err}");
    assert!(saved_for("keys-bad").is_empty());
}

#[tokio::test]
async fn saves_only_what_hermes_lists_as_a_provider_key() {
    let dashboard = signed_in().await;
    for key in ["TELEGRAM_BOT_TOKEN", "OPENAI_BASE_URL", "NOT_LISTED_API_KEY", "HERMES_DASHBOARD_SESSION_TOKEN", "PATH"] {
        let err = dashboard.save_provider_key("keys-refused", key, "sk-good").await.unwrap_err();
        assert!(matches!(err, TransportError::NotRelayed(_)), "{key}: {err:?}");
    }
    let err = dashboard.save_provider_key("keys-refused", "OPENROUTER_API_KEY", "sk-good\nEVIL=1").await.unwrap_err();
    assert!(matches!(err, TransportError::KeyRejected(_)), "{err:?}");
    assert!(saved_for("keys-refused").is_empty());
}

#[tokio::test]
async fn a_failed_key_save_never_shows_the_key_or_part_of_it() {
    let dashboard = signed_in().await;
    // Long enough that a 300-character cut of the echo would end inside it.
    let key = format!("sk-echo-{}", "x".repeat(400));
    let err = dashboard.save_provider_key("keys-echo", "OPENROUTER_API_KEY", &key).await.unwrap_err().to_string();
    assert!(err.contains("422") && !err.contains("sk-echo") && !err.contains("xxxx"), "{err}");
}

#[tokio::test]
async fn removes_a_provider_key_and_reads_the_list_back() {
    let dashboard = signed_in().await;
    dashboard.remove_provider_key("keys-remove", "ANTHROPIC_API_KEY").await.unwrap();
    assert_eq!(removed_for("keys-remove"), vec![json!({"key": "ANTHROPIC_API_KEY"})]);
}

#[tokio::test]
async fn a_key_hermes_says_is_not_set_counts_as_removed() {
    let dashboard = signed_in().await;
    dashboard.remove_provider_key("keys-gone", "ANTHROPIC_API_KEY").await.unwrap();
}

#[tokio::test]
async fn says_so_when_hermes_still_lists_the_key_after_removing_it() {
    let dashboard = signed_in().await;
    let err = dashboard.remove_provider_key("keys-stuck", "ANTHROPIC_API_KEY").await.unwrap_err();
    assert!(matches!(&err, TransportError::KeyStillSet(key) if key == "ANTHROPIC_API_KEY"), "{err:?}");
}

#[tokio::test]
async fn removes_only_what_hermes_lists_as_a_provider_key() {
    let dashboard = signed_in().await;
    for key in ["TELEGRAM_BOT_TOKEN", "OPENAI_BASE_URL", "NOT_LISTED_API_KEY", "HERMES_DASHBOARD_SESSION_TOKEN", "PATH"] {
        let err = dashboard.remove_provider_key("keys-refused-remove", key).await.unwrap_err();
        assert!(matches!(err, TransportError::NotRelayed(_)), "{key}: {err:?}");
    }
    assert!(removed_for("keys-refused-remove").is_empty());
}

#[tokio::test]
async fn a_provider_key_removal_never_follows_a_redirect_to_another_site() {
    let (elsewhere, other) = other_site().await;
    let away = elsewhere.join("api/env").unwrap().to_string();
    let app =
        Router::new().route("/auth/password-login", post(login)).route("/api/env", get(env_rows).delete(move || async move { Redirect::temporary(&away) }));
    let dashboard = sign_in_at(&serve(app).await, &sign_in("hunter2")).await.unwrap();
    let err = dashboard.remove_provider_key("default", "ANTHROPIC_API_KEY").await.unwrap_err();
    assert!(matches!(err, TransportError::Redirected(_)), "{err:?}");
    assert!(other.lock().unwrap().is_empty(), "the request went to another site");
}

#[tokio::test]
async fn a_provider_key_removal_that_never_answers_gives_up() {
    let app = Router::new().route("/auth/password-login", post(login)).route("/api/env", get(env_rows).delete(std::future::pending::<Response>));
    let dashboard = sign_in_at(&serve(app).await, &sign_in("hunter2")).await.unwrap();
    let started = std::time::Instant::now();
    let err = dashboard.remove_provider_key_within("default", "ANTHROPIC_API_KEY", Duration::from_millis(300)).await.unwrap_err();
    assert!(matches!(err, TransportError::KeyRemovalTimedOut(_)), "{err:?}");
    assert!(started.elapsed() < Duration::from_secs(3));
}

#[tokio::test]
async fn never_relays_a_delete_of_the_servers_env() {
    let dashboard = signed_in().await;
    for path in [
        "api/env",
        "api/env?profile=default",
        "api/env/",
        "api/env/reveal",
        // Spelled so the server still routes them to `/api/env`.
        "api/./env",
        "api/%2e/env",
        "api/%65nv",
        "api%2Fenv",
        "api//env",
        "api/sessions/%2E%2E/env",
    ] {
        let err = dashboard.request("DELETE", path, Some(json!({"key": "ANTHROPIC_API_KEY"}).to_string())).await.err().unwrap();
        assert!(matches!(err, TransportError::NotRelayed(_)), "DELETE {path}: {err:?}");
    }
    assert!(removed_for("default").is_empty());
    // Reading it, and any other delete, still go through.
    dashboard.request("GET", "api/env?profile=default", None).await.unwrap();
    dashboard.request("DELETE", "api/sessions/a%20b", None).await.unwrap();
}

#[tokio::test]
async fn a_connection_test_gives_up_on_a_status_body_that_never_comes() {
    let stalled = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = stalled.local_addr().unwrap();
    tokio::spawn(async move {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut held = vec![];
        while let Ok((mut sock, _)) = stalled.accept().await {
            let mut buf = [0u8; 1024];
            let _ = sock.read(&mut buf).await;
            let _ = sock.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 100\r\n\r\n{").await;
            held.push(sock);
        }
    });
    let base = Url::parse(&format!("http://{addr}/")).unwrap();
    let started = std::time::Instant::now();
    let failed = transport::probe_with(&base, &sign_in("hunter2"), "default", Duration::from_millis(300)).await.unwrap_err();
    assert_eq!(failed.stage, Stage::Reach);
    assert!(started.elapsed() < Duration::from_secs(3));
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
        transport::VoiceSetup {
            transcribe: true,
            speak: true,
            stt_enabled: Some(false),
            stt_provider: Some("groq".into()),
            tts_provider: Some("openai".into()),
            silence_threshold: Some(350.0),
            silence_duration: Some(1.5),
            max_recording_seconds: None,
            stt_language: Some("en".into()),
            stt_settings: [
                ("elevenlabs".into(), [("language_code".into(), "eng".into()), ("model_id".into(), "scribe_v2".into())].into()),
                ("groq".into(), [("language".into(), "".into()), ("model".into(), "whisper-large-v3-turbo".into())].into()),
            ]
            .into(),
            tts_settings: [
                ("elevenlabs".into(), [("model_id".into(), "eleven_multilingual_v2".into()), ("voice_id".into(), "pNInz6obpgDQGcFmaJgB".into())].into()),
                ("openai".into(), [("model".into(), "gpt-4o-mini-tts".into()), ("voice".into(), "alloy".into())].into()),
            ]
            .into(),
        }
    );
    let json = serde_json::to_string(&setup).unwrap();
    assert!(!json.contains("SECRET"), "{json}");
    assert_eq!(
        json,
        concat!(
            r#"{"transcribe":true,"speak":true,"sttEnabled":false,"sttProvider":"groq","ttsProvider":"openai","silenceThreshold":350.0,"silenceDuration":1.5,"#,
            r#""sttLanguage":"en","sttSettings":{"elevenlabs":{"language_code":"eng","model_id":"scribe_v2"},"groq":{"language":"","model":"whisper-large-v3-turbo"}},"#,
            r#""ttsSettings":{"elevenlabs":{"model_id":"eleven_multilingual_v2","voice_id":"pNInz6obpgDQGcFmaJgB"},"openai":{"model":"gpt-4o-mini-tts","voice":"alloy"}}}"#
        )
    );
}

#[tokio::test]
async fn a_server_without_voice_has_neither_route() {
    for profile in ["old", "older"] {
        let setup = signed_in().await.voice_setup(profile).await.unwrap();
        let none = transport::VoiceSetup { transcribe: false, speak: false, stt_enabled: None, stt_provider: None, tts_provider: None, ..Default::default() };
        assert_eq!(setup, none, "{profile}");
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
    assert_eq!(err(path_of(&dir.join("gone.txt"))).await, std::io::Error::from_raw_os_error(2).to_string());
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

#[cfg(unix)]
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

#[cfg(unix)]
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
    let dashboard = sign_in_at(&base, &access_sign_in()).await.unwrap();
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
    let dashboard = sign_in_at(&serve(app).await, &access_sign_in()).await.unwrap();
    for err in
        [dashboard.transcribe("default", "audio/wav", b"private audio").await.err().unwrap(), dashboard.speak("default", "private reply").await.err().unwrap()]
    {
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
    let dashboard = sign_in_at(&base, &access_sign_in()).await.expect("signed in through the gate");
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
    let err = sign_in_at(&base, &sign_in("hunter2")).await.err().unwrap();
    assert!(matches!(err, TransportError::Unexpected { status: 403, .. }), "{err:?}");
}

#[tokio::test]
async fn extra_headers_follow_a_redirect_within_the_dashboard_only() {
    let (elsewhere, other_seen) = other_site().await;
    let (base, _) = gated_stub(&elsewhere).await;
    let dashboard = sign_in_at(&base, &access_sign_in()).await.expect("signed in");
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
    let err = sign_in_at(&base, &access_sign_in()).await.err().unwrap();
    assert!(matches!(err, TransportError::Redirected(_)), "{err:?}");
    assert!(other_seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_password_never_follows_a_cross_origin_307_or_308_without_extra_headers() {
    for permanent in [false, true] {
        let (elsewhere, other_seen) = other_site().await;
        let login = elsewhere.join("steal").unwrap().to_string();
        let base = serve(Router::new().route(
            "/auth/password-login",
            post(move || {
                let login = login.clone();
                async move {
                    if permanent {
                        Redirect::permanent(&login)
                    } else {
                        Redirect::temporary(&login)
                    }
                }
            }),
        ))
        .await;
        let err = sign_in_at(&base, &sign_in("hunter2")).await.err().unwrap();
        assert!(matches!(err, TransportError::Redirected(_)), "{err:?}");
        assert!(other_seen.lock().unwrap().is_empty(), "the password reached another origin");
    }
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
        let err = transport::extra_headers(&headers)
            .err()
            .unwrap_or_else(|| panic!("accepted {:?}", headers.iter().map(|h| (&h.name, &h.value)).collect::<Vec<_>>()))
            .to_string();
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
    let png = b"\x89PNG\r\n\x1a\npasted";
    let a = transport::stage_clipboard_file("clipboard-2026-11-02T153000.png", png).unwrap();
    let b = transport::stage_clipboard_file("clipboard-2026-11-02T153000.png", png).unwrap();
    for p in [&a, &b] {
        assert!(p.is_absolute(), "{p:?}");
        assert!(p.starts_with(std::env::temp_dir().join("hermes-chat")), "{p:?}");
        assert_eq!(p.file_name().unwrap(), "clipboard-2026-11-02T153000.png");
        assert_eq!(std::fs::read(p).unwrap(), png);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let folder = std::fs::metadata(p.parent().unwrap()).unwrap();
            assert_eq!(folder.permissions().mode() & 0o777, 0o700, "{p:?}");
        }
    }
    // The same screenshot pasted twice is two files, so both attach.
    assert_ne!(a, b);
    let attachable = transport::Attachable::default();
    attachable.add([path_of(&a)]);
    let got = tokio::runtime::Runtime::new().unwrap().block_on(transport::stat_files(&attachable, &[path_of(&a)]));
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

#[tokio::test]
async fn a_connection_test_sends_the_extra_headers_on_every_request() {
    let (elsewhere, _) = other_site().await;
    let (base, seen) = gated_stub(&elsewhere).await;
    transport::probe(&base, &access_sign_in(), "default").await.expect("test passes through the gate");
    let seen = seen.lock().unwrap();
    let paths: Vec<_> = seen.iter().map(|(p, _)| p.as_str()).collect();
    assert!(["/api/status", "/auth/password-login", "/api/ws"].iter().all(|p| paths.contains(p)), "{paths:?}");
    assert!(seen.iter().all(|(_, secret)| secret.as_deref() == Some("s3cret")), "{seen:?}");
}

#[tokio::test]
async fn a_connection_test_stops_at_a_redirect_to_another_site() {
    let (elsewhere, other) = other_site().await;
    let away = elsewhere.join("login").unwrap().to_string();
    let app = Router::new().route("/api/status", get(move || async move { Redirect::temporary(&away) }));
    let failed = transport::probe(&serve(app).await, &access_sign_in(), "default").await.unwrap_err();
    assert_eq!(failed.stage, Stage::Reach);
    assert!(failed.message.contains("another site"), "{}", failed.message);
    assert!(other.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_connection_test_stops_where_a_gateway_turns_it_away() {
    let (elsewhere, _) = other_site().await;
    let (base, seen) = gated_stub(&elsewhere).await;
    let failed = transport::probe(&base, &sign_in("hunter2"), "default").await.unwrap_err();
    assert_eq!(failed.stage, Stage::Reach);
    assert!(failed.message.contains("answered 403"), "{}", failed.message);
    // It went no further: the password was never sent.
    assert_eq!(seen.lock().unwrap().iter().map(|(p, _)| p.as_str()).collect::<Vec<_>>(), ["/api/status"]);
}

#[tokio::test]
async fn a_provider_key_never_follows_a_redirect_to_another_site() {
    let (elsewhere, other) = other_site().await;
    let away = elsewhere.join("api/providers/validate").unwrap().to_string();
    let app = Router::new()
        .route("/auth/password-login", post(login))
        .route("/api/env", get(env_rows))
        .route("/api/providers/validate", post(move || async move { Redirect::temporary(&away) }));
    // No extra headers: provider keys must still stay on the dashboard origin.
    let dashboard = sign_in_at(&serve(app).await, &sign_in("hunter2")).await.unwrap();
    let err = dashboard.save_provider_key("default", "OPENROUTER_API_KEY", "sk-good").await.unwrap_err().to_string();
    assert!(err.contains("307") && !err.contains("sk-good"), "{err}");
    assert!(other.lock().unwrap().is_empty(), "the key went to another site");
}

#[tokio::test]
async fn a_gateways_refusal_never_shows_the_header_values_it_turned_down() {
    // A gateway that repeats what it was sent in its refusal.
    let app = Router::new().route(
        "/api/status",
        get(|headers: HeaderMap| async move {
            let secret = headers.get("cf-access-client-secret").and_then(|v| v.to_str().ok()).unwrap_or_default().to_owned();
            (StatusCode::FORBIDDEN, format!("Forbidden: bad service token {secret}")).into_response()
        }),
    );
    let base = serve(app).await;
    let failed = transport::probe(&base, &access_sign_in(), "default").await.unwrap_err();
    assert_eq!(failed.stage, Stage::Reach);
    assert!(failed.message.contains("answered 403") && !failed.message.contains("s3cret"), "{}", failed.message);
    // Without extra headers there is nothing to repeat, and the answer helps.
    let failed = transport::probe(&base, &sign_in("hunter2"), "default").await.unwrap_err();
    assert!(failed.message.contains("Forbidden: bad service token"), "{}", failed.message);
}

/// A gateway that lets `/api/status` through, then turns `refuse` away with a page that repeats the secret it got.
async fn echoing_gateway(refuse: &'static str) -> Url {
    let echo = |headers: HeaderMap| async move {
        let secret = headers.get("cf-access-client-secret").and_then(|v| v.to_str().ok()).unwrap_or_default().to_owned();
        (StatusCode::FORBIDDEN, format!("Forbidden: bad service token {secret}")).into_response()
    };
    let mut app = Router::new().route("/api/status", get(status));
    app =
        if refuse == "/auth/password-login" { app.route(refuse, post(echo)) } else { app.route("/auth/password-login", post(login)).route(refuse, post(echo)) };
    serve(app).await
}

#[tokio::test]
async fn a_connection_test_never_shows_a_header_value_a_gateway_repeats_at_sign_in_or_the_ticket() {
    for (refuse, stage) in [("/auth/password-login", Stage::SignIn), ("/api/auth/ws-ticket", Stage::Chat)] {
        let failed = transport::probe(&echoing_gateway(refuse).await, &access_sign_in(), "default").await.unwrap_err();
        assert_eq!(failed.stage, stage, "{refuse}");
        assert!(failed.message.contains("403") && !failed.message.contains("s3cret"), "{refuse}: {}", failed.message);
    }
}

#[tokio::test]
async fn with_extra_headers_the_dashboards_own_detail_is_still_shown_unless_it_repeats_one() {
    let app = Router::new()
        .route("/auth/password-login", post(login))
        .route("/api/plain", get(|| async { (StatusCode::NOT_FOUND, Json(json!({"detail": "Profile 'x' does not exist."}))) }))
        .route("/api/repeats", get(|| async { (StatusCode::BAD_REQUEST, Json(json!({"detail": [{"input": "s3cret"}]}))) }));
    let dashboard = sign_in_at(&serve(app).await, &access_sign_in()).await.unwrap();
    let plain = dashboard.request("GET", "api/plain", None).await.unwrap_err().to_string();
    assert!(plain.contains("Profile 'x' does not exist."), "{plain}");
    let repeats = dashboard.request("GET", "api/repeats", None).await.unwrap_err().to_string();
    assert!(repeats.contains("400") && !repeats.contains("s3cret"), "{repeats}");
}

#[tokio::test]
async fn a_provider_key_check_that_never_answers_gives_up() {
    let app = Router::new()
        .route("/auth/password-login", post(login))
        .route("/api/env", get(env_rows))
        .route("/api/providers/validate", post(std::future::pending::<Response>));
    let dashboard = sign_in_at(&serve(app).await, &sign_in("hunter2")).await.unwrap();
    let started = std::time::Instant::now();
    let err = dashboard.save_provider_key_within("default", "OPENROUTER_API_KEY", "sk-good", Duration::from_millis(300)).await.unwrap_err();
    assert!(matches!(err, TransportError::KeyTimedOut(_)), "{err:?}");
    assert!(started.elapsed() < Duration::from_secs(3));
}

/// Gateway sign-in headers whose secret is long, as a real service token's is.
const LONG_SECRET: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn long_secret_sign_in() -> SignIn {
    let headers = transport::extra_headers(&[header("CF-Access-Client-Id", "id.access"), header("CF-Access-Client-Secret", LONG_SECRET)]).unwrap();
    SignIn { headers, ..sign_in("hunter2") }
}

/// Whether `text` holds any 8 characters of `LONG_SECRET`.
fn shows_part_of_secret(text: &str) -> bool {
    (0..=LONG_SECRET.len() - 8).any(|i| text.contains(&LONG_SECRET[i..i + 8]))
}

#[tokio::test]
async fn a_redirect_loop_never_shows_the_key_or_a_header_value_it_put_in_the_url() {
    // The dashboard's own origin, so the redirects are followed until reqwest gives up on them.
    let lap = |RawQuery(q): RawQuery| async move { Redirect::temporary(&format!("/loop?{}", q.unwrap_or_default())) };
    let app = Router::new()
        .route("/auth/password-login", post(login))
        .route("/api/env", get(env_rows))
        .route(
            "/api/providers/validate",
            post(|Json(body): Json<Value>| async move { Redirect::temporary(&format!("/loop?k={}", body["value"].as_str().unwrap_or("none"))) }),
        )
        .route(
            "/api/status",
            get(|headers: HeaderMap| async move {
                let secret = headers.get("cf-access-client-secret").and_then(|v| v.to_str().ok()).unwrap_or_default().to_owned();
                Redirect::temporary(&format!("/loop?s={secret}"))
            }),
        )
        .route("/loop", get(lap).post(lap));
    let base = serve(app).await;
    let dashboard = sign_in_at(&base, &sign_in("hunter2")).await.unwrap();
    let err = dashboard.save_provider_key("default", "OPENROUTER_API_KEY", "sk-good-and-long").await.unwrap_err().to_string();
    assert!(err.contains("redirect") && !err.contains("sk-good"), "{err}");
    let failed = transport::probe(&base, &long_secret_sign_in(), "default").await.unwrap_err();
    assert_eq!(failed.stage, Stage::Reach);
    assert!(failed.message.contains("redirect") && !shows_part_of_secret(&failed.message), "{}", failed.message);
}

#[tokio::test]
async fn a_voice_refusal_never_shows_a_header_value_even_cut_short() {
    let refuse = |status: StatusCode| {
        move |headers: HeaderMap| async move {
            let secret = headers.get("cf-access-client-secret").and_then(|v| v.to_str().ok()).unwrap_or_default().to_owned();
            // Cut short, as a gateway might, and well past the 800 characters a reason keeps.
            (status, Json(json!({"detail": format!("{}{}", "x".repeat(790), &secret[..40])}))).into_response()
        }
    };
    let app = Router::new()
        .route("/auth/password-login", post(login))
        .route("/api/audio/transcribe", post(refuse(StatusCode::FORBIDDEN)))
        .route("/api/audio/speak", post(refuse(StatusCode::BAD_REQUEST)));
    let dashboard = sign_in_at(&serve(app).await, &long_secret_sign_in()).await.unwrap();
    let heard = dashboard.transcribe("default", "audio/wav", b"RIFF").await.err().unwrap().to_string();
    assert!(heard.ends_with("the server answered 403 Forbidden") && !shows_part_of_secret(&heard), "{heard}");
    let spoken = dashboard.speak("default", "Hello").await.err().unwrap().to_string();
    assert!(spoken.ends_with("the server answered 400 Bad Request") && !shows_part_of_secret(&spoken), "{spoken}");
}

#[tokio::test]
async fn a_chat_connection_closed_with_a_header_value_never_shows_it() {
    let close = |ws: WebSocketUpgrade, headers: HeaderMap| async move {
        let secret = headers.get("cf-access-client-secret").and_then(|v| v.to_str().ok()).unwrap_or_default().to_owned();
        ws.on_upgrade(move |mut ws| async move {
            // A close reason is at most 123 bytes, so a long value arrives cut short.
            let reason = format!("Gateway rejected {}", &secret[..40]);
            let _ = ws.send(Message::Close(Some(axum::extract::ws::CloseFrame { code: 1008, reason: reason.into() }))).await;
        })
    };
    let app = Router::new()
        .route("/api/status", get(status))
        .route("/auth/password-login", post(login))
        .route("/api/auth/ws-ticket", post(ws_ticket))
        .route("/api/ws", get(close));
    let failed = transport::probe(&serve(app).await, &long_secret_sign_in(), "default").await.unwrap_err();
    assert_eq!(failed.stage, Stage::Chat);
    assert!(failed.message.contains("1008") && !shows_part_of_secret(&failed.message), "{}", failed.message);
}

#[tokio::test]
async fn a_redirect_to_an_address_that_repeats_a_header_value_never_shows_it() {
    // The host name the URL parser lowercases, so the value is found whatever its case.
    let away = |headers: HeaderMap| async move {
        let secret = headers.get("cf-access-client-secret").and_then(|v| v.to_str().ok()).unwrap_or_default().to_owned();
        Redirect::temporary(&format!("https://{secret}.gateway.invalid/login"))
    };
    let app = Router::new().route("/api/status", get(away)).route("/auth/password-login", post(login)).route("/api/sessions", get(away));
    let base = serve(app).await;
    let headers = transport::extra_headers(&[header("CF-Access-Client-Secret", "Round6PrivateHeader")]).unwrap();
    let sign_in = SignIn { headers, ..sign_in("hunter2") };
    let failed = transport::probe(&base, &sign_in, "default").await.unwrap_err();
    assert_eq!(failed.stage, Stage::Reach);
    assert!(failed.message.contains("another site") && !failed.message.to_lowercase().contains("privateh"), "{}", failed.message);
    let dashboard = sign_in_at(&base, &sign_in).await.unwrap();
    let err = dashboard.request("GET", "api/sessions", None).await.unwrap_err();
    assert!(matches!(err, TransportError::RedirectedHidden), "{err:?}");
}

/// The files in `dir`, hidden part files included.
fn names_in(dir: &PathBuf) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    names
}

#[tokio::test]
async fn downloads_a_server_file_in_place_of_the_destination_and_reports_progress() {
    let dashboard = signed_in().await;
    let dir = scratch("download-ok");
    let dest = dir.join("data.bin");
    std::fs::write(&dest, "the owner's older copy").unwrap();
    let seen = Mutex::new(Vec::new());
    let n = dashboard.download("/srv/data.bin", &dest, |done, total| seen.lock().unwrap().push((done, total))).await.expect("downloaded");
    assert_eq!(n, 300_000);
    let got = std::fs::read(&dest).unwrap();
    assert_eq!(got, (0..300_000u32).map(|i| (i % 251) as u8).collect::<Vec<u8>>());
    let seen = seen.into_inner().unwrap();
    assert_eq!(seen.first(), Some(&(0, Some(300_000))));
    assert_eq!(seen.last(), Some(&(300_000, Some(300_000))));
    assert_eq!(names_in(&dir), ["data.bin"], "no part file is left");
}

#[tokio::test]
async fn a_refused_or_broken_download_leaves_the_destination_as_it_was() {
    let dashboard = signed_in().await;
    let dir = scratch("download-fail");
    let dest = dir.join("keep.txt");
    std::fs::write(&dest, "kept").unwrap();
    let err = dashboard.download("/srv/.env", &dest, |_, _| {}).await.err().unwrap();
    assert!(matches!(&err, TransportError::Unexpected { status: 403, body } if body.contains("sensitive")), "{err:?}");
    let err = dashboard.download("/srv/cut", &dest, |_, _| {}).await.err().unwrap();
    assert!(matches!(err, TransportError::Unreachable(_)), "{err:?}");
    assert_eq!(std::fs::read_to_string(&dest).unwrap(), "kept");
    assert_eq!(names_in(&dir), ["keep.txt"], "the part file was removed");
    #[cfg(unix)]
    a_download_into_a_locked_folder_leaves_nothing(&dashboard, &dir).await;
}

#[cfg(unix)]
async fn a_download_into_a_locked_folder_leaves_nothing(dashboard: &Dashboard, dir: &std::path::Path) {
    // A folder this user can't write to: nothing is read past the answer's start, and nothing is left.
    let locked = dir.join("locked");
    std::fs::create_dir(&locked).unwrap();
    std::fs::set_permissions(&locked, std::os::unix::fs::PermissionsExt::from_mode(0o500)).unwrap();
    let err = dashboard.download("/srv/data.bin", &locked.join("x.bin"), |_, _| {}).await.err().unwrap();
    std::fs::set_permissions(&locked, std::os::unix::fs::PermissionsExt::from_mode(0o700)).unwrap();
    assert!(matches!(&err, TransportError::File(m) if m.contains("ermission denied")), "{err:?}");
    assert!(names_in(&locked).is_empty());
}

// On the app's kind of runtime, where the file work runs through `block_in_place`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelling_a_download_removes_its_part_file() {
    let dashboard = Arc::new(signed_in().await);
    let dir = scratch("download-cancel");
    let dest = dir.join("slow.bin");
    let (tx, mut rx) = mpsc::unbounded_channel();
    let d = dashboard.clone();
    let task = tokio::spawn({
        let dest = dest.clone();
        async move {
            d.download("/srv/slow", &dest, move |done, _| {
                let _ = tx.send(done);
            })
            .await
        }
    });
    // Wait until bytes have been written, so the part file exists.
    while rx.recv().await.unwrap() < 8192 {}
    assert_eq!(names_in(&dir).len(), 1, "a part file while it runs");
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert!(names_in(&dir).is_empty(), "nothing left: {:?}", names_in(&dir));
}

#[tokio::test]
async fn a_download_names_its_path_as_a_query_and_stays_on_the_file_route() {
    let dashboard = signed_in().await;
    let dir = scratch("download-path");
    // A path that would read as more query, or another route, if it weren't encoded.
    let err = dashboard.download("/srv/data.bin&path=/srv/.env", &dir.join("x"), |_, _| {}).await.err().unwrap();
    assert!(matches!(&err, TransportError::Unexpected { status: 404, .. }), "{err:?}");
}

#[tokio::test]
async fn a_download_never_takes_over_a_file_already_named_like_its_part_file() {
    let dashboard = signed_in().await;
    let dir = scratch("download-collide");
    let dest = dir.join("data.bin");
    // Every part name the next downloads could pick in this process is taken by someone else's file.
    let pid = std::process::id();
    for n in 0..64 {
        std::fs::write(dir.join(format!(".data.bin.{pid}-{n}.part")), "not ours").unwrap();
    }
    dashboard.download("/srv/data.bin", &dest, |_, _| {}).await.expect("a free name was found");
    assert_eq!(std::fs::metadata(&dest).unwrap().len(), 300_000);
    for n in 0..64 {
        assert_eq!(std::fs::read_to_string(dir.join(format!(".data.bin.{pid}-{n}.part"))).unwrap(), "not ours", "{n}");
    }
}

/// `POST /api/fs/write-text?profile=`, as `hermes_cli/web_routers/files.py` takes it at `bf0203a`: a JSON
/// `{path, content}`. It answers with what it got, as Hermes answers `{ok, path, byteSize}`.
async fn fs_write_text(State(writes): State<Arc<Mutex<Vec<String>>>>, headers: HeaderMap, RawQuery(query): RawQuery, Json(body): Json<Value>) -> Response {
    let path = body["path"].as_str().unwrap_or_default().to_owned();
    writes.lock().unwrap().push(path.clone());
    if path == "/srv/readonly.md" {
        return (StatusCode::FORBIDDEN, Json(json!({"detail": "File is not writable"}))).into_response();
    }
    let content = body["content"].as_str().unwrap_or_default();
    Json(json!({"ok": true, "path": path, "byteSize": content.len(), "content": content, "query": query, "cookie": cookie(&headers)})).into_response()
}

async fn fs_write_stub() -> (Dashboard, Arc<Mutex<Vec<String>>>) {
    let writes = Arc::new(Mutex::new(Vec::new()));
    let app = Router::new().route("/auth/password-login", post(login)).route("/api/fs/write-text", post(fs_write_text)).with_state(writes.clone());
    let dashboard = sign_in_at(&serve(app).await, &sign_in("hunter2")).await.unwrap();
    (dashboard, writes)
}

#[tokio::test]
async fn writes_an_artifacts_text_where_the_profiles_tools_run() {
    let (dashboard, writes) = fs_write_stub().await;
    let text = "# Plan\r\n\u{feff}naïve ✓ 🚀\n";
    let got: Value = serde_json::from_str(&dashboard.write_agent_text("work two", "/srv/out/plan.md", text, None).await.expect("written")).unwrap();
    assert_eq!(got["path"], "/srv/out/plan.md");
    assert_eq!(got["content"], text, "the text goes exactly as given");
    assert_eq!(got["byteSize"], text.len());
    assert_eq!(got["query"], "profile=work+two");
    assert_eq!(got["cookie"], "hermes_session_at=AT; hermes_session_rt=RT");
    assert_eq!(*writes.lock().unwrap(), vec!["/srv/out/plan.md".to_owned()]);
    // A path under the home folder is the tools' own form too.
    dashboard.write_agent_text("default", "~/notes/todo.txt", "x", None).await.expect("a home path is sent");
}

#[tokio::test]
async fn an_artifact_write_refuses_credential_files_odd_paths_and_too_much_text() {
    let (dashboard, writes) = fs_write_stub().await;
    for path in ["/srv/.env", "/home/me/.hermes/auth.json", "/srv/mcp-tokens/x.json", "relative.md", "/srv/a/../b.md", "/srv/dir/", "/srv/a\0b"] {
        let err = dashboard.write_agent_text("default", path, "x", None).await.err().unwrap();
        assert!(matches!(err, TransportError::NotRelayed(_)), "{path}: {err:?}");
    }
    let big = "x".repeat(transport::AGENT_TEXT_MAX_BYTES as usize + 1);
    let err = dashboard.write_agent_text("default", "/srv/big.md", &big, None).await.err().unwrap();
    assert!(matches!(err, TransportError::FileTooLarge { .. }), "{err:?}");
    assert!(writes.lock().unwrap().is_empty(), "nothing reached the server");
    let err = dashboard.write_agent_text("default", "/srv/readonly.md", "x", None).await.err().unwrap();
    assert!(matches!(&err, TransportError::Unexpected { status: 403, body } if body.contains("not writable")), "{err:?}");
}

#[tokio::test]
async fn the_generic_relay_still_refuses_writes_to_the_agent_fs_routes() {
    let (dashboard, writes) = fs_write_stub().await;
    for path in ["api/fs/write-text", "api/./fs/write-text", "api/%66s/write-text"] {
        let err = dashboard.request("POST", path, Some(r#"{"path":"/srv/x.md","content":"x"}"#.into())).await.err().unwrap();
        assert!(matches!(err, TransportError::NotRelayed(_)), "{path}: {err:?}");
    }
    assert!(writes.lock().unwrap().is_empty());
}

/// A stub dashboard with only sign-in and the upload route, and the server paths it was sent.
async fn upload_stub() -> (Dashboard, Arc<Mutex<Vec<String>>>) {
    let uploads = Arc::new(Mutex::new(Vec::new()));
    let app = Router::new().route("/auth/password-login", post(login)).route("/api/files/upload-stream", post(upload_stream)).with_state(uploads.clone());
    let dashboard = sign_in_at(&serve(app).await, &sign_in("hunter2")).await.unwrap();
    (dashboard, uploads)
}

#[tokio::test]
async fn uploads_a_local_file_as_hermes_takes_it_and_reports_progress() {
    let (dashboard, _) = upload_stub().await;
    let dir = scratch("upload-ok");
    let local = dir.join("report.pdf");
    let bytes: Vec<u8> = (0..700_000u32).map(|i| (i % 253) as u8).collect();
    std::fs::write(&local, &bytes).unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let s = seen.clone();
    let got = dashboard
        .upload("/srv/in/report.pdf", transport::UploadSource::File(local.clone()), false, move |done, total| s.lock().unwrap().push((done, total)))
        .await
        .expect("uploaded");
    let got: Value = serde_json::from_str(&got).unwrap();
    assert_eq!(got["path"], "/srv/in/report.pdf");
    assert_eq!(got["overwrite"], "false");
    assert_eq!(got["file_name"], "report.pdf");
    assert_eq!(got["size"], 700_000);
    assert_eq!(got["sum"], bytes.iter().map(|&b| b as u64).sum::<u64>());
    assert_eq!(got["cookie"], "hermes_session_at=AT; hermes_session_rt=RT");
    let seen = seen.lock().unwrap();
    assert_eq!(seen.first(), Some(&(0, Some(700_000))));
    assert_eq!(seen.last(), Some(&(700_000, Some(700_000))));
}

#[tokio::test]
async fn an_upload_that_would_replace_a_file_is_refused_unless_asked() {
    let (dashboard, _) = upload_stub().await;
    let local = scratch("upload-taken").join("taken.txt");
    std::fs::write(&local, "new").unwrap();
    let err = dashboard.upload("/srv/taken.txt", transport::UploadSource::File(local.clone()), false, |_, _| {}).await.err().unwrap();
    assert!(matches!(&err, TransportError::Unexpected { status: 409, body } if body.contains("already exists")), "{err:?}");
    let got: Value =
        serde_json::from_str(&dashboard.upload("/srv/taken.txt", transport::UploadSource::File(local.clone()), true, |_, _| {}).await.unwrap()).unwrap();
    assert_eq!(got["overwrite"], "true");
}

#[tokio::test]
async fn never_uploads_to_a_credential_file_or_more_than_hermes_takes() {
    let (dashboard, uploads) = upload_stub().await;
    let dir = scratch("upload-refused");
    let local = dir.join("x");
    std::fs::write(&local, "SECRET=1").unwrap();
    for path in [
        "/srv/.env",
        "/srv/.ENV",
        "/srv/.env.local",
        "/srv/.envrc",
        "/srv/Auth.JSON",
        "/home/u/.hermes/config.yaml",
        "/srv/mcp-tokens/a.json",
        "/srv/Pairing/x",
        "/srv/.git-credentials",
        "/srv/",
        "/srv/..",
    ] {
        let err = dashboard.upload(path, transport::UploadSource::File(local.clone()), true, |_, _| {}).await.err().unwrap();
        assert!(matches!(err, TransportError::NotRelayed(_)), "{path}: {err:?}");
    }
    let big = dir.join("big");
    std::fs::File::create(&big).unwrap().set_len(transport::MANAGED_FILE_MAX_BYTES + 1).unwrap();
    let err = dashboard.upload("/srv/big", transport::UploadSource::File(big.clone()), true, |_, _| {}).await.err().unwrap();
    assert!(matches!(err, TransportError::FileTooLarge { .. }), "{err:?}");
    assert!(uploads.lock().unwrap().is_empty(), "nothing was sent");
    // Names that only look alike go.
    for path in ["/srv/env", "/srv/my.env", "/srv/config.yml", "/srv/pairings/x"] {
        dashboard.upload(path, transport::UploadSource::File(local.clone()), true, |_, _| {}).await.expect(path);
    }
}

#[tokio::test]
async fn saves_an_edits_text_through_the_upload_route() {
    let (dashboard, uploads) = upload_stub().await;
    let text = "caf\u{e9}\r\nline two\r\n".as_bytes().to_vec();
    let got: Value =
        serde_json::from_str(&dashboard.upload("/srv/notes.md", transport::UploadSource::Bytes(text.clone()), true, |_, _| {}).await.unwrap()).unwrap();
    assert_eq!(got["size"], text.len());
    assert_eq!(got["sum"], text.iter().map(|&b| b as u64).sum::<u64>());
    assert_eq!(got["overwrite"], "true");
    let err = dashboard.upload("/srv/.env", transport::UploadSource::Bytes(b"X=1".to_vec()), true, |_, _| {}).await.err().unwrap();
    assert!(matches!(err, TransportError::NotRelayed(_)), "{err:?}");
    assert_eq!(uploads.lock().unwrap().as_slice(), ["/srv/notes.md"]);
}

// ── Routes: same-server check and plain http (ADR 0120) ─────────────────────────────────────────────────────────

/// A dashboard whose `/api/status` names `install`, counting the sign-ins it got.
async fn installed(install: &'static str) -> (Url, Arc<Mutex<u32>>) {
    let logins = Arc::new(Mutex::new(0u32));
    let counted = logins.clone();
    let app = Router::new()
        .route("/auth/password-login", post(login))
        .route("/api/auth/ws-ticket", post(ws_ticket))
        .route("/api/ws", get(api_ws))
        .route(
            "/api/status",
            get(move || async move { Json(json!({"version": "0.22.5", "auth_required": true, "auth_providers": ["basic"], "install_id": install})) }),
        )
        .layer(middleware::from_fn(move |req: Request, next: Next| {
            let counted = counted.clone();
            async move {
                if req.uri().path() == "/auth/password-login" {
                    *counted.lock().unwrap() += 1;
                }
                next.run(req).await
            }
        }));
    (serve(app).await, logins)
}

#[test]
fn a_server_is_told_apart_by_its_hashed_install_id() {
    let id = transport::server_id("install-1");
    assert_eq!(id.len(), 32);
    assert!(!id.contains("install"));
    assert_ne!(id, transport::server_id("install-2"));
    let status = r#"{"version":"0.17.0","install_id":"install-1","auth_required":true}"#;
    assert_eq!(transport::identify(status, None).unwrap(), Some(id.clone()));
    assert_eq!(transport::identify(status, Some(&id)).unwrap(), Some(id.clone()));
    assert!(matches!(transport::identify(status, Some(&transport::server_id("install-2"))), Err(TransportError::WrongServer)));
    // An older Hermes names no install: nothing to tell apart, so it passes.
    assert_eq!(transport::identify(r#"{"version":"0.16.0"}"#, Some(&id)).unwrap(), None);
    // Anything that isn't a Hermes status is the wrong server.
    for other in ["<html>router login</html>", "[]", r#"{"ok":true}"#, r#"{"version":3}"#] {
        assert!(matches!(transport::identify(other, None), Err(TransportError::NotHermes)), "{other}");
    }
}

#[tokio::test]
async fn reading_the_server_needs_no_sign_in_and_names_its_install() {
    let (base, logins) = installed("install-home").await;
    let seen = transport::read_server(&transport::client(&HeaderMap::new()).unwrap(), &base, &HeaderMap::new(), None, Duration::from_secs(5)).await.unwrap();
    assert_eq!(seen.server, Some(transport::server_id("install-home")));
    assert!(seen.status.contains("0.22.5"));
    assert_eq!(*logins.lock().unwrap(), 0);
    let wrong = transport::read_server(
        &transport::client(&HeaderMap::new()).unwrap(),
        &base,
        &HeaderMap::new(),
        Some(&transport::server_id("install-away")),
        Duration::from_secs(5),
    )
    .await;
    assert!(matches!(wrong, Err(TransportError::WrongServer)));
}

#[tokio::test]
async fn a_route_that_reaches_another_server_never_gets_the_password() {
    let (base, logins) = installed("install-neighbour").await;
    let expect = transport::server_id("install-home");
    let failed =
        transport::probe_expecting(&base, &sign_in("hunter2"), "default", Duration::from_secs(5), Duration::from_secs(5), Some(&expect)).await.unwrap_err();
    assert_eq!(failed.stage, Stage::Reach);
    assert!(failed.message.starts_with("Wrong server:"), "{}", failed.message);
    assert_eq!(*logins.lock().unwrap(), 0, "the password went out");

    // The same server passes, and the test says which it was.
    let (home, logins) = installed("install-home").await;
    let probed =
        transport::probe_expecting(&home, &sign_in("hunter2"), "default", Duration::from_secs(5), Duration::from_secs(5), Some(&expect)).await.unwrap();
    assert_eq!(probed.server, Some(expect));
    assert_eq!(*logins.lock().unwrap(), 1);
}

/// A dashboard-like server whose `/api/status` answers `status` (none: no such route, a 404), counting the sign-ins
/// it got.
async fn without_status(status: Option<StatusCode>) -> (Url, Arc<Mutex<u32>>) {
    let logins = Arc::new(Mutex::new(0u32));
    let counted = logins.clone();
    let mut app = Router::new().route("/auth/password-login", post(login)).route("/api/auth/ws-ticket", post(ws_ticket)).route("/api/ws", get(api_ws));
    if let Some(status) = status {
        app = app.route("/api/status", get(move || async move { (status, "upstream trouble") }));
    }
    let app = app.layer(middleware::from_fn(move |req: Request, next: Next| {
        let counted = counted.clone();
        async move {
            if req.uri().path() == "/auth/password-login" {
                *counted.lock().unwrap() += 1;
            }
            next.run(req).await
        }
    }));
    (serve(app).await, logins)
}

#[tokio::test]
async fn a_route_whose_status_is_not_a_hermes_answer_never_gets_the_password() {
    let wait = Duration::from_secs(5);
    let home = transport::server_id("install-home");
    for status in [None, Some(StatusCode::NOT_FOUND), Some(StatusCode::INTERNAL_SERVER_ERROR), Some(StatusCode::BAD_GATEWAY)] {
        let (base, logins) = without_status(status).await;
        for expect in [None, Some(home.as_str())] {
            let opened = transport::open_route(&base, &sign_in("hunter2"), "default", expect, wait, None, &Steps::default(), |_| {}).await;
            assert!(opened.is_err(), "{status:?}, {expect:?}: the route opened");
            let failed = transport::probe_expecting(&base, &sign_in("hunter2"), "default", wait, wait, expect).await.unwrap_err();
            assert_eq!(failed.stage, Stage::Reach, "{status:?}, {expect:?}: {}", failed.message);
            let reached = transport::read_server(&transport::client(&HeaderMap::new()).unwrap(), &base, &HeaderMap::new(), expect, wait).await;
            assert!(reached.is_err(), "{status:?}, {expect:?}: the route counted as reached");
        }
        assert_eq!(*logins.lock().unwrap(), 0, "{status:?}: the password went out");
    }
    // No status at all is the wrong server; a server error keeps its own words, as the dashboard may be failing.
    let (base, _) = without_status(None).await;
    let failed = transport::probe_expecting(&base, &sign_in("hunter2"), "default", wait, wait, None).await.unwrap_err();
    assert!(failed.message.starts_with("Wrong server: something answered"), "{}", failed.message);
    let (base, _) = without_status(Some(StatusCode::BAD_GATEWAY)).await;
    let failed = transport::probe_expecting(&base, &sign_in("hunter2"), "default", wait, wait, None).await.unwrap_err();
    assert_eq!(failed.message, "The dashboard answered 502: upstream trouble");
}

/// `serve`, counting the TCP connections the stub accepts.
async fn serve_counting(app: Router) -> (Url, Arc<std::sync::atomic::AtomicUsize>) {
    use axum::serve::{Listener, ListenerExt};
    let accepted = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let count = accepted.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap().tap_io(move |_| {
        count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    });
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (Url::parse(&format!("http://{addr}/")).unwrap(), accepted)
}

/// Issue #271: a connection test reads the status, signs in and mints the ticket on one HTTP connection, plus the
/// WebSocket.
#[tokio::test]
async fn a_connection_test_opens_one_http_connection_plus_the_socket() {
    let (base, accepted) = serve_counting(stub_routes()).await;
    transport::probe(&base, &sign_in("hunter2"), "default").await.expect("probed");
    assert_eq!(accepted.load(std::sync::atomic::Ordering::SeqCst), 2);
}

#[tokio::test]
async fn something_that_isnt_hermes_never_gets_the_password() {
    let logins = Arc::new(Mutex::new(0u32));
    let counted = logins.clone();
    let app = Router::new().route("/api/status", get(|| async { "<html>Router admin</html>" })).route(
        "/auth/password-login",
        post(move || async move {
            *counted.lock().unwrap() += 1;
            StatusCode::NOT_FOUND
        }),
    );
    let failed = transport::probe(&serve(app).await, &sign_in("hunter2"), "default").await.unwrap_err();
    assert_eq!(failed.stage, Stage::Reach);
    assert!(failed.message.contains("isn't a Hermes dashboard"), "{}", failed.message);
    assert_eq!(*logins.lock().unwrap(), 0);
}

#[test]
fn plain_http_goes_only_to_this_computer_a_lan_or_tailscale() {
    for ip in ["127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.1.10", "169.254.3.4", "::1", "fd7a:115c:a1e0::1", "fc00::5", "fe80::1", "::ffff:192.168.1.10"] {
        assert!(transport::is_local_or_private(ip.parse().unwrap()), "{ip}");
    }
    // 100.64.0.0/10 is carrier-grade NAT as well as Tailscale, so it counts only when Tailscale carries it.
    for ip in [
        "8.8.8.8",
        "100.64.0.1",
        "100.127.255.254",
        "::ffff:100.64.0.1",
        "100.63.255.255",
        "100.128.0.1",
        "172.32.0.1",
        "2001:4860:4860::8888",
        "::ffff:8.8.8.8",
        "0.0.0.0",
    ] {
        assert!(!transport::is_local_or_private(ip.parse().unwrap()), "{ip}");
    }
}

#[test]
fn plain_http_to_100_64_goes_only_over_tailscale() {
    let direct = |url: &str, addresses: &[&str]| transport::DirectUrl {
        base: Url::parse(url).unwrap(),
        addresses: addresses.iter().map(|a| a.parse().unwrap()).collect(),
    };
    let tailnet = |_: IpAddr| Some("100.119.13.105".parse().unwrap());
    let carrier = |_: IpAddr| Some("10.2.1.121".parse().unwrap());
    let both = |ip: IpAddr| Some(if ip.to_string() == "100.100.64.121" { "100.119.13.105" } else { "10.2.1.121" }.parse().unwrap());
    for url in ["http://100.100.64.121:9119/", "http://[::ffff:100.100.64.121]:9119/"] {
        assert!(transport::check_plain_http_from(&direct(url, &[]), tailnet).is_ok(), "{url}");
    }
    assert!(transport::check_plain_http_from(&direct("http://hermes:9119/", &["100.100.64.121", "192.168.1.10"]), both).is_ok());
    assert!(transport::check_plain_http_from(&direct("https://100.100.64.121/", &[]), carrier).is_ok());
    for (url, addresses) in [("http://100.64.0.1:9119/", &[][..]), ("http://hermes:9119/", &["100.100.64.121", "100.64.0.1"][..])] {
        let refused = transport::check_plain_http_from(&direct(url, addresses), both).unwrap_err();
        assert!(matches!(refused, TransportError::PlainHttpNotTailscale(_)), "{url}: {refused:?}");
        let said = refused.to_string();
        assert!(said.starts_with("Plain http:// is only used") && said.contains("over Tailscale"), "{said}");
    }
    // 100.64.0.1 is no tailnet peer, so the routing table sends it out through the LAN's gateway.
    let real = transport::check_plain_http(&direct("http://100.64.0.1:9119/", &[])).unwrap_err();
    assert!(matches!(real, TransportError::PlainHttpNotTailscale(_)), "{real:?}");
    assert!(transport::check_plain_http(&direct("http://127.0.0.1:9119/", &[])).is_ok());
}

#[tokio::test]
async fn a_plain_http_route_to_a_public_address_is_refused() {
    let direct = |url: &str, addresses: &[&str]| transport::DirectUrl {
        base: Url::parse(url).unwrap(),
        addresses: addresses.iter().map(|a| a.parse().unwrap()).collect(),
    };
    assert!(transport::check_plain_http(&direct("http://192.168.1.10:9119/", &[])).is_ok());
    assert!(transport::check_plain_http(&direct("http://[fd7a:115c:a1e0::9]:9119/", &[])).is_ok());
    assert!(transport::check_plain_http(&direct("https://hermes.example.com/", &["203.0.113.7"])).is_ok());
    let refused = transport::check_plain_http(&direct("http://203.0.113.7:9119/", &[])).unwrap_err().to_string();
    assert!(refused.contains("203.0.113.7 is a public address"), "{refused}");
    // A name is local only if everything it resolved to is.
    assert!(transport::check_plain_http(&direct("http://hermes.example.com:9119/", &["192.168.1.10", "203.0.113.7"])).is_err());
    let local = transport::resolve_direct("http://localhost:9119").await.unwrap();
    assert!(transport::check_plain_http(&local).is_ok());
}

// Token sign-in (ADR 0058): a dashboard with the session-token provider, which takes `Authorization: Bearer GOOD`.

/// Every request the token stub got: its path, query, and `Authorization` header.
type Heard = Arc<Mutex<Vec<(String, String, Option<String>)>>>;

async fn hear(State(heard): State<Heard>, req: Request, next: Next) -> Response {
    let auth = header_of(&req, "authorization");
    heard.lock().unwrap().push((req.uri().path().to_owned(), req.uri().query().unwrap_or("").to_owned(), auth));
    next.run(req).await
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers.get(header::AUTHORIZATION)?.to_str().ok()?.strip_prefix("Bearer ")
}

async fn token_me(headers: HeaderMap) -> Response {
    match bearer(&headers) {
        Some("GOOD") => Json(json!({"user_id": "deployment-token", "provider": "session-token", "expires_at": 0})).into_response(),
        Some("BASIC") => Json(json!({"user_id": "liam", "provider": "basic", "expires_at": 0})).into_response(),
        Some("abcd") => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"detail": "abcd"}))).into_response(),
        Some("deadbeef1234") => Json(json!({"user_id": "x", "provider": "deadbeef1234"})).into_response(),
        Some("echo-header") => {
            let echoed = headers.get("x-hermes-chat-token").and_then(|v| v.to_str().ok()).unwrap_or("").to_owned();
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"detail": echoed}))).into_response()
        }
        _ => (StatusCode::UNAUTHORIZED, Json(json!({"detail": "Unauthorized"}))).into_response(),
    }
}

async fn token_ticket(headers: HeaderMap) -> Response {
    if bearer(&headers) == Some("GOOD") {
        Json(json!({"ticket": "TICKET-1", "ttl_seconds": 30})).into_response()
    } else {
        (StatusCode::UNAUTHORIZED, Json(json!({"detail": "Unauthorized"}))).into_response()
    }
}

async fn token_sessions(headers: HeaderMap) -> Response {
    if bearer(&headers) != Some("GOOD") {
        return (StatusCode::UNAUTHORIZED, Json(json!({"detail": "Unauthorized"}))).into_response();
    }
    Json(json!({"sessions": [], "cookie": cookie(&headers)})).into_response()
}

/// The token stub, whose `/api/status` lists `providers`, and what it heard. `/api/away` redirects to `elsewhere`,
/// when given.
async fn token_stub(providers: &[&str], elsewhere: Option<&Url>) -> (Url, Heard) {
    let heard = Heard::default();
    let status = json!({"version": "0.22.7", "auth_required": true, "auth_providers": providers, "auth_flows": ["cookie"]});
    let mut app = Router::new()
        .route("/api/status", get(move || async move { Json(status) }))
        .route("/api/auth/me", get(token_me))
        .route("/api/auth/ws-ticket", post(token_ticket))
        .route("/api/ws", get(api_ws))
        .route("/api/sessions", get(token_sessions))
        .route("/auth/password-login", post(login));
    if let Some(away) = elsewhere {
        let away = away.join("steal").unwrap().to_string();
        app = app.route("/api/away", get(move || async move { Redirect::temporary(&away) }));
    }
    (serve(app.layer(middleware::from_fn_with_state(heard.clone(), hear))).await, heard)
}

fn token(t: &str) -> SignIn {
    SignIn { credential: Credential::Token(t.into()), headers: Default::default() }
}

#[tokio::test]
async fn a_token_signs_in_as_a_bearer_and_opens_the_socket_with_a_ticket_only() {
    let (base, heard) = token_stub(&["session-token"], None).await;
    let dashboard = sign_in_at(&base, &token("GOOD")).await.expect("signed in");
    let got = get_json(&dashboard, "api/sessions").await;
    assert_eq!(got["cookie"], "");
    let (tx, mut rx) = mpsc::unbounded_channel();
    let _pipe = dashboard
        .open_pipe("default", move |e| {
            let _ = tx.send(e);
        })
        .await
        .expect("pipe open");
    assert_eq!(frame(next(&mut rx).await)["params"]["type"], "gateway.ready");
    let heard = heard.lock().unwrap().clone();
    let by_path = |p: &str| heard.iter().find(|(path, ..)| path == p).cloned().unwrap_or_else(|| panic!("no {p} in {heard:?}"));
    assert_eq!(by_path("/api/auth/me").2.as_deref(), Some("Bearer GOOD"));
    assert_eq!(by_path("/api/sessions").2.as_deref(), Some("Bearer GOOD"));
    assert_eq!(by_path("/api/auth/ws-ticket").2.as_deref(), Some("Bearer GOOD"));
    let (_, query, auth) = by_path("/api/ws");
    assert_eq!(query, "ticket=TICKET-1&profile=default");
    assert_eq!(auth, None, "the socket is let in by its ticket alone");
    assert!(heard.iter().all(|(_, q, _)| !q.contains("GOOD")), "the token never goes in a URL: {heard:?}");
}

#[tokio::test]
async fn a_wrong_token_is_turned_down_and_a_token_for_another_provider_too() {
    let (base, _) = token_stub(&["session-token"], None).await;
    let err = sign_in_at(&base, &token("WRONG")).await.err().unwrap();
    assert!(matches!(err, TransportError::BadToken), "{err:?}");
    assert!(err.to_string().starts_with("Wrong token"), "{err}");
    let err = sign_in_at(&base, &token("BASIC")).await.err().unwrap();
    assert!(matches!(&err, TransportError::NotSessionToken(p) if p == "basic"), "{err:?}");
    // Nothing the server echoes of the token is shown, however short, not even as the provider's name.
    let err = sign_in_at(&base, &token("abcd")).await.err().unwrap().to_string();
    assert!(err.starts_with("The dashboard answered 500") && !err.contains("abcd"), "{err}");
    let err = sign_in_at(&base, &token("deadbeef1234")).await.err().unwrap().to_string();
    assert!(err.contains("as a different sign-in") && !err.contains("deadbeef"), "{err}");
    // An extra header that happens to share the name the token is hidden under keeps its own value hidden.
    let headers = transport::extra_headers(&[header("X-Hermes-Chat-Token", "gateway-secret-value")]).unwrap();
    let err = sign_in_at(&base, &SignIn { credential: Credential::Token("echo-header".into()), headers }).await.err().unwrap().to_string();
    assert!(err.starts_with("The dashboard answered 500") && !err.contains("gateway-secret"), "{err}");
    for bad in ["", "  ", "two words", "line\nbreak"] {
        assert!(matches!(sign_in_at(&base, &token(bad)).await.err().unwrap(), TransportError::BadToken), "{bad:?}");
    }
}

#[tokio::test]
async fn a_token_isnt_sent_when_extra_headers_set_authorization() {
    let (base, heard) = token_stub(&["session-token"], None).await;
    let headers = transport::extra_headers(&[header("Authorization", "Basic Z2F0ZXdheQ==")]).unwrap();
    let err = sign_in_at(&base, &SignIn { credential: Credential::Token("GOOD".into()), headers }).await.err().unwrap();
    assert!(matches!(err, TransportError::AuthorizationHeaderSet), "{err:?}");
    assert!(err.to_string().contains("Authorization"), "{err}");
    assert!(heard.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_token_goes_only_to_a_server_that_lists_the_session_token_provider() {
    let (base, heard) = token_stub(&["basic"], None).await;
    let failed = transport::probe_with(&base, &token("GOOD"), "default", Duration::from_secs(5)).await.unwrap_err();
    assert_eq!(failed.stage, Stage::SignIn);
    assert!(failed.message.starts_with("This Hermes server doesn't take a token"), "{}", failed.message);
    assert!(heard.lock().unwrap().iter().all(|(_, _, auth)| auth.is_none()), "{:?}", heard.lock().unwrap());
    assert!(transport::offered(&token("GOOD"), None).is_ok(), "an unread status doesn't stop it; /api/auth/me checks the token");
    assert!(transport::offered(&sign_in("hunter2"), Some(r#"{"auth_providers":["session-token"]}"#)).is_ok());

    let (base, _) = token_stub(&["basic", "session-token"], None).await;
    let probed = transport::probe_with(&base, &token("GOOD"), "default", Duration::from_secs(5)).await.expect("probed");
    assert!(probed.ready.contains("gateway.ready"));
}

#[tokio::test]
async fn a_token_never_follows_a_redirect_to_another_site() {
    let (elsewhere, seen) = other_site().await;
    let (base, _) = token_stub(&["session-token"], Some(&elsewhere)).await;
    let dashboard = sign_in_at(&base, &token("GOOD")).await.expect("signed in");
    let err = dashboard.request("GET", "api/away", None).await.unwrap_err();
    assert!(err.to_string().contains("another site"), "{err}");
    assert!(seen.lock().unwrap().is_empty(), "{:?}", seen.lock().unwrap());
}

#[tokio::test]
async fn a_password_goes_to_the_provider_hermes_listed() {
    let logins = Arc::new(Mutex::new(Vec::<Value>::new()));
    let kept = logins.clone();
    let app = Router::new().route(
        "/auth/password-login",
        post(move |Json(body): Json<Value>| {
            let kept = kept.clone();
            async move {
                kept.lock().unwrap().push(body);
                Json(json!({"ok": true}))
            }
        }),
    );
    let base = serve(app).await;
    let with = |provider: &str| SignIn {
        credential: Credential::Password { provider: provider.into(), username: "liam".into(), password: "hunter2".into() },
        headers: Default::default(),
    };
    sign_in_at(&base, &with("team-sso")).await.expect("signed in");
    sign_in_at(&base, &with("../evil")).await.expect("signed in");
    let providers: Vec<Value> = logins.lock().unwrap().iter().map(|b| b["provider"].clone()).collect();
    assert_eq!(providers, vec![json!("team-sso"), json!("basic")]);
}

#[test]
fn the_methods_are_what_the_server_lists_and_supports() {
    use transport::{sign_in_methods as methods, MethodsNote, SignInMethod};
    let password = |p: &str, l: &str| SignInMethod::Password { provider: p.into(), label: l.into() };
    let owners = r#"{"version":"0.21.5","auth_required":true,"auth_providers":["basic","conduit-local-live"],"auth_flows":["cookie","native_pkce"]}"#;
    let listed = r#"{"providers":[{"name":"basic","display_name":"Username & password","supports_password":true},{"name":"conduit-local-live","display_name":"Conduit","supports_password":false}]}"#;
    let got = methods(Some(owners), Some(listed));
    assert_eq!((got.methods, got.note), (vec![password("basic", "Username & password")], None));
    let got = methods(Some(owners), None);
    assert_eq!((got.methods, got.note), (vec![password("basic", "Password")], None));

    let token_only = r#"{"auth_required":true,"auth_providers":["session-token"],"auth_flows":["cookie"]}"#;
    let got = methods(Some(token_only), None);
    assert_eq!((got.methods, got.note), (vec![SignInMethod::Token], None));
    let got = methods(Some(token_only), Some(r#"{"providers":[]}"#));
    assert_eq!(got.methods, vec![SignInMethod::Token]);

    let both = r#"{"auth_required":true,"auth_providers":["basic","session-token","drain-secret"],"auth_flows":["cookie","native_pkce"]}"#;
    let two = r#"{"providers":[{"name":"basic","display_name":"Basic","supports_password":true},{"name":"ldap","display_name":"Company login","supports_password":true},{"name":"bad name","supports_password":true},{"name":"self-hosted","display_name":"OIDC","supports_password":false}]}"#;
    let got = methods(Some(both), Some(two));
    assert_eq!(got.methods, vec![password("basic", "Basic"), password("ldap", "Company login"), SignInMethod::Token]);

    for unread in [None, Some("<html>"), Some("[]"), Some(r#"{"version":"0.12.0"}"#)] {
        let got = methods(unread, None);
        assert_eq!((got.methods, got.note), (vec![password("basic", "Password")], Some(MethodsNote::Unread)), "{unread:?}");
    }
    let got = methods(Some(r#"{"auth_required":false,"auth_providers":[]}"#), None);
    assert_eq!(got.note, Some(MethodsNote::GateOff));
    let got = methods(Some(r#"{"auth_required":true,"auth_providers":["conduit-local-live","drain-secret"]}"#), None);
    assert_eq!((got.methods, got.note), (vec![password("basic", "Password")], Some(MethodsNote::NoneSupported)));
    assert_eq!(serde_json::to_value(methods(Some(both), Some(two))).unwrap()["methods"][2], json!({"method": "token"}));
}

/// Against a real Hermes dashboard with the session-token provider, when `HERMES_LIVE_TOKEN_DASHBOARD` (its URL) and
/// `HERMES_LIVE_TOKEN` are set; skipped otherwise. A throwaway one: docs/compatibility.md, "Sign-in methods".
#[tokio::test]
async fn live_token_sign_in() {
    let (Ok(url), Ok(secret)) = (std::env::var("HERMES_LIVE_TOKEN_DASHBOARD"), std::env::var("HERMES_LIVE_TOKEN")) else { return };
    let base = Url::parse(&url).unwrap();
    let wait = Duration::from_secs(20);
    let seen = transport::read_server(&transport::client(&HeaderMap::new()).unwrap(), &base, &HeaderMap::new(), None, wait).await.expect("status read");
    let methods = transport::read_methods(&base, &Default::default(), Some(&seen.status), wait).await;
    assert!(methods.methods.contains(&transport::SignInMethod::Token), "{methods:?}");
    let probed = transport::probe_with(&base, &token(&secret), "default", wait).await.expect("the right token signs in");
    assert!(probed.ready.contains("gateway.ready"), "{}", probed.ready);
    let wrong = transport::probe_with(&base, &token(&format!("{secret}-wrong")), "default", wait).await.unwrap_err();
    assert_eq!(wrong.stage, Stage::SignIn);
    assert!(wrong.message.starts_with("Wrong token"), "{}", wrong.message);
    assert!(!wrong.message.contains(&secret));
    let dashboard = sign_in_at(&base, &token(&secret)).await.expect("signed in");
    let me: Value = serde_json::from_str(&dashboard.request("GET", "api/auth/me", None).await.expect("me")).unwrap();
    assert_eq!(me["provider"], "session-token");
    println!("live: {methods:?}; signed in as {}; a wrong token: {}", me["user_id"], wrong.message);
}

// ── one of several routes gives way on a step that stalls (#269, ADR 0120) ──────────────────────────────────

/// Step limits short enough for a test.
const SHORT: StepLimits = StepLimits {
    lookup: Duration::from_millis(300),
    sign_in: Duration::from_millis(300),
    ticket: Duration::from_millis(300),
    socket: Duration::from_millis(300),
};
/// Well past every `SHORT` limit, far short of the whole attempt's 60 s.
const GIVE_UP: Duration = Duration::from_secs(3);

/// Holds a request for `path` for good, as a dashboard that stopped answering midway does.
async fn stall(State(path): State<&'static str>, req: Request, next: Next) -> Response {
    if req.uri().path() == path {
        std::future::pending::<()>().await;
    }
    next.run(req).await
}

/// The stub, whose `/api/status` answers and whose `path` never does.
async fn stalling_at(path: &'static str) -> Url {
    serve(stub_routes().layer(middleware::from_fn_with_state(path, stall))).await
}

type Opened = (Dashboard, transport::Pipe, transport::ServerSeen);

async fn open_route(base: &Url, limits: Option<StepLimits>, on_event: impl Fn(PipeEvent) + Send + 'static) -> Result<Opened, TransportError> {
    open_route_reporting(base, limits, &Steps::default(), on_event).await
}

async fn open_route_reporting(
    base: &Url,
    limits: Option<StepLimits>,
    steps: &Steps,
    on_event: impl Fn(PipeEvent) + Send + 'static,
) -> Result<Opened, TransportError> {
    transport::open_route(base, &sign_in("hunter2"), "default", None, Duration::from_secs(5), limits, steps, on_event).await
}

/// The steps `open_route` said it started at `base`, in order, and whether it opened.
async fn steps_said(base: &Url) -> (Vec<Step>, bool) {
    let said = Arc::new(Mutex::new(Vec::new()));
    let to = said.clone();
    let steps = Steps::reporting(move |s| to.lock().unwrap().push(s.step));
    let opened = tokio::time::timeout(GIVE_UP, open_route_reporting(base, Some(SHORT), &steps, |_| {})).await.expect("gave up in time").is_ok();
    let said = said.lock().unwrap().clone();
    (said, opened)
}

#[tokio::test]
async fn opening_a_route_says_each_step_as_it_starts() {
    // The record of connection attempts (#270) shows how far a route got and how long each step took.
    assert_eq!(steps_said(&stub().await).await, (vec![Step::Status, Step::SignIn, Step::Ticket, Step::WebSocket], true));
    assert_eq!(steps_said(&stalling_at("/api/auth/ws-ticket").await).await, (vec![Step::Status, Step::SignIn, Step::Ticket], false));
}

/// Opens the route at `base` with the `SHORT` limits: its failure, which must come within `GIVE_UP`.
async fn gives_up(base: &Url) -> String {
    match tokio::time::timeout(GIVE_UP, open_route(base, Some(SHORT), |_| {})).await {
        Err(_) => panic!("still waiting after {}s: the step has no limit of its own", GIVE_UP.as_secs()),
        Ok(Ok(_)) => panic!("opened a route that stalls"),
        Ok(Err(e)) => e.to_string(),
    }
}

#[tokio::test]
async fn a_route_whose_name_lookup_stalls_gives_up_within_the_lookup_limit() {
    let never = |_: String, _: u16| std::future::pending::<std::io::Result<Vec<std::net::SocketAddr>>>();
    let looked_up = tokio::time::timeout(GIVE_UP, transport::resolve_direct_using("https://hermes.example.com/", Some(SHORT.lookup), never))
        .await
        .unwrap_or_else(|_| panic!("still looking up after {}s: the lookup has no limit of its own", GIVE_UP.as_secs()));
    let err = looked_up.unwrap_err().to_string();
    assert!(err.starts_with("Can't reach the Hermes dashboard: looking up hermes.example.com didn't finish within"), "{err}");
}

#[tokio::test]
async fn a_route_whose_sign_in_stalls_gives_up_within_the_sign_in_limit() {
    let err = gives_up(&stalling_at("/auth/password-login").await).await;
    assert!(err.starts_with("Can't reach the Hermes dashboard: the sign-in didn't answer within"), "{err}");
}

#[tokio::test]
async fn a_route_whose_ws_ticket_stalls_gives_up_within_the_ticket_limit() {
    let err = gives_up(&stalling_at("/api/auth/ws-ticket").await).await;
    assert!(err.starts_with("Can't reach the Hermes dashboard: the chat connection's ticket didn't answer within"), "{err}");
}

#[tokio::test]
async fn a_route_whose_websocket_stalls_gives_up_within_the_socket_limit() {
    let err = gives_up(&stalling_at("/api/ws").await).await;
    assert!(err.starts_with("The chat connection failed: it didn't open within"), "{err}");
}

#[tokio::test]
async fn the_next_route_is_signed_in_to_within_the_step_limit_of_one_that_stalls() {
    let routes = [stalling_at("/auth/password-login").await, stub().await];
    let (tx, mut rx) = mpsc::unbounded_channel();
    let started = std::time::Instant::now();
    let mut used = None;
    // As routes.ts `routedPipe` does: each route in turn, the first that opens.
    for base in &routes {
        let tx = tx.clone();
        let opening = open_route(base, Some(SHORT), move |e| {
            let _ = tx.send(e);
        });
        match tokio::time::timeout(GIVE_UP, opening).await {
            Err(_) => panic!("{base} held the connection past {}s", GIVE_UP.as_secs()),
            Ok(Err(_)) => continue,
            Ok(Ok(opened)) => {
                used = Some((base.clone(), opened));
                break;
            }
        }
    }
    let (base, _opened) = used.expect("a route opened");
    assert_eq!(base, routes[1]);
    assert!(started.elapsed() < GIVE_UP, "took {:?}", started.elapsed());
    assert_eq!(frame(next(&mut rx).await)["params"]["type"], "gateway.ready");
}

#[tokio::test]
async fn a_connection_with_several_routes_limits_each_step_and_one_with_a_single_route_does_not() {
    let secs = |l: StepLimits| [l.lookup, l.sign_in, l.ticket, l.socket].map(|d| d.as_secs());
    assert_eq!(transport::StepLimits::of(true).map(secs), Some([5, 10, 10, 10]));
    assert_eq!(transport::StepLimits::of(false), None);
    // A single route waits on a slow sign-in as long as the whole attempt allows (ADR 0120).
    let slow = stalling_at("/auth/password-login").await;
    assert!(tokio::time::timeout(Duration::from_secs(1), open_route(&slow, None, |_| {})).await.is_err(), "a single route gave up early");
}

/// FastAPI's 422 for a body that failed validation, which echoes the request it was sent as `input`.
async fn echo_422(Json(body): Json<Value>) -> Response {
    (StatusCode::UNPROCESSABLE_ENTITY, Json(json!({"detail": [{"type": "missing", "loc": ["body", "totp"], "msg": "Field required", "input": body}]})))
        .into_response()
}

#[tokio::test]
async fn a_failed_password_sign_in_never_shows_the_password() {
    let echo_text = |Json(body): Json<Value>| async move { (StatusCode::BAD_GATEWAY, format!("upstream refused {body}")).into_response() };
    // As Python's json.dumps writes it, non-ASCII as \uXXXX, inside a page that isn't JSON.
    let echo_ascii = |Json(body): Json<Value>| async move {
        let ascii: String = body.to_string().chars().map(|c| if c.is_ascii() { c.to_string() } else { format!("\\u{:04x}", c as u32) }).collect();
        (StatusCode::INTERNAL_SERVER_ERROR, format!("<pre>{ascii}</pre>")).into_response()
    };
    let base_422 = serve(Router::new().route("/auth/password-login", post(echo_422))).await;
    let base_text = serve(Router::new().route("/auth/password-login", post(echo_text))).await;
    let base_ascii = serve(Router::new().route("/auth/password-login", post(echo_ascii))).await;
    for (base, status) in [(&base_422, 422), (&base_text, 502), (&base_ascii, 500)] {
        for password in ["hunter2", "pässwörd-ünïcode", "Q", "bell\u{7}"] {
            for headers in [sign_in(password).headers, access_sign_in().headers] {
                let signing_in = SignIn { headers, ..sign_in(password) };
                let err = sign_in_at(base, &signing_in).await.err().unwrap();
                let shown = err.to_string();
                assert!(matches!(&err, TransportError::Unexpected { status: s, .. } if *s == status), "{err:?}");
                assert!(!shown.contains(password), "{password:?} shown: {shown}");
                assert!(shown.contains("(not shown, as it may repeat your password or a request header)"), "{password:?} shown: {shown}");
            }
        }
    }
}

#[tokio::test]
async fn a_failed_password_sign_in_shows_a_body_that_doesnt_repeat_the_password() {
    let gateway = || async { (StatusCode::BAD_GATEWAY, "Bad Gateway: upstream hermes is down").into_response() };
    let disabled = || async { (StatusCode::FORBIDDEN, Json(json!({"detail": "This account is disabled"}))).into_response() };
    for (route, status, said) in [(post(gateway), 502, "upstream hermes is down"), (post(disabled), 403, "This account is disabled")] {
        let base = serve(Router::new().route("/auth/password-login", route)).await;
        let err = sign_in_at(&base, &sign_in("hunter2")).await.err().unwrap();
        assert!(matches!(&err, TransportError::Unexpected { status: s, body } if *s == status && body.contains(said)), "{err:?}");
    }
}
