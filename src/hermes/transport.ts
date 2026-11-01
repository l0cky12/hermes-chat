// Frontend Hermes transport: speaks the legacy JSON-RPC generation of `/api/ws` over a Pipe and folds
// the server's frames into Chats. Wire shapes: docs/research/hermes-gateway-api.md §3d, §4, §5 and
// "SSH tunnel, Host header and protocol generation". Only the legacy verbs are used (ADR 0003).
// The chat list comes from dashboard REST, because the legacy `session.list` has no last-activity field.
// Attachments: research doc §7. A dropped connection is reconnected on its own; keepalive: research doc §1.
import type { AttachCheck, Attachment, Chat, ConnectionStatus, Item, Source } from "./model";
import type { OpenPipe, Pipe, PipeEvent, Route } from "./pipe";
import { isUnsecure } from "./unsecure";

/** The `source` this app stamps on chats it starts. Legacy `session.create` stores any string as-is. */
export const APP_SOURCE = "hermes-chat";
const READY_TIMEOUT_MS = 15_000;
/** Waits before each try to reconnect a dropped connection. When the last try fails the app is Offline until the
 * owner asks to reconnect, so a wrong password isn't retried for ever. */
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000];
/** A `gateway.ping` goes out this often. A connection that has sent nothing for longer than the official client's
 * heartbeat deadline is dropped. */
const PING_EVERY_MS = 15_000;
const SILENCE_LIMIT_MS = 45_000;
/** The list shows chats active in the past month. */
const LIST_WINDOW_MS = 30 * 86_400_000;
/** Dashboard REST caps `GET /api/sessions` pages at 100. */
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

const MiB = 1024 * 1024;
/** The most legacy `image.attach_bytes` and `file.attach` take (research doc §7). PDFs go as files: `pdf.attach`
 * needs `pdftoppm`, which the live server doesn't have. */
const LIMITS = { image: { bytes: 25 * MiB, what: "images" }, file: { bytes: 256 * MiB, what: "files" } };
/** The images Hermes looks at (`cli._IMAGE_EXTENSIONS`); anything else is staged as a file. */
const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp)$/i;
/** What the official desktop app asks when an image is sent with no text. */
const IMAGE_ONLY_PROMPT = "What do you see in this image?";
/** Stands in for a file's base64 in a frame; the pipe swaps the bytes in. JSON can't hold a raw NUL. */
const FILE_MARK = "\u0000file\u0000";

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

/** Legacy `image.attach_bytes` and `file.attach` results (research doc §7), as far as this app reads them. */
type ImageAttached = { path: string };
type FileAttached = { ref_text: string };

/** Legacy `session.interrupt` result (research doc §8). `not_interrupted` needs `expected_hosted_task_id`. */
type InterruptResult = { status: "interrupted" | "not_interrupted" };

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

/**
 * `route`: how the latest connection reached the dashboard. `unsecure`: its traffic isn't encrypted (unsecure.ts).
 * `closedReason`: why the connection dropped, or why the last try to reconnect failed.
 */
export type Snapshot = {
  chats: Chat[];
  status: ConnectionStatus;
  route?: Route;
  unsecure: boolean;
  closedReason?: string;
  syncError?: string;
};

/** Connects to Hermes; rejects if the first connection fails. Later drops are reconnected by the returned Hermes. */
export async function connect(openPipe: OpenPipe, profile = "default", cache: ChatCache = noCache): Promise<Hermes> {
  const hermes = new Hermes(openPipe, profile, cache);
  await hermes.dial();
  return hermes;
}

export class Hermes {
  private pipe?: Pipe;
  /** Counts pipes opened; events from an older pipe than the current one are ignored. */
  private generation = 0;
  /** The pipe being opened is waiting for `gateway.ready`. */
  private onReady?: (payload: Record<string, unknown>) => void;
  /** Ends the dial under way with this error. */
  private abortDial?: (e: Error) => void;
  /** The dropped pipe, until the Rust side has closed it. Opening the next one waits, because Rust holds a single
   * connection and closing drops whichever it holds. */
  private droppedClosing?: Promise<void>;
  private redialing?: Promise<void>;
  private failedTries = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private lastHeard = 0;
  private closing = false;
  /** Chats resumed on a connection that has since dropped: how many of their items the next resume replaces with the
   * stored history. */
  private staleItems = new Map<string, number>();
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners = new Set<() => void>();
  private snapshot: Snapshot;
  /** Chats this app made Active that Hermes hasn't stored as pinned yet (ADR 0002). */
  private awaitingPin = new Set<string>();
  /** Resumes in flight, so opening a chat and replying in it share one. */
  private resuming = new Map<string, Promise<string>>();
  /** Messages Hermes hasn't accepted yet, so a Stop waits for the turn it stops. */
  private submitting = new Map<string, Promise<unknown>>();
  private syncing?: Promise<void>;
  private syncAgain = false;
  private background = new Set<Promise<unknown>>();

  constructor(
    private openPipe: OpenPipe,
    readonly profile: string,
    private cache: ChatCache = noCache,
  ) {
    this.snapshot = { chats: cache.load(profile), status: "offline", unsecure: false };
  }

  /**
   * Opens a pipe and waits for `gateway.ready`. Used by `connect` and to reconnect; on failure the pipe is closed and
   * the error thrown.
   */
  async dial(): Promise<void> {
    await this.droppedClosing;
    const gen = ++this.generation;
    const ready = new Promise<Record<string, unknown>>((resolve) => (this.onReady = resolve));
    // Set as soon as the pipe closes or the app gives up, even after gateway.ready has arrived.
    let failure: Error | undefined;
    const failed = new Promise<never>((_, reject) => (this.abortDial = (e) => reject((failure ??= e))));
    failed.catch(() => {}); // Raced below, once the pipe is open.
    let up = false;
    let pipe: Pipe | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      pipe = await this.openPipe((e) => {
        if (gen !== this.generation) return;
        if (e.kind === "closed" && !up) this.abortDial?.(new Error(`The connection closed before Hermes was ready: ${e.reason}`));
        else this.handle(e);
      });
      const payload = await Promise.race([
        ready,
        failed,
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new Error("Hermes didn't send gateway.ready in time.")), READY_TIMEOUT_MS);
        }),
      ]);
      if (failure) throw failure;
      if (payload.session_authority) throw new ProtocolMismatchError();
    } catch (e) {
      this.generation++;
      await pipe?.close().catch(() => {});
      throw e;
    } finally {
      clearTimeout(timer);
      this.onReady = this.abortDial = undefined;
    }
    up = true;
    this.pipe = pipe;
    this.lastHeard = Date.now();
    this.heartbeat = setInterval(() => this.beat(), PING_EVERY_MS);
    this.update({ status: "connected", closedReason: undefined, route: pipe.route, unsecure: isUnsecure(pipe.route) });
  }

  /** Tries to connect again now, after a drop or from Offline, and keeps retrying on its own if that fails. */
  reconnect(): Promise<void> {
    if (!this.redialing) this.failedTries = 0;
    return this.redial();
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

  /** Checks local files the owner wants to attach: images up to 25 MB, other files up to 256 MB. */
  async checkAttachments(paths: string[]): Promise<AttachCheck> {
    if (!this.pipe) throw new Error("Not connected to Hermes.");
    const attachments: Attachment[] = [];
    const refused: string[] = [];
    for (const f of await this.pipe.statFiles(paths)) {
      if (f.size === undefined) {
        refused.push(`Couldn't attach ${f.name}: ${f.error}`);
        continue;
      }
      const kind = IMAGE_EXTENSIONS.test(f.name) ? "image" : "file";
      const limit = LIMITS[kind];
      if (f.size > limit.bytes)
        refused.push(`${f.name} is ${(f.size / MiB).toFixed(1)} MB. Hermes takes ${limit.what} up to ${limit.bytes / MiB} MB.`);
      else attachments.push({ path: f.path, name: f.name, size: f.size, kind });
    }
    return { attachments, refused };
  }

  /**
   * Sends a message and its attachments. A chat not yet open on this connection is resumed first; a Settled one
   * becomes Active.
   */
  async send(chatId: string, text: string, attachments: Attachment[] = []): Promise<void> {
    const chat = this.snapshot.chats.find((c) => c.id === chatId);
    if (!chat) return;
    const activating = chat.settled;
    if (activating) this.awaitingPin.add(chatId);
    this.patchChat(chatId, (c) => ({
      ...c,
      settled: false,
      running: true,
      updatedAt: Date.now(),
      title: c.items.length === 0 && c.runtimeId ? (text || attachments[0]?.name || c.title).slice(0, 48) : c.title,
      items: [
        ...c.items,
        { kind: "user", id: `u-${c.items.length}`, text, ...(attachments.length && { attachments: attachments.map((a) => a.name) }) },
      ],
    }));
    try {
      const submitting = this.resume(chatId).then((runtimeId) => this.submit(runtimeId, text, attachments));
      this.submitting.set(chatId, submitting);
      try {
        await submitting;
      } finally {
        if (this.submitting.get(chatId) === submitting) this.submitting.delete(chatId);
      }
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
   * Stops the chat's reply with legacy `session.interrupt`, once Hermes has accepted the message it answers. Hermes
   * answers before the agent has stopped, so the chat is `stopping` until the turn's `message.complete`, which
   * marks the reply interrupted and its running tool calls stopped. If Hermes can't stop it, the chat says so and
   * the reply keeps running.
   */
  async stop(chatId: string): Promise<void> {
    const stoppable = () => {
      const c = this.snapshot.chats.find((c) => c.id === chatId);
      return c?.running && !c.stopping ? c : undefined;
    };
    if (!stoppable()) return;
    try {
      await this.submitting.get(chatId);
    } catch {
      return; // send() has shown why the message didn't go.
    }
    const chat = stoppable();
    if (!chat?.runtimeId) return;
    this.patchChat(chatId, (c) => ({ ...c, stopping: true }));
    try {
      const res = (await this.request("session.interrupt", { session_id: chat.runtimeId })) as InterruptResult;
      if (res.status !== "interrupted") this.patchChat(chatId, (c) => ({ ...c, stopping: false }));
    } catch (e) {
      // A turn that has already ended, or a dropped connection, needs no error.
      this.patchChat(chatId, (c) =>
        c.stopping ? { ...c, stopping: false, items: [...c.items, errorItem(c, `Couldn't stop the reply: ${(e as Error).message}`)] } : c,
      );
    }
  }

  /**
   * Refreshes the chat list from dashboard REST: the profile's chats active in the past month, Active when
   * pinned. A call while a sync is running asks for one more pass and resolves with it.
   */
  sync(): Promise<void> {
    if (this.snapshot.status !== "connected") return Promise.resolve(); // Reconnecting syncs again.
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
    this.closing = true;
    this.abortDial?.(new Error("Closed by the app."));
    this.generation++;
    clearTimeout(this.retryTimer);
    clearInterval(this.heartbeat);
    await this.pipe?.close();
  }

  private handle(e: PipeEvent) {
    if (e.kind === "closed") return this.dropped(e.reason);
    this.lastHeard = Date.now();
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

  /**
   * The connection has dropped: requests in flight fail, replies stop running, and reconnecting starts. Closing a
   * connection detaches its runtime sessions, so each chat resumed on it resumes again when next opened.
   */
  private dropped(reason: string) {
    const pipe = this.pipe;
    this.pipe = undefined;
    this.generation++;
    clearInterval(this.heartbeat);
    // Lets the Rust side end the tunnel.
    if (pipe) this.droppedClosing = pipe.close().catch(() => {}).finally(() => (this.droppedClosing = undefined));
    for (const p of this.pending.values()) p.reject(new Error(`Connection closed: ${reason}`));
    this.pending.clear();
    for (const c of this.snapshot.chats) if (c.runtimeId) this.staleItems.set(c.id, c.items.length);
    this.update({
      status: "reconnecting",
      closedReason: reason,
      chats: this.snapshot.chats.map((c) => (c.runtimeId || c.running ? { ...c, runtimeId: undefined, running: false, stopping: false } : c)),
    });
    this.retryLater();
  }

  private retryLater() {
    const wait = RETRY_DELAYS_MS[this.failedTries];
    if (wait === undefined) return this.update({ status: "offline" });
    this.retryTimer = setTimeout(() => void this.redial(), wait);
  }

  private redial(): Promise<void> {
    if (this.closing || this.snapshot.status === "connected") return Promise.resolve();
    this.redialing ??= (async () => {
      clearTimeout(this.retryTimer);
      this.update({ status: "reconnecting" });
      try {
        await this.dial();
        this.failedTries = 0;
        void this.sync();
      } catch (e) {
        if (this.closing) return;
        this.failedTries++;
        this.update({ closedReason: (e as Error).message });
        // A server that changed protocol won't change back on its own.
        if (e instanceof ProtocolMismatchError) this.update({ status: "offline" });
        else this.retryLater();
      } finally {
        this.redialing = undefined;
      }
    })();
    return this.redialing;
  }

  /** Pings Hermes, or drops the connection if it has gone quiet; any frame counts as an answer. */
  private beat() {
    if (Date.now() - this.lastHeard > SILENCE_LIMIT_MS) return this.dropped("Hermes stopped answering.");
    this.request("gateway.ping", {}).catch(() => {});
  }

  /**
   * Stages the attachments for the session's next turn, then submits the message. Images are queued server-side;
   * other files are staged in the session's workspace and their `@file:` refs go before the text, as the official
   * desktop app does. If anything fails the message isn't sent, and images already queued are taken back so they
   * don't ride along with the next one.
   */
  private async submit(runtimeId: string, text: string, attachments: Attachment[]) {
    const queued: string[] = [];
    const refs: string[] = [];
    try {
      for (const a of attachments) {
        const file = { path: a.path, maxBytes: LIMITS[a.kind].bytes };
        try {
          if (a.kind === "image") {
            const params = { session_id: runtimeId, filename: a.name, content_base64: FILE_MARK };
            queued.push(((await this.request("image.attach_bytes", params, file)) as ImageAttached).path);
          } else {
            const params = { session_id: runtimeId, name: a.name, data_url: `data:application/octet-stream;base64,${FILE_MARK}` };
            refs.push(((await this.request("file.attach", params, file)) as FileAttached).ref_text);
          }
        } catch (e) {
          throw new Error(`Couldn't attach ${a.name}: ${(e as Error).message}`);
        }
      }
      const prompt = [refs.join("\n"), text].filter(Boolean).join("\n\n") || (queued.length ? IMAGE_ONLY_PROMPT : "");
      return await this.request("prompt.submit", { session_id: runtimeId, profile: this.profile, text: prompt });
    } catch (e) {
      for (const path of queued) this.track(this.request("image.detach", { session_id: runtimeId, path }));
      throw e;
    }
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
        const stale = this.staleItems.get(chatId) ?? 0;
        this.staleItems.delete(chatId);
        this.patchChat(chatId, (c) => ({
          ...c,
          runtimeId: res.session_id,
          items: [...history, ...withoutLoadError(c.items.slice(stale))],
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

  /** One JSON-RPC request. With a `file`, the pipe swaps its base64 in for the `FILE_MARK` in `params`. */
  private request(method: string, params: Record<string, unknown>, file?: { path: string; maxBytes: number }): Promise<unknown> {
    const pipe = this.pipe;
    if (!pipe || this.snapshot.status !== "connected") return Promise.reject(new Error("Not connected to Hermes."));
    const id = this.nextId++;
    const done = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const [head, tail, ...rest] = frame.split(JSON.stringify(FILE_MARK).slice(1, -1));
    const sent = !file
      ? pipe.send(frame)
      : rest.length === 0 && tail !== undefined
        ? pipe.sendFile(head, file.path, tail, file.maxBytes)
        : Promise.reject(new Error("the request has no single place for the file"));
    sent.catch((err) => {
      this.pending.get(id)?.reject(err instanceof Error ? err : new Error(String(err)));
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

/** Ends a turn's tool calls that were still running when it ended. */
const endRunningTools = (items: Item[], status: "done" | "stopped") =>
  items.map((i): Item => (i.kind === "tool" && i.status === "running" ? { ...i, status } : i));

/**
 * Marks the last reply interrupted and its running tool calls stopped. A reply stopped before it said anything gets
 * an empty one, so the transcript still shows the stop.
 */
function markInterrupted(items: Item[]): Item[] {
  const out = endRunningTools(items, "stopped");
  const last = out[out.length - 1];
  if (last?.kind === "assistant") out[out.length - 1] = { ...last, interrupted: true };
  else out.push({ kind: "assistant", id: `a-${out.length}`, text: "", interrupted: true });
  return out;
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
      const end = { ...c, running: false, stopping: false, updatedAt: Date.now() };
      // Stopped here or from another Hermes client.
      if (p.status === "interrupted") return { ...end, items: markInterrupted(items) };
      const failure = p.error ?? (p.status === "error" ? p.failure_reason ?? "The turn failed." : undefined);
      if (failure) items.push(errorItem({ ...c, items }, String(failure)));
      return { ...end, items: endRunningTools(items, "done") };
    }
    case "error":
      items.push(errorItem(c, String(p.message ?? "Hermes reported an error.")));
      return { ...c, items, running: false, stopping: false };
    default:
      return c;
  }
}
