import { pageOn, type PageOn, type PreviewTarget, type WebTarget } from "../hermes/preview";

export const HISTORY_KEPT = 50;

export type PreviewHistory = { back: PreviewTarget[]; here: PreviewTarget; forward: PreviewTarget[]; reloadSeq: number } | null;

export type HistoryStep =
  | { kind: "open"; target: PreviewTarget }
  | { kind: "switch"; on: PageOn }
  | { kind: "back" }
  | { kind: "forward" }
  | { kind: "reload" }
  | { kind: "arrived"; target: WebTarget; replace: boolean }
  | { kind: "clear" };

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
    case "extension":
      return b.kind === "extension" && a.id === b.id && a.view === b.view;
  }
}

type Open = NonNullable<PreviewHistory>;

const pushed = (h: Open, target: PreviewTarget): Open => ({ back: [...h.back, h.here].slice(-HISTORY_KEPT), here: target, forward: [], reloadSeq: h.reloadSeq });
const wentBack = (h: Open): Open => ({ back: h.back.slice(0, -1), here: h.back[h.back.length - 1], forward: [h.here, ...h.forward], reloadSeq: h.reloadSeq });
const wentForward = (h: Open): Open => ({ back: [...h.back, h.here], here: h.forward[0], forward: h.forward.slice(1), reloadSeq: h.reloadSeq });

export function stepHistory(h: PreviewHistory, s: HistoryStep): PreviewHistory {
  switch (s.kind) {
    case "open":
      if (!h) return { back: [], here: s.target, forward: [], reloadSeq: 0 };
      return sameTarget(h.here, s.target) ? { ...h, reloadSeq: h.reloadSeq + 1 } : pushed(h, s.target);
    case "switch":
      return h?.here.kind === "web" && pageOn(h.here) && pageOn(h.here) !== s.on ? { ...h, here: { ...h.here, on: s.on } } : h;
    case "back":
      return h?.back.length ? wentBack(h) : h;
    case "forward":
      return h?.forward.length ? wentForward(h) : h;
    case "reload":
      return h && { ...h, reloadSeq: h.reloadSeq + 1 };
    case "arrived":
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
