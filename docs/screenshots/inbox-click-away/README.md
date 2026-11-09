# Inbox click-away, rail and tab strip screenshots (ADR 0116)

Captured on 2026-11-05 from the running Tauri debug build (WebKitGTK) on an Xvfb display, 1280 × 820, signed in to the
`FakeHermes` stand-in dashboard in `bridge.ts` on loopback. Chats, the `work` profile and its waiting Approval are
fixture data; no real model or user data is shown. Clicks are real xdotool clicks. Framebuffer captures, not retouched.

Before (unmodified `main`, 0e8c7bf):

- `before-1-rail-and-split-buttons.png`: the rail's Work group (Server files, Outputs, Repository, Terminal) above
  Server, and Split right and Split down at the tab strip's right end.
- `before-2-inbox-stays-over-logs.png`: the Inbox open, then Logs clicked on the rail. Logs opened underneath, and the
  Inbox stayed over it.

After:

- `after-1-rail-and-tab-strip.png`: one Server group (Outputs, Repository, Scheduled jobs, Automations, Logs, Usage);
  no Server files or Terminal button; no split buttons on the tab strip.
- `after-2-inbox-open.png`: the Inbox open over the chat.
- `after-3-logs-closes-inbox.png`: Logs clicked on the rail: Logs opens and the Inbox closes.
- `after-4-chat-click-closes-inbox.png`: the Inbox opened again, then a click on the chat: it closes.
- `after-5-side-panel.png`: the chat header's side panel button: Preview, Terminal, Files and Screen.
