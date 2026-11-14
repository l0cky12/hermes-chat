# End-to-end tests

`npm run e2e` tests features the way a person uses them, with no display, no person and no Hermes server. Each test starts the whole app in headless Chromium, clicks and types with real browser input, and checks two things: what the screen shows, and what `FakeHermes` received. ADR 0163 records the design.

## Run it

```sh
npm run e2e                                  # every feature
npm run e2e -- --feature approvals           # one feature
npm run e2e -- --feature connect,settings    # several (or repeat --feature)
npm run e2e -- -t "denies"                   # tests whose name matches
npm run e2e -- --list                        # the feature names
npm run e2e -- --help
```

A feature is a file in `e2e/features/`, named `<feature>.e2e.tsx`. Its name is the file name without `.e2e.tsx`.

The suite needs Playwright's Chromium headless shell. The build box has it in `~/.cache/ms-playwright`. Anywhere else, run `npx playwright install chromium-headless-shell` once.

## What it prints

One line per test, then the counts and where the results are:

```
FAIL approvals › approves a command once: Hermes gets the answer and the card closes (6003 ms)
    the answers Hermes got: expected [ [ 'srq-000000000001', 'deny' ] ] to deeply equal [ [ 'srq-000000000001', 'once' ] ]
    e2e/out/attachments/failure-screenshots/approvals.e2e.tsx/approves-a-command-once--Hermes-gets-the-answer-and-the-card-closes.png
PASS approvals › denies a command: Hermes gets the denial and the card closes (2062 ms)

1 passed, 1 failed, 0 skipped in 9.9 s
Summary: e2e/out/summary.json
Screenshots: e2e/out/screenshots/
```

Under a failure come its error and the screenshot taken when it failed. A test skipped by `-t` gets no line, only a count. A line `Commands no handler answered: …` lists Rust commands the app invoked that the fake Rust side doesn't know (see below).

The exit code is 0 when every test that ran passed, 1 when a test failed, a file didn't load, a hook failed or no test ran, and 2 for an unknown feature or option.

Each run deletes `e2e/out/` first.

## summary.json

`e2e/out/summary.json` holds the same result for a program to read:

```json
{
  "ok": true,
  "durationMs": 11941,
  "counts": { "passed": 6, "failed": 0, "skipped": 0 },
  "features": [
    {
      "name": "approvals",
      "file": "e2e/features/approvals.e2e.tsx",
      "ok": true,
      "errors": [],
      "tests": [
        {
          "name": "approves a command once: Hermes gets the answer and the card closes",
          "status": "passed",
          "durationMs": 7463,
          "errors": [],
          "screenshots": ["e2e/out/screenshots/approvals/approves-a-command-once-hermes-gets-the-answer-and-the-card-closes--asked.png"]
        }
      ]
    }
  ],
  "unhandledErrors": [],
  "unhandledCommands": []
}
```

- `status` is `passed`, `failed` or `skipped`.
- A feature's `errors` are failures outside any test: its file didn't load, or a `beforeAll` or `afterAll` hook failed. A test's `errors` are its failed assertions.
- `screenshots` are paths from the repository root: the ones the test took, then the one taken when it failed.
- `unhandledErrors` are errors thrown outside any test. Any of them fails the run.
- `unhandledCommands` are the Rust commands no handler answered, in every test that ran.

## Screenshots

`shot("name")` saves the whole window as `e2e/out/screenshots/<feature>/<test>--<name>.png` and lists it in the summary. A failing test also gets a screenshot at the moment it failed, under `e2e/out/attachments/failure-screenshots/`. Read the PNGs to check that each shows the state its name says.

## How it works

- `e2e/harness.tsx` has `boot()`, `shot()` and `sessionOfPrompt()`. `boot()` makes a `FakeHermes`, seeds it, and starts the app in an iframe of its own from `src/main.tsx`, as the window does. Each test gets a new frame, so the app's modules and the state they keep start fresh.
- `e2e/ipc.ts` runs in that frame before the app. It sends every `invoke` to the test's fake Rust side.
- The fake Rust side is a table of command handlers in `boot()`. The pipe commands (`hermes_connect`, `hermes_send`, `hermes_request`, …) go to the `FakeHermes` pipe that `hermes_connect` opened for that `attempt`. The keyring is a `Map`. The commands the app calls at launch get their empty value, as Rust gives them on a fresh install. A command not in the table returns `undefined` and is listed in the summary.
- `boot({ signedIn: false })` leaves the keyring empty, so launch shows the sign-in screen. The default has the password saved, so launch signs in.

## Add a test for a feature

1. Copy the spec closest to yours in `e2e/features/` to `<feature>.e2e.tsx`.
2. Seed the server in `boot({ seed: (s) => … })`. `FakeHermes` (`src/hermes/fakeHermes.ts`) has `sessions`, `transcripts`, `approvalModes` and many more fields. `tools/shots/main.tsx` shows a realistic seed.
3. Drive the app as a person would. Find elements with `app.getByRole`, `app.getByLabelText`, `app.getByText` or `app.getByPlaceholder`, and act with `.click()`, `.fill()` and `userEvent.keyboard()` from `vitest/browser`. Wait on what the screen or the server shows, with `expect.element(…)` and `expect.poll(…)`, never on a timer.
4. To play Hermes's side of a turn, send events: `server.event(session, "message.start")`, `"message.delta"` with `{ text }`, then `"message.complete"`. `sessionOfPrompt(server, text)` waits for the prompt and returns its session. Requests to the app have helpers such as `server.askApproval(session)`.
5. Assert the server side too: `server.requests` (JSON-RPC), `server.restRequests` (REST), `server.approvalAnswers`, and the other records `FakeHermes` keeps. A test that only checks the screen can pass while nothing reaches Hermes.
6. Call `shot("name")` at the state the test is about.
7. Run `npm run e2e -- --feature <feature>`. If `Commands no handler answered` lists a command your feature needs, add it to the table in `boot()` with what Rust returns, or pass it for one test in `boot({ commands: { … } })`.

## What it doesn't prove

The suite tests the webview code: React, CSS layout in Chromium, and the calls the page makes to Rust. It doesn't test Rust, the SSH tunnel, a real Hermes, or WebKitGTK, the engine the Linux app runs in. A bug that appears only in WebKitGTK passes here. To prove a change in the real app, use the `verify-hermes-chat` skill (`.claude/skills/verify-hermes-chat`). The Rust side has its own tests (`cargo test`).

`npm test` doesn't run this suite.

## In CI

The `e2e` job in `.github/workflows/ci.yml` installs the Chromium headless shell with `npx playwright install --with-deps chromium-headless-shell` and runs `npm run e2e`. It uploads `e2e/out/` as the artifact `e2e`, whether or not the tests passed.
