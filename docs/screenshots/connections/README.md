# Connection manager verification — 2026-11-03

These are unedited native Tauri/WebKitGTK framebuffer screenshots at 1280×900 (the app window is 1280×820), taken under Xvfb on Debian 13. The app used the production Vite assets served to its development webview. The embedded-asset native build also passed. All names, credentials, drafts and chat text are synthetic.

- [Manager](manager.png): two saved connections deliberately named **Home**, distinguished by their addresses.
- [Recent picker](recent-picker.png): Bravo in use with its own draft.
- [Switch warning](switch-warning.png): a synthetic JSON-RPC Approval request injected into the native app's Tauri channel for a real resumed Alpha research chat. This verifies rendering and the Stay interaction; it is **not** evidence of a live provider-generated Approval or a surviving model run. No Approval answer or command was sent. Reload discarded the fixture.
- [Removal](removal.png): the local cleanup explanation before removing Bravo.

## Real-dashboard exercise

Two real Hermes dashboard processes from commit `bf0203a794` (Hermes 0.22.5), with separate temporary homes and different basic-auth passwords, listened at `http://127.0.0.2:9881` and `:9882`. Both had `default` and `research` profiles. The isolated app used a private DBus Secret Service session with an unlocked, in-memory GNOME keyring collection. No production Hermes data or desktop keyring was changed.

1. Added both Home connections through Setup, tested each against its dashboard, saved and connected. Each got a distinct UUID.
2. Entered “Draft only for alpha” and “Draft only for bravo” in the respective default profiles. Switched both ways: each draft returned. Reloaded Bravo: its draft returned. Reads of the two keyring slots confirmed that each matched its own password (only boolean results were recorded).
3. Switched Alpha to research, entered “Alpha research draft”, switched to Bravo and back. Alpha reopened research with that draft; Bravo reopened default with its own draft. Opened Alpha's synthetic research chat and read its real transcript.
4. Removed active Bravo. The app showed **Pick a saved connection, or set up a new one**, with no selection. Bravo's UUID and draft were absent from local storage, and its password load returned null. Selected Alpha and connected using its retained password: research and “Alpha research draft” returned.
5. Queried the isolated server databases immediately before and after removal. Their chat IDs and message counts were unchanged:

```text
a default  [('hc88-a-default', 0)]
a research [('hc88-a-default', 0), ('hc88-a-research', 2)]
b default  [('hc88-b-default', 2)]
b research [('hc88-b-default', 2), ('hc88-b-research', 2)]
```

Synthetic chats were seeded directly into these temporary databases; no model provider was configured. Resuming a chat read the transcript but Hermes reported that it could not initialize its assistant. This run therefore does not verify live model execution, remote-run survival, gateway/CLI work, real Approval expiry, SSH routing, external authentication gateways, Wayland or audio hardware. Automated protocol tests cover pending work, Approvals, late responses, queues, screenshot outboxes, headers, migration, bad keyring values and switch races. Canonical session authority remains unsupported, as documented in the main README.

## Commands and actual output

Node 24.22.1 was used (the host's Node 20 cannot start this installed jsdom/undici version). Frontend checks ran in the worktree. Rust checks and the native build ran on the test server with `CARGO_TARGET_DIR=/tmp/hc88-verification/target`, `CARGO_BUILD_JOBS=3`, and dev/test debug info disabled to avoid adding Rust artifacts to the shared workstation's nearly full disk.

```text
npm run build
> tsc --noEmit && vite build
✓ 2601 modules transformed.
✓ built in 486ms
(existing warning: chunks larger than 500 kB)

npm test -- --maxWorkers=2
Test Files  94 passed | 1 skipped (95)
Tests       2163 passed | 5 skipped (2168)
Duration    61.63s

cd src-tauri
cargo test --lib --test transport --test media --test screenshot
lib:        22 passed; 0 failed
media:       4 passed; 0 failed
screenshot: 19 passed; 0 failed
transport:  91 passed; 0 failed
```

The final transport run includes `a_password_never_follows_a_cross_origin_307_or_308_without_extra_headers ... ok`. Remote file timestamps were refreshed before that run to invalidate a stale test binary after copying the source.

`cargo build --features tauri/custom-protocol` also passed. There is no configured lint command.

A separate Codex reviewer used exactly **gpt-6.1-sol / High reasoning** in three review rounds. Nine actionable findings were fixed: sign-in transport races, failed-write/screenshot retention, legacy Failed messages, model pick isolation, Setup leave guards, persona cleanup suffixes and memory, Setup chat restoration, failed-removal recovery, and sign-in during pending removal. The final busy-removal regression and the full suite above passed after the fixes.

## Integration with current main

Main merged Server files download/upload/edit while this PR was being prepared. Its transfer cancellation and commands were retained, and this feature's ADR was renumbered to 0025; a later merge of main renumbered it again, to 0049 (now 0112), because main had taken 0025 for the context inspector and 0048 for the chat header. After resolving the mechanical Rust insertion conflict, checks were rerun:

```text
npm run build: passed (2604 modules, existing chunk warning)
npm test -- --maxWorkers=2
Test Files  95 passed | 1 skipped (96)
Tests       2213 passed | 5 skipped (2218)
Duration    65.37s

cargo test --lib --test transport --test media --test screenshot
lib:        23 passed; 0 failed
media:       4 passed; 0 failed
screenshot: 19 passed; 0 failed
transport: 100 passed; 0 failed
cargo build --features tauri/custom-protocol: passed
```

Review rounds were 1/3 (five findings), 2/3 (three), and 3/3 (one). All nine were addressed with regression checks before main's updated AGENTS.md arrived. No fourth review was started under its three-round limit. The subsequent mechanical integration was inspected locally and tested as above; a Claude integration task was attempted under the new workflow but its API was rate limited. There is no independent review verdict for that integration.

The final merged binary was then launched with embedded assets (`tauri://localhost`) in the isolated native session. From its fresh production origin, Setup tested Alpha, Save and connect succeeded, and the main screen showed Connected. This was a production-binary smoke check; the two-connection restoration/removal exercise above used the development origin.
