// What the Preview has shown, as one list the app owns: every target the owner opened and every address the page's
// view reached by itself. Back, Forward and the address box read it. WebKit's own back-forward list never owns any of
// it: Rust only consults that list to pick how to reach an entry this one already chose (page_view.rs `go`).
import { pageOn, type PageOn, type PreviewTarget, type WebTarget } from "../hermes/preview";

/** The most entries kept behind `here`, so a page that calls pushState in a loop can't grow the list without end. */
export const HISTORY_KEPT = 50;

/**
 * `null`: nothing open, the empty state. Otherwise a zipper, so `here` always exists and no cursor can point past the
 * list. `reloads` counts the owner's Reloads, and reopening what is already shown; it never goes down, so a view that
 * stays mounted across entries reloads only when it grows.
 */
export type PreviewHistory = { back: PreviewTarget[]; here: PreviewTarget; forward: PreviewTarget[]; reloads: number } | null;

export type HistoryStep =
  /** The owner opened `target`: a reply link, a tool chip, Outputs, the address box, a dev server, a picked file. */
  | { kind: "open"; target: PreviewTarget }
  /** The owner clicked the badge: the same loopback page from the other side. */
  | { kind: "switch"; on: PageOn }
  | { kind: "back" }
  | { kind: "forward" }
  | { kind: "reload" }
  /**
   * The page's view reached `target` (mapped out of its tunnel, preview.ts `fromView`). `replace`: it took the current
   * entry's place, as where a load the app asked for landed, a redirect, or `replaceState` does. Otherwise the page
   * moved by itself: a link, `pushState`, or its own `history.back()`.
   */
  | { kind: "arrived"; target: WebTarget; replace: boolean }
  /** Another profile: nothing it showed carries over. */
  | { kind: "clear" };

/** Whether two targets show the same thing from the same place. A loopback page's `on` counts with its default. */
export function sameTarget(a: PreviewTarget, b: PreviewTarget): boolean {
  switch (a.kind) {
    case "web":
      return b.kind === "web" && a.url === b.url && pageOn(a) === pageOn(b);
    case "server":
      return b.kind === "server" && a.path === b.path && !!a.host === !!b.host && a.session === b.session;
    case "local":
      return b.kind === "local" && a.path === b.path;
    case "artifact":
      return b.kind === "artifact" && a.ref.path === b.ref.path && a.ref.host === b.ref.host && a.ref.profile === b.ref.profile && a.ref.session === b.ref.session;
    case "tool":
      return b.kind === "tool" && a.name === b.name && a.text === b.text;
    case "start":
      return b.kind === "start";
  }
}

type Open = NonNullable<PreviewHistory>;

const pushed = (h: Open, target: PreviewTarget): Open => ({ back: [...h.back, h.here].slice(-HISTORY_KEPT), here: target, forward: [], reloads: h.reloads });
const wentBack = (h: Open): Open => ({ back: h.back.slice(0, -1), here: h.back[h.back.length - 1], forward: [h.here, ...h.forward], reloads: h.reloads });
const wentForward = (h: Open): Open => ({ back: [...h.back, h.here], here: h.forward[0], forward: h.forward.slice(1), reloads: h.reloads });

/** The one reducer for the Preview's history (App.tsx). Returns `h` itself when nothing changes, so React skips the render. */
export function stepHistory(h: PreviewHistory, s: HistoryStep): PreviewHistory {
  switch (s.kind) {
    case "open":
      if (!h) return { back: [], here: s.target, forward: [], reloads: 0 };
      return sameTarget(h.here, s.target) ? { ...h, reloads: h.reloads + 1 } : pushed(h, s.target);
    case "switch":
      return h?.here.kind === "web" && pageOn(h.here) && pageOn(h.here) !== s.on ? { ...h, here: { ...h.here, on: s.on } } : h;
    case "back":
      return h?.back.length ? wentBack(h) : h;
    case "forward":
      return h?.forward.length ? wentForward(h) : h;
    case "reload":
      return h && { ...h, reloads: h.reloads + 1 };
    case "arrived":
      // A late event from a view that has gone.
      if (h?.here.kind !== "web" || sameTarget(h.here, s.target)) return h;
      if (s.replace) return { ...h, here: s.target };
      if (h.back.length && sameTarget(h.back[h.back.length - 1], s.target)) return wentBack(h);
      if (h.forward.length && sameTarget(h.forward[0], s.target)) return wentForward(h);
      return pushed(h, s.target);
    case "clear":
      return null;
  }
}

export const canGoBack = (h: PreviewHistory) => !!h?.back.length;
export const canGoForward = (h: PreviewHistory) => !!h?.forward.length;
