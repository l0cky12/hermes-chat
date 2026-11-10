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
use tokio::sync::mpsc;
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
    let mut http = reqwest::Client::builder().default_headers(headers.clone());
    if always || !headers.is_empty() {
        http = http.redirect(redirect::Policy::custom(same_origin_redirects));
    }
    http.build().map_err(unreachable)
}

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
        Some(t) if !(refused && !headers.is_empty()) && !repeats_header(t, headers) => t.chars().take(800).collect(),
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
        return resp.text().await.map_err(unreachable);
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
            resp.text().await.ok()
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

fn read_file_prefix(file: &std::fs::File, max: u64) -> Result<Vec<u8>, TransportError> {
    let mut bytes = vec![0; max as usize];
    let mut len = 0;
    // Positional reads keep concurrent reloads from sharing or advancing the retained handle's offset.
    while len < bytes.len() {
        match local_fs::read_at(file, &mut bytes[len..], len as u64) {
            Ok(0) => break,
            Ok(n) => len += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(TransportError::File(e.to_string())),
        }
    }
    bytes.truncate(len);
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
        self.0.lock().unwrap().insert(path.clone(), std::sync::Arc::new(file));
        Ok(path)
    }

    fn file(&self, path: &str) -> Result<std::sync::Arc<std::fs::File>, TransportError> {
        self.0.lock().unwrap().get(path).cloned().ok_or_else(|| TransportError::File("it wasn't picked in the Open dialog".into()))
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
        *self.paths.lock().unwrap() = kept;
        *self.file.lock().unwrap() = Some(file);
    }

    pub fn add(&self, paths: impl IntoIterator<Item = String>) {
        let mut kept = self.paths.lock().unwrap();
        for path in paths {
            kept.retain(|p| *p != path);
            kept.push(path);
        }
        let over = kept.len().saturating_sub(ATTACHABLE_KEPT);
        kept.drain(..over);
        if let Some(file) = &*self.file.lock().unwrap() {
            if let Err(e) = write_json(file, &*kept) {
                eprintln!("hermes-chat: couldn't keep the attached files' paths, so they can't be sent after a restart: {e}");
            }
        }
    }

    pub fn check(&self, path: &str) -> Result<(), TransportError> {
        if self.paths.lock().unwrap().iter().any(|p| p == path) {
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

/// Writes a file pasted into the composer to a new temp file and returns its path, so it attaches like a dropped
/// one: a pasted screenshot has no file of its own. Each paste gets its own folder under `<temp>/hermes-chat`, so
/// the same name pasted twice stays two files. `name` is cut down to a safe basename. Nothing removes these files.
pub fn stage_clipboard_file(name: &str, bytes: &[u8]) -> Result<std::path::PathBuf, TransportError> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static PASTES: AtomicU64 = AtomicU64::new(0);
    let io = |e: std::io::Error| TransportError::File(format!("couldn't save the pasted file: {e}"));

    // Pastes can be private: only this user's folders, and not one someone else made (or linked) in a shared /tmp.
    let root = std::env::temp_dir().join("hermes-chat");
    local_fs::private_dir_builder().recursive(true).create(&root).map_err(io)?;
    let meta = std::fs::symlink_metadata(&root).map_err(io)?;
    if !meta.is_dir() || !local_fs::only_mine(&meta).map_err(io)? {
        return Err(TransportError::File(format!("couldn't save the pasted file: {} isn't private", root.display())));
    }
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    let dir = root.join(format!("{nanos}-{}-{}", std::process::id(), PASTES.fetch_add(1, Ordering::Relaxed)));
    local_fs::private_dir_builder().create(&dir).map_err(io)?;
    let path = dir.join(safe_name(name));
    std::fs::write(&path, bytes).map_err(io)?;
    Ok(path)
}

/// How a local file is opened for the preview, and a private folder made, on this platform.
#[cfg(unix)]
mod local_fs {
    use std::fs::{DirBuilder, File, Metadata};
    use std::os::unix::fs::{DirBuilderExt, FileExt, MetadataExt, OpenOptionsExt, PermissionsExt};
    use std::path::Path;

    pub fn open_no_follow(path: &Path) -> std::io::Result<File> {
        std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK).open(path)
    }

    pub fn read_at(file: &File, buf: &mut [u8], at: u64) -> std::io::Result<usize> {
        file.read_at(buf, at)
    }

    pub fn private_dir_builder() -> DirBuilder {
        let mut b = DirBuilder::new();
        b.mode(0o700);
        b
    }

    /// Ownership matters, not just the mode: another user's folder could be opened up again after this check.
    pub fn only_mine(meta: &Metadata) -> std::io::Result<bool> {
        let me = std::fs::metadata("/proc/self")?.uid();
        Ok(meta.uid() == me && meta.permissions().mode() & 0o077 == 0)
    }
}

/// Windows has no FIFOs in folders and no Unix modes. A link is opened as itself (so it isn't a regular file and is
/// refused), and the temp folder is the user's own (`%LOCALAPPDATA%\Temp`), which only they (and administrators) can
/// open, so a folder made in it is private already.
#[cfg(windows)]
mod local_fs {
    use std::fs::{DirBuilder, File, Metadata};
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

    pub fn private_dir_builder() -> DirBuilder {
        DirBuilder::new()
    }

    pub fn only_mine(meta: &Metadata) -> std::io::Result<bool> {
        Ok(!meta.file_type().is_symlink())
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
    file.take(max_bytes + 1).read_to_end(&mut bytes).await.map_err(|e| TransportError::File(e.to_string()))?;
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

/// An open `/api/ws` connection. Dropping it closes the socket.
pub struct Pipe {
    outgoing: mpsc::UnboundedSender<String>,
    task: JoinHandle<()>,
}

impl Pipe {
    pub fn send(&self, text: String) -> Result<(), TransportError> {
        self.outgoing.send(text).map_err(|_| TransportError::Closed)
    }

    /// Send one frame: `head`, the file at `path` as base64, then `tail`. Refuses a file over
    /// `max_bytes` without sending anything; the size is checked again after reading, in case it grew.
    pub async fn send_file(&self, head: &str, path: &str, tail: &str, max_bytes: u64) -> Result<(), TransportError> {
        let bytes = read_capped(path, max_bytes).await?;
        let mut frame = String::with_capacity(head.len() + bytes.len().div_ceil(3) * 4 + tail.len());
        frame.push_str(head);
        base64::engine::general_purpose::STANDARD.encode_string(&bytes, &mut frame);
        frame.push_str(tail);
        self.send(frame)
    }
}

impl Drop for Pipe {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// A signed-in dashboard session. It keeps the session cookies up to date: the dashboard rotates an
/// expired access token through the refresh cookie on any request and sends the new ones back. A token sign-in has
/// no cookies: its `Authorization` header goes with every request instead (ADR 0058).
pub struct Dashboard {
    http: reqwest::Client,
    base: Url,
    cookies: Mutex<Vec<(String, String)>>,
    /// The owner's extra request headers, and a token sign-in's `Authorization`; `http` sends them all itself, the
    /// WebSocket handshake adds the extra headers.
    headers: HeaderMap,
    /// What an error or close reason mustn't repeat to be shown: `headers`, and a token on its own, however short.
    /// Never sent.
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
                    _ => return Err(unexpected_sent(login, &sign_in.headers, password).await),
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
                let me: serde_json::Value = me.json().await.map_err(unreachable)?;
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
        let connecting = async { tokio_tungstenite::connect_async(handshake).await.map_err(|e| TransportError::WebSocket(e.to_string())) };
        let (ws, _) = steps
            .run(Step::WebSocket, within(limits.map(|l| l.socket), connecting, |s| TransportError::WebSocket(format!("it didn't open within {s}s."))))
            .await?;

        let (outgoing, mut to_server) = mpsc::unbounded_channel::<String>();
        let headers = self.hide.clone();
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
                            break frame.map_or("closed by the server".into(), |f| {
                                // A gateway in front of the dashboard may close with the header values it turned down.
                                let why = if repeats_header(&f.reason, &headers) { HIDDEN } else { f.reason.as_str() };
                                format!("closed by the server ({} {why})", f.code)
                            });
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

    /// A single-use ticket for `/api/ws`.
    async fn ws_ticket(&self) -> Result<String, TransportError> {
        let ticket = self.signed(Method::POST, endpoint(&self.base, "api/auth/ws-ticket")).send().await.map_err(unreachable)?;
        self.keep_cookies(&ticket);
        if !ticket.status().is_success() {
            return Err(unexpected(ticket, &self.hide).await);
        }
        let ticket: serde_json::Value = ticket.json().await.map_err(unreachable)?;
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
        let list = method == Method::GET && is_session_list(&routed);
        // Hermes answers removing an endpoint with the endpoints left, each with its key's preview (ADR 0133).
        let answer_unread = method == Method::DELETE && routed.starts_with("api/providers/custom-endpoints/");
        let mut req = self.signed(method, url);
        if let Some(body) = body {
            req = req.header(header::CONTENT_TYPE, "application/json").body(body);
        }
        let resp = if list { unless_stalled(READ_STALL, req.send()).await? } else { req.send().await.map_err(unreachable)? };
        self.keep_cookies(&resp);
        match resp.status() {
            s if s.is_success() && list => text_unless_stalled(resp, READ_STALL).await,
            s if s.is_success() && answer_unread => Ok(r#"{"ok":true}"#.to_owned()),
            s if s.is_success() => resp.text().await.map_err(unreachable),
            StatusCode::UNAUTHORIZED => Err(TransportError::SignedOut),
            _ => Err(unexpected(resp, &self.hide).await),
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
        let transcribe = has(self.post_audio("api/audio/transcribe", profile, &json!({"data_url": ""})).await?);
        let speak = has(self.post_audio("api/audio/speak", profile, &json!({"text": ""})).await?);
        let query = url::form_urlencoded::Serializer::new(String::new()).append_pair("profile", profile).finish();
        let config: Option<serde_json::Value> = match self.request("GET", &format!("api/config?{query}"), None).await {
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
        let resp = self.signed(Method::POST, url).json(body).send().await.map_err(unreachable)?;
        self.keep_cookies(&resp);
        let status = resp.status();
        if status == StatusCode::UNAUTHORIZED {
            return Err(TransportError::SignedOut);
        }
        if status.is_redirection() {
            return Err(unexpected(resp, &self.hide).await);
        }
        let text = resp.text().await.map_err(unreachable)?;
        if status.is_success() {
            return serde_json::from_str(&text)
                .map(AudioAnswer::Done)
                .map_err(|_| TransportError::Unexpected { status: status.as_u16(), body: shown_body(status, &text, &self.hide) });
        }
        let reason = refusal_reason(status, &text, &self.hide);
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
    /// `api/files/read`. It stops reading, and refuses the answer, once it passes `max_bytes`, so a file that grew
    /// since it was listed can't fill memory. Returns the response body on 2xx.
    pub async fn get_limited(&self, path_and_query: &str, max_bytes: u64) -> Result<String, TransportError> {
        let (path, query) = path_and_query.split_once('?').unwrap_or((path_and_query, ""));
        let (url, _) = relay_url(&self.base, path, query)?;
        let mut resp = self.signed(Method::GET, url).send().await.map_err(unreachable)?;
        self.keep_cookies(&resp);
        match resp.status() {
            s if s.is_success() => {}
            StatusCode::UNAUTHORIZED => return Err(TransportError::SignedOut),
            _ => return Err(unexpected(resp, &self.hide).await),
        }
        let too_large = |size| TransportError::FileTooLarge { size, max: max_bytes };
        if let Some(size) = resp.content_length().filter(|&n| n > max_bytes) {
            return Err(too_large(size));
        }
        let mut body = Vec::new();
        while let Some(chunk) = resp.chunk().await.map_err(unreachable)? {
            body.extend_from_slice(&chunk);
            if body.len() as u64 > max_bytes {
                return Err(too_large(body.len() as u64));
            }
        }
        String::from_utf8(body).map_err(|_| TransportError::Unexpected { status: 200, body: "the answer isn't UTF-8 text".into() })
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
            _ => return Err(unexpected(resp, &self.hide).await),
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
            s if s.is_success() => resp.text().await.map_err(unreachable),
            StatusCode::UNAUTHORIZED => Err(TransportError::SignedOut),
            _ => Err(unexpected(resp, &self.hide).await),
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
        let resp = self.signed(Method::POST, url).json(&body).send().await.map_err(unreachable)?;
        self.keep_cookies(&resp);
        match resp.status() {
            s if s.is_success() => resp.text().await.map_err(unreachable),
            StatusCode::UNAUTHORIZED => Err(TransportError::SignedOut),
            _ => Err(unexpected(resp, &self.hide).await),
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
        let jar = self.cookies.lock().unwrap();
        jar.iter().map(|(n, v)| format!("{n}={v}")).collect::<Vec<_>>().join("; ")
    }
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
    let name = path.rsplit('/').next().unwrap_or_default().to_lowercase();
    name == ".env"
        || name.starts_with(".env.")
        || name == ".envrc"
        || NAMES.contains(&name.as_str())
        || path.split('/').any(|part| matches!(part.to_lowercase().as_str(), "mcp-tokens" | "pairing"))
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
    let under_api = |p: &str| p.starts_with("api/") && !p.split('/').any(|seg| seg == ".." || seg == ".");
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

/// An error body as it may be shown, for a request that carried `headers`: its extra request headers, and a token it
/// sent. With none, its start as sent. Otherwise only the dashboard's own JSON `detail`, whole and repeating none of
/// their values: a refusal (401, 403, 407) or any other page could come from a gateway in front, which can echo a value
/// it turned down.
fn shown_body(status: StatusCode, text: &str, headers: &HeaderMap) -> String {
    if headers.is_empty() {
        return text.chars().take(300).collect();
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
    unexpected_sent(resp, headers, "").await
}

/// `unexpected` for a request whose body carried `secret`, such as a password: an error that repeats it anywhere, as
/// sent or JSON-escaped, is shown as `HIDDEN`. Unlike extra request headers, it doesn't limit what else is shown.
async fn unexpected_sent(mut resp: reqwest::Response, headers: &HeaderMap, secret: &str) -> TransportError {
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
        match resp.chunk().await {
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
            if let Some(tx) = tx.lock().unwrap().take() {
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

/// How long the chat list's read waits for the next bytes of Hermes's answer, its head first and then each part of its
/// body. The clock restarts with every part, so a page that keeps arriving is never cut off, however slow the link.
/// Hermes answers the list from its session store, a read-only query of at most 100 rows that waits at most 5 s on a
/// lock, so a minute with nothing means the read has stalled. Other routes have no such limit: some stay silent for
/// minutes and still answer, such as files on an SSH profile, the update check, or a read behind a memory provider's
/// setup.
const READ_STALL: Duration = Duration::from_secs(60);

/// The chat list's read, `api/sessions` itself. Empty segments are skipped, as `is_file_route` does.
fn is_session_list(path: &str) -> bool {
    let mut segs = path.split('/').filter(|seg| !seg.is_empty());
    segs.next() == Some("api") && segs.next() == Some("sessions") && segs.next().is_none()
}

/// One step of a read, given up after `limit` without an answer.
async fn unless_stalled<T>(limit: Duration, step: impl std::future::Future<Output = reqwest::Result<T>>) -> Result<T, TransportError> {
    tokio::time::timeout(limit, step).await.map_err(|_| TransportError::Stalled(limit.as_secs()))?.map_err(unreachable)
}

/// `resp`'s body as text, given up once `limit` passes without a part of it.
async fn text_unless_stalled(mut resp: reqwest::Response, limit: Duration) -> Result<String, TransportError> {
    let mut body = Vec::new();
    while let Some(part) = unless_stalled(limit, resp.chunk()).await? {
        body.extend_from_slice(&part);
    }
    Ok(String::from_utf8_lossy(&body).into_owned())
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
        let resp = req.send().await.map_err(unreachable)?;
        self.keep_cookies(&resp);
        match resp.status() {
            s if s.is_success() => resp.text().await.map_err(unreachable),
            StatusCode::UNAUTHORIZED => Err(TransportError::SignedOut),
            _ if show_failure => Err(unexpected(resp, &self.hide).await),
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
        let resp = http
            .put(url)
            .header(header::COOKIE, self.cookie_header())
            .header(header::CONTENT_TYPE, "application/json")
            .body(body)
            .send()
            .await
            .map_err(unreachable)?;
        self.keep_cookies(&resp);
        match resp.status() {
            s if s.is_success() => Ok(()),
            StatusCode::UNAUTHORIZED => Err(TransportError::SignedOut),
            s => {
                let answer = resp.text().await.unwrap_or_default();
                // Neither a secret the map held nor a value of the owner's extra request headers is shown.
                let body = shown_body(s, &crate::mcp::scrubbed(&answer, &edited.secrets), &self.hide);
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
        agent_text_body, memory_entry_edit_allowed, memory_provider_write, profile_create_allowed, provider_key_name, skill_create_allowed, text_unless_stalled,
        unless_stalled, webhook_write, TransportError,
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

    /// A server that answers one request with `parts` chunks, `gap` apart in real time, then ends the body if `end`.
    async fn trickle(parts: usize, gap: std::time::Duration, end: bool) -> String {
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
            if end {
                sock.write_all(b"0\r\n\r\n").await.unwrap();
            }
            std::future::pending::<()>().await;
        });
        url
    }

    #[tokio::test]
    async fn a_read_that_keeps_arriving_finishes_however_long_it_takes_in_all() {
        let url = trickle(10, Duration::from_millis(150), true).await;
        let limit = Duration::from_secs(1);
        let started = std::time::Instant::now();
        let resp = unless_stalled(limit, reqwest::get(url)).await.unwrap();
        let text = text_unless_stalled(resp, limit).await.unwrap();
        assert_eq!(text, (0..10).map(|i| format!("part{i};")).collect::<String>());
        assert!(started.elapsed() > limit, "the whole read took {:?}, longer than the limit", started.elapsed());
    }

    #[tokio::test]
    async fn a_read_that_stops_arriving_is_given_up_once_the_limit_passes_without_a_byte() {
        let url = trickle(2, Duration::from_millis(50), false).await;
        let limit = Duration::from_millis(500);
        let started = std::time::Instant::now();
        let resp = unless_stalled(limit, reqwest::get(url)).await.unwrap();
        let err = text_unless_stalled(resp, limit).await.unwrap_err();
        assert!(matches!(err, TransportError::Stalled(_)), "{err:?}");
        assert!(started.elapsed() >= limit + Duration::from_millis(50), "{:?}", started.elapsed());
    }
}
