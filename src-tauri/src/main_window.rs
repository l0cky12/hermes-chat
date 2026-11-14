//! The app's window. It stays on the app's own page and opens no other windows, so a script that somehow runs in it
//! can't take the window to another site, such as a copy of the Sign in screen (ADR 0129).

use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Runtime, Url, WebviewWindowBuilder};

/// Builds the window `tauri.conf.json` describes, which has `create: false` so that Tauri leaves it to this.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let config = app.config().app.windows.first().cloned().unwrap_or_default();
    let dev = tauri::is_dev().then(|| app.config().build.dev_url.clone()).flatten();
    let app_name = config.title.clone();
    WebviewWindowBuilder::from_config(app, &config)?
        .on_navigation(move |url| may_show(url, dev.as_ref()))
        .on_new_window(|_, _| NewWindowResponse::Deny)
        // The page names the window (src/ui/windowTitle.ts); neither webview passes its title on by itself.
        .on_document_title_changed(move |window, title| {
            let _ = window.set_title(if title.trim().is_empty() { &app_name } else { &title });
        })
        .build()?;
    Ok(())
}

/// Whether the window may show `url`: the app's own page (`tauri://localhost`, `http(s)://tauri.localhost` on Windows,
/// or Vite's address in a dev build), or an empty or `srcdoc` document. WebKitGTK asks about frames too,
/// and the preview shows an HTML file in a `srcdoc` frame; neither kind loads anything from elsewhere.
fn may_show(url: &Url, dev: Option<&Url>) -> bool {
    match url.scheme() {
        "about" => matches!(url.path(), "blank" | "srcdoc"),
        "tauri" => url.host_str() == Some("localhost") && url.port().is_none(),
        "http" | "https" => {
            (cfg!(windows) && url.host_str() == Some("tauri.localhost") && url.port().is_none()) || dev.is_some_and(|dev| dev.origin() == url.origin())
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::may_show;
    use tauri::Url;

    #[test]
    fn shows_only_the_app_and_empty_or_srcdoc_documents() {
        let url = |s: &str| Url::parse(s).unwrap();
        let dev = url("http://localhost:1420/");
        for own in ["tauri://localhost/", "tauri://localhost/index.html#chat", "about:blank", "about:srcdoc"] {
            assert!(may_show(&url(own), None), "{own}");
        }
        // Only WebView2 serves the app at tauri.localhost. Elsewhere the name is this computer's loopback, where any
        // local server, the sign-in tunnel's included, would answer.
        for windows_own in ["http://tauri.localhost/", "https://tauri.localhost/"] {
            assert_eq!(may_show(&url(windows_own), None), cfg!(windows), "{windows_own}");
        }
        assert!(may_show(&url("http://localhost:1420/src/main.tsx"), Some(&dev)));
        for other in [
            "https://example.com/",
            "http://127.0.0.1:9119/api/status",
            "http://localhost:1420/",
            "tauri://example.com/",
            "http://tauri.localhost.example.com/",
            "file:///etc/passwd",
            "data:text/html,<p>hi</p>",
            "javascript:alert(1)",
            "about:config",
            "http://tauri.localhost:9119/api/status",
            "https://tauri.localhost:8443/login",
            "tauri://localhost:9119/",
        ] {
            assert!(!may_show(&url(other), None), "{other}");
        }
        assert!(!may_show(&url("http://localhost:1421/"), Some(&dev)));
    }
}
