# Settings → Profiles screenshots (#447)

Taken from the real app (`verify-hermes-chat` skill, display `:150`, 1280 × 820) against a throwaway Hermes v0.22.6
(`f0d94882`) dashboard. All data is synthetic.

1. `dash.sh` starts the dashboard on `127.0.0.2:21550` with its own `HOME`/`HERMES_HOME` (a `git worktree` of
   `~/.hermes/hermes-agent` at `f0d94882`, with `hermes_cli/web_dist` symlinked from the installed checkout).
2. `seed.sh` makes `coder`, `research` and `scratch` through Hermes's own `POST /api/profiles`, and gives `coder` a model.
3. `gateway.sh` runs the host gateway from `default`. Hermes v0.22.6 gives named profiles no gateway of their own: the
   host gateway serves them, so every row lists "Gateway running".
4. `signin.sh` goes through Setup with a Web address route.

Then, in Settings → Profiles: New profile (a taken name, then `notes`), Edit on `reviewer` reached with the arrow keys and
Enter (the rename's gateway warning), Edit on `default` (Display name), the row menu opened with Shift+F10, Delete on
`research` with the Delete key and the typed name, Write for me (Hermes's own failure reason: the throwaway server has
no real model key), and deleting `papers` while it was in use (the app switched to `default` first).

Each change was read back from the server with `GET /api/profiles` and the profiles folder: `papers` created with its
model, description and SOUL.md; `coder` renamed to `reviewer` (folder moved); `default`'s `display_name` set to `Main`;
`scratch`, `research` and `papers` deleted (folders gone).
