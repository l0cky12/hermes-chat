# Idle compaction (ADR 0119)

Captured on 2026-11-04 from the running Tauri debug app (WebKitGTK, frontend embedded) at commit `2f99487`, on an
Xvfb display at 1280 × 820, with its own `HOME`, XDG folders and D-Bus session, so nothing touched a real profile or
keyring. The app signed in by URL to `bridge.ts` in this folder. The bridge is a loopback stand-in for the Hermes
dashboard, served by the tests' `FakeHermes`, with synthetic chats. It is **not** a real Hermes server, and no model ran.
Its chat reports a context window 82% full with a compactor (`session.info.usage`), and `session.compress` answers
with fixed counts. Everything Hermes Chat shows and does is the real app: the setting, the idle timer, the call to
`session.compress` and the toast. No visual element was composited or retouched.

One change was applied to the build and not committed: PR #198's selector fix (`.field select` →
`.field select:not(.select)` in `src/styles.css`). On `main`, every picker on Settings → Model renders its text cut off
in WebKitGTK, and the new pickers here sit in the same kind of field, so without it they show blank. PR #198 fixes it
for the whole page.

- `1-settings-off.png`: Settings → Model, at the foot of the page. Idle compaction is off, as it starts; the mark
  (70%) and idle time (15 minutes) wait, dimmed, until it's on.
- `2-mark-choices.png`: turned on, the mark's choices open (50–90% full).
- `3-settings-on.png`: on, at 80% full after 5 minutes idle.
- `4-chat-at-82.png`: the stand-in's chat opened from the Settled drawer at 19:15:31. The status bar's meter reads
  82% full, past the mark.
- `5-compacted-toast.png`: 19:20:51, with nothing touched since. The app found the chat idle 5 minutes past the
  mark, had Hermes compact it, and the toast reports Hermes's own token estimate. The chat on screen is unchanged:
  every message stays in the transcript.
- `6-not-again.png`: 19:22:56. Frames every 3 seconds from 19:20:51 to here show no second compaction, though the
  meter still reads 82% (Hermes sends no new measure until the next reply).
