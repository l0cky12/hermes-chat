# A web page in the Preview is the top level of its own WebKitGTK view on Linux

> **Partly superseded by [ADR 0103](0103-the-preview-is-a-browser-only-the-owner-drives.md)** (#376). The Preview makes a view for each run of web pages and ends it, rather than loading `about:blank` into one view, and Reload reloads the same view. The view stays over a page while the next one the owner asked for loads. The address follows a link followed inside the page, and Back and Forward move through it. The decision "The page stops when the Preview hides it" holds with those changes, and the last consequence no longer holds. The rest of this ADR stands.

Issue #254. **Open in the Preview** on `https://www.google.com` showed only a note: "www.google.com doesn't allow being shown inside other apps". The Preview loaded web pages in an `<iframe>` (ADR 0007), and a site that sends `X-Frame-Options` or CSP `frame-ancestors` refuses to be framed. ADR 0011 could only say so. A large share of the web refuses framing, Google included, so the owner wants such a page to render in the Preview.

## Decisions

- **On Linux, a web page loads as the top level of a WebKitGTK view laid over the Preview's box.** `X-Frame-Options` and `frame-ancestors` apply only to frames, so a site that refuses framing shows. This covers every web page the Preview opens: a link, the address box, a tool call's page, a page on this computer's loopback, and a server page through its SSH tunnel (ADR 0114), whose tunnel address the view loads. The pane no longer asks whether a site refuses framing there, and the refusal note never shows. Windows keeps the sandboxed frame, the check and the note (ADR 0007, ADR 0011).
- **The view isn't Tauri's.** `src-tauri/src/page_view.rs` makes a plain `webkit2gtk::WebView` with its own `WebContext::new_ephemeral()`. Tauri adds its IPC bootstrap and the per-launch invoke key to every webview it makes. This view gets no Tauri script, no IPC handler and none of the app's URI schemes (`tauri:`, `ipc:`, `asset:`), which are registered only on Tauri's own web context. The page shares no cookies or storage with the app. Its own cookies last until the app quits, so a sign-in on a site lasts the run.
- **Tauri's webview moves into a `GtkOverlay` the first time a page opens.** The page's view is the overlay's one overlay child, and the overlay's `get-child-position` places it at the rectangle the pane last sent. The app's page is never zoomed, so the pane's CSS pixels are GTK's logical pixels. Taking Tauri's webview out of its box clears the window's keyboard focus, so the move gives the focus back. Without that, Escape and every shortcut stopped working until the owner clicked the app.
- **The pane sends where its box is, and works it out again only when something changed** (`src/ui/pagePlacement.ts`). The triggers are the box resizing (a pane drag, the window), the app's DOM changing, the owner's input, and an opening animation ending. Checks are at most one per 200 ms, and run on a timer, not an animation frame. The view hides until the page's first response comes, and again if a load fails, when the pane says why with **Reload**.
- **The app's layers over the page make room for it.** The view is a native widget, so it draws over every element of the app's page. The pane counts as a layer every element that matches a `position: fixed` rule in the app's stylesheet, such as a menu, a dialog's backdrop, a toast or the inbox, and every `[role=separator]`. A layer counts where it overlaps the box and is painted above it: before the box among the elements at the overlap's middle (`elementsFromPoint`). So a layer under the Preview (when it covers the chat) counts for nothing, and a menu under a toast still counts. A layer across a whole side of the box moves that side in: the pane's resize handle sits on the box's left edge, and without that the page took half of it. A dialog's backdrop covers every side, so the page hides. Any other layer, such as a menu or a toast, makes a hole. On X11 the view's window is made native and shaped: the X server clips the page out of each hole and passes the pointer through to the app. Wayland's GTK has no native child windows, so there the page hides while such a layer overlaps it.
- **The page stops when the Preview hides it.** Another page, Reload, another side panel tab, or the side panel closing loads `about:blank` into the view and hides it (ADR 0039). Each page opened has a key, and Rust ignores a move or close for any other key, so a page that went away can't move or close the next one. The pane sends the view's commands one at a time, each once the one before has finished, so Rust never gets a close before its open, or an old page's open after a new one's.
- **The page may do no more than the frame did.** `page_webview()` in `page_view.rs` makes the view with the frame's limits, set in WebKit's settings and its signals, so no page needs to be trusted to keep to them. *What the page may do*, below, lists each. A first version left WebKit's defaults in place. An independent check of the PR found three things the frame never allowed. One `alert()` left open stopped every later page from loading until the app restarted. A page could open WebKit's modal Print dialog over the whole window on load, and on a timer bring it back after every Cancel. A click on a fullscreen button made the app's whole window fullscreen.
- **The page can't keep the keyboard from the app.** A page that calls `window.focus()` and `input.focus()` every 300 ms left the owner's typing in the composer. A click in the page gives it the keyboard, as any widget, and a click in the app takes it back. Keys pressed while the page has the keyboard go to the page. An Escape the page doesn't use comes back from WebKit through the overlay, and gives the keyboard back to the app, at the Preview's box, so the next Escape closes the side panel as it would anywhere in the panel. The frame kept every key, Escape included. When the view hides while it has the keyboard (a load fails, the SSH tunnel closes, a layer hides the page on Wayland), the app takes the keyboard back, so keys don't go nowhere until the owner clicks.

## What the page may do

The frame is ADR 0007's: `sandbox="allow-scripts allow-forms allow-same-origin"`, with every feature in its `allow` list `'none'`. Each row was checked in the app, in the frame on `main` (3a7a1cfc) and in the view with this change, with a test page and real clicks, except where the row says otherwise. Rows marked *test* are also in `page_view::tests::a_page_in_the_view_gets_no_more_than_the_frame`, which needs a display and so runs only with `--ignored`.

| | The frame | The view |
| --- | --- | --- |
| Scripts, forms, its own cookies and storage | Allowed | Allowed. The storage is in memory and apart from the app's (*The security boundary*). |
| `alert`, `confirm`, `prompt` | No dialog. They return at once: `undefined`, `false`, `null`. | The same (*test*). The view answers every script dialog itself (`script-dialog`). |
| Leaving a page that asks to stay (`beforeunload`) | No dialog | No dialog. The view answers "leave". |
| `print()` | Returns at once. No dialog. | The same (*test*). The view handles `print`. |
| Fullscreen | Refused by the `allow` list | The Fullscreen API is off (`enable-fullscreen`), so `requestFullscreen` is undefined (*test*). The view also handles `enter-fullscreen`, so nothing else that asks gets the app's window. With the API turned on in a test build, a page went fullscreen inside its own box, and the window stayed as it was. |
| A new window: `window.open`, `target=_blank`, the page's menu | Nothing opens | No window opens. Without a click, `window.open` returns `null` (`javascript-can-open-windows-automatically` is off, *test*). After a click, an http(s) address loads in the same view, which the page could do itself by setting `location`. |
| Downloads | None | None. Every download is cancelled as it starts. A page whose first response is a download fails with "It's a file to download, and the Preview doesn't save files."; a download from a page already shown leaves that page. |
| A file picker (`<input type=file>`) | A click opened nothing | Every file chooser request is cancelled (`run-file-chooser`). |
| A colour picker (`<input type=color>`) | A click opened WebKit's Select Color dialog | The same, WebKit's default. |
| Camera, microphone, display capture, location, notifications, clipboard read | Refused. Checked: location, notifications, clipboard read. | Every permission request is refused (`permission-request`). Checked: location, notifications, clipboard read, and the camera in the *test*. |
| Pointer lock | Refused by the sandbox | Every permission request is refused, pointer lock's included. In the check WebKit refused it first, on its own test that the window has focus, so the refusal by the view wasn't seen. |
| Clipboard write after a click | Allowed: `navigator.clipboard.writeText` wrote. WebKit doesn't apply `clipboard-write 'none'`. | The same. Script reads of the clipboard stay off (`javascript-can-access-clipboard`). |
| WebKit's Web Inspector | The app's webview's setting. Not checked. | Off (`enable-developer-extras`). Not checked. |
| The app's IPC, origin and storage | None | None (*The security boundary*) |

The page's own right-click menu is WebKit's, as it was in the frame. Its items weren't checked one by one: the menu draws black in the headless X server used for checks. By the rows above, a download from it is cancelled, a new window from it loads in the same view, and with developer extras off it has no Inspect Element.

## The security boundary

What a page in the view could reach before, through the frame, was nothing of the app: ADR 0007 relies on the invoke key, which a cross-origin frame can't read. The view keeps that true by having no channel to the app at all:

- **No IPC.** No Tauri script runs in the view, so the page has no `__TAURI_INTERNALS__`, no invoke key and no `window.ipc`. The view's web context has no `ipc:` scheme to post to. Checked in the running app: a script in the page reported `window.__TAURI_INTERNALS__` undefined.
- **No app origin.** The view's context has no `tauri:` or `asset:` scheme, so the page can't load the app's own pages or files. Rust opens only an http(s) address without credentials (`web_page::web_url`), as the pane checks it.
- **No shared storage.** The ephemeral context keeps its cookies, local storage and cache in memory, apart from the app's webview. Nothing is written to disk.
- **Capabilities unchanged.** `capabilities/default.json` grants Tauri's permissions to the `main` window. The view isn't a Tauri webview, so no capability can name it and no command can be reached from it.

## Considered options

Two were built and run in the app, on a branch kept out of this change.

- **A Tauri child webview** (`Window::add_child`, behind Tauri's `unstable` feature). Rejected on what it did:
  - On Linux, `tauri-runtime-wry` packs every child webview into the window's vertical `GtkBox`, and `set_position` and `set_size` do nothing there. Google filled the bottom half of the window, under the app.
  - Tauri gives every webview it makes its IPC bootstrap and the per-launch invoke key. A script in Google's page in the child webview read the key by wrapping `fetch` and calling `invoke`. Tauri turned the call down (a remote origin needs a `remote` capability), but the key is the only guard ADR 0007 has for the frames in the app's own webview.
  - `unstable` changes how Tauri makes every webview, the app's own included, on every platform.
- **Fetching the page in Rust, or stripping the headers through a proxy.** Rejected for the reasons ADR 0011 gives: it bypasses the site's own policy, the page runs without its origin, and its cookies and requests break.
- **A separate window over the pane.** Rejected without building it: Wayland doesn't let an app place a window, and on X11 the window manager decides. The window would also take focus and show in the task list.
- **Tracking the box every animation frame.** Built and measured: with a page shown and nothing changing, the app's process used 1.25 s and its web process 0.55 s of CPU every 10 s. Each frame has the webview draw, though nothing changed. With the change-driven checks, they used 0.02 s and 0.01 s, the same as with the Preview closed (0.01 s and 0 to 0.02 s). Measured on a box with a load average near 25.
- **Hiding the page whenever any layer overlaps it, on X11 too.** Rejected for X11: a toast or a menu near the pane would blank the whole page. It is the fallback elsewhere.
- **Keeping the page's cookies across runs.** Not done: it would keep sign-ins to sites on disk without the owner asking. It is one line in `page_view.rs` if wanted.

## Consequences

- Sites that refuse framing show on Linux. ADR 0007's frame, and its consequence that framed pages get no cookies, now hold only on Windows.
- A page keeps its first-party cookies while the app runs, so a site's sign-in works in the Preview until the app quits.
- An element that floats over the pane must be `position: fixed`, or a separator, for the page to make room for it. An `absolute` popover reaching into the Preview would be drawn under the page.
- On Wayland a menu or toast over the page hides the whole page until it goes, rather than leaving a hole. Checked on a headless Sway (wlroots) with the app on GTK's Wayland backend: Google rendered in the pane, the search palette hid it, and closing the palette brought it back. A real desktop compositor (the owner's) wasn't tried.
- While a page shows, WebKit runs a web process for it beside the app's.
- WebDriver's screenshot (`wd.mjs shot`) shows the app's page without the view. `hv shot` takes the whole screen.
- The Preview's header shows the address it opened. A link followed inside the page doesn't change it, as with the frame.
