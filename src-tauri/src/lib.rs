pub mod backup;
#[cfg(target_os = "linux")]
pub mod browser;
pub mod connect_steps;
pub mod connection_attempts;
pub mod defaults_file;
pub mod display;
pub mod fonts;
pub mod links;
pub mod local_stt;
pub mod main_window;
pub mod mcp;
pub mod media;
pub mod notify;
pub mod page_view;
pub mod remote;
pub mod repo_git;
pub mod saved_password;
pub mod screenshot;
pub mod server_page;
pub mod summon;
pub mod terminal;
pub mod transport;
pub mod tray;
pub mod tunnel;
pub mod update;
pub mod web_page;

use connect_steps::{Step, Steps};
use saved_password::{Address, TokenEntry};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::ipc::{Channel, InvokeBody};
use tauri::webview::{PermissionKind, PermissionResponse};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::Mutex;
use transport::{Attachable, Credential, Dashboard, ExtraHeader, LocalFile, LocalText, PickedFiles, Pipe, PipeEvent, ProbeFailure, SavedKey, SignIn, Stage};
use tunnel::Tunnel;

/// The owner's `hermes dashboard` port on the server's loopback (research doc, "SSH tunnel, Host header
/// and protocol generation").
const DASHBOARD_PORT: u16 = 9119;

struct Connection {
    dashboard: Arc<Dashboard>,
    pipe: Arc<Pipe>,
    _tunnel: Option<Tunnel>,
    /// The SSH target the sign-in went through, if it did: where the Preview's server pages go (server_page.rs).
    ssh_target: Option<String>,
    /// A token typed for this sign-in, and the address it signed in at, until `token_keep` saves it (ADR 0058).
    typed_token: Option<(String, Address)>,
}

/// How the webview asks to sign in (ADR 0058). `Password`: the provider Hermes listed, `basic` when none is given.
/// `Token`: one typed now, or else the one saved for `connection` (its keyring id; none for the migrated
/// connection), which only goes to an address it was saved for. The saved token never comes back to the webview.
#[derive(Deserialize)]
#[serde(tag = "method", rename_all = "camelCase")]
enum SignInWith {
    Password {
        username: String,
        password: String,
        #[serde(default)]
        provider: Option<String>,
    },
    Token {
        #[serde(default)]
        token: Option<String>,
        #[serde(default)]
        connection: Option<String>,
    },
}

const NO_SAVED_TOKEN: &str = "No token is saved for this address. Enter the token to sign in.";

impl SignInWith {
    /// The credential to sign in with at `address`, and the token typed now, if one was, for `token_keep`.
    async fn credential(self, address: &Address) -> Result<(Credential, Option<String>), String> {
        match self {
            SignInWith::Password { username, password, provider } => {
                let provider = provider.filter(|p| transport::provider_name(p)).unwrap_or_else(|| transport::PASSWORD_PROVIDER.into());
                Ok((Credential::Password { provider, username, password }, None))
            }
            SignInWith::Token { token: Some(token), .. } if !token.trim().is_empty() => {
                let token = token.trim().to_owned();
                Ok((Credential::Token(token.clone()), Some(token)))
            }
            SignInWith::Token { connection, .. } => {
                let raw = saved_password::load(saved_password::account(saved_password::TOKEN, connection.as_deref())?).await?;
                let saved = raw.as_deref().and_then(TokenEntry::read);
                match saved.as_ref().and_then(|e| e.token_for(address)) {
                    Some(token) => Ok((Credential::Token(token.to_owned()), None)),
                    None => Err(NO_SAVED_TOKEN.into()),
                }
            }
        }
    }
}

/// Where the owner signs in: through an SSH tunnel (ADR 0003), or straight to a dashboard URL.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Target {
    Ssh {
        target: String,
    },
    /// `headers`: extra request headers for a gateway in front of the dashboard, such as Cloudflare Access (ADR 0006).
    /// Only a direct connection sends them; the SSH tunnel goes straight to the dashboard.
    Url {
        url: String,
        #[serde(default)]
        headers: Vec<ExtraHeader>,
    },
}

/// How the connection reached the dashboard, for the webview to show and to decide whether it is Unsecure. `server`:
/// the server's id (`transport::server_id`), when its status named its install (ADR 0056).
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Route {
    Ssh {
        target: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        server: Option<String>,
    },
    Url {
        url: String,
        addresses: Vec<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        server: Option<String>,
    },
}

impl Target {
    /// Where a secret for this target may go: its mode and its target or URL as typed, trimmed.
    fn address(&self) -> Address {
        match self {
            Target::Ssh { target } => ["ssh".into(), target.trim().into()],
            Target::Url { url, .. } => ["url".into(), url.trim().into()],
        }
    }
}

impl Route {
    fn with_server(mut self, id: Option<String>) -> Self {
        match &mut self {
            Route::Ssh { server, .. } | Route::Url { server, .. } => *server = id,
        }
        self
    }
}

/// How long one route of a connection with several may take to answer before the next is tried (ADR 0056).
const QUICK_REACH: std::time::Duration = std::time::Duration::from_secs(5);

/// `probe`: the connection test running now, so setup can stop it, and a new one replaces it. `connecting`: the
/// connection being opened now, so the webview can stop it.
#[derive(Default)]
struct AppState(Mutex<Option<Connection>>, std::sync::Mutex<Option<tokio::task::AbortHandle>>, std::sync::Mutex<Connecting>);

/// The connection `hermes_connect` is opening, by the webview's name for that attempt, and the attempts stopped
/// before they began.
#[derive(Default)]
struct Connecting {
    now: Option<(String, tokio::task::AbortHandle)>,
    stopped: std::collections::HashSet<String>,
}

/// How long opening a connection may take, all steps together, so a server that stops answering midway can't keep
/// the app, or Sign out, waiting for good.
const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
const CONNECT_STOPPED: &str = "Connecting was stopped.";

/// The dashboard root for `target`, the tunnel that reaches it (SSH only), the route to report, and the extra
/// request headers to send (URL only, ADR 0006). Failures are the owner's address, headers or SSH (`Stage::Address`).
/// `quick`: give up on an SSH route that doesn't connect within `QUICK_REACH`, for a connection with several routes.
/// A plain http:// URL is refused unless it stays on this computer, a LAN or Tailscale (ADR 0056).
/// `steps`: where opening the connection reports the tunnel or DNS step (`connect_steps`).
async fn open_target(target: Target, quick: bool, steps: &Steps) -> Result<(url::Url, Option<Tunnel>, Route, reqwest::header::HeaderMap), String> {
    Ok(match target {
        Target::Ssh { target } => {
            let tunnel =
                steps.run(Step::Tunnel, tunnel::open_within(&target, DASHBOARD_PORT, quick.then_some(QUICK_REACH))).await.map_err(|e| e.to_string())?;
            let base = url::Url::parse(&format!("http://127.0.0.1:{}/", tunnel.local_port)).expect("valid URL");
            (base, Some(tunnel), Route::Ssh { target: target.trim().to_owned(), server: None }, Default::default())
        }
        Target::Url { url, headers } => {
            let headers = transport::extra_headers(&headers).map_err(|e| e.to_string())?;
            let lookup = transport::StepLimits::of(quick).map(|l| l.lookup);
            let direct = steps.run(Step::Resolve, transport::resolve_direct_within(&url, lookup)).await.map_err(|e| e.to_string())?;
            transport::check_plain_http(&direct).map_err(|e| e.to_string())?;
            let addresses = direct.addresses.iter().map(ToString::to_string).collect();
            (direct.base, None, Route::Url { url: url.trim().to_owned(), addresses, server: None }, headers)
        }
    })
}

/// How long the status read before a sign-in may take: short on a connection with several routes, so a dead one
/// gives way to the next soon.
const fn reach_within(quick: bool) -> std::time::Duration {
    if quick {
        QUICK_REACH
    } else {
        transport::PROBE_STEP_TIMEOUT
    }
}

/// Private screenshot storage and desktop requests waiting for a signed-in window.
#[derive(Default)]
struct Screenshots {
    captures: std::sync::Mutex<Option<Arc<screenshot::Captures>>>,
    requests: remote::Requests,
}

impl Screenshots {
    fn captures(&self) -> Result<Arc<screenshot::Captures>, screenshot::CaptureError> {
        let mut slot = self.captures.lock().unwrap();
        if let Some(c) = &*slot {
            return Ok(c.clone());
        }
        let c = Arc::new(screenshot::Captures::open(screenshot::default_root()?)?);
        *slot = Some(c.clone());
        Ok(c)
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn hermes_connect(
    state: State<'_, AppState>,
    transfers: State<'_, Transfers>,
    displays: State<'_, display::Displays>,
    pages: State<'_, Arc<server_page::ServerPages>>,
    target: Target,
    credential: SignInWith,
    profile: String,
    attempt: Option<String>,
    on_event: Channel<PipeEvent>,
    expect_server: Option<String>,
    quick: Option<bool>,
    ssh_route: Option<String>,
    on_step: Channel<connect_steps::Started>,
) -> Result<Route, String> {
    let mut slot = state.0.lock().await;
    *slot = None;
    transfers.stop_all();
    displays.close_all();
    let attempt = attempt.unwrap_or_default();
    // Run apart, so `hermes_connect_cancel` can stop it; stopping it drops what it opened, SSH tunnel included.
    let task = {
        let mut connecting = state.2.lock().unwrap();
        if connecting.stopped.remove(&attempt) {
            return Err(CONNECT_STOPPED.into());
        }
        let task = tokio::spawn(async move {
            // Which step it is on, for the record of connection attempts (#270).
            let steps = Steps::reporting(move |s| drop(on_step.send(s)));
            let opening = open_connection(target, credential, profile, on_event, expect_server, quick.unwrap_or(false), ssh_route, steps);
            tokio::time::timeout(CONNECT_TIMEOUT, opening)
                .await
                .unwrap_or_else(|_| Err(format!("Hermes didn't finish connecting within {}s.", CONNECT_TIMEOUT.as_secs())))
        });
        connecting.now = Some((attempt.clone(), task.abort_handle()));
        task
    };
    let opened = task.await;
    {
        let mut connecting = state.2.lock().unwrap();
        if connecting.now.as_ref().is_some_and(|(a, _)| *a == attempt) {
            connecting.now = None;
        }
    }
    let (connection, route) = match opened {
        Ok(opened) => opened?,
        Err(e) if e.is_cancelled() => return Err(CONNECT_STOPPED.into()),
        Err(e) => return Err(e.to_string()),
    };
    // Server pages opened through another SSH target, or for a URL sign-in none, belong to the server left behind.
    pages.close_other_targets(connection.ssh_target.as_deref(), SIGNED_IN_ELSEWHERE);
    *slot = Some(connection);
    Ok(route)
}

/// Opens the tunnel or resolves the URL, checks the dashboard there is Hermes, and the one `expect_server` names, then
/// signs in and opens `/api/ws`, for `hermes_connect`. `ssh_route`: the connection's SSH target when this route isn't
/// SSH, for the Preview's server pages (ADR 0056). Each step runs through `steps`, which says when it starts.
#[allow(clippy::too_many_arguments)]
async fn open_connection(
    target: Target,
    credential: SignInWith,
    profile: String,
    on_event: Channel<PipeEvent>,
    expect_server: Option<String>,
    quick: bool,
    ssh_route: Option<String>,
    steps: Steps,
) -> Result<(Connection, Route), String> {
    let address = target.address();
    let (credential, typed_token) = steps.run(Step::Keyring, credential.credential(&address)).await?;
    let (base, tunnel, route, headers) = open_target(target, quick, &steps).await?;
    let sign_in = SignIn { credential, headers };
    let limits = transport::StepLimits::of(quick);
    let (dashboard, pipe, seen) = transport::open_route(&base, &sign_in, &profile, expect_server.as_deref(), reach_within(quick), limits, &steps, move |e| {
        let _ = on_event.send(e);
    })
    .await
    .map_err(|e| e.to_string())?;
    let route = route.with_server(seen.server);
    let ssh_target = match &route {
        Route::Ssh { target, .. } => Some(target.clone()),
        Route::Url { .. } => ssh_route.map(|t| t.trim().to_owned()).filter(|t| !t.is_empty() && !t.starts_with('-')),
    };
    let typed_token = typed_token.map(|t| (t, address));
    Ok((Connection { dashboard: Arc::new(dashboard), pipe: Arc::new(pipe), _tunnel: tunnel, ssh_target, typed_token }, route))
}

/// Stops the connection `hermes_connect` is opening for `attempt`, or, if it hasn't begun, stops it before it does.
/// Another attempt's is left alone.
#[tauri::command]
fn hermes_connect_cancel(state: State<'_, AppState>, attempt: String) {
    let mut connecting = state.2.lock().unwrap();
    match &connecting.now {
        Some((now, task)) if *now == attempt => task.abort(),
        _ => {
            connecting.stopped.insert(attempt);
        }
    }
}

/// A connection test that went through: how it reached the dashboard, plus what `transport::probe` read.
#[derive(Serialize)]
struct ProbeResult {
    route: Route,
    #[serde(flatten)]
    probed: transport::Probed,
}

/// Tests a sign-in for setup without keeping it, so the app's own connection, if any, carries on. Its own SSH
/// tunnel, if it opened one, closes when the test ends. A new test, or `hermes_probe_cancel`, stops the one before.
#[tauri::command]
async fn hermes_probe(
    state: State<'_, AppState>,
    target: Target,
    credential: SignInWith,
    profile: String,
    expect_server: Option<String>,
    quick: Option<bool>,
) -> Result<ProbeResult, ProbeFailure> {
    let quick = quick.unwrap_or(false);
    let task = tokio::spawn(async move {
        let (credential, _) = credential.credential(&target.address()).await.map_err(|e| ProbeFailure::new(Stage::SignIn, e))?;
        let (base, _tunnel, route, headers) = open_target(target, quick, &Steps::default()).await.map_err(|e| ProbeFailure::new(Stage::Address, e))?;
        let sign_in = SignIn { credential, headers };
        let probed =
            transport::probe_expecting(&base, &sign_in, &profile, transport::PROBE_STEP_TIMEOUT, reach_within(quick), expect_server.as_deref()).await?;
        Ok(ProbeResult { route: route.with_server(probed.server.clone()), probed })
    });
    if let Some(before) = state.1.lock().unwrap().replace(task.abort_handle()) {
        before.abort();
    }
    match task.await {
        Ok(result) => result,
        Err(e) if e.is_cancelled() => Err(ProbeFailure::new(Stage::Cancelled, "The test was stopped.")),
        Err(e) => Err(ProbeFailure::new(Stage::Address, e.to_string())),
    }
}

/// One route reached without signing in, for a route's Test and for checking whether a preferred route is back: the
/// tunnel or address opened, and `/api/status` answered as the Hermes `expect_server` names (ADR 0056). No password
/// is sent, and the app's own connection carries on.
#[derive(Serialize)]
struct Reached {
    route: Route,
    status: Option<String>,
    /// The sign-in methods it offers (ADR 0058), when asked for.
    #[serde(skip_serializing_if = "Option::is_none")]
    methods: Option<transport::Methods>,
}

#[tauri::command]
async fn hermes_reach(target: Target, expect_server: Option<String>, quick: Option<bool>, methods: Option<bool>) -> Result<Reached, ProbeFailure> {
    let quick = quick.unwrap_or(false);
    let (base, _tunnel, route, headers) = open_target(target, quick, &Steps::default()).await.map_err(|e| ProbeFailure::new(Stage::Address, e))?;
    let http = transport::client(&headers).map_err(|e| ProbeFailure::new(Stage::Address, e.to_string()))?;
    let seen = transport::read_server(&http, &base, &headers, expect_server.as_deref(), reach_within(quick))
        .await
        .map_err(|e| ProbeFailure::new(Stage::Reach, e.to_string()))?;
    let methods = match methods {
        Some(true) => Some(transport::read_methods(&base, &headers, seen.status.as_deref(), reach_within(quick)).await),
        _ => None,
    };
    Ok(Reached { route: route.with_server(seen.server), status: seen.status, methods })
}

#[tauri::command]
fn hermes_probe_cancel(state: State<'_, AppState>) {
    if let Some(task) = state.1.lock().unwrap().take() {
        task.abort();
    }
}

/// Gives the signed-in Hermes a model provider's API key for `profile` (`Dashboard::save_provider_key`). The key
/// goes to the server and isn't kept on this computer.
#[tauri::command]
async fn hermes_save_provider_key(state: State<'_, AppState>, profile: String, key: String, value: String) -> Result<SavedKey, String> {
    let dashboard = match &*state.0.lock().await {
        Some(conn) => conn.dashboard.clone(),
        None => return Err(transport::TransportError::Closed.to_string()),
    };
    dashboard.save_provider_key(&profile, &key, &value).await.map_err(|e| e.to_string())
}

/// Takes a model provider's API key out of the signed-in Hermes for `profile` (`Dashboard::remove_provider_key`). The
/// window's REST relay refuses `DELETE api/env`, so this is the only way (ADR 0095).
#[tauri::command]
async fn hermes_remove_provider_key(state: State<'_, AppState>, profile: String, key: String) -> Result<(), String> {
    let dashboard = match &*state.0.lock().await {
        Some(conn) => conn.dashboard.clone(),
        None => return Err(transport::TransportError::Closed.to_string()),
    };
    dashboard.remove_provider_key(&profile, &key).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn hermes_send(state: State<'_, AppState>, frame: String) -> Result<(), String> {
    match &*state.0.lock().await {
        Some(conn) => conn.pipe.send(frame).map_err(|e| e.to_string()),
        None => Err(transport::TransportError::Closed.to_string()),
    }
}

/// Sends a frame with a file the owner attached (`Attachable`) in it.
#[tauri::command]
async fn hermes_send_file(
    state: State<'_, AppState>,
    attachable: State<'_, Attachable>,
    head: String,
    path: String,
    tail: String,
    max_bytes: u64,
) -> Result<(), String> {
    attachable.check(&path).map_err(|e| e.to_string())?;
    // Reading a big file takes a while; don't hold the lock, so a Stop can still go out.
    let pipe = match &*state.0.lock().await {
        Some(conn) => conn.pipe.clone(),
        None => return Err(transport::TransportError::Closed.to_string()),
    };
    pipe.send_file(&head, &path, &tail, max_bytes).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn hermes_stat_files(attachable: State<'_, Attachable>, paths: Vec<String>) -> Result<Vec<LocalFile>, String> {
    Ok(transport::stat_files(&attachable, &paths).await)
}

/// A staged image's bytes for its composer thumbnail, raw rather than as JSON.
#[tauri::command]
async fn hermes_read_preview(attachable: State<'_, Attachable>, path: String) -> Result<tauri::ipc::Response, String> {
    transport::read_preview(&attachable, &path).await.map(tauri::ipc::Response::new).map_err(|e| e.to_string())
}

/// Opens the native Open dialog for files to attach. `[]`: the owner cancelled.
#[tauri::command]
async fn attach_picked_files(app: tauri::AppHandle, attachable: State<'_, Attachable>) -> Result<Vec<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app.dialog().file();
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    dialog.pick_files(move |paths| {
        let _ = tx.send(paths);
    });
    let Some(picked) = rx.await.map_err(|e| e.to_string())? else { return Ok(Vec::new()) };
    let mut paths = Vec::with_capacity(picked.len());
    for path in picked {
        paths.push(path.into_path().map_err(|e| e.to_string())?.to_string_lossy().into_owned());
    }
    attachable.add(paths.clone());
    Ok(paths)
}

/// Takes a screenshot of a region or window the owner picks, staged privately as `<name>.png` for the composer.
#[tauri::command]
async fn screenshot_capture(
    state: State<'_, Screenshots>,
    attachable: State<'_, Attachable>,
    name: String,
) -> Result<screenshot::Capture, screenshot::CaptureError> {
    let captures = state.captures()?;
    let capture = screenshot::capture(&captures, &name).await?;
    attachable.add([capture.path.clone()]);
    Ok(capture)
}

/// Deletes a staged screenshot: removed from the composer, or its message sent. Paths that aren't one are ignored.
#[tauri::command]
fn screenshot_discard(state: State<'_, Screenshots>, path: String) {
    if let Some(c) = &*state.captures.lock().unwrap() {
        c.discard(std::path::Path::new(&path));
    }
}

/// How screenshots are taken on this desktop, for Settings.
#[tauri::command]
async fn screenshot_support() -> screenshot::Support {
    tokio::task::spawn_blocking(screenshot::support).await.unwrap_or_else(|e| screenshot::Support { ok: false, summary: e.to_string() })
}

/// The renderer supplies all persisted outboxes at startup and whenever they change, before cleanup.
#[tauri::command]
fn screenshot_sync_outbox(app: tauri::AppHandle, state: State<'_, Screenshots>, paths: Vec<String>) -> Result<(), screenshot::CaptureError> {
    // Also those of drafts an update's restart couldn't put back (update.rs).
    let saved = update::saved_attachment_paths(&app);
    state.captures()?.retain_outbox(paths.into_iter().map(std::path::PathBuf::from).chain(saved));
    Ok(())
}

/// Peeking leaves the request pending if the signed-in window goes away before handling it.
#[tauri::command]
fn screenshot_pending_request(state: State<'_, Screenshots>) -> Option<u64> {
    state.requests.pending()
}

/// A live window started handling this request. A newer request remains pending.
#[tauri::command]
fn screenshot_ack_request(state: State<'_, Screenshots>, id: u64) {
    state.requests.acknowledge(id);
}

/// The chat link waiting for the window, from the command line or a later launch (links.rs); handed out once.
#[tauri::command]
fn chat_link_take(links: State<'_, links::Links>) -> Option<String> {
    links.take()
}

/// Brings the window forward after a desktop shortcut's screenshot was attached, so the owner can review it.
#[tauri::command]
fn screenshot_show_window(app: tauri::AppHandle) {
    tray::show(&app);
}

/// Saves a file pasted into the composer to a temp file and returns its path. Its bytes come as the raw body, not
/// JSON, so a big screenshot isn't sent as a list of numbers; its name comes URI-encoded in the `x-name` header.
#[tauri::command]
async fn stage_clipboard_file(attachable: State<'_, Attachable>, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("The pasted file didn't arrive as bytes.".into());
    };
    let header = request.headers().get("x-name").and_then(|v| v.to_str().ok()).unwrap_or_default();
    // encodeURIComponent never writes `+`, `&` or `=` bare, so one form-decoded key is exactly the name.
    let name = url::form_urlencoded::parse(header.as_bytes()).next().map(|(k, _)| k.into_owned()).unwrap_or_default();
    let path = transport::stage_clipboard_file(&name, bytes).map_err(|e| e.to_string())?.to_string_lossy().into_owned();
    attachable.add([path.clone()]);
    Ok(path)
}

#[tauri::command]
async fn hermes_request(state: State<'_, AppState>, method: String, path: String, body: Option<String>) -> Result<String, String> {
    // Don't hold the lock across the request, so frames keep flowing while it runs.
    let dashboard = match &*state.0.lock().await {
        Some(conn) => conn.dashboard.clone(),
        None => return Err(transport::TransportError::Closed.to_string()),
    };
    dashboard.request(&method, &path, body).await.map_err(|e| e.to_string())
}

/// The signed-in dashboard, without holding the lock across a request, so frames keep flowing while it runs.
async fn dashboard(state: &State<'_, AppState>) -> Result<Arc<Dashboard>, String> {
    match &*state.0.lock().await {
        Some(conn) => Ok(conn.dashboard.clone()),
        None => Err(transport::TransportError::Closed.to_string()),
    }
}

/// A header the webview set on a raw-body command, URI-decoded.
fn header_value(request: &tauri::ipc::Request<'_>, name: &str) -> Option<String> {
    let raw = request.headers().get(name)?.to_str().ok()?;
    url::form_urlencoded::parse(format!("v={}", raw.replace('+', "%2B")).as_bytes()).next().map(|(_, v)| v.into_owned())
}

/// Transcribes a Dictation or Voice conversation recording where the owner chose (`local_stt`, ADR 0065 and 0067): on
/// Hermes with the profile's speech-to-text provider, on this computer, or one with the other as backup. Its bytes come
/// as the raw request body, not as JSON; its MIME type and the profile as the URI-encoded `x-mime` and `x-profile`
/// headers; `x-stt-run` names it for `local_stt_cancel`, and `x-stt-side` asks for one side alone (Settings' Test).
/// Hermes is reached only when it is in the route. Nothing here keeps or logs the audio or the text.
#[tauri::command]
async fn hermes_transcribe(app: tauri::AppHandle, state: State<'_, AppState>, request: tauri::ipc::Request<'_>) -> Result<local_stt::Routed, String> {
    let InvokeBody::Raw(audio) = request.body() else {
        return Err("The recording didn't arrive as audio bytes.".into());
    };
    let mime = header_value(&request, "x-mime").unwrap_or_default();
    let only = match header_value(&request, "x-stt-side") {
        Some(side) => Some(local_stt::Side::parse(&side).ok_or("Transcribe on the server or on this computer.")?),
        None => None,
    };
    let run = header_value(&request, "x-stt-run");
    let profile = header_value(&request, "x-profile");
    let server = async {
        let profile = profile.ok_or("The recording didn't name a profile.")?;
        let dashboard = dashboard(&state).await?;
        dashboard.transcribe(&profile, &mime, audio).await.map_err(|e| e.to_string())
    };
    local_stt::transcribe_routed(&app, &mime, audio, only, run, server).await
}

/// A reply read aloud, as the webview gets it: the audio as base64, since a command answers either JSON or raw bytes.
#[derive(Serialize)]
struct SpeechOut {
    mime: String,
    audio: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider: Option<String>,
}

#[tauri::command]
async fn hermes_speak(state: State<'_, AppState>, profile: String, text: String) -> Result<SpeechOut, String> {
    use base64::Engine;
    let dashboard = dashboard(&state).await?;
    let speech = dashboard.speak(&profile, &text).await.map_err(|e| e.to_string())?;
    let audio = base64::engine::general_purpose::STANDARD.encode(&speech.audio);
    Ok(SpeechOut { mime: speech.mime, audio, provider: speech.provider })
}

#[tauri::command]
async fn hermes_voice_setup(state: State<'_, AppState>, profile: String) -> Result<transport::VoiceSetup, String> {
    let dashboard = dashboard(&state).await?;
    dashboard.voice_setup(&profile).await.map_err(|e| e.to_string())
}

/// A read-only dashboard GET whose answer may be big, e.g. a server file for the Server files screen's preview: refused
/// once it passes `max_bytes`.
#[tauri::command]
async fn hermes_get_limited(state: State<'_, AppState>, path: String, max_bytes: u64) -> Result<String, String> {
    let dashboard = dashboard(&state).await?;
    dashboard.get_limited(&path, max_bytes).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn hermes_toolset_guards(state: State<'_, AppState>, profile: String) -> Result<transport::ToolsetGuards, String> {
    let dashboard = dashboard(&state).await?;
    dashboard.toolset_guards(&profile).await.map_err(|e| e.to_string())
}

/// Settings → MCP servers' edit of one server for `profile` (`Dashboard::mcp_edit`, ADR 0068). The webview sends
/// only that server's fields, secrets it didn't retype left out; Rust reads and writes Hermes's whole map.
#[tauri::command]
async fn hermes_mcp_edit(state: State<'_, AppState>, profile: String, edit: mcp::Edit) -> Result<(), String> {
    let dashboard = dashboard(&state).await?;
    dashboard.mcp_edit(&profile, &edit).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn hermes_disconnect(
    state: State<'_, AppState>,
    transfers: State<'_, Transfers>,
    displays: State<'_, display::Displays>,
    pages: State<'_, Arc<server_page::ServerPages>>,
) -> Result<(), String> {
    *state.0.lock().await = None;
    transfers.stop_all();
    displays.close_all();
    pages.close_all(SIGNED_OUT);
    Ok(())
}

const SIGNED_OUT: &str = "Hermes Chat left the Hermes server, so the tunnel to it closed.";
const SIGNED_IN_ELSEWHERE: &str = "Hermes Chat is now connected to another server, so the tunnel to this one closed.";

/// Opens `url`, a page on the Hermes server's own loopback, through an SSH tunnel to the signed-in connection's SSH
/// target (server_page.rs, ADR 0052). The webview names only the page and its own `key` for it; Rust parses the page
/// again, and picks the target. The tunnel is registered while the connection is locked, so a sign-out or another
/// sign-in after this closes it, even while ssh is still connecting. `on_event` hears once if it ends without
/// `preview_server_close`.
#[tauri::command]
async fn preview_server_open(
    state: State<'_, AppState>,
    pages: State<'_, Arc<server_page::ServerPages>>,
    url: String,
    key: String,
    on_event: Channel<server_page::PageEvent>,
) -> Result<server_page::Opened, server_page::ServerPageError> {
    let page = server_page::server_page(&url)?;
    let starting = match &*state.0.lock().await {
        None => return Err(server_page::ServerPageError::NotConnected),
        Some(conn) => pages.begin(&key, conn.ssh_target.as_deref().ok_or(server_page::ServerPageError::NoSshTarget)?)?,
    };
    let pages = pages.inner().clone();
    pages
        .open("ssh", starting, page, move |e| {
            let _ = on_event.send(e);
        })
        .await
}

/// Closes the page `key` opened, or is opening; if Rust hasn't seen its `preview_server_open` yet, that is refused.
#[tauri::command]
fn preview_server_close(pages: State<'_, Arc<server_page::ServerPages>>, key: String) {
    pages.close(&key);
}

/// Server file transfers running now, by the webview's id for each, so Cancel can stop one. Every one is stopped when
/// the connection is replaced or closed, so a transfer never outlives the sign-in it started on (ADR 0023).
#[derive(Default)]
struct Transfers {
    /// Each running transfer's abort handle, with the run that registered it.
    tasks: std::sync::Mutex<std::collections::HashMap<u64, (u64, tokio::task::AbortHandle)>>,
    /// Counts the times every transfer was stopped. A transfer that started before the latest stop must not go on,
    /// even if it was still waiting on a dialog then.
    epoch: std::sync::atomic::AtomicU64,
    runs: std::sync::atomic::AtomicU64,
}

impl Transfers {
    fn stop_all(&self) {
        use std::sync::atomic::Ordering;
        let mut tasks = self.tasks.lock().unwrap();
        self.epoch.fetch_add(1, Ordering::SeqCst);
        for (_, (_, task)) in tasks.drain() {
            task.abort();
        }
    }

    fn epoch(&self) -> u64 {
        self.epoch.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Runs `work` as transfer `id` until it ends or `files_cancel` or `stop_all` stops it, if no stop came since
    /// `epoch` (checked under the same lock `stop_all` takes, so a stop either reaches the work or keeps it from
    /// starting). Given an `id` still running, the older transfer is stopped; each run removes only its own entry.
    async fn run<T: Send + 'static>(
        &self,
        id: u64,
        epoch: u64,
        work: impl std::future::Future<Output = Result<T, String>> + Send + 'static,
    ) -> Result<T, String> {
        let run = self.runs.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let task = {
            let mut tasks = self.tasks.lock().unwrap();
            if self.epoch() != epoch {
                return Err(TRANSFER_STOPPED.into());
            }
            let task = tokio::spawn(work);
            if let Some((_, old)) = tasks.insert(id, (run, task.abort_handle())) {
                old.abort();
            }
            task
        };
        let ended = task.await;
        let mut tasks = self.tasks.lock().unwrap();
        if tasks.get(&id).is_some_and(|(r, _)| *r == run) {
            tasks.remove(&id);
        }
        drop(tasks);
        match ended {
            Ok(result) => result,
            Err(e) if e.is_cancelled() => Err(TRANSFER_STOPPED.into()),
            Err(e) => Err(e.to_string()),
        }
    }
}

/// What a stopped transfer rejects with; the webview tells it from a failure by this text.
const TRANSFER_STOPPED: &str = "The transfer was stopped.";

/// A transfer's progress: bytes so far, the size the server announced, and where on this computer the file goes.
#[derive(Clone, Serialize)]
struct TransferProgress {
    done: u64,
    total: Option<u64>,
    dest: String,
}

/// A finished download: where it went and how many bytes it holds.
#[derive(Serialize)]
struct Downloaded {
    dest: String,
    bytes: u64,
}

/// The signed-in dashboard, if the connection is still the one that was current at `epoch`. Waiting for the connection
/// lock can outlast a reconnect, so this checks again after.
async fn dashboard_since(app: &tauri::AppHandle, epoch: u64) -> Result<Arc<Dashboard>, String> {
    let transfers = app.state::<Transfers>();
    let dashboard = dashboard(&app.state::<AppState>()).await?;
    if transfers.epoch() != epoch {
        return Err(TRANSFER_STOPPED.into());
    }
    Ok(dashboard)
}

/// Downloads the Server file at `path` (ADR 0023). The owner picks where in the native Save dialog, which asks before
/// replacing a file there; the webview never names the local path. `None`: the owner cancelled the dialog, and nothing
/// was read or written. `name` only suggests the file name. The download reads from the connection that was current
/// when it was asked for, and only from it: one replaced or closed meanwhile, even while the dialog was open, stops it.
/// The dialog itself isn't part of the transfer: the plugin can't close a dialog it opened, so a stop while it is open
/// would leave it on screen with nowhere for its answer to go. The pick is turned down once it comes instead.
#[tauri::command]
async fn files_download(
    app: tauri::AppHandle,
    transfers: State<'_, Transfers>,
    id: u64,
    path: String,
    name: String,
    on_progress: Channel<TransferProgress>,
) -> Result<Option<Downloaded>, String> {
    let epoch = transfers.epoch();
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app.dialog().file().set_title("Download from the Hermes server").set_file_name(name);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    dialog.save_file(move |dest| {
        let _ = tx.send(dest);
    });
    let Some(dest) = rx.await.map_err(|e| e.to_string())? else { return Ok(None) };
    let dest = dest.into_path().map_err(|e| e.to_string())?;
    let work = async move {
        let dashboard = dashboard_since(&app, epoch).await?;
        let shown = dest.display().to_string();
        // Picked: from here on it is a running download, which Cancel can stop.
        let _ = on_progress.send(TransferProgress { done: 0, total: None, dest: shown.clone() });
        let report = |done, total| {
            let _ = on_progress.send(TransferProgress { done, total, dest: shown.clone() });
        };
        let bytes = dashboard.download(&path, &dest, report).await.map_err(|e| e.to_string())?;
        Ok(Some(Downloaded { dest: shown, bytes }))
    };
    transfers.run(id, epoch, work).await
}

/// Local files the owner picked to upload, by the token the webview gets for each, so it never names a local path.
/// Each is kept with the transfers' epoch it was picked in: a pick is good for one upload, over the connection that was
/// current when it was picked.
#[derive(Default)]
struct UploadPicks(std::sync::Mutex<(u64, std::collections::HashMap<u64, Pick>)>);

/// A picked file: its local path and the transfers' epoch it was picked in.
type Pick = (std::path::PathBuf, u64);

/// A local file picked to upload: its token, name and size.
#[derive(Serialize)]
struct PickedUpload {
    token: u64,
    name: String,
    size: u64,
}

/// Opens the native Open dialog for a file to upload to the server. Nothing is sent yet: the webview shows where it
/// would go first. `None`: the owner cancelled.
#[tauri::command]
async fn files_pick_upload(app: tauri::AppHandle, picks: State<'_, UploadPicks>, transfers: State<'_, Transfers>) -> Result<Option<PickedUpload>, String> {
    let epoch = transfers.epoch();
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app.dialog().file().set_title("Upload to the Hermes server");
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    dialog.pick_file(move |path| {
        let _ = tx.send(path);
    });
    let Some(path) = rx.await.map_err(|e| e.to_string())? else { return Ok(None) };
    let path = path.into_path().map_err(|e| e.to_string())?;
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("That isn't a file.".into());
    }
    let name = path.file_name().map_or_else(|| path.display().to_string(), |n| n.to_string_lossy().into_owned());
    let mut picks = picks.0.lock().unwrap();
    picks.0 += 1;
    let token = picks.0;
    // Picks never sent are let go once the connection they were picked in is gone.
    let now = transfers.epoch();
    picks.1.retain(|_, (_, e)| *e == now);
    picks.1.insert(token, (path, epoch));
    Ok(Some(PickedUpload { token, name, size: meta.len() }))
}

/// Lets go of a pick that won't be sent: the owner cancelled the upload dialog. A token already taken or let go is fine.
#[tauri::command]
fn files_discard_pick(picks: State<'_, UploadPicks>, token: u64) {
    picks.0.lock().unwrap().1.remove(&token);
}

/// Uploads the file picked as `token` to the server path `path` (`Dashboard::upload`, ADR 0023). `overwrite` false:
/// Hermes refuses when a file is already there. Resolves to Hermes's answer, the written entry as JSON.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn files_upload(
    app: tauri::AppHandle,
    transfers: State<'_, Transfers>,
    picks: State<'_, UploadPicks>,
    id: u64,
    token: u64,
    path: String,
    overwrite: bool,
    on_progress: Channel<TransferProgress>,
) -> Result<String, String> {
    // Taken, not looked up: a pick is good for one upload.
    let (local, epoch) = picks.0.lock().unwrap().1.remove(&token).ok_or("That file wasn't picked in the Open dialog, or was already sent.")?;
    let dest = path.clone();
    // Registered before it waits for the connection, so a stop meanwhile reaches it; and only the connection that was
    // current when it was asked for is used.
    let work = async move {
        let dashboard = dashboard_since(&app, epoch).await?;
        let report = move |done, total| {
            let _ = on_progress.send(TransferProgress { done, total, dest: dest.clone() });
        };
        dashboard.upload(&path, transport::UploadSource::File(local), overwrite, report).await.map_err(|e| e.to_string())
    };
    transfers.run(id, epoch, work).await
}

/// Writes an edited text file's whole new text to the server path `path` (Server files editing, ADR 0024): the same
/// upload route, with `overwrite` true for a save over the file the edit started from, false for a copy. The webview
/// checks the file's revision first and reads it back after; this only writes.
#[tauri::command]
async fn files_save_text(
    app: tauri::AppHandle,
    transfers: State<'_, Transfers>,
    id: u64,
    path: String,
    text: String,
    overwrite: bool,
) -> Result<String, String> {
    let epoch = transfers.epoch();
    let work = async move {
        let dashboard = dashboard_since(&app, epoch).await?;
        dashboard.upload(&path, transport::UploadSource::Bytes(text.into_bytes()), overwrite, |_, _| {}).await.map_err(|e| e.to_string())
    };
    transfers.run(id, epoch, work).await
}

/// Writes an artifact's whole new text to `path` where `profile`'s tools run (`POST api/fs/write-text`, ADR 0029). Like
/// `files_save_text`, the webview checks the revision first and reads it back after, and the write is a transfer, so
/// `files_cancel` stops it and a closed or replaced connection never sends it. `session`: the chat whose sandbox the
/// path is in, named as the read named it, so the save lands where the read did (ADR 0062).
#[tauri::command]
async fn fs_save_text(
    app: tauri::AppHandle,
    transfers: State<'_, Transfers>,
    id: u64,
    profile: String,
    path: String,
    text: String,
    session: Option<String>,
) -> Result<String, String> {
    let epoch = transfers.epoch();
    let work = async move {
        let dashboard = dashboard_since(&app, epoch).await?;
        dashboard.write_agent_text(&profile, &path, &text, session.as_deref()).await.map_err(|e| e.to_string())
    };
    transfers.run(id, epoch, work).await
}

/// Stops transfer `id`, if it is still running. A download's part file is removed; `dest` is left as it was.
#[tauri::command]
fn files_cancel(transfers: State<'_, Transfers>, id: u64) {
    if let Some((_, task)) = transfers.tasks.lock().unwrap().remove(&id) {
        task.abort();
    }
}

/// The dashboard password of one saved connection. `connection`: its id; none for the connection migrated from the
/// single sign-in kept before saved connections, which keeps the keyring entry it had (src/hermes/connections.ts).
#[tauri::command]
async fn password_load(connection: Option<String>) -> Result<Option<String>, String> {
    saved_password::load(saved_password::account(saved_password::PASSWORD, connection.as_deref())?).await
}

#[tauri::command]
async fn password_save(password: String, connection: Option<String>) -> Result<(), String> {
    saved_password::save(saved_password::account(saved_password::PASSWORD, connection.as_deref())?, password).await
}

#[tauri::command]
async fn password_delete(connection: Option<String>) -> Result<(), String> {
    saved_password::delete(saved_password::account(saved_password::PASSWORD, connection.as_deref())?).await
}

/// One saved connection's extra request headers, names and values, as JSON the webview reads and writes.
#[tauri::command]
async fn headers_load(connection: Option<String>) -> Result<Option<String>, String> {
    saved_password::load(saved_password::account(saved_password::HEADERS, connection.as_deref())?).await
}

#[tauri::command]
async fn headers_save(headers: String, connection: Option<String>) -> Result<(), String> {
    saved_password::save(saved_password::account(saved_password::HEADERS, connection.as_deref())?, headers).await
}

#[tauri::command]
async fn headers_delete(connection: Option<String>) -> Result<(), String> {
    saved_password::delete(saved_password::account(saved_password::HEADERS, connection.as_deref())?).await
}

/// Saves the token the connection in use signed in with, when it was typed for this sign-in, in the keyring as
/// `dashboard-token/<id>` for `addresses`: the routes it was entered for, which must include the one it signed in at.
/// Nothing typed: nothing to save. The webview never reads the token back (ADR 0058).
#[tauri::command]
async fn token_keep(state: State<'_, AppState>, connection: Option<String>, addresses: Vec<Address>) -> Result<(), String> {
    let account = saved_password::account(saved_password::TOKEN, connection.as_deref())?;
    let typed = match &*state.0.lock().await {
        Some(conn) => conn.typed_token.clone(),
        None => return Err(transport::TransportError::Closed.to_string()),
    };
    let Some((token, at)) = typed else { return Ok(()) };
    let mut keep: Vec<Address> = Vec::new();
    for a in addresses.into_iter().map(|[mode, target]| [mode, target.trim().to_owned()]) {
        if matches!(a[0].as_str(), "ssh" | "url") && !a[1].is_empty() && !keep.contains(&a) {
            keep.push(a);
        }
    }
    if !keep.contains(&at) {
        return Err("The token wasn't saved: the addresses given don't include the one it signed in at.".into());
    }
    saved_password::save(account, TokenEntry::new(keep, token).to_json()).await
}

/// The addresses a saved token is for, so the webview knows which routes it can sign in over without asking. None when
/// no token is saved. Never the token itself.
#[tauri::command]
async fn token_saved(connection: Option<String>) -> Result<Option<Vec<Address>>, String> {
    let raw = saved_password::load(saved_password::account(saved_password::TOKEN, connection.as_deref())?).await?;
    Ok(raw.as_deref().and_then(TokenEntry::read).map(|e| e.addresses))
}

#[tauri::command]
async fn token_delete(connection: Option<String>) -> Result<(), String> {
    saved_password::delete(saved_password::account(saved_password::TOKEN, connection.as_deref())?).await
}

/// Writes `text` where the owner picks in the native Save dialog, which asks before replacing a file. The webview
/// never names the path. `None`: the owner cancelled, and nothing was written.
async fn save_with_dialog(app: &tauri::AppHandle, title: &str, file_name: String, filter: (&str, &[&str]), text: String) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app.dialog().file().set_title(title).set_file_name(file_name).add_filter(filter.0, filter.1);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    dialog.save_file(move |path| {
        let _ = tx.send(path);
    });
    let Some(path) = rx.await.map_err(|e| e.to_string())? else { return Ok(None) };
    let path = path.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    Ok(Some(path.display().to_string()))
}

/// A transcript file the owner picked to import (src/hermes/importTranscripts.ts), read whole.
#[derive(Serialize)]
struct PickedTranscript {
    name: String,
    path: String,
    text: String,
}

/// The most an import file can be: Hermes's own import limit (`_SESSION_IMPORT_MAX_BYTES` at the deployed `bf0203a`).
const IMPORT_MAX_BYTES: u64 = 25 * 1024 * 1024;

/// Opens the native Open dialog for a transcript to import, and reads the file picked, up to `max_bytes` (never past
/// `IMPORT_MAX_BYTES`). The webview never names the path, so no other file can be read this way. `None`: the owner
/// cancelled.
#[tauri::command]
async fn import_pick_file(app: tauri::AppHandle, extensions: Vec<String>, max_bytes: u64) -> Result<Option<PickedTranscript>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let extensions: Vec<&str> = extensions.iter().map(String::as_str).filter(|e| e.chars().all(|c| c.is_ascii_alphanumeric())).collect();
    let mut dialog = app.dialog().file().set_title("Import a transcript").add_filter("Transcript", &extensions);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    dialog.pick_file(move |path| {
        let _ = tx.send(path);
    });
    let Some(path) = rx.await.map_err(|e| e.to_string())? else { return Ok(None) };
    let path = path.into_path().map_err(|e| e.to_string())?;
    let name = path.file_name().map_or_else(|| path.display().to_string(), |n| n.to_string_lossy().into_owned());
    let text = tokio::task::spawn_blocking({
        let path = path.clone();
        move || read_transcript(&path, max_bytes.min(IMPORT_MAX_BYTES))
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(Some(PickedTranscript { name, path: path.display().to_string(), text }))
}

/// A transcript file's whole text: a regular file of at most `max_bytes`, in UTF-8, without a byte order mark.
fn read_transcript(path: &std::path::Path, max_bytes: u64) -> Result<String, String> {
    use std::io::Read;
    let file = std::fs::File::open(path).map_err(|e| if path.is_dir() { "It isn't a file.".to_string() } else { format!("Couldn't open it: {e}") })?;
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("It isn't a file.".into());
    }
    let too_big = || format!("It's over {} MB, more than Hermes imports at once.", max_bytes / 1024 / 1024);
    if meta.len() > max_bytes {
        return Err(too_big());
    }
    let mut bytes = Vec::new();
    file.take(max_bytes + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > max_bytes {
        return Err(too_big());
    }
    let text = String::from_utf8(bytes).map_err(|_| "It isn't UTF-8 text.".to_string())?;
    Ok(text.strip_prefix('\u{feff}').map(str::to_owned).unwrap_or(text))
}

/// Saves an exported chat (src/hermes/exportChat.ts) where the owner picks.
#[tauri::command]
async fn chat_export(app: tauri::AppHandle, markdown: String, file_name: String) -> Result<Option<String>, String> {
    let title = "Export chat — the file may contain sensitive information from the chat";
    save_with_dialog(&app, title, file_name, ("Markdown", &["md"]), markdown).await
}

/// Saves the owner's message templates (src/hermes/templates.ts `exportFile`) where the owner picks.
#[tauri::command]
async fn templates_export(app: tauri::AppHandle, json: String) -> Result<Option<String>, String> {
    save_with_dialog(&app, "Export templates", "hermes-chat-templates.json".into(), ("JSON", &["json"]), json).await
}

/// Saves Usage analytics' CSV where the owner picks in the native Save dialog (ADR 0026). `None`: cancelled.
#[tauri::command]
async fn usage_export(app: tauri::AppHandle, csv: String, file_name: String) -> Result<Option<String>, String> {
    save_with_dialog(&app, "Export usage — chat titles are in the file", file_name, ("CSV", &["csv"]), csv).await
}

/// Saves Logs' export or support bundle (src/hermes/logs.ts, ADR 0033) where the owner picks. `None`: cancelled.
#[tauri::command]
async fn logs_export(app: tauri::AppHandle, text: String, file_name: String) -> Result<Option<String>, String> {
    save_with_dialog(&app, "Save logs — read the file before sharing it", file_name, ("Text", &["txt", "log"]), text).await
}

/// A local file the owner picked for the preview pane.
#[derive(Serialize)]
struct PickedFile {
    path: String,
    name: String,
}

/// Opens the native Open dialog for a file to preview. The webview never names the path: only a file picked here can
/// be read by `preview_read_local`. `None`: the owner cancelled.
#[tauri::command]
async fn preview_pick_local(app: tauri::AppHandle, picked: State<'_, PickedFiles>) -> Result<Option<PickedFile>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app.dialog().file().set_title("Preview a file on this computer");
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    dialog.pick_file(move |path| {
        let _ = tx.send(path);
    });
    let Some(path) = rx.await.map_err(|e| e.to_string())? else { return Ok(None) };
    let path = path.into_path().map_err(|e| e.to_string())?;
    let name = path.file_name().map_or_else(|| path.display().to_string(), |n| n.to_string_lossy().into_owned());
    let path = picked.allow(&path.display().to_string()).map_err(|e| e.to_string())?;
    Ok(Some(PickedFile { path, name }))
}

/// The start of a local file picked in `preview_pick_local`, as text.
#[tauri::command]
async fn preview_read_local(picked: State<'_, PickedFiles>, path: String) -> Result<LocalText, String> {
    picked.read(&path).await.map_err(|e| e.to_string())
}

/// Image bytes from the same retained handle as text previews, never from a newly resolved path.
#[tauri::command]
async fn preview_read_local_image(picked: State<'_, PickedFiles>, path: String) -> Result<tauri::ipc::Response, String> {
    picked.read_image(&path).await.map(tauri::ipc::Response::new).map_err(|e| e.to_string())
}

/// Whether the site at `url` refuses to be shown in the preview's frame, asked the way the frame asks
/// (`web_page::check`, ADR 0011). `user_agent`: the webview's, which the frame sends.
#[tauri::command]
async fn preview_check_web(url: String, user_agent: String) -> Result<web_page::Framing, String> {
    web_page::check(&url, &user_agent).await
}

/// Opens an http(s) page in the owner's default browser, and gives the browser's name where it is known.
#[tauri::command]
async fn preview_open_in_browser(app: tauri::AppHandle, url: String) -> Result<Option<String>, String> {
    web_page::open_in_browser(&app, &url).await
}

/// Shows a web page in the Preview's own WebKitGTK view (page_view.rs, ADR 0081). `key`: this page's name from now on.
#[tauri::command]
fn preview_page_open(app: tauri::AppHandle, key: String, url: String, on_event: Channel<page_view::PageEvent>) -> Result<(), String> {
    page_view::open(&app, key, &url, on_event)
}

/// Shows the Preview's page at `placement`, or hides it (`None`).
#[tauri::command]
fn preview_page_place(app: tauri::AppHandle, key: String, placement: Option<page_view::Placement>) {
    page_view::place(&app, key, placement)
}

/// Hides the Preview's page and stops it.
#[tauri::command]
fn preview_page_close(app: tauri::AppHandle, key: String) {
    page_view::close(&app, key)
}

#[tauri::command]
async fn notify_desktop(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    notify::show(app, title, body).await
}

/// The installed font families, for the Appearance settings.
#[tauri::command]
async fn system_fonts() -> fonts::Fonts {
    fonts::list().await
}

/// Dictation records from the microphone, and the app asks for it only when the owner starts a recording, so a
/// microphone request from the app's own page is granted here. Any other page (a link in a reply can navigate the
/// webview away) is refused, as are the camera and screen, which the app never uses. Anything else gets WebKit's
/// default.
fn permission<R: tauri::Runtime>(webview: &tauri::Webview<R>, kind: PermissionKind) -> PermissionResponse {
    match kind {
        PermissionKind::Microphone => {
            // In a dev build the page comes from the Vite server; a release build only trusts its bundled page.
            let dev_url = if tauri::is_dev() { webview.config().build.dev_url.clone() } else { None };
            match webview.url() {
                Ok(page) if media::is_app_page(&page, dev_url.as_ref()) => PermissionResponse::Allow,
                _ => PermissionResponse::Deny,
            }
        }
        PermissionKind::Camera | PermissionKind::DisplayCapture => PermissionResponse::Deny,
        _ => PermissionResponse::Default,
    }
}

/// Opens a terminal on the server: `ssh` to `target` (the sign-in's SSH target, or one the owner gave the terminal),
/// `cols` × `rows`, its output and end sent to `on_event` (terminal.rs, ADR 0022).
#[tauri::command]
async fn terminal_open(
    terminals: State<'_, terminal::Terminals>,
    target: String,
    cols: u16,
    rows: u16,
    on_event: Channel<terminal::TerminalEvent>,
) -> Result<u64, terminal::TerminalError> {
    let command = terminal::ssh_command(&target)?;
    terminals.open(command, cols, rows, move |e| {
        let _ = on_event.send(e);
    })
}

/// Async, so a terminal that isn't reading can't hold up the window.
#[tauri::command]
async fn terminal_write(terminals: State<'_, terminal::Terminals>, id: u64, data: String) -> Result<(), terminal::TerminalError> {
    terminals.write(id, data.as_bytes())
}

#[tauri::command]
fn terminal_resize(terminals: State<'_, terminal::Terminals>, id: u64, cols: u16, rows: u16) -> Result<(), terminal::TerminalError> {
    terminals.resize(id, cols, rows)
}

#[tauri::command]
fn terminal_close(terminals: State<'_, terminal::Terminals>, id: u64) {
    terminals.close(id);
}

/// Opens a terminal on this computer: the owner's own login shell, in their home folder (ADR 0039). The webview picks
/// neither the program nor its arguments.
#[tauri::command]
async fn terminal_open_local(
    terminals: State<'_, terminal::Terminals>,
    cols: u16,
    rows: u16,
    on_event: Channel<terminal::TerminalEvent>,
) -> Result<u64, terminal::TerminalError> {
    terminals.open(terminal::local_shell_command(), cols, rows, move |e| {
        let _ = on_event.send(e);
    })
}

/// What a screen socket sends the webview: its RFB bytes raw (an ArrayBuffer there), and how it closed as JSON.
fn display_event(e: display::DisplayEvent) -> tauri::ipc::InvokeResponseBody {
    match e {
        display::DisplayEvent::Data(bytes) => tauri::ipc::InvokeResponseBody::Raw(bytes),
        display::DisplayEvent::Closed { code, reason } => {
            tauri::ipc::InvokeResponseBody::Json(serde_json::json!({ "code": code, "reason": reason }).to_string())
        }
    }
}

/// Opens the Screen's stream, the Bot Desktop's RFB, with a ticket Hermes gave over `/api/ws` (display.rs, ADR 0039).
/// It is closed with the connection it was opened on.
#[tauri::command]
async fn display_open(
    state: State<'_, AppState>,
    displays: State<'_, display::Displays>,
    ticket: String,
    on_event: Channel<tauri::ipc::InvokeResponseBody>,
) -> Result<u64, String> {
    let epoch = displays.epoch();
    let dashboard = dashboard(&state).await?;
    let socket = display::open(dashboard, &ticket, move |e| {
        let _ = on_event.send(display_event(e));
    })
    .await
    .map_err(|e| e.to_string())?;
    displays.keep(epoch, socket).ok_or_else(|| transport::TransportError::Closed.to_string())
}

/// The webview's RFB bytes for screen socket `x-display-id`, as the raw body.
#[tauri::command]
fn display_send(displays: State<'_, display::Displays>, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("The screen's input didn't arrive as bytes.".into());
    };
    let id = header_value(&request, "x-display-id").and_then(|v| v.parse().ok()).ok_or("The screen's input didn't name its socket.")?;
    displays.send(id, bytes.clone()).map_err(|e| e.to_string())
}

#[tauri::command]
fn display_close(displays: State<'_, display::Displays>, id: u64) {
    displays.close(id);
}

/// One Git operation on the server for the Repository screen: the helper run through `ssh` to `target` (the sign-in's
/// SSH target, or one the owner gave), with `request` on its stdin (repo_git.rs, ADR 0034).
#[tauri::command]
async fn repo_git(target: String, request: repo_git::Request) -> Result<serde_json::Value, repo_git::RepoError> {
    repo_git::run_over_ssh(&target, &request).await
}

/// `repo_git`, for a request that reports progress as it goes (creating a worktree and running its setup, removing
/// one): each progress line goes to `on_progress` as the helper prints it (ADR 0043).
#[tauri::command]
async fn repo_git_stream(
    target: String,
    request: repo_git::Request,
    on_progress: Channel<serde_json::Value>,
) -> Result<serde_json::Value, repo_git::RepoError> {
    repo_git::run_over_ssh_streaming(&target, &request, move |line| {
        let _ = on_progress.send(line);
    })
    .await
}

/// Tauri tells the webview about the drop before this runs, but the webview's next IPC call is handled on this same
/// main thread after it returns, so the paths are attachable before the webview can ask about them.
fn attach_dropped(window: &tauri::Window, event: &tauri::WindowEvent) {
    if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
        if window.label() == "main" {
            window.state::<Attachable>().add(paths.iter().map(|p| p.to_string_lossy().into_owned()));
        }
    }
}

/// Starts the app. `screenshot`: it was started by `hermes-chat --screenshot`, with no other Hermes Chat to take it.
/// `link`: it was started to open a chat link, with no other Hermes Chat to open it (links.rs).
pub fn run(screenshot: bool, link: Option<String>) {
    let screenshots = Screenshots::default();
    if screenshot {
        screenshots.requests.ask();
    }
    let context = tauri::generate_context!();
    let mut builder = tauri::Builder::default();
    // The updater needs a public key to start, so it is there only in a build given one (README, "Updates").
    if update::configured(context.config()) {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }
    builder
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .manage(screenshots)
        .manage(links::Links::new(link))
        .manage(update::Updates::default())
        .manage(tray::Tray::default())
        .on_window_event(tray::on_window_event)
        .on_window_event(attach_dropped)
        .on_permission_request(|webview, kind| permission(&webview, kind))
        .setup(|app| {
            use tauri::Emitter;
            app.state::<Attachable>().load(app.path().app_data_dir()?.join("attachable.json"));
            main_window::build(app.handle())?;
            // WebKitGTK leaves `navigator.mediaDevices` out unless media capture is turned on. WebView2 has it, and asks
            // `permission` for the microphone.
            #[cfg(target_os = "linux")]
            if let Some(window) = app.get_webview_window("main") {
                window.with_webview(|webview| {
                    use webkit2gtk::{SettingsExt, WebViewExt};
                    if let Some(settings) = webview.inner().settings() {
                        settings.set_enable_media_stream(true);
                    }
                })?;
            }
            // Open storage at startup. The renderer supplies outbox references and triggers the startup sweep.
            if let Err(e) = app.state::<Screenshots>().captures() {
                eprintln!("hermes-chat: couldn't clean up old screenshots: {e}");
            }
            // Which package the binary came from, read before anything can upgrade it.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move { handle.state::<update::Updates>().start().await });
            // The global shortcut was removed (ADR 0033 is superseded); an older version's setting file goes too.
            summon::forget_old_shortcut(app.handle());
            let handle = app.handle().clone();
            // Requests that came while the app started (main.rs took the bus name first) are handled now.
            remote::set_handler(move |request| match request {
                remote::Request::Screenshot => {
                    handle.state::<Screenshots>().requests.ask();
                    let _ = handle.emit(remote::EVENT, ());
                }
                // A second launch or `--show` brings back this window, hidden to the tray or not (ADR 0034).
                remote::Request::Show { token } => summon::activate(&handle, false, token),
                remote::Request::Toggle { token } => summon::activate(&handle, true, token),
                // A chat link opened while the app runs: kept for the window, which comes forward to show it.
                remote::Request::OpenLink { link, token } => {
                    if handle.state::<links::Links>().put(link) {
                        let _ = handle.emit(links::EVENT, ());
                        summon::activate(&handle, false, token);
                    }
                }
            });
            tray::start(app.handle());
            Ok(())
        })
        .manage(PickedFiles::default())
        .manage(Attachable::default())
        .manage(local_stt::Downloads::default())
        .manage(Transfers::default())
        .manage(UploadPicks::default())
        .manage(terminal::Terminals::default())
        .manage(display::Displays::default())
        .manage(Arc::new(server_page::ServerPages::default()))
        .invoke_handler(tauri::generate_handler![
            hermes_connect,
            hermes_send,
            hermes_send_file,
            hermes_stat_files,
            hermes_read_preview,
            attach_picked_files,
            stage_clipboard_file,
            hermes_request,
            hermes_transcribe,
            local_stt::local_stt_state,
            local_stt::local_stt_detect,
            local_stt::local_stt_set,
            local_stt::local_stt_pick_program,
            local_stt::local_stt_pick_model,
            local_stt::local_stt_models,
            local_stt::local_stt_download,
            local_stt::local_stt_cancel_download,
            local_stt::local_stt_delete,
            local_stt::local_stt_cancel,
            hermes_speak,
            hermes_voice_setup,
            hermes_toolset_guards,
            hermes_mcp_edit,
            hermes_get_limited,
            hermes_disconnect,
            files_download,
            files_pick_upload,
            files_upload,
            files_discard_pick,
            files_save_text,
            fs_save_text,
            files_cancel,
            hermes_connect_cancel,
            hermes_probe,
            hermes_probe_cancel,
            hermes_reach,
            hermes_save_provider_key,
            hermes_remove_provider_key,
            password_load,
            password_save,
            password_delete,
            headers_load,
            headers_save,
            headers_delete,
            token_keep,
            token_saved,
            token_delete,
            chat_export,
            import_pick_file,
            templates_export,
            usage_export,
            logs_export,
            preview_pick_local,
            preview_read_local,
            preview_read_local_image,
            preview_check_web,
            preview_open_in_browser,
            preview_page_open,
            preview_page_place,
            preview_page_close,
            preview_server_open,
            preview_server_close,
            notify_desktop,
            system_fonts,
            screenshot_capture,
            screenshot_discard,
            screenshot_support,
            screenshot_sync_outbox,
            screenshot_pending_request,
            screenshot_ack_request,
            screenshot_show_window,
            chat_link_take,
            terminal_open,
            repo_git,
            repo_git_stream,
            terminal_write,
            terminal_resize,
            terminal_close,
            terminal_open_local,
            display_open,
            display_send,
            display_close,
            update::update_install_kind,
            update::update_check,
            update::update_download_and_install,
            update::app_restart,
            update::restart_drafts_read,
            update::restart_drafts_clear,
            backup::backup_export,
            backup::backup_pick,
            backup::backup_save_recovery,
            connection_attempts::connection_attempts_put,
            connection_attempts::connection_attempts_read,
            defaults_file::project_defaults_read,
            defaults_file::project_defaults_swap,
            defaults_file::tags_read,
            defaults_file::tags_swap,
            update::restart_drafts_set_aside,
            tray::tray_status,
            tray::tray_set_close_to_tray,
            tray::tray_inbox,
            tray::window_unsaved,
            tray::window_hidden
        ])
        .build(context)
        .expect("error while building tauri application")
        // Outbox persistence in the renderer can precede its asynchronous retention IPC. Leave remaining captures
        // for the next startup's sweep, after persisted references are known, rather than risk deleting Retry bytes.
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                // Each ssh also has PR_SET_PDEATHSIG, so none outlives the app even if this doesn't run.
                app.state::<Arc<server_page::ServerPages>>().close_all("Hermes Chat quit.");
                update::relaunch(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::Transfers;
    use std::time::Duration;

    #[test]
    fn a_transcript_is_read_whole_only_when_it_is_small_utf8_text() {
        let dir = std::env::temp_dir().join(format!("hermes-chat-import-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = |name: &str, bytes: &[u8]| {
            let p = dir.join(name);
            std::fs::write(&p, bytes).unwrap();
            p
        };
        assert_eq!(super::read_transcript(&file("ok.md", "\u{feff}# Chat\n".as_bytes()), 100).unwrap(), "# Chat\n");
        assert_eq!(super::read_transcript(&file("exact.md", &[b'a'; 100]), 100).unwrap().len(), 100);
        assert!(super::read_transcript(&file("big.md", &[b'a'; 101]), 100).unwrap_err().contains("over"));
        assert!(super::read_transcript(&file("bin.md", &[0xff, 0xfe, 0x00]), 100).unwrap_err().contains("UTF-8"));
        assert!(super::read_transcript(&dir, 100).unwrap_err().contains("isn't a file"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn a_replaced_transfer_leaves_its_replacements_cancel_in_place() {
        let transfers = std::sync::Arc::new(Transfers::default());
        let t = transfers.clone();
        let old = tokio::spawn(async move {
            t.run(7, 0, async {
                tokio::time::sleep(Duration::from_secs(60)).await;
                Ok(())
            })
            .await
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        let t = transfers.clone();
        let new = tokio::spawn(async move {
            t.run(7, 0, async {
                tokio::time::sleep(Duration::from_secs(60)).await;
                Ok(())
            })
            .await
        });
        assert_eq!(old.await.unwrap(), Err(super::TRANSFER_STOPPED.to_owned()));
        // The old run ended after the new one registered; the new one must still be reachable.
        assert!(transfers.tasks.lock().unwrap().contains_key(&7));
        let epoch = transfers.epoch();
        transfers.stop_all();
        assert_eq!(new.await.unwrap(), Err(super::TRANSFER_STOPPED.to_owned()));
        assert_eq!(transfers.epoch(), epoch + 1);
        assert!(transfers.tasks.lock().unwrap().is_empty());
        // Asked for before that stop: it never starts.
        let started = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let s = started.clone();
        let late = transfers
            .run(8, epoch, async move {
                s.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(())
            })
            .await;
        assert_eq!(late, Err(super::TRANSFER_STOPPED.to_owned()));
        assert!(!started.load(std::sync::atomic::Ordering::SeqCst));
    }

    /// Each request a stub got, in order: its path and its `Authorization` header.
    type Heard = std::sync::Arc<std::sync::Mutex<Vec<(String, Option<String>)>>>;

    type Frames = std::sync::Arc<std::sync::Mutex<Vec<String>>>;

    /// A stub dashboard that answers a password or a token sign-in, notes each request in the order it came, counts
    /// the TCP connections it accepted, and keeps the frames its WebSocket got.
    async fn counting_dashboard() -> (url::Url, std::sync::Arc<std::sync::atomic::AtomicUsize>, Heard, Frames) {
        use axum::extract::ws::{Message, WebSocketUpgrade};
        use axum::response::IntoResponse;
        use axum::routing::{get, post};
        use axum::serve::{Listener, ListenerExt};
        use std::sync::atomic::{AtomicUsize, Ordering};
        let accepted = std::sync::Arc::new(AtomicUsize::new(0));
        let paths = Heard::default();
        let ready = r#"{"jsonrpc":"2.0","method":"event","params":{"type":"gateway.ready","payload":{}}}"#;
        let note = paths.clone();
        let frames = Frames::default();
        let got = frames.clone();
        let app = axum::Router::new()
            .route(
                "/api/status",
                get(|| async { axum::Json(serde_json::json!({"version": "0.22.7", "auth_required": true, "auth_providers": ["basic", "session-token"]})) }),
            )
            .route(
                "/auth/password-login",
                post(|| async { ([(axum::http::header::SET_COOKIE, "hermes_session_at=AT; Path=/; HttpOnly")], axum::Json(serde_json::json!({"ok": true}))) }),
            )
            .route("/api/auth/me", get(|| async { axum::Json(serde_json::json!({"provider": "session-token"})) }))
            .route("/api/auth/ws-ticket", post(|| async { axum::Json(serde_json::json!({"ticket": "TICKET-1"})) }))
            .route(
                "/api/ws",
                get(move |ws: WebSocketUpgrade| async move {
                    ws.on_upgrade(move |mut ws| async move {
                        let _ = ws.send(Message::text(ready)).await;
                        while let Some(Ok(message)) = ws.recv().await {
                            if let Message::Text(text) = message {
                                got.lock().unwrap().push(text.to_string());
                            }
                        }
                    })
                    .into_response()
                }),
            )
            .layer(axum::middleware::from_fn(move |req: axum::extract::Request, next: axum::middleware::Next| {
                let auth = req.headers().get(axum::http::header::AUTHORIZATION).and_then(|v| v.to_str().ok()).map(str::to_owned);
                note.lock().unwrap().push((req.uri().path().to_owned(), auth));
                next.run(req)
            }));
        let count = accepted.clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap().tap_io(move |_| {
            count.fetch_add(1, Ordering::SeqCst);
        });
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (url::Url::parse(&format!("http://{addr}/")).unwrap(), accepted, paths, frames)
    }

    async fn connect(base: &url::Url, credential: super::SignInWith) -> super::Connection {
        let target = super::Target::Url { url: base.to_string(), headers: Vec::new() };
        let on_event = tauri::ipc::Channel::new(|_| Ok(()));
        let (connection, _) =
            super::open_connection(target, credential, "default".into(), on_event, None, false, None, super::Steps::default()).await.expect("connected");
        connection
    }

    /// Issue #271: the status read, the sign-in and the ticket share one kept-alive HTTP connection; the WebSocket
    /// is the only other one. The status read still comes first, before the password or token (ADR 0056).
    #[tokio::test]
    async fn a_sign_in_opens_one_http_connection_for_status_sign_in_and_ticket() {
        let password = super::SignInWith::Password { username: "liam".into(), password: "hunter2".into(), provider: None };
        let token = super::SignInWith::Token { token: Some("GOOD".into()), connection: None };
        let bearer = Some("Bearer GOOD".to_owned());
        for (credential, sign_in, auth) in [(password, "/auth/password-login", None), (token, "/api/auth/me", bearer)] {
            let (base, accepted, heard, _) = counting_dashboard().await;
            let _connection = connect(&base, credential).await;
            let want = [("/api/status", None), (sign_in, auth.clone()), ("/api/auth/ws-ticket", auth), ("/api/ws", None)];
            // The shared client never carries the token: the status read and the socket go without it.
            assert_eq!(*heard.lock().unwrap(), want.map(|(p, a)| (p.to_owned(), a)));
            assert_eq!(accepted.load(std::sync::atomic::Ordering::SeqCst), 2, "one HTTP connection plus the WebSocket, for {sign_in}");
        }
    }

    fn send_through_ipc(webview: &tauri::WebviewWindow<tauri::test::MockRuntime>, path: &std::path::Path) -> Result<(), String> {
        let request = tauri::webview::InvokeRequest {
            cmd: "hermes_send_file".into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: tauri::ipc::InvokeBody::Json(serde_json::json!({
                "head": r#"{"jsonrpc":"2.0","id":1,"method":"prompt.submit","params":{"text":""#,
                "path": path,
                "tail": r#""}}"#,
                "maxBytes": 1000,
            })),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.into(),
        };
        tauri::test::get_ipc_response(webview, request).map(|_| ()).map_err(|e| e.to_string())
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn send_file_refuses_a_file_the_owner_never_attached() {
        use base64::Engine;
        use tauri::Manager;
        let (base, _, _, frames) = counting_dashboard().await;
        let app = tauri::test::mock_builder()
            .manage(super::AppState::default())
            .manage(super::Attachable::default())
            .invoke_handler(tauri::generate_handler![super::hermes_send_file])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
        let password = super::SignInWith::Password { username: "liam".into(), password: "hunter2".into(), provider: None };
        *app.state::<super::AppState>().0.lock().await = Some(connect(&base, password).await);

        let dir = std::env::temp_dir().join(format!("hermes-chat-344-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let secret = dir.join("id_ed25519");
        std::fs::write(&secret, "PRIVATE KEY").unwrap();

        let attached = dir.join("notes.txt");
        std::fs::write(&attached, "MEETING NOTES").unwrap();
        app.state::<super::Attachable>().add([attached.to_string_lossy().into_owned()]);
        let heard = |bytes: &str| frames.lock().unwrap().iter().any(|f| f.contains(&base64::engine::general_purpose::STANDARD.encode(bytes)));

        let sent = send_through_ipc(&webview, &secret);
        send_through_ipc(&webview, &attached).expect("an attached file is sent");
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !heard("MEETING NOTES") && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let delivered = heard("MEETING NOTES");
        // One socket keeps the order, so the first file, had it gone, arrived before the second.
        let leaked = heard("PRIVATE KEY");
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(!leaked, "the stub dashboard got the bytes of a file nobody attached");
        assert!(sent.is_err(), "hermes_send_file answered Ok for a file nobody attached");
        assert!(delivered, "the stub dashboard didn't get the attached file");
    }
}
