// What Hermes's canonical session protocol does with every JSON-RPC method this app sends on `/api/ws`, in the shape
// the app sends it (ADR 0174). The app refuses a canonical server (`ProtocolMismatchError`), so nothing here runs in
// it: this is the map an adapter has to cover, and what its tests check.
//
// Each answer was recorded from a real `hermes gateway run` at `f0d94882` whose own listener serves the dashboard
// (`tools/canonical-gateway.py`), signed in as the app signs in. `sessionProtocol.live.test.ts` sends every row again
// and fails on one that answers differently. `sessionProtocol.test.ts` fails when the app sends a method with no row.

/** `gateway.ready`'s payload from that gateway, `skin` emptied. A standalone `hermes dashboard` sends the same without `session_authority`. */
export const CANONICAL_READY: Record<string, unknown> = {
  skin: {},
  change_events: true,
  heartbeat: true,
  replay_epoch: "6731dec07f584019ae948bfc07f90bdb",
  session_authority: true,
};

/** What the probe fills a row's params with: a canonical session's id (its stored id too) and the profile. */
export type ProbeScope = { sid: string; profile: string };

/** A result, or the error's `code`, `message` and, for `invalid_params`, the keys `data.fields` names. */
export type CanonicalAnswer = "ok" | { code: number; message: string; fields?: string[] };

/**
 * Where a canonical socket sends the method. `authority`: the session authority answers it
 * (`gateway/session_controls.py` `handlers`). `fallback`: the authority has no such method and the legacy handler runs
 * (`tui_gateway/ws_legacy_fallback.py`). `refused`: the authority has no such method and the fallback is not allowed,
 * as for every `session.*`, `prompt.*` and `message.*` it doesn't own. `socket`: `tui_gateway/ws.py` answers it itself.
 * `none`: no Hermes has the method.
 */
export type CanonicalRoute = "authority" | "fallback" | "refused" | "socket" | "none";

/** Every JSON-RPC method the app sends on `/api/ws`. `Hermes.request` takes only these, so a new method won't compile until
 * it is named here, and `sessionProtocol.test.ts` fails until it has a row in `APP_VERBS`. */
export const APP_METHODS = [
  "approval.received",
  "approval.respond",
  "clarify.lock",
  "client.capabilities",
  "command.dispatch",
  "commands.catalog",
  "config.get",
  "config.set",
  "display.lease.acquire",
  "display.lease.release",
  "display.observe",
  "display.start",
  "display.status",
  "file.attach",
  "gateway.capabilities",
  "gateway.ping",
  "image.attach_bytes",
  "image.detach",
  "learning.delete",
  "learning.detail",
  "learning.edit",
  "learning.frames",
  "llm.oneshot",
  "model.options",
  "profiles.get_asset",
  "profiles.list",
  "projects.add_folder",
  "projects.create",
  "projects.delete",
  "projects.list",
  "projects.membership.apply",
  "projects.membership.list",
  "projects.remove_folder",
  "projects.update",
  "prompt.btw",
  "prompt.submit",
  "request.answer",
  "session.active_list",
  "session.branch",
  "session.close",
  "session.compress",
  "session.context_breakdown",
  "session.create",
  "session.cwd.set",
  "session.events.since",
  "session.interrupt",
  "session.list",
  "session.resume",
  "session.status",
  "session.title",
  "session.undo",
  "slash.exec",
  "subagent.interrupt",
  "subagent.list",
  "subagent.roster",
  "subagent.steer",
  "subagent.tail",
  "tools.show",
] as const;

export type AppMethod = (typeof APP_METHODS)[number];

export type AppVerb = {
  method: AppMethod;
  /** Which of the app's uses of the method this is, for one it sends in more than one shape. */
  shape?: string;
  /** The params the app sends, as its call site builds them. */
  params: (s: ProbeScope) => Record<string, unknown>;
  route: CanonicalRoute;
  /** The canonical gateway's answer to those params. */
  answer: CanonicalAnswer;
  /** What an adapter sends instead, when the app's own frame is refused or means something else. */
  canonical?: string;
  /** Why the live test doesn't send this row; its `route` is then from the source alone. */
  unprobed?: string;
};

const NO_METHOD = (method: AppMethod): CanonicalAnswer => ({ code: -32601, message: `unknown method: ${method} — not available on this Hermes backend` });
const moved = (method: AppMethod, params: AppVerb["params"], canonical: string): AppVerb => ({ method, params, route: "refused", answer: NO_METHOD(method), canonical });
const DESKTOP = "starts or drives the profile's Bot Desktop";
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

export const APP_VERBS: AppVerb[] = [
  // The connection.
  { method: "client.capabilities", params: () => ({ server_requests: true }), route: "fallback", answer: "ok" },
  { method: "gateway.capabilities", params: () => ({}), route: "fallback", answer: "ok" },
  { method: "gateway.ping", params: () => ({}), route: "socket", answer: "ok" },

  // A chat's session: every one of these changes.
  // A new chat's own frame is taken as it is, and answered with a snapshot that has what the app reads. The next two
  // shapes are refused, and so is the message that would follow any of them (`prompt.submit`).
  { method: "session.create", shape: "a new chat", params: (s) => ({ profile: s.profile, source: "gui" }), route: "authority", answer: "ok" },
  { method: "session.create", shape: "a new chat in a folder", params: (s) => ({ profile: s.profile, source: "gui", cwd: "/tmp", cwd_explicit: true }), route: "authority", answer: "ok" },
  {
    method: "session.create",
    shape: "a new chat with project instructions or attached context",
    params: (s) => ({ profile: s.profile, source: "gui", messages: [{ role: "user", content: "Instructions", display_kind: "hidden" }] }),
    route: "authority",
    answer: { code: 4001, message: "invalid_params", fields: ["messages"] },
    canonical: "No canonical frame seeds a hidden message. prompt.submit takes `display_kind: 'hidden'`, but that starts a turn. Open question 1 in ADR 0174.",
  },
  {
    method: "session.create",
    shape: "a new chat with a picked effort and fast mode",
    params: (s) => ({ profile: s.profile, source: "gui", model: "fake", provider: "custom", reasoning_effort: "low", fast: false }),
    route: "authority",
    answer: { code: 4001, message: "invalid_params", fields: ["reasoning_effort", "fast"] },
    canonical: "session.create {…, model, provider, reasoning: <effort>, service_tier}.",
  },
  {
    method: "session.create",
    shape: "a Bot Chat",
    params: (s) => ({ profile: s.profile, title: `Canonical probe ${s.sid.slice(-8)}`, hidden: true, follow_profile_config: true, source: "gui" }),
    route: "authority",
    answer: "ok",
  },
  {
    method: "session.resume",
    params: (s) => ({ session_id: s.sid, profile: s.profile, inline_images: false }),
    route: "authority",
    answer: { code: 4001, message: "invalid_params", fields: ["inline_images"] },
    canonical: "session.resume {session_id} → a snapshot: messages, running, execution_generation, revision, subscription_id, replay_epoch, last_sequence, pending, prompts.",
  },
  {
    method: "prompt.submit",
    shape: "a message",
    params: (s) => ({ session_id: s.sid, profile: s.profile, text: "hello" }),
    route: "authority",
    answer: { code: 4001, message: "invalid_params" },
    canonical: "prompt.submit {session_id, text, submission_id, queued?, attachments?: [{path, mime}]} → an admission receipt {admission_id, status, execution_generation}. `submission_id` is required.",
  },
  {
    method: "prompt.submit",
    shape: "a queued message",
    params: (s) => ({ session_id: s.sid, profile: s.profile, text: "hello", queued: true }),
    route: "authority",
    answer: { code: 4001, message: "invalid_params" },
    canonical: "The same, with `submission_id`. Hermes holds it in the session's own queue, which prompt.cancel, prompt.steer_queued and prompt.replace_queued change.",
  },
  {
    method: "session.interrupt",
    params: (s) => ({ session_id: s.sid }),
    route: "authority",
    answer: { code: 4001, message: "stale_generation" },
    canonical: "session.interrupt {session_id, execution_generation}, with the generation of the turn to stop.",
  },
  {
    method: "session.events.since",
    params: (s) => ({ session_id: s.sid, last_seen: Number.MAX_SAFE_INTEGER }),
    route: "authority",
    answer: "ok",
    canonical: "session.events.since {session_id, last_sequence, replay_epoch}. Without the epoch it answers `snapshot_required` and no events; waiting prompts are in the resume snapshot's `prompts`.",
  },
  moved("session.close", (s) => ({ session_id: s.sid }), "session.detach {session_id, subscription_id}."),
  moved("session.title", (s) => ({ session_id: s.sid, title: "Bot Chat" }), "session.mutate {session_id, request_id, expected_revision, operation: 'rename', payload: {title}}."),
  moved("session.cwd.set", (s) => ({ session_id: s.sid, profile: s.profile, cwd: "/tmp" }), "session.mutate {…, expected_generation, operation: 'workspace', payload: {cwd}}."),
  moved("session.branch", (s) => ({ session_id: s.sid, count: 1, idempotency_key: "k" }), "session.mutate {…, expected_generation, operation: 'branch', payload}."),
  moved("session.undo", (s) => ({ session_id: s.sid }), "session.mutate {…, expected_generation, operation: 'rewind', payload: {target_message_id}}."),
  moved("session.compress", (s) => ({ session_id: s.sid }), "session.mutate {…, expected_generation, operation: 'compress', payload}."),
  moved("session.status", (s) => ({ session_id: s.sid }), "session.info {session_id}."),
  { method: "session.list", params: (s) => ({ profile: s.profile, title: "Bot Chat", include_hidden: true, limit: 5 }), route: "authority", answer: "ok" },
  { method: "session.active_list", params: () => ({}), route: "authority", answer: "ok" },
  { method: "session.context_breakdown", params: (s) => ({ session_id: s.sid }), route: "authority", answer: "ok" },

  // Approvals and questions. An Approval and a Clarify arrive as `approval.request` and `clarify.request` events, each
  // with a `prompt_id` and an `execution_generation`, not as server→client requests.
  {
    method: "approval.respond",
    params: (s) => ({ session_id: s.sid, choice: "deny", request_id: "none" }),
    route: "authority",
    answer: { code: 4001, message: "invalid_params", fields: ["request_id"] },
    canonical: "approval.respond {session_id, execution_generation, prompt_id, choice} → {status: resolved | already_resolved}. A Clarify: clarify.respond {…, answer}.",
  },
  { method: "approval.received", params: (s) => ({ session_id: s.sid, request_id: "none" }), route: "authority", answer: "ok" },
  {
    method: "clarify.lock",
    params: () => ({ request_id: "none", question_id: "q1", answer: "x" }),
    route: "authority",
    answer: "ok",
    canonical: "Only for a batch `clarify` server request, which Hermes sends when the turn was submitted with `clarify_batch: true`. Otherwise each question is a `clarify.request` event, answered with clarify.respond.",
  },
  { method: "request.answer", params: () => ({ id: "srq-none", result: { choice: "deny" } }), route: "fallback", answer: "ok" },

  // Attachments.
  {
    method: "image.attach_bytes",
    params: (s) => ({ session_id: s.sid, filename: "dot.png", content_base64: PNG_1X1 }),
    route: "authority",
    answer: "ok",
    canonical: "It only stores the image and answers {path, mime}. Nothing is queued for the next turn: the path goes in prompt.submit's `attachments`.",
  },
  {
    method: "image.detach",
    params: (s) => ({ session_id: s.sid, path: "/none.png" }),
    route: "fallback",
    answer: { code: 4001, message: "session not found" },
    canonical: "Nothing to take back: an image is in a turn only when prompt.submit lists it.",
  },
  { method: "file.attach", params: (s) => ({ session_id: s.sid, name: "hello.txt", data_url: "data:application/octet-stream;base64,aGVsbG8=" }), route: "authority", answer: "ok" },

  // Model, settings and profiles.
  { method: "model.options", params: (s) => ({ profile: s.profile }), route: "authority", answer: "ok" },
  { method: "config.get", params: (s) => ({ key: "reasoning", profile: s.profile }), route: "authority", answer: "ok" },
  {
    method: "config.set",
    shape: "a chat's model",
    params: (s) => ({ session_id: s.sid, profile: s.profile, key: "model", value: "fake --provider custom --session" }),
    route: "authority",
    answer: { code: 4001, message: "use_session_mutation_model" },
    canonical: "session.mutate {…, expected_generation, operation: 'model', payload: {model, provider, confirm?, reasoning?}}.",
  },
  { method: "config.set", shape: "a chat's effort", params: (s) => ({ session_id: s.sid, profile: s.profile, key: "reasoning", value: "low", scope: "session" }), route: "authority", answer: "ok" },
  { method: "config.set", shape: "a chat's fast mode", params: (s) => ({ session_id: s.sid, profile: s.profile, key: "fast", value: "normal" }), route: "authority", answer: "ok" },
  { method: "config.set", shape: "a chat's YOLO", params: (s) => ({ session_id: s.sid, profile: s.profile, key: "yolo", value: "off" }), route: "authority", answer: "ok" },
  { method: "config.set", shape: "the profile's approval mode", params: (s) => ({ session_id: s.sid, profile: s.profile, key: "approvals.mode", value: "manual" }), route: "authority", answer: "ok" },
  { method: "profiles.list", params: () => ({}), route: "authority", answer: "ok" },
  { method: "profiles.get_asset", params: (s) => ({ name: s.profile, asset: "avatar" }), route: "fallback", answer: "ok" },
  { method: "llm.oneshot", params: (s) => ({ profile: s.profile, instructions: "Answer briefly.", input: "Say hi", max_tokens: 16 }), route: "authority", answer: "ok" },

  // Commands.
  { method: "commands.catalog", params: (s) => ({ profile: s.profile }), route: "authority", answer: "ok" },
  {
    method: "command.dispatch",
    shape: "/steer",
    params: (s) => ({ name: "steer", arg: "x", session_id: s.sid }),
    route: "authority",
    answer: { code: 4001, message: "unsupported_command" },
    canonical: "session.steer {session_id, execution_generation, text}.",
  },
  // `arxiv` is a skill Hermes bundles, so a new home has it.
  { method: "command.dispatch", shape: "a skill", params: (s) => ({ name: "arxiv", arg: "", session_id: s.sid }), route: "authority", answer: "ok" },
  { method: "slash.exec", params: (s) => ({ command: "/context", session_id: s.sid }), route: "authority", answer: "ok" },
  { method: "prompt.btw", params: (s) => ({ session_id: s.sid, text: "A side question" }), route: "authority", answer: "ok" },

  // Tools and subagents.
  { method: "tools.show", params: (s) => ({ session_id: s.sid }), route: "authority", answer: "ok" },
  { method: "subagent.list", params: (s) => ({ session_id: s.sid }), route: "authority", answer: "ok" },
  { method: "subagent.tail", params: (s) => ({ session_id: s.sid, subagent_id: "none" }), route: "authority", answer: "ok" },
  { method: "subagent.steer", params: (s) => ({ session_id: s.sid, subagent_id: "none", text: "x" }), route: "authority", answer: "ok" },
  { method: "subagent.interrupt", params: (s) => ({ session_id: s.sid, subagent_id: "none" }), route: "authority", answer: "ok" },
  { method: "subagent.roster", params: (s) => ({ profile: s.profile }), route: "fallback", answer: "ok" },

  // Projects.
  { method: "projects.list", params: (s) => ({ profile: s.profile }), route: "fallback", answer: "ok" },
  { method: "projects.create", params: (s) => ({ profile: s.profile, name: "Canonical probe" }), route: "fallback", answer: "ok" },
  { method: "projects.update", params: (s) => ({ profile: s.profile, id: "p_none", name: "X" }), route: "fallback", answer: { code: 5062, message: "no such project" } },
  { method: "projects.delete", params: (s) => ({ profile: s.profile, id: "p_none" }), route: "fallback", answer: { code: 5062, message: "no such project" } },
  { method: "projects.add_folder", params: (s) => ({ profile: s.profile, id: "p_none", path: "/tmp" }), route: "fallback", answer: { code: 5062, message: "no such project" } },
  { method: "projects.remove_folder", params: (s) => ({ profile: s.profile, id: "p_none", path: "/tmp" }), route: "fallback", answer: { code: 5062, message: "no such project" } },
  { method: "projects.membership.list", params: (s) => ({ profile: s.profile }), route: "none", answer: NO_METHOD("projects.membership.list") },
  { method: "projects.membership.apply", params: (s) => ({ profile: s.profile, ops: [] }), route: "none", answer: NO_METHOD("projects.membership.apply") },

  // Memory.
  { method: "learning.frames", params: () => ({ cols: 20, rows: 10, frames: 2 }), route: "fallback", answer: "ok" },
  { method: "learning.detail", params: () => ({ id: "no-such-entry" }), route: "fallback", answer: "ok" },
  { method: "learning.edit", params: () => ({ id: "no-such-entry", content: "x" }), route: "fallback", answer: "ok" },
  { method: "learning.delete", params: () => ({ id: "no-such-entry" }), route: "fallback", answer: "ok" },

  // The Screen.
  { method: "display.status", params: (s) => ({ profile: s.profile }), route: "fallback", answer: "ok" },
  { method: "display.start", params: (s) => ({ profile: s.profile }), route: "fallback", answer: "ok", unprobed: DESKTOP },
  { method: "display.observe", params: (s) => ({ profile: s.profile }), route: "fallback", answer: "ok", unprobed: DESKTOP },
  { method: "display.lease.acquire", params: (s) => ({ profile: s.profile, viewer_id: "v" }), route: "fallback", answer: "ok", unprobed: DESKTOP },
  { method: "display.lease.release", params: (s) => ({ profile: s.profile, viewer_id: "v" }), route: "fallback", answer: "ok", unprobed: DESKTOP },
];
