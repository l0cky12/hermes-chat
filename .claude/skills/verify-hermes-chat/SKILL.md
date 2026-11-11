---
name: verify-hermes-chat
description: Launch the real Hermes Chat Tauri desktop app headless (Xvfb + tauri-driver WebDriver) against an isolated stand-in or real Hermes dashboard, drive it by CSS selectors and visible text, and capture screenshots plus server-side proof. Use to prove a UI change works in the real app, reproduce a bug a user would see, or take PR screenshots.
---

# Verify Hermes Chat

The surface is the desktop window: a WebKitGTK webview in a Tauri shell, where Rust does all network traffic to the Hermes dashboard. This skill drives that real binary through WebDriver (`tauri-driver` → `WebKitWebDriver`), so clicks and key presses are real input and every request crosses the real Rust boundary. The only stand-in is the Hermes dashboard on the far side of that boundary.

Other surfaces, for completeness: `npm test` (Vitest + jsdom against `FakeHermes`), `tools/shots/` (the React app in headless Chromium with an in-page fake, no Rust, good for layout shots only), and `bench/` (long-chat performance). None of them is proof that the desktop app works.

All helpers live in `scripts/` beside this file. Every Bash call starts a fresh shell, so begin each one with:

```sh
S=$(git rev-parse --show-toplevel)/.claude/skills/verify-hermes-chat/scripts; export HV_RUN=<the path hv up printed>
```

## 1. Bootstrap and build

```sh
$S/hv bootstrap   # once per machine: Xvfb, xwd, xdotool, openbox, WebKitWebDriver, tauri-driver 2.1.0
$S/hv build       # npm ci if needed, npm run build, cargo build --features tauri/custom-protocol --bins
```

- `bootstrap` uses system tools when present. On Debian without sudo it `apt-get download`s the packages and unpacks them under `~/.cache/hermes-verify/root`. On Arch it needs `xorg-server-xvfb` and `xdotool` installed, and fetches `webkitgtk-6.0` (which holds `WebKitWebDriver`), `openbox` and `xorg-xwd` from pacman's mirror, checks each against pacman's sync database, and unpacks them there. Done when it prints `hv: bootstrap ok`.
- `build` embeds the frontend in the binary (no Vite port to fight over) and writes to `~/.cache/hermes-verify/target` (`HV_TARGET` overrides). It stamps the build with the source revision, including uncommitted edits to `src/`, `src-tauri/` and the frontend config. Done when it prints `hv: built … from <rev>`.
- A first build from an empty target takes many minutes. To speed it up, seed the target with hard links from a recent one on the same filesystem: `mkdir -p T/debug && cp -al <old target>/debug/{deps,build,.fingerprint} T/debug/`. Use hard links only within `~/.cache`, because `/tmp` is a different filesystem.
- Rebuild after every code change before you prove it. `hv up` warns and `hv doctor` fails when the build is stale.

## 2. Launch

```sh
$S/hv up                          # stand-in dashboard (default)
$S/hv up --dashboard http://127.0.0.4:47242   # a real Hermes dashboard you started (see below)
```

`hv up` starts, each in its own process group: Xvfb on a free display from `:140` upward (1400×900; a display counts as ours only once our Xvfb holds its lock, so concurrent runs never share one), openbox, a private D-Bus session bus that activates no services, the stand-in dashboard on a free loopback port, and tauri-driver on a free port. It prints `export HV_RUN=…`, the dashboard URL, and the evidence folder. If any step fails, `hv up` stops what it had started before it exits, the way `hv down` does. The app's `HOME` and `XDG_*` dirs are new and empty under the run dir, so every run starts at the Welcome screen with no saved connection.

Then launch the app:

```sh
$S/wd.mjs open    # tauri-driver starts the binary; prints the session id
```

It is ready when `$S/wd.mjs wait button "Get started"` prints `ok` on a fresh run. To reach a usable, signed-in state, follow [features/sign-in.md](features/sign-in.md).

**The stand-in** (`scripts/bridge.ts`) is the repo's `FakeHermes` (`src/hermes/fakeHermes.ts`) behind a minimal HTTP and WebSocket server. It requires username `verify` and password `verify-pass`, and answers anything else with 401. It reports Hermes 0.17.0 and has two profiles: `default`, with four seeded chats that the feature map relies on, a SOUL.md and six own skills, and an empty `work`; both have synthetic MCP servers. `HV_DELAY_MS=<ms>` set for `hv up` holds each `/api/` answer that long, as a distant server's round trip would. `HV_LONG_REPLY=<n>` makes a prompt that starts with `long` stream n paragraphs of markdown for minutes, to time the app while a reply streams. `HV_TURNS=<n>` adds the bench's two long chats (`long1`, `long2`, n turns each), so `bench/app-split/run.sh` can time the app on the chats `bench/run.mjs` renders. Every prompt gets a streamed reply, `Stand-in reply to: <prompt>`, which is stored in that chat's history. `GET /__state` (or `$S/hv state`) returns the sessions, transcripts and MCP servers (never their `.env`) it holds, and the app's answers to what the stand-in asked it, and the same JSON is saved to `<evidence>/server-state.json` after each change. `POST /__ask?chat=<id>&method=<method>` with JSON params asks the app what a Hermes tool would (`preview.act`, for example) in that open chat's session. `POST /__frame` sends its body to the app verbatim as one WebSocket frame, so a malformed or out-of-spec frame (`null`, an array, a `tool.start` with `"preview": 5`) can be driven through the real Rust boundary; with `?chat=<id>`, each `$SESSION` in the body becomes that open chat's runtime session id first. `HV_BAD_HISTORY=1` adds the chat `badtool` ("Broken tool row"), whose stored history has a tool row with a number `context` and one with an object `name`. This is a mock at a production boundary (the dashboard's HTTP/WS API). For behaviour that depends on what real Hermes does, use a real dashboard.

**A real dashboard** needs Hermes with Python 3.14. One recipe that has worked: a venv at `~/.cache/hermes-venv-168` (built from Hermes `f0d94882`) and `hermes dashboard --isolated --host 127.0.0.4 --port N --no-open --skip-build`, run under `env -i` with a private `HOME`/`HERMES_HOME`, `HERMES_WEB_DIST` pointed at a directory with a stub `index.html`, and `HERMES_DASHBOARD_BASIC_AUTH_{USERNAME,PASSWORD,SECRET}` set. Bind it to `127.0.0.2` or higher, never `127.0.0.1`. On a loopback literal, Hermes turns off its password gate, so `/api/auth/ws-ticket` answers 401 and the app can't open its WebSocket. Agent replies also need a model; a small OpenAI-compatible stub on another loopback address works. You started this server, so you stop it by its PID. `hv down` does not stop it.

## 3. Doctor

```sh
$S/hv doctor
```

This is read-only. Each line is `ok` or `FAIL`, and the command exits non-zero on any `FAIL`. It checks that Xvfb, openbox, D-Bus, the stand-in (or `/api/status` on a real dashboard) and tauri-driver are alive and are the processes this run started, that the stand-in's port is held by our PID, and that the build matches the source. When a session is open, it also checks that the session answers and that an app process is on our display. Run it first whenever anything looks off. A `FAIL` on the session means the app died: run `wd.mjs close`, then `wd.mjs open`, and sign in again.

## 4. Drive

`scripts/wd.mjs` is a zero-dependency WebDriver client. Its header lists every command. The core set:

| Command | Does |
| --- | --- |
| `wd.mjs handles` | One line per visible control: `tag \| role/type \| aria-label or <label> \| text or value=/placeholder= \| disabled`. Run it on every new screen to find handles. |
| `wd.mjs click <css> [text]` | Real click on the innermost displayed match. `[text]` matches visible text, `aria-label`, `title`, placeholder, or `<label>`. |
| `wd.mjs fill <css> [text] -- <value>` | Clears the field, then types the value as key presses. |
| `wd.mjs select <css> [text] -- <option>` | Picks a native `<select>` option. Its popup never renders headless, so this is the only way to pick one. |
| `wd.mjs press <chord>` | `Control+k`, `Control+n`, `Control+,`, `Enter`, `Escape`, `Shift+Tab`, `ArrowDown`. |
| `wd.mjs keys <text>` | Types into the focused element. `\n` is Enter. |
| `wd.mjs wait / gone <css> [text] [ms]` | Polls until a match is displayed or gone. Exits 2 on timeout. Use these instead of `sleep`. |
| `wd.mjs text / value / count <css> [text]` | Read state for assertions. |
| `wd.mjs eval <js>` | Read-only DOM queries, such as listing `.row-open[data-chat]` ids. |
| `cpu.sh <seconds> [samples]` | The app's CPU over a window, as a percentage of one core, summed over its processes on the run's display. |

Prefer handles in this order: aria-label or `<label>` text (`input "Dashboard password"`, `button "Search all chats (Ctrl+K)"`), visible button text (`button "Save and connect"`), then the app's own data attributes and classes (`textarea[data-composer]`, `.row-open[data-chat=backup]`, `.msg.user`, `.msg.assistant`, `.chat-title`, `.hit-row`). Never use coordinates or tab order. Drive with `click`, `fill`, `select`, `press` and `keys`, because these go through WebKit's input pipeline as a user's would. `eval` is for reading state only.

Native GTK windows (file pickers, Save dialogs) are outside the webview, so WebDriver can't reach them. Use `$S/hv x <xdotool args>` on the run's display for those. Press with `mousemove X Y`, a short sleep, `mousedown 1`, about 120 ms, then `mouseup 1`, because a plain `click 1` often doesn't register. Capture the result with `hv shot`.

The [feature map](features/README.md) holds a recipe for each feature. Read the matching file before driving, and cover every entry point it lists.

## 5. Evidence

Each run's evidence folder is `~/.cache/hermes-verify/evidence/<run>/`. `hv up` prints it, and `$EVIDENCE` in `$HV_RUN/state.env` holds it. It survives `hv down`. It collects:

- `wd.mjs shot <name>`: the webview, as `<name>.png`.
- `hv shot <name>`: the whole X screen, including the window frame and any native dialog.
- `wd.mjs html <name>`: the DOM at that moment.
- `bridge.log`: every request the stand-in received. `server-state.json` is the stand-in's final sessions and transcripts. `driver.log` and `xvfb.log` are also kept.

A proof:

- **Real user path.** Reach the feature the way the owner does: rail buttons, menus, shortcuts and forms. Never call Tauri commands, set React state, or write `localStorage` to skip a step.
- **Action and result.** Take a shot before the action and one after it, numbered in order (`05-chat-open`, `06-typed`, `07-replied`), and use `wait` or `text` to assert the visible end state.
- **Side effects.** For anything that changes the server, read it back: `hv state` for the stand-in (for example, the new message in `transcripts.<id>`), or the real dashboard's API. For local state, reopen the screen or relaunch the app (`wd.mjs close`, then `wd.mjs open`) and check that the state is still there.
- **Name the gaps.** Say which entry points or branches you did not drive, and why.

## 6. Cleanup

```sh
$S/hv down
```

This ends the WebDriver session and kills the process groups this run started: tauri-driver with WebKitWebDriver, the app and any `ssh` it spawned, the stand-in, openbox and Xvfb. It also kills the D-Bus daemon by its PID and any app process still on this run's display, then deletes the run dir. It copies `state.env` (display, ports, PIDs) into the evidence and lists what it kept. It never kills by process name, so other sessions' apps and servers on this box are safe. After `hv down`, check that the evidence folder still lists your shots. Run `hv down` after every failed attempt too, so displays and ports aren't stranded.

## Gotchas

- The box is shared and other sessions run their own Xvfb, Vite and Hermes servers. `hv up` picks a free display and ports, and the doctor checks that our PID holds our port. Never drive or kill an instance this run didn't start.
- `pkill -f <pattern>` also matches the Bash tool's own shell. Kill by the PIDs in `state.env`, or let `hv down` do it.
- There is no keyring on the private bus, and the bus starts none: its config names no service directories, so nothing (a Secret Service, dconf, a portal) is activated with the owner's `HOME` (#497). A feature that needs a keyring starts one by hand ([launch.md](features/launch.md)). Setup says "Couldn't save the password in the system keyring", and after every relaunch the app opens on Sign in with the username kept and the password empty. This is expected here and is not a bug.
- `cargo test` with the same `CARGO_TARGET_DIR` rebuilds `debug/hermes-chat` without `custom-protocol`, and the app then shows "Could not connect to localhost". Run `hv build` again before `hv up`.
- WebKitGTK allows one automation session per app process. `wd.mjs open` refuses to open a second session while `$HV_RUN/session` exists.
- At high load (`uptime` 30 or more), raise `wait` timeouts rather than adding sleeps.
- After changing `hv` or `wd.mjs`, run `$S/selftest`. It needs only `hv bootstrap` (no build, no app). It checks `wait` timeouts, cleanup after a failed or interrupted `hv up` (including a child the driver left behind), and that three concurrent `hv up` runs get three displays, and it prints `selftest: all ok`.
