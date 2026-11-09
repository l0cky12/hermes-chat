//! The Windows touch keyboard over the bottom of the window (ADR 0103). Windows docks it over the window without
//! resizing it, and neither WebView2 (`navigator.virtualKeyboard`, `keyboard-inset-*`, `visualViewport`) nor the
//! input pane API (`IFrameworkInputPane`) tells the app, so the composer stayed under it (#375). TabTip draws the
//! keyboard in its `IPTip_Main_Window`, which is uncloaked and enabled while the keyboard shows: a thread reads it and
//! tells the page how much of the window it covers, in CSS pixels, as [`EVENT`] and [`touch_keyboard_covered`].

/// Carries `{ covered }`: the height, in CSS pixels, of the window's bottom edge the keyboard covers, 0 once it doesn't.
pub const EVENT: &str = "touch-keyboard";

/// A rectangle in screen pixels, edges exclusive at right and bottom as Windows' `RECT`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

/// How much of the bottom of `client` a shown keyboard at `keyboard` covers, in the same pixels. Only a keyboard that
/// overlaps the client sideways and reaches down to the client's bottom edge covers it, docked or floating there; one
/// moved up the screen leaves the bottom, and the composer on it, in view.
pub fn covered(client: Rect, keyboard: Option<Rect>) -> i32 {
    match keyboard {
        Some(k) if k.left < client.right && k.right > client.left && k.top < client.bottom && k.bottom >= client.bottom => {
            client.bottom - k.top.max(client.top)
        }
        _ => 0,
    }
}

/// Follows the touch keyboard over `window` until the window is gone, emitting [`EVENT`] when what it covers changes.
#[cfg(windows)]
pub fn start<R: tauri::Runtime>(window: tauri::WebviewWindow<R>) {
    use tauri::Emitter;
    let Ok(hwnd) = window.hwnd() else { return };
    let hwnd = hwnd.0 as isize;
    std::thread::spawn(move || {
        let mut last = 0.0;
        while let Some(px) = win::covered_px(hwnd) {
            // Without the scale, a height in CSS pixels can't be told; the next poll tries again.
            if let Ok(scale) = window.scale_factor() {
                let css = px as f64 / scale;
                if css != last {
                    last = css;
                    let _ = window.emit(EVENT, serde_json::json!({ "covered": css }));
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
    });
}

/// What the keyboard covers now, in CSS pixels, for a page that starts listening after the keyboard came up (at
/// startup, or after a reload). Always 0 outside Windows.
#[tauri::command]
pub fn touch_keyboard_covered<R: tauri::Runtime>(window: tauri::WebviewWindow<R>) -> f64 {
    #[cfg(windows)]
    if let (Ok(hwnd), Ok(scale)) = (window.hwnd(), window.scale_factor()) {
        return win::covered_px(hwnd.0 as isize).unwrap_or(0) as f64 / scale;
    }
    let _ = window;
    0.0
}

#[cfg(windows)]
mod win {
    use super::{covered, Rect};
    use windows_sys::Win32::Foundation::{HWND, POINT, RECT};
    use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows_sys::Win32::Graphics::Gdi::ClientToScreen;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        FindWindowW, GetClientRect, GetWindowLongW, GetWindowRect, IsIconic, IsWindow, IsWindowVisible, GWL_STYLE, WS_DISABLED,
    };

    /// The pixels of `hwnd`'s client area the keyboard covers now, or `None` once the window is gone.
    pub fn covered_px(hwnd: isize) -> Option<i32> {
        let hwnd = hwnd as HWND;
        // SAFETY: plain Win32 queries on window handles; a stale handle makes them fail, not misbehave.
        unsafe {
            if IsWindow(hwnd) == 0 {
                return None;
            }
            if IsIconic(hwnd) != 0 {
                return Some(0);
            }
            let mut r: RECT = std::mem::zeroed();
            let mut origin = POINT { x: 0, y: 0 };
            if GetClientRect(hwnd, &mut r) == 0 || ClientToScreen(hwnd, &mut origin) == 0 {
                return Some(0);
            }
            let client = Rect { left: origin.x, top: origin.y, right: origin.x + r.right, bottom: origin.y + r.bottom };
            Some(covered(client, keyboard()))
        }
    }

    /// Where TabTip's keyboard is, while it shows. Hidden, its window stays visible but is cloaked and disabled.
    unsafe fn keyboard() -> Option<Rect> {
        let class: Vec<u16> = "IPTip_Main_Window\0".encode_utf16().collect();
        let k = FindWindowW(class.as_ptr(), std::ptr::null());
        if k.is_null() || IsWindowVisible(k) == 0 || GetWindowLongW(k, GWL_STYLE) as u32 & WS_DISABLED != 0 {
            return None;
        }
        let mut cloaked = 0u32;
        let size = std::mem::size_of::<u32>() as u32;
        if DwmGetWindowAttribute(k, DWMWA_CLOAKED as u32, (&mut cloaked as *mut u32).cast(), size) != 0 || cloaked != 0 {
            return None;
        }
        let mut r: RECT = std::mem::zeroed();
        (GetWindowRect(k, &mut r) != 0).then_some(Rect { left: r.left, top: r.top, right: r.right, bottom: r.bottom })
    }
}

#[cfg(test)]
mod tests {
    use super::{covered, Rect};

    const fn rect(left: i32, top: i32, right: i32, bottom: i32) -> Rect {
        Rect { left, top, right, bottom }
    }

    // The probe's geometry (#375): a maximized window's client area on a 1024 × 768 screen above a 48-pixel taskbar.
    const CLIENT: Rect = rect(0, 23, 1024, 720);

    #[test]
    fn a_docked_keyboard_covers_the_window_from_its_top_edge_down() {
        assert_eq!(covered(CLIENT, Some(rect(0, 494, 1024, 768))), 720 - 494);
    }

    #[test]
    fn a_floating_keyboard_at_the_bottom_covers_the_bottom_too() {
        assert_eq!(covered(CLIENT, Some(rect(70, 494, 953, 768))), 720 - 494);
    }

    #[test]
    fn nothing_is_covered_without_a_keyboard_or_with_one_clear_of_the_bottom_edge() {
        assert_eq!(covered(CLIENT, None), 0);
        // Moved up the screen: over the window, but not its bottom.
        assert_eq!(covered(CLIENT, Some(rect(70, 100, 953, 374))), 0);
        // A window that ends above the keyboard.
        assert_eq!(covered(rect(0, 23, 1024, 400), Some(rect(0, 494, 1024, 768))), 0);
        // A window beside the keyboard, on another monitor.
        assert_eq!(covered(rect(1024, 23, 2048, 720), Some(rect(0, 494, 1024, 768))), 0);
    }

    #[test]
    fn a_keyboard_taller_than_the_window_covers_all_of_it() {
        assert_eq!(covered(rect(0, 600, 1024, 720), Some(rect(0, 494, 1024, 768))), 120);
    }
}
