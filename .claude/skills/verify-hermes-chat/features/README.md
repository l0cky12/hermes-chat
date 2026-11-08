# Hermes Chat verification map

This folder is the maintained source for verifying what the owner sees and does in the Hermes Chat desktop app. Read this index before driving the app, then use the matching feature file as the recipe. The harness is `wd.mjs` (WebDriver into the real Tauri window) plus `hv` (launch, doctor, screenshots, stand-in state). Both are documented in [../SKILL.md](../SKILL.md).

## Baseline preconditions

- Start from a fresh run: `hv up` (stand-in dashboard), then `wd.mjs open`. The app has empty `HOME` and `XDG_*` dirs, a private D-Bus with no keyring, and its own display.
- `hv doctor` shows `ok` on every line, including `build … matches the source`.
- Unless a recipe says otherwise, sign in first by following [sign-in.md](sign-in.md) to its signed-in end state.
- The stand-in serves profile `default` with four seeded chats, all Settled (in the drawer at the list's foot), a SOUL.md and six own skills such as `restic-unlock` (for Clone a profile), and an empty second profile `work` (both with synthetic MCP servers, see [mcp-servers.md](mcp-servers.md)):
  - `backup`, "Nightly backup failing". The reply mentions `restic unlock`.
  - `nginx`, "Rotate nginx logs".
  - `vpn`, "Why is the VPN slow". The reply mentions `MTU = 1380`.
  - `trip`, "Plan a weekend in Lisbon".
- Every Bash call starts with `S=$(git rev-parse --show-toplevel)/.claude/skills/verify-hermes-chat/scripts; export HV_RUN=<from hv up>`.

## Driving conventions

- Find handles with `wd.mjs handles` on each new screen. Prefer aria-labels, `<label>` text and button text, then the app's data attributes and classes. Never use coordinates.
- Drive only with `click`, `fill`, `select`, `press` and `keys`. Use `eval` only to read state.
- Use `wait` and `gone` instead of `sleep`. The reply stream, sign-in and search are all asynchronous.
- Treat every command as literal. Quoted names are the app's exact text, and they are case-sensitive.
- A run's chats and messages live on its own stand-in, so a mutation needs no restore: `hv down` discards it.

## Proof and skip reporting

- Capture the action and its result. Take numbered `wd.mjs shot` images before and after (`hv shot` when the window frame or a native dialog matters), and assert the end state with `wait` or `text`.
- Changes on the server are proved by reading them back with `hv state` (or the real dashboard's API). Persistence in the app is proved by reopening the screen, or by relaunching with `wd.mjs close` then `wd.mjs open` and signing in again.
- Report every entry point the feature lists. A path you couldn't reach is reported with the command you tried and the precondition that was missing, never as verified through a different path.
- Evidence stays in `~/.cache/hermes-verify/evidence/<run>/` after `hv down`.

## Feature entry contract

Each feature file starts with an H1 and one paragraph describing the behaviour the user sees. Then come exactly four H2s, in this order: `Sub-features` (short IDs), `How to get to it (user POV)` (every entry point), `Driving it with wd.mjs` (`Preconditions:`, then labelled bullets pairing each user action with exact commands and the result you can see), and `Gotchas`. Leave implementation details out.

## Features

- [Sign in](sign-in.md): first-run setup for a web address connection, a wrong password, and signing in again after a relaunch.
- [Send a message](send-message.md): open a chat, send, watch the streamed reply, and confirm both messages on the server.
- [New chat](new-chat.md): start a chat from the rail, the list panel or Ctrl+N, and see it created on the server and in the list.
- [MCP servers](mcp-servers.md): Settings → MCP servers: list, test, add, edit with write-only secrets, remove, switch, OAuth sign-in, catalog, another profile.
- [Gateways](gateways.md): Settings → Gateways: Telegram and Discord state, token replace and remove with read-back, the switch, a turned-down token, a missing library, a change on the server meanwhile, Check status.
- [Search chats](search.md): Ctrl+K or the rail opens search, a body-text match opens its chat, and a miss shows No matches.
- [Chat list](chat-list.md): the Settled drawer at the foot (open, close, its own scroll, kept across a relaunch), Settle and Unsettle from the menu, Up and Down into the drawer, and Archived in the scroll, with the `HV_LIST=24` seed.
- [Rail inbox](rail-inbox.md): opened as the tray's Open Inbox is (an emitted event), then Check now, Clear done, and auto-dismissing old completed entries, with the `HV_INBOX=1` seed.
- [Launch on the saved chats](launch.md): a relaunch over a slow stand-in shows the saved list at once, Connecting, and a wrong saved password goes back to Sign in. Needs a throwaway keyring.
- [Connections](connections.md): Settings → General → Connection, Test a saved connection, and Sign out.
- [Approval mode](approval-mode.md): the composer's pill: Smart, Manual, YOLO with its warning, "YOLO · all chats", and the narrow face, against the real Hermes in `~/.cache/hermes-live-277`.
- [Office](office.md): the building and List, three agents typing, the card, the frame counter, unfocused and at-rest frames, CPU, and the List a computer without WebGL gets.
- [Dispatched work](dispatched-work.md): a reply that dispatches a kanban task or background subagents keeps its chat in Working with the waiting icon, the wake turn, the Inbox hand-off, a blocked task, Stop waiting, the Rail inbox and Office states, and a relaunch rebuilt from the board.
