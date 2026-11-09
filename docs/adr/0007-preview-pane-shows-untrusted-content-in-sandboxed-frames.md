# The preview pane shows untrusted content in sandboxed frames, and never names a local file itself

The preview pane beside the chat shows web pages, Server files, Local files and tool output. All of it may come from the model, a tool or a web site, so the app treats it as untrusted. What it must not reach is the app's own webview: that page holds Tauri's IPC, which can read the saved password from the keyring, sign in, and read and send local files.

- **Web pages** load in an `<iframe>` with `sandbox="allow-scripts allow-forms allow-same-origin"`, `referrerpolicy="no-referrer"`, and an `allow` list that turns every device permission off. Without `allow-top-navigation` and `allow-popups`, a page can't replace the app's window or open new windows. Only `http:`/`https:` addresses without credentials open, and never the app's own origin (`checkWebUrl`). `index.html` sets `frame-src http: https:`, so a page can't redirect its frame onto `tauri:`, `ipc:` or `asset:`. If a frame does end up same-origin with the app, its `load` handler empties it.
- **HTML files** render through `srcdoc` with `sandbox=""` (no scripts, no forms, an opaque origin), behind a `default-src 'none'` policy, so they also load nothing from the network. **Markdown files** render the way replies do, without raw HTML. **Code and text** render as text. **Images** show in an `<img>`, from a `data:` URL whose type is checked to be an image, or a `blob:` URL Rust read from a file whose bytes look like an image.
- **Server files** come from Hermes's own dashboard REST, `GET /api/fs/read-text` and `GET /api/fs/read-data-url`, through the existing GET relay. Rust's allow-list is unchanged. Hermes applies its own refusals, such as for credentials files and folders.
- **Local files** are picked in the native Open dialog, which Rust runs (`preview_pick_local`). Rust retains an open handle to each selected regular file in this run, and `preview_read_local` reads from that handle. Replacing the path or retargeting a symlink does not change which file Reload reads. Opens use `O_NOFOLLOW | O_NONBLOCK` and validate the opened handle, so a FIFO cannot block waiting for a writer. The webview never names a local file to read. Images use `preview_read_local_image` on the same retained handle, with the existing image signature and 25 MB limit checks.

## Why this keeps framed content away from the app

Tauri 2.12 injects its IPC bootstrap (`__TAURI_INTERNALS__`) and the per-launch `__TAURI_INVOKE_KEY__` into the main frame only (`manager/webview.rs`, `for_main_frame_only: true`). `Webview::on_message` drops every call whose key doesn't match (`webview/mod.rs`). A frame that is cross-origin with the app, or has an opaque origin, can't read the parent's globals, so it can't learn the key. On Linux the postMessage handler reports the main frame's URL, not the frame's, so the key is the barrier rather than the origin check. That is why same-origin framing, the one way to read the parent's globals, is shut three ways: the address check, the frame-src policy, and the load check.

## Considered options

- **A separate native child webview for web pages.** It would be the strongest isolation, and sites that refuse framing would still load. Rejected for now: it needs Tauri's `unstable` multi-webview feature, has to be kept positioned over the React layout by hand, and would draw over the app's menus and toasts. The pane is behind one component (`WebView` in `PreviewPane.tsx`), so it can be swapped later.
- **Turning on Tauri's CSP for the whole app.** Rejected here: it rewrites the app's scripts with nonces and would affect every screen. The one directive the pane needs, `frame-src`, is set in `index.html`. ADR 0100 adds the app's other directives to the same tag.
- **No `allow-same-origin` for web pages.** That would give each page an opaque origin, where `localStorage` throws and many sites break. Since a page's real origin is never the app's, keeping it gives the page nothing of the app's. (In the running app, a framed page's `localStorage` works. WebKitGTK keeps no third-party cookies for it either way.)
- **Letting the webview read any local path, as `hermes_send_file` did until ADR 0100.** Rejected: a preview only needs files the owner chose, and the Open dialog in Rust gives that without widening what the webview can ask Rust to read.

## Consequences

- Framed pages get no cookies (WebKitGTK blocks third-party cookies), so a site that needs a sign-in won't stay signed in.
- Sites that send `X-Frame-Options` or `frame-ancestors` show blank in the frame. The frame can't tell this apart from a page that loaded, so the pane asks the site separately and offers the owner's browser (ADR 0011). A page slow to load still says, after 15 seconds, that it may not show.
- Pages on the Hermes server's own loopback (an agent's dev server, say) aren't reachable from this computer, so they don't load. Since ADR 0052 they open through an SSH tunnel to the server.
- Links in replies now open in the pane. Before, a click replaced the app's own window with the page.
- HTML files show as static documents: their scripts don't run.
