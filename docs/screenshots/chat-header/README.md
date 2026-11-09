# Chat header screenshots (issue #173)

Captured on 2026-11-04 from the running Tauri debug build (WebKitGTK) on an Xvfb display, signed in to a throwaway
Hermes 0.22.6 dashboard on loopback with seeded chats (`setup/`). Chats and replies are fixture data; no real model or
user data is shown. "Before" is the build of `main` at 93f7b14; "after" is this branch. Framebuffer captures of the
1280 × 820 window, cropped where named; nothing retouched. Native tooltips don't appear under Xvfb, so none are shown.

- `1-before.png`, `1-before-header.png`: eight unlabelled icon buttons after the usage chip.
- `2-after.png`, `2-after-header.png`: the side panel, Find in chat and More (⋯) on the bar; Split right and Split down
  at the end of the tab strip.
- `3-more-menu.png`: More opened with the mouse: Export as Markdown (now named Export…), Copy chat link, Settle, Archive.
- `4-more-menu-keyboard.png`: More opened with Enter after Escape returned focus to it; Down Down moved to Settle.
- `5-split.png`: split right; each pane's close button sits at the end of its own tab strip.

To redo them: `setup/dash.sh`, then `setup/start-app.sh <hermes-chat binary>`, then `setup/signin.sh`.
