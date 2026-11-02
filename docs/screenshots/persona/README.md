# Persona (SOUL.md) screenshots

Captured on 2026-11-02 from the running Tauri debug application (WebKitGTK) on an Xvfb display, 1280 × 820. The app
was signed in by URL to a real Hermes dashboard: the deployed `bf0203a` checkout on the Hermes server, started for this
check with a throwaway `HERMES_HOME`, a throwaway basic-auth login and bound to `127.0.0.2:9193`, reached through an SSH
tunnel. No fixture or fake server is involved. The personas are synthetic test text; no real profile's SOUL.md was read
or written. The "edit in another client" was a `printf` into the file on the server, and the permission and missing-file
states were made with `chmod 000` and `mv` on that throwaway home. No visual elements were composited or retouched.

- `1-persona.png`: the Persona tab with the server, profile and file path, when edits take effect, and SOUL.md as Hermes has it.
- `2-editing.png`: an unsaved Markdown edit.
- `3-leave-asks.png`: Back to chat with an unsaved edit asks first.
- `4-saved.png`: saved and read back from Hermes; the version it replaced is under Earlier versions.
- `5-conflict.png`: SOUL.md changed on the server after editing started, so Save wrote nothing and shows what Hermes has.
- `6-overwrite-asks.png`: saving over the other version asks first.
- `7-earlier-version.png`: the version that save replaced, to copy or put back in the editor.
- `8-permission.png`: Hermes may not read the file (`[Errno 13] Permission denied`).
- `9-missing.png`: the profile has no SOUL.md; creating one is an explicit choice.
