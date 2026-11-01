// A fake Hermes dashboard for tests: it sits where the Rust pipe does and speaks wire-shaped legacy
// JSON-RPC frames and dashboard REST bodies (shapes from the deployed contracts, see the research doc).
import type { OpenPipe, PipeEvent } from "./pipe";

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

const DAY = 86_400;
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
      this.respond(r.id, { session_id: runtimeId, stored_session_id: stored, message_count: 2, messages: [], info: {}, running: false });
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
  closed = false;

  openPipe: OpenPipe = async (onEvent) => {
    this.onEvent = onEvent;
    // The server writes gateway.ready as soon as the socket is accepted.
    this.frame({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: this.readyPayload } });
    return {
      send: async (text) => {
        const req = JSON.parse(text) as Request;
        this.requests.push(req);
        this.handlers[req.method]?.(req);
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
