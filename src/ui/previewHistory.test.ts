import { describe, expect, it } from "vitest";
import type { PreviewTarget, WebTarget } from "../hermes/preview";
import { canGoBack, canGoForward, HISTORY_KEPT, stepHistory, type HistoryStep, type PreviewHistory } from "./previewHistory";

const page = (path: string, on?: "server" | "local"): WebTarget => ({ kind: "web", url: `http://localhost:5173${path}`, ...(on && { on }) });
const github: WebTarget = { kind: "web", url: "https://github.com/l0cky12/hermes-chat" };
const file: PreviewTarget = { kind: "server", path: "/srv/app/README.md" };

const run = (...steps: HistoryStep[]) => steps.reduce<PreviewHistory>(stepHistory, null);
const open = (target: PreviewTarget): HistoryStep => ({ kind: "open", target });
const arrived = (target: WebTarget, replace = false): HistoryStep => ({ kind: "arrived", target, replace });
const where = (h: PreviewHistory) => h && { back: h.back.length, here: h.here, forward: h.forward.length };

describe("The Preview's history", () => {
  it("starts empty, with nowhere to go", () => {
    expect(run()).toBeNull();
    expect(canGoBack(null)).toBe(false);
    expect(canGoForward(null)).toBe(false);
  });

  it("follows a link in a dev server, then goes back and forward", () => {
    const opened = run(open(page("/")), arrived(page("/", "server"), true));
    expect(where(opened)).toEqual({ back: 0, here: page("/"), forward: 0 });
    const followed = stepHistory(opened, arrived(page("/a", "server")));
    expect(where(followed)).toEqual({ back: 1, here: page("/a", "server"), forward: 0 });
    const back = stepHistory(followed, { kind: "back" });
    expect(back?.here).toEqual(page("/"));
    expect(canGoForward(back)).toBe(true);
    expect(stepHistory(back, arrived(page("/", "server"), true))).toBe(back);
    expect(stepHistory(back, { kind: "forward" })?.here).toEqual(page("/a", "server"));
  });

  it("goes back from a reply link to the dev server, and from a server file to the page", () => {
    const linked = run(open(page("/")), open(github));
    expect(stepHistory(linked, { kind: "back" })?.here).toEqual(page("/"));
    const filed = run(open(page("/")), open(file));
    const back = stepHistory(filed, { kind: "back" });
    expect(back?.here).toEqual(page("/"));
    expect(back?.forward).toEqual([file]);
  });

  it("moves along the list when the page goes back or forward by itself", () => {
    const h = run(open(page("/")), arrived(page("/a", "server")), arrived(page("/b", "server")));
    const back = stepHistory(h, arrived(page("/a", "server")));
    expect(where(back)).toEqual({ back: 1, here: page("/a", "server"), forward: 1 });
    expect(where(stepHistory(back, arrived(page("/b", "server"))))).toEqual({ back: 2, here: page("/b", "server"), forward: 0 });
  });

  it("puts a replaced address in the current entry's place, keeping what is ahead", () => {
    const h = run(open(page("/")), open(page("/a")), { kind: "back" }, arrived(page("/r", "server"), true));
    expect(where(h)).toEqual({ back: 0, here: page("/r", "server"), forward: 1 });
  });

  it("drops what is ahead when the page goes somewhere new", () => {
    const h = run(open(page("/")), open(page("/a")), { kind: "back" }, arrived(page("/c", "server")));
    expect(where(h)).toEqual({ back: 1, here: page("/c", "server"), forward: 0 });
  });

  it("ignores the page's view once something else shows", () => {
    const h = run(open(page("/")), open(file));
    expect(stepHistory(h, arrived(page("/late", "server")))).toBe(h);
  });

  it("reloads what is shown when it is opened again, without a new entry", () => {
    const h = run(open(page("/")), open(page("/")));
    expect(where(h)).toEqual({ back: 0, here: page("/"), forward: 0 });
    expect(h?.reloadSeq).toBe(1);
    expect(stepHistory(h, { kind: "reload" })?.reloadSeq).toBe(2);
    expect(stepHistory(stepHistory(h, open(github)), { kind: "back" })?.reloadSeq).toBe(1);
  });

  it("switches a loopback page between the server and this computer in place", () => {
    const h = run(open(github), open(page("/a")));
    const local = stepHistory(h, { kind: "switch", on: "local" });
    expect(where(local)).toEqual({ back: 1, here: page("/a", "local"), forward: 0 });
    expect(stepHistory(local, { kind: "switch", on: "local" })).toBe(local);
    expect(stepHistory(run(open(github)), { kind: "switch", on: "local" })?.here).toEqual(github);
  });

  it("counts a loopback page's default side as the server", () => {
    const h = run(open(page("/a")));
    expect(stepHistory(h, arrived(page("/a", "server")))).toBe(h);
    expect(stepHistory(h, arrived(page("/a", "local")))?.back).toHaveLength(1);
  });

  it(`keeps the last ${HISTORY_KEPT} entries behind`, () => {
    let h = run(open(page("/0")));
    for (let i = 1; i <= HISTORY_KEPT + 10; i++) h = stepHistory(h, arrived(page(`/${i}`, "server")));
    expect(h?.back).toHaveLength(HISTORY_KEPT);
    expect(h?.back[0]).toEqual(page("/10", "server"));
  });

  it("forgets everything for another profile", () => {
    expect(stepHistory(run(open(page("/")), open(file)), { kind: "clear" })).toBeNull();
    expect(stepHistory(null, { kind: "back" })).toBeNull();
    expect(stepHistory(null, { kind: "reload" })).toBeNull();
  });
});
