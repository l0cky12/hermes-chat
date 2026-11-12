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

Run `npm run check` after every code change, before committing. It runs the CI checks that most often fail a PR: unique ADR numbers (`scripts/check-adrs.mjs`, which also prints the highest number in use), `cargo fmt --check`, `npm run build`, the test suite, and `cargo clippy --all-targets -- -D warnings`. A failing check is a blocked task, not a note in the PR body.

The suite runs here as `npm run test:local`, which is `vitest run` with two workers, so a full run doesn't time out on a loaded machine. CI keeps `npm test`. If a file still times out, rerun it alone with `npx vitest run <file> --maxWorkers=1`.

Turn on the pre-commit hook once per clone (all worktrees share it): `git config core.hooksPath .githooks`. It refuses a commit that stages Rust when `cargo fmt --check` fails.

### Releases

A release is a `v<version>` tag on `main` plus its GitHub release (`docs/releases.md`). Attach every installer and package built for that version (`.exe`, `.deb`, `.rpm`, `.AppImage`, …) to that one release, each with a `.sha256` beside it. Today `windows.yml` builds and attaches only the Windows `.exe`, on the tag. A change that adds a bundle format also adds the step that attaches it to the tagged release.

When asked to release or bump the version, follow `docs/releases.md` "Choosing the version": pick patch, minor or major from what merged since the last tag, run `npm run bump -- <level>`, and open a `Bump version to <version>` PR naming the level and why. Ordinary PRs leave the version alone.

### Merge authority

Agents open and update PRs but never merge to `main`. Merging is human-only.
