# Features are tested end to end from the command line in Vitest browser mode against FakeHermes

> **Accepted.** It adds `npm run e2e`, a suite under `e2e/`, and two exact-pinned dev dependencies: `@vitest/browser-playwright` 5.0.5 and `playwright` 1.64.1.

An agent changing a feature had no single command that proved the feature still works the way a person uses it. `npm test` renders components in jsdom, which has no layout, no real focus and no real input. The `verify-hermes-chat` skill drives the real desktop binary, but it needs a Rust build, Xvfb, WebKitWebDriver and a stand-in dashboard, and it is driven by hand, one step at a time. `tools/shots/` runs the app in headless Chromium, but it only takes screenshots and asserts nothing.

The suite had to run on the headless Linux build box with no display, no person, and no Hermes server.

## Decisions

- **The suite runs in Vitest browser mode with the Playwright provider, in headless Chromium.** Each test in an `e2e/features/<feature>.e2e.tsx` file starts the whole app from `src/main.tsx`, the entry the window loads, in an iframe of its own (`e2e/app.html`). The app's modules keep state for the whole window, such as the saved and live connections, and browser mode can't reset modules between tests (`vi.resetModules` has no effect there). A new frame per test gives each test fresh modules, so a file can hold several tests. The tests click, type and press keys through Playwright, so the input is real browser input with real layout and focus. They find elements through `page.frameLocator`. Tests use the Vitest API that the other 300+ test files already use, and `vitest.config` options such as `-t` work unchanged.
- **The stand-in sits where Rust sits, not at `/api/ws`.** The webview never opens the JSON-RPC WebSocket. Rust does, and the page reaches it through `invoke` (`hermes_connect`, `hermes_send`, `hermes_request`, …). The app frame installs `mockIPC` and `mockWindows` from `@tauri-apps/api/mocks` before the app's entry runs, and forwards each command to the test's page, which is part of `@tauri-apps/api`, a dependency the app already has. A table of command handlers routes the pipe commands to `FakeHermes.openPipe`, as `src/ui/liveConnections.test.tsx` does under jsdom. A new WebSocket server would have tested a path the app does not use.
- **`FakeHermes` is the server.** It already speaks the deployed wire shapes for the RPC and REST calls, and Vitest, `tools/shots/` and `verify-hermes-chat` all use it. Each test seeds it and then checks what it received, such as the prompt that was sent or the approval choice it got. That check is the server-side proof.
- **The fake Rust side answers every launch command with its empty value.** A command that the table doesn't know returns nothing and is recorded. The run's summary lists these commands, so a new `invoke` that a test meets shows up there and not as a silent pass.
- **`npm run e2e` is one Node script, `scripts/e2e.mjs`.** It starts Vitest through `vitest/node`. `--feature <name>` picks files by their stem, and `--list` prints the stems. The script prints one line per test and writes `e2e/out/summary.json`, with each test's status, duration, errors and screenshots. Screenshots go to `e2e/out/screenshots/`, and a failing test also gets a screenshot at the point it failed. The exit code is 0 when every test passes and 1 when one fails.
- **Playwright is pinned to 1.64.1** because its Chromium headless shell (revision 1248) is already in `~/.cache/ms-playwright` on the build box. CI installs that same browser revision with `npx playwright install chromium-headless-shell`.

## Considered options

- **A raw Chrome DevTools Protocol runner like `tools/shots/shoot.mjs`.** It needs no new dependency. But every wait, locator, assertion, real-input event and report would be code written here and kept here. The shots runner clicks with `element.click()` in the page, which skips focus, hit testing and pointer events.
- **The `@playwright/test` runner.** It would add a second test framework with its own config, fixtures and assertions beside Vitest. Vitest browser mode uses Playwright only as the browser driver.
- **WebdriverIO, or tauri-driver against the real binary.** That is what `verify-hermes-chat` already does. It is the right tool to prove a change through Rust and WebKitGTK, but it takes minutes to build and needs a display server. It doesn't fit a command that runs in seconds for each feature.
- **A WebSocket stub server at `/api/ws`.** The page never talks to it, as explained in the second decision.

## Consequences

- The suite proves the webview code: React, CSS layout in Chromium, and the RPC and REST calls the page makes. It doesn't prove Rust, WebKitGTK-only behavior, the SSH tunnel or a real Hermes. Those still need `verify-hermes-chat` or the Rust tests.
- Chromium isn't WebKitGTK. A layout or input bug that appears only in WebKitGTK passes here.
- When a feature adds an `invoke` command that its test depends on, the command needs an entry in `e2e/harness.tsx`. The unhandled-command list in the summary shows which one is missing.
- `npm test` doesn't run the suite, because Vitest's default include doesn't match `*.e2e.tsx`. CI runs it in a job of its own.
