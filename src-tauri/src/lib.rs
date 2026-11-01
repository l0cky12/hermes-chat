pub mod transport;
pub mod tunnel;

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::Mutex;
use transport::{Dashboard, LocalFile, Pipe, PipeEvent, SignIn};
use tunnel::Tunnel;

/// The owner's `hermes dashboard` port on the server's loopback (research doc, "SSH tunnel, Host header
/// and protocol generation").
const DASHBOARD_PORT: u16 = 9119;

struct Connection {
    dashboard: Arc<Dashboard>,
    pipe: Arc<Pipe>,
    _tunnel: Option<Tunnel>,
}

/// Where the owner signs in: through an SSH tunnel (ADR 0003), or straight to a dashboard URL.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Target {
    Ssh { target: String },
    Url { url: String },
}

/// How the connection reached the dashboard, for the webview to show and to decide whether it is Unsecure.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Route {
    Ssh { target: String },
    Url { url: String, addresses: Vec<String> },
}

#[derive(Default)]
struct AppState(Mutex<Option<Connection>>);

#[tauri::command]
async fn hermes_connect(
    state: State<'_, AppState>,
    target: Target,
    username: String,
    password: String,
    on_event: Channel<PipeEvent>,
) -> Result<Route, String> {
    let mut slot = state.0.lock().await;
    *slot = None;
    let (base, tunnel, route) = match target {
        Target::Ssh { target } => {
            let tunnel = tunnel::open(&target, DASHBOARD_PORT).await.map_err(|e| e.to_string())?;
            let base = url::Url::parse(&format!("http://127.0.0.1:{}/", tunnel.local_port)).expect("valid URL");
            (base, Some(tunnel), Route::Ssh { target: target.trim().to_owned() })
        }
        Target::Url { url } => {
            let direct = transport::resolve_direct(&url).await.map_err(|e| e.to_string())?;
            let addresses = direct.addresses.iter().map(ToString::to_string).collect();
            (direct.base, None, Route::Url { url: url.trim().to_owned(), addresses })
        }
    };
    let dashboard = Dashboard::sign_in(&base, &SignIn { username, password }).await.map_err(|e| e.to_string())?;
    let pipe = dashboard
        .open_pipe(move |e| {
            let _ = on_event.send(e);
        })
        .await
        .map_err(|e| e.to_string())?;
    *slot = Some(Connection { dashboard: Arc::new(dashboard), pipe: Arc::new(pipe), _tunnel: tunnel });
    Ok(route)
}

#[tauri::command]
async fn hermes_send(state: State<'_, AppState>, frame: String) -> Result<(), String> {
    match &*state.0.lock().await {
        Some(conn) => conn.pipe.send(frame).map_err(|e| e.to_string()),
        None => Err(transport::TransportError::Closed.to_string()),
    }
}

#[tauri::command]
async fn hermes_send_file(
    state: State<'_, AppState>,
    head: String,
    path: String,
    tail: String,
    max_bytes: u64,
) -> Result<(), String> {
    // Reading a big file takes a while; don't hold the lock, so a Stop can still go out.
    let pipe = match &*state.0.lock().await {
        Some(conn) => conn.pipe.clone(),
        None => return Err(transport::TransportError::Closed.to_string()),
    };
    pipe.send_file(&head, &path, &tail, max_bytes).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn hermes_stat_files(paths: Vec<String>) -> Vec<LocalFile> {
    transport::stat_files(&paths).await
}

#[tauri::command]
async fn hermes_request(
    state: State<'_, AppState>,
    method: String,
    path: String,
    body: Option<String>,
) -> Result<String, String> {
    // Don't hold the lock across the request, so frames keep flowing while it runs.
    let dashboard = match &*state.0.lock().await {
        Some(conn) => conn.dashboard.clone(),
        None => return Err(transport::TransportError::Closed.to_string()),
    };
    dashboard.request(&method, &path, body).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn hermes_disconnect(state: State<'_, AppState>) -> Result<(), String> {
    *state.0.lock().await = None;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            hermes_connect,
            hermes_send,
            hermes_send_file,
            hermes_stat_files,
            hermes_request,
            hermes_disconnect
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
