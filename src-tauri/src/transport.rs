//! Rust half of the Hermes transport: sign in to the dashboard, then move JSON-RPC text frames
//! between `/api/ws` and the webview, and relay its dashboard REST calls with the sign-in cookies.
//! The webview speaks the protocol; this side never parses it (ADR 0003). Wire details:
//! docs/research/hermes-gateway-api.md §2, §5 and "Password login and profiles".

use futures_util::{SinkExt, StreamExt};
use reqwest::{header, Method, StatusCode};
use serde::Serialize;
use serde_json::json;
use std::sync::Mutex;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;
use url::Url;

/// The dashboard's username/password provider (`/api/status.auth_providers` on the live server).
const PASSWORD_PROVIDER: &str = "basic";

pub struct SignIn {
    pub username: String,
    pub password: String,
}

#[derive(Debug, thiserror::Error)]
pub enum TransportError {
    #[error("Can't reach the Hermes dashboard: {0}")]
    Unreachable(String),
    #[error("Wrong username or password.")]
    BadCredentials,
    #[error("Too many sign-in attempts. Wait a minute and try again.")]
    RateLimited,
    #[error("The dashboard answered {status}: {body}")]
    Unexpected { status: u16, body: String },
    #[error("The chat connection failed: {0}")]
    WebSocket(String),
    #[error("The chat connection is closed.")]
    Closed,
    #[error("The dashboard sign-in has expired. Sign in again.")]
    SignedOut,
    #[error("Hermes Chat doesn't relay {0}.")]
    NotRelayed(String),
}

/// What the pipe reports to the webview. One `Frame` per JSON-RPC message.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PipeEvent {
    Frame { text: String },
    Closed { reason: String },
}

/// An open `/api/ws` connection. Dropping it closes the socket.
pub struct Pipe {
    outgoing: mpsc::UnboundedSender<String>,
    task: JoinHandle<()>,
}

impl Pipe {
    pub fn send(&self, text: String) -> Result<(), TransportError> {
        self.outgoing.send(text).map_err(|_| TransportError::Closed)
    }
}

impl Drop for Pipe {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// A signed-in dashboard session. It keeps the session cookies up to date: the dashboard rotates an
/// expired access token through the refresh cookie on any request and sends the new ones back.
pub struct Dashboard {
    http: reqwest::Client,
    base: Url,
    cookies: Mutex<Vec<(String, String)>>,
}

impl Dashboard {
    /// Sign in at `base`, the dashboard root (e.g. the local end of the SSH tunnel).
    pub async fn sign_in(base: &Url, sign_in: &SignIn) -> Result<Dashboard, TransportError> {
        let dashboard = Dashboard { http: reqwest::Client::new(), base: base.clone(), cookies: Mutex::default() };
        let login = dashboard
            .http
            .post(endpoint(base, "auth/password-login"))
            .json(&json!({
                "provider": PASSWORD_PROVIDER,
                "username": sign_in.username,
                "password": sign_in.password,
            }))
            .send()
            .await
            .map_err(|e| TransportError::Unreachable(e.to_string()))?;
        match login.status() {
            s if s.is_success() => {}
            StatusCode::UNAUTHORIZED => return Err(TransportError::BadCredentials),
            StatusCode::TOO_MANY_REQUESTS => return Err(TransportError::RateLimited),
            _ => return Err(unexpected(login).await),
        }
        dashboard.keep_cookies(&login);
        Ok(dashboard)
    }

    /// Mint a WS ticket and open `/api/ws`. Every frame the server sends, starting with
    /// `gateway.ready`, goes to `on_event`.
    pub async fn open_pipe(&self, on_event: impl Fn(PipeEvent) + Send + 'static) -> Result<Pipe, TransportError> {
        let ticket = self
            .http
            .post(endpoint(&self.base, "api/auth/ws-ticket"))
            .header(header::COOKIE, self.cookie_header())
            .send()
            .await
            .map_err(|e| TransportError::Unreachable(e.to_string()))?;
        self.keep_cookies(&ticket);
        if !ticket.status().is_success() {
            return Err(unexpected(ticket).await);
        }
        let ticket: serde_json::Value = ticket
            .json()
            .await
            .map_err(|e| TransportError::Unreachable(e.to_string()))?;
        let ticket = ticket["ticket"].as_str().ok_or_else(|| TransportError::Unexpected {
            status: 200,
            body: "ws-ticket response has no ticket".into(),
        })?;

        let mut ws_url = endpoint(&self.base, "api/ws");
        ws_url
            .set_scheme(if self.base.scheme() == "https" { "wss" } else { "ws" })
            .expect("http(s) URLs map to ws(s)");
        ws_url.query_pairs_mut().append_pair("ticket", ticket);
        let (ws, _) = tokio_tungstenite::connect_async(ws_url.as_str())
            .await
            .map_err(|e| TransportError::WebSocket(e.to_string()))?;

        let (outgoing, mut to_server) = mpsc::unbounded_channel::<String>();
        let task = tokio::spawn(async move {
            let (mut sink, mut stream) = ws.split();
            let reason = loop {
                tokio::select! {
                    out = to_server.recv() => match out {
                        Some(text) => {
                            if let Err(e) = sink.send(Message::text(text)).await {
                                break e.to_string();
                            }
                        }
                        None => {
                            let _ = sink.close().await;
                            break "closed by the app".into();
                        }
                    },
                    msg = stream.next() => match msg {
                        // The server writes newline-delimited JSON-RPC; one WS message may carry several.
                        Some(Ok(Message::Text(text))) => {
                            for line in text.lines().filter(|l| !l.trim().is_empty()) {
                                on_event(PipeEvent::Frame { text: line.to_owned() });
                            }
                        }
                        Some(Ok(Message::Close(frame))) => {
                            break frame.map_or("closed by the server".into(), |f| format!("closed by the server ({} {})", f.code, f.reason));
                        }
                        Some(Ok(_)) => {}
                        Some(Err(e)) => break e.to_string(),
                        None => break "closed by the server".into(),
                    },
                }
            };
            on_event(PipeEvent::Closed { reason });
        });

        Ok(Pipe { outgoing, task })
    }

    /// One dashboard REST call for the webview: `GET` or `PATCH` on a path under `api/`, with a JSON
    /// body. Returns the response body on 2xx.
    pub async fn request(&self, method: &str, path_and_query: &str, body: Option<String>) -> Result<String, TransportError> {
        let method = match method {
            "GET" => Method::GET,
            "PATCH" => Method::PATCH,
            other => return Err(TransportError::NotRelayed(format!("{other} requests"))),
        };
        let (path, query) = path_and_query.split_once('?').unwrap_or((path_and_query, ""));
        if !path.starts_with("api/") || path.split('/').any(|seg| seg == "..") {
            return Err(TransportError::NotRelayed(path.to_owned()));
        }
        let mut url = endpoint(&self.base, path);
        url.set_query(Some(query).filter(|q| !q.is_empty()));
        let mut req = self.http.request(method, url).header(header::COOKIE, self.cookie_header());
        if let Some(body) = body {
            req = req.header(header::CONTENT_TYPE, "application/json").body(body);
        }
        let resp = req.send().await.map_err(|e| TransportError::Unreachable(e.to_string()))?;
        self.keep_cookies(&resp);
        match resp.status() {
            s if s.is_success() => resp.text().await.map_err(|e| TransportError::Unreachable(e.to_string())),
            StatusCode::UNAUTHORIZED => Err(TransportError::SignedOut),
            _ => Err(unexpected(resp).await),
        }
    }

    /// Take in every Set-Cookie: a new value replaces the old one, an empty one deletes it. Only
    /// `name=value` is kept; the dashboard is the only site this jar talks to.
    fn keep_cookies(&self, resp: &reqwest::Response) {
        let mut jar = self.cookies.lock().unwrap();
        for v in resp.headers().get_all(header::SET_COOKIE) {
            let Some((name, value)) = v.to_str().ok().and_then(|v| v.split(';').next()?.split_once('=')) else {
                continue;
            };
            let (name, value) = (name.trim(), value.trim());
            jar.retain(|(n, _)| n != name);
            if !value.is_empty() {
                jar.push((name.to_owned(), value.to_owned()));
            }
        }
    }

    fn cookie_header(&self) -> String {
        let jar = self.cookies.lock().unwrap();
        jar.iter().map(|(n, v)| format!("{n}={v}")).collect::<Vec<_>>().join("; ")
    }
}

fn endpoint(base: &Url, path: &str) -> Url {
    let mut url = base.clone();
    let prefix = url.path().trim_end_matches('/').to_owned();
    url.set_path(&format!("{prefix}/{path}"));
    url
}

async fn unexpected(resp: reqwest::Response) -> TransportError {
    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default().chars().take(300).collect();
    TransportError::Unexpected { status, body }
}
