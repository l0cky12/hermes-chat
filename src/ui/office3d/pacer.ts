// When the office's building draws (ADR 0089's cost rules), in one place: only after something changed, at most
// `maxFps` while something moves, and never while asleep (the window unfocused or hidden). The scene draws only from
// here, so the frame counter it keeps is every frame the office draws. No three.js: tests run it with a fake clock.

export type Pacer = {
  /** Something changed: draw one frame, soon. Any number of calls before it draws make one frame. */
  invalidate(): void;
  /**
   * Something is moving (`who`: typing, a camera move) and needs `fps` frames a second, up to the pacer's most, until
   * it says it stopped. While several move, the fastest sets the pace.
   */
  animating(who: string, on: boolean, fps?: number): void;
  /** Changes the most frames a second, from the next frame on. Movers that asked for the most follow it. */
  setMaxFps(fps: number): void;
  /** Whether frames may be drawn: the office is on screen and its window has focus. Waking draws what changed. */
  setAwake(awake: boolean): void;
  /** How many frames have been drawn. */
  readonly frames: number;
  dispose(): void;
};

export type Clock = { now(): number; request(fn: () => void): number; cancel(id: number): void; wait(fn: () => void, ms: number): () => void };

const browserClock: Clock = {
  now: () => performance.now(),
  request: (fn) => requestAnimationFrame(fn),
  cancel: (id) => cancelAnimationFrame(id),
  wait: (fn, ms) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
};

/**
 * `draw` draws one frame; `onFrame` hears each one with the count. Starts asleep, with a frame owed, so the first
 * wake draws. While nothing moves and nothing changed, no animation frame is even asked for, and between the frames
 * of something slow it waits on a timer, not on animation frames.
 */
export function createPacer({ draw, onFrame, maxFps: startFps = 30, clock = browserClock }: { draw: () => void; onFrame?: (frames: number) => void; maxFps?: number; clock?: Clock }): Pacer {
  const moving = new Map<string, number>();
  let maxFps = startFps;
  let fastest = 1000 / maxFps;
  // The time a frame waits after the last: a change draws as soon as maxFps allows, so turning the camera stays smooth;
  // motion alone waits for the fastest mover's next beat.
  const gap = () => (dirty ? fastest : 1000 / Math.min(maxFps, Math.max(...moving.values())));
  let dirty = true;
  let awake = false;
  let pending: number | undefined;
  let waiting: (() => void) | undefined;
  let last = -Infinity;
  let frames = 0;
  let disposed = false;

  const wanted = () => awake && !disposed && (dirty || moving.size > 0);
  const schedule = () => {
    if (pending !== undefined || !wanted()) return;
    const early = gap() - (clock.now() - last);
    // The small slack keeps a 60 Hz display at every other frame for 30 a second, not every third.
    if (early > fastest) {
      if (!waiting) waiting = clock.wait(() => ((waiting = undefined), schedule()), early - fastest / 2);
      return;
    }
    waiting?.();
    waiting = undefined;
    pending = clock.request(tick);
  };
  const stop = () => {
    if (pending !== undefined) clock.cancel(pending);
    pending = undefined;
    waiting?.();
    waiting = undefined;
  };
  function tick() {
    pending = undefined;
    if (!wanted()) return;
    const now = clock.now();
    if (now - last < gap() - 2) return schedule();
    last = now;
    dirty = false;
    draw();
    frames++;
    onFrame?.(frames);
    schedule();
  }

  return {
    invalidate() {
      dirty = true;
      // A change while waiting for slow motion's next beat draws now, not at the beat.
      waiting?.();
      waiting = undefined;
      schedule();
    },
    animating(who, on, fps = Infinity) {
      if (on) moving.set(who, fps);
      else moving.delete(who);
      schedule();
    },
    setMaxFps(fps) {
      maxFps = fps;
      fastest = 1000 / fps;
      stop();
      schedule();
    },
    setAwake(on) {
      awake = on;
      if (on) schedule();
      else stop();
    },
    get frames() {
      return frames;
    },
    dispose() {
      disposed = true;
      stop();
    },
  };
}
