// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImageTooTallError, chatImage, layoutImage, type ImageBox, type ImageLayout, type ImagePage } from "./exportImage";

const measure = (text: string) => text.length * 8;
const page = (blocks: ImagePage["blocks"], title = "Fix nightly backup cron"): ImagePage => ({
  title,
  caption: "Exported from Hermes Chat on 2026-11-08 14:02 UTC · 2 places redacted",
  blocks,
});

const linesIn = (layout: ImageLayout, box: ImageBox) => layout.lines.filter((l) => l.top >= box.top && l.top < box.top + box.height);
/** A block's own text lines, without its label. */
const bodyOf = (layout: ImageLayout, i: number) => linesIn(layout, layout.boxes[i]).slice(1).map((l) => l.text);
/** The right edge text may reach in a box: the same inset as on the left. */
const rightEdge = (layout: ImageLayout, box: ImageBox) => box.x + box.width - (linesIn(layout, box)[0].x - box.x);

describe("layoutImage", () => {
  it("wraps words at the block's width and keeps every word in order", () => {
    const words = Array.from({ length: 60 }, (_, i) => `word${i}`);
    const layout = layoutImage(page([{ who: "Hermes", text: words.join(" ") }]), measure);
    const box = layout.boxes[0];
    const body = linesIn(layout, box).slice(1);
    expect(body.length).toBeGreaterThan(1);
    expect(body.map((l) => l.text).join(" ").split(" ")).toEqual(words);
    const edge = rightEdge(layout, box);
    body.forEach((line, i) => {
      expect(line.x + measure(line.text)).toBeLessThanOrEqual(edge);
      const next = body[i + 1]?.text.split(" ")[0];
      if (next) expect(line.x + measure(`${line.text} ${next}`)).toBeGreaterThan(edge);
    });
  });

  it("wraps into more lines when the image is narrower", () => {
    const text = "the backup job runs at three and writes to the remote bucket every night ".repeat(4);
    const wide = layoutImage(page([{ who: "You", text }]), measure, 720);
    const narrow = layoutImage(page([{ who: "You", text }]), measure, 400);
    expect(bodyOf(narrow, 0).length).toBeGreaterThan(bodyOf(wide, 0).length);
    expect(narrow.height).toBeGreaterThan(wide.height);
  });

  it("starts a new line at each line break in the text, blank lines included", () => {
    const layout = layoutImage(page([{ who: "You", text: "one\ntwo\r\n\nthree" }]), measure);
    expect(bodyOf(layout, 0)).toEqual(["one", "two", "", "three"]);
  });

  it("breaks a word wider than the block between characters", () => {
    const word = "x".repeat(200);
    const layout = layoutImage(page([{ who: "Tool", text: word }]), measure);
    const box = layout.boxes[0];
    const body = linesIn(layout, box).slice(1);
    expect(body.length).toBeGreaterThan(1);
    expect(body.map((l) => l.text).join("")).toBe(word);
    for (const line of body) expect(line.x + measure(line.text)).toBeLessThanOrEqual(rightEdge(layout, box));
  });

  it("keeps the blocks in order, each under its label, below the title and caption", () => {
    const blocks: ImagePage["blocks"] = [
      { who: "You", text: "Why did the backup fail?" },
      { who: "Hermes, thinking", text: "Check the cron log." },
      { who: "Tool", text: "cat /var/log/cron" },
      { who: "Approval", text: "Run cat /var/log/cron: allowed once" },
      { who: "Hermes", text: "The disk was full." },
    ];
    const layout = layoutImage(page(blocks), measure);
    expect(layout.lines[0].text).toBe("Fix nightly backup cron");
    expect(layout.lines[1].text).toBe("Exported from Hermes Chat on 2026-11-08 14:02 UTC · 2 places redacted");
    expect(layout.boxes.map((b) => b.who)).toEqual(blocks.map((b) => b.who));
    layout.boxes.forEach((box, i) => {
      expect(linesIn(layout, box).map((l) => l.text)).toEqual([blocks[i].who, blocks[i].text]);
      expect(box.top).toBeGreaterThan(layout.lines[1].top);
      if (i > 0) expect(box.top).toBeGreaterThanOrEqual(layout.boxes[i - 1].top + layout.boxes[i - 1].height);
    });
  });

  it("grows taller with more content, and every line fits inside the image", () => {
    const one = layoutImage(page([{ who: "You", text: "hi" }]), measure);
    const two = layoutImage(page([{ who: "You", text: "hi" }, { who: "Hermes", text: "hello" }]), measure);
    const longer = layoutImage(page([{ who: "You", text: "hi\nthere\nfriend" }]), measure);
    expect(two.height).toBeGreaterThan(one.height);
    expect(longer.height).toBeGreaterThan(one.height);
    for (const layout of [one, two, longer]) {
      for (const line of layout.lines) expect(line.top + line.height).toBeLessThanOrEqual(layout.height);
      for (const box of layout.boxes) expect(box.top + box.height).toBeLessThanOrEqual(layout.height);
    }
  });

  it("draws lines inside ``` fences in a monospace font, indentation kept", () => {
    const text = "Run this:\n```sh\n    rsync -a /srv backup:\n```\nThen check.";
    const layout = layoutImage(page([{ who: "Hermes", text }]), measure);
    const body = linesIn(layout, layout.boxes[0]).slice(1);
    expect(body.map((l) => l.text)).toEqual(["Run this:", "```sh", "    rsync -a /srv backup:", "```", "Then check."]);
    expect(body.map((l) => l.font.includes("monospace"))).toEqual([false, true, true, true, false]);
  });

  it("draws a tool's output in a monospace font", () => {
    const layout = layoutImage(page([{ who: "Tool", text: "tail -n 1 /var/log/cron\nNov 08 03:00:02 rsync: No space left" }]), measure);
    const body = linesIn(layout, layout.boxes[0]).slice(1);
    expect(body).toHaveLength(2);
    for (const line of body) expect(line.font).toContain("monospace");
  });
});

describe("chatImage", () => {
  afterEach(() => vi.restoreAllMocks());

  /** jsdom has no 2D context: a stand-in that measures 8 px a character and records what is drawn. */
  function fakeCanvas() {
    const ctx = {
      font: "",
      fillStyle: "",
      textBaseline: "",
      measureText: (text: string) => ({ width: measure(text) }),
      fillText: vi.fn(),
      fillRect: vi.fn(),
      scale: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      arcTo: vi.fn(),
      closePath: vi.fn(),
      fill: vi.fn(),
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,iVBORw0KGgo=");
    return { ctx, toDataURL };
  }

  it("draws every line it was given, as given, and returns the PNG without the data: prefix", async () => {
    const { ctx } = fakeCanvas();
    const png = await chatImage(page([{ who: "You", text: "token [redacted] leaked?" }]), { scale: 2, dark: true });
    expect(png).toBe("iVBORw0KGgo=");
    expect(ctx.fillText.mock.calls.map((c) => c[0])).toEqual([
      "Fix nightly backup cron",
      "Exported from Hermes Chat on 2026-11-08 14:02 UTC · 2 places redacted",
      "You",
      "token [redacted] leaked?",
    ]);
  });

  it("refuses an image taller than a browser draws, before drawing anything", async () => {
    const { ctx, toDataURL } = fakeCanvas();
    const blocks = Array.from({ length: 400 }, () => ({ who: "Hermes" as const, text: "a line\nanother line" }));
    await expect(chatImage(page(blocks), { scale: 2 })).rejects.toBeInstanceOf(ImageTooTallError);
    expect(ctx.fillText).not.toHaveBeenCalled();
    expect(ctx.fillRect).not.toHaveBeenCalled();
    expect(toDataURL).not.toHaveBeenCalled();
  });

  it("allows a taller image at a smaller scale", async () => {
    fakeCanvas();
    const blocks = Array.from({ length: 250 }, () => ({ who: "Hermes" as const, text: "a line\nanother line" }));
    await expect(chatImage(page(blocks), { scale: 3 })).rejects.toBeInstanceOf(ImageTooTallError);
    await expect(chatImage(page(blocks), { scale: 1 })).resolves.toBe("iVBORw0KGgo=");
  });
});
