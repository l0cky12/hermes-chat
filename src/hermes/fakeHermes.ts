// A fake Hermes dashboard for tests: it sits where the Rust pipe does and speaks wire-shaped legacy
// JSON-RPC frames and dashboard REST bodies (shapes from the deployed contracts, see the research doc).
import type { LocalFile, OpenPipe, PipeEvent } from "./pipe";

type Request = { jsonrpc: "2.0"; id: number; method: string; params: Record<string, unknown> };
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
  return { id, source: "hermes-chat", title: `Chat ${id}`, preview: "", started_at: at, last_active: at, message_count: 2, pinned: false, archived: false, ...over };
}

export class FakeHermes {
  /** Every request the client sent, in order. */
  readonly requests: Request[] = [];
  readonly restRequests: RestRequest[] = [];
  readyPayload: Record<string, unknown> = { skin: {}, change_events: true, heartbeat: true, replay_epoch: "e1" };
  /** The profile's stored sessions. A chat started over the WS gets a row on its first prompt. */
  sessions: SessionRow[] = [];
  /** Stored session id -> its history, as `session.resume` projects it (`_history_to_messages`). */
  transcripts: Record<string, TranscriptMessage[]> = {};
  /** The owner's local disk, by path, for attachments. */
  files: Record<string, FakeFile> = {};
  /** runtime session id -> stored session id, for every session.create / session.resume. */
  readonly runtime = new Map<string, string>();
  private created = new Map<string, string>(); // runtime id -> source, until the first prompt stores it

  /** Per-method behaviour; tests override entries. Unhandled methods get no answer. */
  readonly handlers: Record<string, Handler> = {
    "session.create": (r) => {
      const n = this.requests.filter((q) => q.method === "session.create").length;
      const runtimeId = `rt-${n}`;
      const stored = `20261031_12000${n}_abc123`;
      this.runtime.set(runtimeId, stored);
      this.created.set(runtimeId, String(r.params.source ?? "tui"));
      this.respond(r.id, { session_id: runtimeId, stored_session_id: stored, message_count: 0, messages: [], info: {} });
    },
    "session.resume": (r) => {
      const stored = String(r.params.session_id);
      if (!this.sessions.some((s) => s.id === stored)) return this.fail(r.id, 4007, `session not found: ${stored}`);
      const runtimeId = `rt-r${this.runtime.size + 1}`;
      this.runtime.set(runtimeId, stored);
      const messages = this.transcripts[stored] ?? [];
      this.respond(r.id, { session_id: runtimeId, stored_session_id: stored, message_count: messages.length, messages, info: {}, running: false });
    },
    "prompt.submit": (r) => {
      const runtimeId = String(r.params.session_id);
      const source = this.created.get(runtimeId);
      if (source) {
        this.created.delete(runtimeId);
        this.sessions.push(row(this.runtime.get(runtimeId)!, 0, { source, title: null, preview: String(r.params.text), message_count: 1 }));
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
      if (!this.runtime.has(String(r.params.session_id))) return this.fail(r.id, 4001, "session not found");
      this.respond(r.id, { status: "interrupted" });
    },
  };

  /** Per-route REST behaviour, keyed `METHOD /path`. A handler throws to fail the request. */
  readonly rest: Record<string, RestHandler> = {
    "GET /api/sessions": ({ query }) => {
      // order=recent, archived=exclude, then every pinned row not already on the page (list_sessions_rich).
      const excluded = (query.get("exclude_sources") ?? "").split(",").filter(Boolean);
      const visible = this.sessions.filter((s) => !excluded.includes(s.source));
      const recent = visible.filter((s) => !s.archived).sort((a, b) => (b.last_active ?? b.started_at) - (a.last_active ?? a.started_at));
      const offset = Number(query.get("offset") ?? 0);
      const limit = Number(query.get("limit") ?? 20);
      const page = recent.slice(offset, offset + limit);
      const pinned = visible.filter((s) => s.pinned && !page.includes(s));
      return { sessions: [...page, ...pinned], total: recent.length, limit, offset, storage: {} };
    },
  };

  private onEvent?: (e: PipeEvent) => void;
  private imagesStaged = 0;
  closed = false;

  openPipe: OpenPipe = async (onEvent) => {
    this.onEvent = onEvent;
    // The server writes gateway.ready as soon as the socket is accepted.
    this.frame({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: this.readyPayload } });
    const send = async (text: string) => {
      const req = JSON.parse(text) as Request;
      this.requests.push(req);
      this.handlers[req.method]?.(req);
    };
    return {
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
        return JSON.stringify(handler(req));
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

  private patchSession(id: string, body: Record<string, unknown>) {
    const s = this.sessions.find((r) => r.id === id);
    if (!s) throw new Error(`The dashboard answered 404: {"detail":"Session not found"}`);
    if (typeof body.pinned === "boolean") s.pinned = body.pinned;
    return { ok: true };
  }

  private frame(f: unknown) {
    this.onEvent?.({ kind: "frame", text: JSON.stringify(f) });
  }
}

/** `tui_gateway/prompt_attachments.py::_format_ref_value`: quote a ref with whitespace, brackets or quotes. */
function formatRefValue(value: string): string {
  if (!/[\s()[\]{}<>"'`]/.test(value)) return value;
  const q = ["`", '"', "'"].find((q) => !value.includes(q));
  return q ? `${q}${value}${q}` : value;
}
