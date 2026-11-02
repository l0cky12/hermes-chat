# Web preview: refused and unreachable sites (issue #55)

Captured on 2026-11-02 from the running Tauri debug app (WebKitGTK 2.54) on an Xvfb display. The app's page came
from the Vite dev server (`http://localhost:1420`), not the packaged `tauri://localhost` origin. The app was signed in
to a local stub dashboard based on `FakeHermes`; the chat and reply are fixture data. The web pages are the real
`https://www.google.com/` and `https://example.com/`, loaded live. `xdg-open` was replaced on the app's `PATH` with a
script that recorded its argument (`https://www.google.com/`), because the test display had no browser. These are
framebuffer captures cropped to the 1280 × 820 window. Nothing was composited or retouched.

- `1-google-refused.png`: Google answers `X-Frame-Options: SAMEORIGIN`, so the pane says so and offers the browser.
- `2-google-tried-anyway-stays-blank.png`: after **Try showing it here anyway**, the frame loads Google and WebKitGTK
  leaves it white. This is what issue #55 reported.
- `3-example-com-shows.png`: a site that allows framing still shows in the pane, with the note's browser link.
- `4-unreachable-site.png`: a port nothing listens on says **Couldn't reach** at once, instead of loading for 15 seconds.
