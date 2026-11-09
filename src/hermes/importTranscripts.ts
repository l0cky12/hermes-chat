// Importing transcripts (ADR 0031): a file the owner picks is read whole, checked whole, and only then sent to Hermes
// in one `POST /api/sessions/import`, which writes every chat in it or none. Each chat goes in with `source: "import"`,
// which marks it in every Hermes client, and an id taken from the file: the session's own id for a Hermes session
// export, or one made from the file's SHA-256 for a Hermes Chat Markdown export. Hermes skips an id it already has, so
// importing a file again, or retrying one whose answer was lost, never makes a second copy.
//
// Nothing a file names is opened: attachment names, paths and tool arguments come in as text. No tool call is run.
import { invoke } from "@tauri-apps/api/core";
import { asError } from "./tauriPipe";

export type ImportFormat = "markdown" | "jsonl";

export const IMPORT_FORMATS: Record<ImportFormat, { label: string; hint: string; extensions: string[] }> = {
  markdown: {
    label: "Hermes Chat Markdown export",
    hint: "A .md file saved with Export in a chat's header. It has no message times, models or attachments.",
    extensions: ["md"],
  },
  jsonl: {
    label: "Hermes session export (JSON or JSONL)",
    hint: "From hermes sessions export on the command line, or a .json file saved with Export in a chat's header: with times, models and tool calls.",
    extensions: ["jsonl", "json"],
  },
};

/** Hermes's own import limits at the deployed `bf0203a` (`hermes_state.py`, `web_routers/sessions.py`). */
export const IMPORT_LIMITS = {
  fileBytes: 25 * 1024 * 1024,
  sessions: 500,
  messagesPerSession: 10_000,
  totalMessages: 50_000,
  sessionBytes: 5 * 1024 * 1024,
  totalBytes: 25 * 1024 * 1024,
};

/** One chat found in the file, as it will go to Hermes. */
export type PlannedChat = {
  /** Its session id on the server. */
  id: string;
  title: string;
  /** Messages of the owner's and replies with words in them. */
  messages: number;
  toolCalls: number;
  attachments: number;
  /** When it started, Unix seconds, as far as the file says. */
  startedAt?: number;
  model?: string;
  /** Where a Hermes session export says it was had (`cli`, `telegram`, …). */
  from?: string;
  /** The session as it goes to Hermes, messages included. */
  session: Record<string, unknown>;
};

export type ImportPlan = {
  format: ImportFormat;
  fileName: string;
  bytes: number;
  /** SHA-256 of the file's text, hex. */
  digest: string;
  chats: PlannedChat[];
  /** What the file had that doesn't come in, or comes in changed. */
  warnings: string[];
};

/** The file isn't one this format can import; nothing was sent. */
export class ImportFileError extends Error {}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

export async function sha256(text: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Reads and checks the whole file. Throws `ImportFileError` saying where it went wrong; nothing is sent either way. */
export async function planImport(format: ImportFormat, fileName: string, text: string): Promise<ImportPlan> {
  const bytes = utf8Bytes(text);
  if (bytes > IMPORT_LIMITS.fileBytes) throw new ImportFileError(`The file is over ${IMPORT_LIMITS.fileBytes / 1024 / 1024} MB, more than Hermes imports at once.`);
  if (!text.trim()) throw new ImportFileError("The file is empty.");
  const digest = await sha256(text);
  const read = format === "markdown" ? fromMarkdown(text, digest) : fromJsonl(text);
  // Hermes keeps every title in a profile different (`sessions.title` is UNIQUE), and refuses the whole import, as
  // 503 `storage_unavailable`, when one is taken: by the chat the file was exported from, say. The id makes it unique.
  // The whole id: only it is unique in the profile, across every file ever imported.
  const chats = read.chats.map((c) => {
    const title = `${c.title} (imported ${c.id})`;
    return { ...c, title, session: { ...c.session, title } };
  });
  const warnings = [...read.warnings, "Each chat's title gets \"(imported <its id>)\" added, since Hermes needs every title in a profile to be different."];
  checkLimits(chats);
  return { format, fileName, bytes, digest, chats, warnings };
}

function checkLimits(chats: PlannedChat[]) {
  if (!chats.length) throw new ImportFileError("The file has no chats in it.");
  if (chats.length > IMPORT_LIMITS.sessions)
    throw new ImportFileError(`The file has ${chats.length} chats; Hermes imports at most ${IMPORT_LIMITS.sessions} at once. Split it and import each part.`);
  let messages = 0;
  let total = 0;
  for (const c of chats) {
    const rows = (c.session.messages as unknown[]).length;
    if (rows > IMPORT_LIMITS.messagesPerSession)
      throw new ImportFileError(`"${c.title}" has ${rows} messages; Hermes imports at most ${IMPORT_LIMITS.messagesPerSession} in one chat.`);
    messages += rows;
    const size = utf8Bytes(JSON.stringify(c.session));
    if (size > IMPORT_LIMITS.sessionBytes) throw new ImportFileError(`"${c.title}" is over ${IMPORT_LIMITS.sessionBytes / 1024 / 1024} MB, more than Hermes imports in one chat.`);
    total += size;
  }
  if (messages > IMPORT_LIMITS.totalMessages)
    throw new ImportFileError(`The file has ${messages} messages; Hermes imports at most ${IMPORT_LIMITS.totalMessages} at once. Split it and import each part.`);
  if (total > IMPORT_LIMITS.totalBytes) throw new ImportFileError(`The chats come to over ${IMPORT_LIMITS.totalBytes / 1024 / 1024} MB, more than Hermes imports at once.`);
}

// ---- Hermes Chat Markdown export (exportChat.ts `chatMarkdown`, version 1) ----

const TITLE_RE = /^# (.+)$/;
const EXPORTED_RE = /^> Exported from Hermes Chat on (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) UTC\.$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const ATTACHED = "_Attached, not included in this file:_ ";
type BlockKind = "user" | "assistant" | "thinking" | "tool" | "approval";
const HEADERS: [BlockKind, RegExp][] = [
  ["user", /^\*\*You:\*\*$/],
  ["assistant", /^\*\*Hermes:\*\*( _\(stopped before it finished\)_)?$/],
  ["thinking", /^\*\*Hermes, thinking:\*\*$/],
  ["tool", /^\*\*Tool:\*\* (.+)$/],
  ["approval", /^\*\*Approval asked:\*\* (.*)$/],
];
type Block = { kind: BlockKind; head: RegExpExecArray; body: string[]; line: number };

/**
 * The blocks of a Hermes Chat export, each from its header line to the next. A header counts only outside code fences
 * and after a blank line, as the exporter writes it.
 * ponytail: a message whose own text has a blank line then exactly `**You:**` (or another header) splits there; the
 * export doesn't escape it, so no reader can tell. The digest still keeps a re-import from duplicating.
 */
function markdownBlocks(lines: string[], from: number): Block[] {
  const blocks: Block[] = [];
  let open: string | undefined;
  let openedAt = 0;
  for (let n = from; n < lines.length; n++) {
    const line = lines[n];
    const fence = FENCE_RE.exec(line);
    if (open) {
      if (fence && fence[1][0] === open[0] && fence[1].length >= open.length && !fence[2].trim()) open = undefined;
      blocks[blocks.length - 1]?.body.push(line);
      continue;
    }
    const header = (n === from || !lines[n - 1].trim()) && HEADERS.map(([kind, re]) => [kind, re.exec(line)] as const).find(([, m]) => m);
    if (header && header[1]) {
      blocks.push({ kind: header[0], head: header[1], body: [], line: n + 1 });
      continue;
    }
    if (!blocks.length) {
      if (line.trim()) throw new ImportFileError(`Line ${n + 1}: expected a message ("**You:**" or "**Hermes:**"), found "${line.slice(0, 60)}".`);
      continue;
    }
    if (fence && !(fence[1][0] === "`" && fence[2].includes("`"))) {
      open = fence[1];
      openedAt = n + 1;
    }
    blocks[blocks.length - 1].body.push(line);
  }
  if (open) throw new ImportFileError(`Line ${openedAt}: a code block opens here and never closes. The file may be cut short.`);
  return blocks;
}

const trimBlank = (lines: string[]) => {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b);
};

/** The text of the one fenced block in `lines`, or undefined when `lines` isn't exactly one. */
function fencedText(lines: string[]): string | undefined {
  const body = trimBlank(lines);
  const open = body.length >= 2 && FENCE_RE.exec(body[0]);
  if (!open) return undefined;
  const close = FENCE_RE.exec(body[body.length - 1]);
  if (!close || close[1] !== open[1] || close[2].trim()) return undefined;
  return body.slice(1, -1).join("\n");
}

/** The fenced block after the line `label` in `lines`. `[text, rest]`; text undefined when there is no such label. */
function labelledFence(lines: string[], label: string, line: number): [string | undefined, string[]] {
  // The label counts only outside a code fence: tool output can hold a line that reads "Arguments:".
  let inside: RegExpExecArray | undefined;
  const at = lines.findIndex((l) => {
    const fence = FENCE_RE.exec(l);
    if (inside) {
      if (fence && fence[1][0] === inside[1][0] && fence[1].length >= inside[1].length && !fence[2].trim()) inside = undefined;
      return false;
    }
    if (fence) inside = fence;
    return l === label;
  });
  if (at < 0) return [undefined, lines];
  let start = at + 1;
  while (start < lines.length && !lines[start].trim()) start++;
  const open = FENCE_RE.exec(lines[start] ?? "");
  if (!open) throw new ImportFileError(`Line ${line}: "${label}" isn't followed by a code block.`);
  let end = start + 1;
  while (end < lines.length) {
    const close = FENCE_RE.exec(lines[end]);
    if (close && close[1][0] === open[1][0] && close[1].length >= open[1].length && !close[2].trim()) break;
    end++;
  }
  return [lines.slice(start + 1, end).join("\n"), [...lines.slice(0, at), ...lines.slice(end + 1)]];
}

/** Inline code at the start of `s`, as `exportChat.ts` `code` writes it: `[text, rest]`. */
function leadingCode(s: string): [string, string] | undefined {
  const m = /^(`+)(.*?[^`]|)\1(?!`)/.exec(s);
  if (!m) return undefined;
  const inner = m[2];
  const text = inner.length > 1 && inner.startsWith(" ") && inner.endsWith(" ") && inner.trim() ? inner.slice(1, -1) : inner;
  return [text, s.slice(m[0].length).trim()];
}

const codeSpans = (s: string) => {
  const names: string[] = [];
  let rest = s.trim();
  while (rest) {
    const c = leadingCode(rest);
    if (!c) break;
    names.push(c[0]);
    rest = c[1].replace(/^,\s*/, "");
  }
  return names;
};

/** What the exporter writes when a tool call has no output: the only other way a tool block can end. */
const NO_OUTPUT = ["_Still running when this file was saved; no output yet._", "_Stopped before it finished; no output._", "_No output: Hermes didn't keep it._"];

function fromMarkdown(text: string, digest: string): { chats: PlannedChat[]; warnings: string[] } {
  // The exporter ends every file with a line break, so one that stops mid-line was cut short.
  // ponytail: a cut exactly at the end of a block can't be told from a shorter chat; the digest still dedupes it.
  if (!/\n$/.test(text)) throw new ImportFileError("The file stops in the middle of a line, so it was probably cut short.");
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const title = TITLE_RE.exec(lines[0] ?? "");
  if (!title) throw new ImportFileError(`Line 1: a Hermes Chat export starts with the chat's title ("# …"). This file doesn't.`);
  let n = 1;
  while (n < lines.length && !lines[n].trim()) n++;
  const notes: string[] = [];
  for (; n < lines.length && lines[n].startsWith(">"); n++) notes.push(lines[n]);
  const stamp = notes.map((l) => EXPORTED_RE.exec(l)).find(Boolean);
  if (!stamp) throw new ImportFileError(`This isn't a Hermes Chat export: its note doesn't say when Hermes Chat exported it ("> Exported from Hermes Chat on …").`);
  const [, y, mo, d, h, mi] = stamp.map(Number);
  const exportedAt = Date.UTC(y, mo - 1, d, h, mi) / 1000;
  if (!Number.isFinite(exportedAt) || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59)
    throw new ImportFileError("The date the note says it was exported on isn't a real date.");

  const rows: Record<string, unknown>[] = [];
  let reasoning: string | undefined;
  let calls = 0;
  const counts = { messages: 0, attachments: 0, tools: 0, approvals: 0, stopped: 0 };
  const at = { timestamp: exportedAt };
  const assistant = (row: Record<string, unknown>) => {
    rows.push({ role: "assistant", ...row, ...(reasoning !== undefined && { reasoning }), ...at });
    reasoning = undefined;
  };
  const flushThought = () => reasoning !== undefined && assistant({ content: "" });
  for (const b of markdownBlocks(lines, n)) {
    const body = trimBlank(b.body).join("\n");
    switch (b.kind) {
      case "user": {
        flushThought();
        const last = body.split("\n").at(-1) ?? "";
        if (last.startsWith(ATTACHED)) counts.attachments += codeSpans(last.slice(ATTACHED.length)).length;
        // The note naming its attachments stays in its words: they are all the file has of them.
        rows.push({ role: "user", content: body, ...at });
        counts.messages++;
        break;
      }
      case "assistant":
        if (b.head[1]) counts.stopped++;
        assistant({ content: body });
        counts.messages++;
        break;
      case "thinking": {
        const thought = fencedText(b.body);
        if (thought === undefined) throw new ImportFileError(`Line ${b.line}: Hermes's thinking should be one code block, and here it isn't.`);
        if (reasoning !== undefined) flushThought();
        reasoning = thought;
        break;
      }
      case "tool": {
        const name = leadingCode(b.head[1]);
        if (!name || !name[0]) throw new ImportFileError(`Line ${b.line}: a tool call without the tool's name.`);
        const [argsText, rest] = labelledFence(b.body, "Arguments:", b.line);
        const [output, after] = labelledFence(rest, "Output:", b.line);
        if (output === undefined && !after.some((l) => NO_OUTPUT.includes(l.trim())))
          throw new ImportFileError(`Line ${b.line}: the ${name[0]} tool call has no output and no note saying why. The file may be cut short.`);
        let args: unknown = {};
        if (argsText !== undefined) {
          try {
            args = JSON.parse(argsText);
          } catch {
            throw new ImportFileError(`Line ${b.line}: the arguments of the ${name[0]} tool call aren't valid JSON.`);
          }
        }
        const id = `import-call-${++calls}`;
        assistant({ content: "", tool_calls: [{ id, type: "function", function: { name: name[0], arguments: JSON.stringify(args) } }] });
        rows.push({ role: "tool", tool_call_id: id, tool_name: name[0], content: output ?? "", ...at });
        counts.tools++;
        break;
      }
      case "approval": {
        const body = trimBlank(b.body);
        if (!FENCE_RE.test(body[0] ?? "") || !/^_.+_$/.test(body.at(-1) ?? ""))
          throw new ImportFileError(`Line ${b.line}: an Approval without its command or its outcome. The file may be cut short.`);
        counts.approvals++;
        break;
      }
    }
  }
  flushThought();
  if (!rows.length) throw new ImportFileError("The export has no messages in it.");

  const when = new Date(exportedAt * 1000).toISOString();
  const stampId = when.slice(0, 19).replace(/[-:]/g, "").replace("T", "_");
  const chatTitle = title[1].trim();
  const warnings = [
    `Message times aren't in a Markdown export, so every message is dated when the file was exported, ${when.slice(0, 10)} ${when.slice(11, 16)} UTC.`,
    "The model each reply came from isn't in a Markdown export.",
    counts.attachments > 0 && `${plural(counts.attachments, "attachment is", "attachments are")} named in the file but not in it. Only the names come in, as text; no file is read.`,
    counts.tools > 0 &&
      `${plural(counts.tools, "tool call comes", "tool calls come")} in with ${counts.tools === 1 ? "its" : "their"} name, arguments and output; how long ${counts.tools === 1 ? "it" : "they"} took doesn't. Hermes clients show the output of edit tools only. Nothing is run.`,
    counts.approvals > 0 && `${plural(counts.approvals, "Approval isn't", "Approvals aren't")} imported: Hermes has no place for them in a chat's history.`,
    counts.stopped > 0 && `${plural(counts.stopped, "reply was", "replies were")} stopped before finishing; that mark isn't kept.`,
    ...notes
      .map((l) => l.replace(/^>\s?/, ""))
      .filter((l) => /may be missing|still being written|have none/.test(l))
      .map((l) => `The export says: ${l}`),
  ].filter((w): w is string => typeof w === "string");
  return {
    chats: [
      {
        id: `${stampId}_${digest.slice(0, 12)}`,
        title: chatTitle,
        messages: counts.messages,
        toolCalls: counts.tools,
        attachments: counts.attachments,
        startedAt: exportedAt,
        session: { id: `${stampId}_${digest.slice(0, 12)}`, source: "import", title: chatTitle, started_at: exportedAt, messages: rows },
      },
    ],
    warnings,
  };
}

// ---- Hermes session export, JSONL (`hermes sessions export`, `render_sessions_export` at the deployed `bf0203a`) ----
// Hermes Chat's JSON export (exportChat.ts `chatJson`) is one such session in a JSON array. Its `hermes_chat_export`
// notes and its messages' `attachments` names have no place in Hermes and don't come in.

/** A session id this app sends in a URL path: no slashes, dots-only names or spaces. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
/** Hermes's `coerce_epoch` range (`hermes_cli/timefmt.py`). */
const EPOCH_MAX = 4_200_000_000;
const SESSION_KEEP = new Set(["id", "title", "model", "started_at", "ended_at", "end_reason", "messages", "source"]);
const MESSAGE_KEEP = ["role", "content", "timestamp", "tool_calls", "tool_call_id", "tool_name", "reasoning", "reasoning_content", "finish_reason", "active", "compacted", "display_kind"];
/** Session fields worth naming when they don't come in. The rest (ids, flags, counters Hermes recomputes) go unsaid. */
const SESSION_DROPPED_NAMES: Record<string, string> = {
  input_tokens: "token and cost totals",
  output_tokens: "token and cost totals",
  estimated_cost_usd: "token and cost totals",
  actual_cost_usd: "token and cost totals",
  cwd: "the working folder",
  git_branch: "the git branch",
  git_repo_root: "the git branch",
  system_prompt: "the system prompt",
  model_config: "the model settings",
  parent_session_id: "links to parent chats",
  user_id: "the platform's user",
  pinned: "Active or Settled, Archived and hidden",
  archived: "Active or Settled, Archived and hidden",
  hidden: "Active or Settled, Archived and hidden",
};
const ROLES = new Set(["user", "assistant", "tool", "system"]);
const ATTACHMENT_PARTS = new Set(["image", "image_url", "input_image", "file", "input_file", "document"]);

const validTime = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= EPOCH_MAX;
const textOf = (content: unknown) =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => (isObj(p) && typeof p.text === "string" ? p.text : "")).join("") : "";

function jsonRecords(text: string): [unknown, number][] {
  const whole = text.trim();
  if (whole.startsWith("[")) {
    try {
      const all = JSON.parse(whole);
      if (Array.isArray(all)) return all.map((r, i) => [r, i + 1]);
    } catch (e) {
      throw new ImportFileError(`The file isn't valid JSON: ${(e as Error).message}`);
    }
  }
  return text.split(/\r?\n/).flatMap((line, i): [unknown, number][] => {
    if (!line.trim()) return [];
    try {
      return [[JSON.parse(line), i + 1]];
    } catch (e) {
      throw new ImportFileError(`Line ${i + 1} isn't valid JSON: ${(e as Error).message}`);
    }
  });
}

function fromJsonl(text: string): { chats: PlannedChat[]; warnings: string[] } {
  const seen = new Set<string>();
  const dropped = new Set<string>();
  let untimed = 0;
  let otherRoles = 0;
  let attachments = 0;
  let attachmentNames = 0;
  let compacted = 0;
  const chats = jsonRecords(text).map(([raw, line]): PlannedChat => {
    const where = `Line ${line}`;
    if (!isObj(raw)) throw new ImportFileError(`${where} isn't a session: it should be a JSON object.`);
    if (!Array.isArray(raw.messages))
      throw new ImportFileError(
        typeof raw.prompt === "string" || typeof raw.text === "string"
          ? `${where} is a user-prompts export, which has no chats. Export the sessions without --only.`
          : `${where} isn't a session: it has no "messages" list.`,
      );
    const id = raw.id;
    if (typeof id !== "string" || !ID_RE.test(id)) throw new ImportFileError(`${where}: the session id ${JSON.stringify(id)?.slice(0, 80)} isn't one Hermes Chat imports.`);
    if (seen.has(id)) throw new ImportFileError(`${where}: session ${id} is in the file twice.`);
    seen.add(id);
    for (const k of Object.keys(raw)) if (!SESSION_KEEP.has(k) && SESSION_DROPPED_NAMES[k] && raw[k] !== null && raw[k] !== 0 && raw[k] !== false && raw[k] !== "") dropped.add(SESSION_DROPPED_NAMES[k]);
    if (raw.started_at !== undefined && raw.started_at !== null && !validTime(raw.started_at)) throw new ImportFileError(`${where}: session ${id} has a start time Hermes can't use.`);
    let last = validTime(raw.started_at) ? (raw.started_at as number) : undefined;
    let messages = 0;
    let toolCalls = 0;
    let chatAttachments = 0;
    const rows = raw.messages.map((m, i) => {
      if (!isObj(m) || typeof m.role !== "string" || !m.role) throw new ImportFileError(`${where}, message ${i + 1}: it has no role.`);
      if (m.timestamp !== undefined && m.timestamp !== null && !validTime(m.timestamp)) throw new ImportFileError(`${where}, message ${i + 1}: its time isn't one Hermes can use.`);
      const row: Record<string, unknown> = {};
      for (const k of MESSAGE_KEEP) if (m[k] !== undefined && m[k] !== null) row[k] = m[k];
      // Hermes dates a message without a time when it is imported, which would make it look new. It gets the time
      // of the message before it, or the chat's start.
      if (validTime(m.timestamp)) last = m.timestamp as number;
      else if (last !== undefined) {
        row.timestamp = last;
        untimed++;
      } else untimed++;
      if (!ROLES.has(m.role)) otherRoles++;
      if (m.active === 0 || m.active === false) compacted++;
      if ((m.role === "user" || m.role === "assistant") && textOf(m.content).trim()) messages++;
      if (Array.isArray(m.tool_calls)) toolCalls += m.tool_calls.length;
      if (Array.isArray(m.content)) chatAttachments += m.content.filter((p) => isObj(p) && ATTACHMENT_PARTS.has(String(p.type))).length;
      if (Array.isArray(m.attachments)) attachmentNames += m.attachments.filter((a) => typeof a === "string").length;
      return row;
    });
    attachments += chatAttachments;
    const title = typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : "Untitled chat";
    const session: Record<string, unknown> = { id, source: "import", messages: rows };
    for (const k of ["title", "model", "started_at", "ended_at", "end_reason"]) if (raw[k] !== undefined && raw[k] !== null) session[k] = raw[k];
    if (session.started_at === undefined && last !== undefined) session.started_at = rows.find((r) => validTime(r.timestamp))?.timestamp;
    return {
      id,
      title,
      messages,
      toolCalls,
      attachments: chatAttachments,
      startedAt: validTime(session.started_at) ? (session.started_at as number) : undefined,
      model: typeof raw.model === "string" && raw.model ? raw.model : undefined,
      from: typeof raw.source === "string" && raw.source ? raw.source : undefined,
      session,
    };
  });
  const warnings = [
    "Each chat keeps its session id, so one Hermes already has is skipped, not copied.",
    dropped.size > 0 && `Not imported: ${[...dropped].join(", ")}.`,
    untimed > 0 && `${plural(untimed, "message has", "messages have")} no time in the file; each is dated like the message before it, or the chat's start.`,
    attachments > 0 && `${plural(attachments, "attachment comes", "attachments come")} in only as far as the file holds ${attachments === 1 ? "it" : "them"}. No file it names is read.`,
    attachmentNames > 0 && `Attachment names aren't imported: Hermes has no place for them in a chat's history (${plural(attachmentNames, "name")} in the file).`,
    compacted > 0 && `${plural(compacted, "message was", "messages were")} compacted away in the original chat and stay${compacted === 1 ? "s" : ""} that way.`,
    otherRoles > 0 && `${plural(otherRoles, "row has a role", "rows have roles")} Hermes Chat doesn't show; ${otherRoles === 1 ? "it comes" : "they come"} in as ${otherRoles === 1 ? "it is" : "they are"}.`,
  ].filter((w): w is string => typeof w === "string");
  return { chats, warnings };
}

// ---- Sending ----

/** One dashboard REST call, naming its profile itself. */
export type ImportRest = (method: "GET" | "POST", pathAndQuery: string, body?: unknown) => Promise<unknown>;

const sessionPath = (id: string, profile: string, tail = "") => `api/sessions/${encodeURIComponent(id)}${tail}?${new URLSearchParams({ profile })}`;
const LOOKUPS_AT_ONCE = 8;

async function eachAtOnce<T>(items: T[], run: (item: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += LOOKUPS_AT_ONCE) await Promise.all(items.slice(i, i + LOOKUPS_AT_ONCE).map(run));
}

/**
 * A session's revision and whether it exists. A profile that has never had a chat has no session store yet, and
 * Hermes's reads answer 503 "Session store is not initialized" for it, while a write creates the store: so that is no
 * session, at revision 0.
 */
async function snapshot(rest: ImportRest, profile: string, id: string): Promise<{ exists?: boolean; runtime_revision?: number }> {
  try {
    return (await rest("GET", sessionPath(id, profile, "/mutation-snapshot"))) as { exists?: boolean; runtime_revision?: number };
  } catch (e) {
    if (e instanceof Error && e.message.includes("Session store is not initialized")) return { exists: false, runtime_revision: 0 };
    throw e;
  }
}

/** What Hermes has of each id now: its source, or null when it has no such session. */
export async function readBack(rest: ImportRest, profile: string, ids: string[]): Promise<Map<string, string | null>> {
  const found = new Map<string, string | null>();
  await eachAtOnce(ids, async (id) => {
    const snap = await snapshot(rest, profile, id);
    if (!snap.exists) return void found.set(id, null);
    const row = (await rest("GET", sessionPath(id, profile))) as { source?: string };
    found.set(id, typeof row.source === "string" ? row.source : "");
  });
  return found;
}

export type ImportOutcome = {
  /** Imported now, and read back from Hermes as imported chats. */
  imported: string[];
  /** Hermes already had them (from an earlier import, or the original chat), so they were skipped. */
  skipped: string[];
  /** Hermes said it imported them, but reading back didn't find them. */
  unconfirmed: string[];
  /** The answer was lost: what reading back found instead. Import the file again for the rest. */
  interrupted?: string;
};

/** Hermes refused the import, and wrote nothing. */
export class ImportRefusedError extends Error {}

/**
 * Sends the chats in one fenced `POST /api/sessions/import`: Hermes writes all of them or none, and skips ids it has.
 * The fence is the first chat's revision (0 when it isn't there). Then every chat is read back. If the answer is lost,
 * the reading back says what Hermes has; importing again sends the rest, and what Hermes has is skipped.
 */
export async function sendImport(rest: ImportRest, profile: string, chats: PlannedChat[]): Promise<ImportOutcome> {
  const ids = chats.map((c) => c.id);
  let answer: { imported_ids?: unknown; skipped_ids?: unknown } | undefined;
  let lost: string | undefined;
  for (let attempt = 0; ; attempt++) {
    const snap = await snapshot(rest, profile, ids[0]);
    const body = { profile, request_id: crypto.randomUUID(), expected_revision: snap.runtime_revision ?? 0, sessions: chats.map((c) => c.session) };
    const post = async () => (await rest("POST", "api/sessions/import", body)) as typeof answer;
    try {
      answer = await post();
      break;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Another write to the first chat landed between reading its revision and importing: read it again, once.
      if (message.includes("revision_conflict") && attempt === 0) continue;
      if (/answered (4\d\d)/.test(message)) throw new ImportRefusedError(refusal(message));
      // The same request again: Hermes answers with the receipt of the first if that one was written, which says
      // what it made and what it skipped; otherwise this one is the import.
      try {
        answer = await post();
      } catch {
        lost = message;
      }
      break;
    }
  }
  let back: Map<string, string | null>;
  try {
    back = await readBack(rest, profile, ids);
  } catch (e) {
    // Hermes may have written them; it's the reading back that failed, so this isn't a refusal.
    const why = e instanceof Error ? e.message : String(e);
    const said = Array.isArray(answer?.imported_ids) ? answer.imported_ids.filter((x): x is string => typeof x === "string") : [];
    return {
      imported: [],
      skipped: [],
      unconfirmed: said,
      interrupted: `${lost === undefined ? "Hermes answered" : `The answer from Hermes was lost (${lost})`}, but reading the chats back failed (${why}), so it isn't known what Hermes has. Import the file again; the ones Hermes has are skipped.`,
    };
  }
  const has = (id: string) => back.get(id) !== null && back.get(id) !== undefined;
  if (lost !== undefined) {
    const there = ids.filter(has);
    // Without the receipt, a chat Hermes has may be from before; none is counted as made by this import.
    return {
      imported: [],
      skipped: [],
      unconfirmed: [],
      interrupted: there.length
        ? `The answer from Hermes was lost (${lost}). Hermes has ${there.length} of the ${plural(ids.length, "chat")}. Import the file again to bring in the rest; the ones Hermes has are skipped.`
        : `Nothing was imported: Hermes didn't take the chats, or its answer was lost (${lost}). Reading back found none of them. Try again; any Hermes has by then is skipped.`,
    };
  }
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const imported = list(answer?.imported_ids);
  return {
    imported: imported.filter(has),
    skipped: list(answer?.skipped_ids),
    unconfirmed: imported.filter((id) => !has(id)),
  };
}

/** A 4xx from the import route in the owner's words. */
function refusal(message: string): string {
  const errors = /"errors":\s*(\[[\s\S]*\])/.exec(message);
  if (errors) {
    try {
      const list = JSON.parse(errors[1]) as { error?: string; session_id?: string }[];
      return `Hermes refused the file and imported nothing: ${list.map((e) => `${e.session_id ? `${e.session_id}: ` : ""}${e.error}`).join("; ")}.`;
    } catch {
      // The plain message below.
    }
  }
  if (message.includes("invalid_params"))
    return "Hermes refused the file and imported nothing: something in it isn't what Hermes can import, and Hermes didn't say what (invalid_params).";
  if (message.includes("was deleted here")) return "Hermes refused the file and imported nothing: a chat in it was deleted from this Hermes, and Hermes won't bring a deleted chat back.";
  if (message.includes("answered 413")) return "Hermes refused the file and imported nothing: it's larger than Hermes takes at once.";
  if (message.includes("answered 404") && message.includes("Profile")) return "Hermes refused the file and imported nothing: the profile isn't on the server any more.";
  if (/answered 40[45]/.test(message) && !message.includes("Profile"))
    return "This Hermes can't import transcripts: its dashboard has no session import (Hermes Chat was built against bf0203a).";
  return `Hermes refused the file and imported nothing: ${message}`;
}

// ---- What this computer remembers of imports ----

export const IMPORTS_KEY = "hermes-chat.imports";
const LEDGER_LIMIT = 200;

/** An import of one file, kept per connection and profile by the file's digest. */
export type ImportRecord = {
  fileName: string;
  format: ImportFormat;
  /** When it was started, Unix ms. */
  at: number;
  /** `started`: sent, and the outcome not known yet (the app may have closed meanwhile). */
  state: "started" | "done";
  ids: string[];
};

type LedgerDoc = { v: 1; scopes: Record<string, Record<string, ImportRecord>> };

export type ImportLedger = {
  get(scope: string, digest: string): ImportRecord | undefined;
  put(scope: string, digest: string, record: ImportRecord): void;
};

export function importLedger(storage: Pick<Storage, "getItem" | "setItem"> = localStorage): ImportLedger {
  const read = (): LedgerDoc => {
    try {
      const doc = JSON.parse(storage.getItem(IMPORTS_KEY) ?? "null");
      if (isObj(doc) && doc.v === 1 && isObj(doc.scopes)) return doc as LedgerDoc;
    } catch {
      // Unreadable: start again.
    }
    return { v: 1, scopes: {} };
  };
  return {
    get: (scope, digest) => {
      const r = read().scopes[scope]?.[digest];
      return isObj(r) && Array.isArray(r.ids) && typeof r.at === "number" ? r : undefined;
    },
    put: (scope, digest, record) => {
      const doc = read();
      const kept = Object.entries({ ...doc.scopes[scope], [digest]: record })
        .sort(([, a], [, b]) => b.at - a.at)
        .slice(0, LEDGER_LIMIT);
      doc.scopes[scope] = Object.fromEntries(kept);
      try {
        storage.setItem(IMPORTS_KEY, JSON.stringify(doc));
      } catch {
        // Storage full: Hermes's own skip of ids it has still keeps a re-import from duplicating.
      }
    },
  };
}

// ---- Picking the file ----

export type PickedTranscript = { name: string; path: string; text: string };

/**
 * The native Open dialog for an import file, read whole by Rust (`import_pick_file`) up to Hermes's limit. Only the
 * file picked is read; the webview never names a path. `null`: the owner cancelled.
 */
export const pickTranscript = (format: ImportFormat): Promise<PickedTranscript | null> =>
  invoke<PickedTranscript | null>("import_pick_file", { extensions: IMPORT_FORMATS[format].extensions, maxBytes: IMPORT_LIMITS.fileBytes }).catch(asError);
