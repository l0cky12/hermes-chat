//! The app's window. It stays on the app's own page and opens no other windows, so a script that somehow runs in it
//! can't take the window to another site, such as a copy of the Sign in screen (ADR 0129).

use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, PhysicalPosition, Runtime, Url, WebviewWindowBuilder};

/// Builds the window `tauri.conf.json` describes, which has `create: false` so that Tauri leaves it to this.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let config = app.config().app.windows.first().cloned().unwrap_or_default();
    let dev = tauri::is_dev().then(|| app.config().build.dev_url.clone()).flatten();
    let app_name = config.title.clone();
    let mut window = WebviewWindowBuilder::from_config(app, &config)?;
    // Nothing keeps the window's place between runs, so unless the config names one the window manager would pick it,
    // and some put a new window at the screen's top-left (#541). Wayland compositors place windows themselves. The place
    // is in physical pixels, which the builder can't take, so the window is built hidden, moved, then shown.
    let place = (config.x.is_none() && config.y.is_none() && !config.center).then(|| launch_place(app, config.width, config.height)).flatten();
    if place.is_some() {
        window = window.visible(false);
    }
    let window = window
        .on_navigation(move |url| may_show(url, dev.as_ref()))
        .on_new_window(|_, _| NewWindowResponse::Deny)
        // The page names the window (src/ui/windowTitle.ts); neither webview passes its title on by itself.
        .on_document_title_changed(move |window, title| {
            let _ = window.set_title(if title.trim().is_empty() { &app_name } else { &title });
        })
        .build()?;
    if let Some(at) = place {
        window.set_position(at)?;
        if config.visible {
            window.show()?;
        }
    }
    Ok(())
}

/// `(x, y, width, height)`, in physical pixels.
type Rect = (f64, f64, f64, f64);

/// Where the window starts, in physical pixels: centred in the work area of the monitor under the pointer, or of the
/// primary one when the pointer can't be found (Wayland). Monitors at different scales have no shared logical space, so
/// the pointer and the monitors are compared in physical pixels.
fn launch_place<R: Runtime>(app: &AppHandle<R>, width: f64, height: f64) -> Option<PhysicalPosition<i32>> {
    let monitors = app.available_monitors().unwrap_or_default();
    let bounds: Vec<Rect> = monitors.iter().map(|m| rect(m.position().x, m.position().y, m.size().width, m.size().height)).collect();
    let under_pointer = app.cursor_position().ok().and_then(|at| monitor_under((at.x, at.y), &bounds)).map(|i| monitors[i].clone());
    let monitor = under_pointer.or_else(|| app.primary_monitor().ok().flatten())?;
    let area = monitor.work_area();
    let (x, y) = centred(rect(area.position.x, area.position.y, area.size.width, area.size.height), monitor.scale_factor(), (width, height));
    Some(PhysicalPosition::new(x, y))
}

fn rect(x: i32, y: i32, width: u32, height: u32) -> Rect {
    (f64::from(x), f64::from(y), f64::from(width), f64::from(height))
}

/// The first monitor whose bounds hold `point`, all in physical pixels.
fn monitor_under(point: (f64, f64), monitors: &[Rect]) -> Option<usize> {
    monitors.iter().position(|&(x, y, width, height)| point.0 >= x && point.0 < x + width && point.1 >= y && point.1 < y + height)
}

/// The top-left corner, in physical pixels, that centres a window `size` logical pixels big in `area`, a work area in
/// physical pixels at `scale`. A window bigger than the area keeps to its top-left corner.
fn centred(area: Rect, scale: f64, size: (f64, f64)) -> (i32, i32) {
    let (x, y, width, height) = area;
    let at = |start: f64, room: f64, wanted: f64| (start + (room - wanted * scale).max(0.0) / 2.0).round() as i32;
    (at(x, width, size.0), at(y, height, size.1))
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
    use super::{centred, may_show, monitor_under};
    use tauri::Url;

    #[test]
    fn centres_the_window_in_the_monitors_work_area_in_physical_pixels() {
        // One 1920×1080 monitor with a 32 px panel at the top.
        assert_eq!(centred((0.0, 32.0, 1920.0, 1048.0), 1.0, (1280.0, 820.0)), (320, 146));
        // At twice the scale the window is 2560×1640 physical pixels.
        assert_eq!(centred((1920.0, 0.0, 3840.0, 2160.0), 2.0, (1280.0, 820.0)), (2560, 260));
        // 1.5 times: 1920×1230 in 2560×1440.
        assert_eq!(centred((0.0, 0.0, 2560.0, 1440.0), 1.5, (1280.0, 820.0)), (320, 105));
        // A monitor left of the primary one has a negative x.
        assert_eq!(centred((-1366.0, 0.0, 1366.0, 768.0), 1.0, (1280.0, 820.0)), (-1323, 0));
    }

    #[test]
    fn opens_on_the_monitor_under_the_pointer_when_their_scales_differ() {
        // A 1920×1080 primary at 100 %, and a 3840×2160 monitor at 200 % to its right. In logical pixels the second
        // would start at x 960 and overlap the first, so only physical pixels tell them apart.
        let monitors = [(0.0, 0.0, 1920.0, 1080.0), (1920.0, 0.0, 3840.0, 2160.0)];
        assert_eq!(monitor_under((2500.0, 900.0), &monitors), Some(1));
        assert_eq!(monitor_under((1280.0, 130.0), &monitors), Some(0));
        assert_eq!(monitor_under((1919.0, 1079.0), &monitors), Some(0));
        assert_eq!(monitor_under((1920.0, 0.0), &monitors), Some(1));
        assert_eq!(monitor_under((100.0, 1500.0), &monitors), None);
        // The window lands on the second monitor, inside it: the point the logical centring gave, (1280, 130), is on
        // the primary.
        let (x, y) = centred(monitors[1], 2.0, (1280.0, 820.0));
        assert_eq!(monitor_under((f64::from(x), f64::from(y)), &monitors), Some(1));
        assert_eq!(monitor_under((f64::from(x) + 2559.0, f64::from(y) + 1639.0), &monitors), Some(1));
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
