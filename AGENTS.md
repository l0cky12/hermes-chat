# hermes-chat

Personal Tauri 2 + React + TypeScript desktop chat client for a remote Hermes Agent, built for Arch Linux.

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues on `l0cky12/hermes-chat`, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.



### PR conventions

- Reference the correct `docs/adr/` file name; verify it exists before opening the PR.
- Attach screenshots to the PR for any UI change.
- Link the issue with `Fixes #N`.
- Never report a test as passing unless you ran it. If a step can't run (no server, no UI), say exactly why instead of faking it.

### Verify before PR

Run the build and test suite after every code change, before committing. A failing build is a blocked task, not a note in the PR body.

### Releases

A release is a `v<version>` tag on `main` plus its GitHub release (`docs/releases.md`). Attach every installer and package built for that version (`.exe`, `.deb`, `.rpm`, `.AppImage`, …) to that one release, each with a `.sha256` beside it. Today `windows.yml` builds and attaches only the Windows `.exe`, on the tag. A change that adds a bundle format also adds the step that attaches it to the tagged release.

When asked to release or bump the version, follow `docs/releases.md` "Choosing the version": pick patch, minor or major from what merged since the last tag, run `npm run bump -- <level>`, and open a `Bump version to <version>` PR naming the level and why. Ordinary PRs leave the version alone.

### Merge authority

Agents open and update PRs but never merge to `main`. Merging is human-only.
