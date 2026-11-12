// Read aloud: plays one reply at a time, on the owner's click. The audio Hermes sends lives in memory as a Blob URL
// only while it plays; stopping, finishing, failing, starting another reply or closing the chat releases it.
import type { Speech } from "../hermes/pipe";
import { errorText } from "../hermes/values";

/** What the reply `itemId` is doing: fetching its audio, playing, or why it couldn't. */
export type Speaking = { itemId: string; phase: "loading" | "playing" } | { itemId: string; phase: "failed"; why: string };

/** The bit of an `<audio>` element the speaker uses, so tests can stand in for it. */
export type Player = Pick<HTMLAudioElement, "play" | "pause" | "removeAttribute" | "load" | "src" | "onended" | "onerror">;

export class Speaker {
  private state?: Speaking;
  private readonly listeners = new Set<() => void>();
  private player?: Player;
  private url?: string;
  /** Bumped by every start and stop, so audio arriving for an earlier one is dropped. */
  private turn = 0;
  private disposed = false;

  constructor(
    private readonly speak: (text: string) => Promise<Speech>,
    private readonly makePlayer: () => Player = () => new Audio(),
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  /** What the reply `itemId` is doing, if anything. */
  of(itemId: string): Speaking | undefined {
    return this.state?.itemId === itemId ? this.state : undefined;
  }

  /** What is loading, playing or failed, whichever reply it is. */
  current(): Speaking | undefined {
    return this.state;
  }

  /** The text of the reply last started, for telling an echo of it from the owner's own words. */
  lastSpoken(): string | undefined {
    return this.spoken;
  }

  /** Reads the reply aloud, or stops it if it's already loading or playing. Another reply playing is stopped first. */
  toggle(itemId: string, text: string): void {
    const now = this.of(itemId);
    if (now && now.phase !== "failed") return this.stop();
    void this.start(itemId, text);
  }

  /** Reads the reply aloud from the start, whatever was playing: a Voice conversation speaking Hermes's answer. */
  play(itemId: string, text: string): void {
    if (this.disposed) return;
    void this.start(itemId, text);
  }

  private spoken?: string;

  private async start(itemId: string, text: string) {
    this.release();
    const turn = ++this.turn;
    this.spoken = text;
    this.set({ itemId, phase: "loading" });
    let speech: Speech;
    try {
      speech = await this.speak(text);
    } catch (e) {
      if (turn === this.turn) this.set({ itemId, phase: "failed", why: errorText(e) });
      return;
    }
    if (turn !== this.turn || this.disposed) return;
    const url = URL.createObjectURL(new Blob([speech.audio as BlobPart], { type: speech.mime }));
    const player = this.makePlayer();
    this.url = url;
    this.player = player;
    const fail = (why: string) => {
      if (turn !== this.turn) return;
      this.release();
      this.set({ itemId, phase: "failed", why });
    };
    player.onended = () => turn === this.turn && this.stop();
    player.onerror = () => fail(`This computer couldn't play the ${speech.mime} audio Hermes sent.`);
    player.src = url;
    this.set({ itemId, phase: "playing" });
    try {
      await player.play();
    } catch (e) {
      fail(`The audio couldn't start: ${errorText(e)}`);
    }
  }

  /** Stops whatever is loading or playing, and forgets a failure. */
  stop(): void {
    this.turn++;
    this.release();
    this.set(undefined);
  }

  /** Stops, and lets go of the listeners: the chat closed. */
  dispose(): void {
    this.disposed = true;
    this.stop();
    this.listeners.clear();
  }

  private release() {
    const player = this.player;
    if (player) {
      player.onended = null;
      player.onerror = null;
      player.pause();
      player.removeAttribute("src");
      player.load();
    }
    if (this.url) URL.revokeObjectURL(this.url);
    this.player = undefined;
    this.url = undefined;
  }

  private set(state: Speaking | undefined) {
    this.state = state;
    for (const l of this.listeners) l();
  }
}
