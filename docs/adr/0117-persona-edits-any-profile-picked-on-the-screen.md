# Settings → Persona edits any profile's SOUL.md, picked on the screen

Settings → Persona edited only the profile the app was using (ADR 0014). The owner wants to edit the persona of every profile on the server without switching the app to it first. Hermes's persona routes, `GET` and `PUT /api/profiles/{name}/soul`, already take any profile name, and `PersonaApi` already names the profile on every call. So this is a screen change.

## Decision

- **A picker at the top.** The Profile line under the heading is a select of every profile `GET /api/profiles` lists, in Hermes's order, with the profile in use first and marked "(in use)". It starts on the profile in use, and starts there again when the app switches profile or connection. If the list can't be read, the profile in use is still offered and edited, and the screen says the list failed, with Try again.
- **Picking doesn't switch the app.** Picking a profile changes only what this screen edits. When the picked profile isn't the one in use, the screen says that chats started in the app keep the in-use profile's persona, and this one is for chats on the picked profile, in any Hermes client.
- **One editor per profile.** Each picked profile gets an editor of its own (`PersonaSettings`, keyed by `personaKey(connection, profile)`), as switching the app's profile already did. Its unsaved edit, the versions saves replaced and a save under way stay with that profile in `PersonaStore`, so switching never mixes edits. Every check of ADR 0014 applies per profile unchanged: read before writing, write only if unchanged, read back.
- **Asks before switching away from an unsaved edit.** Picking another profile while the editor holds an edit Hermes doesn't have, or a save under way, asks first with the same dialog as leaving the screen (`LeavePersona`, "Open another profile's persona without saving?"). Going on keeps the edit on this computer, and the profile's editor offers it back when it is picked again. Leaving Settings, switching the app's profile, signing out or closing the window name the picked profile in their question.
- **The notes are the picked profile's.** File path, profile distribution, "a chat already under way keeps its persona" and the missing-file text all name the picked profile. A profile with no SOUL.md shows as empty and can be created, as before.

## Considered options

- **A side list of profiles (the sub-nav Memory uses).** Rejected for now: Persona is one editor that wants the full width, and a select keeps the editor where it was. A server with many profiles still fits in a select.
- **Keep every picked profile's editor mounted, so switching never asks.** Rejected: unsaved edits are already kept on this computer, and asking matches every other way of leaving an edit. Keeping hidden editors alive would also keep their reads and saves running unseen.
- **Switch the app's profile when a persona is picked.** Rejected: the issue asks for the opposite, and switching reconnects and moves the chat list.

## Consequences

- Any profile's SOUL.md can be read, created and saved from Persona, with the same guarantees as the profile in use.
- The profile list is read when Persona opens (and again when the connection comes back after a failed read). A profile created on the server while Persona is open shows after Persona is opened again.
- Names `GET /api/profiles` lists that aren't Hermes profile ids are left out, since the persona routes would refuse them.
