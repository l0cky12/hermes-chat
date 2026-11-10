# A message that can't be drawn shows an error in its place

Issue #476. One tool call whose preview was a number threw while the transcript drew it, and the window's one error boundary (ADR 0092) replaced the whole app with the crash screen. A chat whose stored history held such a row threw again each time it opened, so Reload and signing in again led straight back to the crash screen.

## Decisions

- **Each transcript block has its own boundary.** A message, a reply, a thought, a tool call or group, an Approval card and a side question each sit under one. A block that throws while it is drawn shows a small error in its place ("Hermes Chat couldn't show this message", with the error's message) in the style of an error from Hermes. The other messages, the composer, the list and the other chats keep working.
- **The root boundary stays.** It catches what the transcript's boundaries don't, as ADR 0092 says. `ErrorBoundary` takes a `fallback` for the per-block case, so both share one way of catching.
- **The error is still reported.** React reports a caught error on the console, so Logs → This app keeps it (ADR 0033).

## Considered options

- **A boundary around the whole chat pane.** A broken block would still hide the rest of its chat and the composer, and a chat whose history holds the block could never be used.
- **Try again in the fallback.** A block draws from the same data each time, so it would throw again.

## Consequences

- A malformed message costs only itself. The owner sees which message failed and can still read, send and switch chats.
