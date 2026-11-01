pub mod transport;
pub mod tunnel;

use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::Mutex;
use transport::{Dashboard, Pipe, PipeEvent, SignIn};
use tunnel::Tunnel;

/// The owner's `hermes dashboard` port on the server's loopback (research doc, "SSH tunnel, Host header
/// and protocol generation").
const DASHBOARD_PORT: u16 = 9119;

struct Connection {
    dashboard: Arc<Dashboard>,
    pipe: Pipe,
    _tunnel: Tunnel,
}

#[derive(Default)]
struct AppState(Mutex<Option<Connection>>);

#[tauri::command]
async fn hermes_connect(
    state: State<'_, AppState>,
    ssh_target: String,
    username: String,
    password: String,
    on_event: Channel<PipeEvent>,
) -> Result<(), String> {
    let mut slot = state.0.lock().await;
    *slot = None;
    let tunnel = tunnel::open(&ssh_target, DASHBOARD_PORT).await.map_err(|e| e.to_string())?;
    let base = url::Url::parse(&format!("http://127.0.0.1:{}/", tunnel.local_port)).expect("valid URL");
    let dashboard = Dashboard::sign_in(&base, &SignIn { username, password }).await.map_err(|e| e.to_string())?;
    let pipe = dashboard
        .open_pipe(move |e| {
            let _ = on_event.send(e);
        })
        .await
        .map_err(|e| e.to_string())?;
    *slot = Some(Connection { dashboard: Arc::new(dashboard), pipe, _tunnel: tunnel });
    Ok(())
}

#[tauri::command]
async fn hermes_send(state: State<'_, AppState>, frame: String) -> Result<(), String> {
    match &*state.0.lock().await {
        Some(conn) => conn.pipe.send(frame).map_err(|e| e.to_string()),
        None => Err(transport::TransportError::Closed.to_string()),
    }
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
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![hermes_connect, hermes_send, hermes_request, hermes_disconnect])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
