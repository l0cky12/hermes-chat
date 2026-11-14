// Which selected text a message starts with when the window is brought forward from another app, and how it is quoted
// (ADR 0172).
import { describe, expect, it } from "vitest";
import { SelectionWatch, quoted } from "./selection";

describe("New selected text", () => {
  it("is what was selected since the window last lost focus, ahead of what was copied", () => {
    const w = new SelectionWatch();
    w.remember(w.reading(), { primary: "old pick", clipboard: "old copy" });
    expect(w.take(w.reading(), { primary: "df -h", clipboard: "new copy" })).toBe("df -h");
  });

  it("is what was copied when the selection didn't change", () => {
    const w = new SelectionWatch();
    w.remember(w.reading(), { primary: "same", clipboard: "old copy" });
    expect(w.take(w.reading(), { primary: "same", clipboard: "https://example.com/log" })).toBe("https://example.com/log");
  });

  it("is nothing when neither changed, or neither can be read", () => {
    const w = new SelectionWatch();
    w.remember(w.reading(), { primary: "same", clipboard: "copied" });
    expect(w.take(w.reading(), { primary: "same", clipboard: "copied" })).toBeUndefined();
    expect(w.take(w.reading(), {})).toBeUndefined();
  });

  it("starts a message once: a second summon with the same text finds nothing new", () => {
    const w = new SelectionWatch();
    expect(w.take(w.reading(), { primary: "journalctl -u nginx" })).toBe("journalctl -u nginx");
    expect(w.take(w.reading(), { primary: "journalctl -u nginx" })).toBeUndefined();
  });

  it("keeps what a selection held when a later read couldn't read it, so unchanged text isn't new again", () => {
    const w = new SelectionWatch();
    w.remember(w.reading(), { primary: "a line of Hermes's reply", clipboard: "copied" });
    w.remember(w.reading(), {});
    expect(w.take(w.reading(), { primary: "a line of Hermes's reply", clipboard: "copied" })).toBeUndefined();
  });

  it("counts text selected again after the selection was cleared as new", () => {
    const w = new SelectionWatch();
    w.remember(w.reading(), { primary: "df -h", clipboard: null });
    w.remember(w.reading(), { primary: null, clipboard: null });
    expect(w.take(w.reading(), { primary: "df -h", clipboard: null })).toBe("df -h");
  });

  it("counts text selected in this app before leaving it as already seen", () => {
    const w = new SelectionWatch();
    w.remember(w.reading(), { primary: "a line of Hermes's reply" });
    expect(w.take(w.reading(), { primary: "a line of Hermes's reply" })).toBeUndefined();
  });
});

describe("Reads answered out of order", () => {
  it("drops a read made on leaving that lands after a summon's later read, so the next summon doesn't quote it again", () => {
    const w = new SelectionWatch();
    const leaving = w.reading();
    const summoned = w.reading();
    expect(w.take(summoned, { primary: "error: disk full" })).toBe("error: disk full");
    w.remember(leaving, { primary: "selected before leaving" });
    expect(w.take(w.reading(), { primary: "error: disk full" })).toBeUndefined();
  });

  it("drops a summon's read that lands after a later one, quoting only the newer", () => {
    const w = new SelectionWatch();
    w.remember(w.reading(), { primary: "old" });
    const first = w.reading();
    const second = w.reading();
    expect(w.take(second, { primary: "newer pick" })).toBe("newer pick");
    expect(w.take(first, { primary: "older pick" })).toBeUndefined();
    expect(w.take(w.reading(), { primary: "newer pick" })).toBeUndefined();
  });
});

describe("Quoted selection", () => {
  it("puts each line after `> `, keeps indentation, and leaves a blank line to write under", () => {
    expect(quoted("error: disk full\n  at /var/log\n\nretrying")).toBe("> error: disk full\n>   at /var/log\n>\n> retrying\n\n");
  });

  it("drops blank lines before and whitespace after, and reads Windows line ends", () => {
    expect(quoted("\n  \nfirst\r\nsecond  \n\n")).toBe("> first\n> second\n\n");
  });
});
