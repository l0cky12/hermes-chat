// Which selected text a message starts with when the window is brought forward from another app, and how it is quoted
// (ADR 0172).
import { describe, expect, it } from "vitest";
import { SelectionWatch, quoted } from "./selection";

describe("New selected text", () => {
  it("is what was selected since the window last lost focus, ahead of what was copied", () => {
    const w = new SelectionWatch();
    w.remember({ primary: "old pick", clipboard: "old copy" });
    expect(w.take({ primary: "df -h", clipboard: "new copy" })).toBe("df -h");
  });

  it("is what was copied when the selection didn't change", () => {
    const w = new SelectionWatch();
    w.remember({ primary: "same", clipboard: "old copy" });
    expect(w.take({ primary: "same", clipboard: "https://example.com/log" })).toBe("https://example.com/log");
  });

  it("is nothing when neither changed, or neither can be read", () => {
    const w = new SelectionWatch();
    w.remember({ primary: "same", clipboard: "copied" });
    expect(w.take({ primary: "same", clipboard: "copied" })).toBeUndefined();
    expect(w.take({})).toBeUndefined();
  });

  it("starts a message once: a second summon with the same text finds nothing new", () => {
    const w = new SelectionWatch();
    expect(w.take({ primary: "journalctl -u nginx" })).toBe("journalctl -u nginx");
    expect(w.take({ primary: "journalctl -u nginx" })).toBeUndefined();
  });

  it("keeps what a selection held when a later read couldn't read it, so unchanged text isn't new again", () => {
    const w = new SelectionWatch();
    w.remember({ primary: "a line of Hermes's reply", clipboard: "copied" });
    w.remember({});
    expect(w.take({ primary: "a line of Hermes's reply", clipboard: "copied" })).toBeUndefined();
  });

  it("counts text selected again after the selection was cleared as new", () => {
    const w = new SelectionWatch();
    w.remember({ primary: "df -h", clipboard: null });
    w.remember({ primary: null, clipboard: null });
    expect(w.take({ primary: "df -h", clipboard: null })).toBe("df -h");
  });

  it("counts text selected in this app before leaving it as already seen", () => {
    const w = new SelectionWatch();
    w.remember({ primary: "a line of Hermes's reply" });
    expect(w.take({ primary: "a line of Hermes's reply" })).toBeUndefined();
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
