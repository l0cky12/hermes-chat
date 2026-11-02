//! Web pages in the preview pane (ADR 0007, ADR 0011): whether a site's response refuses to be shown inside another
//! app's frame, and opening a page in the owner's browser instead.
//!
//! WebKitGTK gives a frame no sign that it was refused: a page blocked by `X-Frame-Options` or CSP `frame-ancestors`
//! fires `load` at once and is as unreadable from the app as one that loaded. So the pane asks here: Rust requests the
//! page the way the frame does and reads the same two headers, by the rules WebKitGTK applies to the frame (the HTML
//! standard's "check a navigation response's adherence to its embedder policy" and CSP3's `frame-ancestors`).
//! Nothing is bypassed: the frame still loads the page itself, and a refusal only replaces the blank frame with a note.

use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, CONTENT_SECURITY_POLICY, USER_AGENT, X_FRAME_OPTIONS};
use serde::Serialize;
use std::time::Duration;
use url::Url;

/// How long a site has to answer before the check gives up and says nothing.
const CHECK_TIMEOUT: Duration = Duration::from_secs(10);
/// How long `xdg-open` may take to fail before the page counts as handed to the browser.
const OPEN_WAIT: Duration = Duration::from_secs(3);
const MAX_USER_AGENT: usize = 512;

/// What a site said when asked for a page the way the preview's frame asks for it. Sent to the webview as `{ kind, … }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Framing {
    /// The response refuses to be shown in a frame on another site: `by` is the header that says so, as sent.
    Refused { by: String },
    /// This computer couldn't connect to the site at all (no such host, connection refused, TLS failed).
    Unreachable { message: String },
    /// Nothing in the response refuses. The page may still show blank (a script can hide it, or the frame's own request
    /// can be answered differently), so this is no promise that it will show.
    NotRefused,
}

/// An http(s) page address without a username or password in it, as the pane accepts (preview.ts `checkWebUrl`).
pub fn web_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw.trim()).map_err(|_| "That isn't a web address.".to_owned())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none_or(str::is_empty) {
        return Err("Only http:// and https:// pages open from the preview.".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Web addresses with a username or password in them don't open from the preview.".into());
    }
    Ok(url)
}

/// Requests `url` as the preview's frame would (`user_agent` is the webview's), follows redirects, and reads whether the
/// final response refuses framing. Only the headers are read; the body is dropped. No cookies are sent or kept.
pub async fn check(url: &str, user_agent: &str) -> Result<Framing, String> {
    let url = web_url(url)?;
    let http = reqwest::Client::builder()
        .timeout(CHECK_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = http
        .get(url)
        .header(ACCEPT, "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
        // What a cross-site frame's navigation sends, since a site may answer a frame differently from a top-level page.
        .header("Sec-Fetch-Dest", "iframe")
        .header("Sec-Fetch-Mode", "navigate")
        .header("Sec-Fetch-Site", "cross-site")
        .header("Upgrade-Insecure-Requests", "1");
    if let Ok(ua) = HeaderValue::from_str(user_agent) {
        if !user_agent.is_empty() && user_agent.len() <= MAX_USER_AGENT {
            req = req.header(USER_AGENT, ua);
        }
    }
    match req.send().await {
        Ok(resp) => Ok(match refusal(resp.headers()) {
            Some(by) => Framing::Refused { by },
            None => Framing::NotRefused,
        }),
        Err(e) if e.is_connect() => Ok(Framing::Unreachable { message: root_cause(&e) }),
        // A slow site, a redirect loop or a broken response: the frame may still manage, so say nothing.
        Err(_) => Ok(Framing::NotRefused),
    }
}

/// The header in `headers` that refuses framing by a page on another origin, as sent, or `None`.
///
/// An enforced CSP with `frame-ancestors` decides on its own, and `X-Frame-Options` is then ignored. A source list
/// refuses only when nothing in it could match the app's page (`tauri://localhost`, or `http://localhost:…` in a dev
/// build): `'none'`, `'self'` (the framed site, never the app) and `https:` sources. Anything else, `*` included, isn't
/// counted as a refusal, since whether it matches the app's page isn't certain.
pub fn refusal(headers: &HeaderMap) -> Option<String> {
    let csp: Vec<&str> = headers.get_all(CONTENT_SECURITY_POLICY).iter().filter_map(|v| v.to_str().ok()).collect();
    let mut has_frame_ancestors = false;
    // A header may hold several policies, separated by commas. Each one is enforced.
    for policy in csp.iter().flat_map(|v| v.split(',')) {
        let Some(sources) = frame_ancestors(policy) else { continue };
        has_frame_ancestors = true;
        if refuses_every_other_app(&sources) {
            return Some(format!("Content-Security-Policy: frame-ancestors {}", sources.join(" ")).trim_end().to_owned());
        }
    }
    if has_frame_ancestors {
        return None;
    }

    let values: Vec<&str> = headers.get_all(X_FRAME_OPTIONS).iter().filter_map(|v| v.to_str().ok()).collect();
    let mut set: Vec<String> = Vec::new();
    for v in values.iter().flat_map(|v| v.split(',')) {
        let v = v.trim().to_ascii_lowercase();
        if !set.contains(&v) {
            set.push(v);
        }
    }
    let known = |s: &String| matches!(s.as_str(), "deny" | "sameorigin" | "allowall");
    // Conflicting values refuse; a lone value that isn't one of the three (such as the obsolete ALLOW-FROM) is ignored.
    let refuses = if set.len() > 1 { set.iter().any(known) } else { set.iter().any(|s| s == "deny" || s == "sameorigin") };
    refuses.then(|| format!("X-Frame-Options: {}", values.join(", ")))
}

/// The source list of the first `frame-ancestors` directive in one policy, or `None` if it has none.
fn frame_ancestors(policy: &str) -> Option<Vec<String>> {
    policy.split(';').find_map(|directive| {
        let mut tokens = directive.split_ascii_whitespace();
        let name = tokens.next()?;
        name.eq_ignore_ascii_case("frame-ancestors").then(|| tokens.map(str::to_owned).collect())
    })
}

/// Whether no source in a `frame-ancestors` list could match the app's own page. An empty list matches nothing.
fn refuses_every_other_app(sources: &[String]) -> bool {
    sources.iter().all(|s| {
        let s = s.to_ascii_lowercase();
        s == "'none'" || s == "'self'" || s == "https:" || s.starts_with("https://")
    })
}

/// The innermost reason a request failed, such as "Connection refused (os error 111)".
fn root_cause(e: &(dyn std::error::Error + 'static)) -> String {
    let mut cause = e;
    while let Some(next) = cause.source() {
        cause = next;
    }
    cause.to_string()
}

/// Opens `url` in the owner's browser with `xdg-open`.
pub async fn open_in_browser(url: &str) -> Result<(), String> {
    open_with("xdg-open", url).await
}

/// Opens `url` with `program` (`xdg-open`, or a stand-in in tests). The address is checked as the pane checks it and
/// passed as one argument, never through a shell. A program still running after a moment counts as having opened it,
/// since some browsers keep `xdg-open` waiting while they run; it is reaped in the background.
pub async fn open_with(program: &str, url: &str) -> Result<(), String> {
    let url = web_url(url)?;
    let mut child = tokio::process::Command::new(program)
        .arg(url.as_str())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => {
                format!("Couldn't find {program}, which opens pages in your browser. It comes with the xdg-utils package.")
            }
            _ => format!("Couldn't start {program}: {e}"),
        })?;
    match tokio::time::timeout(OPEN_WAIT, child.wait()).await {
        Ok(Ok(status)) if status.success() => Ok(()),
        Ok(Ok(status)) => Err(format!(
            "Your desktop couldn't open it in a browser ({program} exited with {}).",
            status.code().map_or_else(|| "a signal".to_owned(), |c| c.to_string())
        )),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => {
            tokio::spawn(async move {
                let _ = child.wait().await;
            });
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::HeaderName;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.append(HeaderName::from_bytes(k.as_bytes()).unwrap(), HeaderValue::from_str(v).unwrap());
        }
        h
    }
    const XFO: &str = "x-frame-options";
    const CSP: &str = "content-security-policy";

    /// Each case was loaded in a sandboxed frame in WebKitGTK 2.54 (the app's webview) on 2026-11-02, from a parent
    /// page on another origin; the second column is whether WebKitGTK refused to show it.
    #[test]
    fn refuses_as_webkitgtk_did() {
        let cases: &[(&[(&str, &str)], bool)] = &[
            (&[], false),
            (&[(XFO, "DENY")], true),
            (&[(XFO, "SAMEORIGIN")], true),
            (&[(XFO, "ALLOWALL")], false),
            (&[(XFO, "ALLOW-FROM http://localhost:4560")], false),
            (&[(XFO, "foo")], false),
            (&[(XFO, "sameorigin, allowall")], true),
            (&[(XFO, "DENY"), (XFO, "deny")], true),
            (&[(XFO, "DENY"), (CSP, "frame-ancestors *")], false),
            (&[(CSP, "frame-ancestors 'none'")], true),
            (&[(CSP, "frame-ancestors 'self'")], true),
            (&[(CSP, "frame-ancestors *")], false),
            (&[(CSP, "frame-ancestors http://localhost:4560")], false),
            (&[(CSP, "frame-ancestors 'self' https://*.example.com")], true),
            (&[(CSP, "frame-ancestors *"), (CSP, "frame-ancestors 'none'")], true),
            (&[("content-security-policy-report-only", "frame-ancestors 'none'")], false),
        ];
        for (h, refused) in cases {
            assert_eq!(refusal(&headers(h)).is_some(), *refused, "{h:?}");
        }
    }

    #[test]
    fn says_which_header_refused() {
        // www.google.com's answer, as fetched on 2026-11-02.
        let google = headers(&[
            ("content-security-policy-report-only", "object-src 'none';base-uri 'self'"),
            (XFO, "SAMEORIGIN"),
        ]);
        assert_eq!(refusal(&google).as_deref(), Some("X-Frame-Options: SAMEORIGIN"));
        let csp = headers(&[(CSP, "default-src 'self'; Frame-Ancestors 'self' https://a.example; script-src 'none'")]);
        assert_eq!(refusal(&csp).as_deref(), Some("Content-Security-Policy: frame-ancestors 'self' https://a.example"));
        // Two policies in one header, and a directive with no sources, which matches nothing.
        assert!(refusal(&headers(&[(CSP, "frame-ancestors *, frame-ancestors")])).is_some());
        // Other directives say nothing about framing.
        assert_eq!(refusal(&headers(&[(CSP, "default-src 'none'")])), None);
    }

    #[test]
    fn counts_a_source_that_could_be_the_app_as_no_refusal() {
        for list in ["*", "http:", "localhost:*", "tauri:", "'self' http://localhost:1420"] {
            assert_eq!(refusal(&headers(&[(CSP, &format!("frame-ancestors {list}"))])), None, "{list}");
        }
    }

    #[test]
    fn accepts_only_http_pages_without_credentials() {
        assert_eq!(web_url(" https://www.google.com/ ").unwrap().as_str(), "https://www.google.com/");
        assert!(web_url("http://127.0.0.1:8000/x").is_ok());
        for bad in ["file:///etc/passwd", "javascript:alert(1)", "tauri://localhost/", "https://liam:pw@example.com/", "nope"] {
            assert!(web_url(bad).is_err(), "{bad}");
        }
    }
}
