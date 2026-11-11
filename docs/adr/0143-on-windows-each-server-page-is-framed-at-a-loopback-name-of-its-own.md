# On Windows each server page is framed at a loopback name of its own

Every server page (ADR 0114) is served on this computer at `127.0.0.1`, each on its tunnel's own port. Cookies don't tell ports apart. On Linux each page has a WebKit context of its own (ADR 0081, #404). On Windows the page is a frame in the app's one WebView2, and ADR 0007 assumed that a framed page gets no cookies. That assumption came from WebKitGTK and was not checked on WebView2 (#430).

Chromium, the engine in WebView2, was checked on 2026-11-11 (Chromium 156, run both with default flags and with wry's flags). Two pages on two `127.0.0.1` ports were framed in a parent page on another site, with the Preview's exact sandbox (`allow-scripts allow-forms`, which gives an opaque origin). The cookie that page A set with `SameSite=None; Secure` reached page B in B's `Cookie` request header. Chromium treats loopback as secure, so `Secure` cookies work over http there. Cookies set with `SameSite=Lax`, or with no `SameSite` attribute, did not reach B. The opaque origin blocks `document.cookie` (it throws `SecurityError`), but it does not stop cookies from being stored or sent. So a server page could set a cookie that every other server page then received, whatever SSH target it came through.

## Decision

- **On Windows each server page's tunnel is given at a name of its own under `localhost`.** The name is `p` and 16 hex digits, followed by `.localhost`. It is a hash of the page's jar (`server_page::Jar`: its SSH target and its origin on the server). The hash is keyed afresh each run. Chromium resolves every name under `localhost` to loopback (RFC 6761), so the frame still reaches the tunnel on `127.0.0.1`. Cookies do tell host names apart, and Chromium counts each such name as a site of its own, so a page can't set a cookie that another page gets.
- **A page opened again in the same run gets the same name**, so it gets its cookies back, as on Linux.
- **A new run gives a page a new name.** WebView2 keeps cookies on disk, but they are stored under the old run's names, which no page uses again. So a sign-in lasts only the run, as ADR 0081 chose for Linux.
- **Linux is unchanged.** Its pages stay at `127.0.0.1`, and their jars stay WebKit contexts.
- **The framing check (ADR 0011) resolves a name under `localhost` to loopback itself.** Not every system resolver does this, and some return only `::1`, where the tunnel doesn't listen.
- **The webview loads a tunnel address only at `127.0.0.1` or at a name of this exact shape** (`tunnelUrl`).

## Considered options

- **A WebView2 of its own for each page, or a WebView2 profile for each page.** This would match Linux, but ADR 0007 rejected a native child webview on Windows: it needs Tauri's `unstable` multi-webview feature, and it would draw over the app's menus.
- **A WebView2 flag that blocks or partitions third-party cookies.** No stable flag was found. Partitioning by top-level site would not help anyway, because every page has the same top-level site, the app.
- **Removing cookies from the frame's requests** with WebView2's `WebResourceRequested` event. This means native code on the request path of every page, and it would break sign-ins that the frame can keep today.
- **A name that stays the same across runs.** It would keep sign-ins on disk without the owner asking, which ADR 0081 declined.
- **A counter (`p1`, `p2`) in place of a hash.** The cookies kept on disk would reach whichever page got the same number in the next run.

## Consequences

- On Windows a server page sees its own address as `http://p….localhost:<port>`, and the server receives that as the `Host` header. Vite accepts any name under `.localhost` by default. A dev server that checks `Host` against a fixed list can refuse the page until that list includes `.localhost`.
- "Open in your browser" opens the same address. Browsers that resolve names under `localhost` themselves (Chromium, Edge) reach it.
- ADR 0007's statement that framed pages get no cookies holds for WebKitGTK only. In WebView2 a framed page keeps `SameSite=None` cookies under its own name.
- Cookies that earlier runs stored under `127.0.0.1` stay in the WebView2 profile, and no server page is served there any longer.
