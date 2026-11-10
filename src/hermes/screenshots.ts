// Screenshots for the composer. Rust takes the capture (src-tauri/src/screenshot.rs) and stages it in a private folder;
// the desk hands it to the composer on screen, where it waits as an image attachment until the owner sends or removes
// it. Files pasted into the composer are staged the same way. The desk remembers which staged files are its own, so
// each one is deleted once it is sent, removed, or left behind (a chat switched away from, or signing out). Nothing
// here sends anything to Hermes.

import type { Attachment } from "./model";

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
 * The composer on screen. `attach` stages the files and resolves to the ones it kept (one too large for Hermes is
 * refused, with its note). `note` shows a line above the composer.
 */
export type ScreenshotSink = {
  attach: (paths: string[]) => Promise<string[]>;
  /** A mounted pane lost capture routing while validation finished; remove its provisional copies before rerouting. */
  detach?: (paths: string[]) => void;
  /** Already validated captures returning after an unconfirmed send; works while disconnected. */
  restore: (attachments: Attachment[]) => void;
  note: (text: string) => void;
};

export type DeskState = { capturing: boolean };

/** `screenshot-2026-11-02-153417`, in local time: what a capture is called in the composer and in Hermes. */
export function captureName(now = new Date()): string {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString();
  return `screenshot-${local.slice(0, 10)}-${local.slice(11, 19).replaceAll(":", "")}`;
}

const isFailure = (e: unknown): e is CaptureFailure => typeof e === "object" && e !== null && typeof (e as CaptureFailure).kind === "string";

/** What the composer says when a capture didn't attach. Nothing for a cancelled one, or a second press while picking. */
export function failureText(e: unknown): string | undefined {
  if (!isFailure(e)) return `Couldn't take a screenshot: ${e instanceof Error ? e.message : String(e)}`;
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
type Waiting = { paths: string[]; restored?: Attachment[]; note?: string; remote: boolean };

export class ScreenshotDesk {
  private state: DeskState = { capturing: false };
  private readonly listeners = new Set<() => void>();
  /** Staged captures not yet discarded. */
  private readonly mine = new Set<string>();
  private waiting: Waiting[] = [];
  private readonly sending = new Set<string>();
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

  /** Files Rust staged with the captures from a paste: deleted as captures are, once sent, removed or left behind. */
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
    if (w.restored) {
      sink.restore(w.restored.filter((a) => this.mine.has(a.path)));
    } else if (w.paths.length) {
      const kept = await sink.attach(w.paths);
      // The composer went while it checked them (another chat opened, or Settings): they go to the one on screen
      // now, unless the old one already let them go.
      if (this.sink !== sink) {
        sink.detach?.(w.paths);
        return this.deliver({ ...w, paths: w.paths.filter((p) => this.mine.has(p)) });
      }
      this.release(w.paths.filter((p) => !kept.includes(p)));
      if (kept.length) this.onAttached?.(w.remote);
    }
    if (w.note) sink.note(w.note);
  }

  /**
   * Puts captures sent with a message Hermes didn't confirm back in the composer on screen, so they aren't lost with
   * it; others are deleted. `accepted`: Hermes took the message.
   */
  sent(attachments: readonly Attachment[], accepted: boolean) {
    const paths = attachments.map((a) => a.path);
    for (const p of paths) this.sending.delete(p);
    if (accepted || this.disposed) return this.release(paths);
    const back = attachments.filter((a) => this.mine.has(a.path));
    if (back.length) void this.deliver({ paths: [], restored: back, remote: false, note: RESTORED });
  }

  /** The outbox takes responsibility while sending; closing the composer must not remove its files. */
  hold(paths: readonly string[]) {
    for (const p of paths) if (this.mine.has(p)) this.sending.add(p);
  }

  /** Rust has reconciled the outbox; release anything it no longer needs. */
  finish(paths: readonly string[]) {
    for (const p of paths) this.sending.delete(p);
    this.release(paths);
  }

  /** Deletes any of `paths` that are captures: sent, removed from the composer, or left behind. Others are ignored. */
  release(paths: readonly string[]) {
    for (const p of paths) if (!this.sending.has(p) && this.mine.delete(p)) {
      this.sending.delete(p);
      void this.api.discard(p).catch(() => {});
    }
  }

  /** The app is signing out or closing: every capture not yet sent is deleted, and one still being taken will be. */
  dispose() {
    this.disposed = true;
    this.waiting = [];
    this.release([...this.mine].filter((p) => !this.sending.has(p)));
  }
}
