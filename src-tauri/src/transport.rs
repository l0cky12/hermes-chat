//! Rust half of the Hermes transport: sign in to the dashboard, then move JSON-RPC text frames
//! between `/api/ws` and the webview. The webview speaks the protocol; this side never parses it
//! (ADR 0003). Wire details: docs/research/hermes-gateway-api.md §2 and "Password login and profiles".

use futures_util::{SinkExt, StreamExt};
use reqwest::{header, StatusCode};
use serde::Serialize;
use serde_json::json;
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

/// Sign in at `base` (the dashboard root, e.g. the local end of the SSH tunnel), mint a WS ticket,
/// and open `/api/ws`. Every frame the server sends, starting with `gateway.ready`, goes to `on_event`.
pub async fn open(
    base: &Url,
    sign_in: &SignIn,
    on_event: impl Fn(PipeEvent) + Send + 'static,
) -> Result<Pipe, TransportError> {
    let http = reqwest::Client::new();

    let login = http
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
    // Keep only `name=value` from each Set-Cookie; the session cookies are all the ticket call needs.
    let cookie = login
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok()?.split(';').next())
        .collect::<Vec<_>>()
        .join("; ");

    let ticket = http
        .post(endpoint(base, "api/auth/ws-ticket"))
        .header(header::COOKIE, cookie)
        .send()
        .await
        .map_err(|e| TransportError::Unreachable(e.to_string()))?;
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

    let mut ws_url = endpoint(base, "api/ws");
    ws_url
        .set_scheme(if base.scheme() == "https" { "wss" } else { "ws" })
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
