// Undo and redo without I/O, as the artifact editor and the composer keep them.
import { describe, expect, it } from "vitest";
import { HISTORY_MAX_STEPS, TYPING_PAUSE_MS, emptyHistory, record, redo, undo } from "./editHistory";

type Sel = { text: string; start: number; end: number };
const at = (text: string): Sel => ({ text, start: text.length, end: text.length });

describe("undo and redo", () => {
  it("makes a burst of typing one step, and a pause or another kind of change a new one", () => {
    let h = emptyHistory<Sel>();
    h = record(h, at(""), "typing", 0);
    h = record(h, at("a"), "typing", 100);
    h = record(h, at("ab"), "typing", 200);
    expect(h.past.map((s) => s.text)).toEqual([""]);
    h = record(h, at("abc"), "typing", 200 + TYPING_PAUSE_MS + 1);
    expect(h.past.map((s) => s.text)).toEqual(["", "abc"]);
    h = record(h, at("abcd"), "change", 2000);
    h = record(h, at("HERMES"), "typing", 2001);
    expect(h.past.map((s) => s.text)).toEqual(["", "abc", "abcd", "HERMES"]);
  });

  it("undoes and redoes in order, and a new change drops what was undone", () => {
    let h = emptyHistory<Sel>();
    h = record(h, at("one"), "change", 0);
    h = record(h, at("two"), "change", 1);
    let step = undo(h, at("three"))!;
    expect(step.state.text).toBe("two");
    step = undo(step.history, step.state)!;
    expect(step.state.text).toBe("one");
    expect(undo(step.history, step.state)).toBeUndefined();
    const back = redo(step.history, step.state)!;
    expect(back.state.text).toBe("two");
    expect(redo(back.history, back.state)!.state.text).toBe("three");
    const branched = record(back.history, back.state, "change", 5);
    expect(branched.future).toEqual([]);
    expect(redo(branched, at("other"))).toBeUndefined();
  });

  it("keeps the selection with each step", () => {
    const h = record(emptyHistory<Sel>(), { text: "hello world", start: 6, end: 11 }, "change", 0);
    expect(undo(h, at("hello there"))!.state).toEqual({ text: "hello world", start: 6, end: 11 });
  });

  it("keeps at most the newest steps", () => {
    let h = emptyHistory<Sel>();
    for (let i = 0; i < HISTORY_MAX_STEPS + 50; i++) h = record(h, at(String(i)), "change", i);
    expect(h.past).toHaveLength(HISTORY_MAX_STEPS);
    expect(h.past[0].text).toBe("50");
  });
});
