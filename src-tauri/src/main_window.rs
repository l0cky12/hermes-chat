//! The app's window. It stays on the app's own page and opens no other windows, so a script that somehow runs in it
//! can't take the window to another site, such as a copy of the Sign in screen (ADR 0129).

use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Runtime, Url, WebviewWindowBuilder};

/// Builds the window `tauri.conf.json` describes, which has `create: false` so that Tauri leaves it to this.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let config = app.config().app.windows.first().cloned().unwrap_or_default();
    let dev = tauri::is_dev().then(|| app.config().build.dev_url.clone()).flatten();
    let app_name = config.title.clone();
    let mut window = WebviewWindowBuilder::from_config(app, &config)?;
    // Nothing keeps the window's place between runs and the config names none, so the window manager would pick it, and
    // some put a new window at the screen's top-left (#541). Wayland compositors place windows themselves.
    if let Some((x, y)) = launch_place(app, config.width, config.height) {
        window = window.position(x, y);
    }
    window
        .on_navigation(move |url| may_show(url, dev.as_ref()))
        .on_new_window(|_, _| NewWindowResponse::Deny)
        // The page names the window (src/ui/windowTitle.ts); neither webview passes its title on by itself.
        .on_document_title_changed(move |window, title| {
            let _ = window.set_title(if title.trim().is_empty() { &app_name } else { &title });
        })
        .build()?;
    Ok(())
}

/// Where the window starts: centred in the work area of the monitor under the pointer, or of the primary one when the
/// pointer can't be found (Wayland).
fn launch_place<R: Runtime>(app: &AppHandle<R>, width: f64, height: f64) -> Option<(f64, f64)> {
    let under_pointer = app.cursor_position().ok().and_then(|at| app.monitor_from_point(at.x, at.y).ok().flatten());
    let monitor = under_pointer.or_else(|| app.primary_monitor().ok().flatten())?;
    let area = monitor.work_area();
    let area = (f64::from(area.position.x), f64::from(area.position.y), f64::from(area.size.width), f64::from(area.size.height));
    Some(centred(area, monitor.scale_factor(), (width, height)))
}

/// The top-left corner, in logical pixels, that centres a window `size` logical pixels big in `area`, a work area's
/// `(x, y, width, height)` in physical pixels at `scale`. A window bigger than the area keeps to its top-left corner.
fn centred(area: (f64, f64, f64, f64), scale: f64, size: (f64, f64)) -> (f64, f64) {
    let (x, y, width, height) = (area.0 / scale, area.1 / scale, area.2 / scale, area.3 / scale);
    ((x + (width - size.0).max(0.0) / 2.0).round(), (y + (height - size.1).max(0.0) / 2.0).round())
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
    use super::{centred, may_show};
    use tauri::Url;

    #[test]
    fn centres_the_window_in_the_monitors_work_area() {
        // One 1920×1080 monitor with a 32 px panel at the top.
        assert_eq!(centred((0.0, 32.0, 1920.0, 1048.0), 1.0, (1280.0, 820.0)), (320.0, 146.0));
        // The second monitor, to the right of the first, at twice the scale: its 3840×2160 pixels are 1920×1080 logical.
        assert_eq!(centred((1920.0, 0.0, 3840.0, 2160.0), 2.0, (1280.0, 820.0)), (1280.0, 130.0));
        // 1.5 times: 2560×1440 is 1706.67×960 logical.
        assert_eq!(centred((0.0, 0.0, 2560.0, 1440.0), 1.5, (1280.0, 820.0)), (213.0, 70.0));
        // A monitor left of the primary one has a negative x.
        assert_eq!(centred((-1366.0, 0.0, 1366.0, 768.0), 1.0, (1280.0, 820.0)), (-1323.0, 0.0));
    }

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
