import { describe, expect, it } from "vitest";
import { authorize, parseIncoming, parseView, RPC_LIMITS, SERVED } from "./extensionRpc";
import { PERMISSIONS, type Permission } from "./extensionPermissions";
import { BUNDLED } from "./bundledExtensions";

const msg = (m: object) => JSON.stringify({ jsonrpc: "2.0", ...m });

describe("parseIncoming", () => {
  it("takes JSON-RPC 2.0 text: requests, notifications, results and errors", () => {
    expect(parseIncoming(msg({ id: 1, method: "log", params: { level: "info", text: "hi" } }))).toEqual({ kind: "request", id: 1, method: "log", params: { level: "info", text: "hi" } });
    expect(parseIncoming(msg({ method: "log" }))).toEqual({ kind: "request", id: undefined, method: "log", params: {} });
    expect(parseIncoming(msg({ id: 2, result: null }))).toEqual({ kind: "result", id: 2, result: null });
    expect(parseIncoming(msg({ id: 3, error: { code: 1, message: "no" } }))).toEqual({ kind: "error", id: 3, message: "no" });
  });

  it("calls anything else broken", () => {
    const broken = (d: unknown) => (parseIncoming(d) as { kind: string; why?: string }).why;
    expect(broken({ jsonrpc: "2.0", method: "log" })).toBe("sent something other than JSON text");
    expect(broken("nope")).toBe("sent a message that isn't JSON");
    expect(broken(JSON.stringify({ method: "log" }))).toBe("sent a message that isn't JSON-RPC 2.0");
    expect(broken(msg({ id: {}, method: "log" }))).toBe("sent a request with a bad id");
    expect(broken(msg({ method: "log", params: [1] }))).toBe("sent log with params that aren't an object");
    expect(broken(msg({ id: 1 }))).toBe("sent an answer with neither a result nor an error");
    expect(broken(msg({ result: 1 }))).toBe("sent an answer with no id");
    // Multi-byte text counts in UTF-8 bytes, so 100k three-byte characters are over the cap.
    expect(broken(msg({ method: "log", params: { text: "€".repeat(100_000) } }))).toBe("sent a message over 256 KB");
    expect(parseIncoming(msg({ method: "log", params: { text: "a".repeat(RPC_LIMITS.bytes - 100) } })).kind).toBe("request");
  });
});

describe("parseView", () => {
  it("takes the node kinds the app draws, within their caps", () => {
    const nodes = [
      { kind: "heading", text: "H" },
      { kind: "text", text: "T" },
      { kind: "list", items: ["a", "b"] },
      { kind: "table", columns: ["A", "B"], rows: [["1", "2"]] },
      { kind: "facts", facts: [{ label: "L", value: "V" }] },
      { kind: "notice", text: "N" },
      { kind: "button", label: "Go", command: "stats" },
    ];
    expect(parseView(nodes)).toEqual([...nodes.slice(0, 6), { kind: "button", label: "Go", command: "stats", arg: "" }]);
  });

  it("refuses HTML, images, links, unknown keys and anything over a cap", () => {
    expect(parseView([{ kind: "html", text: "<b>" }])).toBe("a node of an unknown kind");
    expect(parseView([{ kind: "image", src: "http://x" }])).toBe("a node of an unknown kind");
    expect(parseView([{ kind: "text", text: "x", href: "http://x" }])).toBe('a text node with an unknown key "href"');
    expect(parseView([{ kind: "table", columns: ["A"], rows: [["1", "2"]] }])).toBe("a table that isn't text within its caps");
    expect(parseView([{ kind: "text", text: "x".repeat(RPC_LIMITS.text + 1) }])).toBe("a text over the length cap");
    expect(parseView(Array.from({ length: RPC_LIMITS.nodes + 1 }, () => ({ kind: "text", text: "x" })))).toMatch(/^a view must be a list/);
    expect(parseView({ kind: "text" })).toMatch(/^a view must be a list/);
  });
});

describe("authorize", () => {
  const all = new Set(Object.keys(PERMISSIONS) as Permission[]);
  const none = new Set<Permission>();
  const read = { call: "c1" };

  it("serves chat.read and chat.draft only with the grant, during the open call that the request names", () => {
    for (const [method, params] of [["chat.read", read], ["chat.draft", { ...read, text: "hi" }]] as const) {
      expect(authorize(method, params, all, "c1")).toMatchObject({ ok: true, method });
      expect(authorize(method, params, none, "c1")).toMatchObject({ ok: false, error: "permission_denied" });
      expect(authorize(method, params, all, undefined)).toMatchObject({ ok: false, error: "no_open_call" });
      expect(authorize(method, params, all, "c2")).toMatchObject({ ok: false, error: "no_open_call" });
    }
  });

  it("lets view.update and log through without a grant or a call", () => {
    expect(authorize("view.update", { id: "v", nodes: [] }, none, undefined)).toMatchObject({ ok: true });
    expect(authorize("log", { level: "info", text: "x" }, none, undefined)).toMatchObject({ ok: true, params: { level: "INFO", text: "x" } });
    expect(authorize("log", { level: "critical", text: "x" }, none, undefined)).toMatchObject({ ok: false, error: "invalid_params" });
  });

  it("has no method for the network, files, credentials, other chats, or the permissions no method serves yet", () => {
    for (const m of ["fetch", "net.fetch", "fs.read", "password_load", "chat.send", "chat.list", "project.read", "storage.get", "__proto__", "constructor"])
      expect(authorize(m, {}, all, "c1")).toMatchObject({ ok: false, error: "method_not_found" });
    expect([...SERVED].sort()).toEqual(["chat.draft", "chat.read"]);
  });

  it("is what every bundled manifest is limited to", () => {
    for (const p of BUNDLED) for (const perm of p.manifest.permissions) expect(SERVED.has(perm)).toBe(true);
  });
});
