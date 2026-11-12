// The words an annotation stages beside its image (ADR 0094): what each kind of pick says, what the page's address
// may carry, and the cap.
import { describe, expect, it } from "vitest";
import { MAX_WORDS, annotationWords, dragBox, shareableAddress, staleText, type Pick, type Still } from "./annotations";

const still: Still = { id: 3, generation: 1, path: "/c/1/0/still.png", url: "http://127.0.0.1:41001/settings", takenAtMs: Date.UTC(2026, 10, 12, 14, 2, 31), width: 1280, height: 800, scale: 2, elements: true };
const view = { width: 1280, height: 800, scrollX: 0, scrollY: 0, scale: 2 };
const words = (pick: Pick, note = "", url = "http://localhost:5173/settings") =>
  annotationWords({ n: 1, url, where: "server", takenAtMs: still.takenAtMs, still, pick, note });

describe("Annotation words", () => {
  it("says what was picked, where, and the owner's note last", () => {
    const pick: Pick = {
      kind: "element",
      target: {
        kind: "element",
        tag: "button",
        role: null,
        label: "Save changes",
        selector: "main > form#profile > button.primary",
        styles: { color: "rgb(255, 255, 255)", "font-size": "14px" },
      },
      rect: { x: 412.4, y: 380, width: 120, height: 36 },
      view,
    };
    const lines = words(pick, "  make this match the secondary button ").split("\n");
    expect(lines[0]).toBe("Annotation 1. annotation-1.png marks it in blue.");
    expect(lines[1]).toMatch(/^Page: http:\/\/localhost:5173\/settings \(Server page\), still taken \d\d:\d\d:\d\d$/);
    expect(lines.slice(2)).toEqual([
      'Element: button, text from the page: "Save changes"',
      "Selector: main > form#profile > button.primary",
      "Box: 412, 380, 120 × 36 CSS px, in a 1280 × 800 view at scale 2",
      "Styles: color rgb(255, 255, 255); font-size 14px",
      "Note: make this match the secondary button",
    ]);
  });

  it("describes a password field as one, with no label, selector or styles", () => {
    const pick: Pick = { kind: "element", target: { kind: "field", tag: "input", field: { kind: "password" }, label: null }, rect: { x: 1, y: 2, width: 3, height: 4 }, view };
    const text = words(pick);
    expect(text).toContain("Element: input, a password field");
    expect(text).not.toMatch(/Selector|Styles|Note/);
  });

  it("says why a region has no element details", () => {
    const region = (why: Extract<Pick, { kind: "region" }>["why"]): Pick => ({ kind: "region", rect: { x: 0, y: 0, width: 10, height: 10 }, why });
    expect(words(region({ kind: "changed" }))).toContain("Region: The page changed after the still. Element details are left out.");
    expect(words(region({ kind: "otherSite", host: "ads.example:8443" }))).toContain("This part comes from ads.example:8443, which the app can't read.");
    expect(words(region({ kind: "framed" }))).toContain("can't read this page on Windows");
    expect(words(region({ kind: "drawn" }))).toContain("Box: 0, 0, 10 × 10 CSS px, in a 1280 × 800 view at scale 2");
    expect(words(region({ kind: "drawn" }))).not.toContain("Selector");
  });

  it("cuts the note so the whole block stays within its cap", () => {
    const pick: Pick = { kind: "region", rect: { x: 0, y: 0, width: 10, height: 10 }, why: { kind: "drawn" } };
    const text = words(pick, "x".repeat(10_000));
    expect(text.length).toBe(MAX_WORDS);
    expect(text.endsWith("x…")).toBe(true);
  });

  it("leaves secret-looking query and fragment values, and any user name, out of the address", () => {
    expect(shareableAddress("https://u:pw@app.example/cb?code=1&access_token=abc&X-Amz-Signature=f00#id_token=eyJ&state=2")).toBe(
      "https://app.example/cb?code=1&access_token=%E2%80%A6&X-Amz-Signature=%E2%80%A6#id_token=%E2%80%A6&state=2",
    );
    expect(shareableAddress("http://localhost:5173/settings#billing")).toBe("http://localhost:5173/settings#billing");
    expect(words({ kind: "region", rect: { x: 0, y: 0, width: 1, height: 1 }, why: { kind: "drawn" } }, "", "http://localhost:3000/?session=abc")).toContain(
      "Page: http://localhost:3000/?session=%E2%80%A6 (Server page)",
    );
  });

  it("keeps a dragged box on the still, whichever way it was dragged", () => {
    expect(dragBox({ x: 300, y: 50 }, { x: 100, y: -20 }, still)).toEqual({ x: 100, y: 0, width: 200, height: 50 });
    expect(dragBox({ x: 1200, y: 700 }, { x: 5000, y: 900 }, still)).toEqual({ x: 1200, y: 700, width: 80, height: 100 });
  });

  it("labels a staged annotation with its page and time, and says when the page has changed since", () => {
    expect(staleText({ url: "http://localhost:5173/a?token=1", takenAtMs: still.takenAtMs, stale: false })).toMatch(/^Taken on http:\/\/localhost:5173\/a\?token=%E2%80%A6 at \d\d:\d\d:\d\d\.$/);
    expect(staleText({ url: "http://localhost:5173/a", takenAtMs: still.takenAtMs, stale: true })).toMatch(/The page has changed since\.$/);
  });
});
