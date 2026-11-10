//! Settings → MCP servers (ADR 0121), on Hermes's `/api/mcp` routes (`hermes_cli/web_routers/mcp.py` at the deployed
//! `f0d94882`). Two things live here, both pure so they can be tested without a server:
//!
//! - `relayed`: which MCP writes the webview's relay passes (`Dashboard::request`), each with the exact body shape
//!   Hermes's model takes. Reads (`GET`) and `DELETE` were already relayed for any `api/` path.
//! - `edited`: one server's edit, made into the whole `mcp_servers` map Hermes's only edit route takes (`PUT
//!   /api/mcp/servers`, `MCPServersReplace`). Rust reads the profile's raw config, changes that one entry and writes
//!   the map back (`Dashboard::mcp_edit`), so the webview never sends a map and never reads a stored secret: env values
//!   and the bearer token are write-only on the screen, and a blank one keeps what Hermes has.

use serde::Deserialize;
use serde_json::{Map, Value};
use url::Url;

/// The server names this app adds, edits and names in a path: an ASCII letter or digit, then up to 63 more of those,
/// `_`, `-` or `.`. Hermes itself takes any name; a server named otherwise is listed but not changed from here.
pub fn server_name(n: &str) -> bool {
    let mut b = n.bytes();
    n.len() <= 64 && matches!(b.next(), Some(c) if c.is_ascii_alphanumeric()) && b.all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-' | b'.'))
}

/// An environment variable's name: a letter or `_`, then letters, digits or `_`, at most 128.
fn env_name(k: &str) -> bool {
    let mut b = k.bytes();
    k.len() <= 128 && matches!(b.next(), Some(c) if c.is_ascii_alphabetic() || c == b'_') && b.all(|c| c.is_ascii_alphanumeric() || c == b'_')
}

/// Text on one line, not blank, at most `max` bytes.
fn one_line(s: &str, max: usize) -> bool {
    !s.trim().is_empty() && s.len() <= max && !s.chars().any(char::is_control)
}

/// An argument: anything but a NUL, which no process can be given, at most 8 KiB.
fn arg_ok(s: &str) -> bool {
    s.len() <= 8192 && !s.contains('\0')
}

/// An env value: may be empty, no line break or other control character but a tab, at most 8 KiB.
fn env_value_ok(s: &str) -> bool {
    s.len() <= 8192 && !s.chars().any(|c| c.is_control() && c != '\t')
}

const MAX_ARGS: usize = 64;
const MAX_ENV: usize = 64;

/// An HTTP or SSE server's address: `http://` or `https://` with a host, on one line.
fn http_url(u: &str) -> bool {
    one_line(u, 2048) && !u.contains(' ') && Url::parse(u).is_ok_and(|p| matches!(p.scheme(), "http" | "https") && p.host().is_some())
}

fn object(body: Option<&str>) -> Option<Map<String, Value>> {
    match serde_json::from_str::<Value>(body?).ok()? {
        Value::Object(o) => Some(o),
        _ => None,
    }
}

fn strings(v: Option<&Value>, max: usize, ok: impl Fn(&str) -> bool) -> bool {
    match v {
        None => true,
        Some(Value::Array(a)) => a.len() <= max && a.iter().all(|s| s.as_str().is_some_and(&ok)),
        _ => false,
    }
}

fn env_map(v: Option<&Value>, nonempty_values: bool) -> bool {
    match v {
        None => true,
        Some(Value::Object(o)) => {
            o.len() <= MAX_ENV
                && o.iter().all(|(k, v)| env_name(k) && v.as_str().is_some_and(|s| env_value_ok(s) && (!nonempty_values || !s.trim().is_empty())))
        }
        _ => false,
    }
}

/// A bearer token as typed: one line, not just the word "Bearer".
fn token_ok(t: &str) -> bool {
    let t = strip_bearer(t);
    one_line(t, 8192) && !t.eq_ignore_ascii_case("bearer")
}

/// Hermes's `_strip_bearer_prefix`: a token pasted with its own `Bearer ` loses it.
fn strip_bearer(t: &str) -> &str {
    let t = t.trim();
    match t.get(..7) {
        Some(p) if p.eq_ignore_ascii_case("bearer ") => t[7..].trim(),
        _ => t,
    }
}

/// `POST api/mcp/servers` (`MCPServerCreate`, checked again by `_normalize_mcp_server_create`): a name, and exactly
/// one of a `command` (stdio, with optional `args` and `env`, no auth) or a `url` (HTTP/SSE, with `auth` none, header
/// or oauth, and a `bearer_token` only for header auth). No `profile` in the body: it goes in the query.
pub fn create_allowed(body: Option<&str>) -> bool {
    let Some(f) = object(body) else { return false };
    if !f.keys().all(|k| matches!(k.as_str(), "name" | "url" | "command" | "args" | "env" | "auth" | "bearer_token")) {
        return false;
    }
    if !f.get("name").and_then(Value::as_str).is_some_and(server_name) {
        return false;
    }
    let auth = f.get("auth").map(|a| a.as_str());
    match (f.get("url").map(Value::as_str), f.get("command").map(Value::as_str)) {
        (Some(Some(url)), None) => {
            let token = f.get("bearer_token").map(Value::as_str);
            http_url(url)
                && !f.contains_key("args")
                && !f.contains_key("env")
                && match auth {
                    None | Some(Some("none" | "oauth")) => token.is_none(),
                    Some(Some("header")) => matches!(token, Some(Some(t)) if token_ok(t)),
                    _ => false,
                }
        }
        (None, Some(Some(command))) => {
            one_line(command, 4096)
                && strings(f.get("args"), MAX_ARGS, arg_ok)
                && env_map(f.get("env"), false)
                && matches!(auth, None | Some(Some("none")))
                && !f.contains_key("bearer_token")
        }
        _ => false,
    }
}

/// `POST api/mcp/catalog/install` (`MCPCatalogInstall`): exactly a catalog entry's `name`, the `env` values it asks for
/// (Hermes refuses any it doesn't declare) and `enable`. A blank value isn't sent.
fn install_allowed(body: Option<&str>) -> bool {
    let Some(f) = object(body) else { return false };
    f.keys().all(|k| matches!(k.as_str(), "name" | "env" | "enable"))
        && f.get("name").and_then(Value::as_str).is_some_and(server_name)
        && env_map(f.get("env"), true)
        && f.get("enable").is_none_or(Value::is_boolean)
}

/// Whether the relay passes this MCP write from the webview:
///
/// - `POST api/mcp/servers`, adding one server (`create_allowed`).
/// - `PUT api/mcp/servers/{name}/enabled` with exactly `{"enabled": true|false}`.
/// - `POST api/mcp/servers/{name}/test` and `…/auth`, with no body.
/// - `POST api/mcp/catalog/install` (`install_allowed`).
///
/// `{name}` is one segment as `server_name` allows, so it needs no escaping. Not `PUT api/mcp/servers`, the whole-map
/// replace: only `Dashboard::mcp_edit` sends it, built here from one server's edit.
pub fn relayed(method: &str, path: &str, body: Option<&str>) -> bool {
    match (method, path) {
        ("POST", "api/mcp/servers") => return create_allowed(body),
        ("POST", "api/mcp/catalog/install") => return install_allowed(body),
        _ => {}
    }
    let Some((name, action)) = path.strip_prefix("api/mcp/servers/").and_then(|r| r.split_once('/')) else {
        return false;
    };
    if !server_name(name) {
        return false;
    }
    match (method, action) {
        ("PUT", "enabled") => object(body).is_some_and(|f| f.len() == 1 && f.get("enabled").is_some_and(Value::is_boolean)),
        ("POST", "test" | "auth") => body.is_none(),
        _ => false,
    }
}

/// One server's edit as the screen sends it. Secrets are write-only: an env value or bearer token left out keeps what
/// Hermes has saved.
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Edit {
    /// The server's name now.
    pub name: String,
    /// Its new name, when renamed.
    #[serde(default)]
    pub new_name: Option<String>,
    pub server: ServerEdit,
}

#[derive(Deserialize, Debug)]
#[serde(tag = "transport", rename_all = "lowercase")]
pub enum ServerEdit {
    Stdio {
        command: String,
        args: Vec<String>,
        env: Vec<EnvEdit>,
    },
    Http {
        url: String,
        auth: Auth,
        #[serde(default, rename = "bearerToken")]
        bearer_token: Option<String>,
    },
}

#[derive(Deserialize, Debug, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum Auth {
    None,
    Header,
    Oauth,
}

/// One env var the edited server keeps: a new value, or `None` to keep the one Hermes has.
#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct EnvEdit {
    pub key: String,
    #[serde(default)]
    pub value: Option<String>,
}

/// What `edited` makes of an edit: the whole map to send, the bearer token to save first (its env var and value), and
/// every secret either holds, so no error shown can quote one.
#[derive(Debug)]
pub struct Edited {
    pub servers: Map<String, Value>,
    pub token: Option<(String, String)>,
    pub secrets: Vec<String>,
}

/// Hermes's `_env_key_for_server`: `MCP_<NAME>_API_KEY`, the name upper-cased with anything but letters, digits and
/// `_` made `_`, and `_` trimmed from its ends.
pub fn env_key_for(name: &str) -> String {
    let suffix: String = name.to_uppercase().chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' { c } else { '_' }).collect();
    format!("MCP_{}_API_KEY", suffix.trim_matches('_'))
}

fn is_authorization(k: &str) -> bool {
    k.eq_ignore_ascii_case("authorization")
}

/// Every string held under the servers' `env` and `headers`, and the token, at least 4 characters long.
fn secrets_of(servers: &Map<String, Value>, token: Option<&str>) -> Vec<String> {
    let mut out: Vec<String> = token.map(str::to_owned).into_iter().collect();
    for cfg in servers.values() {
        for part in ["env", "headers"] {
            if let Some(Value::Object(o)) = cfg.get(part) {
                out.extend(o.values().filter_map(Value::as_str).map(str::to_owned));
            }
        }
    }
    out.retain(|s| s.trim().len() >= 4);
    out
}

/// Makes `edit` into the whole `mcp_servers` map, from the profile's raw config (`servers`, as `GET
/// /api/config?include_defaults=false` reads it, so `${VAR}` references stay references). Every other server goes back
/// as it was read. The edited one keeps every key the screen doesn't show (`enabled`, `tools`, `timeout`, `oauth`,
/// other headers), loses the other transport's keys, and takes:
///
/// - stdio: `command`, `args` (left out when none), and `env` with exactly the keys listed, each with its new value or
///   the one Hermes has.
/// - HTTP/SSE: `url`, and its sign-in. None: no `auth`, no `Authorization` header. OAuth: `auth: oauth`, no
///   `Authorization` header (Hermes's sign-in refuses a header-auth server). Header: no `auth`, and with a new token the
///   `Authorization: Bearer ${MCP_<NAME>_API_KEY}` header, the token going to that env var first, as adding one does;
///   with none, the `Authorization` header it has.
///
/// A rename moves the entry; its OAuth tokens, kept by name, stay with the old name.
pub fn edited(servers: &Map<String, Value>, edit: &Edit) -> Result<Edited, String> {
    let Some(Value::Object(old)) = servers.get(&edit.name) else {
        return Err(format!(
            "This profile's config has no server named {} now: another client may have removed or renamed it, or a plugin provides it. Read the list again.",
            edit.name
        ));
    };
    let name = edit.new_name.as_deref().unwrap_or(&edit.name);
    if name != edit.name {
        if !server_name(name) {
            return Err("A server's name is a letter or digit, then up to 63 letters, digits, '-', '_' or '.'.".into());
        }
        if servers.contains_key(name) {
            return Err(format!("This profile already has a server named {name}."));
        }
    }
    let mut cfg = old.clone();
    let mut token = None;
    match &edit.server {
        ServerEdit::Stdio { command, args, env } => {
            if !one_line(command, 4096) {
                return Err("Type the command on one line.".into());
            }
            if args.len() > MAX_ARGS || !args.iter().all(|a| arg_ok(a)) {
                return Err(format!("At most {MAX_ARGS} arguments, none holding a NUL character."));
            }
            if env.len() > MAX_ENV {
                return Err(format!("At most {MAX_ENV} environment variables."));
            }
            let old_env = old.get("env").and_then(Value::as_object);
            let mut new_env = Map::new();
            for e in env {
                if !env_name(&e.key) {
                    return Err(format!("{} isn't an environment variable's name: letters, digits and '_', not starting with a digit.", e.key));
                }
                if new_env.contains_key(&e.key) {
                    return Err(format!("{} is listed twice.", e.key));
                }
                let value = match &e.value {
                    Some(v) if env_value_ok(v) => Value::String(v.clone()),
                    Some(_) => return Err(format!("{}'s value must be on one line.", e.key)),
                    None => match old_env.and_then(|o| o.get(&e.key)) {
                        Some(v @ Value::String(_)) => v.clone(),
                        _ => return Err(format!("{} has no saved value to keep. Type one.", e.key)),
                    },
                };
                new_env.insert(e.key.clone(), value);
            }
            for k in ["url", "headers", "auth", "oauth"] {
                cfg.remove(k);
            }
            cfg.insert("command".into(), Value::String(command.trim().to_owned()));
            if args.is_empty() {
                cfg.remove("args");
            } else {
                cfg.insert("args".into(), Value::Array(args.iter().cloned().map(Value::String).collect()));
            }
            if new_env.is_empty() {
                cfg.remove("env");
            } else {
                cfg.insert("env".into(), Value::Object(new_env));
            }
        }
        ServerEdit::Http { url, auth, bearer_token } => {
            if !http_url(url.trim()) {
                return Err("Type the server's address, starting with http:// or https://.".into());
            }
            for k in ["command", "args", "env"] {
                cfg.remove(k);
            }
            cfg.insert("url".into(), Value::String(url.trim().to_owned()));
            let mut headers = old.get("headers").and_then(Value::as_object).cloned().unwrap_or_default();
            let had_authorization = headers.keys().any(|k| is_authorization(k));
            match (auth, bearer_token.as_deref().filter(|t| !t.trim().is_empty())) {
                (Auth::Header, Some(t)) => {
                    if !token_ok(t) {
                        return Err("Paste the bearer token on one line.".into());
                    }
                    let key = env_key_for(name);
                    headers.retain(|k, _| !is_authorization(k));
                    headers.insert("Authorization".into(), Value::String(format!("Bearer ${{{key}}}")));
                    token = Some((key, strip_bearer(t).to_owned()));
                    cfg.remove("auth");
                }
                (Auth::Header, None) if had_authorization && cfg.get("auth").and_then(Value::as_str) != Some("oauth") => {}
                (Auth::Header, None) => return Err("Type the bearer token: Hermes has none saved for this server.".into()),
                (_, Some(_)) => return Err("A bearer token goes only with bearer-token sign-in.".into()),
                (Auth::None, None) => {
                    headers.retain(|k, _| !is_authorization(k));
                    cfg.remove("auth");
                }
                (Auth::Oauth, None) => {
                    headers.retain(|k, _| !is_authorization(k));
                    cfg.insert("auth".into(), Value::String("oauth".into()));
                }
            }
            if headers.is_empty() {
                cfg.remove("headers");
            } else {
                cfg.insert("headers".into(), Value::Object(headers));
            }
        }
    }
    let mut out = servers.clone();
    out.remove(&edit.name);
    out.insert(name.to_owned(), Value::Object(cfg));
    let secrets = secrets_of(&out, token.as_ref().map(|(_, t): &(String, String)| t.as_str()));
    Ok(Edited { servers: out, token, secrets })
}

/// Hermes's refusal of a whole-map write, without any secret the map held: a 400's `detail` can quote a server's
/// entry, so any secret in it is hidden, and whatever else came back isn't shown.
pub fn scrubbed(answer: &str, secrets: &[String]) -> String {
    let detail = serde_json::from_str::<Value>(answer).ok().and_then(|v| v.get("detail").and_then(Value::as_str).map(str::to_owned));
    match detail {
        Some(d) if !secrets.iter().any(|s| d.contains(s.as_str())) && d.len() <= 2000 => serde_json::json!({ "detail": d }).to_string(),
        _ => serde_json::json!({ "detail": "Hermes refused it (its answer isn't shown, as it may hold a secret)." }).to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn names() {
        for n in ["github", "my-server", "a", "Context7", "srv.v2", "x_y", &"a".repeat(64)] {
            assert!(server_name(n), "{n}");
        }
        for n in ["", "-x", ".x", "_x", "a/b", "a b", "a%2Fb", "..", "é", &"a".repeat(65), "a\n"] {
            assert!(!server_name(n), "{n:?}");
        }
    }

    #[test]
    fn creates_relayed() {
        for body in [
            json!({"name": "fs", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]}),
            json!({"name": "fs", "command": "npx", "env": {"API_KEY": "s3cret", "EMPTY": ""}}),
            json!({"name": "fs", "command": "uvx", "auth": "none"}),
            json!({"name": "web", "url": "https://mcp.example.com/mcp"}),
            json!({"name": "web", "url": "http://10.0.0.2:8000/sse", "auth": "none"}),
            json!({"name": "web", "url": "https://mcp.example.com/mcp", "auth": "oauth"}),
            json!({"name": "web", "url": "https://mcp.example.com/mcp", "auth": "header", "bearer_token": "tok-123"}),
            json!({"name": "web", "url": "https://mcp.example.com/mcp", "auth": "header", "bearer_token": "Bearer tok-123"}),
        ] {
            assert!(relayed("POST", "api/mcp/servers", Some(&body.to_string())), "{body}");
        }
    }

    #[test]
    fn creates_refused() {
        for body in [
            json!({"command": "npx"}),
            json!({"name": "a/b", "command": "npx"}),
            json!({"name": "fs", "command": "npx", "profile": "other"}),
            json!({"name": "fs", "command": "npx", "url": "https://x.example"}),
            json!({"name": "fs"}),
            json!({"name": "fs", "command": ""}),
            json!({"name": "fs", "command": "npx\nrm"}),
            json!({"name": "fs", "command": "npx", "args": "-y"}),
            json!({"name": "fs", "command": "npx", "args": [1]}),
            json!({"name": "fs", "command": "npx", "args": ["a\0b"]}),
            json!({"name": "fs", "command": "npx", "env": {"1BAD": "x"}}),
            json!({"name": "fs", "command": "npx", "env": {"OK": "line\nbreak"}}),
            json!({"name": "fs", "command": "npx", "env": {"OK": 1}}),
            json!({"name": "fs", "command": "npx", "auth": "oauth"}),
            json!({"name": "fs", "command": "npx", "bearer_token": "t"}),
            json!({"name": "web", "url": "ftp://x.example"}),
            json!({"name": "web", "url": "https://"}),
            json!({"name": "web", "url": "https://x.example", "args": ["a"]}),
            json!({"name": "web", "url": "https://x.example", "env": {"A": "b"}}),
            json!({"name": "web", "url": "https://x.example", "auth": "header"}),
            json!({"name": "web", "url": "https://x.example", "auth": "header", "bearer_token": "Bearer "}),
            json!({"name": "web", "url": "https://x.example", "auth": "header", "bearer_token": "a\nb"}),
            json!({"name": "web", "url": "https://x.example", "bearer_token": "t"}),
            json!({"name": "web", "url": "https://x.example", "auth": "basic"}),
            json!(["name", "fs"]),
        ] {
            assert!(!relayed("POST", "api/mcp/servers", Some(&body.to_string())), "{body}");
        }
        assert!(!relayed("POST", "api/mcp/servers", None));
        let many: Vec<String> = (0..65).map(|i| i.to_string()).collect();
        assert!(!relayed("POST", "api/mcp/servers", Some(&json!({"name": "fs", "command": "x", "args": many}).to_string())));
    }

    #[test]
    fn per_server_routes() {
        assert!(relayed("PUT", "api/mcp/servers/github/enabled", Some(r#"{"enabled":false}"#)));
        assert!(relayed("PUT", "api/mcp/servers/github/enabled", Some(r#"{"enabled":true}"#)));
        assert!(relayed("POST", "api/mcp/servers/github/test", None));
        assert!(relayed("POST", "api/mcp/servers/github/auth", None));
        for (method, path, body) in [
            ("PUT", "api/mcp/servers/github/enabled", Some(r#"{"enabled":"yes"}"#)),
            ("PUT", "api/mcp/servers/github/enabled", Some(r#"{"enabled":true,"profile":"x"}"#)),
            ("PUT", "api/mcp/servers/github/enabled", None),
            ("POST", "api/mcp/servers/github/test", Some("{}")),
            ("POST", "api/mcp/servers/github/auth", Some("{}")),
            ("POST", "api/mcp/servers/github/enabled", Some(r#"{"enabled":true}"#)),
            ("PUT", "api/mcp/servers/github/test", None),
            ("POST", "api/mcp/servers/a%2Fb/test", None),
            ("POST", "api/mcp/servers/../test", None),
            ("POST", "api/mcp/servers//test", None),
            ("POST", "api/mcp/servers/github/test/x", None),
            ("POST", "api/mcp/servers/github", None),
            ("PUT", "api/mcp/servers", Some(r#"{"servers":{}}"#)),
            ("POST", "api/mcp/oauth/flows/abc", None),
            ("POST", "api/mcp/oauth/callback/github", None),
        ] {
            assert!(!relayed(method, path, body), "{method} {path} {body:?}");
        }
    }

    #[test]
    fn catalog_install() {
        assert!(relayed("POST", "api/mcp/catalog/install", Some(r#"{"name":"linear","env":{},"enable":true}"#)));
        assert!(relayed("POST", "api/mcp/catalog/install", Some(r#"{"name":"github","env":{"GITHUB_TOKEN":"ghp_x"},"enable":true}"#)));
        for body in [
            r#"{"env":{}}"#,
            r#"{"name":"github","env":{"GITHUB_TOKEN":""}}"#,
            r#"{"name":"github","env":{"GITHUB_TOKEN":"a\nb"}}"#,
            r#"{"name":"github","profile":"x"}"#,
            r#"{"name":"github","enable":"yes"}"#,
            r#"{"name":"../x"}"#,
        ] {
            assert!(!relayed("POST", "api/mcp/catalog/install", Some(body)), "{body}");
        }
    }

    fn servers() -> Map<String, Value> {
        json!({
            "fs": {"command": "npx", "args": ["-y", "pkg"], "env": {"API_KEY": "s3cret-value", "MODE": "${MODE}"}, "enabled": false, "timeout": 30},
            "web": {"url": "https://old.example/mcp", "headers": {"Authorization": "Bearer ${MCP_WEB_API_KEY}", "X-Team": "blue"}, "tools": {"include": ["a"]}},
            "sso": {"url": "https://sso.example/mcp", "auth": "oauth", "oauth": {"scope": "read"}},
        })
        .as_object()
        .unwrap()
        .clone()
    }

    fn edit(v: Value) -> Edit {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn stdio_edit_keeps_unsent_secrets_and_other_keys() {
        let e = edited(
            &servers(),
            &edit(json!({"name": "fs", "server": {"transport": "stdio", "command": " uvx ", "args": ["tool"], "env": [{"key": "API_KEY"}, {"key": "NEW", "value": "n"}]}})),
        )
        .unwrap();
        assert_eq!(
            e.servers["fs"],
            json!({"command": "uvx", "args": ["tool"], "env": {"API_KEY": "s3cret-value", "NEW": "n"}, "enabled": false, "timeout": 30})
        );
        // The others go back exactly as read.
        assert_eq!(e.servers["web"], servers()["web"]);
        assert_eq!(e.servers["sso"], servers()["sso"]);
        assert!(e.token.is_none());
        assert!(e.secrets.contains(&"s3cret-value".to_owned()));
    }

    #[test]
    fn stdio_edit_drops_env_left_out_and_empty_args() {
        let e = edited(&servers(), &edit(json!({"name": "fs", "server": {"transport": "stdio", "command": "npx", "args": [], "env": []}}))).unwrap();
        assert_eq!(e.servers["fs"], json!({"command": "npx", "enabled": false, "timeout": 30}));
    }

    #[test]
    fn keeping_a_value_hermes_lacks_is_refused() {
        let err = edited(&servers(), &edit(json!({"name": "fs", "server": {"transport": "stdio", "command": "npx", "args": [], "env": [{"key": "MISSING"}]}})))
            .unwrap_err();
        assert!(err.contains("MISSING has no saved value"), "{err}");
    }

    #[test]
    fn http_header_edit_saves_the_token_under_the_name() {
        let e = edited(
            &servers(),
            &edit(json!({"name": "web", "server": {"transport": "http", "url": "https://new.example/mcp", "auth": "header", "bearerToken": "Bearer tok-999"}})),
        )
        .unwrap();
        assert_eq!(
            e.servers["web"],
            json!({"url": "https://new.example/mcp", "headers": {"Authorization": "Bearer ${MCP_WEB_API_KEY}", "X-Team": "blue"}, "tools": {"include": ["a"]}})
        );
        assert_eq!(e.token, Some(("MCP_WEB_API_KEY".to_owned(), "tok-999".to_owned())));
        assert!(e.secrets.contains(&"tok-999".to_owned()));
    }

    #[test]
    fn http_header_edit_without_a_token_keeps_the_header() {
        let e = edited(&servers(), &edit(json!({"name": "web", "server": {"transport": "http", "url": "https://old.example/mcp", "auth": "header"}}))).unwrap();
        assert_eq!(e.servers["web"], servers()["web"]);
        assert!(e.token.is_none());
        // Bearer sign-in with no header saved needs a token.
        let err =
            edited(&servers(), &edit(json!({"name": "sso", "server": {"transport": "http", "url": "https://sso.example/mcp", "auth": "header"}}))).unwrap_err();
        assert!(err.contains("Type the bearer token"), "{err}");
    }

    #[test]
    fn http_auth_switches() {
        let none =
            edited(&servers(), &edit(json!({"name": "web", "server": {"transport": "http", "url": "https://old.example/mcp", "auth": "none"}}))).unwrap();
        assert_eq!(none.servers["web"], json!({"url": "https://old.example/mcp", "headers": {"X-Team": "blue"}, "tools": {"include": ["a"]}}));
        let oauth =
            edited(&servers(), &edit(json!({"name": "web", "server": {"transport": "http", "url": "https://old.example/mcp", "auth": "oauth"}}))).unwrap();
        assert_eq!(
            oauth.servers["web"],
            json!({"url": "https://old.example/mcp", "auth": "oauth", "headers": {"X-Team": "blue"}, "tools": {"include": ["a"]}})
        );
        let off = edited(&servers(), &edit(json!({"name": "sso", "server": {"transport": "http", "url": "https://sso.example/mcp", "auth": "none"}}))).unwrap();
        assert_eq!(off.servers["sso"], json!({"url": "https://sso.example/mcp", "oauth": {"scope": "read"}}));
        let err =
            edited(&servers(), &edit(json!({"name": "web", "server": {"transport": "http", "url": "https://x.example", "auth": "oauth", "bearerToken": "t"}})))
                .unwrap_err();
        assert!(err.contains("only with bearer-token"), "{err}");
    }

    #[test]
    fn transport_switch_drops_the_other_side() {
        let e = edited(&servers(), &edit(json!({"name": "fs", "server": {"transport": "http", "url": "https://x.example/mcp", "auth": "none"}}))).unwrap();
        assert_eq!(e.servers["fs"], json!({"url": "https://x.example/mcp", "enabled": false, "timeout": 30}));
        let s = edited(&servers(), &edit(json!({"name": "sso", "server": {"transport": "stdio", "command": "npx", "args": [], "env": []}}))).unwrap();
        assert_eq!(s.servers["sso"], json!({"command": "npx"}));
    }

    #[test]
    fn rename_moves_the_entry() {
        let e = edited(&servers(), &edit(json!({"name": "fs", "newName": "files", "server": {"transport": "stdio", "command": "npx", "args": ["-y", "pkg"], "env": [{"key": "API_KEY"}, {"key": "MODE"}]}}))).unwrap();
        assert!(!e.servers.contains_key("fs"));
        assert_eq!(e.servers["files"], servers()["fs"]);
        let taken =
            edited(&servers(), &edit(json!({"name": "fs", "newName": "web", "server": {"transport": "stdio", "command": "npx", "args": [], "env": []}})))
                .unwrap_err();
        assert!(taken.contains("already has a server named web"), "{taken}");
        let bad = edited(&servers(), &edit(json!({"name": "fs", "newName": "a/b", "server": {"transport": "stdio", "command": "npx", "args": [], "env": []}})))
            .unwrap_err();
        assert!(bad.contains("A server's name"), "{bad}");
        // A header-auth rename with a new token stores it under the new name's variable.
        let moved = edited(&servers(), &edit(json!({"name": "web", "newName": "web-2", "server": {"transport": "http", "url": "https://old.example/mcp", "auth": "header", "bearerToken": "t0k3n"}}))).unwrap();
        assert_eq!(moved.token.unwrap().0, "MCP_WEB_2_API_KEY");
        assert_eq!(moved.servers["web-2"]["headers"]["Authorization"], json!("Bearer ${MCP_WEB_2_API_KEY}"));
    }

    #[test]
    fn missing_or_bad_edits_are_refused() {
        assert!(edited(&servers(), &edit(json!({"name": "gone", "server": {"transport": "stdio", "command": "npx", "args": [], "env": []}})))
            .unwrap_err()
            .contains("no server named gone"));
        assert!(edited(&servers(), &edit(json!({"name": "fs", "server": {"transport": "stdio", "command": "", "args": [], "env": []}}))).is_err());
        assert!(edited(&servers(), &edit(json!({"name": "fs", "server": {"transport": "stdio", "command": "x", "args": [], "env": [{"key": "A", "value": "1"}, {"key": "A", "value": "2"}]}}))).is_err());
        assert!(edited(
            &servers(),
            &edit(json!({"name": "fs", "server": {"transport": "stdio", "command": "x", "args": [], "env": [{"key": "A", "value": "a\nb"}]}}))
        )
        .is_err());
        assert!(edited(&servers(), &edit(json!({"name": "web", "server": {"transport": "http", "url": "file:///etc/passwd", "auth": "none"}}))).is_err());
        assert!(serde_json::from_value::<Edit>(json!({"name": "fs", "profile": "x", "server": {"transport": "stdio", "command": "x", "args": [], "env": []}}))
            .is_err());
    }

    #[test]
    fn env_keys() {
        assert_eq!(env_key_for("github"), "MCP_GITHUB_API_KEY");
        assert_eq!(env_key_for("my-server.v2"), "MCP_MY_SERVER_V2_API_KEY");
        assert_eq!(env_key_for("-x-"), "MCP_X_API_KEY");
    }

    #[test]
    fn refusals_never_quote_a_secret() {
        let secrets = vec!["s3cret-value".to_owned()];
        assert_eq!(scrubbed(r#"{"detail":"Server 'fs' rejected: shell egress"}"#, &secrets), r#"{"detail":"Server 'fs' rejected: shell egress"}"#);
        assert!(!scrubbed(r#"{"detail":"bad value s3cret-value"}"#, &secrets).contains("s3cret"));
        assert!(!scrubbed(r#"{"detail":[{"input":"s3cret-value"}]}"#, &secrets).contains("s3cret"));
        assert!(!scrubbed("s3cret-value", &secrets).contains("s3cret"));
    }
}
