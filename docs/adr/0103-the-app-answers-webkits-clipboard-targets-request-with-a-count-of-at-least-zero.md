# The app answers WebKit's clipboard targets request with a count of at least zero

Pressing Ctrl+V in any text field ended the app when nothing owned the X clipboard (#360). The app took a segmentation fault in WebKitGTK's UI-process code, so there was no panic and no GTK message. GTK 3 answers `gtk_clipboard_request_targets` with `atoms = NULL` and `n_atoms = -1` when it can't read the targets, which is what happens when the clipboard has no owner. WebKitGTK 2.54.0 and 2.54.1 turned that count into a span (`unsafeMakeSpan<GdkAtom>(atoms, atomsCount)`, `Source/WebKit/UIProcess/gtk/ClipboardGtk3.cpp:85`), so -1 became `SIZE_MAX` atoms read from a null pointer. WebKit fixed it in 2.54.2 (commit 75cdc5a66f, bug 324466). The app links the system's WebKitGTK, and Debian 13 still ships 2.54.0. Arch shipped 2.54.1 from 2026-10-02 to 2026-10-23.

WebKit's own paste reaches this code, not the app's paste handler. Ctrl+V in the search field, which has no handler, ended the app the same way, and so did Shift+Insert in the composer.

It isn't only a bare test display. Any session where the clipboard has no owner hits it: a new login before anything is copied, or after the app that copied quits. Measured with WebKitGTK 2.54.0 on 2026-11-09:

| Session | Clipboard | Ctrl+V |
| --- | --- | --- |
| X11, no clipboard manager | text from an app that's still running | pastes |
| X11, no clipboard manager | nothing copied yet, or the copying app quit | app ends |
| X11 with ClipIt | nothing copied yet | app ends |
| X11 with ClipIt | the copying app quit (ClipIt takes the clipboard over) | pastes |
| Wayland (Sway) | text from `wl-copy`, still running | pastes |
| Wayland (Sway) | `wl-copy` quit | app ends |

A clipboard manager that keeps the last copy helps only after the first copy. Desktops whose compositor keeps the clipboard itself would behave like the ClipIt rows, but they weren't tested.

## Decisions

- **The executable defines `gtk_clipboard_request_targets` itself** (`src-tauri/src/gtk_clipboard.rs`). The dynamic linker looks in the executable before any library, so WebKit's call reaches this definition. It looks up GTK's function with `dlsym(RTLD_NEXT, …)`, asks GTK, and passes GTK's answer to WebKit's callback with the count raised to 0 when it is negative. That's the same change WebKit 2.54.2 made. On a WebKit that already has it, nothing changes.
- **`build.rs` keeps and exports the symbol on Linux.** `-Wl,--undefined=` makes the linker take the object that defines it out of the `hermes_chat` rlib, since nothing in Rust calls it. `-Wl,--export-dynamic-symbol=` puts it in the executable's dynamic symbol table, where WebKit's lookup finds it.
- **CI runs the regression test under Xvfb** (`src-tauri/tests/clipboard.rs`). It asks for the targets of an unowned selection through `dlsym(RTLD_DEFAULT, …)`, which resolves as WebKit's call does, and expects a count of 0. Then it pastes into a WebKitGTK textarea with no clipboard owner, expects the text unchanged, and pastes again with text on the clipboard to show the paste reads it. It is `#[ignore]`d for plain `cargo test`, because it empties the clipboard of whatever display it runs on.

## Considered options

- **Skip the paste in the app's handler when the clipboard is empty.** The crash is in WebKit's paste command, which runs for every text field, the search field included. A handler sees only its own field, and Shift+Insert would still crash.
- **Catch Ctrl+V on the GTK side and drop it when the clipboard has no owner.** It would need a different owner query on X11 and Wayland, and every way to paste would need its own key check.
- **Take ownership of an empty clipboard at startup.** The app would hold the owner's clipboard and answer for it, which changes what other apps see.
- **Require WebKitGTK 2.54.2 or later in the `.deb`.** Debian 13 users couldn't install the app until Debian ships a fixed WebKit.

## Consequences

- Pasting with nothing on the clipboard pastes nothing, in every field, on every WebKitGTK version the app runs on.
- The app depends on GTK's documented signature for `gtk_clipboard_request_targets`. GTK 3 is frozen, so it won't change.
- Once every supported distribution ships WebKitGTK 2.54.2 or later, `gtk_clipboard.rs`, the two link arguments and the first half of the test can go.
