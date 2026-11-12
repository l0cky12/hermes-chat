# Connection tests, context files and transcription fail with fields too

ADR 0142 made relay commands reject with `{ message, status, body }` and the webview classify on those fields. Three groups of commands still rejected with text, and the webview read that text (#517):

- Setup's connection test (`hermes_probe`, `hermes_reach`) matched `answered (401|403)`, `answered 503` and `^The dashboard answered 5\d\d` in the message, which repeats the server's body. Its other hints ran over that body too. A gateway's 502 whose page said "answered 401" read as a refused sign-in, and a 525 "SSL handshake failed" page as an untrusted certificate.
- Project context writes (ADR 0135) found "a file is there already" by `message === "exists"` and an SSH profile's text-only refusal by `includes(...)` on the message.
- Dictation and voice conversations decided whether Rust had already named the side that failed by matching "^(Hermes|This computer) couldn't transcribe".

## Decisions

- **A failed connection test carries `answered: { status, body }`** when the dashboard, or a gateway in front of it, answered the failing call. Setup explains such a failure by its stage and status alone. The hints that read words (SSH errors, certificates, timeouts, "Wrong server") run only over failures with no answer, whose text is Rust's or OpenSSH's own.
- **`context_*` commands that reach the dashboard reject with `RelayError`.** A refusal Rust makes itself carries a `code` (`exists`, `ssh-text-only`), which the webview gets as a `RefusedError`. A dashboard failure keeps its status and body as a `RestError`.
- **Every transcription failure names its side in Rust.** Hermes's failure alone now reads "Hermes couldn't transcribe it: …", as this computer's always did, unless one side was asked alone (Settings' Test). A fallback's `why` comes without that start. The webview turns any `hermes_transcribe` rejection into an `SttFailed` and shows it as it is.

## Considered options

- **Status and body on transcription failures.** Rust's `post_audio` already reads Hermes's refusal into its reason, so a failed transcription has no status left that the webview could act on. Nothing in the webview branches on one.
- **A structured error for `hermes_connect`.** The real sign-in's error reaches the sign-in screen as a string through App state. Until it doesn't, `explainSignIn` takes the status from Rust's own opening words, "The dashboard answered {status}: ", and never from the body after them.

## Consequences

- A fake or test that stands in for `hermes_probe` gives a server's answer as `answered`, as ADR 0142's fakes throw `RestError`. A probe failure without it is read as Rust's own words.
- A Hermes-only transcription failure reads "Hermes couldn't transcribe it: …" in Dictation, where it used to show Rust's text alone.
- The WebSocket close reason that Rust hides for the extra headers' sake is still matched by its wording, since a close has no HTTP status.
