import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRANSCRIPT_LIMIT_BYTES, localChatCache } from "./chatCache";
import { FakeHermes } from "./fakeHermes";
import { toolResultText, withoutInlineData } from "./toolResult";
import { connect } from "./transport";

/** About as long as a 1440x900 Bot Desktop capture's base64: 446 KB of PNG. */
const PNG_BASE64 = "iVBORw0KGgo" + "A".repeat(594_590 - 11);
const SHOT = "/home/liam/.hermes/cache/images/computer_use_76f76bd5.png";

/** A `computer_use` capture's result as Hermes sends it with `tool.complete` (hermes-agent 2026.9.24). */
const capture = () => ({
  _multimodal: true,
  content: [
    { type: "text", text: `capture mode=vision 1440x900 app=Chromium-browser\n0 interactable element(s):\n  (shareable screenshot saved to ${SHOT})` },
    { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_BASE64}` } },
  ],
  text_summary: `capture mode=vision 1440x900 app=Chromium-browser`,
  meta: { mode: "vision", width: 1440, height: 900, png_bytes: 445_924, screenshot_path: SHOT },
});

describe("A tool's result as the chat keeps it", () => {
  it("leaves a screenshot out and says what it was, keeping the text and where it was saved", () => {
    const text = toolResultText(capture())!;
    expect(text).not.toContain(PNG_BASE64.slice(0, 64));
    expect(text).toContain('"url": "[image/png, 435 KB, not kept in the chat]"');
    expect(text).toContain(`shareable screenshot saved to ${SHOT}`);
    expect(text).toContain('"png_bytes": 445924');
    expect(text.length).toBeLessThan(1_000);
  });

  it("leaves out bare base64 fields too", () => {
    expect(withoutInlineData({ ok: true, screenshot_png_b64: PNG_BASE64 })).toEqual({ ok: true, screenshot_png_b64: "[data, 435 KB, not kept in the chat]" });
  });

  it("swaps data URLs inside text, and keeps the text around them", () => {
    const text = `Saved it. data:image/jpeg;name=x.jpg;base64,${"/9j/".padEnd(4_000, "Q")} Done.`;
    expect(toolResultText(text)).toBe("Saved it. [image/jpeg, 2.9 KB, not kept in the chat] Done.");
  });

  it("keeps what is text, or too small to matter", () => {
    const hashes = Array.from({ length: 200 }, (_, i) => i.toString(16).padStart(40, "a")).join("\n");
    const small = { url: "data:image/png;base64,iVBORw0KGgo=", token: "QUJD".repeat(500) };
    for (const kept of [hashes, "92% used", small, "MEDIA:/tmp/out.png", 42, true, ["a", { b: null }]]) expect(withoutInlineData(kept)).toEqual(kept);
    expect(toolResultText("92% used")).toBe("92% used");
    expect(toolResultText({ exit_code: 0 })).toBe('{\n  "exit_code": 0\n}');
    expect(toolResultText(undefined)).toBeUndefined();
    expect(toolResultText(null)).toBeUndefined();
  });
});

describe("A computer-use chat", () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = new Map();
    vi.stubGlobal("localStorage", {
      get length() {
        return store.size;
      },
      key: (i: number) => [...store.keys()][i] ?? null,
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("keeps no screenshot from a capture, so its Saved copy fits and leaves other chats' copies alone", async () => {
    const cache = localChatCache({ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" });
    // Another chat's Saved copy, a quarter of the room.
    cache.saveTranscript("default", "older", [{ kind: "assistant", id: "a-0", text: "x".repeat(TRANSCRIPT_LIMIT_BYTES / 8) }]);
    const server = new FakeHermes();
    const hermes = await connect(server.openPipe, undefined, cache);
    const id = await hermes.newChat();
    await hermes.send(id, "Open the settings page.");
    const runtime = server.runtimeIdOf(id)!;
    server.event(runtime, "message.start");
    for (const n of [1, 2, 3]) {
      server.event(runtime, "tool.start", { tool_id: `c${n}`, name: "computer_use", args: { action: "capture", mode: "vision" } });
      server.event(runtime, "tool.complete", { tool_id: `c${n}`, name: "computer_use", duration_s: 0.51, result: capture() });
    }
    server.event(runtime, "message.complete", { text: "Done.", status: "complete" });

    const tools = hermes.getSnapshot().chats.find((c) => c.id === id)!.items.filter((i) => i.kind === "tool");
    expect(tools).toHaveLength(3);
    for (const t of tools) expect(t).toMatchObject({ status: "done", result: expect.stringContaining("[image/png, 435 KB, not kept in the chat]") });
    expect(cache.loadTranscript("default", id)?.items).toHaveLength(5);
    expect(cache.loadTranscript("default", "older")).toBeDefined();
  });
});
