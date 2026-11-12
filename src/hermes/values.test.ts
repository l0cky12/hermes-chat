import { describe, expect, it } from "vitest";
import { clockTime, clockTimeWithSeconds, errorText, formatBytes, nonBlankText, nonEmptyText, optionalText, textOrEmpty } from "./values";

describe("errorText", () => {
  it("reads an Error's message", () => expect(errorText(new Error("disk full"))).toBe("disk full"));
  it("reads the message of a plain object, as a rejected Tauri invoke gives", () => expect(errorText({ code: 4, message: "no such profile" })).toBe("no such profile"));
  it("writes out a plain object with no message", () => expect(errorText({ code: 4 })).toBe("[object Object]"));
  it("keeps a thrown string", () => expect(errorText("timed out")).toBe("timed out"));
  it("writes out null", () => expect(errorText(null)).toBe("null"));
  it("names an error whose message is empty", () => expect(errorText(new TypeError(""))).toBe("TypeError"));
});

describe("text readers", () => {
  it("textOrEmpty keeps a string and turns anything else into an empty one", () => {
    expect([textOrEmpty(" a "), textOrEmpty(""), textOrEmpty(3), textOrEmpty(null)]).toEqual([" a ", "", "", ""]);
  });
  it("optionalText keeps a string up to max, empty included", () => {
    expect([optionalText(""), optionalText("abc", 3), optionalText("abcd", 3), optionalText(1)]).toEqual(["", "abc", undefined, undefined]);
  });
  it("nonEmptyText keeps a string of 1 to max characters", () => {
    expect([nonEmptyText(""), nonEmptyText(" "), nonEmptyText("abc", 3), nonEmptyText("abcd", 3), nonEmptyText(false)]).toEqual([undefined, " ", "abc", undefined, undefined]);
  });
  it("nonBlankText keeps a string with more than whitespace, untrimmed, up to max", () => {
    expect([nonBlankText("  "), nonBlankText(" a "), nonBlankText(" a ", 2), nonBlankText({})]).toEqual([undefined, " a ", undefined, undefined]);
  });
});

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [1023, "1023 B"],
    [1024, "1.0 KB"],
    [1536, "1.5 KB"],
    [10 * 1024, "10 KB"],
    [1023 * 1024, "1023 KB"],
    [1024 * 1024 - 1, "1.0 MB"],
    [25 * 1024 ** 2, "25 MB"],
    [1.25 * 1024 ** 3, "1.3 GB"],
    [2048 * 1024 ** 3, "2048 GB"],
  ])("writes %d bytes as %s", (bytes, text) => expect(formatBytes(bytes)).toBe(text));
});

describe("clock times", () => {
  const at = new Date(2026, 10, 11, 15, 45, 7).getTime();
  it("writes hours and minutes in the locale's own 12- or 24-hour clock", () => {
    expect(clockTime(at, "en-US")).toMatch(/^3:45\sPM$/);
    expect(clockTime(at, "en-GB")).toBe("15:45");
  });
  it("follows the desktop's locale when given none", () => {
    expect(clockTime(at)).toBe(new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }));
    expect(clockTimeWithSeconds(at)).toBe(new Date(at).toLocaleTimeString());
  });
});
