//! Settings → MCP servers' edit (`Dashboard::mcp_edit`, ADR 0121) and its relay, against a local stub of the
//! dashboard's raw config read, `.env` write and whole-map MCP replace, as `f0d94882` answers them.

use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{AppendHeaders, IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use hermes_chat::mcp::Edit;
use hermes_chat::transport::{Dashboard, ExtraHeader, SignIn, TransportError};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use url::Url;

/// What the stub server keeps, per profile: the raw `mcp_servers` map, the `.env` writes, and what it was asked.
#[derive(Default)]
struct Server {
    servers: HashMap<String, Value>,
    env: Vec<(String, String, String)>,
    puts: Vec<(String, Value)>,
    /// The next whole-map write is refused with a 400 repeating the body, as a careless server might.
    refuse_echoing: bool,
    /// The next whole-map write is refused with a 400 whose detail repeats the gateway's credential header.
    refuse_echoing_header: bool,
    /// The next whole-map write drops `env` from every entry as it saves, so the read back differs.
    drop_env_on_write: bool,
    /// A raw read that wasn't asked for (`include_defaults` missing).
    expanded_reads: usize,
}

type Shared = Arc<Mutex<Server>>;

async fn login(Json(body): Json<Value>) -> Response {
    if body["password"] == "hunter2" {
        (AppendHeaders([(header::SET_COOKIE, "hermes_session_at=AT; Path=/; HttpOnly")]), Json(json!({"ok": true}))).into_response()
    } else {
        StatusCode::UNAUTHORIZED.into_response()
    }
}

fn signed(headers: &HeaderMap) -> bool {
    headers.get(header::COOKIE).and_then(|v| v.to_str().ok()).is_some_and(|c| c.contains("hermes_session_at=AT"))
}

async fn config(State(s): State<Shared>, headers: HeaderMap, Query(q): Query<HashMap<String, String>>) -> Response {
    if !signed(&headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let mut s = s.lock().unwrap();
    let profile = q.get("profile").cloned().unwrap_or_default();
    if q.get("include_defaults").map(String::as_str) != Some("false") {
        // The default read expands `${VAR}`: an edit built on it would write secrets into config.yaml.
        s.expanded_reads += 1;
        return Json(json!({"mcp_servers": {"expanded": {"command": "x", "env": {"K": "expanded-secret"}}}})).into_response();
    }
    match s.servers.get(&profile) {
        Some(servers) => Json(json!({"model": "m", "mcp_servers": servers})).into_response(),
        None => (StatusCode::NOT_FOUND, Json(json!({"detail": format!("Profile '{profile}' does not exist")}))).into_response(),
    }
}

async fn save_env(State(s): State<Shared>, Query(q): Query<HashMap<String, String>>, Json(body): Json<Value>) -> Response {
    let profile = q.get("profile").cloned().unwrap_or_default();
    s.lock().unwrap().env.push((profile, body["key"].as_str().unwrap().to_owned(), body["value"].as_str().unwrap().to_owned()));
    Json(json!({"ok": true})).into_response()
}

async fn replace(State(s): State<Shared>, headers: HeaderMap, Query(q): Query<HashMap<String, String>>, Json(body): Json<Value>) -> Response {
    let mut s = s.lock().unwrap();
    let profile = q.get("profile").cloned().unwrap_or_default();
    s.puts.push((profile.clone(), body.clone()));
    if std::mem::take(&mut s.refuse_echoing_header) {
        let secret = headers.get("cf-access-client-secret").and_then(|v| v.to_str().ok()).unwrap_or_default().to_owned();
        return (StatusCode::BAD_REQUEST, Json(json!({"detail": format!("gateway refused service token {secret}")}))).into_response();
    }
    if std::mem::take(&mut s.refuse_echoing) {
        return (StatusCode::BAD_REQUEST, Json(json!({"detail": format!("rejected: {body}")}))).into_response();
    }
    let mut servers = body["servers"].clone();
    if std::mem::take(&mut s.drop_env_on_write) {
        for cfg in servers.as_object_mut().unwrap().values_mut() {
            cfg.as_object_mut().unwrap().remove("env");
        }
    }
    s.servers.insert(profile, servers);
    Json(json!({"ok": true})).into_response()
}

async fn echo(body: String) -> Response {
    body.into_response()
}

async fn stub() -> (Dashboard, Shared) {
    stub_with(Default::default()).await
}

async fn stub_with(extra: Vec<ExtraHeader>) -> (Dashboard, Shared) {
    let shared: Shared = Default::default();
    shared.lock().unwrap().servers.insert(
        "work".into(),
        json!({
            "fs": {"command": "npx", "args": ["-y", "pkg"], "env": {"API_KEY": "s3cret-value", "REF": "${REF}"}, "enabled": false},
            "web": {"url": "https://old.example/mcp", "headers": {"Authorization": "Bearer ${MCP_WEB_API_KEY}"}},
        }),
    );
    let app = Router::new()
        .route("/auth/password-login", post(login))
        .route("/api/config", get(config))
        .route("/api/env", put(save_env))
        .route("/api/mcp/servers", put(replace).post(echo))
        .route("/api/mcp/servers/{name}/{action}", put(echo).post(echo))
        .route("/api/mcp/catalog/install", post(echo))
        .with_state(shared.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let base = Url::parse(&format!("http://{addr}/")).unwrap();
    let sign_in =
        SignIn { credential: hermes_chat::transport::Credential::password("liam", "hunter2"), headers: hermes_chat::transport::extra_headers(&extra).unwrap() };
    let dashboard = Dashboard::sign_in(hermes_chat::transport::client(&sign_in.headers).unwrap(), &base, &sign_in).await.unwrap();
    (dashboard, shared)
}

fn edit(v: Value) -> Edit {
    serde_json::from_value(v).unwrap()
}

#[tokio::test]
async fn an_edit_changes_one_server_from_the_raw_config_and_reads_it_back() {
    let (dashboard, shared) = stub().await;
    dashboard
        .mcp_edit(
            "work",
            &edit(json!({"name": "fs", "server": {"transport": "stdio", "command": "uvx", "args": ["tool"], "env": [{"key": "API_KEY"}, {"key": "REF"}]}})),
        )
        .await
        .unwrap();
    let s = shared.lock().unwrap();
    assert_eq!(s.expanded_reads, 0);
    assert_eq!(s.puts.len(), 1);
    assert_eq!(s.puts[0].0, "work");
    // The kept secret and the `${REF}` reference go back as Hermes had them; the other server is untouched.
    assert_eq!(
        s.puts[0].1,
        json!({"servers": {
            "fs": {"command": "uvx", "args": ["tool"], "env": {"API_KEY": "s3cret-value", "REF": "${REF}"}, "enabled": false},
            "web": {"url": "https://old.example/mcp", "headers": {"Authorization": "Bearer ${MCP_WEB_API_KEY}"}},
        }})
    );
    assert!(s.env.is_empty());
}

#[tokio::test]
async fn a_new_bearer_token_goes_to_the_profiles_env_before_the_map() {
    let (dashboard, shared) = stub().await;
    dashboard
        .mcp_edit(
            "work",
            &edit(
                json!({"name": "web", "server": {"transport": "http", "url": "https://new.example/mcp", "auth": "header", "bearerToken": "Bearer tok-1234"}}),
            ),
        )
        .await
        .unwrap();
    let s = shared.lock().unwrap();
    assert_eq!(s.env, vec![("work".to_owned(), "MCP_WEB_API_KEY".to_owned(), "tok-1234".to_owned())]);
    assert_eq!(s.servers["work"]["web"], json!({"url": "https://new.example/mcp", "headers": {"Authorization": "Bearer ${MCP_WEB_API_KEY}"}}));
}

#[tokio::test]
async fn a_refusal_that_repeats_the_map_never_shows_a_secret() {
    let (dashboard, shared) = stub().await;
    shared.lock().unwrap().refuse_echoing = true;
    let err = dashboard
        .mcp_edit("work", &edit(json!({"name": "fs", "server": {"transport": "stdio", "command": "npx", "args": [], "env": [{"key": "API_KEY"}]}})))
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("400") && !err.contains("s3cret"), "{err}");
}

#[tokio::test]
async fn a_write_that_reads_back_otherwise_is_not_called_saved() {
    let (dashboard, shared) = stub().await;
    shared.lock().unwrap().drop_env_on_write = true;
    let err = dashboard
        .mcp_edit("work", &edit(json!({"name": "fs", "server": {"transport": "stdio", "command": "npx", "args": [], "env": [{"key": "API_KEY"}]}})))
        .await
        .unwrap_err();
    assert!(matches!(&err, TransportError::McpUnconfirmed(m) if m.contains("reads back otherwise")), "{err:?}");
}

#[tokio::test]
async fn a_token_saved_before_a_refused_map_is_not_called_unchanged() {
    let (dashboard, shared) = stub().await;
    shared.lock().unwrap().refuse_echoing = true;
    let err = dashboard
        .mcp_edit(
            "work",
            &edit(json!({"name": "web", "server": {"transport": "http", "url": "https://old.example/mcp", "auth": "header", "bearerToken": "tok-new-5678"}})),
        )
        .await
        .unwrap_err();
    // The token went to `.env` first, so the server already signs in with it: that's said, never "not changed".
    assert!(matches!(&err, TransportError::McpUnconfirmed(m) if m.contains("saved the new bearer token")), "{err:?}");
    let shown = err.to_string();
    assert!(shown.starts_with("Not confirmed: ") && !shown.contains("tok-new") && !shown.contains("s3cret"), "{shown}");
    assert_eq!(shared.lock().unwrap().env.len(), 1);
}

#[tokio::test]
async fn an_edit_refused_before_sending_writes_nothing() {
    let (dashboard, shared) = stub().await;
    for e in [
        json!({"name": "gone", "server": {"transport": "stdio", "command": "npx", "args": [], "env": []}}),
        json!({"name": "fs", "server": {"transport": "stdio", "command": "npx", "args": [], "env": [{"key": "NEVER_SAVED"}]}}),
        json!({"name": "fs", "newName": "web", "server": {"transport": "stdio", "command": "npx", "args": [], "env": []}}),
    ] {
        let err = dashboard.mcp_edit("work", &edit(e.clone())).await.unwrap_err();
        assert!(matches!(err, TransportError::Mcp(_)), "{e}: {err:?}");
    }
    // Another profile's config is its own: an unknown one is Hermes's 404, and nothing is written.
    let err = dashboard
        .mcp_edit("nobody", &edit(json!({"name": "fs", "server": {"transport": "stdio", "command": "npx", "args": [], "env": []}})))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("404"), "{err}");
    let s = shared.lock().unwrap();
    assert!(s.puts.is_empty() && s.env.is_empty());
}

#[tokio::test]
async fn the_relay_passes_only_the_mcp_writes_the_screen_makes() {
    let (dashboard, shared) = stub().await;
    let ok = [
        ("POST", "api/mcp/servers?profile=work", Some(json!({"name": "new", "command": "npx"}))),
        ("PUT", "api/mcp/servers/fs/enabled?profile=work", Some(json!({"enabled": true}))),
        ("POST", "api/mcp/servers/fs/test?profile=work", None),
        ("POST", "api/mcp/servers/web/auth?profile=work", None),
        ("POST", "api/mcp/catalog/install?profile=work", Some(json!({"name": "linear", "env": {}, "enable": true}))),
    ];
    for (method, path, body) in ok {
        dashboard.request(method, path, body.map(|b| b.to_string())).await.unwrap_or_else(|e| panic!("{method} {path}: {e}"));
    }
    let refused = [
        ("PUT", "api/mcp/servers?profile=work", Some(json!({"servers": {}}))),
        ("POST", "api/mcp/servers?profile=work", Some(json!({"name": "new", "command": "npx", "profile": "other"}))),
        ("PUT", "api/mcp/servers/fs/enabled?profile=work", Some(json!({"enabled": 1}))),
        ("POST", "api/mcp/servers/fs/test?profile=work", Some(json!({}))),
        ("POST", "api/mcp/servers/a%2Fb/test?profile=work", None),
        ("POST", "api/mcp/catalog/install?profile=work", Some(json!({"name": "linear", "env": {"PATH": "/x\n"}}))),
    ];
    for (method, path, body) in refused {
        let err = dashboard.request(method, path, body.map(|b| b.to_string())).await.unwrap_err();
        assert!(matches!(err, TransportError::NotRelayed(_)), "{method} {path}: {err:?}");
    }
    assert!(shared.lock().unwrap().puts.is_empty(), "the whole-map replace went out from the webview");
}

#[tokio::test]
async fn a_refusal_that_repeats_an_extra_request_header_never_shows_it() {
    let (dashboard, shared) = stub_with(vec![ExtraHeader { name: "CF-Access-Client-Secret".into(), value: "gateway-s3cret-value".into() }]).await;
    shared.lock().unwrap().refuse_echoing_header = true;
    let err = dashboard
        .mcp_edit("work", &edit(json!({"name": "fs", "server": {"transport": "stdio", "command": "npx", "args": [], "env": [{"key": "API_KEY"}]}})))
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("400") && !err.contains("gateway-s3cret"), "{err}");
}
