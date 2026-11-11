//! Settings → Providers' subscription sign-ins and custom endpoints (ADR 0133), on Hermes's routes at the deployed
//! `bf0203a` (`hermes_cli/web_routers/oauth.py` and `config_env.py`). Rust reads both lists so that the token and key
//! previews Hermes puts in them (`token_preview`, `api_key_preview`) never reach the window, whose own `GET` of either
//! list the REST relay refuses (ADR 0138), and saves an endpoint so
//! that its API key goes from the window to Hermes and nowhere else. Starting a sign-in, polling and cancelling it,
//! signing out, and activating or removing an endpoint carry nothing secret, so the window sends those through the
//! REST relay (`provider_account_write`).

use super::{client_kept_to_origin, endpoint, Dashboard, TransportError};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
use url::Url;

/// A subscription provider as `GET /api/providers/oauth` lists it, without its token preview.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSignIn {
    pub id: String,
    pub name: String,
    /// `device_code`: the app can drive the sign-in. `external`: it's done on the server's command line (`command`).
    pub flow: &'static str,
    pub signed_in: bool,
    /// Hermes can sign it out from here (`disconnectable`), and it is signed in.
    pub can_sign_out: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    /// Hermes's `disconnect_hint`: why it can't sign this one out from here, while it is signed in.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sign_out_hint: Option<String>,
}

/// An OpenAI-compatible endpoint as `GET /api/providers/custom-endpoints` lists it, without its key preview.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomEndpoint {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub model: String,
    pub has_key: bool,
    /// The profile's default model provider is this endpoint.
    pub current: bool,
}

/// The Add an endpoint form. `key`: blank for an endpoint that takes none, such as a local Ollama. No `Debug`, so the
/// key can't end up in a log.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointForm {
    pub name: String,
    pub base_url: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub key: Option<String>,
}

/// What became of `Dashboard::save_endpoint`. `CheckFailed`: Hermes's check didn't pass and nothing was saved; the
/// owner may save it anyway.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub enum EndpointSave {
    #[serde(rename_all = "camelCase")]
    Saved {
        id: String,
        checked: bool,
    },
    CheckFailed {
        message: String,
    },
}

/// How long checking and saving an endpoint may take, all requests together. Hermes's own probe of the endpoint gives
/// up after 8 seconds, twice.
const ENDPOINT_SAVE_LIMIT: Duration = Duration::from_secs(30);

/// `POST /api/providers/custom-endpoints/validate`'s answer.
#[derive(Deserialize)]
struct Checked {
    ok: bool,
    #[serde(default)]
    message: String,
    #[serde(default)]
    models: Vec<String>,
    /// The base that served the models: Hermes tries the address typed and its `/v1` twin, and the runtime appends
    /// `/chat/completions` to the one saved.
    #[serde(default)]
    resolved_base_url: Option<String>,
}

/// A provider id as Hermes's catalog spells it: `nous`, `openai-codex`, `xai-oauth`.
pub(super) fn provider_slug(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}

/// An endpoint id as the window sends it in a path: one segment, percent-encoded. Hermes's ids keep dots and colons
/// from the name (`local-127.0.0.1:8283`).
pub(super) fn endpoint_segment(id: &str) -> bool {
    (1..=256).contains(&id.len()) && id != "." && id != ".." && !id.contains(['/', '\\', '?', '#']) && !id.chars().any(char::is_control)
}

fn sign_in_of(p: &Value) -> Option<ProviderSignIn> {
    let id = p["id"].as_str().filter(|id| provider_slug(id))?;
    let text = |v: &Value| v.as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned);
    let device_code = p["flow"] == "device_code";
    let signed_in = p["status"]["logged_in"] == json!(true);
    let disconnectable = p["disconnectable"] == json!(true);
    Some(ProviderSignIn {
        id: id.to_owned(),
        name: text(&p["name"]).unwrap_or_else(|| id.to_owned()),
        flow: if device_code { "device_code" } else { "external" },
        signed_in,
        can_sign_out: signed_in && disconnectable,
        command: if device_code { None } else { text(&p["cli_command"]) },
        expires_at: text(&p["status"]["expires_at"]),
        sign_out_hint: if signed_in && !disconnectable { text(&p["disconnect_hint"]) } else { None },
    })
}

fn endpoint_of(e: &Value) -> Option<CustomEndpoint> {
    // The main model's own `base_url` shows as a `direct-config` row, which Hermes can't activate or remove.
    if e["source"] == "direct-config" {
        return None;
    }
    let id = e["id"].as_str().filter(|id| !id.is_empty())?;
    let text = |v: &Value| v.as_str().unwrap_or_default().to_owned();
    Some(CustomEndpoint {
        id: id.to_owned(),
        name: e["name"].as_str().filter(|n| !n.is_empty()).unwrap_or(id).to_owned(),
        base_url: text(&e["base_url"]),
        model: text(&e["model"]),
        has_key: e["has_api_key"] == json!(true),
        current: e["is_current"] == json!(true),
    })
}

/// The form, trimmed, or what is wrong with it. The rules are the window's (`endpointFormProblem` in accounts.ts),
/// checked again here since the window isn't trusted.
fn checked_form(form: &EndpointForm) -> Result<(String, Url, String, Option<String>), TransportError> {
    let bad = |why: &str| Err(TransportError::Endpoint(why.into()));
    let line = |s: &str, max: usize| s.len() <= max && !s.chars().any(char::is_control);
    let name = form.name.trim();
    if name.is_empty() || !line(name, 64) {
        return bad("Give the endpoint a name of up to 64 characters.");
    }
    let base = form.base_url.trim();
    let url = Url::parse(base).ok().filter(|u| matches!(u.scheme(), "http" | "https") && u.host_str().is_some_and(|h| !h.is_empty()));
    let Some(url) = url.filter(|_| line(base, 2048)) else {
        return bad("Enter the endpoint's address, starting with http:// or https://, such as http://localhost:11434/v1.");
    };
    let model = form.model.trim();
    if !line(model, 256) {
        return bad("The model name is too long.");
    }
    let key = form.key.as_deref().map(str::trim).filter(|k| !k.is_empty());
    if key.is_some_and(|k| !line(k, 4096) || k.contains(' ')) {
        return bad("Paste the API key on one line, without spaces.");
    }
    Ok((name.to_owned(), url, model.to_owned(), key.map(str::to_owned)))
}

impl Dashboard {
    /// `url` under the dashboard with `?profile=`.
    fn for_profile(&self, path: &str, profile: &str) -> Url {
        let mut url = endpoint(&self.base, path);
        url.query_pairs_mut().append_pair("profile", profile);
        url
    }

    async fn read_json(&self, url: Url) -> Result<Value, TransportError> {
        let http = client_kept_to_origin(&self.headers, true)?;
        let text = self.call(&http, Method::GET, url, None, true).await?;
        serde_json::from_str(&text).map_err(|e| TransportError::Unexpected { status: 200, body: format!("not JSON: {e}") })
    }

    /// The profile's subscription providers and whether each is signed in (`GET /api/providers/oauth?profile=`).
    pub async fn provider_sign_ins(&self, profile: &str) -> Result<Vec<ProviderSignIn>, TransportError> {
        let v = self.read_json(self.for_profile("api/providers/oauth", profile)).await?;
        Ok(v["providers"].as_array().map(|ps| ps.iter().filter_map(sign_in_of).collect()).unwrap_or_default())
    }

    /// The profile's OpenAI-compatible endpoints (`GET /api/providers/custom-endpoints?profile=`).
    pub async fn custom_endpoints(&self, profile: &str) -> Result<Vec<CustomEndpoint>, TransportError> {
        let v = self.read_json(self.for_profile("api/providers/custom-endpoints", profile)).await?;
        Ok(v["endpoints"].as_array().map(|es| es.iter().filter_map(endpoint_of).collect()).unwrap_or_default())
    }

    /// Adds an OpenAI-compatible endpoint to the profile, the way the dashboard's own panel does:
    ///
    /// 1. `POST /api/providers/custom-endpoints/validate` has Hermes ask the endpoint for its models. If that doesn't
    ///    pass, nothing is saved and Hermes's reason comes back, unless `anyway`.
    /// 2. `POST /api/providers/custom-endpoints?profile=` saves it with the models found. A blank model takes the first.
    ///    Hermes keeps the key in the profile's `.env` and names it from `config.yaml`.
    ///
    /// The key never comes back in an error, as for `save_provider_key`.
    pub async fn save_endpoint(&self, profile: &str, form: &EndpointForm, anyway: bool) -> Result<EndpointSave, TransportError> {
        self.save_endpoint_within(profile, form, anyway, ENDPOINT_SAVE_LIMIT).await
    }

    /// `save_endpoint`, giving up after `limit`.
    pub async fn save_endpoint_within(&self, profile: &str, form: &EndpointForm, anyway: bool, limit: Duration) -> Result<EndpointSave, TransportError> {
        tokio::time::timeout(limit, self.check_and_save_endpoint(profile, form, anyway)).await.unwrap_or(Err(TransportError::EndpointTimedOut(limit.as_secs())))
    }

    async fn check_and_save_endpoint(&self, profile: &str, form: &EndpointForm, anyway: bool) -> Result<EndpointSave, TransportError> {
        let (name, url, model, key) = checked_form(form)?;
        let base_url = url.as_str().trim_end_matches('/').to_owned();
        let http = client_kept_to_origin(&self.headers, true)?;
        // With a key in the body, a failed answer isn't shown: FastAPI's 422 repeats the body.
        let show_failure = key.is_none();
        let scrub = |s: &str| match &key {
            Some(k) => s.replace(k.as_str(), "(the key)"),
            None => s.to_owned(),
        };

        // A blank key is sent blank: Hermes clears the key an endpoint of that name had, rather than keeping it for
        // the new address.
        let mut body = json!({"name": name, "base_url": base_url, "model": model, "api_key": key.as_deref().unwrap_or("")});
        let answer =
            self.call(&http, Method::POST, endpoint(&self.base, "api/providers/custom-endpoints/validate"), Some(body.to_string()), show_failure).await?;
        let checked: Checked = serde_json::from_str(&answer).map_err(|_| TransportError::Unexpected {
            status: 200,
            body: "Hermes's answer to the endpoint check wasn't understood (not shown, as it may hold the key).".into(),
        })?;
        if !checked.ok && !anyway {
            let message = scrub(checked.message.trim());
            let message = if message.is_empty() { "Hermes couldn't check the endpoint, and didn't say why.".to_owned() } else { message };
            return Ok(EndpointSave::CheckFailed { message });
        }
        let model = if model.is_empty() { checked.models.first().cloned().unwrap_or_default() } else { model };
        if model.is_empty() {
            return Err(TransportError::Endpoint("Enter the model's name: Hermes found no models at that address.".into()));
        }
        body["model"] = json!(model);
        let resolved = checked.resolved_base_url.as_deref().and_then(|r| Url::parse(r).ok()).filter(|r| r.origin() == url.origin());
        if let Some(r) = resolved {
            body["base_url"] = json!(r.as_str().trim_end_matches('/'));
        }
        if !checked.models.is_empty() {
            body["models"] = json!(checked.models);
        }
        let saved = self.call(&http, Method::POST, self.for_profile("api/providers/custom-endpoints", profile), Some(body.to_string()), show_failure).await?;
        let id = serde_json::from_str::<Value>(&saved).ok().and_then(|v| v["id"].as_str().map(str::to_owned)).unwrap_or_default();
        Ok(EndpointSave::Saved { id, checked: checked.ok })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sign_in_row_drops_the_token_preview() {
        let row = json!({
            "id": "nous", "name": "Nous Portal", "flow": "device_code", "cli_command": "hermes auth add nous",
            "disconnectable": true, "disconnect_hint": null,
            "status": {"logged_in": true, "token_preview": "abcd1234", "expires_at": "2026-12-01T00:00:00+00:00"},
        });
        let s = sign_in_of(&row).unwrap();
        assert_eq!(
            s,
            ProviderSignIn {
                id: "nous".into(),
                name: "Nous Portal".into(),
                flow: "device_code",
                signed_in: true,
                can_sign_out: true,
                command: None,
                expires_at: Some("2026-12-01T00:00:00+00:00".into()),
                sign_out_hint: None,
            }
        );
        assert!(!serde_json::to_string(&s).unwrap().contains("abcd1234"));
    }

    #[test]
    fn an_external_provider_keeps_its_command_and_hint() {
        let row = json!({
            "id": "anthropic", "name": "Anthropic Account", "flow": "external", "cli_command": "hermes auth add anthropic",
            "disconnectable": false, "disconnect_hint": "Remove the API key from Settings → Keys instead.", "status": {"logged_in": true},
        });
        let s = sign_in_of(&row).unwrap();
        assert_eq!((s.flow, s.can_sign_out), ("external", false));
        assert_eq!(s.command.as_deref(), Some("hermes auth add anthropic"));
        assert_eq!(s.sign_out_hint.as_deref(), Some("Remove the API key from Settings → Keys instead."));
        assert!(sign_in_of(&json!({"id": "../x", "flow": "device_code"})).is_none());
    }

    #[test]
    fn an_endpoint_row_drops_the_key_preview_and_the_main_models_own_row() {
        let row = json!({"id": "ollama", "name": "Ollama", "base_url": "http://localhost:11434/v1", "model": "qwen3", "has_api_key": true,
            "api_key_preview": "«redacted:sk-o...abcd»", "is_current": true, "source": "providers"});
        let e = endpoint_of(&row).unwrap();
        assert!(e.has_key && e.current);
        assert!(!serde_json::to_string(&e).unwrap().contains("redacted"));
        assert!(endpoint_of(&json!({"id": "custom", "base_url": "http://x/v1", "source": "direct-config"})).is_none());
    }

    #[test]
    fn the_form_is_checked_before_anything_is_sent() {
        let form = |name: &str, base: &str, key: Option<&str>| EndpointForm {
            name: name.into(),
            base_url: base.into(),
            model: String::new(),
            key: key.map(Into::into),
        };
        assert!(checked_form(&form("Ollama", "http://localhost:11434/v1", None)).is_ok());
        assert!(checked_form(&form("Groq", "https://api.groq.com/openai/v1", Some(" gsk_abc "))).is_ok_and(|f| f.3.as_deref() == Some("gsk_abc")));
        for (name, base, key) in [
            ("", "http://x/v1", None),
            ("A", "localhost:11434", None),
            ("A", "ftp://x/v1", None),
            ("A", "http://x/v1", Some("a b")),
            ("A\nB", "http://x/v1", None),
        ] {
            assert!(matches!(checked_form(&form(name, base, key)), Err(TransportError::Endpoint(_))), "{name:?} {base:?} {key:?}");
        }
    }

    #[test]
    fn segments_the_relay_takes() {
        assert!(provider_slug("openai-codex") && !provider_slug("Nous") && !provider_slug("a/b") && !provider_slug(""));
        assert!(endpoint_segment("local-127.0.0.1%3A8283") && !endpoint_segment("..") && !endpoint_segment("a/b") && !endpoint_segment(""));
    }
}
