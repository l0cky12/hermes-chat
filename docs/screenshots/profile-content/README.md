# Skills, Memory and Persona for any profile (ADR 0118)

Captured on 2026-11-04 from the running Hermes Chat debug build (WebKitGTK, frontend embedded) built from this branch, on an Xvfb display at 1400 × 900 with openbox. Nothing was composited or retouched.

The server was a real Hermes dashboard at `f0d94882` (the deployed build), run from a throwaway `HERMES_HOME` on `127.0.0.6`, with two profiles, `default` and `spare`, and synthetic skills, memory and SOUL.md files. The app signed in to it by URL. Every action below went to that dashboard, and its effect was checked in the server's files afterwards (`skills/.archive/`, `profiles/spare/skills/`, `memories/MEMORY.md`, `SOUL.md`).

GTK draws a `<select>`'s open list in a popup that renders black without a compositor, so the lists were picked with the keyboard and only their result is shown.

- `01-skills-picker.png`: Settings → Skills on `default`, the profile list in place of its name, marked "(in use)".
- `03-skills-spare.png`: the same tab showing `spare`, while the app itself stays on `default` (sidebar). Its two Local skills came from the move in 07.
- `04-skills-selected.png`: Select mode with two Local skills and one built-in picked; the note says why Move and Delete leave the built-in out.
- `05-skills-move-ask.png`: Move to…: the target profile, what happens, and that only SKILL.md travels.
- `06-skills-move-refused.png`: a move Hermes refused: `deploy-checklist`'s 71-character description is over the 60 Hermes allows for a new skill. Its reason is shown, and the original stayed (nothing in `.archive`).
- `07-skills-moved.png`: a move that worked: both copies read back in `spare`, both originals archived in `default`; the built-in stays picked, with Move and Delete off.
- `08-skills-delete-ask.png`, `09-skills-deleted.png`: Delete, which archives, with how to restore on the server.
- `10-memory-spare.png`: Settings → Memory showing `spare`'s MEMORY.md, through the profile-scoped `/api/learning/*` routes.
- `11-memory-delete-ask.png`, `12-memory-deleted.png`: two entries removed at once, each read back; `default`'s memory was untouched.
- `16-persona-picker-spare.png`: Settings → Persona showing `spare`'s SOUL.md and its path.
- `13-persona-copy-ask.png`, `14-persona-copied.png`: copying `default`'s SOUL.md over `spare`'s, after showing both sizes.
- `15-persona-spare-earlier.png`: `spare`'s Earlier versions keep what each copy replaced (the 663-character one is from an earlier run of the same check).
