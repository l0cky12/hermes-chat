// Frontend Hermes transport: speaks the legacy JSON-RPC generation of `/api/ws` over a Pipe and folds
// the server's frames into Chats. Wire shapes: docs/research/hermes-gateway-api.md §3d, §4, §5 and
// "SSH tunnel, Host header and protocol generation". Only the legacy verbs are used (ADR 0003).
// The chat list comes from dashboard REST, because the legacy `session.list` has no last-activity field.
import type { Chat, ConnectionStatus, Item, Source } from "./model";
import type { OpenPipe, Pipe, PipeEvent } from "./pipe";

/** The `source` this app stamps on chats it starts. Legacy `session.create` stores any string as-is. */
export const APP_SOURCE = "hermes-chat";
const READY_TIMEOUT_MS = 15_000;
/** The list shows chats active in the past month. */
const LIST_WINDOW_MS = 30 * 86_400_000;
/** Dashboard REST caps `GET /api/sessions` pages at 100. */
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

/** Where each profile's last synced chat list is kept between launches. */
export type ChatCache = { load(profile: string): Chat[]; save(profile: string, chats: Chat[]): void };
const noCache: ChatCache = { load: () => [], save: () => {} };

/** A row of dashboard REST `GET /api/sessions`; times are Unix seconds. */
type SessionRow = {
  id: string;
  source?: string;
  title?: string | null;
  preview?: string;
  started_at?: number;
  last_active?: number | null;
  pinned?: boolean;
  archived?: boolean;
};
type SessionPage = { sessions: SessionRow[]; total: number };

/** A history row from legacy `session.resume` (research doc §5, `TranscriptMessage`). Tool rows carry the call's
 * name, args and an 80-char `context`; Hermes keeps the result (`content`) only for edit tools. */
type TranscriptMessage = {
  role: string;
  text?: string | null;
  content?: unknown;
  name?: string | null;
  context?: string | null;
  args?: Record<string, unknown> | null;
};

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

export type Snapshot = { chats: Chat[]; status: ConnectionStatus; closedReason?: string; syncError?: string };

export async function connect(openPipe: OpenPipe, profile = "default", cache: ChatCache = noCache): Promise<Hermes> {
  const hermes = new Hermes(profile, cache);
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
  private snapshot: Snapshot;
  /** Chats this app made Active that Hermes hasn't stored as pinned yet (ADR 0002). */
  private awaitingPin = new Set<string>();
  /** Resumes in flight, so opening a chat and replying in it share one. */
  private resuming = new Map<string, Promise<string>>();
  private syncing?: Promise<void>;
  private syncAgain = false;
  private background = new Set<Promise<unknown>>();

  constructor(
    readonly profile: string,
    private cache: ChatCache = noCache,
  ) {
    this.snapshot = { chats: cache.load(profile), status: "connected" };
  }

  attach(pipe: Pipe) {
    this.pipe = pipe;
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };

  getSnapshot = () => this.snapshot;

  /** Starts a Chat in this app. It is Active from the start, and pinned once Hermes has stored it (ADR 0002). */
  async newChat(): Promise<string> {
    const res = (await this.request("session.create", { profile: this.profile, source: APP_SOURCE })) as {
      session_id: string;
      stored_session_id: string;
    };
    const chat: Chat = {
      id: res.stored_session_id,
      runtimeId: res.session_id,
      title: "New chat",
      source: "app",
      settled: false,
      updatedAt: Date.now(),
      items: [],
    };
    this.awaitingPin.add(chat.id);
    this.update({ chats: [chat, ...this.snapshot.chats] });
    return chat.id;
  }

  /**
   * Opens a chat: one this connection hasn't resumed yet is resumed now and shows its stored history. If that
   * fails the chat shows why, and the next open tries again.
   */
  async open(chatId: string): Promise<void> {
    if (!this.snapshot.chats.some((c) => c.id === chatId)) return;
    try {
      await this.resume(chatId);
    } catch (e) {
      // A reply sent meanwhile shares this resume and reports the failure itself.
      this.patchChat(chatId, (c) =>
        c.running ? c : { ...c, items: [...withoutLoadError(c.items), { kind: "error", id: LOAD_ERROR_ID, text: `Couldn't load this chat: ${(e as Error).message}` }] },
      );
    }
  }

  /** Sends a message. A chat not yet open on this connection is resumed first; a Settled one becomes Active. */
  async send(chatId: string, text: string): Promise<void> {
    const chat = this.snapshot.chats.find((c) => c.id === chatId);
    if (!chat) return;
    const activating = chat.settled;
    if (activating) this.awaitingPin.add(chatId);
    this.patchChat(chatId, (c) => ({
      ...c,
      settled: false,
      running: true,
      updatedAt: Date.now(),
      title: c.items.length === 0 && c.runtimeId ? text.slice(0, 48) : c.title,
      items: [...c.items, { kind: "user", id: `u-${c.items.length}`, text }],
    }));
    try {
      const runtimeId = await this.resume(chatId);
      await this.request("prompt.submit", { session_id: runtimeId, profile: this.profile, text });
      // Pin now if Hermes has stored the session; a new chat may not have its row yet, so the end of the turn
      // tries again.
      if (this.awaitingPin.has(chatId)) this.track(this.pin(chatId, { quiet: true }));
    } catch (e) {
      if (activating) this.awaitingPin.delete(chatId);
      this.patchChat(chatId, (c) => ({
        ...c,
        running: false,
        settled: activating || c.settled,
        items: [...c.items, errorItem(c, (e as Error).message)],
      }));
    }
  }

  /**
   * Refreshes the chat list from dashboard REST: the profile's chats active in the past month, Active when
   * pinned. A call while a sync is running asks for one more pass and resolves with it.
   */
  sync(): Promise<void> {
    if (this.syncing) {
      this.syncAgain = true;
      return this.syncing;
    }
    this.syncing = (async () => {
      try {
        do {
          this.syncAgain = false;
          await this.syncOnce();
        } while (this.syncAgain);
      } finally {
        this.syncing = undefined;
      }
    })();
    this.track(this.syncing);
    return this.syncing;
  }

  /** Resolves once background work (list syncs, pinning) has finished. Tests wait on it; the app doesn't need to. */
  async idle() {
    while (this.background.size) await Promise.allSettled([...this.background]);
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
    // Broadcast when any process changes the session store (tui_gateway/change_watcher.py).
    if (type === "sessions.changed") {
      void this.sync();
      return;
    }
    const chat = session_id ? this.snapshot.chats.find((c) => c.runtimeId === session_id) : undefined;
    if (!chat) return;
    this.patchChat(chat.id, (c) => applyEvent(c, type, payload));
    // By the end of a turn Hermes has stored the session, so a pin that failed earlier can succeed.
    if (type === "message.complete" && this.awaitingPin.has(chat.id)) this.track(this.pin(chat.id));
  }

  /** The chat's runtime id on this connection, resuming it first if needed. The history goes before anything sent
   * meanwhile. */
  private resume(chatId: string): Promise<string> {
    const known = this.snapshot.chats.find((c) => c.id === chatId)?.runtimeId;
    if (known) return Promise.resolve(known);
    let resuming = this.resuming.get(chatId);
    if (resuming) return resuming;
    this.patchChat(chatId, (c) => ({ ...c, loading: true }));
    resuming = (async () => {
      try {
        const res = (await this.request("session.resume", { session_id: chatId, profile: this.profile, inline_images: false })) as {
          session_id: string;
          messages?: TranscriptMessage[];
        };
        const history = historyItems(res.messages ?? []);
        this.patchChat(chatId, (c) => ({
          ...c,
          runtimeId: res.session_id,
          items: [...history, ...withoutLoadError(c.items)],
        }));
        return res.session_id;
      } finally {
        this.resuming.delete(chatId);
        this.patchChat(chatId, (c) => ({ ...c, loading: false }));
      }
    })();
    this.resuming.set(chatId, resuming);
    return resuming;
  }

  private async pin(chatId: string, { quiet = false } = {}) {
    try {
      await this.rest("PATCH", `api/sessions/${encodeURIComponent(chatId)}`, { pinned: true, profile: this.profile });
      this.awaitingPin.delete(chatId);
    } catch (e) {
      // Stays pending: the chat is still Active here, and the next finished turn tries again.
      if (!quiet) this.update({ syncError: `Couldn't keep a chat Active on the server: ${(e as Error).message}` });
    }
  }

  private async syncOnce() {
    const cutoff = Date.now() - LIST_WINDOW_MS;
    const rows = new Map<string, SessionRow>();
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const offset = page * PAGE_SIZE;
        const query = new URLSearchParams({
          profile: this.profile,
          order: "recent",
          limit: String(PAGE_SIZE),
          offset: String(offset),
          exclude_sources: "cron",
        });
        const res = (await this.rest("GET", `api/sessions?${query}`)) as SessionPage;
        for (const r of res.sessions) rows.set(r.id, r);
        // Every page also carries all pinned rows, out of order; the unpinned ones follow recency.
        const passedCutoff = res.sessions.some((r) => !r.pinned && lastActive(r) < cutoff);
        if (passedCutoff || res.sessions.length === 0 || offset + PAGE_SIZE >= res.total) break;
      }
    } catch (e) {
      this.update({ syncError: `Couldn't refresh the chat list: ${(e as Error).message}` });
      return;
    }

    const known = new Map(this.snapshot.chats.map((c) => [c.id, c]));
    const listed = [...rows.values()]
      .filter((r) => !r.archived && lastActive(r) >= cutoff)
      .map((r): Chat => {
        const c = known.get(r.id);
        if (r.pinned) this.awaitingPin.delete(r.id);
        return {
          items: [],
          ...c,
          id: r.id,
          title: r.title || r.preview || c?.title || "Untitled chat",
          source: toSource(r.source),
          settled: !r.pinned && !this.awaitingPin.has(r.id),
          updatedAt: Math.max(c?.updatedAt ?? 0, lastActive(r)),
        };
      });
    // Chats started or resumed on this connection stay even before Hermes stores them (a new chat has no row
    // until its first prompt).
    const listedIds = new Set(listed.map((c) => c.id));
    const onThisConnection = this.snapshot.chats.filter((c) => c.runtimeId && !listedIds.has(c.id));
    const chats = [...onThisConnection, ...listed];
    this.update({ chats, syncError: undefined });
    this.cache.save(
      this.profile,
      chats.map(({ id, title, source, settled, updatedAt }) => ({ id, title, source, settled, updatedAt, items: [] })),
    );
  }

  private async rest(method: "GET" | "PATCH", pathAndQuery: string, body?: unknown): Promise<unknown> {
    if (!this.pipe) throw new Error("Not connected to Hermes.");
    return JSON.parse(await this.pipe.request(method, pathAndQuery, body === undefined ? undefined : JSON.stringify(body)));
  }

  private track(p: Promise<unknown>) {
    const done: Promise<unknown> = p.catch(() => {}).finally(() => this.background.delete(done));
    this.background.add(done);
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

function lastActive(r: SessionRow): number {
  return (r.last_active ?? r.started_at ?? 0) * 1000;
}

/** A chat's Source from the session's `source` field. This app's own chats, and `gui` ones, show no icon. */
function toSource(source = ""): Source {
  switch (source) {
    case APP_SOURCE:
    case "gui":
      return "app";
    case "telegram":
    case "discord":
    case "desktop":
      return source;
    case "cli":
    case "tui":
      return "cli";
    default:
      return "other";
  }
}

const LOAD_ERROR_ID = "load-error";
const withoutLoadError = (items: Item[]) => items.filter((i) => i.id !== LOAD_ERROR_ID);

/** Stored history as transcript items. Hermes doesn't keep tool results, except for edit tools. */
function historyItems(messages: TranscriptMessage[]): Item[] {
  return messages.flatMap((m, i): Item[] => {
    const id = `h-${i}`;
    if (m.role === "tool")
      return [
        {
          kind: "tool",
          id,
          name: m.name || "tool",
          args: m.args ?? undefined,
          preview: m.context || undefined,
          status: "done",
          result: typeof m.content === "string" ? m.content : undefined,
        },
      ];
    // Assistant rows can be reasoning only; system rows are timeline notes this app doesn't show yet.
    if (!m.text?.trim()) return [];
    if (m.role === "user" || m.role === "assistant") return [{ kind: m.role, id, text: m.text }];
    return [];
  });
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
