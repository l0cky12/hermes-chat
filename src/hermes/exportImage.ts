// A chat drawn as a PNG to share one exchange. Canvas 2D only, so it draws the same in WebKitGTK and WebView2.
// Text is drawn as written, never rendered as Markdown, so the picture shows exactly the redacted text it was given.
import { BUILTIN_THEMES, DEFAULT_THEME_ID, themeVars, type Mode } from "../ui/themes";

/** What the image shows, every text already redacted by the caller. */
export type ImagePage = {
  title: string;
  /** One short line under the title, e.g. "Exported from Hermes Chat on 2026-11-08 14:02 UTC · 2 places redacted". */
  caption: string;
  blocks: { who: Who; text: string }[];
};
export type Who = "You" | "Hermes" | "Hermes, thinking" | "Tool" | "Approval";
export type Measure = (text: string, font: string) => number;

export type ColorToken = "--bg" | "--raised" | "--raised-2" | "--code-bg" | "--accent-soft" | "--text" | "--text-2" | "--text-strong" | "--muted" | "--accent";
/** One drawn line of text, in CSS px from the image's top left. `top` and `height` are the line's box; the text sits centered in it. */
export type ImageLine = { text: string; font: string; color: ColorToken; x: number; top: number; height: number };
/** The rounded background behind one block, in the same order as the page's blocks. */
export type ImageBox = { who: Who; fill: ColorToken; x: number; top: number; width: number; height: number };
export type ImageLayout = { width: number; height: number; boxes: ImageBox[]; lines: ImageLine[] };

export class ImageTooTallError extends Error {
  override name = "ImageTooTallError";
}

export const IMAGE_WIDTH = 720;
/** Device pixels; browsers stop drawing a canvas side past 32 767. */
const MAX_CANVAS_PX = 32_000;

const UI_FONT = `Inter, "Geist", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
const MONO_FONT = `"JetBrains Mono", "Fira Code", ui-monospace, "SFMono-Regular", Menlo, monospace`;
const STYLES = {
  title: { font: `600 20px ${UI_FONT}`, lineHeight: 28 },
  caption: { font: `13px ${UI_FONT}`, lineHeight: 20 },
  label: { font: `600 13px ${UI_FONT}`, lineHeight: 20 },
  body: { font: `15px ${UI_FONT}`, lineHeight: 23 },
  code: { font: `13px ${MONO_FONT}`, lineHeight: 20 },
};
const PAD = 32;
const BLOCK_PAD = 14;
const BLOCK_GAP = 12;
const RADIUS = 10;

const WHO: Record<Who, { fill: ColorToken; label: ColorToken; text: ColorToken; mono?: true }> = {
  You: { fill: "--raised-2", label: "--text-strong", text: "--text" },
  Hermes: { fill: "--raised", label: "--accent", text: "--text" },
  "Hermes, thinking": { fill: "--raised", label: "--muted", text: "--muted" },
  Tool: { fill: "--code-bg", label: "--muted", text: "--text-2", mono: true },
  Approval: { fill: "--accent-soft", label: "--accent", text: "--text" },
};

/** Greedy word wrap of one line with no line breaks; a word wider than `max` breaks between characters. */
function wrap(line: string, font: string, max: number, measure: Measure): string[] {
  const out: string[] = [];
  let cur = "";
  for (const token of line.match(/\s+|\S+/g) ?? []) {
    if (measure(cur + token, font) <= max) {
      cur += token;
      continue;
    }
    if (/\s/.test(token[0])) {
      if (cur) out.push(cur);
      cur = "";
      continue;
    }
    if (cur) out.push(cur.trimEnd());
    cur = "";
    for (const ch of token) {
      if (cur && measure(cur + ch, font) > max) {
        out.push(cur);
        cur = "";
      }
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

const paragraphs = (text: string) => text.replace(/\t/g, "    ").split(/\r?\n/);

/** Pure: wraps every block to `width`, returns lines with positions and the total height. */
export function layoutImage(page: ImagePage, measure: Measure, width = IMAGE_WIDTH): ImageLayout {
  const lines: ImageLine[] = [];
  const boxes: ImageBox[] = [];
  let top = PAD;
  const put = (text: string, style: keyof typeof STYLES, color: ColorToken, x: number, max: number) => {
    const { font, lineHeight } = STYLES[style];
    for (const part of wrap(text, font, max, measure)) {
      lines.push({ text: part, font, color, x, top, height: lineHeight });
      top += lineHeight;
    }
  };

  const inner = width - 2 * PAD;
  for (const p of paragraphs(page.title)) put(p, "title", "--text-strong", PAD, inner);
  if (page.caption) {
    top += 4;
    for (const p of paragraphs(page.caption)) put(p, "caption", "--muted", PAD, inner);
  }
  top += 20;

  const textX = PAD + BLOCK_PAD;
  const textMax = inner - 2 * BLOCK_PAD;
  for (const { who, text } of page.blocks) {
    const look = WHO[who];
    const boxTop = top;
    top += BLOCK_PAD;
    put(who, "label", look.label, textX, textMax);
    top += 4;
    let inCode = false;
    for (const p of paragraphs(text)) {
      const fence = p.trimStart().startsWith("```");
      put(p, look.mono || inCode || fence ? "code" : "body", look.text, textX, textMax);
      if (fence) inCode = !inCode;
    }
    top += BLOCK_PAD;
    boxes.push({ who, fill: look.fill, x: PAD, top: boxTop, width: inner, height: top - boxTop });
    top += BLOCK_GAP;
  }
  if (page.blocks.length) top -= BLOCK_GAP;
  return { width, height: top + PAD, boxes, lines };
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Draws `page` on a canvas and returns the PNG as base64 (no data: prefix). */
export async function chatImage(page: ImagePage, opts: { scale?: number; dark?: boolean } = {}): Promise<string> {
  const scale = opts.scale ?? Math.max(2, window.devicePixelRatio || 1);
  const mode: Mode = (opts.dark ?? document.documentElement.dataset.mode !== "light") ? "dark" : "light";
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This window can't draw images, so the chat can't be exported as one.");
  await document.fonts?.ready;

  const layout = layoutImage(page, (text, font) => {
    ctx.font = font;
    return ctx.measureText(text).width;
  });
  const limit = Math.floor(MAX_CANVAS_PX / scale);
  if (layout.height > limit) {
    throw new ImageTooTallError(
      `This image would be ${Math.ceil(layout.height)} px tall, more than the ${limit} px a picture can be. Leave some messages out and try again.`,
    );
  }

  canvas.width = Math.ceil(layout.width * scale);
  canvas.height = Math.ceil(layout.height * scale);
  ctx.scale(scale, scale);
  const theme = BUILTIN_THEMES.find((t) => t.id === DEFAULT_THEME_ID)!;
  const colors = themeVars(theme[mode], mode) as Record<ColorToken, string>;

  ctx.fillStyle = colors["--bg"];
  ctx.fillRect(0, 0, layout.width, layout.height);
  for (const box of layout.boxes) {
    ctx.fillStyle = colors[box.fill];
    roundedRect(ctx, box.x, box.top, box.width, box.height, RADIUS);
    ctx.fill();
  }
  ctx.textBaseline = "middle";
  for (const line of layout.lines) {
    ctx.font = line.font;
    ctx.fillStyle = colors[line.color];
    ctx.fillText(line.text, line.x, line.top + line.height / 2);
  }
  return canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
}
