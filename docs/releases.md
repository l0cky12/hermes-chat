# Releases and standalone updates

Hermes Chat can update itself only as a standalone AppImage built with an update key. This page says which copies that covers, how a release is built, signed and checked, and what the owner still has to set up before the first real release. ADR 0075 records the decisions.

Nothing here publishes an AppImage. The repo has no AppImage release, signing key, update endpoint or `TAURI_SIGNING_PRIVATE_KEY` secret yet, so no installed copy updates itself today.

The Windows installer is published separately: pushing a `v<version>` tag makes the `windows-installer` workflow attach `hermes-chat_<version>_x64-setup.exe` and its `.sha256` to that tag's release, and the tag must match `tauri.conf.json`'s version (ADR 0080). Those releases carry no `latest.json`.

## Which copies update themselves

The app decides at runtime, in `src-tauri/src/update.rs`, in this order:

1. **A file pacman owns.** The app asks `pacman -Qqo` about the file it was installed as. Running from an AppImage, that is the AppImage itself (`$APPIMAGE`), because the binary runs from a temporary mount of it. Otherwise it's the binary. If a package owns that file, only the package manager replaces it. The updater never runs, even in an AppImage that carries an update key, so a package that ships the release AppImage is safe. The app asks pacman again right before a check and right before an install, in case a package took the file over while the app ran. Settings shows the package and its version, and for `hermes-chat-git` compares its commit with `main` (README, "Updates").
2. **A standalone AppImage built with an update key.** `$APPIMAGE` is set, the binary's bundle type is AppImage, and the build carries `plugins.updater`. Tauri's updater checks the endpoint, downloads the new AppImage, verifies its signature against the public key built into the app, and replaces the AppImage. The new version runs after the owner restarts.
3. **Anything else.** A source build (`npm run app`), a binary pulled out of an AppImage, an AppImage built without an update key, or a copy of the packaged binary somewhere pacman doesn't own. Settings says the copy isn't updated from here.

A build without `plugins.updater` (the PKGBUILD's, and every build that doesn't pass `src-tauri/tauri.release.conf.json`) doesn't register the updater plugin at all.

## Build configuration

`src-tauri/tauri.release.conf.json` is merged over `tauri.conf.json` for a release. It turns on the AppImage bundle and its updater artifacts, names the endpoint, and sets `requireSignedVersion`. Its `pubkey` is empty until the owner makes the production key. The dry run fills it with the throwaway key's public half in a copy, never in the file.

The private key never enters Git or a log:

- A dry run makes a throwaway key in a temporary folder and deletes it at the end. Its stdout is dropped, and in GitHub Actions every line of the key is masked before the build starts.
- The production key lives in the secret `TAURI_SIGNING_PRIVATE_KEY` of the `release-signing` environment, with its password in `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Neither exists yet. They are environment secrets, not repository secrets, so a job reads them only when it names that environment and a required reviewer approves the run. The workflow signs with them only on `main`. It writes the key to a file only the runner user can read, passes the CLI that file's path, not its contents, and deletes the file at the end of the job.
- `scripts/release/verify.sh` refuses a release folder that holds a private key, and `dry-run.sh` checks the staged folder for the key it signed with.

## Rehearse a release

The `release-dry-run` workflow (`.github/workflows/release-dry-run.yml`) runs on every pull request that changes it, `scripts/release/` or `tauri.release.conf.json`, and by hand from the Actions tab. It:

1. checks that `verify.sh` passes a good release and refuses broken ones (`scripts/release/verify.test.sh`);
2. builds the AppImage with the updater turned on and signs it (`scripts/release/dry-run.sh`);
3. stages the AppImage, its `.sig`, `latest.json` and the public key under `release/`;
4. verifies the staged folder with minisign, the way the app will, and checks that the AppImage is built for the target `latest.json` lists it under;
5. uploads `release/` as the workflow artifact `appimage-<signing>-<commit>`, kept for 14 days;
6. installs the staged AppImage with the app's updater, from a local server, into a copy that trusts the staged public key (`a_staged_release_installs` in `src-tauri/tests/update.rs`).

It never creates a tag, a GitHub release or any hosted file. The manual run's `signing` input picks `throwaway` (the default) or `secret`, which signs with the production key. `secret` fails until the owner has created the secret and put the public key in `tauri.release.conf.json`.

To rehearse locally, with `node_modules` installed and `minisign` on the `PATH`:

```sh
scripts/release/dry-run.sh                                    # a throwaway key
HERMES_CHAT_UPDATER_KEY=~/.tauri/hermes-chat.key \
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD=… scripts/release/dry-run.sh  # the production key
scripts/release/verify.sh release "$(cat release/updater.key.pub)"
```

`verify.sh` also checks a downloaded workflow artifact. Pass the public key from `tauri.release.conf.json`, not the one in the folder, when the folder came from somewhere you don't control.

## The manifest

`scripts/release/manifest.mjs` writes `latest.json` in Tauri's [static JSON format](https://v2.tauri.app/plugin/updater/#static-json-file):

```json
{
  "version": "0.2.0",
  "notes": "…",
  "pub_date": "2026-11-05T12:34:56Z",
  "platforms": {
    "linux-x86_64": {
      "signature": "<the .sig file's contents>",
      "url": "https://github.com/l0cky12/hermes-chat/releases/download/v0.2.0/hermes-chat_0.2.0_amd64.AppImage"
    }
  }
}
```

The version and target come from the AppImage's file name, which `tauri build` derives from `tauri.conf.json`. The staged name has no spaces, so it is safe in a URL. The script refuses a bundle folder with no AppImage, more than one, or no `.sig` beside it, so a stale or unsigned build can't be staged.

The manifest itself isn't signed. The signature covers the AppImage and, through `--app-version` (which `tauri build` passes), the version. With `requireSignedVersion`, the app refuses a manifest that announces a version other than the signed one. A manifest edited to pair a new version number with an older genuine AppImage fails.

## Choosing the version

A release raises exactly one number of `MAJOR.MINOR.PATCH`, picked from the biggest change merged since the last `v*` tag (`git log $(git describe --tags --abbrev=0)..main --merges`):

| Raise | When the release holds | Examples |
|---|---|---|
| **PATCH** (0.1.1 → 0.1.2) | Only fixes. Nothing new to find, nothing to relearn. | A crash or layout fix, a typo, a dependency update |
| **MINOR** (0.1.2 → 0.2.0) | Something a user would notice as new or different. | A new screen or tool, a setting added, a screen moved |
| **MAJOR** (0.2.0 → 1.0.0) | Something that breaks for someone already using the app. | Dropping support for a Hermes server version, local data or backups an older copy can't read, a setup that must be done again |

Below 1.0 everything shifts down one: a breaking change raises MINOR, everything else PATCH. 1.0.0 comes when the standalone AppImage updater ships with the production key, since from then on installed copies update themselves. A published version is never reused, and versions bump once per release, not per pull request.

To release:

1. On a branch from `main`, run `npm run bump -- patch` (or `minor`, `major`, or an exact version such as `1.0.0-beta.1`). It writes the new version into `src-tauri/tauri.conf.json`, `package.json`, `package-lock.json`, `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock`, and nothing else (`scripts/release/version.mjs`).
2. Commit as `Bump version to <version>`, with the merged pull requests it ships in the message, and open the pull request. CI fails when the five files disagree.
3. After it merges, tag that merge commit `v<version>` and push the tag. The `windows-installer` workflow stops before building when the tag doesn't match all five files.

## Version and channel rules

- Every release bumps `version` in `src-tauri/tauri.conf.json`, in semver, and the four other version files with it ("Choosing the version"). The tag is `v<version>`.
- The app offers a release only when its version is strictly greater than the running one. An older or equal version is never offered, so there are no downgrades through the updater. A prerelease (`1.0.0-beta.1`) sorts below its release.
- There is one channel, stable, at one endpoint. GitHub's `releases/latest` skips prereleases and drafts, so a prerelease published there is never offered. A beta channel would need its own endpoint built into beta builds, and isn't defined.
- One AppImage per architecture, named in `platforms` as `linux-<arch>`. Only `linux-x86_64` is built today. On an architecture the manifest doesn't name, the check fails with an error naming the missing target.

## Endpoint hosting

The endpoint is a requirement on the owner's hosting, not something the app provides:

- `https` only. A release build refuses a plain `http` endpoint. The tests' local server uses `dangerousInsecureTransportProtocol`, which no release config sets.
- It serves `latest.json` at the URL in `tauri.release.conf.json`, and every `url` in it serves the exact staged AppImage. The configured URL is `https://github.com/l0cky12/hermes-chat/releases/latest/download/latest.json`, which works once a GitHub release carries the staged files as assets.
- It answers with the newest release only. The app asks it at launch (unless the owner turned that off) and when the owner checks. No account, cookie or token is sent.
- Hosting is availability, not trust. A host that serves a tampered AppImage or an edited manifest makes the update fail, not install. A host that's down makes the check fail with an error, and the installed copy stays as it is.

## Key rotation and recovery

The app trusts exactly one public key, the one it was built with. A release signed with any other key is refused, as the wrong-key test shows. So the key can change only through a release signed with the old key.

**Planned rotation:**

1. Make the new key (`npx tauri signer generate -w ~/.tauri/hermes-chat-2.key`) and keep it, with its password, outside the repo and in an offline backup.
2. Bump the version, and in `tauri.release.conf.json` put the **new** public key in `pubkey` and a new endpoint file name in `endpoints`, for example `…/releases/latest/download/latest-2.json`. Commit that.
3. Build the bridge release signed with the **old** key, and verify it against the **old** public key, which is what installed copies trust:

   ```sh
   HERMES_CHAT_UPDATER_KEY=~/.tauri/hermes-chat.key TAURI_SIGNING_PRIVATE_KEY_PASSWORD=… \
     HERMES_CHAT_SIGNED_BY="$(cat ~/.tauri/hermes-chat.key.pub)" scripts/release/dry-run.sh
   cp release/latest.json release/latest-2.json
   ```

   `tauri build` warns that the key doesn't match `pubkey`. For a bridge, that is expected. `release/updater.key.pub` holds the old public key, and `verify.sh` has checked the staged AppImage against it.
4. Publish the bridge with both `latest.json` and `latest-2.json` pointing at it.
5. Replace the `release-signing` environment's secrets with the new key and password.
6. Every later release is built as usual with the new key, publishes its own `latest-2.json`, and attaches a copy of the bridge's `latest.json`, so a copy still on the old key always finds the bridge first.

**Lost key.** No installed copy can be updated through the updater again. Make a new key, publish a release signed with it, and tell owners to download that AppImage by hand. The README and release notes say so.

**Leaked key.** Anyone who also controls what the endpoint serves can push an update. Rotate at once as above, delete the leaked secret, and say in the release notes which versions trusted the leaked key. Copies that never reach the bridge keep trusting it, so they also need a manual download.

## The verification tests

`src-tauri/tests/update.rs` runs `tauri-plugin-updater`, the verifier the app ships, against a manifest and AppImage served from `127.0.0.1`. The artifact was signed with two throwaway keys, deleted after signing. Only their public halves and the signatures are in the file. It covers:

- a genuine release, installed in place with its mode kept;
- a tampered and a truncated AppImage, refused, with the installed AppImage untouched;
- a release signed with another key, refused by a copy that trusts key A and installed by one that trusts key B;
- a manifest without this computer's target;
- a manifest announcing a version the AppImage wasn't signed for, and a signature with no version;
- an older and the same version, not offered;
- a failed download, a download given up on, and an endpoint that doesn't answer, each leaving the AppImage alone;
- an AppImage a package owns, checked against a stand-in `pacman` script: one nothing owns is replaced, one already owned is refused and left alone, and one taken over during the download is left alone and installs once the package lets go;
- the folder a dry run staged, with `HERMES_TEST_RELEASE=<folder>`, installed into a copy at version 0.0.0. Without the variable it does nothing.

The `rust` CI job runs it. `scripts/release/verify.test.sh` covers the release scripts' own check, in the dry-run workflow: a genuine folder passes, and another key, an AppImage for another architecture, a tampered or truncated AppImage, a manifest announcing a version other than the signed one, a staged private key and a missing AppImage are each refused.

## Storage, servers and limits

- **Storage.** The updater holds the download in memory, verifies it, moves the running AppImage into a private temporary folder on the same file system as a backup, writes the new one in its place with the old mode, and deletes the backup. It needs free space for one more AppImage beside the old one, and write access to the AppImage's folder. Nothing else on disk changes. Drafts kept across the restart are ADR 0060's.
- **Hermes servers.** An update doesn't touch the Hermes server. Every server version the new app supports stays supported (`docs/compatibility.md`), and the updater has no notion of a server version.
- **Limits.** The tests use the real verifier with a local server, not a real host or a real AppImage swap under a running app. The dry run's real AppImage is installed through the updater's code, into a mock app, not by a running AppImage replacing itself. The manifest is unsigned, so a host can still offer an older signed release as long as it's newer than the running copy, or offer nothing. The updater has no cancel. Quitting the app drops a download, and the AppImage is replaced only after the whole download has verified. The updater checks only the signature, the signed version and that the file is an ELF. It doesn't check the architecture, so an AppImage for another architecture listed under this one would install and then fail to start. `verify.sh` refuses such a release before upload, and that check is the only one. A gzipped AppImage is accepted too (the updater's default `zip` feature), with the signature over the compressed file. The release scripts stage only plain AppImages.

## Left for the owner

These need a decision or a secret only the owner has, and none was exercised:

- Create the `release-signing` environment (Settings → Environments) with yourself as a required reviewer and `main` as its only deployment branch.
- Generate the production key, keep it offline, and set `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` as secrets of that environment.
- Put its public key in `src-tauri/tauri.release.conf.json`'s `pubkey`.
- Decide the hosting. The configured endpoint assumes GitHub releases on this repo.
- Add a publishing step (a tagged release with the staged files as assets), separately authorized. The dry run never publishes. It should attach to the same tagged release the Windows job does (ADR 0080), so the newest release carries both the installer and `latest.json`.
