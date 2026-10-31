pub mod transport;
pub mod tunnel;

use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::Mutex;
use transport::{Pipe, PipeEvent, SignIn};
use tunnel::Tunnel;

/// The owner's `hermes dashboard` port on the server's loopback (research doc, "SSH tunnel, Host header
/// and protocol generation").
const DASHBOARD_PORT: u16 = 9119;

struct Connection {
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
    let pipe = transport::open(&base, &SignIn { username, password }, move |e| {
        let _ = on_event.send(e);
    })
    .await
    .map_err(|e| e.to_string())?;
    *slot = Some(Connection { pipe, _tunnel: tunnel });
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
async fn hermes_disconnect(state: State<'_, AppState>) -> Result<(), String> {
    *state.0.lock().await = None;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![hermes_connect, hermes_send, hermes_disconnect])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
