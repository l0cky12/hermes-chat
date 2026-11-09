# On Windows, Tauri's native drop handler is off, and files are dropped as HTML5 drops

ADR 0046 moved chats between the list, tab strips and panes with HTML5 drag and drop. It kept Tauri's native drop handler for files dropped on the composer, because wry's WebKitGTK handler takes only drags that carry file URIs, so in-page drags still reach the webview. That holds on Linux. On Windows it doesn't. wry replaces WebView2's own drop target on the webview's windows (`RevokeDragDrop`, then `RegisterDragDrop`, in wry's `webview2/drag_drop.rs`) and turns down every drag without files. A chat dragged from the list or a tab started its drag, but the page never got a `dragenter`, `dragover` or `drop`, so nothing opened (#300). Tauri's documentation of `dragDropEnabled` says to turn it off for HTML5 drag and drop on Windows.

## Decisions

- **`tauri.windows.conf.json` sets `dragDropEnabled: false`.** Tauri merges that file over `tauri.conf.json` only when it builds for Windows. A config merge replaces a list whole, so the file repeats the window and `dragDropConfig.test.ts` checks that the two windows differ only in that key.
- **Linux keeps the native handler.** In the real app, an HTML5 drop from a file manager (Thunar, or a plain GTK drag source) carries `text/uri-list` and `text/html` but no files: `dataTransfer.files` is empty and the URI list reads as empty. With the handler off, Linux couldn't attach a dropped file at all. With it on, file drops keep their real paths, and in-page drags pass through (checked with real pointer drags on X11 and on Wayland under sway).
- **On Windows a file dropped on a pane attaches to that pane's composer as an HTML5 drop.** The pane's root takes drags that carry `Files`. The browser's own hit-testing picks the pane. The drop gives the file's bytes and not its path, so each file goes to Rust as bytes (`stage_clipboard_file`), as a pasted file always has. Rust saves it to a private temp file, and it then attaches as before. A file over the 256 MB attachment limit is turned down before its bytes are read.
- **A file dropped where no pane takes it is turned down** (`refuseStrayFileDrops`, at the window). Otherwise the webview would open the file in place of the app. In WebKitGTK it did exactly that once nothing took the drop.

## Considered options

- **Turn the handler off everywhere**, so one drop path serves both platforms. Tried and dropped: on Linux it broke file drops, as above.
- **Forward non-file drags from wry's drop target to WebView2's.** Dropped: a patch to wry, kept outside the project.

## Consequences

- On Windows, a dropped file's bytes pass through the webview, as a pasted file's always have, and it is attached from a temp folder under its own name. Picked files are still read by Rust from their real path.
- The composer has two ways to receive a dropped file: Tauri's event (Linux, macOS) and the HTML5 drop (Windows). Each platform delivers only one of them.
- A build that merges another config over the window list, such as a smoke test's `--config`, replaces `tauri.windows.conf.json`'s list too, so it must keep `dragDropEnabled: false` itself.
