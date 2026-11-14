# The canonical session protocol stays refused until an adapter covers every method, on a real gateway

> **Accepted.** A plan and the evidence for it. It changes nothing the app does. ADR 0003's and ADR 0044's decisions to refuse the canonical protocol stand, and this ADR says what has to be true before they are replaced.

The app stops at sign-in on any Hermes whose `gateway.ready` carries `session_authority` (`ProtocolMismatchError`, ADR 0003, ADR 0044). The owner's worry is that a Hermes update turns that on and the app stops working. The question was whether to add support for the canonical protocol now, or to stop at a design and a check that the refusal still works. A protocol the app speaks only in part must never ship.

The answer is to stop here. A real canonical gateway was run, and every JSON-RPC method the app sends was sent to it. Fourteen of the 58 are refused or need a different frame, four more answer but mean something else, and the dashboard's session edits over REST are refused too. An adapter for all of that, tested against FakeHermes and a real gateway, is more than one change can prove. This ADR records what was found, the adapter's design, and what makes it safe to ship.

## What was found

Source lines are Hermes at `f0d94882`. The live answers come from that build.

### Which servers speak it

`/api/ws` is canonical when the dashboard app runs inside the gateway process. `handle_ws` adds `session_authority: true` to `gateway.ready` when the socket has a session authority (`tui_gateway/ws.py:369-377`, `:647`). The route takes it from `app.state.session_authority` (`hermes_cli/web_routers/chat_ws.py:665`), and only the gateway's own listener sets that (`gateway/run_api.py:97`).

- **`hermes gateway run` with the Webapp on** (`webapp.enabled`, port 9120 by default, `gateway/webapp_listener.py:1-15`, `:31`) serves the dashboard on the gateway's listener. A wildcard bind is behind the same password sign-in the app uses. Checked live: signed in as the app does, `gateway.ready` had `session_authority: true`.
- **A standalone `hermes dashboard` or `hermes serve`** has no authority, so it is legacy. Checked live on the same build and the same Hermes home: no `session_authority`. The owner's server runs this one, on port 9119.
- **The gateway's private listener** (loopback, a port chosen at start) is canonical too, but it takes only tickets from the gateway's control socket (`gateway/run_api.py:440-488`), which this app can't get.

So today the app meets the canonical protocol only if its sign-in points at a gateway's Webapp address instead of the dashboard's. An update can't flip a standalone dashboard by itself at this build. Hermes plans to: the standalone path is commented "its owner cutover is a follow-up" (`hermes_cli/web_server_sessions.py:112`), and a legacy `hermes serve` already hands a turn to the gateway when the gateway owns the session (`tui_gateway/owner_forward.py:1-17`). When that cutover ships, the owner's dashboard becomes canonical with an update.

### What a canonical socket does with the app's frames

A request goes to the authority first. When the authority has no such method, the legacy handler runs, except for `session.*`, `prompt.*` and `message.*`, which get `-32601` (`tui_gateway/ws.py:380-397`, `tui_gateway/ws_legacy_fallback.py:32-59`). Canonical params are a closed set: an unknown or missing key is `4001 invalid_params` (`gateway/session_controls.py:324-329`).

`src/hermes/canonicalVerbs.ts` has a row for each of the 58 methods the app sends, in the app's shape, with the real gateway's answer and what an adapter sends instead.

- **34 answer as a legacy server does.** Among them are the model list, settings reads, commands, skills, side questions, subagents, projects, memory, `file.attach` and `llm.oneshot`.
- **7 are gone**, with `-32601`: `session.close` (now `session.detach`), `session.status` (now `session.info`), and `session.title`, `session.cwd.set`, `session.branch`, `session.undo` and `session.compress`, which are operations of `session.mutate` (`tui_gateway/contracts/canonical.py:82-108`).
- **7 need a different frame.**
  - `prompt.submit` needs a `submission_id` and answers with an admission receipt, not `{status}` (`gateway/session_controls.py:813-833`).
  - `session.interrupt` needs the turn's `execution_generation`. Without it, Stop is `stale_generation`.
  - `approval.respond` takes `{execution_generation, prompt_id, choice}`, not `request_id`.
  - `session.resume` refuses `inline_images`.
  - `session.create` refuses `messages`, `reasoning_effort` and `fast`. A plain New chat's frame is taken as it is.
  - `config.set` refuses a model pick (`use_session_mutation_model`).
  - `command.dispatch` refuses `/steer` (`session.steer` replaces it). Skills still dispatch.
- **4 answer, and mean something else.**
  - `image.attach_bytes` only stores the image. The path has to go in `prompt.submit`'s `attachments` (`gateway/session_images.py:1-20`), or the image is not in the turn.
  - `image.detach` knows no canonical session.
  - `session.events.since` without a `replay_epoch` answers `snapshot_required` and no events.
  - `clarify.lock` is only for a batch Clarify.
- **2 exist on no Hermes** (`projects.membership.*`), and **4 were not sent**, because they start or drive the Bot Desktop.

Other differences, each seen live:

- **An Approval and a Clarify are events.** `approval.request` and `clarify.request` carry a `prompt_id` and an `execution_generation`, and `approval.settled` and `clarify.settled` follow when anyone answers (`gateway/session_api_turn.py:397`, `gateway/session_pending_controls.py:38-51`). The app reads server→client requests named `approval` and `clarify`, so it would show no card and the turn would wait out its timeout. A second window finds a waiting prompt in the resume snapshot's `prompts`.
- **Every session event has an envelope.** `seq`, `replay_epoch`, `authority_epoch`, `execution_generation` and `admission_id` sit beside `type` and `payload`. The event names the app handles are the same. `message.start` has an empty payload.
- **One id.** A session's id on the socket is its stored id (`local-…`). The app keeps the two apart (`runtimeId`).
- **REST edits need a revision.** `PATCH` and `DELETE` on `/api/sessions/{id}` answer `409 client_upgrade_required` unless they name `request_id` and `expected_revision` (`hermes_cli/web_server_sessions.py:37`, `:287-291`). Rename, pin, archive, mark unread and delete all go that way today. Reads are unchanged.
- **Errors are reason words.** `4001` with `message` and `data.reason` set to `invalid_params`, `stale_generation`, `revision_conflict`, `permission_denied` or `not_found`, and the fresh `revision` in `data` after a conflict. The app's `RpcError` drops `data`.
- **The chat's Source changes.** Hermes files the chat as `source: local`, `created_source: desktop`, which the app shows as Hermes Desktop's, not its own.

### Why a part of it can't ship

A New chat's `session.create` succeeds on a canonical server, and the message after it is refused. An attached image uploads, and is then left out of the turn without an error. Stop is refused. An Approval never shows. Each of these is what a partial adapter would give the owner, which is why the refusal comes off last.

## Decisions

- **The refusal stays, and it is the gate.** `connect` still throws `ProtocolMismatchError` before it sends anything. `sessionProtocol.test.ts` checks that with the real gateway's `gateway.ready`, and that nothing went out. The refusal is removed in the last step below, alone.
- **The map is code, and it can't go stale.** `canonicalVerbs.ts` is the list an adapter has to cover. `Hermes.request`, the one place a JSON-RPC request leaves the app, takes only a method named in `APP_METHODS`, so a new method doesn't compile until it is named there, and `sessionProtocol.test.ts` fails until it has a row. A new method is classified when it is added. `sessionProtocol.live.test.ts` sends every row to a real canonical gateway and fails on an answer that differs, so a Hermes update that moves a row is caught by one run.
- **One protocol per connection.** The app picks from `protocolOf(gateway.ready)` when the socket opens, as it reads the protocol today, and never mixes the two on one connection. A reconnect or a profile switch opens a new connection and picks again, so a server updated while the app runs is handled by the next connect.
- **The adapter is one module behind one interface.** A `SessionProtocol` with one typed operation per thing the transport does to a session: create, resume, submit, stop, answer an Approval, answer a Clarify, rename, move, branch, rewind, compact, pick a model, close, replay, and the session edits that go over REST. The legacy implementation sends the frames the app sends today, byte for byte. The canonical one sends the frames in `canonicalVerbs.ts`. The transport's own interface to the screens doesn't change. This is not the split of `transport.ts`: the call sites stay where they are and call the interface.
- **What the canonical implementation keeps per chat.** The `execution_generation`, the `revision`, the `subscription_id`, the `replay_epoch` and last `seq`, the admission of each message it sent, and each waiting prompt by `prompt_id`. Every one comes from the create or resume snapshot and is kept current by `session.info` events.
- **A message is sent once.** `submission_id` is the retry key, so a send whose answer was lost is asked about (`prompt.receipt`) instead of guessed at. This replaces the legacy path's "may have been sent" state on canonical connections only.
- **Both protocols stay supported.** The owner's server is legacy and will be until Hermes cuts the standalone dashboard over. Legacy support is removed only by a later ADR.
- **Diagnostics shows the protocol it connected with.** `facts.protocol` already holds `legacy` or `canonical`. A check that uses a moved method gets a canonical form. Settings → Toolsets reads an open chat's tools with `session.status`, which is gone, so today it would say the server can't report them.
- **Rust doesn't change.** The relay passes frames through, and splices a file into a frame the webview wrote. Sign-in, the ticket and `?profile=` are the same on both protocols.

### The order of work

Each step is a pull request that changes no behaviour until the last.

1. **This one.** The map, its two tests, and the tools that start a real canonical gateway.
2. **The interface, with the legacy implementation only.** Every session call site goes through it. A test records every frame the existing suite sends and compares it with the frames before the change.
3. **FakeHermes's canonical mode.** It keeps generations, revisions, admissions and prompts as the authority does, and answers each row of `canonicalVerbs.ts` as the real gateway did. The live test's flows run against it too, so the fake and the real gateway are held to the same assertions.
4. **The canonical implementation**, behind the refusal. The transport's suite runs once per protocol. The live test drives the app's own transport against the real gateway: a turn, attachments, an Approval, a Clarify, Stop, a queued message, a reconnect in the middle of a turn, rename, pin, archive, delete, branch, undo, compact, a model pick and a Bot Chat.
5. **The refusal comes off**, with ADR 0003, ADR 0044 and `docs/compatibility.md` changed in the same pull request.

### What makes it safe to ship

- Every row of `canonicalVerbs.ts` that is refused or changed has an adapter path, and no row is unprobed.
- The transport's suite passes on both FakeHermes modes.
- The live test passes against a real canonical gateway, with the app's own transport, for every flow in step 4.
- The frames sent to a legacy server are unchanged, shown by the recorded-frames test.
- `npm run check` passes.
- The open questions below are answered.

## Open questions

1. **Project instructions and Referenced chats are seeded as hidden messages in `session.create`**, which the canonical protocol refuses. `prompt.submit` takes `display_kind: "hidden"`, but that starts a turn. Either Hermes gains a way to seed, or the app sends them as attached context with the first message, as it sends a Referenced chat's summary (ADR 0165).
2. **Which chats are the app's own.** With `created_source: desktop`, a chat started here can't be told from one started in Hermes Desktop. The owner picks: show both as one Source, or ask Hermes for a `created_source` of its own.
3. **Whose queue.** Hermes holds queued messages itself on the canonical protocol, and can cancel, steer and replace them. The app's queue (ADR 0018) exists because the legacy protocol can't. Step 4 keeps the app's queue. Moving to Hermes's is a separate decision.
4. **A rename to a title another chat has** answers `-32603 internal error`. The adapter has to check first or word that error.
5. **Sudo and Secret questions** are still server→client requests on a canonical socket, by the source (`gateway/session_controls.py:284-289`). They were not seen live.

## Considered options

- **Ship an adapter now.** Rejected. The change set is the 14 methods, the two prompt flows, the event envelope, the id model and the REST edits, and FakeHermes has no canonical mode to test any of it against. It could not be finished and proven in one change.
- **Adapt only sending a message.** Rejected. It is the partial protocol described above: a chat that sends and can't be stopped, approved or renamed.
- **Send the legacy frame, and retry in the canonical shape when it is refused.** Rejected. Some legacy frames aren't refused: `image.attach_bytes` answers and drops the image, and a plain `session.create` succeeds. A retry on refusal would leave those as they are.
- **Use the gateway's API server (`/v1/runs`) instead of the socket.** Not pursued. It is a second transport to build and test, it takes only inline images (research doc, section 7), and the methods that aren't about a session would still need `/api/ws`.
- **Leave the map in a document.** Rejected. A list in prose goes stale with the first new method. The table and its tests fail instead.

## Consequences

- A change that adds a JSON-RPC method names it in `APP_METHODS`, or it doesn't compile, and adds a row to `canonicalVerbs.ts`, or `sessionProtocol.test.ts` fails. A row whose canonical answer nobody has checked says so (`unprobed`).
- Nothing changes for the owner. A Hermes that speaks the canonical protocol is still refused at sign-in with the same words. The way out today is to sign in to the standalone dashboard's address, not the gateway's Webapp address.
- The risk the owner named remains until step 5. What this change adds is that one command says whether a Hermes build is canonical and which rows moved.
- `tools/canonical-gateway.py` runs a real gateway with the Webapp on, bound to an IPv4 `127.x.x.x` other than `127.0.0.1` so the password gate is on, on a new, empty Hermes home every run. It refuses the owner's `~/.hermes` (symlinks resolved), and stops if a file operation reaches it; `--self-check` proves both. `tools/canonical-stub-model.py` is the model behind it. Neither is part of the app.
- `docs/research/hermes-gateway-api.md` has the dated findings.
