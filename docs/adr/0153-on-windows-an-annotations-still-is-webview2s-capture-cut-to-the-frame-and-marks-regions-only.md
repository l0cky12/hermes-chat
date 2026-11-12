# On Windows an annotation's still is WebView2's capture, cut to the frame, and marks regions only

**Status: accepted (#96).** ADR 0094 is the design of record for annotations. This ADR records how the still is taken on Windows, where the page isn't a view of its own.

On Windows a web page in the Preview is a sandboxed frame in the app's own WebView2 (ADR 0007), with an opaque origin (ADR 0155). The Linux still is a WebKitGTK snapshot of the page's own view (`WebViewExt::snapshot`). Windows has no view to snapshot, and the app can't read the frame.

## Decisions

- **The still is the whole webview, cut to the frame.** Annotate sends Rust the frame's box and the window's size, both in CSS pixels, and the address the frame shows (`StillSource::Frame`). Rust asks WebView2 for `CapturePreview` as PNG into a memory stream on the main thread (`frame_still.rs`), with three seconds to finish. `annotate::crop_frame` works out the device scale as the capture's width over the window's CSS width. It refuses a capture whose height disagrees by more than 2%, and a box outside the window by more than 1 CSS pixel. Then it cuts the box out and writes it as the still. The address is checked with `web_page::web_url`, as every Preview address is.
- **Annotate takes the still before the app draws anything over the frame.** The capture holds whatever the window shows. So the press takes the still while the frame is bare, and only then does the still cover it.
- **Regions only** (ADR 0094 open question 1, its default). The still carries `elements: false`, so the overlay never asks the page anything. A drag marks a region, and its card and words say "The app can't read this page on Windows, so annotations here are regions." Query and pick stay Linux-only.
- **The frame's `load` stands for a move.** The frame says that something loaded, not where, so any load makes a staged annotation's chip say "page changed". A same-document move inside the frame isn't seen.
- **Staging is the same on both platforms.** `annotate::stage` uses the `image` crate in place of cairo, so it outlines, scales down and writes `annotation-N.png` on Windows too.

## Considered options

- **The OS screenshot of the window region.** It needs the window on screen and unobscured, and maps device pixels to the page only by guessing the window's position. WebView2 captures its own surface.
- **A DevTools-protocol isolated world for element details.** It would give Windows the Linux query, but the frame is cross-origin and needs a DevTools session on its own target, which nothing here has tried (ADR 0094 Considered options). It is the later option for open question 1.
- **The frame's `ExecuteScript`.** It runs in the page's own world, where the page can replace every function the query calls.

## Consequences

- Windows annotations are regions with no selector, box details from the owner's drag, and no styles.
- A menu or toast over the frame when the owner presses Annotate would be in the still. The Annotate button is in the toolbar, not over the frame, and the card shows the still before anything is staged.
- Proven on `windows-latest` by the Windows smoke test (`.github/windows-smoke/send.sh`): the still is the frame's size times the device scale, shows the page's own pixels, and a dragged region stages with its words and sends nothing. Only scale 1 was run there. Other scales rely on the ratio check above.
