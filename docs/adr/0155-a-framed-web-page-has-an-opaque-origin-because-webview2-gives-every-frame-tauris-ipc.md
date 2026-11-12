# A framed web page has an opaque origin, because WebView2 gives every frame Tauri's IPC

Issue #466. On Windows a web page in the Preview could reach the app's commands. ADR 0007 kept framed pages away from the app on one premise: Tauri's IPC bootstrap and its invoke key reach the app's top frame only. WebView2 breaks that premise. wry adds every initialization script to subframes on Windows, whatever `for_main_frame_only` says (wry 0.57.1, `src/lib.rs`). So every framed page has `__TAURI_INTERNALS__`, and its `invoke` sends the key.

What then decides is the origin Tauri reads from the request's `Origin` header. Tauri 2.12.5 counts an origin as the app's when its scheme and host match, whatever its port (`Webview::is_local_url`). The app has no ACL manifest, so such an origin may call every command.

A probe on a windows-latest runner (the Windows smoke test, `.github/windows-smoke/send.sh`) showed, on `main` before this change:

- A framed page at `http://localhost:<port>` has `__TAURI_INTERNALS__`. Tauri refuses its `tray_status` ("not allowed by ACL"), since its origin is remote. It runs its channel-fetch command, which Tauri exempts from that check ("data not found" for an unused channel id). A page that guessed a live id would get chat, terminal or screen data meant for the app.
- The page can move its frame to `http://tauri.localhost:<its port>/`. WebView2 answers that address with the app's own `index.html`, whose `/assets/…` scripts then load from the page's server on that port. The server's own script runs there, at an origin Tauri counts as the app's.
- From that origin, the IPC request's CORS preflight failed on the runner, so no command answered. Tauri's IPC handler sends `Access-Control-Allow-Origin: *`, so why the preflight failed is not known. Nothing in the app makes it fail, so it is not a defense.
- `window.ipc.postMessage` from a frame never reaches Rust. wry listens only for the top frame's messages: a frame's `tray_set_close_to_tray` sent that way left the setting unchanged.

## Decision

- **A framed web page's origin is opaque.** The web frame's sandbox is `allow-scripts allow-forms`, without `allow-same-origin`. Sandbox flags stay with the frame wherever its page moves it. Its IPC requests carry `Origin: null`, which Tauri refuses before it looks at the command ("Origin header is not a valid URL"). The probe saw that refusal for `tray_status` and for the channel-fetch command, and saw no script of the page's run at `tauri.localhost`.
- **The load check is gone.** `FramedWebView` used to empty a frame whose page it could read, the sign that the frame had become same-origin with the app (ADR 0007). The parent can never read an opaque frame, so the check could no longer fire.

## Considered options

- **A capability that leaves the Preview out.** Tauri's capabilities pick by window, webview and origin. The frame is part of the `main` webview, and the origin to match on is the one Tauri reads too loosely. No capability can tell the frame from the app.
- **Checking the origin in the app's invoke handler.** The handler gets an `Invoke` with the command, its arguments and the webview, not the request's origin. The webview's URL is always the app's top frame. Plugin commands and the channel-fetch command don't pass through it either.
- **A separate WebView2 for web pages, as Linux has (ADR 0081).** The strongest isolation, and sites that refuse framing would show. It means hosting a second WebView2 controller and keeping it placed over the React layout, focus and menus included. The opaque origin closes the IPC without it.

## Consequences

- **A framed page has no storage of its own.** `localStorage` throws `SecurityError` in the frame, as the probe saw. Sites that rely on it may break. The Preview's ⋯ menu says so, and Open in your browser is beside it. This holds wherever the Preview uses the frame, which is everywhere but Linux (Windows, and macOS in a build for it). On Linux web pages are the top level of their own WebKitGTK view (ADR 0081).
- **The bootstrap still loads in frames on Windows.** Tauri refuses a framed page because of its origin, not because the page lacks `__TAURI_INTERNALS__`. A frame given `allow-same-origin` again would reopen #466. The Preview tests pin the sandbox, and the Windows smoke test fails when its probe page reaches a command.
- **The postMessage path is shut by wry, not by this fix.** wry's IPC handler takes the URL of the message's sender as the request's URL, and an opaque frame's URL can still be `http://tauri.localhost:<port>`. Today wry listens only on the top frame, so a frame's message never reaches Rust. A wry that also listened on frames would reopen #466 for that path.
- **The extension host frame (ADR 0126) and the HTML-file frame were already opaque** (`sandbox="allow-scripts"` and `sandbox=""`).
