# The preview asks a site whether it refuses framing, and offers the owner's browser

Some sites refuse to be shown inside another site or app. They send `X-Frame-Options: DENY` or `SAMEORIGIN`, or a
`Content-Security-Policy` with `frame-ancestors`. A refused page left the preview pane white, with nothing to say why
(issue #55, `https://www.google.com/`).

In WebKitGTK 2.54 (the app's webview), the frame gives no sign of a refusal. A refused page fires `load` within a few
hundred milliseconds, and its location then throws `SecurityError`, as for a page that loaded. So the loading note
went away and the 15-second hint never appeared. A site that can't be reached (connection refused) never fires `load`,
so its spinner ran until the hint.

So when the pane opens a web page, it asks Rust as well (`preview_check_web`, `src-tauri/src/web_page.rs`). Rust
requests the page with the webview's user agent and the `Sec-Fetch-*` headers of a cross-site frame. It sends no
cookies, follows redirects and reads only the final response's headers. It applies the rules that WebKitGTK applied
in every case we tested (see the unit tests):

- An enforced CSP `frame-ancestors` decides on its own, and `X-Frame-Options` is then ignored. It counts as a refusal
  only when no source in it could match the app's page: `'none'`, `'self'` and `https:` sources. `*` and anything
  else that might match `tauri://localhost` (or `http://localhost:1420` in a dev build) aren't counted.
- Otherwise `X-Frame-Options` `DENY` or `SAMEORIGIN` refuses, and so do conflicting values. A lone value that isn't
  one of the three, such as the obsolete `ALLOW-FROM`, is ignored.

A refusal replaces the frame with a note that names the header, an **Open in your browser** button and **Try showing
it here anyway**. A connection error shows **Couldn't reach** over the frame until the frame loads. Any other result,
or a failed check, leaves the frame as it was. Every web page has **Open in your browser** in the pane's header and in
its note. That runs `xdg-open` with the checked address as one argument (`preview_open_in_browser`).

## Considered options

- **Detect it in the frame.** It isn't possible here. WebKitGTK reports neither `error` nor a readable location for a
  refused frame, and the console message isn't exposed to the app.
- **Fetch the page in Rust and show it from there, or strip the headers.** Rejected: that bypasses the site's own
  policy, and the page would run without its origin.
- **A separate native webview for web pages** (ADR 0007). It would show refused sites, but its costs are unchanged.
- **`tauri-plugin-opener`** for Open in your browser. Not needed for one `xdg-open` call. A command that accepts only
  checked http(s) addresses also gives the webview less than the plugin's permission set.

## Consequences

- Each web page opened or reloaded in the pane is requested twice: by the frame and by Rust's check. Rust's request
  sends no cookies.
- The check can disagree with the frame when a site answers the two requests differently, for example by cookie, by
  region or at random. If it wrongly finds a refusal, **Try showing it here anyway** loads the frame. If it misses
  one, the page stays white as before, with the note and the header button still offering the browser.
- A page that blanks itself with a script, or that needs a sign-in its frame can't keep (ADR 0007), still can't be
  told apart from a slow one.
- `frame-ancestors *` isn't counted as a refusal, though it may refuse the `tauri://` page. This wasn't tested
  against the packaged app.
- Open in your browser needs `xdg-open` (xdg-utils) and a default browser. If `xdg-open` fails within 3 seconds, the
  pane shows why. If it is still running then, the pane assumes it worked.
