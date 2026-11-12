# A real sign-in fails with a stage, as a connection test does

ADR 0149 gave a failed connection test (`hermes_probe`) its stage and, when the dashboard answered, `answered: { status, body }`. The real sign-in (`hermes_connect`, at launch and when switching connection) still rejected with text, and `explainSignIn` read the stage from it (#550):

- An answered failure was taken to be the status check's, so a 503 from the sign-in showed the status check's wording.
- A failure with no answer had its stage guessed from its words (`/sign-in|\btoken\b/i`, `/chat connection|ready/i`, …).

## Decisions

- **`hermes_connect` rejects with a `ProbeFailure`.** `transport::open_route` names the step each failure stopped at, as `probe_expecting` does: the status read and server check are `reach`, the offered methods and the sign-in `sign-in`, the ticket and socket `chat`. Past the status read it carries that status body too. The saved token is `sign-in`; the address or tunnel is `address`; a stop is `cancelled`.
- **The webview keeps it as a `SignInFailure`**, an `Error` that is a `ProbeFailure`. The chat failures `Hermes.dial` raises once the pipe is open (a close before `gateway.ready`, no `gateway.ready` in time, the canonical protocol) are `SignInFailure`s at `chat` as well.
- **App's sign-in error is a `SignInError`**: a `ProbeFailure`, a `RoutesFailedError`, or a note the app wrote. `explainSignIn` explains the first with `explain`, lists each route for the second, and shows a note, or a stop, as it is. It reads no message text.

## Considered options

- **A stage for local refusals.** A malformed connection id and Rust's live-limit refusal aren't steps of a sign-in. They are `reach`, as the text guess made them before: the webview checks both first, and Rust's text shows under the explanation.

## Consequences

- **Takes up ADR 0149's deferred option** "A structured error for `hermes_connect`": its stopgap that read the status from "The dashboard answered {status}: " is gone.
- A fake that stands in for `hermes_connect` rejects with a `ProbeFailure`, or throws a `SignInFailure`. One that throws a plain `Error` is shown as a note, unexplained.
- A failure of every route still carries only each route's message, not its stage.
