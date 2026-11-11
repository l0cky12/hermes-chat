// Screenshots and the files staged in each chat's composer. Rust takes the capture (src-tauri/src/screenshot.rs) and
// stages it in a private folder; the desk hands it to the composer on screen. Files pasted into the composer are staged
// the same way. The desk keeps every chat's staged attachments, keyed as its Draft is, so they wait there across chat
// switches until the owner sends or removes them (ADR 0145). It remembers which staged files are its own, so each one
// is deleted once nothing needs it any more. Nothing here sends anything to Hermes.

import type { Attachment } from "./model";
import { stagedFiles } from "./unsaved";
import { errorText } from "./values";

/** Why a capture produced no image, as Rust reports it. */
export type CaptureFailure = { kind: "cancelled" | "denied" | "unsupported" | "busy" | "failed"; message?: string };
/** A capture staged on disk, and anything the owner should know about how it was taken. */
export type Captured = { path: string; note?: string };

export type ScreenshotApi = {
  /** Rejects with a CaptureFailure, or a plain error when Rust couldn't be asked at all. */
  capture: (name: string) => Promise<Captured>;
  discard: (path: string) => Promise<void>;
};

/**
 * The composer on screen. `key` is its chat's Draft key (drafts.ts `draftKey`), where its captures are staged. `check`
 * resolves to the files Hermes can take, and shows why it refused any (one too large, say). `note` shows a line above
 * the composer.
 */
export type ScreenshotSink = {
  key: string;
  check: (paths: string[]) => Promise<Attachment[]>;
  note: (text: string) => void;
};

/**
 * Every way a chat's staged attachments change, each chat's under its Draft key. `added`: attached in the composer, or
 * back from a message Hermes didn't confirm. `sent`: they went with a message, which holds them from then on (`hold`,
 * `sent`, `finish`). `removed`: the owner took them out. `gone`: the chat was deleted or archived. A file the desk owns
 * is staged in one chat at a time, so it is deleted once it is removed, its chat goes, or its message no longer needs
 * it; signing out deletes them all (`dispose`). A file the owner picked from their own folders can be in several.
 */
export type Staging =
  | { kind: "added"; key: string; attachments: readonly Attachment[] }
  | { kind: "sent" | "removed"; key: string; paths: readonly string[] }
  | { kind: "gone"; key: string };

const NONE: readonly Attachment[] = [];

export type DeskState = { capturing: boolean };

/** `screenshot-2026-11-02-153417`, in local time: what a capture is called in the composer and in Hermes. */
export function captureName(now = new Date()): string {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString();
  return `screenshot-${local.slice(0, 10)}-${local.slice(11, 19).replaceAll(":", "")}`;
}

const isFailure = (e: unknown): e is CaptureFailure => typeof e === "object" && e !== null && typeof (e as CaptureFailure).kind === "string";

/** What the composer says when a capture didn't attach. Nothing for a cancelled one, or a second press while picking. */
export function failureText(e: unknown): string | undefined {
  if (!isFailure(e)) return `Couldn't take a screenshot: ${errorText(e)}`;
  switch (e.kind) {
    case "cancelled":
    case "busy":
      return undefined;
    case "denied":
      return e.message ?? "Your desktop didn't allow the screenshot.";
    case "unsupported":
      return `Screenshots don't work on this desktop yet. ${e.message ?? ""}`.trim();
    default:
      return `Couldn't take a screenshot: ${e.message ?? "no reason given"}`;
  }
}

const RESTORED = "Hermes didn't confirm it got your message, so its files are back here. Send them again, or remove them.";

/** A capture or a note waiting for a composer to show it. */
type Waiting = { paths: string[]; note?: string; remote: boolean };

export class ScreenshotDesk {
  private state: DeskState = { capturing: false };
  private readonly listeners = new Set<() => void>();
  /** Staged captures not yet discarded. */
  private readonly mine = new Set<string>();
  private waiting: Waiting[] = [];
  private readonly sending = new Set<string>();
  private readonly staged = new Map<string, readonly Attachment[]>();
  private sink?: ScreenshotSink;
  private disposed = false;

  /** `onAttached(remote)`: a capture went into the composer; `remote` when a desktop shortcut asked for it. */
  constructor(
    private readonly api: ScreenshotApi,
    private readonly onAttached?: (remote: boolean) => void,
  ) {}

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  getSnapshot = (): DeskState => this.state;

  private set(state: DeskState) {
    this.state = state;
    for (const fn of [...this.listeners]) fn();
  }

  /** Takes a screenshot and attaches it to the composer on screen. Does nothing while one is already being taken. */
  async capture({ remote = false }: { remote?: boolean } = {}): Promise<void> {
    if (this.state.capturing || this.disposed) return;
    this.set({ capturing: true });
    try {
      const got = await this.api.capture(captureName());
      if (this.disposed) return void this.api.discard(got.path).catch(() => {});
      this.mine.add(got.path);
      await this.deliver({ paths: [got.path], note: got.note, remote });
    } catch (e) {
      const text = failureText(e);
      if (text && !this.disposed) await this.deliver({ paths: [], note: text, remote });
    } finally {
      this.set({ capturing: false });
    }
  }

  /** Files Rust staged with the captures from a paste: deleted as captures are, once nothing needs them. */
  own(paths: readonly string[]) {
    if (this.disposed) return void paths.forEach((p) => void this.api.discard(p).catch(() => {}));
    for (const p of paths) this.mine.add(p);
  }

  /** The composer now on screen takes captures, and any that were waiting for one. Returns the function that stops it. */
  attachTo(sink: ScreenshotSink): () => void {
    this.sink = sink;
    const waiting = this.waiting;
    this.waiting = [];
    for (const w of waiting) void this.deliver(w);
    return () => {
      if (this.sink === sink) this.sink = undefined;
    };
  }

  private async deliver(w: Waiting): Promise<void> {
    const sink = this.sink;
    if (!sink) return void this.waiting.push(w);
    if (w.paths.length) {
      const kept = await sink.check(w.paths);
      // The composer went while it checked them (another chat opened, or Settings): they go to the one on screen now,
      // unless signing out already deleted them.
      if (this.sink !== sink) return this.deliver({ ...w, paths: w.paths.filter((p) => this.mine.has(p)) });
      this.change({ kind: "added", key: sink.key, attachments: kept });
      this.release(w.paths.filter((p) => !kept.some((a) => a.path === p)));
      if (kept.length) this.onAttached?.(w.remote);
    }
    if (w.note) sink.note(w.note);
  }

  /** The attachments staged in the chat whose Draft key is `key`, in the order they were added. */
  stagedIn = (key: string): readonly Attachment[] => this.staged.get(key) ?? NONE;

  change(e: Staging) {
    const now = this.stagedIn(e.key);
    let next: readonly Attachment[];
    let letGo: readonly string[] = [];
    switch (e.kind) {
      case "added":
        if (this.disposed) return this.release(e.attachments.map((a) => a.path));
        next = [...now, ...e.attachments.filter((a) => !now.some((x) => x.path === a.path))];
        // An owned file reaches a second chat only when the owner picks it from the captures folder. It moves here:
        // Rust deletes it once this chat's message no longer needs it, whichever chat still shows it.
        for (const [key, files] of this.staged) {
          const left = files.filter((a) => !(this.mine.has(a.path) && e.attachments.some((x) => x.path === a.path)));
          if (key === e.key || left.length === files.length) continue;
          if (left.length) this.staged.set(key, left);
          else this.staged.delete(key);
        }
        break;
      case "sent":
        next = now.filter((a) => !e.paths.includes(a.path));
        break;
      case "removed":
        next = now.filter((a) => !e.paths.includes(a.path));
        letGo = e.paths;
        break;
      case "gone":
        next = NONE;
        letGo = now.map((a) => a.path);
        break;
    }
    if (next.length === now.length) return this.release(letGo);
    if (next.length) this.staged.set(e.key, next);
    else this.staged.delete(e.key);
    this.stagedChanged();
    this.release(letGo);
  }

  private stagedChanged() {
    stagedFiles.set(this, [...this.staged.values()].flat());
    for (const fn of [...this.listeners]) fn();
  }

  /**
   * Puts captures sent with a message Hermes didn't confirm back in the chat they were sent from (`key`), so they
   * aren't lost with it; others are deleted. `accepted`: Hermes took the message.
   */
  sent(key: string, attachments: readonly Attachment[], accepted: boolean) {
    const paths = attachments.map((a) => a.path);
    for (const p of paths) this.sending.delete(p);
    if (accepted || this.disposed) return this.release(paths);
    const back = attachments.filter((a) => this.mine.has(a.path));
    if (!back.length) return;
    this.change({ kind: "added", key, attachments: back });
    if (this.sink?.key === key) this.sink.note(RESTORED);
  }

  /** The outbox takes responsibility while sending; no chat holds the files any more, and they stay until it lets go. */
  hold(paths: readonly string[]) {
    for (const p of paths) if (this.mine.has(p)) this.sending.add(p);
  }

  /** Rust has reconciled the outbox; release anything it no longer needs. */
  finish(paths: readonly string[]) {
    for (const p of paths) this.sending.delete(p);
    this.release(paths);
  }

  /**
   * Deletes any of `paths` that are captures no message is sending. Others are ignored: a file the owner picked from
   * their own folders is never deleted.
   */
  release(paths: readonly string[]) {
    for (const p of paths) if (!this.sending.has(p) && this.mine.delete(p)) void this.api.discard(p).catch(() => {});
  }

  /** The app is signing out or closing: every capture not yet sent is deleted, and one still being taken will be. */
  dispose() {
    this.disposed = true;
    this.waiting = [];
    this.staged.clear();
    this.stagedChanged();
    this.release([...this.mine]);
  }
}
