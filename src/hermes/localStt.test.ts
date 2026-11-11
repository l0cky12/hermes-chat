// How the webview hands a recording to Rust (`hermes_transcribe`) and drops it again (`local_stt_cancel`).
import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a), Channel: class {} }));

const { tauriLocalStt } = await import("./localStt");
const { SttCancelled } = await import("./sttRoute");

afterEach(() => invoke.mockReset());

const audio = new Uint8Array([82, 73, 70, 70]);

describe("transcribing through Rust", () => {
  it("sends the recording with its run id, profile, connection and side, and answers what Rust said", async () => {
    invoke.mockResolvedValue({ text: "hi", ran: "local" });
    const req = { audio, mime: "audio/wav", profile: "work", connection: "conn-1", side: "local" as const };
    await expect(tauriLocalStt.transcribe(req)).resolves.toEqual({ text: "hi", ran: "local" });
    const [cmd, body, opts] = invoke.mock.calls[0];
    expect([cmd, body]).toEqual(["hermes_transcribe", audio]);
    expect(opts.headers).toMatchObject({ "x-mime": "audio%2Fwav", "x-profile": "work", "x-attempt": "conn-1", "x-stt-side": "local" });
    expect(opts.headers["x-stt-run"]).toBeTruthy();
  });

  it("sends nothing for a recording already dropped, and leaves no rejection unhandled", async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(tauriLocalStt.transcribe({ audio, mime: "audio/wav", signal: abort.signal })).rejects.toBeInstanceOf(SttCancelled);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("tells Rust to stop that run when the recording is dropped on its way", async () => {
    invoke.mockImplementation((cmd: string) => (cmd === "hermes_transcribe" ? new Promise(() => {}) : Promise.resolve()));
    const abort = new AbortController();
    const got = tauriLocalStt.transcribe({ audio, mime: "audio/wav", signal: abort.signal });
    abort.abort();
    await expect(got).rejects.toBeInstanceOf(SttCancelled);
    const run = invoke.mock.calls[0][2].headers["x-stt-run"];
    expect(invoke).toHaveBeenLastCalledWith("local_stt_cancel", { run });
  });
});
