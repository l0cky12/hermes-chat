pub mod annotate;
mod backlog;
pub mod backup;
#[cfg(target_os = "linux")]
pub mod browser;
pub mod connect_steps;
pub mod connection_attempts;
#[cfg(target_os = "linux")]
pub mod copied_files;
pub mod defaults_file;
pub mod dev_servers;
pub mod display;
pub mod fonts;
#[cfg(target_os = "linux")]
pub mod gtk_clipboard;
pub mod links;
pub mod live;
pub mod local_stt;
pub mod lock;
mod loopback_peer;
pub mod main_window;
pub mod markdown_image;
pub mod mcp;
pub mod media;
pub mod notify;
pub mod page_view;
mod private_file;
pub mod project_context;
pub mod remote;
pub mod repo_git;
pub mod saved_password;
pub mod screenshot;
pub mod server_page;
pub mod snapshot;
mod ssh_guard;
pub mod summon;
pub mod terminal;
pub mod touch_keyboard;
pub mod transport;
pub mod tray;
pub mod tunnel;
pub mod update;
pub mod web_page;

use crate::lock::Locked;
use connect_steps::{Step, Steps};
use live::{ConnectionId, Live, Slot, Slots};
use saved_password::{Address, TokenEntry};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::ipc::{Channel, InvokeBody};
use tauri::webview::{PermissionKind, PermissionResponse};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::Mutex;
use transport::{
    Attachable, Credential, Dashboard, ExtraHeader, LocalFile, LocalText, PickedFiles, PipeEvent, ProbeFailure, RelayError, SavedKey, SignIn, Stage,
};
use tunnel::Tunnel;

/// The owner's `hermes dashboard` port on the server's loopback (research doc, "SSH tunnel, Host header
/// and protocol generation").
pub(crate) const DASHBOARD_PORT: u16 = 9119;

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
    /// `headers`: extra request headers for a gateway in front of the dashboard, such as Cloudflare Access (ADR 0104).
    /// Only a direct connection sends them; the SSH tunnel goes straight to the dashboard.
    Url {
        url: String,
        #[serde(default)]
        headers: Vec<ExtraHeader>,
    },
}

/// How the connection reached the dashboard, for the webview to show and to decide whether it is Unsecure. `server`:
/// the server's id (`transport::server_id`), when its status named its install (ADR 0120).
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

/// How long one route of a connection with several may take to answer before the next is tried (ADR 0120).
const QUICK_REACH: std::time::Duration = std::time::Duration::from_secs(5);

/// `slots`: the connections open now (live.rs). `opening`: held by the `hermes_connect` running now, so connects run
/// one at a time; no other command takes it. `probe`: the connection test running now, so setup can stop it, and a new
/// one replaces it. `connecting`: the openings running now, so the webview can stop one.
#[derive(Default)]
struct AppState {
    slots: Slots,
    opening: Mutex<()>,
    probe: std::sync::Mutex<Option<tokio::task::AbortHandle>>,
    connecting: std::sync::Mutex<Connecting>,
}

/// The openings running now, a connect and any reopen of another connection's socket, each by the webview's name for
/// that attempt, and the attempts stopped before they began.
#[derive(Default)]
struct Connecting {
    now: std::collections::HashMap<String, tokio::task::AbortHandle>,
    stopped: std::collections::VecDeque<String>,
}

/// The most attempts stopped before they began kept.
const STOPPED_KEPT: usize = 256;

/// How long opening a connection may take, all steps together, so a server that stops answering midway can't keep
/// the app, or Sign out, waiting for good.
const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
const CONNECT_STOPPED: &str = "Connecting was stopped.";

/// The dashboard root for `target`, the tunnel that reaches it (SSH only), the route to report, and the extra
/// request headers to send (URL only, ADR 0104). Failures are the owner's address, headers or SSH (`Stage::Address`).
/// `quick`: give up on an SSH route that doesn't connect within `QUICK_REACH`, for a connection with several routes.
/// A plain http:// URL is refused unless it stays on this computer, a LAN or Tailscale (ADR 0120).
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
        let mut slot = self.captures.locked();
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
    saved_connection: String,
    attempt: Option<String>,
    on_event: Channel<PipeEvent>,
    expect_server: Option<String>,
    quick: Option<bool>,
    ssh_route: Option<String>,
    on_step: Channel<connect_steps::Started>,
) -> Result<Route, String> {
    let id = ConnectionId::parse(&saved_connection)?;
    let _opening = state.opening.lock().await;
    // The connections this one replaces leave the map first, and their transfers and Screens stop after: whatever
    // registers on one checks it is still held, or its epoch, once it has, so nothing is left running on it.
    let mut evicted = Vec::new();
    let leave = || {
        evicted = state.slots.evict_for(&id);
        for gone in &evicted {
            transfers.stop(gone);
            displays.close_for(gone);
        }
    };
    let name = attempt.unwrap_or_default();
    let opened = as_attempt(&state, name.clone(), leave, async move {
        // Which step it is on, for the record of connection attempts (#270).
        let steps = Steps::reporting(move |s| drop(on_step.send(s)));
        let opening = open_connection(target, credential, profile, on_event, expect_server, quick.unwrap_or(false), ssh_route, steps);
        tokio::time::timeout(CONNECT_TIMEOUT, opening)
            .await
            .unwrap_or_else(|_| Err(format!("Hermes didn't finish connecting within {}s.", CONNECT_TIMEOUT.as_secs())))
    })
    .await;
    // The replaced connections' server pages go with them. This connection's own stay only if it opened again
    // through the SSH target they go through.
    let close_pages = |keep_target: Option<&str>, why: &str| {
        for gone in evicted.iter().filter(|gone| **gone != id) {
            pages.close_for(gone, None, why);
        }
        pages.close_for(&id, keep_target, why);
    };
    match opened {
        Attempt::StoppedFirst => Err(CONNECT_STOPPED.into()),
        Attempt::Ran(Ok((live, route))) => {
            let ssh_target = live.ssh_target.clone();
            state.slots.insert(id.clone(), Slot::new(live::Attempt::new(name), live));
            close_pages(ssh_target.as_deref(), SIGNED_IN_ELSEWHERE);
            Ok(route)
        }
        Attempt::Ran(Err(e)) => {
            close_pages(None, SIGNED_OUT);
            Err(e)
        }
    }
}

/// How long a reopen's ticket and socket may each take: a closed socket usually means the rest of the connection still
/// answers, and when it doesn't, opening it all again soon beats waiting.
const REOPEN_LIMITS: transport::StepLimits = transport::StepLimits { ticket: QUICK_REACH, socket: QUICK_REACH, ..transport::StepLimits::ROUTES };

/// Opens `/api/ws` for `profile` again on the connection the webview opened as `connection`, after its socket closed. The SSH tunnel and the
/// sign-in are kept, so this mints a ticket and opens the socket, nothing more. Transfers stop as on any reconnect (ADR
/// 0023), and so do Screens, whose lease came over the closed socket. Any failure, a stop included, closes the whole
/// connection and its server pages, so the webview opens it again from the start with `hermes_connect`. `attempt`
/// names this reopen, for `hermes_connect_cancel`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn hermes_reopen(
    state: State<'_, AppState>,
    transfers: State<'_, Transfers>,
    displays: State<'_, display::Displays>,
    pages: State<'_, Arc<server_page::ServerPages>>,
    profile: String,
    connection: String,
    attempt: String,
    on_event: Channel<PipeEvent>,
    on_step: Channel<connect_steps::Started>,
) -> Result<(), String> {
    let closed = || transport::TransportError::Closed.to_string();
    let (id, slot) = state.slots.find(&live::Attempt::new(connection)).map_err(|e| e.to_string())?;
    // Held for the whole reopen, so this connection's commands wait for its new socket. No other connection's do.
    let mut live = slot.live.lock().await;
    // Only the connection whose socket closed reopens: one replaced meanwhile isn't touched (#474).
    if !state.slots.is_current(&id, &slot) {
        return Err(closed());
    }
    transfers.stop(&id);
    displays.close_for(&id);
    let dashboard = live.dashboard.clone();
    let opened = as_attempt(&state, attempt, || {}, async move {
        let steps = Steps::reporting(move |s| drop(on_step.send(s)));
        dashboard.open_pipe_within(&profile, move |e| drop(on_event.send(e)), Some(REOPEN_LIMITS), &steps).await.map_err(|e| e.to_string())
    })
    .await;
    let opened = match opened {
        Attempt::StoppedFirst => Err(CONNECT_STOPPED.into()),
        Attempt::Ran(opened) => opened,
    };
    match opened {
        Ok(pipe) if state.slots.is_current(&id, &slot) => {
            live.pipe = pipe;
            Ok(())
        }
        // Replaced or closed while its socket reopened: the new socket is dropped, and whoever took the connection
        // out closes what it had.
        Ok(_) => Err(closed()),
        Err(e) => {
            if state.slots.remove_if(&id, &slot) {
                pages.close_for(&id, None, SIGNED_OUT);
            }
            Err(e)
        }
    }
}

/// How an attempt `as_attempt` was given went: stopped by `hermes_connect_cancel` before it began, or run.
enum Attempt<T> {
    StoppedFirst,
    Ran(Result<T, String>),
}

/// Runs `begin`, then `opening` apart, as the attempt the webview names `attempt`, so `hermes_connect_cancel` can stop it.
async fn as_attempt<T: Send + 'static>(
    state: &AppState,
    attempt: String,
    begin: impl FnOnce(),
    opening: impl std::future::Future<Output = Result<T, String>> + Send + 'static,
) -> Attempt<T> {
    let task = {
        let mut connecting = state.connecting.locked();
        if let Some(i) = connecting.stopped.iter().position(|a| *a == attempt) {
            connecting.stopped.remove(i);
            return Attempt::StoppedFirst;
        }
        begin();
        let task = tokio::spawn(opening);
        connecting.now.insert(attempt.clone(), task.abort_handle());
        task
    };
    let opened = task.await;
    state.connecting.locked().now.remove(&attempt);
    Attempt::Ran(match opened {
        Ok(opened) => opened,
        Err(e) if e.is_cancelled() => Err(CONNECT_STOPPED.into()),
        Err(e) => Err(e.to_string()),
    })
}

/// Opens the tunnel or resolves the URL, checks the dashboard there is Hermes, and the one `expect_server` names, then
/// signs in and opens `/api/ws`, for `hermes_connect`. `ssh_route`: the connection's SSH target when this route isn't
/// SSH, for the Preview's server pages (ADR 0120). Each step runs through `steps`, which says when it starts.
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
) -> Result<(Live, Route), String> {
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
    Ok((Live { dashboard: Arc::new(dashboard), pipe, _tunnel: tunnel, ssh_target, typed_token }, route))
}

/// Stops the opening running as `attempt`, a connect or a reopen, or, if it hasn't begun, stops it before it does.
/// Another attempt's is left alone.
#[tauri::command]
fn hermes_connect_cancel(state: State<'_, AppState>, attempt: String) {
    let mut connecting = state.connecting.locked();
    match connecting.now.get(&attempt) {
        Some(task) => task.abort(),
        None => {
            if connecting.stopped.len() >= STOPPED_KEPT {
                connecting.stopped.pop_front();
            }
            connecting.stopped.push_back(attempt);
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
    if let Some(before) = state.probe.locked().replace(task.abort_handle()) {
        before.abort();
    }
    match task.await {
        Ok(result) => result,
        Err(e) if e.is_cancelled() => Err(ProbeFailure::new(Stage::Cancelled, "The test was stopped.")),
        Err(e) => Err(ProbeFailure::new(Stage::Address, e.to_string())),
    }
}

/// One route reached without signing in, for a route's Test and for checking whether a preferred route is back: the
/// tunnel or address opened, and `/api/status` answered as the Hermes `expect_server` names (ADR 0120). No password
/// is sent, and the app's own connection carries on.
#[derive(Serialize)]
struct Reached {
    route: Route,
    status: String,
    /// The sign-in methods it offers (ADR 0058), when asked for.
    #[serde(skip_serializing_if = "Option::is_none")]
    methods: Option<transport::Methods>,
}

#[tauri::command]
async fn hermes_reach(target: Target, expect_server: Option<String>, quick: Option<bool>, methods: Option<bool>) -> Result<Reached, ProbeFailure> {
    let quick = quick.unwrap_or(false);
    let (base, _tunnel, route, headers) = open_target(target, quick, &Steps::default()).await.map_err(|e| ProbeFailure::new(Stage::Address, e))?;
    let http = transport::client(&headers).map_err(|e| ProbeFailure::of(Stage::Address, e))?;
    let seen =
        transport::read_server(&http, &base, &headers, expect_server.as_deref(), reach_within(quick)).await.map_err(|e| ProbeFailure::of(Stage::Reach, e))?;
    let methods = match methods {
        Some(true) => Some(transport::read_methods(&base, &headers, Some(&seen.status), reach_within(quick)).await),
        _ => None,
    };
    Ok(Reached { route: route.with_server(seen.server), status: seen.status, methods })
}

#[tauri::command]
fn hermes_probe_cancel(state: State<'_, AppState>) {
    if let Some(task) = state.probe.locked().take() {
        task.abort();
    }
}

/// Gives the signed-in Hermes a model provider's API key for `profile` (`Dashboard::save_provider_key`). The key
/// goes to the server and isn't kept on this computer.
#[tauri::command]
async fn hermes_save_provider_key(state: State<'_, AppState>, attempt: String, profile: String, key: String, value: String) -> Result<SavedKey, RelayError> {
    let dashboard = dashboard(&state, &attempt).await?;
    dashboard.save_provider_key(&profile, &key, &value).await.map_err(RelayError::from)
}

/// Takes a model provider's API key out of the signed-in Hermes for `profile` (`Dashboard::remove_provider_key`). The
/// window's REST relay refuses `DELETE api/env`, so this is the only way (ADR 0095).
#[tauri::command]
async fn hermes_remove_provider_key(state: State<'_, AppState>, attempt: String, profile: String, key: String) -> Result<(), RelayError> {
    let dashboard = dashboard(&state, &attempt).await?;
    dashboard.remove_provider_key(&profile, &key).await.map_err(RelayError::from)
}

/// `profile`'s subscription providers and whether each is signed in, without token previews (ADR 0133).
#[tauri::command]
async fn hermes_provider_sign_ins(state: State<'_, AppState>, attempt: String, profile: String) -> Result<Vec<transport::ProviderSignIn>, RelayError> {
    dashboard(&state, &attempt).await?.provider_sign_ins(&profile).await.map_err(RelayError::from)
}

/// `profile`'s OpenAI-compatible endpoints, without key previews (ADR 0133).
#[tauri::command]
async fn hermes_custom_endpoints(state: State<'_, AppState>, attempt: String, profile: String) -> Result<Vec<transport::CustomEndpoint>, RelayError> {
    dashboard(&state, &attempt).await?.custom_endpoints(&profile).await.map_err(RelayError::from)
}

/// Checks an OpenAI-compatible endpoint and adds it to `profile` (`Dashboard::save_endpoint`, ADR 0133). Its key goes
/// to the server and isn't kept on this computer.
#[tauri::command]
async fn hermes_save_endpoint(
    state: State<'_, AppState>,
    attempt: String,
    profile: String,
    form: transport::EndpointForm,
    anyway: bool,
) -> Result<transport::EndpointSave, RelayError> {
    dashboard(&state, &attempt).await?.save_endpoint(&profile, &form, anyway).await.map_err(RelayError::from)
}

#[tauri::command]
async fn hermes_send(state: State<'_, AppState>, attempt: String, frame: String) -> Result<(), String> {
    // The send waits while the pipe's queue is full; don't hold the connection meanwhile.
    let pipe = state.slots.read(&live::Attempt::new(attempt), |_, live| live.pipe.sender()).await.map_err(|e| e.to_string())?;
    pipe.send(frame).await.map_err(|e| e.to_string())
}

/// Sends a frame with a file the owner attached (`Attachable`) in it.
#[tauri::command]
async fn hermes_send_file(
    state: State<'_, AppState>,
    attachable: State<'_, Attachable>,
    attempt: String,
    head: String,
    path: String,
    tail: String,
    max_bytes: u64,
) -> Result<(), String> {
    attachable.check(&path).map_err(|e| e.to_string())?;
    // Reading a big file takes a while; don't hold the lock, so a Stop can still go out.
    let pipe = state.slots.read(&live::Attempt::new(attempt), |_, live| live.pipe.sender()).await.map_err(|e| e.to_string())?;
    let written = pipe.send_file(&head, &path, &tail, max_bytes).await.map_err(|e| e.to_string())?;
    written.wait().await.map_err(|e| e.to_string())
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

/// Attaches the files the owner copied in a file manager and pasted into the composer, by path, as a drop does (ADR
/// 0143). `[]`: the clipboard holds no local files. Elsewhere than Linux the webview's paste event carries the files.
#[tauri::command]
async fn attach_copied_files(app: tauri::AppHandle, attachable: State<'_, Attachable>) -> Result<Vec<String>, String> {
    #[cfg(target_os = "linux")]
    let paths = copied_files::read(&app).await?;
    #[cfg(not(target_os = "linux"))]
    let paths = {
        let _ = app;
        Vec::new()
    };
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

/// Deletes a staged screenshot: removed from the composer, or its message sent. Paths that aren't one are ignored. The
/// folder is deleted off the main thread.
#[tauri::command]
async fn screenshot_discard(app: tauri::AppHandle, path: String) {
    let _ = tokio::task::spawn_blocking(move || {
        if let Some(c) = &*app.state::<Screenshots>().captures.locked() {
            c.discard(std::path::Path::new(&path));
        }
    })
    .await;
}

/// How screenshots are taken on this desktop, for Settings.
#[tauri::command]
async fn screenshot_support() -> screenshot::Support {
    tokio::task::spawn_blocking(screenshot::support).await.unwrap_or_else(|e| screenshot::Support { ok: false, summary: e.to_string() })
}

/// The renderer supplies all persisted outboxes at startup and whenever they change, before cleanup. The folders are
/// swept off the main thread.
#[tauri::command]
async fn screenshot_sync_outbox(app: tauri::AppHandle, paths: Vec<String>) -> Result<(), screenshot::CaptureError> {
    let sync = move || {
        // Also those of drafts an update's restart couldn't put back (update.rs).
        let saved = update::saved_attachment_paths(&app);
        app.state::<Screenshots>().captures()?.retain_outbox(paths.into_iter().map(std::path::PathBuf::from).chain(saved));
        Ok(())
    };
    tokio::task::spawn_blocking(sync).await.map_err(|e| screenshot::CaptureError::Failed(e.to_string()))?
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

/// Stages a file pasted into the composer with the screenshots and returns its path. Its bytes come as the raw body,
/// not JSON, so a big screenshot isn't sent as a list of numbers; its name comes URI-encoded in the `x-name` header.
#[tauri::command]
async fn stage_clipboard_file(
    screenshots: State<'_, Screenshots>,
    attachable: State<'_, Attachable>,
    request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("The pasted file didn't arrive as bytes.".into());
    };
    let header = request.headers().get("x-name").and_then(|v| v.to_str().ok()).unwrap_or_default();
    // encodeURIComponent never writes `+`, `&` or `=` bare, so one form-decoded key is exactly the name.
    let name = url::form_urlencoded::parse(header.as_bytes()).next().map(|(k, _)| k.into_owned()).unwrap_or_default();
    let captures = screenshots.captures().map_err(|e| e.to_string())?;
    let path = transport::stage_clipboard_file(&captures, &name, bytes).map_err(|e| e.to_string())?.to_string_lossy().into_owned();
    attachable.add([path.clone()]);
    Ok(path)
}

#[tauri::command]
async fn hermes_request(state: State<'_, AppState>, attempt: String, method: String, path: String, body: Option<String>) -> Result<String, RelayError> {
    let dashboard = dashboard(&state, &attempt).await?;
    dashboard.request(&method, &path, body).await.map_err(RelayError::from)
}

/// The dashboard of the connection opened as `attempt` (`Slots::read`), without holding its lock across a request, so
/// frames keep flowing while it runs.
async fn dashboard(state: &AppState, attempt: &str) -> Result<Arc<Dashboard>, String> {
    state.slots.read(&live::Attempt::new(attempt), |_, live| live.dashboard.clone()).await.map_err(|e| e.to_string())
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
    let attempt = header_value(&request, "x-attempt");
    let server = async {
        let profile = profile.ok_or("The recording didn't name a profile.")?;
        let dashboard = dashboard(&state, attempt.as_deref().unwrap_or_default()).await?;
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
async fn hermes_speak(state: State<'_, AppState>, attempt: String, profile: String, text: String) -> Result<SpeechOut, RelayError> {
    use base64::Engine;
    let dashboard = dashboard(&state, &attempt).await?;
    let speech = dashboard.speak(&profile, &text).await.map_err(RelayError::from)?;
    let audio = base64::engine::general_purpose::STANDARD.encode(&speech.audio);
    Ok(SpeechOut { mime: speech.mime, audio, provider: speech.provider })
}

#[tauri::command]
async fn hermes_voice_setup(state: State<'_, AppState>, attempt: String, profile: String) -> Result<transport::VoiceSetup, RelayError> {
    let dashboard = dashboard(&state, &attempt).await?;
    dashboard.voice_setup(&profile).await.map_err(RelayError::from)
}

/// A read-only dashboard GET whose answer may be big, e.g. a server file for the Server files screen's preview: refused
/// once it passes `max_bytes`.
#[tauri::command]
async fn hermes_get_limited(state: State<'_, AppState>, attempt: String, path: String, max_bytes: u64) -> Result<String, RelayError> {
    let dashboard = dashboard(&state, &attempt).await?;
    dashboard.get_limited(&path, max_bytes).await.map_err(RelayError::from)
}

#[tauri::command]
async fn hermes_toolset_guards(state: State<'_, AppState>, attempt: String, profile: String) -> Result<transport::ToolsetGuards, RelayError> {
    let dashboard = dashboard(&state, &attempt).await?;
    dashboard.toolset_guards(&profile).await.map_err(RelayError::from)
}

/// Settings → MCP servers' edit of one server for `profile` (`Dashboard::mcp_edit`, ADR 0121). The webview sends
/// only that server's fields, secrets it didn't retype left out; Rust reads and writes Hermes's whole map.
#[tauri::command]
async fn hermes_mcp_edit(state: State<'_, AppState>, attempt: String, profile: String, edit: mcp::Edit) -> Result<(), RelayError> {
    let dashboard = dashboard(&state, &attempt).await?;
    dashboard.mcp_edit(&profile, &edit).await.map_err(RelayError::from)
}

/// Closes the connection the webview opened as `attempt`, and what was open on it. One Rust no longer holds is left
/// as it is: a close that comes late, for a connection replaced since, never closes the one that replaced it.
#[tauri::command]
async fn hermes_disconnect(
    state: State<'_, AppState>,
    transfers: State<'_, Transfers>,
    displays: State<'_, display::Displays>,
    pages: State<'_, Arc<server_page::ServerPages>>,
    attempt: String,
) -> Result<(), String> {
    if let Some(id) = state.slots.remove_attempt(&live::Attempt::new(attempt)) {
        transfers.stop(&id);
        displays.close_for(&id);
        pages.close_for(&id, None, SIGNED_OUT);
    }
    Ok(())
}

const SIGNED_OUT: &str = "Hermes Chat left the Hermes server, so the tunnel to it closed.";
const SIGNED_IN_ELSEWHERE: &str = "Hermes Chat is now connected to another server, so the tunnel to this one closed.";

/// Opens `url`, a page on the Hermes server's own loopback, through an SSH tunnel to the SSH target of the connection
/// the webview opened as `attempt` (server_page.rs, ADR 0114). The webview names only the page and its own `key` for
/// it; Rust parses the page again, and picks the target. The tunnel is registered for that connection, so its
/// sign-out, or another sign-in that replaces it, closes the tunnel, even while ssh is still connecting. `on_event`
/// hears once if it ends without `preview_server_close`.
#[tauri::command]
async fn preview_server_open(
    state: State<'_, AppState>,
    pages: State<'_, Arc<server_page::ServerPages>>,
    url: String,
    key: String,
    attempt: String,
    on_event: Channel<server_page::PageEvent>,
) -> Result<server_page::Opened, server_page::ServerPageError> {
    use server_page::ServerPageError;
    let page = server_page::server_page(&url)?;
    let attempt = live::Attempt::new(attempt);
    let held = state.slots.read(&attempt, |id, live| (id.clone(), live.ssh_target.clone())).await;
    let Ok((id, target)) = held else { return Err(ServerPageError::NotConnected) };
    let starting = pages.begin(&key, &id, target.as_deref().ok_or(ServerPageError::NoSshTarget)?)?;
    // The connection may have gone since it was read, before this tunnel was there to close with it.
    if state.slots.find(&attempt).is_err() {
        pages.give_up(starting);
        return Err(ServerPageError::NotConnected);
    }
    let pages = pages.inner().clone();
    pages
        .open("ssh", starting, page, move |e| {
            let _ = on_event.send(e);
        })
        .await
}

#[tauri::command]
async fn preview_dev_servers(state: State<'_, AppState>, attempt: String) -> Result<dev_servers::DevServers, String> {
    use dev_servers::{plausible, ServerSide};
    let target = match state.slots.read(&live::Attempt::new(attempt), |_, live| live.ssh_target.clone()).await {
        Err(_) => Err(ServerSide::NotConnected),
        Ok(target) => target.ok_or(ServerSide::NoSshTarget),
    };
    let local = tauri::async_runtime::spawn_blocking(dev_servers::local);
    let server = match target {
        Err(side) => side,
        Ok(target) => match server_page::listening("ssh", &target).await {
            Ok(out) => ServerSide::Listed { ports: dev_servers::parse_ss(&out).into_iter().filter(|l| plausible(l, &[DASHBOARD_PORT])).collect() },
            Err(e) => ServerSide::Failed { message: e.to_string() },
        },
    };
    let local = local.await.map_err(|e| e.to_string())?.into_iter().filter(|l| plausible(l, &[])).collect();
    Ok(dev_servers::DevServers { server, local })
}

/// Closes the page `key` opened, or is opening; if Rust hasn't seen its `preview_server_open` yet, that is refused.
#[tauri::command]
fn preview_server_close(pages: State<'_, Arc<server_page::ServerPages>>, key: String) {
    pages.close(&key);
}

/// Server file transfers running now, by the webview's id for each, so Cancel can stop one. A connection's are stopped
/// when it is replaced or closed, so a transfer never outlives the sign-in it started on (ADR 0023).
#[derive(Default)]
struct Transfers {
    /// Each running transfer's abort handle, with the run that registered it and the connection it is on.
    tasks: std::sync::Mutex<std::collections::HashMap<u64, (u64, ConnectionId, tokio::task::AbortHandle)>>,
    /// Counts the times each connection's transfers were stopped. A transfer that started before its connection's
    /// latest stop must not go on, even if it was still waiting on a dialog then. Locked only while `tasks` is, or
    /// alone.
    epochs: std::sync::Mutex<std::collections::HashMap<ConnectionId, u64>>,
    runs: std::sync::atomic::AtomicU64,
}

/// When work was asked for: the connection it is for, and how many times that connection's transfers had been stopped.
#[derive(Clone)]
struct Asked {
    connection: ConnectionId,
    epoch: u64,
}

/// Work asked for now on the connection the webview opened as `attempt`. Refused as `Closed` when no such connection
/// is held.
fn asked(app: &tauri::AppHandle, attempt: &str) -> Result<Asked, String> {
    let (connection, _) = app.state::<AppState>().slots.find(&live::Attempt::new(attempt)).map_err(|e| e.to_string())?;
    let epoch = app.state::<Transfers>().epoch(&connection);
    Ok(Asked { connection, epoch })
}

impl Transfers {
    /// Stops `connection`'s transfers, and keeps those asked for before now from starting. Another connection's go on.
    fn stop(&self, connection: &ConnectionId) {
        let mut tasks = self.tasks.locked();
        *self.epochs.locked().entry(connection.clone()).or_default() += 1;
        tasks.retain(|_, (_, on, task)| {
            let stays = on != connection;
            if !stays {
                task.abort();
            }
            stays
        });
    }

    fn epoch(&self, connection: &ConnectionId) -> u64 {
        self.epochs.locked().get(connection).copied().unwrap_or(0)
    }

    /// Refuses work once its connection was closed, replaced or reopened since it was asked for.
    fn still(&self, asked: &Asked) -> Result<(), String> {
        if self.epoch(&asked.connection) == asked.epoch {
            Ok(())
        } else {
            Err(TRANSFER_STOPPED.into())
        }
    }

    /// Runs `work` as transfer `id` until it ends or `files_cancel` or `stop` stops it, if its connection wasn't
    /// stopped since it was `asked` for (checked under the same lock `stop` takes, so a stop either reaches the work
    /// or keeps it from starting). Given an `id` still running, the older transfer is stopped; each run removes only
    /// its own entry.
    async fn run<T: Send + 'static, E: From<String> + Send + 'static>(
        &self,
        id: u64,
        asked: &Asked,
        work: impl std::future::Future<Output = Result<T, E>> + Send + 'static,
    ) -> Result<T, E> {
        let run = self.runs.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let task = {
            let mut tasks = self.tasks.locked();
            if self.still(asked).is_err() {
                return Err(TRANSFER_STOPPED.to_owned().into());
            }
            let task = tokio::spawn(work);
            if let Some((_, _, old)) = tasks.insert(id, (run, asked.connection.clone(), task.abort_handle())) {
                old.abort();
            }
            task
        };
        let ended = task.await;
        let mut tasks = self.tasks.locked();
        if tasks.get(&id).is_some_and(|(r, _, _)| *r == run) {
            tasks.remove(&id);
        }
        drop(tasks);
        match ended {
            Ok(result) => result,
            Err(e) if e.is_cancelled() => Err(TRANSFER_STOPPED.to_owned().into()),
            Err(e) => Err(e.to_string().into()),
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

/// The dashboard of the connection opened as `attempt`, if it is the one the work was `asked` for and its transfers
/// weren't stopped since either: a reopen keeps the connection but stops its transfers. Waiting for the connection
/// can outlast a reopen, so this checks again after.
async fn dashboard_since(app: &tauri::AppHandle, attempt: &str, asked: &Asked) -> Result<Arc<Dashboard>, String> {
    let closed = |e: transport::TransportError| e.to_string();
    // A file picked for one connection never goes to another.
    let on_asked = |held: &ConnectionId, live: &Live| (*held == asked.connection).then(|| live.dashboard.clone());
    let dashboard = app.state::<AppState>().slots.read(&live::Attempt::new(attempt), on_asked).await.map_err(closed)?;
    let dashboard = dashboard.ok_or_else(|| closed(transport::TransportError::Closed))?;
    app.state::<Transfers>().still(asked)?;
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
    attempt: String,
    transfers: State<'_, Transfers>,
    id: u64,
    path: String,
    name: String,
    on_progress: Channel<TransferProgress>,
) -> Result<Option<Downloaded>, RelayError> {
    let asked = asked(&app, &attempt)?;
    let since = asked.clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app.dialog().file().set_title("Download from the Hermes server").set_file_name(suggested_name(&name, "download"));
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    dialog.save_file(move |dest| {
        let _ = tx.send(dest);
    });
    let Some(dest) = rx.await.map_err(|e| e.to_string())? else { return Ok(None) };
    let dest = dest.into_path().map_err(|e| e.to_string())?;
    let work = async move {
        let dashboard = dashboard_since(&app, &attempt, &since).await?;
        let shown = dest.display().to_string();
        // Picked: from here on it is a running download, which Cancel can stop.
        let _ = on_progress.send(TransferProgress { done: 0, total: None, dest: shown.clone() });
        let report = |done, total| {
            let _ = on_progress.send(TransferProgress { done, total, dest: shown.clone() });
        };
        let bytes = dashboard.download(&path, &dest, report).await.map_err(RelayError::from)?;
        Ok(Some(Downloaded { dest: shown, bytes }))
    };
    transfers.run(id, &asked, work).await
}

/// Local files the owner picked to upload, by the token the webview gets for each, so it never names a local path.
/// Each is kept with the connection it was picked for and that connection's transfer epoch then: a pick is good for
/// one upload, over that connection as it was when the file was picked.
#[derive(Default)]
struct UploadPicks(std::sync::Mutex<(u64, std::collections::HashMap<u64, Pick>)>);

/// A picked file: its local path, and when it was picked.
type Pick = (std::path::PathBuf, Asked);

/// A local file picked to upload: its token, name and size.
#[derive(Serialize)]
struct PickedUpload {
    token: u64,
    name: String,
    size: u64,
}

/// Opens the native Open dialog for a file to upload to the server the webview's connection `attempt` is to. Nothing
/// is sent yet: the webview shows where it would go first. `None`: the owner cancelled.
#[tauri::command]
async fn files_pick_upload(
    app: tauri::AppHandle,
    picks: State<'_, UploadPicks>,
    transfers: State<'_, Transfers>,
    attempt: String,
) -> Result<Option<PickedUpload>, String> {
    let asked = asked(&app, &attempt)?;
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
    let mut picks = picks.0.locked();
    picks.0 += 1;
    let token = picks.0;
    // Picks never sent are let go once the connection they were picked for is gone.
    picks.1.retain(|_, (_, picked)| transfers.still(picked).is_ok());
    picks.1.insert(token, (path, asked));
    Ok(Some(PickedUpload { token, name, size: meta.len() }))
}

/// Lets go of a pick that won't be sent: the owner cancelled the upload dialog. A token already taken or let go is fine.
#[tauri::command]
fn files_discard_pick(picks: State<'_, UploadPicks>, token: u64) {
    picks.0.locked().1.remove(&token);
}

/// Uploads the file picked as `token` to the server path `path` (`Dashboard::upload`, ADR 0023). `overwrite` false:
/// Hermes refuses when a file is already there. Resolves to Hermes's answer, the written entry as JSON.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn files_upload(
    app: tauri::AppHandle,
    attempt: String,
    transfers: State<'_, Transfers>,
    picks: State<'_, UploadPicks>,
    id: u64,
    token: u64,
    path: String,
    overwrite: bool,
    on_progress: Channel<TransferProgress>,
) -> Result<String, RelayError> {
    // Taken, not looked up: a pick is good for one upload.
    let (local, asked) = picks.0.locked().1.remove(&token).ok_or("That file wasn't picked in the Open dialog, or was already sent.")?;
    let since = asked.clone();
    let dest = path.clone();
    // Registered before it waits for the connection, so a stop meanwhile reaches it; and only the connection that was
    // current when it was asked for is used.
    let work = async move {
        let dashboard = dashboard_since(&app, &attempt, &since).await?;
        let report = move |done, total| {
            let _ = on_progress.send(TransferProgress { done, total, dest: dest.clone() });
        };
        dashboard.upload(&path, transport::UploadSource::File(local), overwrite, report).await.map_err(RelayError::from)
    };
    transfers.run(id, &asked, work).await
}

/// Writes an edited text file's whole new text to the server path `path` (Server files editing, ADR 0024): the same
/// upload route, with `overwrite` true for a save over the file the edit started from, false for a copy. The webview
/// checks the file's revision first and reads it back after; this only writes.
#[tauri::command]
async fn files_save_text(
    app: tauri::AppHandle,
    attempt: String,
    transfers: State<'_, Transfers>,
    id: u64,
    path: String,
    text: String,
    overwrite: bool,
) -> Result<String, RelayError> {
    let asked = asked(&app, &attempt)?;
    let since = asked.clone();
    let work = async move {
        let dashboard = dashboard_since(&app, &attempt, &since).await?;
        dashboard.upload(&path, transport::UploadSource::Bytes(text.into_bytes()), overwrite, |_, _| {}).await.map_err(RelayError::from)
    };
    transfers.run(id, &asked, work).await
}

/// Writes an artifact's whole new text to `path` where `profile`'s tools run (`POST api/fs/write-text`, ADR 0029). Like
/// `files_save_text`, the webview checks the revision first and reads it back after, and the write is a transfer, so
/// `files_cancel` stops it and a closed or replaced connection never sends it. `session`: the chat whose sandbox the
/// path is in, named as the read named it, so the save lands where the read did (ADR 0062).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn fs_save_text(
    app: tauri::AppHandle,
    attempt: String,
    transfers: State<'_, Transfers>,
    id: u64,
    profile: String,
    path: String,
    text: String,
    session: Option<String>,
) -> Result<String, RelayError> {
    let asked = asked(&app, &attempt)?;
    let since = asked.clone();
    let work = async move {
        let dashboard = dashboard_since(&app, &attempt, &since).await?;
        dashboard.write_agent_text(&profile, &path, &text, session.as_deref()).await.map_err(RelayError::from)
    };
    transfers.run(id, &asked, work).await
}

/// Opens the native Open dialog for files to add to a project's context (ADR 0135). The picked files become attachable
/// (ADR 0129), so `context_upload` may send them. `[]`: the owner cancelled.
#[tauri::command]
async fn context_pick(app: tauri::AppHandle, attachable: State<'_, Attachable>) -> Result<Vec<LocalFile>, String> {
    let paths = attach_picked_files(app, attachable.clone()).await?;
    Ok(transport::stat_files(&attachable, &paths).await)
}

/// Names and sizes of files dropped on a project's Context card (ADR 0135). A path that isn't attachable (ADR 0129)
/// comes back with an `error` and no size.
#[tauri::command]
async fn context_local_files(attachable: State<'_, Attachable>, paths: Vec<String>) -> Result<Vec<LocalFile>, String> {
    Ok(transport::stat_files(&attachable, &paths).await)
}

/// Uploads the attached file `local` (up to 30 MB) to `server_path` in a project's context folder (ADR 0135), as
/// transfer `id`, so `files_cancel` stops it and a closed or replaced connection never sends it (ADR 0023).
/// `ssh_profile`: the profile's tools run over SSH, so only UTF-8 text up to 8 MiB goes.
/// `overwrite` false: rejects with `exists` when a file is already there.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn context_upload(
    app: tauri::AppHandle,
    attempt: String,
    transfers: State<'_, Transfers>,
    attachable: State<'_, Attachable>,
    id: u64,
    local: String,
    server_path: String,
    overwrite: bool,
    ssh_profile: Option<String>,
    on_progress: Channel<TransferProgress>,
) -> Result<(), RelayError> {
    let asked = asked(&app, &attempt)?;
    let since = asked.clone();
    let file = project_context::AttachedFile::check(&attachable, &local)?;
    let to = project_context::ContextPath::parse(&server_path)?;
    let work = async move {
        let dashboard = dashboard_since(&app, &attempt, &since).await?;
        let report = move |done, total| {
            let _ = on_progress.send(TransferProgress { done, total, dest: server_path.clone() });
        };
        project_context::upload(&dashboard, file, &to, overwrite, ssh_profile.as_deref(), report).await
    };
    transfers.run(id, &asked, work).await
}

/// Writes `text` as `server_path` in a project's context folder (ADR 0135). `overwrite` false: rejects with `exists`
/// when a file is already there.
#[tauri::command]
async fn context_write_text(
    app: tauri::AppHandle,
    attempt: String,
    server_path: String,
    text: String,
    overwrite: bool,
    ssh_profile: Option<String>,
) -> Result<(), RelayError> {
    let asked = asked(&app, &attempt)?;
    let to = project_context::ContextPath::parse(&server_path)?;
    project_context::write_text(&*dashboard_since(&app, &attempt, &asked).await?, &to, text, overwrite, ssh_profile.as_deref()).await
}

/// Creates a project's context folder `path`, and any missing parents, in managed files (ADR 0135). Returns the path
/// Hermes created.
#[tauri::command]
async fn context_mkdir(app: tauri::AppHandle, attempt: String, path: String) -> Result<String, RelayError> {
    let asked = asked(&app, &attempt)?;
    let dir = project_context::ContextDir::parse(&path)?;
    project_context::mkdir(&*dashboard_since(&app, &attempt, &asked).await?, &dir).await
}

/// Deletes the file `server_path` from a project's context folder in managed files (ADR 0135).
#[tauri::command]
async fn context_remove(app: tauri::AppHandle, attempt: String, server_path: String) -> Result<(), RelayError> {
    let asked = asked(&app, &attempt)?;
    let file = project_context::ContextPath::parse(&server_path)?;
    project_context::remove(&*dashboard_since(&app, &attempt, &asked).await?, &file).await
}

/// The text of `server_path` in a project's context folder, `size` bytes as listed, for full-text mode (ADR 0135).
/// `None`: it holds no text Hermes Chat can read.
#[tauri::command]
async fn context_read_text(
    app: tauri::AppHandle,
    attempt: String,
    server_path: String,
    size: u64,
    ssh_profile: Option<String>,
) -> Result<Option<String>, RelayError> {
    let asked = asked(&app, &attempt)?;
    let file = project_context::ContextPath::parse(&server_path)?;
    project_context::read_text(&*dashboard_since(&app, &attempt, &asked).await?, &file, size, ssh_profile.as_deref()).await
}

/// A context file where `ssh_profile`'s tools run: its size there, and its text when it is plain text up to 512 KiB
/// (ADR 0135).
#[tauri::command]
async fn context_ssh_file(app: tauri::AppHandle, attempt: String, server_path: String, ssh_profile: String) -> Result<project_context::SshFile, RelayError> {
    let asked = asked(&app, &attempt)?;
    let file = project_context::ContextPath::parse(&server_path)?;
    project_context::ssh_file(&*dashboard_since(&app, &attempt, &asked).await?, &file, &ssh_profile).await
}

/// Keeps `<main_folder>/context/` out of the Git repository it is in, through that repository's `info/exclude`, the
/// only file it writes (ADR 0135). `none`: not in a repository.
#[tauri::command]
async fn context_git_exclude(
    app: tauri::AppHandle,
    attempt: String,
    main_folder: String,
    ssh_profile: Option<String>,
) -> Result<project_context::GitExclude, RelayError> {
    let asked = asked(&app, &attempt)?;
    project_context::git_exclude(&*dashboard_since(&app, &attempt, &asked).await?, &main_folder, ssh_profile.as_deref()).await
}

/// Stops transfer `id`, if it is still running. A download's part file is removed; `dest` is left as it was.
#[tauri::command]
fn files_cancel(transfers: State<'_, Transfers>, id: u64) {
    if let Some((_, _, task)) = transfers.tasks.locked().remove(&id) {
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

/// Saves the token the connection the webview opened as `attempt` signed in with, when it was typed for this sign-in, in the keyring as
/// `dashboard-token/<id>` for `addresses`: the routes it was entered for, which must include the one it signed in at.
/// Nothing typed: nothing to save. The webview never reads the token back (ADR 0058).
#[tauri::command]
async fn token_keep(state: State<'_, AppState>, connection: Option<String>, attempt: String, addresses: Vec<Address>) -> Result<(), String> {
    let account = saved_password::account(saved_password::TOKEN, connection.as_deref())?;
    let typed = state.slots.read(&live::Attempt::new(attempt), |_, live| live.typed_token.clone()).await.map_err(|e| e.to_string())?;
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

/// A file name the webview or the server suggests, made fit to show in a Save dialog (#481): only its last part on
/// either separator, so it names no folder; without control, invisible or direction-changing characters, which can make
/// `invoice\u{202E}fdp.exe` read `invoiceexe.pdf`; and without `:` or the other characters Windows refuses, where `:`
/// would name a drive or a stream. Leading and trailing spaces and dots go too. `fallback` when nothing is left.
fn suggested_name(name: &str, fallback: &str) -> String {
    let hidden = |c: char| {
        c.is_control()
            || matches!(c, '\u{00AD}' | '\u{061C}' | '\u{180E}' | '\u{200B}'..='\u{200F}' | '\u{2028}'..='\u{202E}' | '\u{2060}'..='\u{206F}' | '\u{FEFF}' | '\u{FFF9}'..='\u{FFFB}')
    };
    let last = name.rsplit(['/', '\\']).next().unwrap_or_default();
    let kept: String = last.chars().filter(|&c| !hidden(c) && !matches!(c, ':' | '<' | '>' | '"' | '|' | '?' | '*')).collect();
    let mut kept = kept.trim_matches(|c: char| c.is_whitespace() || c == '.').to_owned();
    if kept.len() > 200 {
        let end = (0..=200).rev().find(|&i| kept.is_char_boundary(i)).unwrap_or(0);
        kept.truncate(end);
    }
    if kept.is_empty() {
        fallback.to_owned()
    } else {
        kept
    }
}

/// Writes `contents` where the owner picks in the native Save dialog, which asks before replacing a file. The webview
/// never names the path. `None`: the owner cancelled, and nothing was written.
async fn save_with_dialog(
    app: &tauri::AppHandle,
    title: &str,
    file_name: String,
    filter: (&str, &[&str]),
    contents: impl AsRef<[u8]>,
) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let file_name = suggested_name(&file_name, filter.1.first().map_or("export".to_owned(), |ext| format!("export.{ext}")).as_str());
    let mut dialog = app.dialog().file().set_title(title).set_file_name(file_name).add_filter(filter.0, filter.1);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    dialog.save_file(move |path| {
        let _ = tx.send(path);
    });
    let Some(path) = rx.await.map_err(|e| e.to_string())? else { return Ok(None) };
    let path = path.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, contents).map_err(|e| e.to_string())?;
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
    file.take(max_bytes.saturating_add(1)).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > max_bytes {
        return Err(too_big());
    }
    let text = String::from_utf8(bytes).map_err(|_| "It isn't UTF-8 text.".to_string())?;
    Ok(text.strip_prefix('\u{feff}').map(str::to_owned).unwrap_or(text))
}

/// The formats a chat exports as text, an HTML page among them (src/hermes/exportChat.ts `ExportFormat`). Any other is refused.
#[derive(Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
enum ExportFormat {
    Markdown,
    Json,
    Html,
}

impl ExportFormat {
    fn filter(self) -> (&'static str, &'static [&'static str]) {
        match self {
            ExportFormat::Markdown => ("Markdown", &["md"]),
            ExportFormat::Json => ("JSON", &["json"]),
            ExportFormat::Html => ("HTML page", &["html"]),
        }
    }
}

const EXPORT_TITLE: &str = "Export chat — the file may contain sensitive information from the chat";

/// Saves an exported chat (src/hermes/exportChat.ts) where the owner picks.
#[tauri::command]
async fn chat_export(app: tauri::AppHandle, text: String, file_name: String, format: ExportFormat) -> Result<Option<String>, String> {
    save_with_dialog(&app, EXPORT_TITLE, file_name, format.filter(), text).await
}

/// A PNG's bytes from plain base64, refused unless they start with the PNG signature.
fn png_bytes(base64: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(base64).map_err(|_| "The image isn't valid base64.".to_string())?;
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("The image isn't a PNG.".into());
    }
    Ok(bytes)
}

/// Saves a chat exported as a PNG image (src/hermes/exportChat.ts `saveImage`) where the owner picks.
#[tauri::command]
async fn chat_export_image(app: tauri::AppHandle, png_base64: String, file_name: String) -> Result<Option<String>, String> {
    let png = png_bytes(&png_base64)?;
    save_with_dialog(&app, EXPORT_TITLE, file_name, ("PNG image", &["png"]), png).await
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

/// Whether a typed address's https:// form answers, so the address box opens it rather than http:// (ADR 0103).
#[tauri::command]
async fn preview_https_answers(url: String) -> Result<bool, String> {
    web_page::https_answers(&url).await
}

/// A Markdown image the owner clicked to load, as a `data:` URL (`markdown_image::load`, ADR 0136).
#[tauri::command]
async fn markdown_image_load(url: String) -> Result<String, String> {
    markdown_image::load(&url).await
}

/// Opens an http(s) page in the owner's default browser, and gives the browser's name where it is known.
#[tauri::command]
async fn preview_open_in_browser(app: tauri::AppHandle, url: String) -> Result<Option<String>, String> {
    web_page::open_in_browser(&app, &url).await
}

/// Makes the Preview's own WebKitGTK view for web pages (page_view.rs, ADR 0081), ending the one before it. `key`: its
/// name from now on.
#[tauri::command]
fn preview_page_open(app: tauri::AppHandle, key: String, on_event: Channel<page_view::PageEvent>) -> Result<(), String> {
    page_view::open(&app, key, on_event)
}

/// Shows `url` in the Preview's view, going back or forward in the view's own list when that is where it is.
#[tauri::command]
fn preview_page_go(pages: State<'_, Arc<server_page::ServerPages>>, key: String, url: String) -> Result<(), String> {
    page_view::go(key, &url, &pages)
}

#[tauri::command]
fn preview_page_reload(app: tauri::AppHandle, key: String) {
    page_view::reload(&app, key)
}

/// Shows the Preview's page at `placement`, or hides it (`None`).
#[tauri::command]
fn preview_page_place(app: tauri::AppHandle, key: String, placement: Option<page_view::Placement>) {
    page_view::place(&app, key, placement)
}

#[tauri::command]
fn preview_page_close(app: tauri::AppHandle, key: String) {
    page_view::close(&app, key)
}

/// Takes a still of the page in the Preview to annotate (ADR 0094), kept in the captures folder until it is staged or
/// discarded (`screenshot_discard`).
#[tauri::command]
async fn preview_annotate_still(app: tauri::AppHandle, state: State<'_, Screenshots>, key: String) -> Result<annotate::Still, annotate::AnnotateError> {
    let captures = state.captures().map_err(|e| annotate::AnnotateError::Failed(e.to_string()))?;
    page_view::annotate_still(&app, key, captures).await
}

/// What the page says is under a point of its still, for the outline while the owner points.
#[tauri::command]
async fn preview_annotate_query(
    app: tauri::AppHandle,
    key: String,
    still: u64,
    x: f64,
    y: f64,
    up: u32,
) -> Result<Option<annotate::Answer>, annotate::AnnotateError> {
    page_view::annotate_query(&app, key, still, x, y, up).await
}

/// The element the owner picked on the still, or its box as a region when the page changed there since.
#[tauri::command]
async fn preview_annotate_pick(app: tauri::AppHandle, key: String, still: u64, x: f64, y: f64, up: u32) -> Result<annotate::Pick, annotate::AnnotateError> {
    page_view::annotate_pick(&app, key, still, x, y, up).await
}

/// Stages a still as annotation `n`, marked at `rect`, as a Screenshot the composer can send, and deletes the still.
#[tauri::command]
async fn preview_annotate_stage(
    state: State<'_, Screenshots>,
    attachable: State<'_, Attachable>,
    still_path: String,
    n: u32,
    rect: annotate::Rect,
    scale: f64,
) -> Result<screenshot::Capture, screenshot::CaptureError> {
    let captures = state.captures()?;
    let staged = tokio::task::spawn_blocking(move || annotate::stage(&captures, std::path::Path::new(&still_path), n, rect, scale))
        .await
        .map_err(|e| screenshot::CaptureError::Failed(e.to_string()))??;
    let path = staged.to_string_lossy().into_owned();
    attachable.add([path.clone()]);
    Ok(screenshot::Capture { path, note: None })
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

/// Hands what the owner typed to terminal `id`'s writing thread (terminal.rs), so a program that isn't reading holds
/// up neither the window nor the runtime.
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
    attempt: String,
    ticket: String,
    on_event: Channel<tauri::ipc::InvokeResponseBody>,
) -> Result<u64, String> {
    let (id, _) = state.slots.find(&live::Attempt::new(attempt.as_str())).map_err(|e| e.to_string())?;
    let epoch = displays.epoch(&id);
    let dashboard = dashboard(&state, &attempt).await?;
    let socket = display::open(dashboard, &ticket, move |e| {
        let _ = on_event.send(display_event(e));
    })
    .await
    .map_err(|e| e.to_string())?;
    displays.keep(&id, epoch, socket).ok_or_else(|| transport::TransportError::Closed.to_string())
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
/// SSH target, or one the owner gave), with `request` on its stdin (repo_git.rs, ADR 0110).
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
    std::thread::spawn(local_stt::sweep_scratch);
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
            // Lifts the page above the docked touch keyboard, which Windows lays over the window (ADR 0130).
            #[cfg(windows)]
            if let Some(window) = app.get_webview_window("main") {
                touch_keyboard::start(window);
            }
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
            // The global shortcut was removed (ADR 0107 is superseded); an older version's setting file goes too.
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
            hermes_reopen,
            hermes_send,
            hermes_send_file,
            hermes_stat_files,
            hermes_read_preview,
            attach_picked_files,
            attach_copied_files,
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
            context_pick,
            context_local_files,
            context_upload,
            context_write_text,
            context_mkdir,
            context_remove,
            context_read_text,
            context_ssh_file,
            context_git_exclude,
            hermes_connect_cancel,
            hermes_probe,
            hermes_probe_cancel,
            hermes_reach,
            hermes_save_provider_key,
            hermes_remove_provider_key,
            hermes_provider_sign_ins,
            hermes_custom_endpoints,
            hermes_save_endpoint,
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
            chat_export_image,
            snapshot::snapshot_host,
            snapshot::snapshot_host_save,
            snapshot::snapshot_host_clear,
            snapshot::snapshot_host_test,
            snapshot::snapshot_publish,
            snapshot::snapshot_list,
            snapshot::snapshot_link,
            snapshot::snapshot_revoke,
            import_pick_file,
            usage_export,
            logs_export,
            preview_pick_local,
            preview_read_local,
            preview_read_local_image,
            preview_check_web,
            preview_https_answers,
            markdown_image_load,
            preview_open_in_browser,
            preview_page_open,
            preview_page_go,
            preview_page_reload,
            preview_page_place,
            preview_page_close,
            preview_annotate_still,
            preview_annotate_query,
            preview_annotate_pick,
            preview_annotate_stage,
            preview_server_open,
            preview_server_close,
            preview_dev_servers,
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
            tray::window_hidden,
            touch_keyboard::touch_keyboard_covered
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

#[cfg(all(test, unix))]
#[path = "../tests/common/mod.rs"]
mod test_common;

#[cfg(test)]
mod tests {
    use super::live::{Attempt, ConnectionId, Live, Slot, Slots};
    use super::{AppState, Asked, Transfers};
    use crate::lock::Locked;
    use std::time::Duration;

    fn id(connection: &str) -> ConnectionId {
        ConnectionId::parse(connection).unwrap()
    }

    fn asked_now(transfers: &Transfers, connection: &str) -> Asked {
        Asked { connection: id(connection), epoch: transfers.epoch(&id(connection)) }
    }

    #[test]
    fn a_suggested_save_name_is_one_plain_file_name() {
        let name = |s: &str| super::suggested_name(s, "download");
        assert_eq!(name("invoice\u{202E}fdp.exe"), "invoicefdp.exe");
        assert_eq!(name("a\u{2066}b\u{2069}c\u{200F}d\u{FEFF}e\u{0007}f\nġ.txt"), "abcdefġ.txt");
        assert_eq!(name(r"..\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\x.bat"), "x.bat");
        assert_eq!(name("../../etc/passwd"), "passwd");
        assert_eq!(name("C:x.txt"), "Cx.txt");
        assert_eq!(name("report.txt:stream"), "report.txtstream");
        assert_eq!(name(r#"a<b>c"d|e?f*g.md"#), "abcdefg.md");
        assert_eq!(name("  .hidden. "), "hidden");
        for nothing in ["", "..", "/", r"dir\", "\u{202E}", " . "] {
            assert_eq!(name(nothing), "download", "{nothing:?}");
        }
        assert_eq!(name("Chat — notes 2026.md"), "Chat — notes 2026.md");
        assert_eq!(name(&"é".repeat(150)).len(), 200);
    }

    #[test]
    fn a_chat_exports_only_as_markdown_json_or_an_html_page_each_with_its_own_extension() {
        let format = |s: &str| serde_json::from_str::<super::ExportFormat>(s);
        assert_eq!(format("\"markdown\"").unwrap().filter(), ("Markdown", &["md"][..]));
        assert_eq!(format("\"json\"").unwrap().filter(), ("JSON", &["json"][..]));
        assert_eq!(format("\"html\"").unwrap().filter(), ("HTML page", &["html"][..]));
        for other in ["\"png\"", "\"Markdown\"", "\"md\"", "\"htm\"", "\"HTML\"", "\"\""] {
            assert!(format(other).is_err(), "{other} should be refused");
        }
    }

    #[test]
    fn an_exported_image_is_saved_only_when_its_bytes_are_a_png() {
        use base64::Engine;
        let b64 = |bytes: &[u8]| base64::engine::general_purpose::STANDARD.encode(bytes);
        let png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";
        assert_eq!(super::png_bytes(&b64(png)).unwrap(), png.to_vec());
        assert!(super::png_bytes(&b64(b"GIF89a....")).unwrap_err().contains("isn't a PNG"));
        assert!(super::png_bytes(&b64(b"")).unwrap_err().contains("isn't a PNG"));
        assert!(super::png_bytes("data:image/png;base64,iVBORw0KGgo=").unwrap_err().contains("base64"));
    }

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

    #[test]
    fn work_asked_for_before_its_connection_was_replaced_is_refused() {
        let transfers = Transfers::default();
        let (on_one, on_two) = (asked_now(&transfers, "server-one"), asked_now(&transfers, "server-two"));
        assert_eq!(transfers.still(&on_one), Ok(()));
        transfers.stop(&id("server-one"));
        assert_eq!(transfers.still(&on_one), Err(super::TRANSFER_STOPPED.to_owned()));
        assert_eq!(transfers.still(&asked_now(&transfers, "server-one")), Ok(()));
        assert_eq!(transfers.still(&on_two), Ok(()), "another connection's work goes on");
    }

    #[tokio::test]
    async fn a_replaced_transfer_leaves_its_replacements_cancel_in_place() {
        let transfers = std::sync::Arc::new(Transfers::default());
        let forever = |id: u64, asked: Asked| {
            let t = transfers.clone();
            tokio::spawn(async move {
                t.run(id, &asked, async {
                    tokio::time::sleep(Duration::from_secs(60)).await;
                    Ok(())
                })
                .await
            })
        };
        let asked = asked_now(&transfers, "server-one");
        let old = forever(7, asked.clone());
        tokio::time::sleep(Duration::from_millis(20)).await;
        let new = forever(7, asked.clone());
        let elsewhere = forever(9, asked_now(&transfers, "server-two"));
        assert_eq!(old.await.unwrap(), Err(super::TRANSFER_STOPPED.to_owned()));
        // The old run ended after the new one registered; the new one must still be reachable.
        assert!(transfers.tasks.locked().contains_key(&7));
        transfers.stop(&id("server-one"));
        assert_eq!(new.await.unwrap(), Err(super::TRANSFER_STOPPED.to_owned()));
        assert_eq!(transfers.epoch(&id("server-one")), asked.epoch + 1);
        let running: Vec<u64> = transfers.tasks.locked().keys().copied().collect();
        assert_eq!(running, [9], "only the stopped connection's transfers ended");
        // Asked for before that stop: it never starts.
        let started = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let s = started.clone();
        let late = transfers
            .run(8, &asked, async move {
                s.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(())
            })
            .await;
        assert_eq!(late, Err(super::TRANSFER_STOPPED.to_owned()));
        assert!(!started.load(std::sync::atomic::Ordering::SeqCst));
        transfers.stop(&id("server-two"));
        assert_eq!(elsewhere.await.unwrap(), Err(super::TRANSFER_STOPPED.to_owned()));
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
                                got.locked().push(text.to_string());
                            }
                        }
                    })
                    .into_response()
                }),
            )
            .layer(axum::middleware::from_fn(move |req: axum::extract::Request, next: axum::middleware::Next| {
                let auth = req.headers().get(axum::http::header::AUTHORIZATION).and_then(|v| v.to_str().ok()).map(str::to_owned);
                note.locked().push((req.uri().path().to_owned(), auth));
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

    async fn connect(base: &url::Url, credential: super::SignInWith) -> Live {
        let target = super::Target::Url { url: base.to_string(), headers: Vec::new() };
        let on_event = tauri::ipc::Channel::new(|_| Ok(()));
        let (connection, _) =
            super::open_connection(target, credential, "default".into(), on_event, None, false, None, super::Steps::default()).await.expect("connected");
        connection
    }

    /// Issue #271: the status read, the sign-in and the ticket share one kept-alive HTTP connection; the WebSocket
    /// is the only other one. The status read still comes first, before the password or token (ADR 0120).
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
            assert_eq!(*heard.locked(), want.map(|(p, a)| (p.to_owned(), a)));
            assert_eq!(accepted.load(std::sync::atomic::Ordering::SeqCst), 2, "one HTTP connection plus the WebSocket, for {sign_in}");
        }
    }

    fn connecting_app() -> tauri::App<tauri::test::MockRuntime> {
        app_holding(AppState::default())
    }

    /// An app whose connections are `state`'s, with the commands that name one.
    fn app_holding(state: AppState) -> tauri::App<tauri::test::MockRuntime> {
        tauri::test::mock_builder()
            .manage(state)
            .manage(super::Transfers::default())
            .manage(super::display::Displays::default())
            .manage(std::sync::Arc::new(super::server_page::ServerPages::default()))
            .invoke_handler(tauri::generate_handler![
                super::hermes_send,
                super::hermes_reopen,
                super::hermes_disconnect,
                super::token_keep,
                super::preview_server_open
            ])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap()
    }

    /// Signs in to `base` as the saved connection `saved`, opened as `attempt`.
    async fn connect_command(app: &impl tauri::Manager<tauri::test::MockRuntime>, base: &url::Url, saved: &str, attempt: &str) -> Result<super::Route, String> {
        let password = super::SignInWith::Password { username: "liam".into(), password: "hunter2".into(), provider: None };
        super::hermes_connect(
            app.state(),
            app.state(),
            app.state(),
            app.state(),
            super::Target::Url { url: base.to_string(), headers: Vec::new() },
            password,
            "default".into(),
            saved.into(),
            Some(attempt.into()),
            tauri::ipc::Channel::new(|_| Ok(())),
            None,
            None,
            None,
            tauri::ipc::Channel::new(|_| Ok(())),
        )
        .await
    }

    async fn reopen_command(app: &tauri::App<tauri::test::MockRuntime>, connection: &str, attempt: &str) -> Result<(), String> {
        use tauri::Manager;
        let (on_event, on_step) = (tauri::ipc::Channel::new(|_| Ok(())), tauri::ipc::Channel::new(|_| Ok(())));
        super::hermes_reopen(app.state(), app.state(), app.state(), app.state(), "default".into(), connection.into(), attempt.into(), on_event, on_step).await
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_connect_stopped_before_it_began_leaves_the_live_connection_alone() {
        use tauri::Manager;
        let (base, _, _, _) = counting_dashboard().await;
        let app = connecting_app();
        connect_command(&app, &base, "server-one", "a").await.expect("a signs in");
        let pages = app.state::<std::sync::Arc<super::server_page::ServerPages>>();
        let _page = pages.begin("page", &id("server-one"), "me@hermes").unwrap();

        super::hermes_connect_cancel(app.state(), "b".into());
        assert_eq!(connect_command(&app, &base, "server-two", "b").await.err().as_deref(), Some(super::CONNECT_STOPPED));

        assert!(app.state::<AppState>().slots.find(&Attempt::new("a")).is_ok(), "a's connection is still there");
        assert_eq!(pages.len(), 1, "the server page is still open");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_failed_connect_closes_the_server_pages() {
        use tauri::Manager;
        let (base, _, _, _) = counting_dashboard().await;
        let app = connecting_app();
        connect_command(&app, &base, "server-one", "a").await.expect("a signs in");
        let pages = app.state::<std::sync::Arc<super::server_page::ServerPages>>();
        let _page = pages.begin("page", &id("server-one"), "me@hermes").unwrap();

        let refused = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let nowhere = url::Url::parse(&format!("http://{}/", refused.local_addr().unwrap())).unwrap();
        drop(refused);
        assert!(connect_command(&app, &nowhere, "server-two", "b").await.is_err(), "nothing answers there");

        assert!(app.state::<AppState>().slots.ids().is_empty());
        assert!(pages.is_empty(), "the server pages closed with the sign-in");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_failed_reopen_closes_the_server_pages() {
        use tauri::Manager;
        let (base, _, _, _) = counting_dashboard().await;
        let app = connecting_app();
        connect_command(&app, &base, "server-one", "a").await.expect("a signs in");
        let pages = app.state::<std::sync::Arc<super::server_page::ServerPages>>();
        let _page = pages.begin("page", &id("server-one"), "me@hermes").unwrap();

        super::hermes_connect_cancel(app.state(), "r".into());
        assert_eq!(reopen_command(&app, "a", "r").await.unwrap_err(), super::CONNECT_STOPPED);

        assert!(app.state::<AppState>().slots.ids().is_empty());
        assert!(pages.is_empty(), "the server pages closed with the connection");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn stops_that_came_too_late_are_not_kept_without_end() {
        use tauri::Manager;
        let app = connecting_app();
        for i in 0..10_000 {
            super::hermes_connect_cancel(app.state(), format!("finished-{i}"));
        }
        let kept = app.state::<AppState>().connecting.locked().stopped.len();
        assert!(kept < 1000, "{kept} stops kept");
    }

    fn send_through_ipc(webview: &tauri::WebviewWindow<tauri::test::MockRuntime>, path: &std::path::Path) -> Result<(), String> {
        invoke_through_ipc(
            webview,
            "hermes_send_file",
            serde_json::json!({
                "attempt": "A",
                "head": r#"{"jsonrpc":"2.0","id":1,"method":"prompt.submit","params":{"text":""#,
                "path": path,
                "tail": r#""}}"#,
                "maxBytes": 1000,
            }),
        )
    }

    fn invoke_through_ipc(webview: &tauri::WebviewWindow<tauri::test::MockRuntime>, cmd: &str, body: serde_json::Value) -> Result<(), String> {
        let request = tauri::webview::InvokeRequest {
            cmd: cmd.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            // The app's own page, where Tauri's permissions let it call the app's commands.
            url: if cfg!(windows) { "http://tauri.localhost" } else { "tauri://localhost" }.parse().unwrap(),
            body: tauri::ipc::InvokeBody::Json(body),
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
        app.state::<AppState>().slots.insert(id("server-one"), Slot::new(Attempt::new("A"), connect(&base, password).await));

        let dir = std::env::temp_dir().join(format!("hermes-chat-344-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let secret = dir.join("id_ed25519");
        std::fs::write(&secret, "PRIVATE KEY").unwrap();

        let attached = dir.join("notes.txt");
        std::fs::write(&attached, "MEETING NOTES").unwrap();
        app.state::<super::Attachable>().add([attached.to_string_lossy().into_owned()]);
        let heard = |bytes: &str| frames.locked().iter().any(|f| f.contains(&base64::engine::general_purpose::STANDARD.encode(bytes)));

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
        let refused = sent.expect_err("hermes_send_file answered Ok for a file nobody attached");
        assert!(refused.contains("wasn't attached in this app"), "refused for another reason: {refused}");
        assert!(delivered, "the stub dashboard didn't get the attached file");
    }

    /// Runs `cmd` as the webview would.
    async fn call(webview: &tauri::WebviewWindow<tauri::test::MockRuntime>, cmd: &'static str, body: serde_json::Value) -> Result<(), String> {
        let webview = webview.clone();
        tokio::task::spawn_blocking(move || invoke_through_ipc(&webview, cmd, body)).await.unwrap()
    }

    async fn send(webview: &tauri::WebviewWindow<tauri::test::MockRuntime>, attempt: &str, frame: &str) -> Result<(), String> {
        call(webview, "hermes_send", serde_json::json!({"attempt": attempt, "frame": frame})).await
    }

    /// Whether the stub that keeps `frames` got `frame`, given a while.
    async fn heard(frames: &Frames, frame: &str) -> bool {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !frames.locked().iter().any(|f| f == frame) && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        frames.locked().iter().any(|f| f == frame)
    }

    /// Every command that names its connection is refused as `Closed` for `attempt`.
    async fn refused_as_closed(webview: &tauri::WebviewWindow<tauri::test::MockRuntime>, attempt: &str) {
        let reopen =
            serde_json::json!({"profile": "default", "connection": attempt, "attempt": "reopen-1", "onEvent": "__CHANNEL__:1", "onStep": "__CHANNEL__:2"});
        let keep = serde_json::json!({"connection": null, "attempt": attempt, "addresses": []});
        let frame = serde_json::json!({"attempt": attempt, "frame": format!("MEANT FOR {attempt}")});
        for (cmd, body) in [("hermes_send", frame), ("token_keep", keep), ("hermes_reopen", reopen)] {
            let refused = call(webview, cmd, body).await.expect_err("a command for a replaced connection went ahead");
            assert!(refused.contains("closed"), "{cmd} for {attempt} was refused for another reason: {refused}");
        }
    }

    /// Issue #474: a command naming a connection that was opened again, or replaced by another server's, reaches
    /// neither server.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_command_naming_a_replaced_connection_is_refused_as_closed() {
        let (x, _, heard_by_x, to_x) = counting_dashboard().await;
        let (y, _, heard_by_y, to_y) = counting_dashboard().await;
        let app = connecting_app();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
        connect_command(&app, &x, "server-one", "A1").await.expect("signs in");
        connect_command(&app, &x, "server-one", "A2").await.expect("signs in again");
        let tickets = |heard: &Heard| heard.locked().iter().filter(|(p, _)| p == "/api/auth/ws-ticket").count();
        let before = tickets(&heard_by_x);

        refused_as_closed(&webview, "A1").await;
        assert_eq!(tickets(&heard_by_x), before, "the server was asked for a ticket for a reopen of the connection replaced");
        send(&webview, "A2", "FOR A2").await.expect("a frame for the connection held is sent");
        assert!(heard(&to_x, "FOR A2").await);

        connect_command(&app, &y, "server-two", "B").await.expect("another server signs in");
        let before = tickets(&heard_by_y);
        refused_as_closed(&webview, "A2").await;
        assert_eq!(tickets(&heard_by_y), before, "the new server was asked for a ticket for a reopen meant for the one replaced");
        send(&webview, "B", "FOR B").await.expect("a frame for the connection held is sent");
        assert!(heard(&to_y, "FOR B").await);
        assert_eq!(*to_y.locked(), ["FOR B"], "the new server heard a frame meant for the one replaced");
        assert_eq!(*to_x.locked(), ["FOR A2"], "a replaced connection still sent a frame");
    }

    /// ADR 0125: with room for two, each connection's commands reach its own server, and closing one leaves the
    /// other, and what is open on it, as it was.
    #[tokio::test(flavor = "multi_thread")]
    async fn two_live_connections_stay_apart() {
        use tauri::Manager;
        let (a, _, _, to_a) = counting_dashboard().await;
        let (b, _, _, to_b) = counting_dashboard().await;
        let app = app_holding(AppState { slots: Slots::with_limit(2), ..Default::default() });
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
        connect_command(&app, &a, "server-one", "A").await.expect("a signs in");
        connect_command(&app, &b, "server-two", "B").await.expect("b signs in");
        let pages = app.state::<std::sync::Arc<super::server_page::ServerPages>>();
        let _page = pages.begin("page", &id("server-two"), "me@hermes").unwrap();

        send(&webview, "A", "FOR A").await.expect("a's frame is sent");
        send(&webview, "B", "FOR B").await.expect("b's frame is sent");
        assert!(heard(&to_a, "FOR A").await && heard(&to_b, "FOR B").await);
        assert_eq!((to_a.locked().clone(), to_b.locked().clone()), (vec!["FOR A".to_owned()], vec!["FOR B".to_owned()]));

        let close_a = || call(&webview, "hermes_disconnect", serde_json::json!({"attempt": "A"}));
        close_a().await.expect("a closes");
        let refused = send(&webview, "A", "AFTER A CLOSED").await.expect_err("a frame for the closed connection was sent");
        assert!(refused.contains("closed"), "refused for another reason: {refused}");
        close_a().await.expect("a close that comes late does nothing");
        send(&webview, "B", "STILL B").await.expect("b's connection is still held");
        assert!(heard(&to_b, "STILL B").await);
        assert_eq!(pages.len(), 1, "b's server page closed with a");

        // A server page is opened on the connection named: none for the one closed, and b's has no SSH target.
        let page = |attempt: &str| serde_json::json!({"url": "http://localhost:3000/", "key": "next", "attempt": attempt, "onEvent": "__CHANNEL__:1"});
        assert!(call(&webview, "preview_server_open", page("A")).await.unwrap_err().contains("notConnected"));
        assert!(call(&webview, "preview_server_open", page("B")).await.unwrap_err().contains("noSshTarget"));
        assert_eq!(*to_a.locked(), ["FOR A"]);
    }

    /// ADR 0125: a connect that waits on its server holds up no other connection's commands, and its own stop still
    /// reaches it while another connection's socket reopens.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_slow_connect_holds_up_no_other_connections_commands() {
        use tauri::Manager;
        let (a, _, _, to_a) = counting_dashboard().await;
        let stalled = stalling_dashboard().await;
        let app = app_holding(AppState { slots: Slots::with_limit(2), ..Default::default() });
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
        connect_command(&app, &a, "server-one", "A").await.expect("a signs in");

        let handle = app.handle().clone();
        let connecting = tokio::spawn(async move { connect_command(&handle, &stalled, "server-two", "B").await });
        tokio::time::sleep(Duration::from_millis(200)).await;

        let sent = tokio::time::timeout(Duration::from_secs(2), send(&webview, "A", "WHILE B CONNECTS")).await;
        sent.expect("the send waited for the slow connect").expect("a's frame is sent");
        assert!(heard(&to_a, "WHILE B CONNECTS").await);

        reopen_command(&app, "A", "reopen-a").await.expect("a's socket reopens while b connects");
        super::hermes_connect_cancel(app.state(), "B".into());
        let stopped = tokio::time::timeout(Duration::from_secs(5), connecting).await.expect("stopping b's connect didn't reach it").unwrap();
        assert_eq!(stopped.err().as_deref(), Some(super::CONNECT_STOPPED));
        send(&webview, "A", "AFTER B STOPPED").await.expect("a's connection is still held");
        assert!(heard(&to_a, "AFTER B STOPPED").await);
    }

    /// A dashboard address that accepts each connection and never answers.
    async fn stalling_dashboard() -> url::Url {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = url::Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((socket, _)) = listener.accept().await {
                held.push(socket);
            }
        });
        base
    }

    /// At a limit of one a connect replaces the connection held as soon as it begins, so a command for that one is
    /// refused then. It used to wait for the connect to end, up to 60 s, behind the one lock.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_frame_for_the_connection_a_slow_connect_replaced_is_refused_at_once() {
        use tauri::Manager;
        let (a, _, _, to_a) = counting_dashboard().await;
        let stalled = stalling_dashboard().await;
        let app = connecting_app();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
        connect_command(&app, &a, "server-one", "A").await.expect("a signs in");

        let handle = app.handle().clone();
        let connecting = tokio::spawn(async move { connect_command(&handle, &stalled, "server-two", "B").await });
        tokio::time::sleep(Duration::from_millis(200)).await;

        let sent = tokio::time::timeout(Duration::from_secs(2), send(&webview, "A", "MEANT FOR A")).await.expect("the send waited for the slow connect");
        let refused = sent.expect_err("a frame for the replaced connection was sent");
        assert!(refused.contains("closed"), "refused for another reason: {refused}");
        assert!(to_a.locked().is_empty(), "the replaced connection still sent it");

        super::hermes_connect_cancel(app.state(), "B".into());
        assert_eq!(connecting.await.unwrap().err().as_deref(), Some(super::CONNECT_STOPPED));
    }
}
