# Dashboard calls are bounded, name their connection, and fail with a status

Four faults shared one cause: the client layer under every feature trusted the network and its own error text.

- Most dashboard calls and JSON-RPC requests had no time limit (#473). One call that never got an answer held whatever waited on it: a chat stayed "loading", a list sync stayed joined, a single-flight write never ended. A kept-alive HTTP connection that went half-open across a suspend did this with no server fault at all.
- The webview told failures apart by matching the text "The dashboard answered {status}: {body}" (#486). The body is server text, so `includes("answered 404")` matched what a server or gateway wrote, and any 404 for a chat, even a gateway's, marked it deleted.
- A wrong password or "Too many sign-in attempts" ran the reconnect retries anyway (#472), spending sign-in attempts the dashboard counts.
- Rust kept one connection slot, and a command waited for its lock (#474). A command sent for server A while a switch to server B held the lock then ran on B.

## Decisions

- **Every dashboard HTTP connection is bounded.** The route's client gives up opening a connection after 15 s, and TCP keepalive (first probe after 30 s idle, then every 10 s, closed after 3 unanswered) closes a half-open one, so a call on it fails within about a minute.
- **Every call the app answers through the relay gives up after an idle limit.** `request`, `get_limited`, the audio routes, agent text writes and the key and endpoint calls wait at most this long for each part of the answer: 60 s for `GET api/sessions`, as since #400, and 10 minutes for anything else, twice Hermes's longest silent step, a 300 s memory provider install. The limit is idle time, not total time, so a long answer that keeps arriving is never cut off. Downloads and uploads stay unbounded: they show progress and the owner can cancel them.
- **Every JSON-RPC request gives up after 2 minutes**, or 10 minutes for `session.compress`, `llm.oneshot` and the two attachment methods. Only the webview knows a request's id, so the limit lives in its `request`. A request given up counts as one whose answer was lost, as on a drop: a prompt or a branch is unconfirmed, not failed, and the next sync settles it.
- **A connection is named by the attempt that opened it.** The webview's `attempt` id for `hermes_connect` stays with the connection in Rust, and every later command that reaches the dashboard, the socket, a transfer or a Screen names it. A command naming a connection that was replaced or closed fails as `Closed`, however long it waited for the lock. A socket reopen (ADR 0134) keeps the name.
- **A dashboard failure crosses to the webview as fields.** Commands that call the dashboard reject with `{ message, status, body }` (`RelayError`), which the webview turns into a `RestError`. Classifiers read `status` and `body` only. The message is for showing.
- **A chat counts as deleted only on Hermes's own word.** Its read answers 404 "Session not found", the mutation snapshot says `exists: false`, and the chat isn't one started here that no list read has brought yet. A 404 alone leaves the chat where it is, and the outcome stays unsure until a later read.
- **A refused sign-in is final.** A wrong password, "Too many sign-in attempts" and a refused token take a reconnect straight to Offline, with no further tries until the owner asks.

## Considered options

- **reqwest's `read_timeout` on the shared client.** In reqwest 0.13 its first timer runs from the start of the request to the response head, so it counts the time spent sending the body and would cut off a large upload.
- **A total timeout per call.** It ends a slow answer that is still arriving, such as the chat list read in parts that #400 kept working.
- **A connection generation that Rust returns from `hermes_connect`.** It changes what `hermes_connect` answers, and every test that stands in for Rust returns a bare route. The webview's attempt id is already unique per opening.
- **Parsing the message once at the boundary.** It still depends on the wording of Rust's text, and a change to that wording would quietly turn every failure into an unknown one.

## Consequences

- A half-open connection now fails a call in about a minute. A live server that never answers one call holds what waits on it for up to 10 minutes, or 2 for a JSON-RPC request, instead of until the app restarts.
- A route Hermes keeps silent on for more than 10 minutes now fails. None does at the deployed `bf0203a`.
- Every Rust command that reaches the dashboard takes an `attempt` argument, and `hermes_transcribe` an `x-attempt` header. A new command has to name its connection too, or it fails as `Closed`.
- Tests and fakes throw `RestError` for a dashboard failure. A fake that throws the old text gets no status, so a check that depends on one fails.
- After a refused sign-in at launch, the app no longer retries every 60 s. The owner reconnects once the password is fixed or the minute has passed.
