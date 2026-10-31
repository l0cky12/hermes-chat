// Frontend Hermes transport: speaks the legacy JSON-RPC generation of `/api/ws` over a Pipe and folds
// the server's frames into Chats. Wire shapes: docs/research/hermes-gateway-api.md §3d, §4 and
// "SSH tunnel, Host header and protocol generation". Only the legacy verbs are used (ADR 0003).
import type { Chat, ConnectionStatus, Item } from "./model";
import type { OpenPipe, Pipe, PipeEvent } from "./pipe";

/** The `source` this app stamps on chats it starts. Legacy `session.create` stores any string as-is. */
export const APP_SOURCE = "hermes-chat";
const READY_TIMEOUT_MS = 15_000;

type RpcFrame = {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: { type?: string; session_id?: string; payload?: Record<string, unknown> } & Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
};

export class ProtocolMismatchError extends Error {
  constructor() {
    super("This Hermes server speaks the canonical session protocol, which Hermes Chat doesn't support yet.");
  }
}

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export type Snapshot = { chats: Chat[]; status: ConnectionStatus; closedReason?: string };

export async function connect(openPipe: OpenPipe, profile = "default"): Promise<Hermes> {
  const hermes = new Hermes(profile);
  let ready!: (payload: Record<string, unknown>) => void;
  let failed!: (e: Error) => void;
  const readyPayload = new Promise<Record<string, unknown>>((res, rej) => ((ready = res), (failed = rej)));
  hermes.onReady = ready;
  hermes.onClosedBeforeReady = (reason) => failed(new Error(`The connection closed before Hermes was ready: ${reason}`));
  const pipe = await openPipe((e) => hermes.handle(e));
  hermes.attach(pipe);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const payload = await Promise.race([
      readyPayload,
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error("Hermes didn't send gateway.ready in time.")), READY_TIMEOUT_MS);
      }),
    ]);
    if (payload.session_authority) throw new ProtocolMismatchError();
  } catch (e) {
    await hermes.close();
    throw e;
  } finally {
    clearTimeout(timer);
  }
  return hermes;
}

export class Hermes {
  onReady?: (payload: Record<string, unknown>) => void;
  onClosedBeforeReady?: (reason: string) => void;

  private pipe?: Pipe;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners = new Set<() => void>();
  private snapshot: Snapshot = { chats: [], status: "connected" };

  constructor(readonly profile: string) {}

  attach(pipe: Pipe) {
    this.pipe = pipe;
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };

  getSnapshot = () => this.snapshot;

  /** Starts a Chat in this app. It is Active from the start (ADR 0002). */
  async newChat(): Promise<string> {
    const res = (await this.request("session.create", { profile: this.profile, source: APP_SOURCE })) as { session_id: string };
    const chat: Chat = { id: res.session_id, title: "New chat", source: "app", settled: false, updatedAt: Date.now(), items: [] };
    this.update({ chats: [chat, ...this.snapshot.chats] });
    return chat.id;
  }

  async send(chatId: string, text: string): Promise<void> {
    this.patchChat(chatId, (c) => ({
      ...c,
      settled: false,
      running: true,
      updatedAt: Date.now(),
      title: c.items.length === 0 ? text.slice(0, 48) : c.title,
      items: [...c.items, { kind: "user", id: `u-${c.items.length}`, text }],
    }));
    try {
      await this.request("prompt.submit", { session_id: chatId, profile: this.profile, text });
    } catch (e) {
      this.patchChat(chatId, (c) => ({ ...c, running: false, items: [...c.items, errorItem(c, (e as Error).message)] }));
    }
  }

  async close() {
    await this.pipe?.close();
  }

  handle(e: PipeEvent) {
    if (e.kind === "closed") {
      this.onClosedBeforeReady?.(e.reason);
      for (const p of this.pending.values()) p.reject(new Error(`Connection closed: ${e.reason}`));
      this.pending.clear();
      this.update({
        status: "offline",
        closedReason: e.reason,
        chats: this.snapshot.chats.map((c) => (c.running ? { ...c, running: false } : c)),
      });
      return;
    }
    let frame: RpcFrame;
    try {
      frame = JSON.parse(e.text);
    } catch {
      return;
    }
    if (frame.method === undefined && typeof frame.id === "number") {
      const p = this.pending.get(frame.id);
      if (!p) return;
      this.pending.delete(frame.id);
      if (frame.error) p.reject(new RpcError(frame.error.code, frame.error.message));
      else p.resolve(frame.result);
      return;
    }
    if (frame.method !== "event" || !frame.params?.type) return;
    const { type, session_id, payload = {} } = frame.params;
    if (type === "gateway.ready") {
      this.onClosedBeforeReady = undefined;
      this.onReady?.(payload);
      return;
    }
    if (session_id) this.patchChat(session_id, (c) => applyEvent(c, type, payload));
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.pipe || this.snapshot.status === "offline") return Promise.reject(new Error("Not connected to Hermes."));
    const id = this.nextId++;
    const done = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.pipe.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })).catch((err) => {
      this.pending.get(id)?.reject(new Error(String(err)));
      this.pending.delete(id);
    });
    return done;
  }

  private patchChat(id: string, fn: (c: Chat) => Chat) {
    if (!this.snapshot.chats.some((c) => c.id === id)) return;
    this.update({ chats: this.snapshot.chats.map((c) => (c.id === id ? fn(c) : c)) });
  }

  private update(patch: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const fn of this.listeners) fn();
  }
}

function errorItem(c: Chat, text: string): Item {
  return { kind: "error", id: `e-${c.items.length}`, text };
}

// Fold one session event into a chat. Text deltas extend the trailing assistant item, or start a new one
// after a tool call.
function applyEvent(c: Chat, type: string, p: Record<string, unknown>): Chat {
  const items = [...c.items];
  const last = items[items.length - 1];
  switch (type) {
    case "message.start":
      return { ...c, running: true, updatedAt: Date.now() };
    case "message.delta": {
      const text = p.text;
      if (typeof text !== "string" || !text) return c;
      if (last?.kind === "assistant") items[items.length - 1] = { ...last, text: last.text + text };
      else items.push({ kind: "assistant", id: `a-${items.length}`, text });
      return { ...c, items, updatedAt: Date.now() };
    }
    case "tool.start":
      items.push({
        kind: "tool",
        id: String(p.tool_id),
        name: String(p.name ?? "tool"),
        args: p.args as Record<string, unknown> | undefined,
        preview: p.preview as string | undefined,
        status: "running",
      });
      return { ...c, items };
    case "tool.complete":
      return {
        ...c,
        items: items.map((i) =>
          i.kind === "tool" && i.id === String(p.tool_id)
            ? {
                ...i,
                status: "done",
                durationS: p.duration_s as number | undefined,
                result: typeof p.result === "string" ? p.result : p.result == null ? undefined : JSON.stringify(p.result, null, 2),
                summary: p.summary as string | undefined,
              }
            : i,
        ),
      };
    case "message.complete": {
      // Providers that don't stream send the whole reply here; a streamed turn repeats text it already sent.
      const lastUser = items.map((i) => i.kind).lastIndexOf("user");
      const answered = items.slice(lastUser + 1).some((i) => i.kind === "assistant");
      if (!answered && typeof p.text === "string" && p.text) items.push({ kind: "assistant", id: `a-${items.length}`, text: p.text });
      const failure = p.error ?? (p.status === "error" ? p.failure_reason ?? "The turn failed." : undefined);
      if (failure) items.push(errorItem({ ...c, items }, String(failure)));
      return {
        ...c,
        running: false,
        updatedAt: Date.now(),
        items: items.map((i) => (i.kind === "tool" && i.status === "running" ? { ...i, status: "done" } : i)),
      };
    }
    case "error":
      items.push(errorItem(c, String(p.message ?? "Hermes reported an error.")));
      return { ...c, items, running: false };
    default:
      return c;
  }
}
