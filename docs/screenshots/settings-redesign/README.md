# Settings sub-navigation screenshots (#187, ADR 0113)

Captured on 2026-11-04 from the running Hermes Chat debug build (WebKitGTK, frontend embedded) on an Xvfb display at 1920 × 1080 with openbox, the window full screen. Nothing was composited or retouched. The app was signed in by URL to the repo's `FakeHermes` stand-in on loopback (`bridge.ts` in this folder), seeded with synthetic profiles, skills, memory entries, memory providers and a persona, so nothing here came from a real server.

Bundle and run the stand-in with:

```
npx rolldown docs/screenshots/settings-redesign/bridge.ts --platform node -o /tmp/settings-bridge.mjs && node /tmp/settings-bridge.mjs 47898
```

## Before: `main` at 6017fa6

Each tab at the top, then each further screen it scrolls to at 1080p.

- `before-general-top.png`, `before-general-voice.png`, `before-general-2.png`, `before-general-3.png`: General, four screens.
- `before-memory-1.png` to `before-memory-3.png`: Memory, three screens; External memory lists every profile's provider in a row.
- `before-skills-1.png` to `before-skills-3.png`: Skills, three screens; `code-review`'s description wraps Edit and the switch under the text.
- `before-model-1.png` to `before-model-3.png`: Model, three screens.
- `before-toolsets-1.png`, `before-toolsets-2.png`; `before-diagnostics-1.png`, `before-diagnostics-2.png`; `before-persona-1.png`; `before-appearance-1.png` to `before-appearance-3.png`.

## After: this branch

- `after-general-connection.png`: General opens on the Connection group beside the sub-nav column.
- `after-general-launch.png`, `after-general-voice.png`, `after-general-storage.png`: the other three groups, each one screen.
- `after-general-search.png`: with "cache" in the search box, every group's sections show together, as before.
- `after-memory-notes.png`: Memory opens on Agent notes; the list beside it holds the two files and every profile.
- `after-memory-profile.png`: the `research` profile picked; its provider form beside the list, the all-profiles table folded.
- `after-skills.png`: one-line rows, Edit and the switch at the end of every row.
- `after-skills-hover.png`: the pointer resting on `code-review`'s description shows the whole text.
- `after-model.png`, `after-toolsets.png`, `after-persona.png`, `after-diagnostics.png`, `after-appearance.png`: the other tabs, each one screen (Appearance unchanged, scrolls as before).
- `after-min-size.png`: the window at its minimum, 760 × 500: the sub-nav becomes a row above the content.
