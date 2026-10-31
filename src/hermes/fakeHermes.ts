// A fake Hermes dashboard for tests: it sits where the Rust pipe does and speaks wire-shaped legacy
// JSON-RPC frames (shapes from the deployed contracts, see the research doc).
import type { OpenPipe, PipeEvent } from "./pipe";

type Request = { jsonrpc: "2.0"; id: number; method: string; params: Record<string, unknown> };
type Handler = (req: Request) => void;

export class FakeHermes {
  /** Every request the client sent, in order. */
  readonly requests: Request[] = [];
  readyPayload: Record<string, unknown> = { skin: {}, change_events: true, heartbeat: true, replay_epoch: "e1" };
  /** Per-method behaviour; tests override entries. Unhandled methods get no answer. */
  readonly handlers: Record<string, Handler> = {
    "session.create": (r) =>
      this.respond(r.id, {
        session_id: `live-${this.requests.filter((q) => q.method === "session.create").length}`,
        stored_session_id: "20261031_120000_abc123",
        message_count: 0,
        messages: [],
        info: {},
      }),
    "prompt.submit": (r) => this.respond(r.id, { status: "streaming" }),
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

  drop(reason = "closed by the server (1006 )") {
    this.onEvent?.({ kind: "closed", reason });
  }

  last(method: string) {
    return [...this.requests].reverse().find((r) => r.method === method);
  }

  private frame(f: unknown) {
    this.onEvent?.({ kind: "frame", text: JSON.stringify(f) });
  }
}
