// What the webview keeps of speech to text's route (ADR 0065): the notes it shows, dropping a recording, and the route
// Rust read back. Where a recording goes is decided and tested in Rust (src-tauri/src/local_stt.rs).
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_STT_PREFS, SttCancelled, couldnt, fellBackOf, inRoute, sttRoute, untilAborted } from "./sttRoute";
import { prefsOf } from "./localStt";

describe("where speech to text ran", () => {
  it("says nothing when the first side gave the text", () => {
    expect(fellBackOf({ text: "hi", ran: "server" })).toBeUndefined();
    expect(fellBackOf({ text: "hi" })).toBeUndefined();
  });

  it("says which side gave the text and why the other didn't, once", () => {
    expect(fellBackOf({ text: "hi", ran: "local", fellBack: { from: "server", why: "GROQ_API_KEY is not set" } })).toBe(
      "Transcribed on this computer. Hermes couldn't transcribe it: GROQ_API_KEY is not set.",
    );
    expect(fellBackOf({ text: "hi", ran: "server", fellBack: { from: "local", why: "It took longer than 30 s." } })).toBe(
      "Transcribed on Hermes. This computer couldn't transcribe it: It took longer than 30 s.",
    );
    expect(couldnt("server", "no key!")).toBe("Hermes couldn't transcribe it: no key!");
  });
});

describe("dropping a recording", () => {
  it("rejects at once and tells Rust, even before the answer comes", async () => {
    const abort = new AbortController();
    const told = vi.fn();
    const never = new Promise<never>(() => {});
    const got = untilAborted(never, abort.signal, told);
    abort.abort();
    await expect(got).rejects.toBeInstanceOf(SttCancelled);
    expect(told).toHaveBeenCalledTimes(1);
    const late = vi.fn();
    await expect(untilAborted(Promise.resolve(1), abort.signal, late)).rejects.toBeInstanceOf(SttCancelled);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it("passes the answer on when nothing is dropped", async () => {
    const told = vi.fn();
    await expect(untilAborted(Promise.resolve("text"), new AbortController().signal, told)).resolves.toBe("text");
    expect(told).not.toHaveBeenCalled();
  });
});

describe("the route Rust read back", () => {
  it("is Hermes alone until read, and follows each read", () => {
    expect(prefsOf(undefined)).toEqual(DEFAULT_STT_PREFS);
    const heard = vi.fn();
    const off = sttRoute.subscribe(heard);
    sttRoute.set(prefsOf({ onThisComputer: true, backup: true, timeoutSeconds: 60 }));
    expect(sttRoute.get()).toEqual({ primary: "local", backup: true, timeoutSeconds: 60 });
    sttRoute.set({ primary: "local", backup: true, timeoutSeconds: 60 });
    expect(heard).toHaveBeenCalledTimes(1);
    expect(inRoute(sttRoute.get(), "server")).toBe(true);
    sttRoute.set(prefsOf({ onThisComputer: true }));
    expect(inRoute(sttRoute.get(), "server")).toBe(false);
    expect(inRoute(sttRoute.get(), "local")).toBe(true);
    off();
    sttRoute.set(DEFAULT_STT_PREFS);
    expect(heard).toHaveBeenCalledTimes(2);
  });
  it("keeps a newer read-back when an older read answers late", async () => {
    let answer!: (p: ReturnType<typeof prefsOf>) => void;
    const slow = sttRoute.refresh(() => new Promise((r) => (answer = r)));
    sttRoute.set(prefsOf({ onThisComputer: true }));
    answer(prefsOf({ onThisComputer: false }));
    await slow;
    expect(sttRoute.get().primary).toBe("local");
    // A read started after the change is taken.
    await sttRoute.refresh(async () => prefsOf({ onThisComputer: false, backup: true }));
    expect(sttRoute.get()).toEqual({ primary: "server", backup: true, timeoutSeconds: 30 });
    sttRoute.set(DEFAULT_STT_PREFS);
  });
});
