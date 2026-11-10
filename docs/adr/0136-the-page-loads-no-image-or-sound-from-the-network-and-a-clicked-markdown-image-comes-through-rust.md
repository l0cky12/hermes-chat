# The page loads no image or sound from the network, and a clicked Markdown image comes through Rust

Mermaid lays a diagram out inside the live page, and `mermaid.ts`'s `contained()` cleans the SVG only afterwards (ADR 0102). Some diagram text puts loading elements into the page during that layout. A sequence message with `$$…$$` keeps its raw HTML, so `<img>`, `<video poster>`, `<audio>`, `<picture><source srcset>` and `<input type=image>` all went in with their sources. A sequence actor's `properties` icon became an SVG `<image>` that d3 draws outside Mermaid's DOMPurify pass. The page policy in `index.html` had no `img-src` or `media-src`, so the webview fetched each one with no click. A prompt-injected reply ending in a diagram could send chat content to any server as soon as the block scrolled into view (#465). Remote images in Markdown already waited for a click (ADR 0099).

## Decisions

- **The page policy sets `img-src 'self' data: blob:` and `media-src 'self' data: blob:`.** No image, poster, sound or video loads from the network, whatever puts the element into the page. Every image and sound the app shows already comes from its own files or a `data:` or `blob:` URL: bot pictures, attachment thumbnails, preview and file browser images, the chat picture in Export, noVNC's cursors and the speaker's audio.
- **A clicked Markdown image comes through Rust.** The click calls `markdown_image_load` (`src-tauri/src/markdown_image.rs`). Rust GETs the http(s) address with no cookies, for at most 30 s and 20 MB, read as it streams. It accepts only a `Content-Type` of PNG, JPEG, GIF, WebP, BMP, AVIF, SVG or ICO, and returns the image as a `data:` URL that the `<img>` shows. An SVG in an `<img>` runs no scripts and loads nothing. Addresses that aren't http(s), or carry a username or password, are refused.
- **The placeholder says what is happening.** While Rust fetches, it reads "…, loading…". If the fetch fails, it gives the reason, such as "That address isn't an image.", and another click tries again. The click still never follows a link around the image.
- **The draw-phase checks stay.** `refused()`, locked settings and `contained()` are unchanged. The policy covers what they miss. The test "puts nothing into the page while it draws that the page policy would let load" reads the policy from `index.html` and draws each case above.

## Considered options

- **A longer draw-phase denylist, or a stricter `dompurifyConfig`.** Each diagram type has its own way to emit markup, so this is whack-a-mole. The actor icon is drawn by d3 outside DOMPurify, so no DOMPurify setting reaches it.
- **Drawing diagrams in a separate frame with its own `default-src 'none'` policy.** Mermaid's renderers read the global `document` for layout and measurement, so they would have to run inside the frame with their own copy of Mermaid.
- **Keeping the policy without `img-src`, as ADR 0102 and ADR 0129 chose.** ADR 0102 relied on the draw-phase checks alone, which #465 shows are not enough. ADR 0129 left `img-src` out because it would block ADR 0099's clicked image. That image now comes through Rust.
- **`font-src`, `style-src` or `default-src`.** Not added. No diagram was found that loads a font or a stylesheet: `refused()` already rejects CSS `url()` and `@import`, and `<link>` in a label loaded nothing in the real app.

## Consequences

- A clicked image now comes from Rust, not the webview. It carries none of the webview's cookies and no `Referer` from the app, and an address that answers with something other than one of the listed image types shows the reason instead of a broken image.
- An image over 20 MB, or slower than 30 s, no longer loads.
- A future feature that shows a remote image or plays remote audio in the page needs the same treatment: fetch it in Rust and show a `data:` or `blob:` URL.
