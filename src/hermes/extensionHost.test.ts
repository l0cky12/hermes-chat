// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { FRAME_CSP, PRELUDE, SHIM, SHIM_HASH, SRCDOC, startFrame } from "./extensionHost";

const pageCsp = () => /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(readFileSync("index.html", "utf8"))![1];
const directive = (csp: string, name: string) => csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `));

describe("the host frame", () => {
  it("pins the shim's hash, and the app's CSP admits exactly that inline script and blob: workers", () => {
    expect(`sha256-${createHash("sha256").update(SHIM).digest("base64")}`).toBe(SHIM_HASH);
    // WebKit applies the page's CSP inside a srcdoc frame too, so without these the shim never runs.
    expect(directive(pageCsp(), "script-src")).toBe(`script-src 'self' '${SHIM_HASH}'`);
    expect(directive(pageCsp(), "worker-src")).toBe("worker-src 'self' blob:");
    expect(directive(pageCsp(), "connect-src")).not.toContain("blob:");
  });

  it("gives the frame no network, no eval and no script but the shim", () => {
    expect(FRAME_CSP).toBe(`default-src 'none'; script-src '${SHIM_HASH}'; worker-src blob:`);
    expect(SRCDOC.match(/<script/g)).toHaveLength(1);
    expect(SRCDOC.match(/<\/script/g)).toHaveLength(1);
    expect(PRELUDE).toContain('"Worker","SharedWorker"');
    expect(PRELUDE).toContain('"caches"');
  });

  it("is an opaque-origin frame, hidden from the owner's tab order, and removing it removes the frame", () => {
    const mount = document.createElement("div");
    const host = startFrame("self.onmessage = () => {};", mount);
    const frame = mount.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("srcdoc")).toBe(SRCDOC);
    expect(frame.getAttribute("srcdoc")).not.toContain("self.onmessage");
    expect(frame.tabIndex).toBe(-1);
    expect(frame.getAttribute("aria-hidden")).toBe("true");
    host.remove();
    expect(mount.querySelector("iframe")).toBeNull();
  });
});

describe("the prelude", () => {
  // A stand-in worker global: Worker and SharedWorker as globals, caches as an accessor, as WebKit has them.
  function worker() {
    const ctx = vm.createContext({});
    vm.runInContext(`globalThis.Worker = function Worker() {}; globalThis.SharedWorker = function SharedWorker() {}; Object.defineProperty(globalThis, "caches", { get() { return "real caches"; }, configurable: true });`, ctx);
    return ctx;
  }
  const after = (ctx: vm.Context) => vm.runInContext(`[typeof Worker, typeof SharedWorker, (() => { try { return String(caches); } catch (e) { return "closed: " + e; } })()]`, ctx);

  it("removes nested workers and closes caches", () => {
    const ctx = worker();
    vm.runInContext(PRELUDE + "self.x = 1;", Object.assign(ctx, { self: ctx }));
    expect(after(ctx)).toEqual(["undefined", "undefined", "closed: caches is closed"]);
  });

  it("still does when the extension's hoisted declarations shadow the names it could have used", () => {
    const ctx = worker();
    vm.runInContext(PRELUDE + "function self() {} function Object() {} function globalThis() {} var Worker; let SharedWorker2;", ctx);
    expect(after(ctx)).toEqual(["undefined", "undefined", "closed: caches is closed"]);
  });

  it("never lets a hoisted declaration of the same name reach the real caches or Worker", () => {
    for (const name of ["caches", "Worker"]) {
      const ctx = worker();
      const probe = `function ${name}() {} globalThis.seen = (() => { try { return String(${name}); } catch (e) { return "closed"; } })();`;
      // WebKit makes the declared name non-configurable, and the prelude's defineProperty then stops the script.
      try {
        vm.runInContext(PRELUDE + probe, ctx);
      } catch {
        continue;
      }
      expect(vm.runInContext("globalThis.seen", ctx)).not.toMatch(/real caches|function Worker\(\) \{\}/);
    }
  });
});
