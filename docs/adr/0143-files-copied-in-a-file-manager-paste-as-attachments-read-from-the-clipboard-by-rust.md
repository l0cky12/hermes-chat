# Files copied in a file manager paste as attachments, read from the clipboard by Rust

Pasting files copied in a file manager put their paths into the composer as text (#442). The owner wants a paste to attach what isn't text, as Chrome and Slack do.

A file manager's copy holds a `text/uri-list` of `file://` URIs, `x-special/gnome-copied-files` and `text/plain` with the paths. Measured in the app's WebKitGTK 2.54.0 on 2026-11-11, with a GTK program owning the clipboard:

| Clipboard | Paste event `types` | Text the page can read | `files` | `navigator.clipboard.read()` |
| --- | --- | --- | --- | --- |
| Three copied files | `text/uri-list` | none: `getData` gives `""` for every type | empty | `text/plain` (all paths), `text/uri-list` (the first URI only) |
| Image, HTML and text | `text/html` | the HTML only | empty | `text/plain`, `text/html`, `image/png` |
| Image and text | none | none | empty | `text/plain`, `image/png` |
| Text | `text/plain` | the text | empty | `text/plain` |
| A link (`https://` uri-list and text) | `text/uri-list`, `text/plain` | both | empty | both |
| Nothing (no owner) | none | none | empty | nothing |

In every row the webview's own paste still inserts the text. So an image with text already attached the image and pasted the text, because the page saw no text and asked the clipboard for images. Only a file copy was missing. The page can tell it apart in the paste event, before any `await`, as the only clipboard with a `text/uri-list` it can't read. It can't get the paths, though.

## Decisions

- **The paste decision is one pure function** (`pasteAttaches` in `ChatPane.tsx`). Files the paste event carries attach as bytes, and their text pastes too unless there is none. A `text/uri-list` that is hidden, or holds only `file://` URIs, is a file copy: the handler stops the paste, so no paths go in as text. With no text the page can see, the handler asks the clipboard for images and lets the webview paste. Text alone pastes as before.
- **Rust reads the copied files.** `attach_copied_files` asks GTK for the clipboard's URIs on the main thread (`gtk_clipboard_request_uris`), keeps the `file://` URIs on this computer as paths (`url` crate), adds them to `Attachable` (ADR 0129), and returns them. The composer attaches them as it does a drop: the same check, size limits and notes. They are the owner's own files, so nothing is staged or deleted later.
- **Windows needs no Rust.** Chromium gives files copied in Explorer to the paste event as `files`, with `types` `["Files"]` and no text. That was reported for Chromium on Windows 11 (esengine/DeepSeek-Reasonix pull request 14787). It wasn't measured here, or in WebView2. They attach through the existing branch, as bytes, the way a file dropped on Windows does (ADR 0127). Elsewhere than Linux, `attach_copied_files` returns no paths.

## Considered options

- **`navigator.clipboard.read()` in the page.** It returns only the first URI of the list. Its `text/plain` lists every path, but a file manager isn't bound to put paths there.
- **Also taking a copy that offers only `x-special/gnome-copied-files` or KDE's target, without a `text/uri-list`.** Not done. The paste event never names those targets, so such a copy looks to the page exactly like plain text, which must paste natively, before any `await`. Catching it would mean stopping every text paste to ask Rust first, the option rejected below. The file managers the issue names (Nautilus, Dolphin, Thunar) are expected to offer `text/uri-list` beside their own target. That wasn't measured here: only a GTK program's copy was tested.
- **Always stopping the paste and inserting the text from Rust.** It would replace the webview's paste for every paste, text included, and its undo and IME behaviour with it.

## Consequences

- A script running in the page could call `attach_copied_files` without a paste, and make attachable whatever files are on the clipboard then. As with `terminal_open_local` (ADR 0129), the script policy is what stops a script from running.
- A uri-list the page can read with any URI that isn't `file://`, such as a link, pastes as text. A copy whose `file://` URIs are all on another host attaches nothing, with the note "Only files on this computer can be attached."
- Cells copied from a spreadsheet that offers an image beside the text should attach the image and paste the text. That was not tested.
