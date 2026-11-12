// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
