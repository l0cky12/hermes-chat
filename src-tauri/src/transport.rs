//! Rust half of the Hermes transport: sign in to the dashboard, then move JSON-RPC text frames
//! between `/api/ws` and the webview, and relay its dashboard REST calls with the sign-in cookies.
//! The webview speaks the protocol; this side never parses it (ADR 0003). Wire details:
//! docs/research/hermes-gateway-api.md §2, §5 and "Password login and profiles".
//! It also reads the files the owner attaches, so their bytes go from disk to Hermes without passing
//! through the webview (§7), the staged images the composer shows as thumbnails, and the start of a local file the
//! owner picked for the preview pane (ADR 0007). For a direct connection it
//! resolves the host name in the URL the owner typed, so the webview can tell whether the connection is Unsecure.
//! For voice it relays a recording to the dashboard's transcription route and a reply to its speech route, and reads
//! which speech providers the profile uses without passing the rest of its config, keys and all, to the webview
//! (research doc, "Voice").
//! A direct connection can carry extra request headers for a gateway in front of the dashboard, such as Cloudflare
//! Access, on every request and the WebSocket handshake (ADR 0104).
//! Setup uses two more things here: `probe`, which tests a sign-in without keeping it, and
//! `Dashboard::save_provider_key`, which gives Hermes a model provider's API key, and `Dashboard::remove_provider_key`,
//! which takes one away (Settings → Providers, ADR 0095). `accounts` reads the subscription sign-ins and custom
//! endpoints for the same screen, and saves an endpoint with its key (ADR 0133).
//! Before any password goes out, `read_server` reads the dashboard's public `/api/status` and `identify` checks it is
//! a Hermes dashboard, and the same one the connection signed in to before (ADR 0120).

use crate::connect_steps::{Step, Steps};
use crate::lock::Locked;
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::{header, redirect, Method, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::BTreeMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::Mutex;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;
use url::Url;

mod accounts;
pub use accounts::{CustomEndpoint, EndpointForm, EndpointSave, ProviderSignIn};

/// The dashboard's username/password provider (`/api/status.auth_providers` on the live server), used when the server's
/// list of providers can't be read (ADR 0058).
pub const PASSWORD_PROVIDER: &str = "basic";
/// The provider that vouches for a provisioned `HERMES_DASHBOARD_SESSION_TOKEN` (ADR 0058).
pub const TOKEN_PROVIDER: &str = "session-token";

pub struct SignIn {
    pub credential: Credential,
    /// Sent with every request to the dashboard, the WebSocket handshake included. Built by `extra_headers`.
    pub headers: HeaderMap,
}

/// How a sign-in proves who it is (ADR 0058). `Password`: a password provider's form, `basic` unless Hermes lists
/// another. `Token`: the dashboard's session token, sent as `Authorization: Bearer` and never in a URL.
pub enum Credential {
    Password { provider: String, username: String, password: String },
    Token(String),
}

impl Credential {
    pub fn password(username: impl Into<String>, password: impl Into<String>) -> Self {
        Credential::Password { provider: PASSWORD_PROVIDER.into(), username: username.into(), password: password.into() }
    }
}

/// Whether `name` can be a dashboard auth provider's name: Hermes's are short, lowercase words with dashes, such as
/// `basic`, `self-hosted` or `session-token`.
pub fn provider_name(name: &str) -> bool {
    (1..=64).contains(&name.len()) && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}

#[derive(Debug, thiserror::Error)]
pub enum TransportError {
    #[error("Enter the dashboard's URL, starting with http:// or https://, such as http://hermes:9119. Put the username and password in their own fields.")]
    BadUrl,
    #[error("Can't reach the Hermes dashboard: {0}")]
    Unreachable(String),
    #[error("Wrong username or password.")]
    BadCredentials,
    #[error("Wrong token: the dashboard turned it down. A token stops working when HERMES_DASHBOARD_SESSION_TOKEN is replaced on the server.")]
    BadToken,
    /// `/api/auth/me` named another provider than `TOKEN_PROVIDER` for the token.
    #[error("The dashboard took the token as a {0} sign-in, not as its session token, so Hermes Chat didn't sign in with it.")]
    NotSessionToken(String),
    #[error("Token sign-in sends the token in the Authorization header, and this connection's extra request headers already set Authorization. Remove that header to sign in with a token.")]
    AuthorizationHeaderSet,
    /// The server's `/api/status` doesn't list `TOKEN_PROVIDER`, so the token isn't sent to it.
    #[error("This Hermes server doesn't take a token: its sign-in doesn't list the session-token provider. Hermes Chat didn't send it the token. Sign in with a password, or update Hermes on the server.")]
    TokenNotOffered,
    #[error("Too many sign-in attempts. Wait a minute and try again.")]
    RateLimited,
    #[error("The dashboard answered {status}: {body}")]
    Unexpected { status: u16, body: String },
    #[error("The chat connection failed: {0}")]
    WebSocket(String),
    #[error("The chat connection is closed.")]
    Closed,
    #[error("Hermes stopped answering: nothing came back for {0} s.")]
    Stalled(u64),
    #[error("The dashboard sign-in has expired. Sign in again.")]
    SignedOut,
    #[error("Hermes Chat doesn't relay {0}.")]
    NotRelayed(String),
    #[error("it's {:.1} MB now, over the {} MB limit", *.size as f64 / MIB as f64, .max / MIB)]
    FileTooLarge { size: u64, max: u64 },
    /// An answer past the most `read_body` reads of it; `size`: what was announced or read when it stopped.
    #[error("The server's answer is over {}, the most Hermes Chat reads of one, so it wasn't read.", size_text(*.max))]
    AnswerTooLarge { size: u64, max: u64 },
    #[error("{0}")]
    File(String),
    /// The provider turned down an API key the owner typed (`POST /api/providers/validate`).
    #[error("{0}")]
    KeyRejected(String),
    #[error("Hermes didn't finish checking and saving the key within {0} s. It may have saved it anyway: the list of providers shows what Hermes has.")]
    KeyTimedOut(u64),
    #[error("Hermes didn't finish removing the key within {0} s. It may have removed it anyway: the list of keys shows what Hermes has.")]
    KeyRemovalTimedOut(u64),
    /// `DELETE /api/env` answered, but `GET /api/env` still lists the key as set (ADR 0095).
    #[error("Hermes still lists the {0} key as set after removing it. It may keep the key somewhere else on the server.")]
    KeyStillSet(String),
    /// Settings → Providers' Add an endpoint form, refused before anything was sent (ADR 0133).
    #[error("{0}")]
    Endpoint(String),
    #[error("Hermes didn't finish checking and saving the endpoint within {0} s. It may have saved it anyway: the list of endpoints shows what Hermes has.")]
    EndpointTimedOut(u64),
    #[error("This Hermes server can't {0}: it has no {1} route. Updating Hermes adds it.")]
    NoVoiceRoute(&'static str, &'static str),
    #[error("{0}")]
    Voice(String),
    #[error("{0}")]
    BadHeader(String),
    /// Settings → MCP servers' edit, refused before anything was written (ADR 0121).
    #[error("{0}")]
    Mcp(String),
    /// Settings → MCP servers' edit, after something may have been written: Hermes didn't confirm all of it (ADR 0121).
    #[error("Not confirmed: {0}")]
    McpUnconfirmed(String),
    #[error("The dashboard sent Hermes Chat on to {0}, another site. Hermes Chat doesn't follow it there, so your extra request headers aren't sent to it. If a gateway such as Cloudflare Access is in front of the dashboard, check the headers it needs.")]
    Redirected(String),
    /// `/api/status` answered, but not as a Hermes dashboard does (ADR 0120). No password was sent.
    #[error("Wrong server: something answered at this address, but it isn't a Hermes dashboard. Hermes Chat didn't send it the password.")]
    NotHermes,
    /// A Hermes dashboard answered whose install id isn't the one the connection signed in to before (ADR 0120).
    #[error("Wrong server: a different Hermes server answered at this address than the one this connection signed in to before. Hermes Chat didn't send it the password.")]
    WrongServer,
    /// Plain http:// to an address that isn't this computer, a LAN or Tailscale (ADR 0120).
    #[error("Plain http:// is only used on this computer, a LAN or Tailscale, and {0} is a public address. Use https:// or SSH to reach it.")]
    PlainHttpPublic(String),
    /// Plain http:// to an address in 100.64.0.0/10 that this computer doesn't reach over Tailscale (ADR 0004).
    #[error("Plain http:// is only used on this computer, a LAN or Tailscale, and this computer doesn't reach {0} over Tailscale. Turn Tailscale on here, or use https:// or SSH to reach it.")]
    PlainHttpNotTailscale(String),
    #[error("The dashboard sent Hermes Chat on to another site, whose address isn't shown, as it may repeat your password or a request header. Hermes Chat doesn't follow it there, so nothing is sent to it. If a gateway such as Cloudflare Access is in front of the dashboard, check the headers it needs.")]
    RedirectedHidden,
}

/// An extra request header as the owner typed it in the sign-in screen.
#[derive(Deserialize)]
pub struct ExtraHeader {
    pub name: String,
    pub value: String,
}

const MAX_EXTRA_HEADERS: usize = 32;
const MAX_HEADER_VALUE_BYTES: usize = 8 * 1024;

/// Headers the transport or HTTP itself sets, or that would change how the request is framed or routed.
fn reserved(name: &HeaderName) -> bool {
    let n = name.as_str(); // always lowercase
    matches!(
        n,
        "host"
            | "content-length"
            | "content-type"
            | "transfer-encoding"
            | "connection"
            | "upgrade"
            | "cookie"
            | "te"
            | "trailer"
            | "keep-alive"
            | "expect"
            | "origin"
    ) || n.starts_with("sec-websocket-")
        || n.starts_with("proxy-")
}

/// Checks the owner's extra request headers and builds them, every value marked sensitive. Names are matched without
/// regard to case: one set twice is refused, as is a reserved one (`reserved`). Spaces and tabs around a value are
/// dropped; any other control character, a line break above all, is refused. Errors name the header, never its value.
pub fn extra_headers(headers: &[ExtraHeader]) -> Result<HeaderMap, TransportError> {
    if headers.len() > MAX_EXTRA_HEADERS {
        return Err(TransportError::BadHeader(format!("Hermes Chat sends at most {MAX_EXTRA_HEADERS} extra request headers.")));
    }
    let mut map = HeaderMap::new();
    for (i, h) in headers.iter().enumerate() {
        let bad = |why: String| TransportError::BadHeader(format!("Extra request header {}: {why}", i + 1));
        let raw = h.name.trim_matches([' ', '\t']);
        if raw.is_empty() {
            return Err(bad("enter its name.".into()));
        }
        let name = HeaderName::from_bytes(raw.as_bytes())
            .map_err(|_| bad(format!("{raw:?} isn't a header name. Use letters, digits and dashes, such as CF-Access-Client-Id.")))?;
        if reserved(&name) {
            return Err(bad(format!("Hermes Chat sets {raw} itself.")));
        }
        if map.contains_key(&name) {
            return Err(bad(format!("{raw} is set twice.")));
        }
        let value = h.value.trim_matches([' ', '\t']);
        if value.is_empty() {
            return Err(bad(format!("enter a value for {raw}.")));
        }
        if value.len() > MAX_HEADER_VALUE_BYTES {
            return Err(bad(format!("the value of {raw} is over {} KB.", MAX_HEADER_VALUE_BYTES / 1024)));
        }
        // Visible ASCII, spaces and tabs only: no line breaks, other control characters or non-ASCII bytes, which
        // `HeaderValue` would let through as obsolete text.
        let printable = value.bytes().all(|b| b == b'\t' || (b' '..=b'~').contains(&b));
        let mut value = HeaderValue::from_str(value)
            .ok()
            .filter(|_| printable)
            .ok_or_else(|| bad(format!("the value of {raw} can only hold ASCII letters, digits, punctuation and spaces, on one line.")))?;
        value.set_sensitive(true);
        map.insert(name, value);
    }
    Ok(map)
}

/// The HTTP client for one dashboard: all redirects stay on its origin. Even without extra headers, a 307/308
/// redirect can forward a password body or a manually supplied cookie to another server. One is built per route
/// attempt, from the route's extra `headers`, and shared by `read_server` and `Dashboard::sign_in`, so the sign-in
/// and its ticket reuse the connection the status read opened (#271). It carries no credential itself.
pub fn client(headers: &HeaderMap) -> Result<reqwest::Client, TransportError> {
    client_kept_to_origin(headers, true)
}

/// `client`, with redirects kept to the dashboard's origin even without extra headers when `always` is set, as for a
/// request that carries a provider key.
fn client_kept_to_origin(headers: &HeaderMap, always: bool) -> Result<reqwest::Client, TransportError> {
    let mut http = reqwest::Client::builder()
        .default_headers(headers.clone())
        .no_proxy()
        .connect_timeout(CONNECT_LIMIT)
        .tcp_keepalive(KEEPALIVE_IDLE)
        .tcp_keepalive_interval(KEEPALIVE_INTERVAL)
        .tcp_keepalive_retries(KEEPALIVE_RETRIES);
    if always || !headers.is_empty() {
        http = http.redirect(redirect::Policy::custom(same_origin_redirects));
    }
    http.build().map_err(unreachable)
}

/// How long opening a connection to the dashboard may take before the call fails.
const CONNECT_LIMIT: Duration = Duration::from_secs(15);

/// A kept-alive connection that went half-open, as one does across a suspend, is found by keepalive probes and closed,
/// so a call on it fails instead of waiting for good (#473): the first probe after 30 s without traffic, then one each
/// 10 s, given up after 3 unanswered.
const KEEPALIVE_IDLE: Duration = Duration::from_secs(30);
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(10);
const KEEPALIVE_RETRIES: u32 = 3;

/// With extra headers set, a redirect is followed only within the dashboard's origin (scheme, host and port), so
/// the headers never reach another site. reqwest only strips its own credential headers on such a redirect.
fn same_origin_redirects(attempt: redirect::Attempt) -> redirect::Action {
    let from = attempt.previous().last().map(Url::origin);
    if from.as_ref() == Some(&attempt.url().origin()) {
        redirect::Policy::default().redirect(attempt)
    } else {
        attempt.stop()
    }
}

const MIB: u64 = 1024 * 1024;

/// Hermes's own limit on a recording to transcribe (`_MAX_TRANSCRIPTION_UPLOAD_BYTES` in
/// `hermes_cli/web_routers/audio.py` at the deployed `bf0203a`).
pub const TRANSCRIBE_MAX_BYTES: u64 = 25 * MIB;

/// What Hermes heard in a recording. `text` is empty when it heard no speech.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Transcript {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
}

/// A reply read aloud by Hermes: the audio file's bytes and type.
#[derive(Debug, Clone, PartialEq)]
pub struct Speech {
    pub mime: String,
    pub audio: Vec<u8>,
    pub provider: Option<String>,
}

/// What the profile's voice set-up looks like from here: whether the server has the two audio routes, which
/// providers the profile's config names, and each provider's model, voice and language for Settings → Voice. Only these
/// fields leave Rust; the config they come from can hold API keys.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceSetup {
    /// The server has `POST /api/audio/transcribe`.
    pub transcribe: bool,
    /// The server has `POST /api/audio/speak`.
    pub speak: bool,
    /// `stt.enabled`; Hermes counts a missing one as on. `None` when the config couldn't be read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stt_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stt_provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tts_provider: Option<String>,
    /// `voice.silence_threshold`: the loudness, as the RMS of 16-bit samples, below which a voice conversation counts
    /// a moment as quiet. Hermes's own voice mode ends a turn with the same three `voice.*` settings.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub silence_threshold: Option<f64>,
    /// `voice.silence_duration`: seconds of quiet after speech that end a turn.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub silence_duration: Option<f64>,
    /// `voice.max_recording_seconds`: the longest one turn may be; 0 or less means Hermes sets no limit.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_recording_seconds: Option<f64>,
    /// `stt.language`: the language hint Hermes gives every speech-to-text provider that has none of its own.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stt_language: Option<String>,
    /// Each speech-to-text provider's own settings, by provider (`stt.<provider>.<setting>`): only the settings named in
    /// `VOICE_SETTING_KEYS`, and only when they are text. No key, token or other field of those sections leaves Rust.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub stt_settings: BTreeMap<String, BTreeMap<String, String>>,
    /// The same for text-to-speech (`tts.<provider>.<setting>`).
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub tts_settings: BTreeMap<String, BTreeMap<String, String>>,
}

/// The settings of a speech provider's config section that Settings → Voice shows and changes: its model, voice and
/// language. Hermes names them differently per provider (`tts.elevenlabs.voice_id`, `stt.elevenlabs.language_code`).
pub const VOICE_SETTING_KEYS: [&str; 6] = ["model", "model_id", "voice", "voice_id", "language", "language_code"];

/// A speech provider's name as a config section key: what Hermes's own providers are called. Other keys of `stt` and
/// `tts` (`providers`, `streaming`, `local` …) are told apart by their contents, not their names.
fn voice_provider_name(name: &str) -> bool {
    let mut b = name.bytes();
    name.len() <= 64 && matches!(b.next(), Some(c) if c.is_ascii_alphanumeric()) && b.all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

/// A voice setting's value as text, kept exactly as Hermes has it so a later check can compare it: `None` for anything
/// that isn't a string, or is long or holds control characters (no model or voice name does).
fn voice_setting_text(v: &serde_json::Value) -> Option<String> {
    v.as_str().filter(|s| s.chars().count() <= 256 && !s.chars().any(char::is_control)).map(str::to_owned)
}

/// The `VOICE_SETTING_KEYS` of each provider section under `section` (the config's `stt` or `tts`). Command providers
/// under `providers` aren't Hermes's own and are left out.
fn voice_settings(section: &serde_json::Value) -> BTreeMap<String, BTreeMap<String, String>> {
    let Some(section) = section.as_object() else {
        return BTreeMap::new();
    };
    section
        .iter()
        .filter(|(name, _)| name.as_str() != "providers" && voice_provider_name(name))
        .filter_map(|(name, block)| {
            let fields: BTreeMap<String, String> = block
                .as_object()?
                .iter()
                .filter(|(k, _)| VOICE_SETTING_KEYS.contains(&k.as_str()))
                .filter_map(|(k, v)| Some((k.clone(), voice_setting_text(v)?)))
                .collect();
            (!fields.is_empty()).then(|| (name.clone(), fields))
        })
        .collect()
}

/// How an audio route answered: its JSON, no such route, or a refusal and Hermes's reason.
enum AudioAnswer {
    Done(serde_json::Value),
    NoRoute,
    Refused(String),
}

/// A plain MIME type such as `audio/wav`, without parameters, or `None` if it isn't an audio type.
fn audio_mime(raw: &str) -> Option<String> {
    let mime = raw.split(';').next()?.trim().to_ascii_lowercase();
    let (kind, sub) = mime.split_once('/')?;
    let token = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"!#$&-^_.+".contains(&b));
    (kind == "audio" && token(sub)).then_some(mime)
}

/// The reason in a refusal's body: FastAPI's `detail`, an `error`, or else the status alone (a proxy's HTML page says
/// nothing useful). Long enough for Hermes's "No STT provider available", which lists what each provider needs.
fn refusal_reason(status: StatusCode, body: &str, headers: &HeaderMap) -> String {
    let json: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
    let text = json["detail"].as_str().or(json["error"].as_str()).map(str::trim).filter(|s| !s.is_empty());
    // As `shown_body`: with extra request headers, a refusal may be a gateway's, repeating them. Checked on the whole
    // reason, before it is shortened.
    let refused = matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN | StatusCode::PROXY_AUTHENTICATION_REQUIRED);
    match text {
        Some(t) if !(refused && carried_extra(headers)) && !repeats_header(t, headers) => t.chars().take(800).collect(),
        _ => format!("the server answered {status}"),
    }
}

/// A config value as a short display string, or `None` if it isn't a non-empty string.
fn config_word(v: &serde_json::Value) -> Option<String> {
    v.as_str().map(str::trim).filter(|s| !s.is_empty()).map(|s| s.chars().take(64).collect())
}

/// A `voice.*` number as Hermes's `_numeric_or` takes it: a real int or float (YAML `true` isn't one), else `None`.
fn config_number(v: &serde_json::Value) -> Option<f64> {
    v.as_f64().filter(|n| n.is_finite())
}

/// `stt.enabled` as Hermes reads it (`is_truthy_value(cfg.get("enabled", True), default=True)` in
/// `tools/transcription_tools.py`, then Python truthiness): missing is on.
fn truthy(v: &serde_json::Value) -> bool {
    match v {
        serde_json::Value::Null => true,
        serde_json::Value::Bool(b) => *b,
        serde_json::Value::Number(n) => n.as_f64() != Some(0.0),
        serde_json::Value::String(s) => matches!(s.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"),
        serde_json::Value::Array(a) => !a.is_empty(),
        serde_json::Value::Object(o) => !o.is_empty(),
    }
}

/// A dashboard to sign in to directly, without the SSH tunnel: its root, and the IP addresses its host name
/// resolves to (none when the host is an IP address).
#[derive(Debug)]
pub struct DirectUrl {
    pub base: Url,
    pub addresses: Vec<IpAddr>,
}

/// Reads the URL the owner typed: `http(s)://` or `ws(s)://` (taken as `http(s)://`), with an optional path
/// prefix, then resolves its host name. A URL with a username or password in it is refused, since the app saves
/// and shows the URL.
pub async fn resolve_direct(raw: &str) -> Result<DirectUrl, TransportError> {
    resolve_direct_within(raw, None).await
}

/// `resolve_direct`, whose name lookup gives up after `limit`, for one of several routes (`StepLimits::lookup`).
pub async fn resolve_direct_within(raw: &str, limit: Option<Duration>) -> Result<DirectUrl, TransportError> {
    resolve_direct_using(raw, limit, |name, port| async move { tokio::net::lookup_host((name.as_str(), port)).await.map(Iterator::collect) }).await
}

/// `resolve_direct_within` with `lookup` resolving a host name and port, so a lookup that never answers can be tested.
pub async fn resolve_direct_using<F, Fut>(raw: &str, limit: Option<Duration>, lookup: F) -> Result<DirectUrl, TransportError>
where
    F: FnOnce(String, u16) -> Fut,
    Fut: std::future::Future<Output = std::io::Result<Vec<std::net::SocketAddr>>>,
{
    let mut base = Url::parse(raw.trim()).map_err(|_| TransportError::BadUrl)?;
    if !base.username().is_empty() || base.password().is_some() {
        return Err(TransportError::BadUrl);
    }
    let scheme = match base.scheme() {
        "http" | "ws" => "http",
        "https" | "wss" => "https",
        _ => return Err(TransportError::BadUrl),
    };
    base.set_scheme(scheme).expect("ws(s) URLs map to http(s)");
    base.set_query(None);
    base.set_fragment(None);
    let addresses = match base.host() {
        Some(url::Host::Domain(name)) => {
            let port = base.port_or_known_default().expect("http(s) has a default port");
            let looked_up = within(
                limit,
                async { lookup(name.to_owned(), port).await.map_err(|e| TransportError::Unreachable(format!("couldn't look up {name}: {e}"))) },
                |s| TransportError::Unreachable(format!("looking up {name} didn't finish within {s}s.")),
            );
            let mut found: Vec<IpAddr> = looked_up.await?.into_iter().map(|a| a.ip()).collect();
            found.sort();
            found.dedup();
            found
        }
        Some(_) => vec![],
        None => return Err(TransportError::BadUrl),
    };
    Ok(DirectUrl { base, addresses })
}

/// Whether `ip` is this computer, a private LAN range, link-local, or Tailscale's IPv6 range (fd7a:115c:a1e0::/48,
/// which the unique-local fc00::/7 holds). Tailscale's IPv4 range, 100.64.0.0/10, isn't one of them: carrier-grade NAT
/// uses it too, so a plain http:// route goes there only over Tailscale (`check_plain_http`, ADR 0004 and 0120).
pub fn is_local_or_private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback() || v4.is_private() || v4.is_link_local(),
        IpAddr::V6(v6) => {
            let first = v6.segments()[0];
            v6.is_loopback()
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80
                || v6.to_ipv4_mapped().is_some_and(|v4| is_local_or_private(IpAddr::V4(v4)))
        }
    }
}

/// Refuses a plain http:// dashboard whose host is, or resolves to, anything but this computer, a LAN or Tailscale:
/// the password would cross the internet, or a carrier's network, unencrypted (ADR 0004 and 0120). https:// goes
/// anywhere.
pub fn check_plain_http(direct: &DirectUrl) -> Result<(), TransportError> {
    check_plain_http_from(direct, source_toward)
}

/// `check_plain_http`, with `source` naming the address this computer sends from to reach an address.
pub fn check_plain_http_from(direct: &DirectUrl, source: impl Fn(IpAddr) -> Option<IpAddr>) -> Result<(), TransportError> {
    if direct.base.scheme() != "http" {
        return Ok(());
    }
    let host = direct.base.host_str().unwrap_or_default().to_owned();
    let addresses = match direct.base.host() {
        Some(url::Host::Ipv4(ip)) => vec![IpAddr::V4(ip)],
        Some(url::Host::Ipv6(ip)) => vec![IpAddr::V6(ip)],
        _ => direct.addresses.clone(),
    };
    if addresses.is_empty() {
        return Err(TransportError::PlainHttpPublic(host));
    }
    // Tailscale reaches a peer's 100.64.0.0/10 address from this computer's own; a carrier's network doesn't.
    let over_tailscale = |ip: IpAddr| in_tailscale_v4(ip) && source(ip).is_some_and(in_tailscale_v4);
    match addresses.iter().find(|ip| !is_local_or_private(**ip) && !over_tailscale(**ip)) {
        None => Ok(()),
        Some(ip) if in_tailscale_v4(*ip) => Err(TransportError::PlainHttpNotTailscale(host)),
        Some(_) => Err(TransportError::PlainHttpPublic(host)),
    }
}

/// Whether `ip` is in 100.64.0.0/10, which Tailscale and carrier-grade NAT both use, written as IPv4 or IPv4-mapped.
fn in_tailscale_v4(ip: IpAddr) -> bool {
    let IpAddr::V4(v4) = ip.to_canonical() else { return false };
    let [a, b, ..] = v4.octets();
    a == 100 && (64..=127).contains(&b)
}

/// The address this computer sends from to reach `ip`, as its routing table picks it. Connecting a UDP socket sends
/// nothing.
fn source_toward(ip: IpAddr) -> Option<IpAddr> {
    let ip = ip.to_canonical();
    let any: IpAddr = if ip.is_ipv4() { Ipv4Addr::UNSPECIFIED.into() } else { Ipv6Addr::UNSPECIFIED.into() };
    let socket = std::net::UdpSocket::bind((any, 0)).ok()?;
    socket.connect((ip, 9)).ok()?;
    Some(socket.local_addr().ok()?.ip())
}

/// A Hermes install's id as this app keeps it: a hash, so the id itself, which `/api/status` shows anyone who asks,
/// isn't written anywhere here. Hermes's own diagnostics leave it out (ADR 0044); this only tells servers apart.
pub fn server_id(install_id: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(format!("hermes-chat server\n{install_id}").as_bytes());
    digest.iter().take(16).map(|b| format!("{b:02x}")).collect()
}

/// Reads an `/api/status` body: it must be a Hermes dashboard's, which always carries its version or its sign-in gate,
/// and when it names its install and `expect` is set, the install must be that one. The server's id when it names
/// one. None of this sends the password (ADR 0120).
pub fn identify(status: &str, expect: Option<&str>) -> Result<Option<String>, TransportError> {
    let v: serde_json::Value = serde_json::from_str(status).map_err(|_| TransportError::NotHermes)?;
    let o = v.as_object().ok_or(TransportError::NotHermes)?;
    if !o.get("version").is_some_and(serde_json::Value::is_string) && !o.get("auth_required").is_some_and(serde_json::Value::is_boolean) {
        return Err(TransportError::NotHermes);
    }
    let id = o.get("install_id").and_then(serde_json::Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(server_id);
    match (&id, expect) {
        (Some(seen), Some(want)) if seen != want => Err(TransportError::WrongServer),
        _ => Ok(id),
    }
}

/// `GET /api/status` at `base`, which a Hermes dashboard answers without a sign-in, with the body read inside the
/// limit too, since a server can send its headers and then stall. Only a 2xx is a status: a Hermes dashboard always
/// serves it, so anything else gets no password (ADR 0120). A refusal (401, 403), a server error and a redirect to
/// another site keep their own errors, as they come from something in front of the dashboard or a dashboard that
/// is failing; any other answer is `NotHermes`.
async fn read_status(http: &reqwest::Client, base: &Url, headers: &HeaderMap) -> Result<String, TransportError> {
    let resp = http.get(endpoint(base, "api/status")).send().await.map_err(unreachable)?;
    let status = resp.status();
    if status.is_success() {
        // A dashboard's status is a KB or two, so an answer past the cap isn't one.
        return small_answer(resp).await.map_err(|e| if matches!(e, TransportError::AnswerTooLarge { .. }) { TransportError::NotHermes } else { e });
    }
    let kept = matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) || status.is_server_error();
    Err(match unexpected(resp, headers).await {
        // Stopped at another site (`same_origin_redirects`), such as a gateway's login page.
        e @ (TransportError::Redirected(_) | TransportError::RedirectedHidden) => e,
        e if kept => e,
        _ => TransportError::NotHermes,
    })
}

/// What `read_server` found: the `/api/status` body, and the server's id (`server_id`), if it named its install.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ServerSeen {
    pub status: String,
    pub server: Option<String>,
}

/// Reads `/api/status` within `wait` and checks it with `identify`, before anything signs in (ADR 0120). `http`: the
/// route's `client(headers)`, which the sign-in then reuses.
pub async fn read_server(http: &reqwest::Client, base: &Url, headers: &HeaderMap, expect: Option<&str>, wait: Duration) -> Result<ServerSeen, TransportError> {
    let status = tokio::time::timeout(wait, read_status(http, base, headers))
        .await
        .map_err(|_| TransportError::Unreachable(format!("the dashboard didn't answer within {}s.", wait.as_secs())))??;
    let server = identify(&status, expect)?;
    Ok(ServerSeen { status, server })
}

/// How long each step of opening one of several routes may take before the next route is tried (ADR 0120). A
/// connection with one route has none: only the whole attempt's limit, as before.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StepLimits {
    /// Looking up a web address's host name.
    pub lookup: Duration,
    /// The password sign-in, or the token's `GET /api/auth/me`.
    pub sign_in: Duration,
    /// `POST /api/auth/ws-ticket`.
    pub ticket: Duration,
    /// The `/api/ws` connect.
    pub socket: Duration,
}

impl StepLimits {
    pub const ROUTES: StepLimits =
        StepLimits { lookup: Duration::from_secs(5), sign_in: Duration::from_secs(10), ticket: Duration::from_secs(10), socket: Duration::from_secs(10) };

    /// The limits for a connection with several routes on (`quick`), none for one.
    pub fn of(quick: bool) -> Option<StepLimits> {
        quick.then_some(StepLimits::ROUTES)
    }
}

/// Runs `step`, giving up after `limit` if there is one with the error `timed_out` makes of its seconds.
async fn within<T>(
    limit: Option<Duration>,
    step: impl std::future::Future<Output = Result<T, TransportError>>,
    timed_out: impl FnOnce(u64) -> TransportError,
) -> Result<T, TransportError> {
    match limit {
        None => step.await,
        Some(limit) => tokio::time::timeout(limit, step).await.unwrap_or_else(|_| Err(timed_out(limit.as_secs()))),
    }
}

/// Opens one route at `base`: reads `/api/status` within `reach` and checks it is the Hermes `expect` names (before
/// the password or token goes anywhere), signs in, and opens `/api/ws` for `profile`, each step within `limits` when
/// given and reported to `steps`. Every frame goes to `on_event`.
#[allow(clippy::too_many_arguments)]
pub async fn open_route(
    base: &Url,
    sign_in: &SignIn,
    profile: &str,
    expect: Option<&str>,
    reach: Duration,
    limits: Option<StepLimits>,
    steps: &Steps,
    on_event: impl Fn(PipeEvent) + Send + 'static,
) -> Result<(Dashboard, Pipe, ServerSeen), TransportError> {
    // One client for this route attempt: the sign-in and its ticket reuse the connection the status read opened
    // (#271). It carries no credential, and the status check still passes before one is sent.
    let http = client(&sign_in.headers)?;
    let seen = steps.run(Step::Status, read_server(&http, base, &sign_in.headers, expect, reach)).await?;
    offered(sign_in, Some(&seen.status))?;
    let signing_in = within(limits.map(|l| l.sign_in), Dashboard::sign_in(http, base, sign_in), |s| {
        TransportError::Unreachable(format!("the sign-in didn't answer within {s}s."))
    });
    let dashboard = steps.run(Step::SignIn, signing_in).await?;
    let pipe = dashboard.open_pipe_within(profile, on_event, limits, steps).await?;
    Ok((dashboard, pipe, seen))
}

/// A way to sign in that a dashboard offers and Hermes Chat supports (ADR 0058). `Password`: a provider's username
/// and password form, `label` its display name. `Token`: the provisioned session token.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "method", rename_all = "camelCase")]
pub enum SignInMethod {
    Password { provider: String, label: String },
    Token,
}

/// Why a dashboard's methods are a guess (Password with `basic`, as before discovery). `Unread`: its status or list of
/// providers couldn't be read. `GateOff`: its sign-in is off, as on a loopback bind, so there is no session to sign in
/// to. `NoneSupported`: it lists only providers Hermes Chat doesn't sign in with.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MethodsNote {
    Unread,
    GateOff,
    NoneSupported,
}

/// The sign-in methods a dashboard offers, never empty, for the method picker. Parsed here so the webview gets this
/// list, not the server's answers.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Methods {
    pub methods: Vec<SignInMethod>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<MethodsNote>,
}

const LABEL_MAX: usize = 60;

/// The methods `status` (`GET /api/status`) and `providers` (`GET /api/auth/providers`, read only when the status lists
/// the native flow) offer: Password for each provider listed with `supports_password` (or `basic` when the status
/// names it and no list was read), and Token when the status names `session-token`. Anything else, such as a browser
/// sign-in or a service credential, isn't offered here. When nothing can be read or nothing is supported, Password
/// with `basic`, as before, with a note saying why.
pub fn sign_in_methods(status: Option<&str>, providers: Option<&str>) -> Methods {
    let basic = || SignInMethod::Password { provider: PASSWORD_PROVIDER.into(), label: "Password".into() };
    let guess = |note| Methods { methods: vec![basic()], note: Some(note) };
    let Some(status) = status.and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok()).filter(serde_json::Value::is_object) else {
        return guess(MethodsNote::Unread);
    };
    if status["auth_required"] == json!(false) {
        return guess(MethodsNote::GateOff);
    }
    let Some(names) = status["auth_providers"].as_array() else { return guess(MethodsNote::Unread) };
    let names: Vec<&str> = names.iter().filter_map(serde_json::Value::as_str).collect();
    let listed = providers.and_then(|p| serde_json::from_str::<serde_json::Value>(p).ok()).and_then(|v| v["providers"].as_array().cloned());
    let mut methods = Vec::new();
    match listed {
        Some(list) => {
            for p in &list {
                let Some(name) = p["name"].as_str().filter(|n| provider_name(n)) else { continue };
                if p["supports_password"] != json!(true) || methods.iter().any(|m| matches!(m, SignInMethod::Password { provider, .. } if provider == name)) {
                    continue;
                }
                let label = p["display_name"]
                    .as_str()
                    .map(str::trim)
                    .filter(|l| !l.is_empty() && l.chars().count() <= LABEL_MAX && !l.chars().any(char::is_control))
                    .unwrap_or(name);
                methods.push(SignInMethod::Password { provider: name.to_owned(), label: label.to_owned() });
            }
        }
        None if names.contains(&PASSWORD_PROVIDER) => methods.push(basic()),
        None => {}
    }
    if names.contains(&TOKEN_PROVIDER) {
        methods.push(SignInMethod::Token);
    }
    if methods.is_empty() {
        return guess(MethodsNote::NoneSupported);
    }
    Methods { methods, note: None }
}

/// Whether `status` says the dashboard takes a token. Unknown (no status, or no list of providers) counts as yes, so
/// a status that can't be read doesn't stop a token sign-in; `/api/auth/me` still checks it.
pub fn takes_token(status: Option<&str>) -> bool {
    let Some(v) = status.and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok()) else { return true };
    match v["auth_providers"].as_array() {
        Some(names) => names.iter().any(|n| n.as_str() == Some(TOKEN_PROVIDER)),
        None => true,
    }
}

/// Refuses a token sign-in before the token goes out when `status` says the dashboard doesn't take one.
pub fn offered(sign_in: &SignIn, status: Option<&str>) -> Result<(), TransportError> {
    match sign_in.credential {
        Credential::Token(_) if !takes_token(status) => Err(TransportError::TokenNotOffered),
        _ => Ok(()),
    }
}

/// The sign-in methods the dashboard at `base` offers, given its `status` (`read_server`): reads `/api/auth/providers`
/// within `wait` when the status lists the native flow, which is when Hermes has an interactive provider to list.
pub async fn read_methods(base: &Url, headers: &HeaderMap, status: Option<&str>, wait: Duration) -> Methods {
    let native = status
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
        .and_then(|v| v["auth_flows"].as_array().map(|f| f.iter().any(|f| f.as_str() == Some("native_pkce"))))
        .unwrap_or(false);
    let providers = if native {
        let read = async {
            let resp = client(headers).ok()?.get(endpoint(base, "api/auth/providers")).send().await.ok()?;
            if !resp.status().is_success() {
                return None;
            }
            small_answer(resp).await.ok()
        };
        tokio::time::timeout(wait, read).await.ok().flatten()
    } else {
        None
    };
    sign_in_methods(status, providers.as_deref())
}

/// A local file the owner wants to attach: its size, or why it can't be attached.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LocalFile {
    pub path: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub async fn stat_files(attachable: &Attachable, paths: &[String]) -> Vec<LocalFile> {
    let mut out = Vec::with_capacity(paths.len());
    for path in paths {
        let name = std::path::Path::new(path).file_name().map_or(path.clone(), |n| n.to_string_lossy().into_owned());
        let size = match attachable.check(path) {
            Ok(()) => file_size(path).await,
            Err(e) => Err(e),
        };
        let (size, error) = match size {
            Ok(size) => (Some(size), None),
            Err(e) => (None, Some(e.to_string())),
        };
        out.push(LocalFile { path: path.clone(), name, size, error });
    }
    out
}

/// The most an image preview reads: Hermes's own limit for images, so a bigger one was refused when attached.
pub const PREVIEW_MAX_BYTES: u64 = 25 * MIB;

/// Reads a staged image for the composer's thumbnail. Only image files up to `PREVIEW_MAX_BYTES`, judged by both
/// their extension and their first bytes, so the webview can't use it to read anything else.
pub async fn read_preview(attachable: &Attachable, path: &str) -> Result<Vec<u8>, TransportError> {
    attachable.check(path)?;
    let p = std::path::Path::new(path);
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    // The extensions Hermes looks at as images (`IMAGE_EXTENSIONS` in transport.ts).
    if !p.is_absolute() || !matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp") {
        return Err(TransportError::File("it isn't an image".into()));
    }
    let bytes = read_capped(path, PREVIEW_MAX_BYTES).await?;
    checked_image(bytes)
}

fn checked_image(bytes: Vec<u8>) -> Result<Vec<u8>, TransportError> {
    let b = bytes.as_slice();
    let image = b.starts_with(b"\x89PNG\r\n\x1a\n")
        || b.starts_with(b"\xff\xd8\xff")
        || b.starts_with(b"GIF8")
        || b.starts_with(b"BM")
        || (b.len() >= 12 && b.starts_with(b"RIFF") && &b[8..12] == b"WEBP");
    if !image {
        return Err(TransportError::File("it isn't an image".into()));
    }
    Ok(bytes)
}

/// The most of a local file the preview pane reads: the same as Hermes reads of a server file
/// (`_FS_TEXT_PREVIEW_MAX_BYTES`), so both kinds of file show alike.
pub const LOCAL_TEXT_MAX_BYTES: u64 = 512 * 1024;

/// A local file's text for the preview pane: its first `LOCAL_TEXT_MAX_BYTES`, decoded as UTF-8 (bad bytes replaced),
/// and whether it looks binary, the way Hermes judges a server file (`_fs_looks_binary`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LocalText {
    pub size: u64,
    pub truncated: bool,
    pub binary: bool,
    pub text: String,
}

/// Opens only a regular file, without following a last-component symlink or blocking on a FIFO.
fn open_local_text(path: &str) -> Result<std::fs::File, TransportError> {
    if !std::path::Path::new(path).is_absolute() {
        return Err(TransportError::File("it isn't a full path".into()));
    }
    let file = local_fs::open_no_follow(std::path::Path::new(path)).map_err(|e| TransportError::File(e.to_string()))?;
    let meta = file.metadata().map_err(|e| TransportError::File(e.to_string()))?;
    if !meta.is_file() {
        return Err(TransportError::File(if meta.is_dir() { "it's a folder" } else { "it isn't a regular file" }.into()));
    }
    Ok(file)
}

/// The first `max` bytes of `file`, read a chunk at a time, so a small file costs its size and not the limit.
fn read_file_prefix(file: &std::fs::File, max: u64) -> Result<Vec<u8>, TransportError> {
    const CHUNK: u64 = 64 * 1024;
    let size = file.metadata().map_err(|e| TransportError::File(e.to_string()))?.len();
    let mut bytes = Vec::with_capacity(size.min(max) as usize);
    let mut chunk = vec![0; CHUNK.min(max) as usize];
    // Positional reads keep concurrent reloads from sharing or advancing the retained handle's offset.
    while (bytes.len() as u64) < max {
        let want = CHUNK.min(max - bytes.len() as u64) as usize;
        match local_fs::read_at(file, &mut chunk[..want], bytes.len() as u64) {
            Ok(0) => break,
            Ok(n) => bytes.extend_from_slice(&chunk[..n]),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(TransportError::File(e.to_string())),
        }
    }
    Ok(bytes)
}

async fn read_opened_text(file: std::sync::Arc<std::fs::File>) -> Result<LocalText, TransportError> {
    tokio::task::spawn_blocking(move || {
        let size = file.metadata().map_err(|e| TransportError::File(e.to_string()))?.len();
        let bytes = read_file_prefix(&file, LOCAL_TEXT_MAX_BYTES)?;
        let head = &bytes[..bytes.len().min(4096)];
        let control = head.iter().filter(|&&b| b < 32 && !matches!(b, 9 | 10 | 13)).count();
        let binary = head.contains(&0) || (!head.is_empty() && control as f64 / head.len() as f64 > 0.12);
        let text = if binary { String::new() } else { String::from_utf8_lossy(&bytes).into_owned() };
        Ok(LocalText { size, truncated: size > bytes.len() as u64, binary, text })
    })
    .await
    .map_err(|e| TransportError::File(e.to_string()))?
}

/// Reads the start of a local regular file. The preview IPC uses `PickedFiles::read` instead.
pub async fn read_local_text(path: &str) -> Result<LocalText, TransportError> {
    read_opened_text(std::sync::Arc::new(open_local_text(path)?)).await
}

/// Retains the files picked in the native dialog, so replacing a path cannot grant access to another file.
#[derive(Default)]
pub struct PickedFiles(Mutex<std::collections::HashMap<String, std::sync::Arc<std::fs::File>>>);

impl PickedFiles {
    pub fn allow(&self, path: &str) -> Result<String, TransportError> {
        let path = std::fs::canonicalize(path).map_err(|e| TransportError::File(e.to_string()))?;
        let path = path.to_str().ok_or_else(|| TransportError::File("the path isn't UTF-8".into()))?.to_owned();
        let file = open_local_text(&path)?;
        self.0.locked().insert(path.clone(), std::sync::Arc::new(file));
        Ok(path)
    }

    fn file(&self, path: &str) -> Result<std::sync::Arc<std::fs::File>, TransportError> {
        self.0.locked().get(path).cloned().ok_or_else(|| TransportError::File("it wasn't picked in the Open dialog".into()))
    }

    pub async fn read(&self, path: &str) -> Result<LocalText, TransportError> {
        read_opened_text(self.file(path)?).await
    }

    pub async fn read_image(&self, path: &str) -> Result<Vec<u8>, TransportError> {
        let file = self.file(path)?;
        tokio::task::spawn_blocking(move || {
            let size = file.metadata().map_err(|e| TransportError::File(e.to_string()))?.len();
            if size > PREVIEW_MAX_BYTES {
                return Err(TransportError::FileTooLarge { size, max: PREVIEW_MAX_BYTES });
            }
            let bytes = read_file_prefix(&file, PREVIEW_MAX_BYTES + 1)?;
            if bytes.len() as u64 > PREVIEW_MAX_BYTES {
                return Err(TransportError::FileTooLarge { size: bytes.len() as u64, max: PREVIEW_MAX_BYTES });
            }
            checked_image(bytes)
        })
        .await
        .map_err(|e| TransportError::File(e.to_string()))?
    }
}

const ATTACHABLE_KEPT: usize = 1000;

/// The local files the owner chose to attach: dropped on the window, picked in the composer's Open dialog, pasted or
/// captured as a screenshot. Only Rust adds to it, so a script in the webview can't send, stat or preview any other
/// file (ADR 0129). It is kept on disk, because queued and unsent messages keep their attachments across restarts.
#[derive(Default)]
pub struct Attachable {
    paths: Mutex<Vec<String>>,
    file: Mutex<Option<std::path::PathBuf>>,
}

impl Attachable {
    /// Reads the paths kept at `file`; later additions are written there.
    pub fn load(&self, file: std::path::PathBuf) {
        let kept = match std::fs::read(&file) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
                eprintln!("hermes-chat: {} isn't readable, so earlier attachments can't be sent: {e}", file.display());
                Vec::new()
            }),
            Err(_) => Vec::new(),
        };
        *self.paths.locked() = kept;
        *self.file.locked() = Some(file);
    }

    pub fn add(&self, paths: impl IntoIterator<Item = String>) {
        let mut kept = self.paths.locked();
        for path in paths {
            kept.retain(|p| *p != path);
            kept.push(path);
        }
        let over = kept.len().saturating_sub(ATTACHABLE_KEPT);
        kept.drain(..over);
        if let Some(file) = &*self.file.locked() {
            if let Err(e) = write_json(file, &*kept) {
                eprintln!("hermes-chat: couldn't keep the attached files' paths, so they can't be sent after a restart: {e}");
            }
        }
    }

    pub fn check(&self, path: &str) -> Result<(), TransportError> {
        if self.paths.locked().iter().any(|p| p == path) {
            Ok(())
        } else {
            Err(TransportError::File("it wasn't attached in this app".into()))
        }
    }
}

fn write_json(path: &std::path::Path, value: &impl Serialize) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    std::fs::write(&tmp, serde_json::to_vec(value)?)?;
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

/// Stages a file pasted into the composer in a slot of `captures` and returns its path. `name` is cut down to a safe
/// basename.
pub fn stage_clipboard_file(captures: &crate::screenshot::Captures, name: &str, bytes: &[u8]) -> Result<std::path::PathBuf, TransportError> {
    let failed = |e: &dyn std::fmt::Display| TransportError::File(format!("couldn't save the pasted file: {e}"));
    let path = captures.slot(&safe_name(name)).map_err(|e| failed(&e))?;
    if let Err(e) = std::fs::write(&path, bytes) {
        captures.discard(&path);
        return Err(failed(&e));
    }
    Ok(path)
}

/// How a local file is opened for the preview on this platform.
#[cfg(unix)]
mod local_fs {
    use std::fs::File;
    use std::os::unix::fs::{FileExt, OpenOptionsExt};
    use std::path::Path;

    pub fn open_no_follow(path: &Path) -> std::io::Result<File> {
        std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK).open(path)
    }

    pub fn read_at(file: &File, buf: &mut [u8], at: u64) -> std::io::Result<usize> {
        file.read_at(buf, at)
    }
}

/// Windows has no FIFOs in folders and no Unix modes. A link is opened as itself, so it isn't a regular file and is
/// refused.
#[cfg(windows)]
mod local_fs {
    use std::fs::File;
    use std::os::windows::fs::{FileExt, MetadataExt, OpenOptionsExt};
    use std::path::{Component, Path, Prefix};

    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

    pub fn open_no_follow(path: &Path) -> std::io::Result<File> {
        // `\\.\` names a device or a pipe, never a file in a folder.
        if matches!(path.components().next(), Some(Component::Prefix(p)) if matches!(p.kind(), Prefix::DeviceNS(_))) {
            return Err(std::io::Error::other("it isn't a regular file"));
        }
        let file = std::fs::OpenOptions::new().read(true).custom_flags(FILE_FLAG_OPEN_REPARSE_POINT).open(path)?;
        let meta = file.metadata()?;
        if meta.file_type().is_symlink() || meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0 {
            return Ok(file);
        }
        // A reparse point that isn't a link, such as a OneDrive file not yet on this computer, is opened again the
        // usual way so Windows fetches its contents. The same creation time and size say it is still the same file.
        let again = std::fs::OpenOptions::new().read(true).open(path)?;
        let now = again.metadata()?;
        if now.creation_time() != meta.creation_time() || now.file_size() != meta.file_size() {
            return Err(std::io::Error::other("the file changed while it was opened"));
        }
        Ok(again)
    }

    pub fn read_at(file: &File, buf: &mut [u8], at: u64) -> std::io::Result<usize> {
        file.seek_read(buf, at)
    }
}

/// `name` as a plain file name: no folders, control characters or leading dots, a sane length, and its extension
/// only when it looks like one (Hermes and the previews go by it).
fn safe_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or_default();
    let base: String = base.chars().filter(|c| !c.is_control()).collect();
    let base = base.trim().trim_start_matches('.');
    let (stem, ext) = match base.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() && (1..=8).contains(&e.len()) && e.chars().all(|c| c.is_ascii_alphanumeric()) => (s, e),
        _ => (base, ""),
    };
    // File names are capped at 255 bytes, not characters.
    let mut stem = stem.to_owned();
    while stem.len() > 200 {
        stem.pop();
    }
    let stem = if stem.trim().is_empty() { "clipboard" } else { stem.as_str() };
    if ext.is_empty() {
        stem.to_owned()
    } else {
        format!("{stem}.{ext}")
    }
}

/// Reads a whole file, refusing one over `max_bytes`; the size is checked again after reading, in case it grew.
async fn read_capped(path: &str, max_bytes: u64) -> Result<Vec<u8>, TransportError> {
    let too_large = |size| TransportError::FileTooLarge { size, max: max_bytes };
    let size = file_size(path).await?;
    if size > max_bytes {
        return Err(too_large(size));
    }
    // Read at most one byte past the limit, so a file that grew can't fill memory.
    let mut bytes = Vec::with_capacity(size as usize);
    let file = tokio::fs::File::open(path).await.map_err(|e| TransportError::File(e.to_string()))?;
    file.take(max_bytes.saturating_add(1)).read_to_end(&mut bytes).await.map_err(|e| TransportError::File(e.to_string()))?;
    if bytes.len() as u64 > max_bytes {
        return Err(too_large(bytes.len() as u64));
    }
    Ok(bytes)
}

async fn file_size(path: &str) -> Result<u64, TransportError> {
    let meta = tokio::fs::metadata(path).await.map_err(|e| TransportError::File(e.to_string()))?;
    if meta.is_dir() {
        return Err(TransportError::File("it's a folder".into()));
    }
    Ok(meta.len())
}

/// What the pipe reports to the webview. One `Frame` per JSON-RPC message.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PipeEvent {
    Frame { text: String },
    Closed { reason: String },
}

/// The most a file attached to a chat message may be, whatever limit the webview names: the most it attaches
/// (src/hermes/transport.ts `LIMITS.file.bytes`).
const ATTACHMENT_MAX_BYTES: u64 = 256 * MIB;

/// How many frames wait behind the one being written. Only a slow write fills it (a big file frame on a slow uplink,
/// #469), and no frame can go before that write ends anyway, so a bigger queue would only hold more memory. A JSON-RPC
/// frame can't be dropped: past it, `PipeSender::send` waits.
const PIPE_QUEUE: usize = 16;

/// A frame for the pipe task to write, and who hears once it has been written. `file`: a file frame's turn
/// (`PipeSender::send_file`), given back once it has been written.
struct Outgoing {
    text: String,
    written: Option<oneshot::Sender<Result<(), String>>>,
    file: Option<tokio::sync::OwnedSemaphorePermit>,
}

/// An open `/api/ws` connection. Dropping it closes the socket.
pub struct Pipe {
    sender: PipeSender,
    task: JoinHandle<()>,
}

/// What sends on a `Pipe`. A clone doesn't keep the socket open: once the `Pipe` is dropped, a send still waiting for
/// its turn fails with `Closed`, so nothing queued for one connection goes out after it is replaced or signed out of.
#[derive(Clone)]
pub struct PipeSender {
    outgoing: mpsc::Sender<Outgoing>,
    /// One permit: a file frame is the whole file as base64, up to about 341 MiB, so one is read and held at a time.
    files: std::sync::Arc<tokio::sync::Semaphore>,
}

impl Pipe {
    pub fn sender(&self) -> PipeSender {
        self.sender.clone()
    }
}

impl PipeSender {
    /// Queue one frame, waiting while `PIPE_QUEUE` frames already wait.
    pub async fn send(&self, text: String) -> Result<(), TransportError> {
        self.outgoing.send(Outgoing { text, written: None, file: None }).await.map_err(|_| TransportError::Closed)
    }

    /// Queue one frame: `head`, the file at `path` as base64, then `tail`. Refuses a file over `max_bytes` (at most
    /// `ATTACHMENT_MAX_BYTES`) without
    /// sending anything; the size is checked again after reading, in case it grew. The frame may take minutes to write
    /// on a slow uplink, so `Written` says when it has gone, and the webview can tell a long upload from a silent
    /// Hermes (#469).
    pub async fn send_file(&self, head: &str, path: &str, tail: &str, max_bytes: u64) -> Result<Written, TransportError> {
        let file = self.files.clone().acquire_owned().await.map_err(|_| TransportError::Closed)?;
        if self.outgoing.is_closed() {
            return Err(TransportError::Closed);
        }
        let bytes = read_capped(path, max_bytes.min(ATTACHMENT_MAX_BYTES)).await?;
        let mut text = String::with_capacity(head.len() + bytes.len().div_ceil(3) * 4 + tail.len());
        text.push_str(head);
        base64::engine::general_purpose::STANDARD.encode_string(&bytes, &mut text);
        drop(bytes);
        text.push_str(tail);
        let (written, sent) = oneshot::channel();
        self.outgoing.send(Outgoing { text, written: Some(written), file: Some(file) }).await.map_err(|_| TransportError::Closed)?;
        Ok(Written(sent))
    }
}

/// A frame `Pipe::send_file` queued, until it has been written to the socket.
pub struct Written(oneshot::Receiver<Result<(), String>>);

impl Written {
    /// Resolves once the frame has been written. `Closed` when the pipe was dropped or its socket ended first.
    pub async fn wait(self) -> Result<(), TransportError> {
        match self.0.await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => Err(TransportError::WebSocket(e)),
            Err(_) => Err(TransportError::Closed),
        }
    }
}

/// What the pipe does with one thing read from the socket: frames go to `on_event`. `Some(reason)`: the socket is done.
fn heard(msg: Option<Result<Message, tokio_tungstenite::tungstenite::Error>>, on_event: &impl Fn(PipeEvent), hide: &HeaderMap) -> Option<String> {
    match msg {
        // The server writes newline-delimited JSON-RPC; one WS message may carry several.
        Some(Ok(Message::Text(text))) => {
            for line in text.lines().filter(|l| !l.trim().is_empty()) {
                on_event(PipeEvent::Frame { text: line.to_owned() });
            }
            None
        }
        Some(Ok(Message::Close(frame))) => Some(frame.map_or("closed by the server".into(), |f| {
            // A gateway in front of the dashboard may close with the header values it turned down.
            let why = if repeats_header(&f.reason, hide) { HIDDEN } else { f.reason.as_str() };
            format!("closed by the server ({} {why})", f.code)
        })),
        Some(Ok(_)) => None,
        Some(Err(e)) => Some(e.to_string()),
        None => Some("closed by the server".into()),
    }
}

/// Runs an open `/api/ws` socket: writes what `Pipe` queues, one frame at a time, and hands every frame Hermes sends
/// to `on_event`, also while a big frame is still being written (an attachment can take minutes on a slow uplink,
/// #469). `hide`: what a close reason mustn't repeat.
fn run_pipe<S>(ws: tokio_tungstenite::WebSocketStream<S>, on_event: impl Fn(PipeEvent) + Send + 'static, hide: HeaderMap) -> Pipe
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (outgoing, mut to_server) = mpsc::channel::<Outgoing>(PIPE_QUEUE);
    let task = tokio::spawn(async move {
        let (mut sink, mut stream) = ws.split();
        let reason = 'socket: loop {
            tokio::select! {
                out = to_server.recv() => match out {
                    Some(Outgoing { text, written, file }) => {
                        let mut write = std::pin::pin!(sink.send(Message::text(text)));
                        let wrote = loop {
                            tokio::select! {
                                wrote = &mut write => break wrote.map_err(|e| e.to_string()),
                                msg = stream.next() => if let Some(reason) = heard(msg, &on_event, &hide) {
                                    if let Some(written) = written {
                                        let _ = written.send(Err(reason.clone()));
                                    }
                                    break 'socket reason;
                                },
                            }
                        };
                        drop(file);
                        let failed = wrote.as_ref().err().cloned();
                        if let Some(written) = written {
                            let _ = written.send(wrote);
                        }
                        if let Some(e) = failed {
                            break e;
                        }
                    }
                    None => {
                        let _ = sink.close().await;
                        break "closed by the app".into();
                    }
                },
                msg = stream.next() => if let Some(reason) = heard(msg, &on_event, &hide) {
                    break reason;
                },
            }
        };
        on_event(PipeEvent::Closed { reason });
    });
    Pipe { sender: PipeSender { outgoing, files: std::sync::Arc::new(tokio::sync::Semaphore::new(1)) }, task }
}

impl Drop for Pipe {
    fn drop(&mut self) {
        self.task.abort();
        self.sender.files.close();
    }
}

/// The most one write hands the socket. Windows takes a write of any size whole while its send buffer isn't full, and
/// tungstenite writes a frame in one call, so a big file frame counted as written at once while it still waited to go
/// out, and the silence check started over during the upload (#469). Capped, a write backs up there as it does on Linux.
/// Not smaller: tungstenite moves the rest of the frame down after each write, so a 256 MiB file over loopback takes
/// 6.5 s at 1 MiB (1.9 s uncapped, 24 s at 256 KiB). What is left when the frame counts as written, about this much,
/// goes in the 45 s silence limit down to about 256 kbit/s.
const WRITE_CAP: usize = 1024 * 1024;

/// A socket whose writes take at most `WRITE_CAP` bytes each.
struct CappedWrites<S>(S);

impl<S: tokio::io::AsyncRead + Unpin> tokio::io::AsyncRead for CappedWrites<S> {
    fn poll_read(self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>, buf: &mut tokio::io::ReadBuf<'_>) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.get_mut().0).poll_read(cx, buf)
    }
}

impl<S: tokio::io::AsyncWrite + Unpin> tokio::io::AsyncWrite for CappedWrites<S> {
    fn poll_write(self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>, buf: &[u8]) -> std::task::Poll<std::io::Result<usize>> {
        std::pin::Pin::new(&mut self.get_mut().0).poll_write(cx, &buf[..buf.len().min(WRITE_CAP)])
    }
    fn poll_flush(self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.get_mut().0).poll_flush(cx)
    }
    fn poll_shutdown(self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.get_mut().0).poll_shutdown(cx)
    }
}

type PipeSocket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<CappedWrites<tokio::net::TcpStream>>>;

/// Opens `/api/ws` as `connect_async` does, over a socket with capped writes.
async fn open_pipe_socket(handshake: tokio_tungstenite::tungstenite::handshake::client::Request) -> Result<PipeSocket, tokio_tungstenite::tungstenite::Error> {
    use tokio_tungstenite::tungstenite::error::{Error, UrlError};
    let uri = handshake.uri();
    let host = uri.host().ok_or(Error::Url(UrlError::NoHostName))?.trim_start_matches('[').trim_end_matches(']').to_owned();
    let port = uri
        .port_u16()
        .or(match uri.scheme_str() {
            Some("wss") => Some(443),
            Some("ws") => Some(80),
            _ => None,
        })
        .ok_or(Error::Url(UrlError::UnsupportedUrlScheme))?;
    let tcp = tokio::net::TcpStream::connect((host.as_str(), port)).await.map_err(Error::Io)?;
    Ok(tokio_tungstenite::client_async_tls(handshake, CappedWrites(tcp)).await?.0)
}

/// The session cookies, and the values most recently replaced or removed: a request may have sent one of those just
/// before, and its error page may repeat it (`Dashboard::hidden`).
#[derive(Default)]
struct Jar {
    live: Vec<(String, String)>,
    replaced: std::collections::VecDeque<String>,
}

/// How many replaced values the jar keeps hidden. The dashboard rotates its access and refresh cookies together, once
/// an access token expires, so this covers requests still in flight across eight rotations.
const REPLACED_COOKIES_KEPT: usize = 16;

/// A signed-in dashboard session. It keeps the session cookies up to date: the dashboard rotates an
/// expired access token through the refresh cookie on any request and sends the new ones back. A token sign-in has
/// no cookies: its `Authorization` header goes with every request instead (ADR 0058).
pub struct Dashboard {
    http: reqwest::Client,
    base: Url,
    cookies: Mutex<Jar>,
    /// The owner's extra request headers, and a token sign-in's `Authorization`; `http` sends them all itself, the
    /// WebSocket handshake adds the extra headers.
    headers: HeaderMap,
    /// What an error or close reason mustn't repeat to be shown: `headers`, and a token on its own, however short.
    /// Never sent. An error mustn't repeat the session cookies either (`hidden`).
    hide: HeaderMap,
    /// Signed in with a token: `headers` holds its `Authorization`, which `signed` adds to each request (`http` is
    /// the route's shared client, which doesn't carry it) and the WebSocket handshake leaves out, as the socket is let
    /// in by its ticket.
    token: bool,
}

impl Dashboard {
    /// Sign in at `base`, the dashboard root (e.g. the local end of the SSH tunnel), with `http`, the route's
    /// `client(&sign_in.headers)` that read its status (`read_server`), kept for every later request. A password goes
    /// to the provider's login form. A token is checked with `GET /api/auth/me`, which must name the session-token
    /// provider.
    pub async fn sign_in(http: reqwest::Client, base: &Url, sign_in: &SignIn) -> Result<Dashboard, TransportError> {
        match &sign_in.credential {
            Credential::Password { provider, username, password } => {
                let dashboard = Dashboard {
                    http,
                    base: base.clone(),
                    cookies: Mutex::default(),
                    headers: sign_in.headers.clone(),
                    hide: sign_in.headers.clone(),
                    token: false,
                };
                let provider = if provider_name(provider) { provider.as_str() } else { PASSWORD_PROVIDER };
                let login = dashboard
                    .http
                    .post(endpoint(base, "auth/password-login"))
                    .json(&json!({
                        "provider": provider,
                        "username": username,
                        "password": password,
                    }))
                    .send()
                    .await
                    .map_err(unreachable)?;
                match login.status() {
                    s if s.is_success() => {}
                    StatusCode::UNAUTHORIZED => return Err(TransportError::BadCredentials),
                    StatusCode::TOO_MANY_REQUESTS => return Err(TransportError::RateLimited),
                    // A 422, or a gateway in front, can echo the body back, password and all.
                    _ => return Err(unexpected_sent(login, &sign_in.headers, password, None).await),
                }
                dashboard.keep_cookies(&login);
                Ok(dashboard)
            }
            Credential::Token(token) => {
                if sign_in.headers.contains_key(header::AUTHORIZATION) {
                    return Err(TransportError::AuthorizationHeaderSet);
                }
                let token = token.trim();
                // A token is one word of visible ASCII; anything else can't go in a header, and isn't one Hermes made.
                if token.is_empty() || !token.bytes().all(|b| (b'!'..=b'~').contains(&b)) {
                    return Err(TransportError::BadToken);
                }
                let mut bearer = HeaderValue::from_str(&format!("Bearer {token}")).map_err(|_| TransportError::BadToken)?;
                bearer.set_sensitive(true);
                let mut headers = sign_in.headers.clone();
                headers.insert(header::AUTHORIZATION, bearer);
                let mut hide = headers.clone();
                let mut bare = HeaderValue::from_str(token).map_err(|_| TransportError::BadToken)?;
                bare.set_sensitive(true);
                // Appended: an extra header of the same name keeps its own value hidden too.
                hide.append(HeaderName::from_static("x-hermes-chat-token"), bare);
                let dashboard = Dashboard { http, base: base.clone(), cookies: Mutex::default(), headers, hide, token: true };
                let me = dashboard.signed(Method::GET, endpoint(base, "api/auth/me")).send().await.map_err(unreachable)?;
                match me.status() {
                    s if s.is_success() => {}
                    StatusCode::UNAUTHORIZED => return Err(TransportError::BadToken),
                    StatusCode::TOO_MANY_REQUESTS => return Err(TransportError::RateLimited),
                    _ => return Err(unexpected(me, &dashboard.hide).await),
                }
                let me = small_json(me).await?;
                // Only a provider Hermes ships is named: anything else the server put there could be the token itself.
                match me["provider"].as_str() {
                    Some(TOKEN_PROVIDER) => Ok(dashboard),
                    Some(other @ ("basic" | "self-hosted" | "nous" | "drain-secret" | "loopback")) => Err(TransportError::NotSessionToken(other.to_owned())),
                    _ => Err(TransportError::NotSessionToken("different".into())),
                }
            }
        }
    }

    /// Mint a WS ticket and open `/api/ws` for `profile`. Every frame the server sends, starting with
    /// `gateway.ready`, goes to `on_event`.
    pub async fn open_pipe(&self, profile: &str, on_event: impl Fn(PipeEvent) + Send + 'static) -> Result<Pipe, TransportError> {
        self.open_pipe_within(profile, on_event, None, &Steps::default()).await
    }

    /// `open_pipe`, the ticket and the socket's connect each within `limits` when given (one of several routes), and
    /// each a step of `steps`.
    pub async fn open_pipe_within(
        &self,
        profile: &str,
        on_event: impl Fn(PipeEvent) + Send + 'static,
        limits: Option<StepLimits>,
        steps: &Steps,
    ) -> Result<Pipe, TransportError> {
        let ticket = steps
            .run(
                Step::Ticket,
                within(limits.map(|l| l.ticket), self.ws_ticket(), |s| {
                    TransportError::Unreachable(format!("the chat connection's ticket didn't answer within {s}s."))
                }),
            )
            .await?;
        let handshake = self.ws_handshake("api/ws", &[("ticket", &ticket), ("profile", profile)])?;
        let connecting = async { open_pipe_socket(handshake).await.map_err(|e| TransportError::WebSocket(e.to_string())) };
        let ws = steps
            .run(Step::WebSocket, within(limits.map(|l| l.socket), connecting, |s| TransportError::WebSocket(format!("it didn't open within {s}s."))))
            .await?;

        Ok(run_pipe(ws, on_event, self.hide.clone()))
    }

    /// A single-use ticket for `/api/ws`.
    async fn ws_ticket(&self) -> Result<String, TransportError> {
        let ticket = self.signed(Method::POST, endpoint(&self.base, "api/auth/ws-ticket")).send().await.map_err(unreachable)?;
        self.keep_cookies(&ticket);
        if !ticket.status().is_success() {
            return Err(unexpected(ticket, &self.hidden()).await);
        }
        let ticket = small_json(ticket).await?;
        ticket["ticket"].as_str().map(str::to_owned).ok_or_else(|| TransportError::Unexpected { status: 200, body: "ws-ticket response has no ticket".into() })
    }

    /// The WebSocket handshake for `path` under the dashboard, with `query` and the owner's extra request headers. No
    /// cookie: each socket is let in by its own single-use ticket in the query, as the official clients do.
    pub fn ws_handshake(&self, path: &str, query: &[(&str, &str)]) -> Result<tokio_tungstenite::tungstenite::handshake::client::Request, TransportError> {
        let mut ws_url = endpoint(&self.base, path);
        ws_url.set_scheme(if self.base.scheme() == "https" { "wss" } else { "ws" }).expect("http(s) URLs map to ws(s)");
        ws_url.query_pairs_mut().extend_pairs(query);
        let mut handshake = ws_url.as_str().into_client_request().map_err(|e| TransportError::WebSocket(e.to_string()))?;
        for (name, value) in &self.headers {
            if self.token && name == header::AUTHORIZATION {
                continue;
            }
            handshake.headers_mut().insert(name, value.clone());
        }
        Ok(handshake)
    }

    /// Whether a server's close reason may repeat the owner's extra request headers, so it mustn't be shown.
    pub fn hides_reason(&self, reason: &str) -> bool {
        repeats_header(reason, &self.hide)
    }

    /// One dashboard REST call for the webview: `GET`, `PATCH` or `DELETE` on a path under `api/`, with a
    /// JSON body. `POST` and `PUT` reach only Settings → Model's two writes (`POST api/model/set`,
    /// `PUT api/config`), the scheduled-job writes (`cron_write`), Settings → Persona's
    /// `PUT api/profiles/{name}/soul`, the Clone profile dialog's `POST api/profiles` (`profile_create_allowed`, ADR 0074),
    /// and Settings → Toolsets' switch, `PUT api/tools/toolsets/<name>` with exactly
    /// `{"enabled": true|false}` (`toolset_toggle_allowed`), Settings → Skills' two writes, `PUT api/skills/toggle` and
    /// `PUT api/skills/content` with exactly their fields (`skill_write_allowed`), Settings → Skills' copy to another
    /// profile, `POST api/skills` (`skill_create_allowed`), Settings → Memory's entry edit for any profile, `PUT
    /// api/learning/node` naming a memory entry (`memory_entry_edit_allowed`), and Import transcripts'
    /// `POST api/sessions/import` whose every session is marked `source: "import"` (`import_body_allowed`, ADR 0031),
    /// the Automations writes (`webhook_write`, ADR 0108), Settings → Memory's external memory writes
    /// (`memory_provider_write`, ADR 0045), and Settings → Voice's provider pick and key save (`voice_provider_write`,
    /// ADR 0115), Settings → MCP servers' add, switch, test, sign-in and catalog install (`mcp::relayed`, ADR 0121), and
    /// Settings → Gateways' Telegram and Discord save and status check (`gateway_write`, ADR 0073).
    /// Settings → Providers' two writes that carry nothing secret, starting a sign-in and activating an endpoint
    /// (`provider_account_write`, ADR 0133).
    /// `DELETE api/env` is refused whatever the body: a key leaves the server only through
    /// `Dashboard::remove_provider_key`, which checks that it is a model provider's (ADR 0095).
    /// `GET api/config` comes back without its credentials, and `GET` on the raw config and on the sign-in and endpoint
    /// lists is refused (ADR 0138).
    /// Returns the response body on 2xx.
    pub async fn request(&self, method: &str, path_and_query: &str, body: Option<String>) -> Result<String, TransportError> {
        let (path, query) = path_and_query.split_once('?').unwrap_or((path_and_query, ""));
        let method = match (method, path) {
            ("GET", _) => Method::GET,
            ("PATCH", _) => Method::PATCH,
            ("DELETE", _) => Method::DELETE,
            ("POST", "api/model/set") => Method::POST,
            ("PUT", "api/config") => Method::PUT,
            ("POST", _) if cron_write("POST", path) => Method::POST,
            ("PUT", _) if cron_write("PUT", path) => Method::PUT,
            ("PUT", _) if toolset_toggle_allowed(path, body.as_deref()) => Method::PUT,
            ("PUT", _) if voice_provider_write(path, body.as_deref()) => Method::PUT,
            ("PUT", _) if skill_write_allowed(path, body.as_deref()) => Method::PUT,
            ("POST", "api/skills") if skill_create_allowed(body.as_deref()) => Method::POST,
            ("PUT", "api/learning/node") if memory_entry_edit_allowed(body.as_deref()) => Method::PUT,
            ("PUT", _) if memory_provider_write("PUT", path, body.as_deref()) => Method::PUT,
            ("POST", _) if memory_provider_write("POST", path, body.as_deref()) => Method::POST,
            ("POST", _) if webhook_write("POST", path, body.as_deref()) => Method::POST,
            ("PUT", _) if webhook_write("PUT", path, body.as_deref()) => Method::PUT,
            ("PUT", p) if is_profile_soul(p) => Method::PUT,
            ("POST", "api/profiles") if profile_create_allowed(body.as_deref()) => Method::POST,
            ("POST", "api/sessions/import") if import_body_allowed(body.as_deref()) => Method::POST,
            ("POST", _) if crate::mcp::relayed("POST", path, body.as_deref()) => Method::POST,
            ("PUT", _) if crate::mcp::relayed("PUT", path, body.as_deref()) => Method::PUT,
            ("POST", _) if gateway_write("POST", path, body.as_deref()) => Method::POST,
            ("PUT", _) if gateway_write("PUT", path, body.as_deref()) => Method::PUT,
            ("POST", _) if provider_account_write(path, body.as_deref()) => Method::POST,
            ("POST" | "PUT", _) => return Err(TransportError::NotRelayed(format!("{method} {path}"))),
            (other, _) => return Err(TransportError::NotRelayed(format!("{other} requests"))),
        };
        let (url, routed) = relay_url(&self.base, path, query)?;
        // Server files are read-only (ADR 0012): nothing but GET goes to the server's file routes, checked on the
        // path as the server will route it, so `api/./files` or `api/%66iles` can't slip past.
        if method != Method::GET && is_file_route(&routed) {
            return Err(TransportError::NotRelayed(format!("{method} {path}")));
        }
        if method == Method::DELETE && is_env_route(&routed) {
            return Err(TransportError::NotRelayed(format!("{method} {path}")));
        }
        let segments: Vec<&str> = routed.split('/').filter(|seg| !seg.is_empty()).collect();
        // The config as written, and the two lists Rust reads without their previews (ADR 0133, ADR 0138).
        if method == Method::GET && matches!(segments.as_slice(), ["api", "config", "raw"] | ["api", "providers", "oauth" | "custom-endpoints"]) {
            return Err(TransportError::NotRelayed(format!("{method} {path}")));
        }
        let config = method == Method::GET && segments == ["api", "config"];
        let idle = if method == Method::GET && is_session_list(&routed) { SESSION_LIST_IDLE_LIMIT } else { ANSWER_IDLE_LIMIT };
        // Hermes answers removing an endpoint with the endpoints left, each with its key's preview (ADR 0133).
        let answer_unread = method == Method::DELETE && routed.starts_with("api/providers/custom-endpoints/");
        let mut req = self.signed(method, url);
        if let Some(body) = body {
            req = req.header(header::CONTENT_TYPE, "application/json").body(body);
        }
        let resp = unless_stalled(idle, req.send()).await?;
        self.keep_cookies(&resp);
        match resp.status() {
            s if s.is_success() && answer_unread => Ok(r#"{"ok":true}"#.to_owned()),
            s if s.is_success() && config => config_without_credentials(&text_unless_stalled(resp, idle).await?),
            s if s.is_success() => text_unless_stalled(resp, idle).await,
            StatusCode::UNAUTHORIZED => Err(TransportError::SignedOut),
            _ => Err(unexpected_sent(resp, &self.hidden(), "", Some(idle)).await),
        }
    }

    /// Sends a recording to Hermes to transcribe with `profile`'s speech-to-text provider (`POST
    /// /api/audio/transcribe`). `mime` must be an audio type. Hermes deletes its temporary copy once it has the text.
    pub async fn transcribe(&self, profile: &str, mime: &str, audio: &[u8]) -> Result<Transcript, TransportError> {
        let mime = audio_mime(mime).ok_or_else(|| TransportError::Voice("The recording isn't audio.".into()))?;
        if audio.is_empty() {
            return Err(TransportError::Voice("The recording is empty.".into()));
        }
        if audio.len() as u64 > TRANSCRIBE_MAX_BYTES {
            return Err(TransportError::Voice(format!(
                "The recording is too long to transcribe: {}.",
                TransportError::FileTooLarge { size: audio.len() as u64, max: TRANSCRIBE_MAX_BYTES }
            )));
        }
        let mut data_url = String::with_capacity(mime.len() + 13 + audio.len().div_ceil(3) * 4);
        data_url.push_str("data:");
        data_url.push_str(&mime);
        data_url.push_str(";base64,");
        base64::engine::general_purpose::STANDARD.encode_string(audio, &mut data_url);
        let body = json!({"data_url": data_url, "mime_type": mime});
        match self.post_audio("api/audio/transcribe", profile, &body).await? {
            AudioAnswer::Done(v) => match v["transcript"].as_str() {
                Some(text) => Ok(Transcript { text: text.trim().to_owned(), provider: config_word(&v["provider"]) }),
                None => Err(TransportError::Voice("Hermes answered without a transcript.".into())),
            },
            AudioAnswer::NoRoute => Err(TransportError::NoVoiceRoute("transcribe recordings", "/api/audio/transcribe")),
            AudioAnswer::Refused(why) => Err(TransportError::Voice(format!("Hermes couldn't transcribe the recording: {why}"))),
        }
    }

    /// Asks Hermes to read `text` aloud with `profile`'s text-to-speech provider (`POST /api/audio/speak`). Hermes
    /// strips the Markdown and splits long text itself, and deletes its audio file once it has sent it.
    pub async fn speak(&self, profile: &str, text: &str) -> Result<Speech, TransportError> {
        if text.trim().is_empty() {
            return Err(TransportError::Voice("There's nothing to read aloud.".into()));
        }
        let v = match self.post_audio("api/audio/speak", profile, &json!({"text": text})).await? {
            AudioAnswer::Done(v) => v,
            AudioAnswer::NoRoute => return Err(TransportError::NoVoiceRoute("read replies aloud", "/api/audio/speak")),
            AudioAnswer::Refused(why) => return Err(TransportError::Voice(format!("Hermes couldn't read it aloud: {why}"))),
        };
        let bad = || TransportError::Voice("Hermes answered with audio this app can't read.".into());
        let (head, encoded) = v["data_url"].as_str().and_then(|u| u.strip_prefix("data:")?.split_once(',')).ok_or_else(bad)?;
        let mime = head.strip_suffix(";base64").and_then(audio_mime).ok_or_else(bad)?;
        let audio = base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|_| bad())?;
        if audio.is_empty() {
            return Err(bad());
        }
        Ok(Speech { mime, audio, provider: config_word(&v["provider"]) })
    }

    /// Reads whether the server has the two audio routes, and which providers `profile`'s config names. The routes
    /// are asked with bodies they refuse before doing any work (an empty recording, no text), so nothing is
    /// transcribed or spoken. Only the provider names, `stt.enabled`, the three `voice.*` turn settings and each
    /// provider's model, voice and language (`VOICE_SETTING_KEYS`) are kept from the config.
    pub async fn voice_setup(&self, profile: &str) -> Result<VoiceSetup, TransportError> {
        let has = |a: AudioAnswer| !matches!(a, AudioAnswer::NoRoute);
        let query = url::form_urlencoded::Serializer::new(String::new()).append_pair("profile", profile).finish();
        let (no_recording, no_text, config_path) = (json!({"data_url": ""}), json!({"text": ""}), format!("api/config?{query}"));
        let (transcribe, speak, config) = tokio::join!(
            self.post_audio("api/audio/transcribe", profile, &no_recording),
            self.post_audio("api/audio/speak", profile, &no_text),
            self.request("GET", &config_path, None),
        );
        let (transcribe, speak) = (has(transcribe?), has(speak?));
        let config: Option<serde_json::Value> = match config {
            Ok(body) => serde_json::from_str(&body).ok(),
            Err(TransportError::SignedOut) => return Err(TransportError::SignedOut),
            Err(_) => None,
        };
        let (stt_enabled, stt_provider, tts_provider) = match &config {
            Some(c) => (Some(truthy(&c["stt"]["enabled"])), config_word(&c["stt"]["provider"]), config_word(&c["tts"]["provider"])),
            None => (None, None, None),
        };
        let voice = |key: &str| config.as_ref().and_then(|c| config_number(&c["voice"][key]));
        let settings = |kind: &str| config.as_ref().map(|c| voice_settings(&c[kind])).unwrap_or_default();
        Ok(VoiceSetup {
            transcribe,
            speak,
            stt_enabled,
            stt_provider,
            tts_provider,
            silence_threshold: voice("silence_threshold"),
            silence_duration: voice("silence_duration"),
            max_recording_seconds: voice("max_recording_seconds"),
            stt_language: config.as_ref().and_then(|c| voice_setting_text(&c["stt"]["language"])),
            stt_settings: settings("stt"),
            tts_settings: settings("tts"),
        })
    }

    /// `ToolsetGuards` for `profile`, from `GET /api/config`; nothing else of the config is kept.
    pub async fn toolset_guards(&self, profile: &str) -> Result<ToolsetGuards, TransportError> {
        let query = url::form_urlencoded::Serializer::new(String::new()).append_pair("profile", profile).finish();
        let body = self.request("GET", &format!("api/config?{query}"), None).await?;
        let config: serde_json::Value =
            serde_json::from_str(&body).map_err(|_| TransportError::Unexpected { status: 200, body: "the profile's config isn't JSON".into() })?;
        Ok(toolset_guards(&config))
    }

    /// One `POST` to an audio route for `profile`, with a JSON body.
    async fn post_audio(&self, path: &str, profile: &str, body: &serde_json::Value) -> Result<AudioAnswer, TransportError> {
        let mut url = endpoint(&self.base, path);
        url.query_pairs_mut().append_pair("profile", profile);
        let resp = unless_stalled(ANSWER_IDLE_LIMIT, self.signed(Method::POST, url).json(body).send()).await?;
        self.keep_cookies(&resp);
        let status = resp.status();
        if status == StatusCode::UNAUTHORIZED {
            return Err(TransportError::SignedOut);
        }
        if status.is_redirection() {
            return Err(unexpected(resp, &self.hidden()).await);
        }
        let text = text_unless_stalled(resp, ANSWER_IDLE_LIMIT).await?;
        if status.is_success() {
            return serde_json::from_str(&text)
                .map(AudioAnswer::Done)
                .map_err(|_| TransportError::Unexpected { status: status.as_u16(), body: shown_body(status, &text, &self.hidden()) });
        }
        let reason = refusal_reason(status, &text, &self.hidden());
        // FastAPI's own "no such route" (and the headless backend's catch-all) differ from a refusal by the route
        // itself, such as an unknown profile, which also answers 404 but with its own reason.
        let no_route = match status {
            StatusCode::METHOD_NOT_ALLOWED => true,
            StatusCode::NOT_FOUND => reason == "Not Found" || reason.starts_with("Headless backend") || reason.starts_with("the server answered"),
            _ => false,
        };
        Ok(if no_route { AudioAnswer::NoRoute } else { AudioAnswer::Refused(reason) })
    }

    /// A dashboard REST `GET` under `api/` whose answer may be big, such as a server file's contents from
    /// `api/files/read`. It stops reading, and refuses the answer, once it passes `max_bytes` (at most
    /// `RELAY_MAX_BYTES`), so a file that grew since it was listed can't fill memory. Returns the response body on 2xx.
    pub async fn get_limited(&self, path_and_query: &str, max_bytes: u64) -> Result<String, TransportError> {
        let (path, query) = path_and_query.split_once('?').unwrap_or((path_and_query, ""));
        let body = self.send_limited(Method::GET, path, query, None, max_bytes.min(RELAY_MAX_BYTES)).await?;
        String::from_utf8(body).map_err(|_| TransportError::Unexpected { status: 200, body: "the answer isn't UTF-8 text".into() })
    }

    /// One request with an optional JSON body, whose answer is read only up to `max_bytes`, as `get_limited` reads.
    /// Unlike `request`, it sends writes to the file routes: it is only for commands that check their own paths first,
    /// such as a project's context files (`project_context.rs`, ADR 0135). Returns the answer's bytes on 2xx.
    pub(crate) async fn send_limited(
        &self,
        method: Method,
        path: &str,
        query: &str,
        json: Option<&serde_json::Value>,
        max_bytes: u64,
    ) -> Result<Vec<u8>, TransportError> {
        let (url, _) = relay_url(&self.base, path, query)?;
        let mut req = self.signed(method, url);
        if let Some(json) = json {
            req = req.json(json);
        }
        let resp = unless_stalled(ANSWER_IDLE_LIMIT, req.send()).await?;
        self.keep_cookies(&resp);
        match resp.status() {
            s if s.is_success() => {}
            StatusCode::UNAUTHORIZED => return Err(TransportError::SignedOut),
            _ => return Err(unexpected(resp, &self.hidden()).await),
        }
        read_body(resp, max_bytes, ANSWER_IDLE_LIMIT).await.map_err(|e| match e {
            // These answers are files, and Outputs tells one over its limit by `FileTooLarge`'s text.
            TransportError::AnswerTooLarge { size, max } => TransportError::FileTooLarge { size, max },
            e => e,
        })
    }

    /// Downloads the Server file at `server_path` through the managed-files route `GET api/files/download` (ADR 0023)
    /// into `dest` on this computer. The bytes go to a hidden `.part` file beside `dest`, which replaces `dest` only
    /// once every byte the server announced has arrived; on any failure, or when the task is aborted (Cancel), the
    /// part file is removed and `dest` is left as it was. `progress` gets the bytes written so far and the size the
    /// server announced. Memory stays bounded: one network chunk at a time.
    ///
    /// The file work is synchronous on purpose. An aborted task stops only at an `.await`, and every `.await` here is
    /// on the network, so an abort can't leave a file operation running on its own: a part file is never left behind,
    /// and once the rename into place has happened, nothing can stop the download from returning that it did. It runs
    /// through `blocking`, so a slow disk holds up only this transfer, not the runtime's other work.
    pub async fn download(&self, server_path: &str, dest: &std::path::Path, progress: impl Fn(u64, Option<u64>)) -> Result<u64, TransportError> {
        use std::io::Write;
        let query = url::form_urlencoded::Serializer::new(String::new()).append_pair("path", server_path).finish();
        let (url, _) = relay_url(&self.base, "api/files/download", &query)?;
        let mut resp = self.signed(Method::GET, url).send().await.map_err(unreachable)?;
        self.keep_cookies(&resp);
        match resp.status() {
            s if s.is_success() => {}
            StatusCode::UNAUTHORIZED => return Err(TransportError::SignedOut),
            _ => return Err(unexpected(resp, &self.hidden()).await),
        }
        let total = resp.content_length();
        let io = |e: std::io::Error| TransportError::File(format!("couldn't write it on this computer: {e}"));
        let (part, mut out) = blocking(|| PartFile::create(dest)).map_err(io)?;
        let mut written = 0u64;
        let mut told = std::time::Instant::now();
        progress(0, total);
        while let Some(chunk) = resp.chunk().await.map_err(unreachable)? {
            blocking(|| out.write_all(&chunk)).map_err(io)?;
            written += chunk.len() as u64;
            if total.is_some_and(|t| written > t) {
                return Err(TransportError::File("the server sent more than it said the file holds".into()));
            }
            if told.elapsed() >= Duration::from_millis(100) {
                progress(written, total);
                told = std::time::Instant::now();
            }
        }
        if let Some(total) = total.filter(|&t| written != t) {
            return Err(TransportError::File(format!("the download ended early, after {written} of {total} bytes")));
        }
        blocking(|| out.sync_all()).map_err(io)?;
        drop(out);
        blocking(|| std::fs::rename(&part.0, dest)).map_err(io)?;
        part.keep();
        progress(written, total);
        Ok(written)
    }

    /// Uploads `source` (a local file, or the text of an edit) to `server_path` through the managed-files route `POST
    /// api/files/upload-stream` (ADR 0023), streamed one chunk at a time. Hermes writes it to a temp file beside the
    /// target and renames it into place, so a cancelled or broken upload never leaves part of a file there. With
    /// `overwrite` false, Hermes refuses with 409 when a file is already there. Hermes doesn't keep credential files
    /// out of its write routes, so a path it would never list or read (`protected_server_path`) is refused here,
    /// before anything is sent. Returns Hermes's answer: the written entry as JSON.
    pub async fn upload(
        &self,
        server_path: &str,
        source: UploadSource,
        overwrite: bool,
        progress: impl Fn(u64, Option<u64>) + Send + Sync + 'static,
    ) -> Result<String, TransportError> {
        use tokio::io::AsyncReadExt;
        if protected_server_path(server_path) {
            return Err(TransportError::NotRelayed(format!("uploads to {server_path}, a credential file Hermes keeps out of reach")));
        }
        let name = server_path.rsplit('/').next().filter(|n| !n.is_empty() && *n != "." && *n != "..");
        let Some(name) = name.map(str::to_owned) else {
            return Err(TransportError::NotRelayed(format!("uploads to {server_path}")));
        };
        let part = match source {
            UploadSource::Bytes(bytes) => {
                let size = bytes.len() as u64;
                if size > MANAGED_FILE_MAX_BYTES {
                    return Err(TransportError::FileTooLarge { size, max: MANAGED_FILE_MAX_BYTES });
                }
                progress(0, Some(size));
                let part = reqwest::multipart::Part::bytes(bytes);
                progress(size, Some(size));
                part
            }
            UploadSource::File(local) => {
                let io = |e: std::io::Error| TransportError::File(format!("couldn't read it on this computer: {e}"));
                let file = tokio::fs::File::open(local).await.map_err(io)?;
                let size = file.metadata().await.map_err(io)?.len();
                if size > MANAGED_FILE_MAX_BYTES {
                    return Err(TransportError::FileTooLarge { size, max: MANAGED_FILE_MAX_BYTES });
                }
                // The file as it was measured: no more than `size` bytes go, and a file that shrank meanwhile fails the upload
                // rather than leaving a short file on the server.
                let mut told = std::time::Instant::now();
                progress(0, Some(size));
                let chunks = futures_util::stream::try_unfold((file, 0u64), move |(mut file, sent)| {
                    let more = (size - sent).min(UPLOAD_CHUNK_BYTES as u64) as usize;
                    let elapsed = told.elapsed();
                    if elapsed >= Duration::from_millis(100) || sent == size {
                        progress(sent, Some(size));
                        told = std::time::Instant::now();
                    }
                    async move {
                        if more == 0 {
                            return Ok(None);
                        }
                        let mut buf = vec![0u8; more];
                        file.read_exact(&mut buf).await.map_err(|e| std::io::Error::new(e.kind(), format!("couldn't read it on this computer: {e}")))?;
                        Ok::<_, std::io::Error>(Some((buf, (file, sent + more as u64))))
                    }
                });
                reqwest::multipart::Part::stream_with_length(reqwest::Body::wrap_stream(chunks), size)
            }
        };
        let part = part.file_name(name).mime_str("application/octet-stream").expect("a valid MIME type");
        let form =
            reqwest::multipart::Form::new().text("path", server_path.to_owned()).text("overwrite", if overwrite { "true" } else { "false" }).part("file", part);
        let (url, _) = relay_url(&self.base, "api/files/upload-stream", "")?;
        let resp = self.signed(Method::POST, url).multipart(form).send().await.map_err(unreachable)?;
        self.keep_cookies(&resp);
        match resp.status() {
            s if s.is_success() => small_answer(resp).await,
            StatusCode::UNAUTHORIZED => Err(TransportError::SignedOut),
            _ => Err(unexpected(resp, &self.hidden()).await),
        }
    }

    /// Writes an artifact's whole new text to `path` where `profile`'s tools run, through the agent fs route `POST
    /// api/fs/write-text?profile=` (ADR 0029). That is the machine an Output written by `write_file` or `patch` is on:
    /// the profile's SSH workspace when it has one, else the dashboard's own. Hermes stages the text beside the file and
    /// renames it into place, and checks nothing else, so the webview checks the file's revision first and reads it
    /// back after; this only writes. Only a full path is sent, never a credential file (`protected_server_path`: Hermes
    /// doesn't guard this route), and never more than Hermes takes. `session`: the chat whose sandbox the path is in
    /// (ADR 0062), sent as `session_id` so Hermes saves where `read-data-url` with the same chat read. Returns Hermes's
    /// answer.
    pub async fn write_agent_text(&self, profile: &str, path: &str, text: &str, session: Option<&str>) -> Result<String, TransportError> {
        if !(path.starts_with('/') || path.starts_with("~/")) || path.contains('\0') || path.ends_with('/') {
            return Err(TransportError::NotRelayed(format!("writes to {path}: not a full path to a file")));
        }
        if path.split('/').any(|seg| seg == "..") {
            return Err(TransportError::NotRelayed(format!("writes to {path}: it has '..' in it")));
        }
        if protected_server_path(path) {
            return Err(TransportError::NotRelayed(format!("writes to {path}, a credential file Hermes keeps out of reach")));
        }
        let size = text.len() as u64;
        if size > AGENT_TEXT_MAX_BYTES {
            return Err(TransportError::FileTooLarge { size, max: AGENT_TEXT_MAX_BYTES });
        }
        let body = agent_text_body(path, text, session)?;
        let query = url::form_urlencoded::Serializer::new(String::new()).append_pair("profile", profile).finish();
        let (url, _) = relay_url(&self.base, "api/fs/write-text", &query)?;
        let resp = unless_stalled(ANSWER_IDLE_LIMIT, self.signed(Method::POST, url).json(&body).send()).await?;
        self.keep_cookies(&resp);
        match resp.status() {
            s if s.is_success() => text_unless_stalled(resp, ANSWER_IDLE_LIMIT).await,
            StatusCode::UNAUTHORIZED => Err(TransportError::SignedOut),
            _ => Err(unexpected(resp, &self.hidden()).await),
        }
    }

    /// Take in every Set-Cookie: a new value replaces the old one, and an empty one or one set to expire (`expired`)
    /// deletes it. Only `name=value` is kept; the dashboard is the only site this jar talks to.
    fn keep_cookies(&self, resp: &reqwest::Response) {
        let mut jar = self.cookies.locked();
        for v in resp.headers().get_all(header::SET_COOKIE) {
            let Some((pair, attributes)) = v.to_str().ok().map(|v| v.split_once(';').unwrap_or((v, ""))) else {
                continue;
            };
            let Some((name, value)) = pair.split_once('=') else {
                continue;
            };
            let (name, value) = (name.trim(), value.trim());
            let kept = !value.is_empty() && !expired(attributes);
            if let Some(at) = jar.live.iter().position(|(n, _)| n == name) {
                let (_, old) = jar.live.remove(at);
                if !(kept && old == value) {
                    if jar.replaced.len() == REPLACED_COOKIES_KEPT {
                        jar.replaced.pop_front();
                    }
                    jar.replaced.push_back(old);
                }
            }
            if kept {
                jar.live.push((name.to_owned(), value.to_owned()));
            }
        }
    }

    /// What an error mustn't repeat to be shown: `hide`, and the value of each session cookie, held or lately replaced
    /// (`Jar`), as a `cookie` entry that `shown_body` doesn't count as an extra request header. A value shorter than
    /// `HEADER_PIECE` is left out: no session cookie is that short, and one such as `1` would hide nearly every error.
    fn hidden(&self) -> HeaderMap {
        let mut hide = self.hide.clone();
        let jar = self.cookies.locked();
        for value in jar.live.iter().map(|(_, v)| v).chain(&jar.replaced).filter(|v| v.len() >= HEADER_PIECE) {
            if let Ok(mut value) = HeaderValue::from_str(value) {
                value.set_sensitive(true);
                hide.append(header::COOKIE, value);
            }
        }
        hide
    }

    /// A request on the shared client with what the sign-in holds: the session cookies, or a token sign-in's
    /// `Authorization`.
    fn signed(&self, method: Method, url: Url) -> reqwest::RequestBuilder {
        let mut req = self.http.request(method, url);
        let cookies = self.cookie_header();
        if !cookies.is_empty() {
            req = req.header(header::COOKIE, cookies);
        }
        match self.headers.get(header::AUTHORIZATION).filter(|_| self.token) {
            Some(bearer) => req.header(header::AUTHORIZATION, bearer.clone()),
            None => req,
        }
    }

    fn cookie_header(&self) -> String {
        let jar = self.cookies.locked();
        jar.live.iter().map(|(n, v)| format!("{n}={v}")).collect::<Vec<_>>().join("; ")
    }
}

/// Whether a Set-Cookie's attributes (what follows `name=value`) end the cookie now: a `Max-Age` of zero or less, or
/// else an `Expires` already past. The last of each counts, and `Max-Age` wins (RFC 6265 §5.3).
fn expired(attributes: &str) -> bool {
    let (mut max_age, mut expires) = (None, None);
    for attribute in attributes.split(';') {
        let (name, value) = attribute.split_once('=').unwrap_or((attribute, ""));
        let value = value.trim();
        match name.trim().to_ascii_lowercase().as_str() {
            "max-age" if value.starts_with(|c: char| c.is_ascii_digit() || c == '-') => max_age = value.parse::<i64>().ok().or(max_age),
            "expires" => expires = cookie_date(value).or(expires),
            _ => {}
        }
    }
    let now = || std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64);
    match max_age {
        Some(seconds) => seconds <= 0,
        None => expires.is_some_and(|at| at <= now()),
    }
}

/// A Set-Cookie date in seconds since 1970, read as RFC 6265 §5.1.1 reads one, so each form servers send counts:
/// `Sun, 06 Nov 1994 08:49:37 GMT`, `Sunday, 06-Nov-94 08:49:37 GMT` and `Sun Nov  6 08:49:37 1994`.
fn cookie_date(date: &str) -> Option<i64> {
    // `least` to `most` digits at the start of `token`, followed by no digit.
    fn number(token: &str, least: usize, most: usize) -> Option<i64> {
        let n = token.bytes().take_while(u8::is_ascii_digit).count();
        if !(least..=most).contains(&n) {
            return None;
        }
        token[..n].parse().ok()
    }
    const MONTHS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    let (mut time, mut day, mut month, mut year) = (None, None, None, None);
    for token in date.split(|c: char| !c.is_ascii_alphanumeric() && c != ':').filter(|t| !t.is_empty()) {
        let hms = || {
            let mut parts = token.splitn(3, ':');
            let (h, m, s) = (parts.next()?, parts.next()?, parts.next()?);
            let whole = |p: &str| number(p, 1, 2).filter(|_| p.len() <= 2);
            Some((whole(h)?, whole(m)?, number(s, 1, 2)?))
        };
        let named_month = || MONTHS.iter().position(|m| token.get(..3).is_some_and(|t| t.eq_ignore_ascii_case(m))).map(|i| i as i64 + 1);
        if time.is_none() && hms().is_some() {
            time = hms();
        } else if day.is_none() && number(token, 1, 2).is_some() {
            day = number(token, 1, 2);
        } else if month.is_none() && named_month().is_some() {
            month = named_month();
        } else if year.is_none() && number(token, 2, 4).is_some() {
            year = number(token, 2, 4);
        }
    }
    let ((hour, minute, second), day, month, year) = (time?, day?, month?, year?);
    let year = match year {
        70..=99 => year + 1900,
        0..=69 => year + 2000,
        _ => year,
    };
    if !(1..=31).contains(&day) || year < 1601 || hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    // Days since 1970 of a proleptic Gregorian date, counted from March so the leap day falls at the end of a year.
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let year_of_era = y - era * 400;
    let day_of_year = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    Some(days * 86_400 + hour * 3600 + minute * 60 + second)
}

/// Runs blocking file work in place, telling a multi-threaded runtime (the app's) to move its other work elsewhere
/// meanwhile. Unlike `spawn_blocking`, nothing is left running if the task is aborted: there is no `.await` inside.
fn blocking<T>(work: impl FnOnce() -> T) -> T {
    match tokio::runtime::Handle::try_current().map(|h| h.runtime_flavor()) {
        Ok(tokio::runtime::RuntimeFlavor::MultiThread) => tokio::task::block_in_place(work),
        _ => work(),
    }
}

/// What an upload sends: a local file the owner picked, read as it goes, or an edit's text, already in memory.
pub enum UploadSource {
    File(std::path::PathBuf),
    Bytes(Vec<u8>),
}

/// The most Hermes takes or sends of one managed file (`_MANAGED_FILE_MAX_BYTES` at `bf0203a`).
pub const MANAGED_FILE_MAX_BYTES: u64 = 100 * MIB;
/// The most `POST api/fs/write-text` takes (`_FS_TEXT_WRITE_MAX_BYTES` at `bf0203a`).
pub const AGENT_TEXT_MAX_BYTES: u64 = 8 * MIB;
const UPLOAD_CHUNK_BYTES: usize = 256 * 1024;

/// A server path Hermes never lists, reads or sends (`_is_sensitive_path` in `hermes_cli/web_routers/files.py` at
/// `bf0203a`): `.env`, `.env.*`, `.envrc`, the credential stores, and anything under `mcp-tokens/` or `pairing/`, in
/// any case. Hermes's write routes don't check these (it calls them "a separate threat class"), so the app refuses to
/// write them, to keep the credential files the browser can't show from being overwritten unseen.
pub fn protected_server_path(path: &str) -> bool {
    const NAMES: [&str; 12] = [
        "auth.json",
        "auth.lock",
        "credentials",
        "config.yaml",
        ".anthropic_oauth.json",
        "google_token.json",
        "google_oauth_pending.json",
        "google_oauth.json",
        "webhook_subscriptions.json",
        "bws_cache.json",
        "bws_cache.enc.json",
        ".git-credentials",
    ];
    // The path as the server resolves it: `/x/.env/.` is `.env`.
    let mut parts: Vec<String> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            part => parts.push(part.to_lowercase()),
        }
    }
    let name = parts.last().map(String::as_str).unwrap_or_default();
    name == ".env"
        || name.starts_with(".env.")
        || name == ".envrc"
        || NAMES.contains(&name)
        || parts.iter().any(|part| matches!(part.as_str(), "mcp-tokens" | "pairing"))
}

/// A download's hidden part file beside its destination, removed when dropped unless `keep` was called: a failed,
/// cancelled (the task aborted) or interrupted download leaves nothing behind. It owns only a file it created itself.
struct PartFile(std::path::PathBuf);

impl PartFile {
    /// Creates a new part file beside `dest`, never opening or taking over one that is already there.
    fn create(dest: &std::path::Path) -> std::io::Result<(PartFile, std::fs::File)> {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let name = dest.file_name().ok_or_else(|| std::io::Error::other("the destination has no file name"))?;
        let dir = dest.parent().ok_or_else(|| std::io::Error::other("the destination has no folder"))?;
        let mut tries = 0;
        loop {
            let part = dir.join(format!(".{}.{}-{}.part", name.to_string_lossy(), std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
            match std::fs::OpenOptions::new().write(true).create_new(true).open(&part) {
                Ok(file) => return Ok((PartFile(part), file)),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists && tries < 100 => tries += 1,
                Err(e) => return Err(e),
            }
        }
    }

    fn keep(mut self) {
        self.0 = std::path::PathBuf::new();
    }
}

impl Drop for PartFile {
    fn drop(&mut self) {
        if !self.0.as_os_str().is_empty() {
            let _ = std::fs::remove_file(&self.0);
        }
    }
}

/// What Settings → Toolsets needs from a profile's config besides the toolset list, read in Rust because the config
/// can hold API keys. Only these facts leave Rust.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolsetGuards {
    /// Platforms whose `platform_toolsets` entry names `no_mcp`, which Hermes's toggle route clears on any change
    /// (`_save_platform_tools` at `bf0203a`), so MCP servers would be offered again.
    pub no_mcp: Vec<String>,
    /// Platforms whose `platform_toolsets` entry is a string this can't read for certain the way Hermes does
    /// (`parse_platform_toolsets_value`, `ast.literal_eval`), so it may name `no_mcp`.
    pub no_mcp_unclear: Vec<String>,
    /// Platforms whose `platform_toolsets` entry is a list Hermes reads as the profile's own saved list
    /// (`_platform_toolsets_explicitly_saved`). Any other platform not in `no_mcp_unclear` inherits Hermes's default
    /// list for it (`_platform_default_toolset`).
    pub saved_lists: Vec<String>,
    /// `agent.coding_context` is `focus` (or its aliases `strict`, `lean`): in a code workspace Hermes swaps in a coding
    /// toolset selection instead of the profile's list (`agent/coding_context.coding_selection`).
    pub coding_focus: bool,
    /// `agent.disabled_toolsets`: names Hermes turns off on every platform, after each platform's own list. Turning a
    /// toolset on removes its own name from this list (`_save_platform_tools` at `bf0203a`), so it comes back on every
    /// platform that lists it, not only here. A composite name here turns off the toolsets inside it, which a switch
    /// can't undo. Toolset names only; the config's values stay in Rust.
    pub disabled_everywhere: Vec<String>,
    /// `agent.disabled_toolsets` is a string this can't read for certain the way Hermes does (`ast.literal_eval`, with
    /// its escapes and literal forms), so any toolset may be on it.
    pub disabled_unclear: bool,
}

/// `ToolsetGuards` from a profile's config as `GET /api/config` answers it.
pub fn toolset_guards(config: &serde_json::Value) -> ToolsetGuards {
    // Hermes reads a platform's entry as a list, or a string list literal; any other value it ignores, `no_mcp` and all.
    let (mut no_mcp, mut no_mcp_unclear, mut saved_lists) = (Vec::new(), Vec::new(), Vec::new());
    for (platform, value) in config["platform_toolsets"].as_object().into_iter().flatten() {
        let read = match value {
            serde_json::Value::Array(_) => config_string_list(value),
            serde_json::Value::String(s) if py_strip(s).starts_with('[') => config_string_list(value),
            // Not a list to Hermes, unless this misjudged the string's start: then it can't be sure.
            serde_json::Value::String(s) if s.contains('[') => {
                no_mcp_unclear.push(platform.clone());
                continue;
            }
            _ => continue,
        };
        if read.unclear {
            no_mcp_unclear.push(platform.clone());
            continue;
        }
        if read.names.iter().any(|n| n == "no_mcp") {
            no_mcp.push(platform.clone());
        }
        saved_lists.push(platform.clone());
    }
    no_mcp.sort();
    no_mcp_unclear.sort();
    saved_lists.sort();
    let mode = match &config["agent"]["coding_context"] {
        serde_json::Value::String(s) => s.trim().to_ascii_lowercase(),
        _ => String::new(),
    };
    let disabled = config_string_list(&config["agent"]["disabled_toolsets"]);
    ToolsetGuards {
        no_mcp,
        no_mcp_unclear,
        saved_lists,
        coding_focus: matches!(mode.as_str(), "focus" | "strict" | "lean"),
        disabled_everywhere: disabled.names,
        disabled_unclear: disabled.unclear,
    }
}

/// `s` without the leading and trailing whitespace Python's `str.strip()` removes: Unicode whitespace, plus the
/// separators U+001C–U+001F, which Rust's `trim` keeps.
fn py_strip(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&c))
}

/// A config list's names, and whether they may be incomplete.
struct ConfigList {
    names: Vec<String>,
    unclear: bool,
}

/// A config list as Hermes's `parse_config_string_list` reads it: a list, a list literal saved as a string
/// (`"['memory', 'web']"`, as `hermes config set` stores it), or one name. Trimmed, empty names dropped. A literal is
/// read only when each item is a plainly quoted name; anything else (escapes, other literal forms) is `unclear`,
/// since Python may read it as names this can't see.
fn config_string_list(value: &serde_json::Value) -> ConfigList {
    let clean = |names: Vec<String>| names.into_iter().map(|n| py_strip(&n).to_owned()).filter(|n| !n.is_empty()).collect();
    match value {
        serde_json::Value::Array(items) => ConfigList {
            names: clean(
                items
                    .iter()
                    .map(|i| match i {
                        serde_json::Value::String(s) => s.clone(),
                        other => other.to_string(),
                    })
                    .collect(),
            ),
            unclear: false,
        },
        serde_json::Value::String(s) if py_strip(s).starts_with('[') => {
            let inner = py_strip(s).strip_prefix('[').and_then(|r| r.strip_suffix(']'));
            let quoted = |item: &str| {
                let item = py_strip(item);
                ['\'', '"'].into_iter().find_map(|q| {
                    let name = item.strip_prefix(q)?.strip_suffix(q)?;
                    let plain = !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || "_.- ".contains(c));
                    plain.then(|| name.to_owned())
                })
            };
            let items: Option<Vec<String>> = inner
                .map(|inner| {
                    let mut parts: Vec<&str> = inner.split(',').collect();
                    // `['a',]` is a list of one; `[]` of none.
                    if parts.last().is_some_and(|p| py_strip(p).is_empty()) {
                        parts.pop();
                    }
                    parts
                })
                .and_then(|parts| parts.into_iter().map(quoted).collect());
            match items {
                Some(names) => ConfigList { names: clean(names), unclear: false },
                None => ConfigList { names: Vec::new(), unclear: true },
            }
        }
        // One name to Hermes; one this misjudged as not starting a list can't be read for certain.
        serde_json::Value::String(s) if s.contains('[') => ConfigList { names: Vec::new(), unclear: true },
        serde_json::Value::String(s) => ConfigList { names: clean(vec![s.clone()]), unclear: false },
        _ => ConfigList { names: Vec::new(), unclear: false },
    }
}

/// The scheduled-job writes the Scheduled jobs view makes (`hermes_cli/web_routers/cron.py`): `POST api/cron/jobs`
/// creates a job, `PUT api/cron/jobs/{id}` edits one, and `POST api/cron/jobs/{id}/{pause,resume,trigger}`. The job id
/// must be one plain path segment, as Hermes's 12-hex-digit ids are.
fn cron_write(method: &str, path: &str) -> bool {
    let Some(rest) = path.strip_prefix("api/cron/jobs") else { return false };
    let id_ok = |id: &str| (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    match (method, rest.strip_prefix('/').map(|r| r.split('/').collect::<Vec<_>>()).as_deref()) {
        ("POST", None) => rest.is_empty(),
        ("PUT", Some([id])) => id_ok(id),
        ("POST", Some([id, "pause" | "resume" | "trigger"])) => id_ok(id),
        _ => false,
    }
}

/// Whether a `POST api/sessions/import` is Import transcripts' (ADR 0031): a JSON object whose `sessions` is a non-empty
/// list of sessions each marked `source: "import"`, so nothing this relays can pass as a chat from another platform.
pub fn import_body_allowed(body: Option<&str>) -> bool {
    let Some(body) = body.and_then(|b| serde_json::from_str::<serde_json::Value>(b).ok()) else {
        return false;
    };
    match body.get("sessions").and_then(|s| s.as_array()) {
        Some(sessions) if !sessions.is_empty() => sessions.iter().all(|s| s.get("source").and_then(|v| v.as_str()) == Some("import")),
        _ => false,
    }
}

/// Where a relayed REST call goes, and its path as the dashboard will route it: with `.` segments resolved and
/// percent-escapes decoded (the server decodes them before routing, so `%2F` is a `/` to it). Both the path asked
/// for and the routed one must stay under `api/` without `.` or `..` segments.
fn relay_url(base: &Url, path: &str, query: &str) -> Result<(Url, String), TransportError> {
    let refused = || TransportError::NotRelayed(path.to_owned());
    // The allow-lists judge the path as given, so the URL parser mustn't change it: it resolves `.` and `..` spelled
    // as `%2e` too, and reads `\` as `/`.
    let dot = |seg: &str| matches!(percent_encoding::percent_decode_str(seg).decode_utf8_lossy().as_ref(), "." | "..");
    let under_api = |p: &str| p.starts_with("api/") && !p.split(['/', '\\']).any(dot);
    if !under_api(path) {
        return Err(refused());
    }
    let mut url = endpoint(base, path);
    url.set_query(Some(query).filter(|q| !q.is_empty()));
    // The dashboard's own path, such as `/team%20one/`, is matched as it's spelled; only what follows is decoded.
    let prefix = format!("{}/", base.path().trim_end_matches('/'));
    let rest = url.path().strip_prefix(&prefix).ok_or_else(refused)?;
    let routed = percent_encoding::percent_decode_str(rest).decode_utf8().map_err(|_| refused())?.into_owned();
    if !under_api(&routed) {
        return Err(refused());
    }
    Ok((url, routed))
}

/// `GET api/config`'s answer without the values Hermes treats as credentials (`_is_secret_config_key` in
/// `hermes_cli/config.py`): Hermes sends the config as written, provider keys and all (ADR 0138).
fn config_without_credentials(text: &str) -> Result<String, TransportError> {
    fn drop_credentials(value: &mut serde_json::Value) {
        match value {
            serde_json::Value::Object(map) => {
                map.retain(|key, v| v.is_object() || v.is_array() || !credential_key(key));
                map.values_mut().for_each(drop_credentials);
            }
            serde_json::Value::Array(items) => items.iter_mut().for_each(drop_credentials),
            _ => {}
        }
    }
    let mut config: serde_json::Value =
        serde_json::from_str(text).map_err(|_| TransportError::Unexpected { status: 200, body: "the profile's config isn't JSON".into() })?;
    drop_credentials(&mut config);
    Ok(config.to_string())
}

/// A config key whose value Hermes treats as a credential: one of its names, or ending in one of its suffixes, with
/// `-` read as `_` (`X-API-Key`).
fn credential_key(key: &str) -> bool {
    const NAMES: [&str; 15] = [
        "api_key",
        "apikey",
        "key",
        "token",
        "access_token",
        "refresh_token",
        "id_token",
        "secret",
        "client_secret",
        "password",
        "passwd",
        "authorization",
        "private_key",
        "bearer",
        "jwt",
    ];
    const SUFFIXES: [&str; 6] = ["_api_key", "_token", "_secret", "_password", "_key", "_access_key"];
    let key = key.to_lowercase().replace('-', "_");
    NAMES.contains(&key.as_str()) || SUFFIXES.iter().any(|suffix| key.ends_with(suffix))
}

/// The dashboard's routes that write or delete files on the server: managed files (`api/files...`) and the agent's
/// workspace (`api/fs/...`). Empty segments are skipped, as a lenient router might.
fn is_file_route(path: &str) -> bool {
    let mut segs = path.split('/').filter(|seg| !seg.is_empty());
    segs.next() == Some("api") && matches!(segs.next(), Some("files" | "fs"))
}

/// Settings → Providers' writes through the relay that carry nothing secret (ADR 0133), each without a body:
/// - `POST api/providers/oauth/<provider>/start` starts a device-code sign-in. Hermes refuses an `external` provider.
/// - `POST api/providers/custom-endpoints/<id>/activate` makes an endpoint the profile's default model provider, as
///   `POST api/model/set` can.
///
/// Saving an endpoint carries its key, so it goes through `Dashboard::save_endpoint`, and its check route isn't relayed.
pub fn provider_account_write(path: &str, body: Option<&str>) -> bool {
    let empty = body.is_none_or(|b| matches!(b.trim(), "" | "{}"));
    let Some(rest) = path.strip_prefix("api/providers/") else {
        return false;
    };
    empty
        && match rest.split('/').collect::<Vec<_>>().as_slice() {
            ["oauth", id, "start"] => accounts::provider_slug(id),
            ["custom-endpoints", id, "activate"] => accounts::endpoint_segment(id),
            _ => false,
        }
}

/// The dashboard's routes on the profile's `.env`: `api/env` and anything under it. Empty segments are skipped, as
/// `is_file_route` does.
fn is_env_route(path: &str) -> bool {
    let mut segs = path.split('/').filter(|seg| !seg.is_empty());
    segs.next() == Some("api") && segs.next() == Some("env")
}

/// The toolset name Settings → Toolsets sends, with an `enabled` that is neither true nor false, to learn whether the
/// server has the toggle route without changing anything: FastAPI refuses the body before the route runs.
pub const TOOLSET_PROBE_NAME: &str = "__hermes_chat_probe__";

/// Whether a `PUT` is Settings → Toolsets' switch: `api/tools/toolsets/<name>`, one path segment of ASCII letters,
/// digits, `_`, `-` and `.` (Hermes's own toolset keys), and a body that is exactly `{"enabled": true}` or
/// `{"enabled": false}`. Nothing else under that prefix is relayed: not its `env`, `provider`, `model` or
/// `post-setup` routes, which write secrets or run installs. The probe name takes only `{"enabled": "probe"}`.
pub fn toolset_toggle_allowed(path: &str, body: Option<&str>) -> bool {
    let Some(name) = path.strip_prefix("api/tools/toolsets/") else {
        return false;
    };
    let safe = !name.is_empty() && name != "." && name != ".." && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'));
    if !safe {
        return false;
    }
    let Some(body) = body.and_then(|b| serde_json::from_str::<serde_json::Value>(b).ok()) else {
        return false;
    };
    let Some(fields) = body.as_object().filter(|o| o.len() == 1) else {
        return false;
    };
    match (name == TOOLSET_PROBE_NAME, fields.get("enabled")) {
        (false, Some(serde_json::Value::Bool(_))) => true,
        (true, Some(serde_json::Value::String(s))) => s == "probe",
        _ => false,
    }
}

/// Settings → Voice's writes under Hermes's toolset routes (ADR 0115, `hermes_cli/web_routers/tools.py`), for the `stt`
/// and `tts` toolsets only:
/// - `PUT api/tools/toolsets/{stt,tts}/provider` with exactly `{"provider": <name>}` picks a provider by the name Hermes
///   lists it under (`apply_provider_selection`, which writes `<kind>.provider` and nothing else of the config).
/// - `PUT api/tools/toolsets/{stt,tts}/env` with exactly `{"env": {NAME: key}}`, never empty, saves API keys to the
///   profile's `.env`. Hermes takes only the env vars that toolset's providers list. A blank key, which Hermes skips, or
///   one with a control character, which would break the `.env` line, isn't relayed.
///
/// Their `model` and `post-setup` routes, and every other toolset's `provider` and `env`, aren't reached.
pub fn voice_provider_write(path: &str, body: Option<&str>) -> bool {
    let Some(route) = path.strip_prefix("api/tools/toolsets/") else {
        return false;
    };
    let field = match route {
        "stt/provider" | "tts/provider" => "provider",
        "stt/env" | "tts/env" => "env",
        _ => return false,
    };
    let Some(fields) = body.and_then(|b| serde_json::from_str::<serde_json::Value>(b).ok()) else {
        return false;
    };
    let Some(value) = fields.as_object().filter(|o| o.len() == 1).and_then(|o| o.get(field)) else {
        return false;
    };
    let text_ok = |s: &str, max: usize| !s.trim().is_empty() && s.chars().count() <= max && !s.chars().any(char::is_control);
    let env_name = |n: &str| {
        let mut b = n.bytes();
        n.len() <= 128 && matches!(b.next(), Some(c) if c.is_ascii_uppercase()) && b.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_')
    };
    match field {
        "provider" => value.as_str().is_some_and(|p| text_ok(p, 200)),
        _ => value.as_object().is_some_and(|env| !env.is_empty() && env.iter().all(|(k, v)| env_name(k) && v.as_str().is_some_and(|v| text_ok(v, 4096)))),
    }
}

/// Settings → Gateways' writes (ADR 0073, Hermes's `hermes_cli/web_routers/messaging.py`), for Telegram and Discord
/// only: `PUT api/messaging/platforms/{id}` with a JSON object of at most `enabled` (a bool), `env` (one-line values
/// under that platform's own env var names) and `clear_env` (those names), and nothing else, a profile included; and
/// `POST api/messaging/platforms/{id}/test` with no body, which only reports the state. A token goes from the webview
/// to Hermes in the `env` value and is never kept or logged here.
pub fn gateway_write(method: &str, path: &str, body: Option<&str>) -> bool {
    let Some(rest) = path.strip_prefix("api/messaging/platforms/") else { return false };
    let (id, test) = match rest.split_once('/') {
        Some((id, "test")) => (id, true),
        Some(_) => return false,
        None => (rest, false),
    };
    let prefix = match id {
        "telegram" => "TELEGRAM_",
        "discord" => "DISCORD_",
        _ => return false,
    };
    if test {
        return method == "POST" && body.is_none();
    }
    if method != "PUT" {
        return false;
    }
    let Some(fields) = body.and_then(|b| serde_json::from_str::<serde_json::Value>(b).ok()) else { return false };
    let Some(fields) = fields.as_object().filter(|o| !o.is_empty()) else { return false };
    let env_name = |n: &str| {
        n.len() <= 128 && n.strip_prefix(prefix).is_some_and(|t| !t.is_empty() && t.bytes().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_'))
    };
    let value_ok = |s: &str| !s.trim().is_empty() && s.chars().count() <= 4096 && !s.chars().any(char::is_control);
    fields.iter().all(|(k, v)| match k.as_str() {
        "enabled" => v.is_boolean(),
        "env" => v.as_object().is_some_and(|env| !env.is_empty() && env.iter().all(|(k, v)| env_name(k) && v.as_str().is_some_and(value_ok))),
        "clear_env" => v.as_array().is_some_and(|keys| !keys.is_empty() && keys.iter().all(|k| k.as_str().is_some_and(env_name))),
        _ => false,
    })
}

/// The Automations writes (ADR 0108, Hermes's `/api/webhooks` routes and the `webhooks/1` contract): `POST
/// api/webhooks` creates a route, `PUT api/webhooks/{name}` edits one, `PUT api/webhooks/{name}/enabled` pauses or
/// resumes one, and `POST api/webhooks/{name}/deliveries/{id}/retry` retries a failed delivery. The route name is one
/// segment as Hermes names routes, the delivery id one unreserved segment. Each body is a JSON object with only the
/// keys the app sends: never a `secret` (Hermes makes secrets, or reads them from its own environment), never
/// `deliver_only`, and nothing reaches `POST api/webhooks/enable`, which rewrites the config and restarts the gateway.
fn webhook_write(method: &str, path: &str, body: Option<&str>) -> bool {
    let Some(rest) = path.strip_prefix("api/webhooks") else { return false };
    let name_ok = |n: &str| {
        // Hermes's route-name rule (`^[a-z0-9][a-z0-9_-]*$`, no length limit); 200 covers any route it lists.
        (1..=200).contains(&n.len())
            && (n.as_bytes()[0].is_ascii_lowercase() || n.as_bytes()[0].is_ascii_digit())
            && n.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
    };
    let id_ok = |i: &str| {
        (1..=200).contains(&i.len()) && i != "." && i != ".." && i.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~'))
    };
    let keys: &[&str] = match (method, rest.strip_prefix('/').map(|r| r.split('/').collect::<Vec<_>>()).as_deref()) {
        ("POST", None) if rest.is_empty() => &[
            "name",
            "description",
            "events",
            "prompt",
            "skills",
            "deliver",
            "deliver_chat_id",
            "script",
            "provider",
            "filters",
            "coalesce",
            "secret_env",
            "enabled",
            "create_only",
        ],
        ("PUT", Some([name])) if name_ok(name) => &[
            "revision",
            "description",
            "events",
            "prompt",
            "skills",
            "deliver",
            "deliver_chat_id",
            "provider",
            "filters",
            "coalesce",
            "secret_env",
            "rotate_secret",
        ],
        ("PUT", Some([name, "enabled"])) if name_ok(name) => &["enabled"],
        ("POST", Some([name, "deliveries", id, "retry"])) if name_ok(name) && id_ok(id) => &["idempotency_key", "confirm_side_effects"],
        _ => return false,
    };
    let Some(fields) = body.and_then(|b| serde_json::from_str::<serde_json::Value>(b).ok()).and_then(|v| v.as_object().cloned()) else {
        return false;
    };
    let only_known = fields.keys().all(|k| keys.contains(&k.as_str()));
    let enabled_ok = keys != ["enabled"] || matches!(fields.get("enabled"), Some(serde_json::Value::Bool(_)));
    only_known && enabled_ok
}

/// Whether a `PUT` is one of Settings → Skills' two writes (`hermes_cli/web_routers/skills.py`): `api/skills/toggle`
/// with exactly `{"name": <skill>, "enabled": true|false}`, or `api/skills/content` with exactly
/// `{"name": <skill>, "content": <text>}`. The profile goes in the query, never the body. A skill name is one line of at
/// most 256 characters with no backslash, no leading `/` and no empty, `.` or `..` segment, so it can't steer Hermes's
/// lookup out of the skills folders. Nothing else under `api/skills` is relayed: not creating a skill, nor the hub's
/// install, uninstall or update, which fetch and run code from elsewhere.
pub fn skill_write_allowed(path: &str, body: Option<&str>) -> bool {
    let second = match path {
        "api/skills/toggle" => "enabled",
        "api/skills/content" => "content",
        _ => return false,
    };
    let Some(fields) = body.and_then(|b| serde_json::from_str::<serde_json::Value>(b).ok()) else {
        return false;
    };
    let Some(fields) = fields.as_object().filter(|o| o.len() == 2) else {
        return false;
    };
    let name_ok = fields.get("name").and_then(|n| n.as_str()).is_some_and(|n| {
        !n.is_empty()
            && n.chars().count() <= 256
            && !n.chars().any(|c| c.is_control() || c == '\\')
            && !n.starts_with('/')
            && !n.split('/').any(|seg| seg.is_empty() || seg == "." || seg == "..")
    });
    let value_ok = matches!((second, fields.get(second)), ("enabled", Some(serde_json::Value::Bool(_))) | ("content", Some(serde_json::Value::String(_))));
    name_ok && value_ok
}

/// Hermes's rule for a new skill's name and its category (`tools/skill_manager_tool.py` `VALID_NAME_RE`, at most 64):
/// a lowercase letter or digit, then lowercase letters, digits, `.`, `_` or `-`. One folder name, so it can't leave the
/// profile's skills folder.
fn skill_dir_name(n: &str) -> bool {
    let mut b = n.bytes();
    n.len() <= 64
        && matches!(b.next(), Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit())
        && b.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'.' || c == b'_' || c == b'-')
}

/// Whether a `POST api/skills` body is Settings → Skills' copy of a skill into another profile (ADR 0118): exactly
/// `{"name", "content"}` and optionally `"category"`, the name and category each one folder name as Hermes allows
/// it (`skill_dir_name`), the content a string. The profile goes in the query, never the body. Hermes's own front matter,
/// size and security checks then apply, and it refuses a name the profile already has.
pub fn skill_create_allowed(body: Option<&str>) -> bool {
    let Some(fields) = body.and_then(|b| serde_json::from_str::<serde_json::Value>(b).ok()) else {
        return false;
    };
    let Some(fields) = fields.as_object() else {
        return false;
    };
    let known = fields.keys().all(|k| matches!(k.as_str(), "name" | "content" | "category"));
    let name_ok = fields.get("name").and_then(|n| n.as_str()).is_some_and(skill_dir_name);
    let content_ok = fields.get("content").is_some_and(|c| c.is_string());
    let category_ok = fields.get("category").is_none_or(|c| c.as_str().is_some_and(skill_dir_name));
    known && name_ok && content_ok && category_ok
}

/// Whether a `PUT api/learning/node` body replaces one built-in memory entry (ADR 0118): exactly `{"id", "content"}`,
/// the id a memory node as Hermes names it, `memory:<memory|profile>:<index>:<fingerprint>` (`agent/learning_graph.py`
/// `memory_node_id`, the fingerprint 12 hex digits of SHA-256). Hermes resolves the fingerprint under the memory tool's
/// lock and refuses a stale one. A skill's id is its name, and skills are edited only through `api/skills/content`,
/// with its checks, so no other id is relayed.
pub fn memory_entry_edit_allowed(body: Option<&str>) -> bool {
    let Some(fields) = body.and_then(|b| serde_json::from_str::<serde_json::Value>(b).ok()) else {
        return false;
    };
    let Some(fields) = fields.as_object().filter(|o| o.len() == 2) else {
        return false;
    };
    let id_ok = fields.get("id").and_then(|i| i.as_str()).is_some_and(|id| {
        let parts: Vec<&str> = id.split(':').collect();
        matches!(parts.as_slice(), ["memory", "memory" | "profile", index, print]
            if !index.is_empty() && index.len() <= 9 && index.bytes().all(|c| c.is_ascii_digit())
                && print.len() == 12 && print.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)))
    });
    id_ok && fields.get("content").is_some_and(|c| c.is_string())
}

/// Settings → Memory's external memory writes (ADR 0045, Hermes's `/api/memory` routes): `PUT api/memory/provider`
/// `{"provider": name}` picks a profile's provider ("" for built-in memory only), `PUT
/// api/memory/providers/{name}/config` `{"values": {key: text}}`, never empty, saves its settings, and `POST
/// api/memory/providers/{name}/setup` with exactly `{"values": {}}` installs what its manifest declares. Names are one
/// segment as Hermes allows them (`_MEMORY_PROVIDER_NAME_RE`). Setup never carries settings, so an install is only ever
/// what the owner confirmed, and `api/memory/reset`, which deletes the built-in memory files, isn't reached.
fn memory_provider_write(method: &str, path: &str, body: Option<&str>) -> bool {
    let name_ok = |n: &str| {
        let mut b = n.bytes();
        n.len() <= 64 && matches!(b.next(), Some(c) if c.is_ascii_alphanumeric()) && b.all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    };
    let Some(fields) = body.and_then(|b| serde_json::from_str::<serde_json::Value>(b).ok()) else {
        return false;
    };
    let Some(fields) = fields.as_object().filter(|o| o.len() == 1) else {
        return false;
    };
    if method == "PUT" && path == "api/memory/provider" {
        return fields.get("provider").and_then(|p| p.as_str()).is_some_and(|p| p.is_empty() || name_ok(p));
    }
    let Some((name, action)) = path.strip_prefix("api/memory/providers/").and_then(|p| p.split_once('/')) else {
        return false;
    };
    let Some(values) = fields.get("values").and_then(|v| v.as_object()) else {
        return false;
    };
    name_ok(name)
        && match (method, action) {
            // Never empty: Hermes's declared route would still switch the provider, without the readiness check.
            ("PUT", "config") => !values.is_empty() && values.iter().all(|(k, v)| !k.is_empty() && k.len() <= 128 && v.is_string()),
            ("POST", "setup") => values.is_empty(),
            _ => false,
        }
}

fn endpoint(base: &Url, path: &str) -> Url {
    let mut url = base.clone();
    let prefix = url.path().trim_end_matches('/').to_owned();
    url.set_path(&format!("{prefix}/{path}"));
    url
}

/// `api/profiles/{name}/soul` for a Hermes profile id, the one write route Settings → Persona uses.
fn is_profile_soul(path: &str) -> bool {
    path.strip_prefix("api/profiles/").and_then(|p| p.strip_suffix("/soul")).is_some_and(profile_id)
}

/// A Hermes profile id (`hermes_constants.PROFILE_ID_RE`): a lowercase letter or digit, then up to 63 more of those, `_`
/// or `-`.
fn profile_id(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit())
        && name.len() <= 64
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

/// Whether a `POST api/profiles` body is the Clone profile dialog's (ADR 0074): `{"name"}` with only `"soul"`,
/// `"description"`, `"provider"` and `"model"` beside it, or `{"name", "clone_from"}` with only `"description"` beside
/// them, the full copy the owner opted in to; each a string. The name is a profile id other than `default`, and the
/// source a profile id or `default`. Every other field Hermes takes is refused: `clone_all` copies the source's whole
/// home, `clone_channels` its bot tokens, `clone_from_default` the default profile's keys, `mcp_servers` writes secrets
/// and `hub_skills` starts installs.
pub fn profile_create_allowed(body: Option<&str>) -> bool {
    let Some(fields) = body.and_then(|b| serde_json::from_str::<serde_json::Value>(b).ok()) else {
        return false;
    };
    let Some(fields) = fields.as_object() else {
        return false;
    };
    let name_ok = fields.get("name").and_then(|n| n.as_str()).is_some_and(|n| n != "default" && profile_id(n));
    let source_ok = fields.get("clone_from").is_none_or(|s| s.as_str().is_some_and(|s| s == "default" || profile_id(s)));
    let full = fields.contains_key("clone_from");
    let known = fields.iter().all(|(k, v)| {
        v.is_string()
            && match k.as_str() {
                "name" | "clone_from" | "description" => true,
                "soul" | "provider" | "model" => !full,
                _ => false,
            }
    });
    name_ok && source_ok && known
}

/// Said in place of an error body that can't be shown.
const HIDDEN: &str = "(not shown, as it may repeat your password or a request header)";

/// How much of a header value `repeats_header` counts as repeating it.
const HEADER_PIECE: usize = 8;

/// Whether `text` repeats one of the values in `headers`: the owner's extra request headers, as a gateway such as
/// Cloudflare Access can in the page it turns a request away with, or a token sent with them. Any
/// `HEADER_PIECE` bytes of a value count, so a value cut short, as in a WebSocket close reason, still does.
fn repeats_header(text: &str, headers: &HeaderMap) -> bool {
    repeats_any(text.as_bytes(), headers.values().map(HeaderValue::as_bytes))
}

/// Whether a request that carried `headers` (what its error mustn't repeat) carried more than session cookies
/// (`Dashboard::hidden`): extra request headers, or a token. The owner can't add a `cookie` header (`reserved`).
fn carried_extra(headers: &HeaderMap) -> bool {
    headers.keys().any(|name| name != header::COOKIE)
}

/// `repeats_header` for an address, whose host the URL parser lowercased.
fn address_repeats_header(address: &str, headers: &HeaderMap) -> bool {
    let values: Vec<Vec<u8>> = headers.values().map(|v| v.as_bytes().to_ascii_lowercase()).collect();
    repeats_any(address.to_ascii_lowercase().as_bytes(), values.iter().map(Vec::as_slice))
}

/// Compared as bytes: a password need not be ASCII, and a piece of it need not end on a character.
fn repeats_any<'a>(text: &[u8], values: impl Iterator<Item = &'a [u8]>) -> bool {
    values.filter(|v| !v.is_empty()).any(|v| {
        let piece = v.len().min(HEADER_PIECE);
        v.windows(piece).any(|p| text.windows(piece).any(|t| t == p))
    })
}

/// Every string in `v`, keys included, one per line, so `repeats_header` sees them unescaped.
fn strings_in(v: &serde_json::Value, out: &mut String) {
    match v {
        serde_json::Value::String(s) => {
            out.push_str(s);
            out.push('\n');
        }
        serde_json::Value::Array(a) => a.iter().for_each(|x| strings_in(x, out)),
        serde_json::Value::Object(o) => o.iter().for_each(|(k, x)| {
            out.push_str(k);
            out.push('\n');
            strings_in(x, out);
        }),
        _ => {}
    }
}

/// An error body as it may be shown, for a request that carried `headers`: its extra request headers, a token it
/// sent, and its session cookies. With only cookies, its start as sent, unless it repeats one of them. Otherwise only
/// the dashboard's own JSON `detail`, whole and repeating none of their values: a refusal (401, 403, 407) or any other
/// page could come from a gateway in front, which can echo a value it turned down.
fn shown_body(status: StatusCode, text: &str, headers: &HeaderMap) -> String {
    if !carried_extra(headers) {
        return if repeats_header(text, headers) { HIDDEN.into() } else { text.chars().take(300).collect() };
    }
    if matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN | StatusCode::PROXY_AUTHENTICATION_REQUIRED) {
        return HIDDEN.into();
    }
    let detail = serde_json::from_str::<serde_json::Value>(text).ok().and_then(|v| v.get("detail").cloned());
    let Some(detail) = detail else { return HIDDEN.into() };
    let mut said = String::new();
    strings_in(&detail, &mut said);
    if repeats_header(text, headers) || repeats_header(&said, headers) {
        return HIDDEN.into();
    }
    json!({ "detail": detail }).to_string().chars().take(300).collect()
}

/// A failed answer as an error, with the start of its body. Reads only the first few KB, so a huge or endless error
/// body can't fill memory. `headers`: what the request carried that mustn't be shown (`shown_body`).
async fn unexpected(resp: reqwest::Response, headers: &HeaderMap) -> TransportError {
    unexpected_sent(resp, headers, "", Some(ANSWER_IDLE_LIMIT)).await
}

/// `unexpected` for a request whose body carried `secret`, such as a password: an error that repeats it anywhere, as
/// sent or JSON-escaped, is shown as `HIDDEN`. Unlike extra request headers, it doesn't limit what else is shown.
/// `limit`: the body is given up as `Stalled` once that passes without a part of it.
async fn unexpected_sent(mut resp: reqwest::Response, headers: &HeaderMap, secret: &str, limit: Option<Duration>) -> TransportError {
    const KEEP: usize = 4096;
    let forms = sent_forms(secret);
    let forms = || forms.iter().map(|f| f.as_bytes());
    // A redirect that came back unfollowed: `same_origin_redirects` stopped it at another site.
    if resp.status().is_redirection() {
        let to = resp.headers().get(header::LOCATION).and_then(|l| resp.url().join(l.to_str().ok()?).ok());
        if let Some(to) = to.filter(|to| to.origin() != resp.url().origin()) {
            // A gateway can put a header value it turned down into the address, even the host name.
            let to = to.origin().ascii_serialization();
            let lower: Vec<Vec<u8>> = forms().map(<[u8]>::to_ascii_lowercase).collect();
            let hidden = address_repeats_header(&to, headers) || repeats_any(to.as_bytes(), lower.iter().map(Vec::as_slice));
            return if hidden { TransportError::RedirectedHidden } else { TransportError::Redirected(to) };
        }
    }
    let status = resp.status().as_u16();
    let mut head = Vec::new();
    while head.len() < KEEP {
        let part = match limit {
            Some(limit) => match tokio::time::timeout(limit, resp.chunk()).await {
                Ok(part) => part,
                Err(_) => return TransportError::Stalled(limit.as_secs()),
            },
            None => resp.chunk().await,
        };
        match part {
            Ok(Some(chunk)) => head.extend_from_slice(&chunk),
            _ => break,
        }
    }
    head.truncate(KEEP);
    let text = String::from_utf8_lossy(&head);
    let mut said = text.to_string();
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
        strings_in(&v, &mut said);
    }
    let body = if repeats_any(said.as_bytes(), forms()) { HIDDEN.into() } else { shown_body(resp.status(), &text, headers) };
    TransportError::Unexpected { status, body }
}

/// `secret` as an error body might repeat it: as sent, JSON-escaped, and JSON-escaped to ASCII as Python's `json` does.
fn sent_forms(secret: &str) -> Vec<String> {
    if secret.is_empty() {
        return vec![];
    }
    let quoted = serde_json::to_string(secret).expect("a string serializes");
    let escaped = &quoted[1..quoted.len() - 1];
    let ascii = escaped.chars().fold(String::new(), |mut out, c| {
        if c.is_ascii() {
            out.push(c);
        } else {
            c.encode_utf16(&mut [0; 2]).iter().for_each(|u| out.push_str(&format!("\\u{u:04x}")));
        }
        out
    });
    vec![secret.to_owned(), escaped.to_owned(), ascii]
}

/// How far a connection test got before it failed, so setup can say what to fix.
/// `Address`: the URL or SSH target, or the SSH tunnel. `Reach`: the dashboard's HTTP port. `SignIn`: the
/// username and password. `Chat`: the `/api/ws` chat connection. `Cancelled`: the owner stopped the test.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Stage {
    Address,
    Reach,
    SignIn,
    Chat,
    Cancelled,
}

/// A failed connection test. `status`: the dashboard's `GET /api/status` body, when it answered one, so setup can
/// tell a Hermes dashboard from something else on the port, and which sign-in methods it offers.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ProbeFailure {
    pub stage: Stage,
    pub message: String,
    pub status: Option<String>,
}

impl ProbeFailure {
    pub fn new(stage: Stage, message: impl Into<String>) -> Self {
        ProbeFailure { stage, message: message.into(), status: None }
    }
}

/// A connection test that went through: the dashboard's `GET /api/status` body and the first frame `/api/ws` sent,
/// which the webview checks is a legacy `gateway.ready`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Probed {
    pub status: String,
    pub ready: String,
    /// The server's id (`server_id`), when its status named its install.
    pub server: Option<String>,
}

/// How long each step of a connection test may take. The app's own sign-in over a single route has no limit but the
/// whole attempt's (one of several has `StepLimits`), but a test the owner is watching should say where it stuck.
pub const PROBE_STEP_TIMEOUT: Duration = Duration::from_secs(15);

/// Tests a sign-in at `base` the way `Dashboard::sign_in` and `open_pipe` do it, without keeping anything: reads
/// `/api/status` (no sign-in needed), signs in, opens `/api/ws` for `profile` and waits for its first frame, then
/// closes it. The app's own connection, if there is one, is untouched.
pub async fn probe(base: &Url, sign_in: &SignIn, profile: &str) -> Result<Probed, ProbeFailure> {
    probe_with(base, sign_in, profile, PROBE_STEP_TIMEOUT).await
}

pub async fn probe_with(base: &Url, sign_in: &SignIn, profile: &str, step: Duration) -> Result<Probed, ProbeFailure> {
    probe_expecting(base, sign_in, profile, step, step, None).await
}

/// `probe_with`, which also refuses, before the password goes out, a server that isn't the one `expect` names
/// (`identify`, ADR 0120). `reach`: how long the status read may take, shorter for one of several routes.
pub async fn probe_expecting(
    base: &Url,
    sign_in: &SignIn,
    profile: &str,
    step: Duration,
    reach: Duration,
    expect: Option<&str>,
) -> Result<Probed, ProbeFailure> {
    let timed_out = |what: &str| format!("{what} didn't answer within {}s.", step.as_secs());
    // The same headers and redirect rule as the sign-in, so a gateway in front of the dashboard lets this through too.
    let http = client(&sign_in.headers).map_err(|e| ProbeFailure::new(Stage::Address, e.to_string()))?;
    // A refusal's page isn't shown if the request carried extra headers (`shown_body`).
    let status = match tokio::time::timeout(reach, read_status(&http, base, &sign_in.headers)).await {
        Err(_) => return Err(ProbeFailure::new(Stage::Reach, format!("The dashboard didn't answer within {}s.", reach.as_secs()))),
        Ok(Err(e)) => return Err(ProbeFailure::new(Stage::Reach, e.to_string())),
        Ok(Ok(status)) => status,
    };
    let server = identify(&status, expect).map_err(|e| ProbeFailure { stage: Stage::Reach, message: e.to_string(), status: Some(status.clone()) })?;
    let fail = |stage, message: String| ProbeFailure { stage, message, status: Some(status.clone()) };
    offered(sign_in, Some(&status)).map_err(|e| fail(Stage::SignIn, e.to_string()))?;
    let dashboard = match tokio::time::timeout(step, Dashboard::sign_in(http, base, sign_in)).await {
        Err(_) => return Err(fail(Stage::SignIn, timed_out("The dashboard's sign-in"))),
        Ok(Err(e)) => return Err(fail(Stage::SignIn, e.to_string())),
        Ok(Ok(d)) => d,
    };
    let (tx, rx) = tokio::sync::oneshot::channel::<PipeEvent>();
    let tx = Mutex::new(Some(tx));
    let pipe = match tokio::time::timeout(
        step,
        dashboard.open_pipe(profile, move |e| {
            if let Some(tx) = tx.locked().take() {
                let _ = tx.send(e);
            }
        }),
    )
    .await
    {
        Err(_) => return Err(fail(Stage::Chat, timed_out("The chat connection"))),
        Ok(Err(e)) => return Err(fail(Stage::Chat, e.to_string())),
        Ok(Ok(p)) => p,
    };
    let first = tokio::time::timeout(step, rx).await;
    drop(pipe);
    match first {
        Ok(Ok(PipeEvent::Frame { text })) => Ok(Probed { status, ready: text, server }),
        Ok(Ok(PipeEvent::Closed { reason })) => Err(fail(Stage::Chat, format!("The chat connection closed before Hermes was ready: {reason}"))),
        Ok(Err(_)) => Err(fail(Stage::Chat, "The chat connection closed before Hermes was ready.".into())),
        Err(_) => Err(fail(Stage::Chat, timed_out("Hermes"))),
    }
}

/// A request error with its causes, which say what actually went wrong ("Connection refused", "dns error", a
/// certificate problem); reqwest's own message only names the URL.
/// A request that got no answer, as an error. The URL is left out: a redirect can put a header value, or a provider
/// key the dashboard was sent, into the URL it gives up on.
fn unreachable(e: reqwest::Error) -> TransportError {
    TransportError::Unreachable(describe(&e.without_url()))
}

/// Hermes serves `api/sessions` from a read-only query of at most 100 rows, each SQLite read waiting at most 5 s for a
/// lock (hermes_cli/web_routers/sessions.py; `_READ_BUSY_TIMEOUT_S` in hermes_state.py), so a minute without a byte is a
/// stall.
const SESSION_LIST_IDLE_LIMIT: Duration = Duration::from_secs(60);

/// How long any other dashboard call may go without a byte from Hermes before it is given up as `Stalled` (#473). Other
/// routes may stay silent for minutes and still answer: memory provider setup runs an install of up to 300 s
/// (hermes_cli/web_routers/memory_providers.py), so this is twice that. A call still sending its body counts as silent:
/// at this limit a 25 MB recording needs about 45 KB/s.
const ANSWER_IDLE_LIMIT: Duration = Duration::from_secs(600);

fn is_session_list(path: &str) -> bool {
    let mut segs = path.split('/').filter(|seg| !seg.is_empty());
    segs.next() == Some("api") && segs.next() == Some("sessions") && segs.next().is_none()
}

/// The most read of one relayed answer: the most Outputs reads of one chat in all (src/hermes/outputs.ts
/// `CHAT_MAX_BYTES`). The biggest the webview asks of `get_limited` is about 13.4 MiB, a 10 MiB image preview as
/// base64 JSON (src/hermes/remoteFiles.ts).
const RELAY_MAX_BYTES: u64 = 64 * MIB;

/// `n` bytes as an error names a limit: in whole MB, or whole KB under one MB.
fn size_text(n: u64) -> String {
    if n >= MIB {
        format!("{} MB", n / MIB)
    } else {
        format!("{} KB", n.div_ceil(1024))
    }
}

async fn unless_stalled<T>(limit: Duration, step: impl std::future::Future<Output = reqwest::Result<T>>) -> Result<T, TransportError> {
    tokio::time::timeout(limit, step).await.map_err(|_| TransportError::Stalled(limit.as_secs()))?.map_err(unreachable)
}

/// A whole answer's body, at most `max` bytes: refused as `AnswerTooLarge` once its announced length or the bytes read
/// pass `max`, so a huge or endless body can't fill memory, and as `Stalled` once `idle` passes without a part of it.
async fn read_body(mut resp: reqwest::Response, max: u64, idle: Duration) -> Result<Vec<u8>, TransportError> {
    let too_large = |size| TransportError::AnswerTooLarge { size, max };
    if let Some(size) = resp.content_length().filter(|&n| n > max) {
        return Err(too_large(size));
    }
    let mut body = Vec::new();
    while let Some(part) = unless_stalled(idle, resp.chunk()).await? {
        body.extend_from_slice(&part);
        if body.len() as u64 > max {
            return Err(too_large(body.len() as u64));
        }
    }
    Ok(body)
}

/// A relayed answer's text, up to `RELAY_MAX_BYTES`.
async fn text_unless_stalled(resp: reqwest::Response, limit: Duration) -> Result<String, TransportError> {
    Ok(String::from_utf8_lossy(&read_body(resp, RELAY_MAX_BYTES, limit).await?).into_owned())
}

/// The most read of an answer that is only ever a little JSON: `/api/status`, about a KB or two from a real dashboard
/// and read before anything is known about the server, the sign-in providers, the token check, a socket ticket and an
/// upload's answer.
const SMALL_ANSWER_MAX_BYTES: u64 = 64 * 1024;

/// A small answer's text (`SMALL_ANSWER_MAX_BYTES`).
async fn small_answer(resp: reqwest::Response) -> Result<String, TransportError> {
    Ok(String::from_utf8_lossy(&read_body(resp, SMALL_ANSWER_MAX_BYTES, ANSWER_IDLE_LIMIT).await?).into_owned())
}

/// A small answer as JSON.
async fn small_json(resp: reqwest::Response) -> Result<serde_json::Value, TransportError> {
    let status = resp.status().as_u16();
    serde_json::from_str(&small_answer(resp).await?).map_err(|_| TransportError::Unexpected { status, body: "the answer isn't JSON".into() })
}

fn describe(e: &reqwest::Error) -> String {
    let mut parts = vec![e.to_string()];
    let mut source = std::error::Error::source(e);
    while let Some(s) = source {
        let text = s.to_string();
        if !parts.iter().any(|p| p.contains(&text)) {
            parts.push(text);
        }
        source = s.source();
    }
    parts.join(": ")
}

/// What became of a provider key saved with `Dashboard::save_provider_key`. `verified`: the provider accepted it.
/// Otherwise Hermes couldn't check it (no check for that provider, or the provider couldn't be reached); it is saved
/// either way. Hermes's own message isn't passed on: a provider's can quote part of the key, as OpenAI's does.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SavedKey {
    pub verified: bool,
}

/// How long checking and saving a provider key may take, all requests together.
const KEY_SAVE_LIMIT: Duration = Duration::from_secs(30);

/// Said when the provider turns a key down, in place of its own message, which can quote part of the key.
pub const KEY_TURNED_DOWN: &str = "The provider turned the key down. Check that you copied all of it, and that it's for this provider.";

/// `POST /api/providers/validate`'s answer (`hermes_cli/web_routers/config_env.py` at the deployed `bf0203a`).
#[derive(Deserialize)]
struct Validated {
    ok: bool,
    reachable: bool,
}

/// An env var name that can hold a model provider's API key: upper-case, ending `_API_KEY`, `_KEY` or `_TOKEN`,
/// and not one of Hermes's own (`HERMES_…`, such as the dashboard session token).
fn provider_key_name(key: &str) -> bool {
    let shape = (2..=64).contains(&key.len())
        && key.starts_with(|c: char| c.is_ascii_uppercase())
        && key.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_');
    shape && !key.starts_with("HERMES_") && (key.ends_with("_KEY") || key.ends_with("_TOKEN"))
}

/// Whether `GET /api/env` lists `key` as a model provider's secret, the only kind of key this app writes or removes.
fn require_provider_secret(env: &serde_json::Value, key: &str) -> Result<(), TransportError> {
    let row = &env[key];
    let is_provider_secret =
        row["provider"].as_str().is_some_and(|p| !p.is_empty()) && row["is_password"] == json!(true) && row["channel_managed"] != json!(true);
    if is_provider_secret {
        Ok(())
    } else {
        Err(TransportError::NotRelayed(format!("{key}: Hermes doesn't list it as a model provider's key")))
    }
}

impl Dashboard {
    /// Gives the profile's Hermes a model provider's API key, the way the dashboard's Keys page does
    /// (`hermes_cli/web_routers/config_env.py` at the deployed `bf0203a`):
    ///
    /// 1. `GET /api/env?profile=` must list `key` as a provider's secret, so nothing else in the profile's `.env`
    ///    can be written this way, whatever the webview asks.
    /// 2. `POST /api/providers/validate` asks the provider about the key. A key it turns down isn't saved.
    /// 3. `PUT /api/env?profile=` saves it in the profile's `.env` on the server.
    ///
    /// The key never comes back in an error: a failed answer to a request that carried it isn't shown at all, since
    /// it may echo the key (FastAPI's 422 does), and cutting it short could leave part of the key behind.
    pub async fn save_provider_key(&self, profile: &str, key: &str, value: &str) -> Result<SavedKey, TransportError> {
        self.save_provider_key_within(profile, key, value, KEY_SAVE_LIMIT).await
    }

    /// `save_provider_key`, giving up after `limit`, every request and answer included, so setup never waits on a
    /// Hermes or provider that stopped answering.
    pub async fn save_provider_key_within(&self, profile: &str, key: &str, value: &str, limit: Duration) -> Result<SavedKey, TransportError> {
        tokio::time::timeout(limit, self.check_and_save_key(profile, key, value)).await.unwrap_or(Err(TransportError::KeyTimedOut(limit.as_secs())))
    }

    async fn check_and_save_key(&self, profile: &str, key: &str, value: &str) -> Result<SavedKey, TransportError> {
        let value = value.trim();
        if !provider_key_name(key) {
            return Err(TransportError::NotRelayed(format!("{key}: not a model provider's key")));
        }
        if value.is_empty() || value.len() > 4096 || value.chars().any(char::is_control) {
            return Err(TransportError::KeyRejected("Paste the key on one line, without spaces around it.".into()));
        }
        // The key never follows a redirect to another site, extra headers or not.
        let http = client_kept_to_origin(&self.headers, true)?;
        require_provider_secret(&self.read_env(&http, profile).await?, key)?;

        let body = json!({"key": key, "value": value}).to_string();
        let checked = self.call(&http, Method::POST, endpoint(&self.base, "api/providers/validate"), Some(body), false).await?;
        // Neither the answer nor serde's account of it is shown: either can quote the key.
        let checked: Validated = serde_json::from_str(&checked).map_err(|_| TransportError::Unexpected {
            status: 200,
            body: "Hermes's answer to the key check wasn't understood (not shown, as it may hold the key).".into(),
        })?;
        if !checked.ok && checked.reachable {
            return Err(TransportError::KeyRejected(KEY_TURNED_DOWN.into()));
        }

        let body = json!({"key": key, "value": value, "provider_setup": true}).to_string();
        self.call(&http, Method::PUT, self.env_url(profile), Some(body), false).await?;
        Ok(SavedKey { verified: checked.ok && checked.reachable })
    }

    /// Takes a model provider's API key out of the profile's Hermes, for Settings → Providers (ADR 0095):
    ///
    /// 1. `GET /api/env?profile=` must list `key` as a provider's secret, as `save_provider_key` requires.
    /// 2. `DELETE /api/env?profile=` with `{"key"}` removes it from the profile's `.env` on the server. A 404, which is
    ///    how Hermes says the key isn't set (`<KEY> not found in .env`), counts as removed.
    /// 3. `GET /api/env?profile=` again must show the key unset, or this says Hermes still lists it.
    pub async fn remove_provider_key(&self, profile: &str, key: &str) -> Result<(), TransportError> {
        self.remove_provider_key_within(profile, key, KEY_SAVE_LIMIT).await
    }

    /// `remove_provider_key`, giving up after `limit`, every request and answer included.
    pub async fn remove_provider_key_within(&self, profile: &str, key: &str, limit: Duration) -> Result<(), TransportError> {
        tokio::time::timeout(limit, self.check_and_remove_key(profile, key)).await.unwrap_or(Err(TransportError::KeyRemovalTimedOut(limit.as_secs())))
    }

    async fn check_and_remove_key(&self, profile: &str, key: &str) -> Result<(), TransportError> {
        if !provider_key_name(key) {
            return Err(TransportError::NotRelayed(format!("{key}: not a model provider's key")));
        }
        let http = client_kept_to_origin(&self.headers, true)?;
        require_provider_secret(&self.read_env(&http, profile).await?, key)?;

        let body = json!({"key": key}).to_string();
        match self.call(&http, Method::DELETE, self.env_url(profile), Some(body), true).await {
            Ok(_) | Err(TransportError::Unexpected { status: 404, .. }) => {}
            Err(e) => return Err(e),
        }
        if self.read_env(&http, profile).await?[key]["is_set"] == json!(true) {
            return Err(TransportError::KeyStillSet(key.to_owned()));
        }
        Ok(())
    }

    fn env_url(&self, profile: &str) -> Url {
        let mut url = endpoint(&self.base, "api/env");
        url.query_pairs_mut().append_pair("profile", profile);
        url
    }

    async fn read_env(&self, http: &reqwest::Client, profile: &str) -> Result<serde_json::Value, TransportError> {
        serde_json::from_str(&self.call(http, Method::GET, self.env_url(profile), None, true).await?)
            .map_err(|e| TransportError::Unexpected { status: 200, body: format!("GET /api/env: {e}") })
    }

    /// One signed-in call that the app itself makes, with a JSON body; the webview's are `request`. `show_failure`:
    /// a failed answer's body goes into the error; off for a request that carries a secret.
    async fn call(&self, http: &reqwest::Client, method: Method, url: Url, body: Option<String>, show_failure: bool) -> Result<String, TransportError> {
        let mut req = http.request(method, url).header(header::COOKIE, self.cookie_header());
        if let Some(body) = body {
            req = req.header(header::CONTENT_TYPE, "application/json").body(body);
        }
        let resp = unless_stalled(ANSWER_IDLE_LIMIT, req.send()).await?;
        self.keep_cookies(&resp);
        match resp.status() {
            s if s.is_success() => text_unless_stalled(resp, ANSWER_IDLE_LIMIT).await,
            StatusCode::UNAUTHORIZED => Err(TransportError::SignedOut),
            _ if show_failure => Err(unexpected(resp, &self.hidden()).await),
            s => Err(TransportError::Unexpected { status: s.as_u16(), body: "(not shown, as it may hold the key)".into() }),
        }
    }
}

impl Dashboard {
    /// Settings → MCP servers' edit of one server for `profile` (ADR 0121). Hermes's only edit route replaces the whole
    /// `mcp_servers` map (`PUT /api/mcp/servers`), and its list hides env values, so Rust makes the map:
    ///
    /// 1. `GET /api/config?profile=&include_defaults=false` reads the profile's config as written, `${VAR}` references
    ///    unexpanded (the default read expands them, which would write secrets into config.yaml).
    /// 2. `mcp::edited` changes that one server; every other goes back as read.
    /// 3. A new bearer token goes to the profile's `.env` first, under `MCP_<NAME>_API_KEY` (`PUT /api/env`), as adding
    ///    a server with one does.
    /// 4. `PUT /api/mcp/servers?profile=` writes the map, and a second raw read must show it, or this says so.
    ///
    /// Nothing read goes back to the webview, and no error quotes a secret the map or the token held.
    pub async fn mcp_edit(&self, profile: &str, edit: &crate::mcp::Edit) -> Result<(), TransportError> {
        let http = client_kept_to_origin(&self.headers, true)?;
        let scoped = |path: &str, raw: bool| {
            let mut url = endpoint(&self.base, path);
            url.query_pairs_mut().append_pair("profile", profile);
            if raw {
                url.query_pairs_mut().append_pair("include_defaults", "false");
            }
            url
        };
        let read = || async {
            let text = self.call(&http, Method::GET, scoped("api/config", true), None, true).await?;
            let config: serde_json::Value = serde_json::from_str(&text).map_err(|_| TransportError::Unexpected {
                status: 200,
                body: "Hermes's config wasn't understood (not shown, as it may hold a secret).".into(),
            })?;
            Ok::<_, TransportError>(match &config["mcp_servers"] {
                serde_json::Value::Object(o) => o.clone(),
                _ => serde_json::Map::new(),
            })
        };
        let before = read().await?;
        let edited = crate::mcp::edited(&before, edit).map_err(TransportError::Mcp)?;
        let mut token_saved = false;
        if let Some((key, token)) = &edited.token {
            let body = json!({ "key": key, "value": token }).to_string();
            match self.call(&http, Method::PUT, scoped("api/env", false), Some(body), false).await {
                Ok(_) => token_saved = true,
                // A refusal wrote nothing; anything else may have saved the token.
                Err(e @ TransportError::Unexpected { status: 400..=499, .. }) => return Err(e),
                Err(e) => {
                    return Err(TransportError::McpUnconfirmed(format!(
                        "the new bearer token may have been saved, and the rest of the change wasn't sent: {e}"
                    )))
                }
            }
        }
        // Once the token is saved, an existing `${…}` reference already uses it: nothing after this is "not changed".
        let partial = |e: TransportError| {
            if token_saved {
                TransportError::McpUnconfirmed(format!("Hermes saved the new bearer token, but not the rest of the change: {e}"))
            } else {
                e
            }
        };
        self.write_mcp_map(&http, scoped("api/mcp/servers", false), &edited).await.map_err(partial)?;
        match read().await {
            Ok(after) if after == edited.servers => Ok(()),
            Ok(_) => Err(TransportError::McpUnconfirmed(
                "Hermes took the change, but its config reads back otherwise: another client may have changed it meanwhile. The list shows what Hermes has now.".into(),
            )),
            Err(e) => Err(TransportError::McpUnconfirmed(format!("Hermes took the change, but its config couldn't be read back to confirm it: {e}"))),
        }
    }

    /// `PUT /api/mcp/servers` with the whole map; a refusal is shown without any secret the map held.
    async fn write_mcp_map(&self, http: &reqwest::Client, url: Url, edited: &crate::mcp::Edited) -> Result<(), TransportError> {
        let body = json!({ "servers": edited.servers }).to_string();
        let put = http.put(url).header(header::COOKIE, self.cookie_header()).header(header::CONTENT_TYPE, "application/json").body(body);
        let resp = unless_stalled(ANSWER_IDLE_LIMIT, put.send()).await?;
        self.keep_cookies(&resp);
        match resp.status() {
            s if s.is_success() => Ok(()),
            StatusCode::UNAUTHORIZED => Err(TransportError::SignedOut),
            s => {
                let answer = text_unless_stalled(resp, ANSWER_IDLE_LIMIT).await.unwrap_or_default();
                // Neither a secret the map held nor a value of the owner's extra request headers is shown.
                let body = shown_body(s, &crate::mcp::scrubbed(&answer, &edited.secrets), &self.hidden());
                Err(TransportError::Unexpected { status: s.as_u16(), body })
            }
        }
    }
}

/// The body of `POST api/fs/write-text` (`FsWriteText` at `f0d94882`): the path, the whole text, and the chat whose
/// sandbox the path is in when there is one. A chat id is Hermes's stored session id; anything blank, over 256
/// characters or holding a control character isn't one, and isn't sent.
fn agent_text_body(path: &str, text: &str, session: Option<&str>) -> Result<serde_json::Value, TransportError> {
    let mut body = serde_json::json!({ "path": path, "content": text });
    if let Some(id) = session {
        if id.trim().is_empty() || id.len() > 256 || id.chars().any(char::is_control) {
            return Err(TransportError::NotRelayed(format!("writes to {path} for a chat id that isn't one")));
        }
        body["session_id"] = serde_json::Value::String(id.to_owned());
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::{
        agent_text_body, memory_entry_edit_allowed, memory_provider_write, profile_create_allowed, provider_key_name, skill_create_allowed,
        text_unless_stalled, unless_stalled, webhook_write, TransportError,
    };
    use std::time::Duration;

    #[test]
    fn an_artifact_save_names_the_chat_whose_sandbox_the_file_is_in() {
        let plain = agent_text_body("/workspace/a.sh", "echo", None).unwrap();
        assert_eq!(plain, serde_json::json!({ "path": "/workspace/a.sh", "content": "echo" }));
        let scoped = agent_text_body("/workspace/a.sh", "echo", Some("20261104_215039_395729")).unwrap();
        assert_eq!(scoped, serde_json::json!({ "path": "/workspace/a.sh", "content": "echo", "session_id": "20261104_215039_395729" }));
        let long = "x".repeat(257);
        for bad in ["", "  ", "a\nb", long.as_str()] {
            assert!(matches!(agent_text_body("/workspace/a.sh", "echo", Some(bad)), Err(TransportError::NotRelayed(_))), "{bad:?}");
        }
    }

    #[test]
    fn only_a_skill_copy_creates_a_skill() {
        for body in [
            r#"{"name":"release-notes","content":"---\nname: release-notes\n---\nx"}"#,
            r#"{"name":"a.b_c-9","content":"x","category":"writing"}"#,
            &format!(r#"{{"name":"{}","content":""}}"#, "a".repeat(64)),
        ] {
            assert!(skill_create_allowed(Some(body)), "{body}");
        }
        for body in [
            r#"{"name":"Release","content":"x"}"#,
            r#"{"name":"-x","content":"x"}"#,
            r#"{"name":"../x","content":"x"}"#,
            r#"{"name":"a/b","content":"x"}"#,
            r#"{"name":"","content":"x"}"#,
            r#"{"name":"x","content":"x","category":"a/b"}"#,
            r#"{"name":"x","content":"x","category":".."}"#,
            r#"{"name":"x","content":"x","category":null}"#,
            // The profile goes in the query only.
            r#"{"name":"x","content":"x","profile":"other"}"#,
            r#"{"name":"x"}"#,
            r#"{"name":"x","content":1}"#,
            "[]",
            "not json",
        ] {
            assert!(!skill_create_allowed(Some(body)), "{body}");
        }
        assert!(!skill_create_allowed(Some(&format!(r#"{{"name":"{}","content":""}}"#, "a".repeat(65)))));
        assert!(!skill_create_allowed(None));
    }

    #[test]
    fn a_new_profile_carries_no_secrets_unless_the_full_copy_is_asked_for() {
        for body in [
            r#"{"name":"work-2"}"#,
            r#"{"name":"work-2","soul":"You are terse.","description":"Release","provider":"openrouter","model":"x/y"}"#,
            r#"{"name":"work-2","clone_from":"work"}"#,
            r#"{"name":"work_2","clone_from":"default"}"#,
            r#"{"name":"work-2","clone_from":"work","description":"Release"}"#,
            &format!(r#"{{"name":"{}"}}"#, "a".repeat(64)),
        ] {
            assert!(profile_create_allowed(Some(body)), "{body}");
        }
        for body in [
            r#"{"name":"work-2","clone_from":"work","clone_all":true}"#,
            r#"{"name":"work-2","clone_from":"work","soul":"x"}"#,
            r#"{"name":"work-2","clone_from":"work","provider":"x","model":"y"}"#,
            r#"{"name":"work-2","clone_all":true}"#,
            r#"{"name":"work-2","clone_channels":true}"#,
            r#"{"name":"work-2","clone_from_default":true}"#,
            r#"{"name":"work-2","mcp_servers":[{"name":"m","url":"http://x","bearer_token":"t"}]}"#,
            r#"{"name":"work-2","hub_skills":["x"]}"#,
            r#"{"name":"work-2","keep_skills":["x"]}"#,
            r#"{"name":"work-2","no_skills":true}"#,
            r#"{"name":"work-2","clone_from":"../work"}"#,
            r#"{"name":"work-2","clone_from":null}"#,
            r#"{"name":"work-2","soul":null}"#,
            r#"{"name":"default"}"#,
            r#"{"name":"Work"}"#,
            r#"{"name":"../x"}"#,
            r#"{"name":""}"#,
            r#"{"soul":"x"}"#,
            "[]",
            "not json",
        ] {
            assert!(!profile_create_allowed(Some(body)), "{body}");
        }
        assert!(!profile_create_allowed(Some(&format!(r#"{{"name":"{}"}}"#, "a".repeat(65)))));
        assert!(!profile_create_allowed(None));
    }

    #[test]
    fn only_memory_entries_are_edited_through_the_learning_route() {
        for body in [r#"{"id":"memory:memory:0:0123456789ab","content":"x"}"#, r#"{"id":"memory:profile:12:abcdefabcdef","content":""}"#] {
            assert!(memory_entry_edit_allowed(Some(body)), "{body}");
        }
        for body in [
            // A skill's id is its name: skills are edited through api/skills/content only.
            r#"{"id":"release-notes","content":"x"}"#,
            r#"{"id":"memory:memory:0","content":"x"}"#,
            r#"{"id":"memory:other:0:0123456789ab","content":"x"}"#,
            r#"{"id":"memory:memory:x:0123456789ab","content":"x"}"#,
            r#"{"id":"memory:memory:0:0123456789AB","content":"x"}"#,
            r#"{"id":"memory:memory:0:0123456789abc","content":"x"}"#,
            r#"{"id":"memory:memory:0:0123456789ab:x","content":"x"}"#,
            r#"{"id":"memory:memory:0:0123456789ab","content":"x","profile":"p"}"#,
            r#"{"id":"memory:memory:0:0123456789ab","content":1}"#,
            "not json",
        ] {
            assert!(!memory_entry_edit_allowed(Some(body)), "{body}");
        }
        assert!(!memory_entry_edit_allowed(None));
    }

    #[test]
    fn only_the_memory_provider_writes() {
        for (method, path, body) in [
            ("PUT", "api/memory/provider", r#"{"provider":"honcho"}"#),
            ("PUT", "api/memory/provider", r#"{"provider":""}"#),
            ("PUT", "api/memory/providers/honcho/config", r#"{"values":{"workspace":"shared","apiKey":"k"}}"#),
            ("PUT", "api/memory/providers/my_mem-0/config", r#"{"values":{"user_id":"owner"}}"#),
            ("POST", "api/memory/providers/retaindb/setup", r#"{"values":{}}"#),
        ] {
            assert!(memory_provider_write(method, path, Some(body)), "{method} {path} {body}");
        }
        for (method, path, body) in [
            // Deleting the built-in memory files isn't reached.
            ("POST", "api/memory/reset", r#"{"target":"all"}"#),
            ("PUT", "api/memory/provider", r#"{"provider":"../x"}"#),
            ("PUT", "api/memory/provider", r#"{"provider":"honcho","x":1}"#),
            ("PUT", "api/memory/provider", r#"{"provider":true}"#),
            ("POST", "api/memory/provider", r#"{"provider":"honcho"}"#),
            // Setup never carries settings.
            ("POST", "api/memory/providers/honcho/setup", r#"{"values":{"apiKey":"k"}}"#),
            ("PUT", "api/memory/providers/honcho/setup", r#"{"values":{}}"#),
            ("POST", "api/memory/providers/honcho/config", r#"{"values":{}}"#),
            ("PUT", "api/memory/providers/honcho/config", r#"{"values":{"timeout":30}}"#),
            ("PUT", "api/memory/providers/honcho/config", r#"{"values":{"":"x"}}"#),
            // An empty write would switch the provider unchecked.
            ("PUT", "api/memory/providers/honcho/config", r#"{"values":{}}"#),
            ("PUT", "api/memory/providers/honcho/config", r#"{"values":{},"x":1}"#),
            ("PUT", "api/memory/providers/honcho/config", r#"{"values":[]}"#),
            ("PUT", "api/memory/providers/..%2Fx/config", r#"{"values":{}}"#),
            ("PUT", "api/memory/providers/../config", r#"{"values":{}}"#),
            ("PUT", "api/memory/providers/_x/config", r#"{"values":{}}"#),
            ("PUT", "api/memory/providers/honcho/config/x", r#"{"values":{}}"#),
            ("PUT", "api/memory/providers/honcho", r#"{"values":{}}"#),
            ("PUT", "api/memory/providers/honcho/config", "not json"),
        ] {
            assert!(!memory_provider_write(method, path, Some(body)), "{method} {path} {body}");
        }
        assert!(!memory_provider_write("PUT", &format!("api/memory/providers/{}/config", "a".repeat(65)), Some(r#"{"values":{}}"#)));
        assert!(!memory_provider_write("PUT", "api/memory/provider", None));
    }

    #[test]
    fn only_the_automations_writes() {
        for (method, path, body) in [
            ("POST", "api/webhooks", r#"{"name":"triage","events":["issues"],"prompt":"p","filters":[],"create_only":true}"#),
            ("PUT", "api/webhooks/triage", r#"{"revision":"abc","prompt":"p","rotate_secret":true}"#),
            ("PUT", "api/webhooks/triage-2_x/enabled", r#"{"enabled":false}"#),
            (
                "POST",
                "api/webhooks/triage/deliveries/7b1c0a10-0000-4000-8000-000000000001~retry~ab12/retry",
                r#"{"idempotency_key":"k","confirm_side_effects":true}"#,
            ),
        ] {
            assert!(webhook_write(method, path, Some(body)), "{method} {path} {body}");
        }
        // Every route Hermes lists stays manageable, the editor's longest new name (64) and beyond.
        let long = |n: usize| format!("api/webhooks/{}/enabled", "a".repeat(n));
        assert!(webhook_write("PUT", &long(65), Some(r#"{"enabled":false}"#)));
        assert!(webhook_write("PUT", &long(200), Some(r#"{"enabled":false}"#)));
        assert!(!webhook_write("PUT", &long(201), Some(r#"{"enabled":false}"#)));
        for (method, path, body) in [
            // A secret never goes through the webview, and direct delivery isn't set from here.
            ("POST", "api/webhooks", r#"{"name":"triage","secret":"s"}"#),
            ("POST", "api/webhooks", r#"{"name":"triage","deliver_only":true}"#),
            ("PUT", "api/webhooks/triage", r#"{"revision":"r","secret":"s"}"#),
            // The platform switch rewrites the config and restarts the gateway.
            ("POST", "api/webhooks/enable", r#"{}"#),
            ("PUT", "api/webhooks/triage/enabled", r#"{"enabled":"no"}"#),
            ("PUT", "api/webhooks/triage/enabled", r#"{"enabled":true,"profile":"x"}"#),
            ("PUT", "api/webhooks/Triage", r#"{"revision":"r"}"#),
            ("PUT", "api/webhooks/-x", r#"{"revision":"r"}"#),
            ("PUT", "api/webhooks/..", r#"{"revision":"r"}"#),
            ("PUT", "api/webhooks/a%2Fb", r#"{"revision":"r"}"#),
            ("PUT", "api/webhooks", r#"{"name":"x"}"#),
            ("POST", "api/webhooks/triage", r#"{"name":"x"}"#),
            ("POST", "api/webhooks/triage/deliveries/../retry", r#"{"idempotency_key":"k"}"#),
            ("POST", "api/webhooks/triage/deliveries/a%2Fb/retry", r#"{"idempotency_key":"k"}"#),
            ("POST", "api/webhooks/triage/deliveries/x/retry/now", r#"{"idempotency_key":"k"}"#),
            ("POST", "api/webhooksx", r#"{"name":"x"}"#),
            ("POST", "api/webhooks", "not json"),
            ("POST", "api/webhooks", "[]"),
        ] {
            assert!(!webhook_write(method, path, Some(body)), "{method} {path} {body}");
        }
        assert!(!webhook_write("POST", "api/webhooks", None));
    }

    #[test]
    fn only_provider_key_names() {
        for ok in ["OPENROUTER_API_KEY", "HF_TOKEN", "GITHUB_TOKEN", "Z_AI_API_KEY", "DASHSCOPE_API_KEY"] {
            assert!(provider_key_name(ok), "{ok}");
        }
        for bad in ["HERMES_DASHBOARD_SESSION_TOKEN", "PATH", "OPENAI_BASE_URL", "openrouter_api_key", "_API_KEY", "A B_KEY", "X\nY_KEY", ""] {
            assert!(!provider_key_name(bad), "{bad}");
        }
    }

    enum Then {
        End,
        GoQuiet,
    }

    async fn trickle(parts: usize, gap: Duration, then: Then) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 4096];
            let _ = sock.read(&mut request).await;
            sock.write_all(b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n").await.unwrap();
            for i in 0..parts {
                if i > 0 {
                    tokio::time::sleep(gap).await;
                }
                let part = format!("part{i};");
                sock.write_all(format!("{:x}\r\n{part}\r\n", part.len()).as_bytes()).await.unwrap();
            }
            if let Then::End = then {
                sock.write_all(b"0\r\n\r\n").await.unwrap();
            }
            std::future::pending::<()>().await;
        });
        url
    }

    #[tokio::test]
    async fn a_read_that_keeps_arriving_finishes_however_long_it_takes_in_all() {
        let url = trickle(16, Duration::from_millis(250), Then::End).await;
        let http = reqwest::Client::new();
        let limit = Duration::from_secs(3);
        let started = std::time::Instant::now();
        let resp = unless_stalled(limit, http.get(url).send()).await.unwrap();
        let text = text_unless_stalled(resp, limit).await.unwrap();
        assert_eq!(text, (0..16).map(|i| format!("part{i};")).collect::<String>());
        assert!(started.elapsed() > limit, "the read ended in {:?}, inside the limit, so it shows nothing about the gaps", started.elapsed());
    }

    #[tokio::test]
    async fn a_read_that_stops_arriving_is_given_up_once_the_limit_passes_without_a_byte() {
        let url = trickle(2, Duration::from_millis(50), Then::GoQuiet).await;
        let http = reqwest::Client::new();
        let limit = Duration::from_secs(1);
        let started = std::time::Instant::now();
        let resp = unless_stalled(limit, http.get(url).send()).await.unwrap();
        let err = text_unless_stalled(resp, limit).await.unwrap_err();
        assert!(matches!(err, TransportError::Stalled(_)), "{err:?}");
        assert!(started.elapsed() >= limit + Duration::from_millis(50), "{:?}", started.elapsed());
    }

    /// A listener whose accepted sockets take little before the test reads them, so the client's write backs up soon.
    fn small_buffered_listener() -> tokio::net::TcpListener {
        let socket = tokio::net::TcpSocket::new_v4().unwrap();
        socket.set_recv_buffer_size(64 * 1024).unwrap();
        socket.bind("127.0.0.1:0".parse().unwrap()).unwrap();
        socket.listen(1).unwrap()
    }

    /// Windows takes one write of any size whole while its send buffer isn't full, so a frame written in one call
    /// counted as gone at once (#469). The pipe's socket hands it at most `WRITE_CAP` a write, and loses nothing.
    #[tokio::test]
    async fn the_pipe_socket_takes_a_big_frame_a_capped_piece_at_a_time() {
        use tokio::io::AsyncWriteExt;
        let frame: Vec<u8> = (0..3 * super::WRITE_CAP + 5).map(|i| i as u8).collect();
        let mut socket = super::CappedWrites(Vec::new());
        assert_eq!(socket.write(&frame).await.unwrap(), super::WRITE_CAP);
        socket.write_all(&frame[super::WRITE_CAP..]).await.unwrap();
        assert_eq!(socket.0, frame);
    }

    /// #469: a file frame big enough to fill the socket's buffers is still being written when Hermes speaks. The pipe
    /// hands that frame to the webview at once, and `send_file` resolves only once the whole file has gone.
    #[tokio::test]
    async fn the_pipe_keeps_hearing_hermes_while_a_big_file_is_still_being_written() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::Message;

        let listener = small_buffered_listener();
        let addr = listener.local_addr().unwrap();
        let (speak, spoken) = tokio::sync::oneshot::channel::<()>();
        let (read, reading) = tokio::sync::oneshot::channel::<()>();
        let (got, received) = tokio::sync::oneshot::channel::<usize>();
        tokio::spawn(async move {
            let (sock, _) = listener.accept().await.unwrap();
            // Hermes takes frames this big; tungstenite's own default stops at 16 MiB.
            let config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default().max_frame_size(None).max_message_size(None);
            let (mut sink, mut stream) = tokio_tungstenite::accept_async_with_config(sock, Some(config)).await.unwrap().split();
            // Nothing is read until the test says so, so the client's write backs up.
            spoken.await.unwrap();
            sink.send(Message::text("{\"jsonrpc\":\"2.0\",\"method\":\"event\"}")).await.unwrap();
            reading.await.unwrap();
            while let Some(Ok(msg)) = stream.next().await {
                if let Message::Text(text) = msg {
                    let _ = got.send(text.len());
                    break;
                }
            }
            std::future::pending::<()>().await;
        });

        let path = std::env::temp_dir().join(format!("hermes-pipe-469-{}.bin", std::process::id()));
        let size = 24 * 1024 * 1024;
        std::fs::write(&path, vec![7u8; size]).unwrap();
        let ws = super::open_pipe_socket(super::IntoClientRequest::into_client_request(format!("ws://{addr}/api/ws")).unwrap()).await.unwrap();
        let (events, mut heard) = tokio::sync::mpsc::unbounded_channel();
        let pipe = super::run_pipe(ws, move |e| drop(events.send(e)), super::HeaderMap::new());

        let sending = {
            let (pipe, path) = (pipe.sender(), path.to_string_lossy().into_owned());
            tokio::spawn(async move { pipe.send_file("{\"f\":\"", &path, "\"}", 64 * 1024 * 1024).await?.wait().await })
        };
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(!sending.is_finished(), "send_file resolved before Hermes read the file");
        speak.send(()).unwrap();
        let event = tokio::time::timeout(Duration::from_secs(5), heard.recv()).await.expect("nothing heard while the file was being written");
        assert!(matches!(event, Some(super::PipeEvent::Frame { .. })), "{event:?}");
        assert!(!sending.is_finished(), "send_file resolved before Hermes read the file");

        read.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(20), sending).await.unwrap().unwrap().unwrap();
        assert_eq!(received.await.unwrap(), "{\"f\":\"".len() + size.div_ceil(3) * 4 + "\"}".len());
        let _ = std::fs::remove_file(&path);
    }

    /// Replacing the connection drops its pipe, and that stops a file frame still being written: the wait ends with
    /// `Closed` instead of the old socket writing on (#469).
    #[tokio::test]
    async fn dropping_the_pipe_stops_a_file_frame_still_being_written() {
        let listener = small_buffered_listener();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (sock, _) = listener.accept().await.unwrap();
            // Accepted and never read, so the client's write backs up.
            let _ws = tokio_tungstenite::accept_async(sock).await.unwrap();
            std::future::pending::<()>().await;
        });
        let path = std::env::temp_dir().join(format!("hermes-pipe-469-drop-{}.bin", std::process::id()));
        std::fs::write(&path, vec![7u8; 24 * 1024 * 1024]).unwrap();
        let ws = super::open_pipe_socket(super::IntoClientRequest::into_client_request(format!("ws://{addr}/api/ws")).unwrap()).await.unwrap();
        let pipe = super::run_pipe(ws, |_| {}, super::HeaderMap::new());

        let written = pipe.sender().send_file("{\"f\":\"", &path.to_string_lossy(), "\"}", 64 * 1024 * 1024).await.unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        drop(pipe);
        let ended = tokio::time::timeout(Duration::from_secs(5), written.wait()).await.expect("the write went on after the pipe was dropped");
        assert!(matches!(ended, Err(TransportError::Closed)), "{ended:?}");
        let _ = std::fs::remove_file(&path);
    }

    fn temp_file(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("hermes-transport-{name}-{}", std::process::id()));
        std::fs::write(&path, bytes).unwrap();
        path
    }

    /// A picked image is read up to the 25 MiB preview limit; a small one mustn't cost the whole limit in memory.
    #[test]
    fn reading_the_start_of_a_small_file_holds_only_what_it_read() {
        let path = temp_file("prefix-small", b"hello");
        let bytes = super::read_file_prefix(&std::fs::File::open(&path).unwrap(), super::PREVIEW_MAX_BYTES + 1).unwrap();
        assert_eq!(bytes, b"hello");
        assert!(bytes.capacity() < 64 * 1024, "{} bytes held for a 5-byte file", bytes.capacity());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn reading_the_start_of_a_file_stops_at_the_limit() {
        let whole: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
        let path = temp_file("prefix-cut", &whole);
        let file = std::fs::File::open(&path).unwrap();
        assert_eq!(super::read_file_prefix(&file, 150_001).unwrap(), &whole[..150_001]);
        assert_eq!(super::read_file_prefix(&file, 1 << 20).unwrap(), whole);
        let _ = std::fs::remove_file(&path);
    }

    /// A pipe to a WebSocket server that reads every frame and hands its text to the returned channel.
    async fn reading_pipe() -> (super::Pipe, tokio::sync::mpsc::UnboundedReceiver<String>) {
        use futures_util::StreamExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (frames, heard) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(async move {
            let (sock, _) = listener.accept().await.unwrap();
            let config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default().max_frame_size(None).max_message_size(None);
            let mut ws = tokio_tungstenite::accept_async_with_config(sock, Some(config)).await.unwrap();
            while let Some(Ok(msg)) = ws.next().await {
                if let super::Message::Text(text) = msg {
                    let _ = frames.send(text.to_string());
                }
            }
        });
        let ws = super::open_pipe_socket(super::IntoClientRequest::into_client_request(format!("ws://{addr}/api/ws")).unwrap()).await.unwrap();
        (super::run_pipe(ws, |_| {}, super::HeaderMap::new()), heard)
    }

    /// The webview names the most a file may be. Rust holds it to the most the webview ever attaches, 256 MiB
    /// (src/hermes/transport.ts `LIMITS.file.bytes`), and a limit past any size can't wrap round to nothing.
    #[tokio::test]
    async fn an_attachment_limit_past_any_size_is_held_to_the_attachment_limit() {
        let (pipe, mut frames) = reading_pipe().await;
        let path = temp_file("attach-unlimited", b"abc");
        match pipe.sender().send_file("[", &path.to_string_lossy(), "]", u64::MAX).await {
            Ok(written) => written.wait().await.unwrap(),
            Err(e) => panic!("{e:?}"),
        }
        assert_eq!(tokio::time::timeout(Duration::from_secs(5), frames.recv()).await.unwrap().unwrap(), "[YWJj]");

        let big = temp_file("attach-too-big", b"");
        std::fs::File::options().write(true).open(&big).unwrap().set_len(256 * 1024 * 1024 + 1).unwrap();
        match pipe.sender().send_file("[", &big.to_string_lossy(), "]", u64::MAX).await {
            Err(TransportError::FileTooLarge { max, .. }) => assert_eq!(max, 256 * 1024 * 1024),
            Err(e) => panic!("{e:?}"),
            Ok(_) => panic!("a file over 256 MiB was sent"),
        }
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&big);
    }

    /// A server that answers one request with `head` and then sends nothing more, keeping the connection open.
    async fn answers_then_waits(head: String) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 4096];
            let _ = sock.read(&mut request).await;
            sock.write_all(head.as_bytes()).await.unwrap();
            std::future::pending::<()>().await;
        });
        url
    }

    fn dashboard_at(base: &str) -> super::Dashboard {
        super::Dashboard {
            http: reqwest::Client::new(),
            base: url::Url::parse(base).unwrap(),
            cookies: Default::default(),
            headers: super::HeaderMap::new(),
            hide: super::HeaderMap::new(),
            token: false,
        }
    }

    /// The webview's limit for a big answer is held to the relay's 64 MiB, the most Outputs reads of one chat in all
    /// (src/hermes/outputs.ts `CHAT_MAX_BYTES`): an answer announcing more is refused before any of it is read.
    #[tokio::test]
    async fn a_limited_get_past_any_size_is_held_to_the_relay_limit() {
        let relay_max: u64 = 64 * 1024 * 1024;
        let url = answers_then_waits(format!("HTTP/1.1 200 OK\r\ncontent-length: {}\r\n\r\n", relay_max + 1)).await;
        let dashboard = dashboard_at(&url);
        match tokio::time::timeout(Duration::from_secs(5), dashboard.get_limited("api/files/read?path=/big", u64::MAX)).await {
            Ok(Err(TransportError::FileTooLarge { size, max })) => assert_eq!((size, max), (relay_max + 1, relay_max)),
            Ok(other) => panic!("{other:?}"),
            Err(_) => panic!("still reading an answer announced past the relay limit"),
        }
    }

    /// A server that answers every request 200 with a body that never ends.
    async fn endless() -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        tokio::spawn(async move {
            loop {
                let (mut sock, _) = listener.accept().await.unwrap();
                tokio::spawn(async move {
                    let mut request = [0u8; 4096];
                    let _ = sock.read(&mut request).await;
                    sock.write_all(b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n").await.unwrap();
                    let chunk = format!("4000\r\n{}\r\n", "x".repeat(0x4000));
                    while sock.write_all(chunk.as_bytes()).await.is_ok() {}
                });
            }
        });
        url
    }

    /// `/api/status` is read before anything is known about the server, so whatever answers at a mistyped address
    /// mustn't fill memory: a real status is a KB or two, and past 64 KiB it is given up as not a Hermes dashboard.
    #[tokio::test]
    async fn a_status_that_never_ends_is_given_up_past_64_kib() {
        let base = url::Url::parse(&endless().await).unwrap();
        let headers = super::HeaderMap::new();
        let read = super::read_server(&super::client(&headers).unwrap(), &base, &headers, None, Duration::from_secs(5)).await;
        assert!(matches!(read, Err(TransportError::NotHermes)), "{read:?}");
    }

    /// The socket ticket's answer is a few words of JSON; one that never ends is given up past 64 KiB.
    #[tokio::test]
    async fn a_ticket_that_never_ends_is_given_up_past_64_kib() {
        let dashboard = dashboard_at(&endless().await);
        match tokio::time::timeout(Duration::from_secs(5), dashboard.ws_ticket()).await {
            Ok(Err(TransportError::AnswerTooLarge { max, .. })) => assert_eq!(max, 64 * 1024),
            Ok(other) => panic!("{other:?}"),
            Err(_) => panic!("still reading a ticket that never ends"),
        }
    }

    /// A pipe to a WebSocket server that reads nothing until `read` is sent, then hands each frame's text on.
    async fn held_pipe() -> (super::Pipe, tokio::sync::oneshot::Sender<()>, tokio::sync::mpsc::UnboundedReceiver<String>) {
        use futures_util::StreamExt;
        let listener = small_buffered_listener();
        let addr = listener.local_addr().unwrap();
        let (read, reading) = tokio::sync::oneshot::channel::<()>();
        let (frames, heard) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(async move {
            let (sock, _) = listener.accept().await.unwrap();
            let config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default().max_frame_size(None).max_message_size(None);
            let mut ws = tokio_tungstenite::accept_async_with_config(sock, Some(config)).await.unwrap();
            reading.await.unwrap();
            while let Some(Ok(msg)) = ws.next().await {
                if let super::Message::Text(text) = msg {
                    let _ = frames.send(text.to_string());
                }
            }
        });
        let ws = super::open_pipe_socket(super::IntoClientRequest::into_client_request(format!("ws://{addr}/api/ws")).unwrap()).await.unwrap();
        (super::run_pipe(ws, |_| {}, super::HeaderMap::new()), read, heard)
    }

    /// A JSON-RPC frame can't be dropped, so behind a write Hermes isn't reading, frames wait rather than pile up:
    /// 16 queue, and the next `send` waits until Hermes reads again. Nothing is lost.
    #[tokio::test]
    async fn sending_waits_once_16_frames_are_queued_behind_a_slow_write() {
        let (pipe, read, mut frames) = held_pipe().await;
        let sender = pipe.sender();
        let big = "x".repeat(24 * 1024 * 1024);
        sender.send(big.clone()).await.unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        for i in 0..16 {
            tokio::time::timeout(Duration::from_secs(1), sender.send(format!("{i}"))).await.expect("queued").unwrap();
        }
        let mut waiting = std::pin::pin!(sender.send("16".into()));
        assert!(tokio::time::timeout(Duration::from_millis(300), &mut waiting).await.is_err(), "a 17th frame queued behind the write");
        read.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(20), waiting).await.expect("still waiting once Hermes read").unwrap();
        assert_eq!(frames.recv().await.unwrap().len(), big.len());
        for i in 0..=16 {
            assert_eq!(frames.recv().await.unwrap(), i.to_string());
        }
    }

    /// A file frame is the file whole as base64, up to about 341 MiB, so only one is held at a time: a second
    /// attachment's file isn't read until the first frame has been written.
    #[tokio::test]
    async fn a_second_attachment_isnt_read_until_the_first_has_been_written() {
        let (pipe, read, mut frames) = held_pipe().await;
        let first = temp_file("attach-first", &vec![7u8; 24 * 1024 * 1024]);
        let second = std::env::temp_dir().join(format!("hermes-transport-attach-second-{}", std::process::id()));
        let _ = std::fs::remove_file(&second);
        let send = |path: &std::path::Path| {
            let (pipe, path) = (pipe.sender(), path.to_string_lossy().into_owned());
            tokio::spawn(async move { pipe.send_file("[", &path, "]", u64::MAX).await?.wait().await })
        };
        let sending_first = send(&first);
        tokio::time::sleep(Duration::from_millis(300)).await;
        let sending_second = send(&second);
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(!sending_second.is_finished(), "the second file was read while the first frame was being written: {:?}", sending_second.await);
        std::fs::write(&second, b"later").unwrap();
        read.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(20), sending_first).await.unwrap().unwrap().unwrap();
        tokio::time::timeout(Duration::from_secs(20), sending_second).await.unwrap().unwrap().unwrap();
        assert_eq!(frames.recv().await.unwrap().len(), 2 + (24 * 1024 * 1024usize).div_ceil(3) * 4);
        assert_eq!(frames.recv().await.unwrap(), "[bGF0ZXI=]");
        let _ = std::fs::remove_file(&first);
        let _ = std::fs::remove_file(&second);
    }

    /// Signing out or connecting again drops the connection's pipe. A frame still waiting for room in the queue then
    /// fails, rather than keeping the old socket open and going out on it once Hermes reads again.
    #[tokio::test]
    async fn a_send_waiting_for_room_fails_once_the_pipe_is_dropped() {
        let (pipe, _read, _frames) = held_pipe().await;
        let sender = pipe.sender();
        sender.send("x".repeat(24 * 1024 * 1024)).await.unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        for i in 0..16 {
            tokio::time::timeout(Duration::from_secs(1), sender.send(format!("{i}"))).await.expect("queued").unwrap();
        }
        let waiting = tokio::spawn(async move { sender.send("after sign-out".into()).await });
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(!waiting.is_finished(), "the 17th frame didn't wait");
        drop(pipe);
        let sent = tokio::time::timeout(Duration::from_secs(2), waiting).await.expect("still waiting after the pipe was dropped").unwrap();
        assert!(matches!(sent, Err(TransportError::Closed)), "{sent:?}");
    }

    /// The same for an attachment waiting for the one being written: it fails without its file being read, and the
    /// one being written stops too.
    #[tokio::test]
    async fn an_attachment_waiting_its_turn_fails_once_the_pipe_is_dropped() {
        let (pipe, _read, _frames) = held_pipe().await;
        let first = temp_file("attach-dropped-first", &vec![7u8; 24 * 1024 * 1024]);
        let second = temp_file("attach-dropped-second", b"later");
        let send = |path: &std::path::Path| {
            let (pipe, path) = (pipe.sender(), path.to_string_lossy().into_owned());
            tokio::spawn(async move { pipe.send_file("[", &path, "]", u64::MAX).await?.wait().await })
        };
        let sending_first = send(&first);
        tokio::time::sleep(Duration::from_millis(300)).await;
        let sending_second = send(&second);
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(!sending_second.is_finished(), "the second attachment didn't wait its turn");
        drop(pipe);
        for sending in [sending_first, sending_second] {
            let sent = tokio::time::timeout(Duration::from_secs(2), sending).await.expect("still sending after the pipe was dropped").unwrap();
            assert!(matches!(sent, Err(TransportError::Closed)), "{sent:?}");
        }
        let _ = std::fs::remove_file(&first);
        let _ = std::fs::remove_file(&second);
    }

    async fn serve(app: axum::Router) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        url
    }

    fn cookie_of(headers: &axum::http::HeaderMap) -> String {
        headers.get("cookie").and_then(|v| v.to_str().ok()).unwrap_or("").to_owned()
    }

    /// A server removes a cookie by setting it to expire: `Max-Age` of zero or less, or an `Expires` already past.
    /// `Max-Age` wins over `Expires` (RFC 6265 §5.3).
    #[tokio::test]
    async fn a_cookie_set_to_expire_is_no_longer_sent() {
        use axum::response::AppendHeaders;
        let set = |cookies: &'static [&'static str]| move || async move { AppendHeaders(cookies.iter().map(|c| ("set-cookie", *c)).collect::<Vec<_>>()) };
        let app = axum::Router::new()
            .route("/api/set", axum::routing::get(set(&["a=A1; Path=/", "b=B1", "c=C1", "d=D1", "e=E1", "f=F1"])))
            .route(
                "/api/expire",
                axum::routing::get(set(&[
                    "a=A1; Max-Age=0; Path=/",
                    "b=B1; max-age=-1",
                    "c=C1; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
                    "d=D1; expires=Sunday, 06-Nov-94 08:49:37 GMT",
                    "e=E2; Expires=Fri, 01 Jan 2100 00:00:00 GMT",
                    "f=F2; Max-Age=3600; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
                ])),
            )
            .route("/api/echo", axum::routing::get(|headers: axum::http::HeaderMap| async move { cookie_of(&headers) }));
        let dashboard = dashboard_at(&serve(app).await);
        dashboard.request("GET", "api/set", None).await.unwrap();
        dashboard.request("GET", "api/expire", None).await.unwrap();
        assert_eq!(dashboard.request("GET", "api/echo", None).await.unwrap(), "e=E2; f=F2");
    }

    #[test]
    fn a_cookie_date_is_read_in_each_form_servers_send() {
        // RFC 9110's example date, 784111777 s after 1970.
        for date in ["Sun, 06 Nov 1994 08:49:37 GMT", "Sunday, 06-Nov-94 08:49:37 GMT", "Sun Nov  6 08:49:37 1994"] {
            assert_eq!(super::cookie_date(date), Some(784111777), "{date}");
        }
        for bad in ["", "yesterday", "Sun, 32 Nov 1994 08:49:37 GMT", "Sun, 06 Nov 1994 24:49:37 GMT", "Sun, 06 Nov 1994"] {
            assert_eq!(super::cookie_date(bad), None, "{bad}");
        }
    }

    /// An error page that repeats a session cookie, as a proxy's or a debug page can, isn't shown; other errors are.
    #[tokio::test]
    async fn an_error_repeating_a_session_cookie_is_not_shown() {
        use axum::http::StatusCode;
        use axum::response::AppendHeaders;
        let app = axum::Router::new()
            .route("/api/set", axum::routing::get(|| async { AppendHeaders([("set-cookie", "hermes_session_at=at-0123456789abcdef; Path=/")]) }))
            .route(
                "/api/leak",
                axum::routing::get(|headers: axum::http::HeaderMap| async move {
                    (StatusCode::INTERNAL_SERVER_ERROR, format!("no session for {}", cookie_of(&headers)))
                }),
            )
            .route("/api/fail", axum::routing::get(|| async { (StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error") }));
        let dashboard = dashboard_at(&serve(app).await);
        dashboard.request("GET", "api/set", None).await.unwrap();
        match dashboard.request("GET", "api/leak", None).await {
            Err(TransportError::Unexpected { status: 500, body }) => assert_eq!(body, super::HIDDEN),
            other => panic!("{other:?}"),
        }
        match dashboard.request("GET", "api/fail", None).await {
            Err(TransportError::Unexpected { status: 500, body }) => assert_eq!(body, "Internal Server Error"),
            other => panic!("{other:?}"),
        }
    }

    /// An error page answering a request with a cookie it replaces or removes in the same answer still doesn't show
    /// the value that request sent.
    #[tokio::test]
    async fn an_error_repeating_a_cookie_it_replaces_is_not_shown() {
        use axum::http::StatusCode;
        use axum::response::AppendHeaders;
        let leak = |set: &'static str| {
            move |headers: axum::http::HeaderMap| async move {
                (StatusCode::INTERNAL_SERVER_ERROR, AppendHeaders([("set-cookie", set)]), format!("no session for {}", cookie_of(&headers)))
            }
        };
        let app = axum::Router::new()
            .route("/api/set", axum::routing::get(|| async { AppendHeaders([("set-cookie", "hermes_session_at=at-0123456789abcdef; Path=/")]) }))
            .route("/api/rotate", axum::routing::get(leak("hermes_session_at=at-fedcba9876543210; Path=/")))
            .route("/api/remove", axum::routing::get(leak("hermes_session_at=; Max-Age=0; Path=/")))
            .route("/api/expire", axum::routing::get(leak("hermes_session_at=at-0123456789abcdef; Max-Age=0; Path=/")))
            .route("/api/expired", axum::routing::get(leak("hermes_session_at=at-0123456789abcdef; Expires=Thu, 01 Jan 1970 00:00:00 GMT")));
        let url = serve(app).await;
        for path in ["api/rotate", "api/remove", "api/expire", "api/expired"] {
            let dashboard = dashboard_at(&url);
            dashboard.request("GET", "api/set", None).await.unwrap();
            match dashboard.request("GET", path, None).await {
                Err(TransportError::Unexpected { status: 500, body }) => assert_eq!(body, super::HIDDEN, "{path}"),
                other => panic!("{path}: {other:?}"),
            }
        }
    }

    /// A relayed answer is read up to the relay's 64 MiB: one announced past it is refused before any of it is read.
    #[tokio::test]
    async fn a_relayed_answer_announced_past_64_mib_is_refused_unread() {
        let relay_max: u64 = 64 * 1024 * 1024;
        let url = answers_then_waits(format!("HTTP/1.1 200 OK\r\ncontent-length: {}\r\n\r\n", relay_max + 1)).await;
        let limit = Duration::from_secs(2);
        let resp = unless_stalled(limit, reqwest::Client::new().get(url).send()).await.unwrap();
        match text_unless_stalled(resp, limit).await {
            Err(TransportError::AnswerTooLarge { size, max }) => assert_eq!((size, max), (relay_max + 1, relay_max)),
            other => panic!("{other:?}"),
        }
    }
}
