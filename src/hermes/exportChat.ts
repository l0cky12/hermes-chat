// A chat as a file, saved where the owner picks in the native Save dialog (`chat_export` and `chat_export_image` in
// src-tauri/src/lib.rs): as Markdown to read, as JSON in Hermes's own session-export shape, which keeps each message's
// time and which Import reads back, as a PNG picture to share (exportImage.ts), or as an inert web page (snapshotPage.ts). The Export dialog (ui/ExportChat.tsx) chooses the format, what goes in and what is redacted, and shows the
// file before it is saved (ADR 0076). Never in it: connection details or attachment contents. Only JSON has the
// chat's session id, so an import of it is skipped where Hermes already has the chat.
import { invoke } from "@tauri-apps/api/core";
import type { ApprovalChoice, Chat, Item } from "./model";
import { REDACTED, findMarkdownSecrets, redactValues } from "./secrets";
import { asError } from "./tauriPipe";
import { LOAD_ERROR_ID } from "./transport";
import type { ImagePage } from "./exportImage";
import { snapshotPage } from "./snapshotPage";
import type { ChatUsage } from "./usage";

/** Shows the Save dialog for `format` and writes `text` where the owner picks. The path saved to, or `null` if cancelled. */
export type SaveFile = (text: string, fileName: string, format: ExportFormat) => Promise<string | null>;

const saveWithDialog: SaveFile = (text, fileName, format) => invoke<string | null>("chat_export", { text, fileName, format }).catch(asError);

const savedNotice = (path: string | null) => (path ? `Exported to ${path}. Read it before you share it: redaction can miss a secret.` : undefined);

/** Saves an export where the owner picks. The notice to show, or nothing when the owner cancelled. Throws when saving fails. */
export async function saveExport(text: string, fileName: string, format: ExportFormat, save = saveWithDialog): Promise<string | undefined> {
  return savedNotice(await save(text, fileName, format));
}

/** Shows the Save dialog for a PNG and writes it where the owner picks. The path saved to, or `null` if cancelled. */
export type SaveImage = (pngBase64: string, fileName: string) => Promise<string | null>;

const saveImageWithDialog: SaveImage = (pngBase64, fileName) => invoke<string | null>("chat_export_image", { pngBase64, fileName }).catch(asError);

/** Saves a PNG, as plain base64 without a `data:` prefix, where the owner picks. As `saveExport`. */
export async function saveImage(pngBase64: string, fileName: string, save = saveImageWithDialog): Promise<string | undefined> {
  return savedNotice(await save(pngBase64, fileName));
}

export const exportFileName = (title: string, extension = "md") =>
  `${
    title
      .replace(/[/\\:*?"<>|\x00-\x1f\s]+/g, " ")
      .trim()
      .replace(/^\.+\s*/, "")
      .slice(0, 100)
      .trim() || "Chat"
  }.${extension}`;

/** The owner's messages, Hermes's replies and its thinking: picked one by one. Tool calls and Approvals go in all or none. */
export const isMessage = (i: Item) => i.kind === "user" || i.kind === "assistant" || i.kind === "thinking";

/** What goes into an export. */
export type ExportChoice = {
  /** Ids of messages (`isMessage`) left out. */
  leftOut: ReadonlySet<string>;
  /** Tool calls, with their arguments and output, and Approvals with their commands. */
  toolCalls: boolean;
  /** The names of files attached to the owner's messages. Their contents are never in an export. */
  attachments: boolean;
  /**
   * Text replaced with `[redacted]` wherever it is in the title or the items, as written there. Overlapping and touching
   * places become one `[redacted]`, so no order of redactions leaves part of one behind.
   */
  redact: readonly string[];
};

/** All of the chat, nothing redacted. */
export const WHOLE: ExportChoice = { leftOut: new Set(), toolCalls: true, attachments: true, redact: [] };

/** `chat` as Markdown: the title, notes on what is and isn't in it, then the chosen items, with `choice.redact` replaced. */
export function chatMarkdown(chat: Chat, exportedAt: Date, choice: ExportChoice = WHOLE): string {
  return render("markdown", chat, exportedAt, choice);
}

/** `chat` as a Hermes session export holding one session, with `choice.redact` replaced. */
export function chatJson(chat: Chat, exportedAt: Date, choice: ExportChoice = WHOLE): string {
  return render("json", chat, exportedAt, choice);
}

/** The chosen items: messages not left out, tool calls and Approvals only when chosen, and never the app's errors. */
const chosen = (chat: Chat, choice: Omit<ExportChoice, "redact">) =>
  chat.items.filter((i) => (isMessage(i) ? !choice.leftOut.has(i.id) : i.kind !== "error" && choice.toolCalls));

const oneLine = (title: string) => title.replace(/\s+/g, " ").trim();

function render(format: ExportFormat, chat: Chat, exportedAt: Date, choice: ExportChoice): string {
  let places = 0;
  const redact = (s: string) => {
    const r = redactValues(s, choice.redact, { anywhere: true });
    places += r.places;
    return r.text;
  };
  return EXPORT_FORMATS[format].write(chat, exportedAt, choice, redact, () => places);
}

/** How a format sets text apart in a note. */
type NoteStyle = { strong: (s: string) => string; code: (s: string) => string };

/** What a file says about itself: what is and isn't in it, an empty line, then that it may hold secrets. */
function exportNotes(chat: Chat, exportedAt: Date, choice: Omit<ExportChoice, "redact">, redacted: number, style: NoteStyle, more: string[] = []): string[] {
  const items = chosen(chat, choice);
  const messages = chat.items.filter(isMessage).length;
  const left = chat.items.filter((i) => isMessage(i) && choice.leftOut.has(i.id)).length;
  const iso = exportedAt.toISOString();
  const missing =
    chat.loading ? "was still loading" : chat.items.some((i) => i.id === LOAD_ERROR_ID) ? "couldn't be loaded" : !chat.runtimeId ? "wasn't loaded" : undefined;
  return [
    `Exported from Hermes Chat on ${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC.`,
    `Only the history loaded in Hermes Chat is included: what Hermes sent when the chat was opened, and what came after.`,
    missing && `This chat's stored history ${missing}, so earlier messages may be missing.`,
    chat.running && "A reply was still being written; it is here as far as it had got.",
    left > 0 && `${left} of the chat's ${messages} messages ${left === 1 ? "was" : "were"} left out.`,
    !choice.toolCalls && chat.items.some((i) => i.kind === "tool" || i.kind === "approval") && "Tool calls and Approvals were left out.",
    !choice.attachments && items.some((i) => i.kind === "user" && i.attachments?.length) && "The names of attached files were left out.",
    items.some((i) => i.kind === "tool" && i.result === undefined && i.status === "done") &&
      "Hermes keeps the output of most tool calls only while the reply is running, so earlier tool calls have none.",
    chat.items.some((i) => i.kind === "error") && "Hermes Chat's own error notices are left out.",
    ...more,
    "",
    `${style.strong("This file may contain sensitive information.")} It has the chat as written, including anything private pasted ` +
      "or printed in it, such as passwords, keys or personal details. Before saving, Hermes Chat flags some kinds of " +
      `secret, and text chosen for redaction is replaced with ${style.code(REDACTED)} (${redacted === 1 ? "1 place" : `${redacted} places`} in this file). ` +
      "It can miss a secret written another way.",
  ].filter((n): n is string => n !== false && n !== undefined);
}

/**
 * Writes a chat as one format. Every free text from the chat goes through `text`, which redacts it or, for the preview,
 * collects it to look for secrets in; ids, roles and times never do. `places`: how many `[redacted]` the texts so far
 * have, for the notes.
 */
type Write = (chat: Chat, exportedAt: Date, choice: Omit<ExportChoice, "redact">, text: (s: string) => string, places: () => number) => string;

export type ExportFormat = "markdown" | "json" | "image" | "html";

/** The chat as Markdown: the title, the notes as a block quote, then the chosen items. */
const markdownWrite: Write = (chat, exportedAt, choice, text, places) => {
  const title = text(`# ${oneLine(chat.title) || "Untitled chat"}`);
  const body = text(
    chosen(chat, choice)
      .flatMap((i) => block(i, choice.attachments))
      .join("\n\n"),
  );
  const notes = exportNotes(chat, exportedAt, choice, places(), { strong: (s) => `**${s}**`, code: (s) => `\`${s}\`` });
  return [title, notes.map((n) => (n ? `> ${n}` : ">")).join("\n"), ...(body ? [body] : [])].join("\n\n") + "\n";
};

const markdownTitle = (file: string) => file.slice(0, file.indexOf("\n")).replace(/^# /, "");

/**
 * Each format the Export dialog offers. A `text` format's file is what `write` returns. An `image` format's `write`
 * returns its `ImagePage` as JSON, which `exportImage.ts` draws and Save writes as a PNG. A `page` format's `write`
 * returns the Markdown that `snapshotPage` makes the page from.
 */
export const EXPORT_FORMATS: Record<ExportFormat, { label: string; extension: string; kind: "text" | "image" | "page"; write: Write; title: (file: string) => string }> = {
  markdown: { label: "Markdown", extension: "md", kind: "text", write: markdownWrite, title: markdownTitle },
  json: {
    label: "JSON",
    extension: "json",
    kind: "text",
    write: (chat, exportedAt, choice, text, places) => JSON.stringify([jsonSession(chat, exportedAt, choice, text, places)], null, 2) + "\n",
    title: (file) => (JSON.parse(file) as { title?: string }[])[0].title ?? "",
  },
  image: {
    label: "Image",
    extension: "png",
    kind: "image",
    write: (chat, exportedAt, choice, text, places) => JSON.stringify(imagePage(chat, exportedAt, choice, text, places)),
    title: (file) => (JSON.parse(file) as ImagePage).title,
  },
  html: { label: "HTML page", extension: "html", kind: "page", write: markdownWrite, title: markdownTitle },
};

/**
 * The chosen items as a picture shows them: each message's words as written, a tool call's name, command and output
 * (not its arguments), and an Approval's command and outcome. The caption says when it was exported and how much was redacted.
 */
function imagePage(chat: Chat, exportedAt: Date, choice: Omit<ExportChoice, "redact">, text: (s: string) => string, places: () => number): ImagePage {
  const blocks = chosen(chat, choice).flatMap((i): ImagePage["blocks"] => {
    switch (i.kind) {
      case "user": {
        const files = choice.attachments && i.attachments?.length ? `\n\nAttached: ${i.attachments.map(text).join(", ")}` : "";
        return [{ who: "You", text: text(i.text) + files }];
      }
      case "assistant":
        return [{ who: "Hermes", text: text(i.text) + (i.interrupted ? "\n\n(stopped before it finished)" : "") }];
      case "thinking":
        return [{ who: "Hermes, thinking", text: text(i.text) }];
      case "tool":
        return [{ who: "Tool", text: [[i.name, i.preview].filter(Boolean).map((t) => text(t!)).join(" "), i.result !== undefined && text(i.result)].filter(Boolean).join("\n") }];
      case "approval": {
        const outcome = i.answer ? ANSWER[i.answer] : i.ended ? `No answer from here (${i.ended})` : "Waiting for an answer";
        return [{ who: "Approval", text: `${text(i.description)}\n${text(i.command)}\n${outcome}` }];
      }
      // Hermes's history keeps a Clarify as the call that asked it; the other Questions say nothing worth keeping.
      case "clarify":
      case "sudo":
      case "secret":
      case "error":
        return [];
    }
  });
  const title = text(oneLine(chat.title) || "Untitled chat");
  const iso = exportedAt.toISOString();
  const n = places();
  const caption = `Exported from Hermes Chat on ${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC · ${n === 1 ? "1 place" : `${n} places`} redacted`;
  return { title, caption, blocks };
}

/** A chat's usage under Hermes's session field names, as `usage.ts` `chatUsageOf` reads them. */
const USAGE_FIELDS: [Exclude<keyof ChatUsage, "cost" | "readAt">, string][] = [
  ["input", "input_tokens"],
  ["output", "output_tokens"],
  ["cacheRead", "cache_read_tokens"],
  ["cacheWrite", "cache_write_tokens"],
  ["reasoning", "reasoning_tokens"],
  ["calls", "api_call_count"],
];

function usageFields(usage: ChatUsage | undefined): Record<string, number> {
  const fields: Record<string, number> = {};
  if (!usage) return fields;
  for (const [ours, hermes] of USAGE_FIELDS) if (usage[ours] !== undefined) fields[hermes] = usage[ours];
  if (usage.cost.kind === "actual") fields.actual_cost_usd = usage.cost.usd;
  else if (usage.cost.kind === "estimated" || usage.cost.kind === "partial") fields.estimated_cost_usd = usage.cost.usd;
  return fields;
}

/**
 * The chat as one session of `hermes sessions export`, which Import's session-export parser reads with its times.
 * Thinking is the `reasoning` of the assistant row after it, as Hermes stores it. A row whose time isn't known has none.
 */
function jsonSession(chat: Chat, exportedAt: Date, choice: Omit<ExportChoice, "redact">, text: (s: string) => string, places: () => number) {
  const items = chosen(chat, choice);
  const title = oneLine(chat.title);
  const session: Record<string, unknown> = { id: chat.id, ...(title && { title: text(title) }), ...(chat.model?.model && { model: chat.model.model }) };
  const messages: Record<string, unknown>[] = [];
  let reasoning: string | undefined;
  let calls = 0;
  const time = (at: number | undefined) => (at === undefined ? {} : { timestamp: at / 1000 });
  const assistant = (row: Record<string, unknown>) => {
    messages.push({ role: "assistant", ...row, ...(reasoning !== undefined && { reasoning }) });
    reasoning = undefined;
  };
  const flushThought = () => reasoning !== undefined && assistant({ content: "" });
  for (const i of items) {
    switch (i.kind) {
      case "user":
        flushThought();
        messages.push({
          role: "user",
          content: text(i.text),
          ...time(i.at),
          ...(i.steer && { display_kind: "steer" }),
          ...(choice.attachments && i.attachments?.length && { attachments: i.attachments.map(text) }),
        });
        break;
      case "assistant":
        assistant({ content: text(i.text), ...time(i.at) });
        break;
      case "thinking":
        flushThought();
        reasoning = text(i.text);
        break;
      case "tool": {
        const id = i.callId ?? `export-call-${++calls}`;
        assistant({ content: "", tool_calls: [{ id, type: "function", function: { name: text(i.name), arguments: text(JSON.stringify(i.args ?? {})) } }] });
        messages.push({ role: "tool", tool_call_id: id, tool_name: text(i.name), content: text(i.result ?? "") });
        break;
      }
      case "approval":
      case "error":
        break;
    }
  }
  flushThought();
  const startedAt = messages.find((m) => m.timestamp !== undefined)?.timestamp;
  const approvals = items.some((i) => i.kind === "approval") ? ["Approvals aren't in a JSON export: Hermes's session format has no place for them."] : [];
  const plain = (s: string) => s;
  return {
    ...session,
    ...(startedAt !== undefined && { started_at: startedAt }),
    ...usageFields(chat.usage),
    hermes_chat_export: {
      version: 1,
      exported_at: exportedAt.toISOString(),
      notes: exportNotes(chat, exportedAt, choice, places(), { strong: plain, code: plain }, approvals).filter(Boolean),
    },
    messages,
  };
}

/** What the owner is choosing in the Export dialog. Every likely secret found is redacted unless the owner keeps it. */
export type ExportDraft = Omit<ExportChoice, "redact"> & {
  /** Likely secrets (`findMarkdownSecrets`) the owner chose to keep in the file. */
  kept: ReadonlySet<string>;
  /** Text the owner picked to redact, in the order picked, as the chat has it (never with `[redacted]` in it). */
  picked: readonly string[];
};

/** A new export: every message, but no tool calls, Approvals or attachment names, and every likely secret redacted. */
export const FIRST_DRAFT: ExportDraft = { leftOut: new Set(), toolCalls: false, attachments: false, kept: new Set(), picked: [] };

export type ExportPreview = {
  /** Exactly what Save writes. */
  text: string;
  fileName: string;
  /** Each different likely secret in what the draft includes, first found first, and how many times it is there. */
  secrets: { text: string; kind: string; times: number; redacted: boolean }[];
  /** Each picked text and how many places it replaced: 0 when it isn't in what the draft includes now. */
  picked: { text: string; times: number }[];
  /** Why a page can't be made from what the draft includes, with `text` empty. Only a `page` format has one. */
  problem?: string;
};

export function exportPreview(chat: Chat, draft: ExportDraft, exportedAt: Date, format: ExportFormat = "markdown"): ExportPreview {
  const { write, title, extension, kind } = EXPORT_FORMATS[format];
  const texts: string[] = [];
  write(chat, exportedAt, draft, (s) => (texts.push(s), s), () => 0);
  const times = (text: string) => texts.reduce((n, s) => n + s.split(text).length - 1, 0);
  const secrets = new Map<string, ExportPreview["secrets"][number]>();
  for (const s of texts.flatMap((t) => findMarkdownSecrets(t)))
    if (!secrets.has(s.text)) secrets.set(s.text, { text: s.text, kind: s.kind, times: times(s.text), redacted: !draft.kept.has(s.text) });
  const redact = [...[...secrets.values()].filter((s) => s.redacted).map((s) => s.text), ...draft.picked];
  const file = render(format, chat, exportedAt, { leftOut: draft.leftOut, toolCalls: draft.toolCalls, attachments: draft.attachments, redact });
  const page = kind === "page" ? snapshotPage({ markdown: file, redacted: redact }) : undefined;
  return {
    text: !page ? file : "page" in page ? page.page.html : "",
    // The title as the file has it, so a redaction there is one in the name too.
    fileName: exportFileName(title(file), extension),
    secrets: [...secrets.values()],
    picked: draft.picked.map((t) => ({ text: t, times: t ? times(t) : 0 })),
    ...(page && "problem" in page && { problem: page.problem }),
  };
}

const ANSWER: Record<ApprovalChoice, string> = { once: "Approved once", session: "Approved for this chat", always: "Always approved", deny: "Denied" };

function block(i: Item, attachments: boolean): string[] {
  switch (i.kind) {
    case "user": {
      const files = attachments && i.attachments?.length ? [`_Attached, not included in this file:_ ${i.attachments.map(code).join(", ")}`] : [];
      return [["**You:**", message(i.text), ...files].filter(Boolean).join("\n\n")];
    }
    case "assistant":
      return [[`**Hermes:**${i.interrupted ? " _(stopped before it finished)_" : ""}`, message(i.text)].filter(Boolean).join("\n\n")];
    case "thinking":
      return [`**Hermes, thinking:**\n\n${fenced(i.text)}`];
    case "tool": {
      const head = [`**Tool:** ${code(i.name)}`, i.preview && code(i.preview), i.summary, i.durationS != null && `(${i.durationS}s)`];
      const output =
        i.result !== undefined
          ? `Output:\n\n${fenced(i.result)}`
          : i.status === "running"
            ? "_Still running when this file was saved; no output yet._"
            : i.status === "stopped"
              ? "_Stopped before it finished; no output._"
              : "_No output: Hermes didn't keep it._";
      const args = i.args && `Arguments:\n\n${fenced(JSON.stringify(i.args, null, 2), "json")}`;
      return [[head.filter(Boolean).join(" "), args, output].filter(Boolean).join("\n\n")];
    }
    case "approval": {
      const outcome = i.answer ? ANSWER[i.answer] : i.ended ? `No answer from here (${i.ended})` : "Waiting for an answer";
      return [`**Approval asked:** ${i.description}\n\n${fenced(i.command)}\n\n_${outcome}_`];
    }
    case "clarify":
    case "sudo":
    case "secret":
      return [];
    case "error":
      // The app's own notices, not the conversation; they can name the connection.
      return [];
  }
}

const longestRun = (text: string, char: string) => Math.max(0, ...(text.match(new RegExp(`${char}+`, "g")) ?? []).map((r) => r.length));

/** Verbatim text in a fence longer than any run of backticks in it, so nothing inside can close it. */
function fenced(text: string, lang = ""): string {
  const fence = "`".repeat(Math.max(3, longestRun(text, "`") + 1));
  return `${fence}${lang}\n${text}\n${fence}`;
}

/** Verbatim text as inline code. */
function code(text: string): string {
  const ticks = "`".repeat(longestRun(text, "`") + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${ticks}${pad}${text}${pad}${ticks}`;
}

/**
 * A message's Markdown as written, with a code fence it leaves open closed, so it can't swallow the rest of the file.
 * ponytail: only sees fences at the start of a line; one opened inside a block quote or list item still runs on.
 */
function message(text: string): string {
  const md = text.replace(/^\s*\n/, "").trimEnd();
  let open: string | undefined;
  for (const line of md.split(/\r?\n/)) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!m) continue;
    if (!open) {
      if (!(m[1][0] === "`" && m[2].includes("`"))) open = m[1];
    } else if (m[1][0] === open[0] && m[1].length >= open.length && !m[2].trim()) open = undefined;
  }
  return open ? `${md}\n${open}` : md;
}
