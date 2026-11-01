// A fake Hermes dashboard for tests: it sits where the Rust pipe does and speaks wire-shaped legacy
// JSON-RPC frames and dashboard REST bodies (shapes from the deployed contracts, see the research doc).
import type { LocalFile, OpenPipe, PipeEvent, Route } from "./pipe";

type Request = { jsonrpc: "2.0"; id: number; method: string; params: Record<string, unknown> };
/** The client's answer to a server→client request (`tui_gateway/server_requests.py`). */
type Response = { jsonrpc: "2.0"; id: string; result?: Record<string, unknown>; error?: { code: number; message: string } };
/** A server→client request still waiting for its answer. `stored`: its session, which outlives the connection. */
type OpenRequest = { sid: string; stored: string; method: string; params: Record<string, unknown> };
type Handler = (req: Request) => void;
export type RestRequest = { method: string; path: string; query: URLSearchParams; body?: Record<string, unknown> };
type RestHandler = (req: RestRequest) => unknown;

/** A `sessions` row as dashboard REST `GET /api/sessions` returns it (research doc §5). */
export type SessionRow = {
  id: string;
  source: string;
  title: string | null;
  preview: string;
  started_at: number;
  last_active: number | null;
  message_count: number;
  pinned: boolean;
  archived: boolean;
  /** The read watermark: unread when activity postdates it. `null` = never tracked = read; 0 = marked unread. */
  last_read_at: number | null;
};

/**
 * One history row as legacy `session.resume` returns it (`tui_gateway/session_history.py` `_history_to_messages`
 * at the deployed `bf0203a`). Tool rows carry name, args and an 80-char `context`; only edit tools keep `content`.
 */
export type TranscriptMessage = {
  role: "user" | "assistant" | "tool" | "system";
  text?: string;
  content?: unknown;
  tool_call_id?: string;
  name?: string;
  context?: string;
  args?: Record<string, unknown>;
  timestamp?: number;
  display_kind?: string;
  reasoning?: string;
};

/** A file on the owner's disk: its bytes as a string, a size alone for a file too big to make, or a folder. */
export type FakeFile = string | { size: number } | { dir: true };

const DAY = 86_400;
const MiB = 1024 * 1024;
const now = () => Date.now() / 1000;

/** A stored session `daysAgo` days old, unpinned and from this app unless overridden. */
export function row(id: string, daysAgo: number, over: Partial<SessionRow> = {}): SessionRow {
  const at = now() - daysAgo * DAY;
  return { id, source: "hermes-chat", title: `Chat ${id}`, preview: "", started_at: at, last_active: at, message_count: 2, pinned: false, archived: false, last_read_at: null, ...over };
}

export class FakeHermes {
  /** Every request the client sent, in order. */
  readonly requests: Request[] = [];
  readonly restRequests: RestRequest[] = [];
  readyPayload: Record<string, unknown> = { skin: {}, change_events: true, heartbeat: true, replay_epoch: "e1" };
  /** How the pipe reaches this server, as the Rust side reports it. */
  route: Route = { kind: "ssh", target: "liam@hermes" };
  /** While set, opening a pipe fails with this message, as the Rust side does when the server can't be reached. */
  refuse?: string;
  /** How many pipes have been opened. */
  opened = 0;
  /** The `default` profile's stored sessions. A chat started over the WS gets a row on its first prompt. */
  sessions: SessionRow[] = [];
  /** Every other profile's stored sessions, by profile name. Each profile has its own store (research doc §5). */
  otherProfiles: Record<string, SessionRow[]> = {};
  /** The `?profile=` each `/api/ws` connection was opened with, in order. */
  readonly wsProfiles: string[] = [];
  /** Stored session id -> its history, as `session.resume` projects it (`_history_to_messages`). */
  transcripts: Record<string, TranscriptMessage[]> = {};
  /** The owner's local disk, by path, for attachments. */
  files: Record<string, FakeFile> = {};
  /** Whether this connection sent `client.capabilities {server_requests: true}`. */
  answersRequests = false;
  /** Server→client requests nobody has answered yet, by id. */
  readonly openRequests = new Map<string, OpenRequest>();
  /** The client's answers to server→client requests, in order. */
  readonly responses: Response[] = [];
  /** runtime session id -> stored session id, for every session.create / session.resume. */
  readonly runtime = new Map<string, string>();
  private created = new Map<string, { source: string; profile?: string }>(); // runtime id, until the first prompt stores it

  /** Per-method behaviour; tests override entries. Unhandled methods get no answer. */
  readonly handlers: Record<string, Handler> = {
    "session.create": (r) => {
      const n = this.requests.filter((q) => q.method === "session.create").length;
      const runtimeId = `rt-${n}`;
      const stored = `20261031_12000${n}_abc123`;
      this.runtime.set(runtimeId, stored);
      this.created.set(runtimeId, { source: String(r.params.source ?? "tui"), profile: r.params.profile as string | undefined });
      this.respond(r.id, { session_id: runtimeId, stored_session_id: stored, message_count: 0, messages: [], info: {} });
    },
    "session.resume": (r) => {
      const stored = String(r.params.session_id);
      if (!this.store(r.params.profile as string | undefined)?.some((s) => s.id === stored)) return this.fail(r.id, 4007, `session not found: ${stored}`);
      // A session waiting on the owner is still live after its connection dropped: the resume reattaches it, with
      // the requests still open (`_resume_reuse_live`, `_live_session_payload` at the deployed `bf0203a`).
      const open = [...this.openRequests].filter(([, q]) => q.stored === stored);
      if (open.length) {
        const sid = open[0][1].sid;
        this.runtime.set(sid, stored);
        const messages = this.transcripts[stored] ?? [];
        const open_requests = open.map(([id, q]) => ({ id, method: q.method, params: { session_id: sid, ...q.params } }));
        return this.respond(r.id, { session_id: sid, stored_session_id: stored, message_count: messages.length, messages, info: {}, running: true, open_requests });
      }
      const runtimeId = `rt-r${++this.resumed}`;
      this.runtime.set(runtimeId, stored);
      const messages = this.transcripts[stored] ?? [];
      this.respond(r.id, { session_id: runtimeId, stored_session_id: stored, message_count: messages.length, messages, info: {}, running: false });
    },
    "prompt.submit": (r) => {
      const runtimeId = String(r.params.session_id);
      const created = this.created.get(runtimeId);
      if (created) {
        this.created.delete(runtimeId);
        const stored = row(this.runtime.get(runtimeId)!, 0, { source: created.source, title: null, preview: String(r.params.text), message_count: 1 });
        this.store(created.profile)?.push(stored);
      }
      this.respond(r.id, { status: "streaming" });
    },
    // Attachments stage server-side for the session's next turn (research doc §7; `tui_gateway/methods_prompt.py`
    // at the deployed `bf0203a`). Images join `attached_images`; other files land in the session's
    // `attachments/` and the client puts the `@file:` ref in the prompt text.
    "image.attach_bytes": (r) => {
      const n = ++this.imagesStaged;
      const name = `upload_${n}.png`;
      const bytes = atob(String(r.params.content_base64)).length;
      this.respond(r.id, { attached: true, path: `/hermes/images/${name}`, name, count: n, remainder: "", text: `[User attached image: ${name}]`, bytes });
    },
    "file.attach": (r) => {
      const name = String(r.params.name);
      const refPath = `attachments/${name}`;
      this.respond(r.id, { attached: true, name, path: `/hermes/workspace/${refPath}`, ref_path: refPath, ref_text: `@file:${formatRefValue(refPath)}`, uploaded: true });
    },
    "image.detach": (r) => {
      this.imagesStaged--;
      this.respond(r.id, { detached: true, count: this.imagesStaged });
    },
    // Legacy `session.interrupt` (tui_gateway/methods_session_interrupt.py). The turn then ends with a
    // `message.complete` whose status is "interrupted"; tests send that themselves.
    "session.interrupt": (r) => {
      const sid = String(r.params.session_id);
      if (!this.runtime.has(sid)) return this.fail(r.id, 4001, "session not found");
      this.respond(r.id, { status: "interrupted" });
      // The interrupt withdraws whatever the session was waiting on.
      for (const [id, q] of this.openRequests) if (q.sid === sid) this.cancelRequest(id, "interrupted");
    },
    // `tui_gateway/methods_voice.py` at the deployed `bf0203a`: lists the server→client request kinds it knows.
    "client.capabilities": (r) => {
      if ("server_requests" in r.params) this.answersRequests = !!r.params.server_requests;
      this.respond(r.id, { server_requests: ["approval", "clarify", "secret", "sudo"], declines_not_shown: true });
    },
    // `tui_gateway/methods_prompt.py` at the deployed `bf0203a`: records that a client has the card on screen.
    "approval.received": (r) => {
      const pending = [...this.openRequests.values()].some((q) => q.sid === r.params.session_id && q.params.request_id === r.params.request_id);
      this.respond(r.id, { acknowledged: pending });
    },
    // Keepalive, answered by the WS layer in either protocol generation (research doc §1).
    "gateway.ping": (r) => this.respond(r.id, { ok: true }),
  };

  /** Per-route REST behaviour, keyed `METHOD /path`. A handler throws to fail the request. */
  readonly rest: Record<string, RestHandler> = {
    "GET /api/sessions": ({ query }) => {
      // order=recent, archived=exclude, then every pinned row not already on the page (list_sessions_rich).
      const excluded = (query.get("exclude_sources") ?? "").split(",").filter(Boolean);
      const visible = this.storeOrFail(query.get("profile")).filter((s) => !excluded.includes(s.source));
      const recent = visible.filter((s) => !s.archived).sort((a, b) => (b.last_active ?? b.started_at) - (a.last_active ?? a.started_at));
      const offset = Number(query.get("offset") ?? 0);
      const limit = Number(query.get("limit") ?? 20);
      const page = recent.slice(offset, offset + limit);
      const pinned = visible.filter((s) => s.pinned && !page.includes(s));
      return { sessions: [...page, ...pinned].map((s) => ({ ...s, unread: unread(s) })), total: recent.length, limit, offset, storage: {} };
    },
    // `search_sessions` in `hermes_cli/web_routers/sessions.py` at the deployed `bf0203a`: one row per chat, archived
    // ones too. Message hits come first, then title matches. FTS5 matches a message holding every word of the query,
    // each as a prefix; its `snippet()` marks the matched words between `>>>` and `<<<`. Message hits carry the
    // message's `role`.
    "GET /api/sessions/search": ({ query }) => {
      const q = (query.get("q") ?? "").trim();
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      if (!words.length) return { results: [] };
      const limit = Math.min(Number(query.get("limit") ?? 20), 100);
      const excluded = (query.get("exclude_sources") ?? "").split(",").filter(Boolean);
      const store = this.storeOrFail(query.get("profile")).filter((s) => !excluded.includes(s.source));
      const hits = (token: string) => words.some((w) => token.toLowerCase().startsWith(w));
      const results = new Map<string, Record<string, unknown>>();
      const add = (s: SessionRow, snippet: string, role: string | null) =>
        results.size < limit && !results.has(s.id) && results.set(s.id, {
          snippet, role, source: s.source, model: null, session_started: s.started_at, session_id: s.id, lineage_root: s.id,
          profile: query.get("profile") ?? "default", id: s.id, title: s.title, started_at: s.started_at,
          last_active: s.last_active ?? s.started_at, message_count: s.message_count, preview: s.preview, archived: s.archived,
        });
      for (const s of store)
        for (const m of this.transcripts[s.id] ?? []) {
          const text = m.text ?? (typeof m.content === "string" ? m.content : "");
          // Odd entries are FTS5 tokens (unicode61: runs of letters and digits), even ones what lies between.
          const parts = text.split(/([\p{L}\p{N}]+)/u);
          const tokens = parts.filter((_, i) => i % 2);
          if (!words.every((w) => tokens.some((t) => t.toLowerCase().startsWith(w)))) continue;
          // snippet(..., '>>>', '<<<', '...', 40): up to 40 tokens from a little before the first match.
          const first = parts.findIndex((t, i) => i % 2 && hits(t));
          const start = Math.max(1, first - 20);
          const end = Math.min(parts.length, start + 79);
          const body = parts.slice(start, end).map((t, i) => (i % 2 === 0 && hits(t) ? `>>>${t}<<<` : t)).join("");
          add(s, `${start > 1 ? "..." : parts[0]}${body}${end < parts.length - 1 ? "..." : (parts[end] ?? "")}`, m.role);
          break;
        }
      for (const s of store) if (s.title?.toLowerCase().includes(q.toLowerCase())) add(s, s.preview || `Session title matched: ${q}`, null);
      return { results: [...results.values()] };
    },
    // `hermes_cli/web_routers/profiles.py` `_profile_to_dict` at the deployed `bf0203a`, trimmed to what matters here.
    "GET /api/profiles": () => ({
      profiles: ["default", ...Object.keys(this.otherProfiles)].map((name) => ({
        name,
        path: name === "default" ? "/home/liam/.hermes" : `/home/liam/.hermes/profiles/${name}`,
        is_default: name === "default",
        model: null,
        provider: null,
        description: "",
        display_name: "",
      })),
    }),
  };

  private onEvent?: (e: PipeEvent) => void;
  private imagesStaged = 0;
  private resumed = 0;
  private asked = 0;
  closed = false;

  openPipe: OpenPipe = async (onEvent, profile) => {
    if (this.refuse !== undefined) throw new Error(this.refuse);
    this.opened++;
    this.wsProfiles.push(profile);
    this.closed = false;
    // Runtime sessions belong to the connection that started them; closing it detaches them (research doc §5).
    this.runtime.clear();
    this.onEvent = onEvent;
    // The server writes gateway.ready as soon as the socket is accepted.
    this.frame({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: this.readyPayload } });
    // A new connection hasn't said yet whether it answers server→client requests.
    this.answersRequests = false;
    const send = async (text: string) => {
      const req = JSON.parse(text) as Request | Response;
      if (!("method" in req)) {
        this.responses.push(req);
        this.openRequests.delete(req.id);
        return;
      }
      this.requests.push(req);
      this.handlers[req.method]?.(req);
    };
    return {
      route: this.route,
      send,
      // Mirrors the Rust side (src-tauri/src/transport.rs): sizes from the disk, and a size check before sending.
      statFiles: async (paths) => paths.map((path) => this.stat(path)),
      sendFile: async (head, path, tail, maxBytes) => {
        const f = this.stat(path);
        if (f.error) throw new Error(f.error);
        if (f.size! > maxBytes) throw new Error(`it's ${(f.size! / MiB).toFixed(1)} MB now, over the ${maxBytes / MiB} MB limit`);
        const bytes = this.files[path];
        if (typeof bytes !== "string") throw new Error(`the fake has only a size for ${path}, no bytes to send`);
        await send(head + btoa(bytes) + tail);
      },
      request: async (method, pathAndQuery, body) => {
        const url = new URL(pathAndQuery, "http://dashboard/");
        const req: RestRequest = { method, path: url.pathname, query: url.searchParams, body: body === undefined ? undefined : JSON.parse(body) };
        this.restRequests.push(req);
        const patch = /^\/api\/sessions\/([^/]+)$/.exec(req.path);
        const handler = this.rest[`${method} ${req.path}`] ?? (method === "PATCH" && patch ? () => this.patchSession(patch[1], req.body!) : undefined);
        if (!handler) throw new Error(`The dashboard answered 404: {"detail":"Not Found"}`);
        return JSON.stringify(await handler(req));
      },
      close: async () => {
        this.closed = true;
      },
    };
  };

  respond(id: number, result: unknown) {
    this.frame({ jsonrpc: "2.0", id, result });
  }

  fail(id: number, code: number, message: string) {
    this.frame({ jsonrpc: "2.0", id, error: { code, message } });
  }

  event(sessionId: string, type: string, payload: Record<string, unknown> = {}) {
    this.frame({ jsonrpc: "2.0", method: "event", params: { type, session_id: sessionId, payload } });
  }

  /** A session-less broadcast such as `sessions.changed` (tui_gateway `_broadcast_global_event`). */
  broadcast(type: string, payload: Record<string, unknown> = {}) {
    this.event("", type, payload);
  }

  /**
   * Asks the client something (`server_requests.send_async`) and returns the request's id. A connection that never
   * said it answers such requests is sent nothing, and the request fails at once. A request asked while the
   * connection is down stays open for the next resume.
   */
  ask(sid: string, method: string, params: Record<string, unknown>): string | undefined {
    if (!this.answersRequests) return undefined;
    const id = `srq-${(++this.asked).toString(16).padStart(12, "0")}`;
    this.openRequests.set(id, { sid, stored: this.runtime.get(sid)!, method, params });
    this.frame({ jsonrpc: "2.0", id, method, params: { session_id: sid, ...params } });
    return id;
  }

  /** An `approval` request as `server._approval_request_payload` renders it: the command redacted, the choices set. */
  askApproval(sid: string, over: Record<string, unknown> = {}) {
    const params = {
      request_id: `apr-${this.asked + 1}`,
      command: "rm -rf /var/log/old",
      description: "recursive delete",
      allow_session: true,
      allow_permanent: true,
      tool_name: "terminal",
      choices: ["once", "session", "always", "deny"],
      ...over,
    };
    return { id: this.ask(sid, "approval", params), requestId: params.request_id };
  }

  /** Hermes stops waiting for an answer (timeout, interrupt, answered elsewhere) and withdraws the request. */
  cancelRequest(id: string, reason: string) {
    const q = this.openRequests.get(id);
    if (!q) return;
    this.openRequests.delete(id);
    this.event(q.sid, "request.cancel", { id, method: q.method, reason });
  }

  drop(reason = "closed by the server (1006 )") {
    this.onEvent?.({ kind: "closed", reason });
  }

  last(method: string) {
    return [...this.requests].reverse().find((r) => r.method === method);
  }

  /** The runtime session id the server handed out for a stored session. */
  runtimeIdOf(stored: string) {
    return [...this.runtime].reverse().find(([, s]) => s === stored)?.[0];
  }

  private stat(path: string): LocalFile {
    const name = path.split("/").pop()!;
    const f = this.files[path];
    if (f === undefined) return { path, name, error: "No such file or directory (os error 2)" };
    if (typeof f === "object" && "dir" in f) return { path, name, error: "it's a folder" };
    return { path, name, size: typeof f === "string" ? f.length : f.size };
  }

  /** A profile's stored sessions; no profile means the default one. Undefined for a profile the server doesn't have. */
  store(profile?: string | null): SessionRow[] | undefined {
    return !profile || profile === "default" ? this.sessions : this.otherProfiles[profile];
  }

  private storeOrFail(profile?: string | null): SessionRow[] {
    const store = this.store(profile);
    if (!store) throw new Error(`The dashboard answered 404: {"detail":"Profile '${profile}' not found"}`);
    return store;
  }

  private patchSession(id: string, body: Record<string, unknown>) {
    const s = this.storeOrFail(body.profile as string | undefined).find((r) => r.id === id);
    if (!s) throw new Error(`The dashboard answered 404: {"detail":"Session not found"}`);
    if (typeof body.pinned === "boolean") s.pinned = body.pinned;
    if (typeof body.unread === "boolean") s.last_read_at = body.unread ? 0 : now();
    return { ok: true };
  }

  private frame(f: unknown) {
    this.onEvent?.({ kind: "frame", text: JSON.stringify(f) });
  }
}

/** `SessionDB.session_unread`: activity postdates the read watermark, and `null` means read. */
export function unread(s: SessionRow): boolean {
  return s.last_read_at !== null && (s.last_active ?? s.started_at) > s.last_read_at;
}

/** `tui_gateway/prompt_attachments.py::_format_ref_value`: quote a ref with whitespace, brackets or quotes. */
function formatRefValue(value: string): string {
  if (!/[\s()[\]{}<>"'`]/.test(value)) return value;
  const q = ["`", '"', "'"].find((q) => !value.includes(q));
  return q ? `${q}${value}${q}` : value;
}
