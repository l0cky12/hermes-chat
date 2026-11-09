# Global shortcut screenshots

> The global shortcut was removed in #169 (ADR 0107 is superseded). These screenshots record the feature as it was.

Captured on 2026-11-03 from the running Hermes Chat debug build (WebKitGTK, with the frontend built in) from this branch, on an Xvfb display at 1280 × 820 with the Openbox window manager. Nothing was composited or retouched.

The app was signed in by URL to the loopback stub from `docs/screenshots/usage-analytics/bridge.ts`: the repo's `FakeHermes` behind real HTTP and WebSocket, with synthetic chats. It ran with its own `XDG_*` folders on a private session bus, so nothing reached a real keyring or another Hermes Chat.

**X11** (shots 1 to 5). These used the app's own X11 key grab against the real X server. A small `XGrabKey` client stood in for "another app" holding a key. Presses were sent with `xdotool key`, which goes through the X server's grabs like a real keyboard.

- `1-x11-working.png`: the saved Ctrl+Alt+H registered, as the X server confirmed. A second X client got `BadAccess` on it.
- `2-recording.png`: recording a new shortcut. The current key's grab is released meanwhile, so pressing it reaches the recorder.
- `3-conflict-keeps-previous.png`: Reset to Ctrl+Alt+H while another app held it. Ctrl+Alt+J stays registered and still worked from another window, and Retry is offered.
- `4-startup-conflict-retry.png`: another app held the saved key when Hermes Chat started. Retry registered it once that app let go.
- `5-summoned-split-panes.png`: two chats side by side with a draft in each, and the right pane selected. With xclock in front, Ctrl+Alt+H brought the window forward. The text typed straight after landed in the right pane's composer, and both drafts were kept.

**Wayland** (shots 6 to 9). The app ran with `WAYLAND_DISPLAY` and `XDG_SESSION_TYPE=wayland` set, so it takes the Wayland path, while GTK drew through X11 (`GDK_BACKEND=x11`, as under XWayland). There is no Wayland compositor on this machine.

- `6-wayland-fallback-instructions.png`: `XDG_CURRENT_DESKTOP=sway`. The session bus started the machine's real xdg-desktop-portal, which has no GlobalShortcuts, so nothing is registered and Settings gives bind lines for `hermes-chat --show`.
- `7-portal-hyprland.png`, `8-portal-denied.png`, `9-portal-session-ended.png`: the stand-in portal `src-tauri/examples/fake_portal.rs`, not a real desktop's. It answered as Hyprland does, binding without setting a key. Then it refused a change to Ctrl+Alt+J (Ctrl+Alt+H still works), and then it ended the session, which Settings reports with Retry. `hyprctl` isn't installed here, so the `global` bind shows the empty-app-id fallback name.

To run it again: build with `cargo build --features tauri/custom-protocol --bins --examples` in `src-tauri` after `npm run build`. Start Xvfb and Openbox, the stub (see the usage-analytics README), and `dbus-daemon --session --fork --print-address`. Then start the app with that bus, its own `XDG_CONFIG_HOME`, `XDG_DATA_HOME` and `XDG_CACHE_HOME`, and `DISPLAY` set. For the portal shots, run `cargo run --example fake_portal`, use the bus address it prints, and type `notrigger`, `deny`, `end` or `press` into it.
