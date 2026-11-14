// Branching a chat from one of its messages (ADR 0027). Hermes does the copy: legacy `session.branch {session_id,
// count, idempotency_key}` forks the live session into a new stored child with the first `count` rows of the parent's
// branch spine, its `parent_session_id` set to the parent (`tui_gateway/methods_session_branch.py` at the deployed
// `bf0203a`). This module holds what the app works out around that call: where the spine puts a message, what the
// branch will hold, whether it can be made now, and whether what Hermes made is what the owner asked for.
//
// The spine (`_visible_branch_history`): the parent's user and assistant rows that have text, in order, hidden ones
// included. Tool rows aren't in it, and an assistant row keeps its text and reasoning but not its tool calls. Probed
// live on 2026-11-03 against a throwaway HERMES_HOME (docs/research/hermes-gateway-api.md, "Branching").
import { isWaiting, type Chat, type Item, type SentReference } from "./model";
import type { ModelPick } from "./models";

/** A stored row of dashboard REST `GET /api/sessions/{id}/messages`, as far as branching reads it. */
export type StoredBranchRow = { id: number; role?: string; content?: unknown; display_kind?: unknown };

/**
 * A row of the parent's branch spine. `hidden`: model-facing, such as a project's instructions; no client shows it.
 * `marker`: a timeline note Hermes stores as a user row, such as a model switch (`_append_model_switch_marker`,
 * `tui_gateway/server.py`); `session.resume` doesn't show it, and it isn't a turn of the owner's.
 */
export type SpineRow = { id: number; role: "user" | "assistant"; text: string; hidden: boolean; marker?: boolean };

/** The message a branch ends with: whose it was, its first words, and its stored row in the parent. */
export type BranchPoint = { role: "user" | "assistant"; excerpt: string; rowId?: number };

/**
 * A branch this app made, kept on this computer per connection and profile (Hermes keeps only the parent's id). `at`:
 * when it was made, Unix ms.
 */
export type BranchLink = { parentId: string; parentTitle: string; point: BranchPoint; at: number; variant?: BranchVariant };

/**
 * What an Edit or Regenerate made a branch for (ADR 0035): another version of one turn of a chat. `rootId` is the chat
 * whose turn this is another version of, and `turn` which turn: the owner's shown messages before it, from 0. That
 * number is the same in the root and in every branch copied from it, since a branch copies every message before it.
 * `model`: what the branch ran on once it was made, as Hermes reported it. `pending`: set until the message has gone
 * into the branch, the words to send and `spineKey` of the rows the branch keeps once its copy of the original message
 * is taken back; `through` is `spineKey` of the rows through the original message, which must be the branch's rows
 * before that message is taken back; `references`, the Referenced chats the original message carried (ADR 0165). Those
 * words are kept on this computer only until they go, as a Draft is.
 */
export type BranchVariant = {
  kind: "edit" | "regenerate";
  rootId: string;
  turn: number;
  model?: ModelPick;
  pending?: { text: string; prefix: string; through: string; references?: SentReference[] };
};

/**
 * A branch asked of Hermes whose answer hasn't come back. `key` is the idempotency key it went with, so asking again
 * returns the same branch while Hermes still holds it. `before`: the parent's branches Hermes listed before it went,
 * so a new one is told apart from them. `startedAt`: Unix ms, this computer's clock.
 */
export type BranchAttempt = {
  key: string;
  parentId: string;
  parentTitle: string;
  point: BranchPoint;
  count: number;
  /** `spineKey` of the rows the preview showed, which the branch Hermes made must hold. No chat text is kept. */
  fingerprint: string;
  before: string[];
  startedAt: number;
  title?: string;
  model?: ModelPick;
  /** Set for an Edit or Regenerate: the branch is made through the owner's message, which it then replaces. */
  variant?: BranchVariant;
};

/** What this computer keeps about branches for one connection and profile. */
export type BranchStore = { links: Record<string, BranchLink>; attempts: BranchAttempt[] };
export const NO_BRANCHES: BranchStore = { links: {}, attempts: [] };

/**
 * How long Hermes remembers a branch's idempotency key (`_IDEMPOTENCY_KEY_TTL` at `bf0203a`). An attempt whose answer
 * was lost is looked for in the chat list until then; after that, a branch not listed was never made.
 */
export const BRANCH_KEY_TTL_MS = 5 * 60_000;

/** The text of a stored message, as Hermes's `_coerce_message_text` reads it for the spine, as far as text goes. */
export function rowText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map((p) => (typeof p === "string" ? p : p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "")).join("");
  return "";
}

/** The parent's branch spine, from its stored rows oldest first. */
export function spineOf(rows: StoredBranchRow[]): SpineRow[] {
  return rows.flatMap((r): SpineRow[] => {
    if (r.role !== "user" && r.role !== "assistant") return [];
    const text = rowText(r.content);
    return text.trim() ? [{ id: r.id, role: r.role, text, hidden: r.display_kind === "hidden", ...(r.display_kind === "model_switch" && { marker: true }) }] : [];
  });
}

const norm = (t: string) => t.replace(/\s+/g, " ").trim();

/** Whether a stored row's text is the message the app shows. A message sent with files is stored with their refs first. */
function sameMessage(row: { role: string; text: string }, item: { kind: string; text: string }): boolean {
  if (row.role !== item.kind) return false;
  const a = norm(row.text);
  const b = norm(item.text);
  return a === b || (item.kind === "user" && !!b && a.endsWith(b));
}

/** A message that can be branched from: one of the owner's or one of Hermes's replies, with text, that Hermes has. */
export const branchable = (i: Item): i is Extract<Item, { kind: "user" | "assistant" }> =>
  (i.kind === "user" && !i.outgoing && !!i.text.trim()) || (i.kind === "assistant" && !!i.text.trim());

/**
 * Where the spine has the message `itemId` of `items`: its index, so the branch copies `index + 1` rows. A message
 * whose stored row is known is found by it; one seen live on this connection, whose row isn't, by its words and how
 * many messages before it have the same words. Otherwise, why it can't be found.
 */
export function locate(items: Item[], itemId: string, spine: SpineRow[]): { index: number } | { error: string } {
  const item = items.find((i) => i.id === itemId);
  if (!item || !branchable(item)) return { error: "Only a message of yours or a reply with text can be branched from." };
  if (item.rowId !== undefined) {
    const index = spine.findIndex((r) => r.id === item.rowId);
    // The row decides: Hermes shows some stored messages differently from how it keeps them.
    if (index >= 0) return { index };
    return { error: "Hermes doesn't list this message among the chat's stored messages, so Hermes Chat can't tell where the branch would start." };
  }
  const before = items.slice(0, items.indexOf(item)).filter((i) => branchable(i) && i.kind === item.kind && norm(i.text) === norm(item.text)).length;
  const shown = spine.map((r, index) => ({ r, index })).filter(({ r }) => !r.hidden && sameMessage(r, item));
  const hit = shown[before];
  if (hit) return { index: hit.index };
  return { error: "Hermes hasn't stored this message yet. Wait a moment, or open the chat again, then branch." };
}

/**
 * A stored message as the owner typed it: without the footer Hermes's @-reference expander appends below the typed
 * text when it stores the message (`agent/context_references.py`), "--- Context Warnings ---" and "--- Attached
 * Context ---" with the files' contents. Hermes strips it with the same rule for titles (`_CONTEXT_FOOTER_RE`,
 * `agent/title_generator.py` at the deployed checkout). A ref named in the footer isn't one the owner sent again.
 */
export const typedText = (text: string) => text.replace(/\n+--- (?:Context Warnings|Attached Context) ---\n[\s\S]*$/, "");

/** The `@file:` refs a message names (`file.attach` `ref_text`, quoted with `` ` ``, `"` or `'` when needed). */
export function fileRefs(text: string): string[] {
  const refs: string[] = [];
  for (const m of typedText(text).matchAll(/@file:(`[^`\n]+`|"[^"\n]+"|'[^'\n]+'|\S+)/g)) refs.push(m[1].replace(/^([`"'])(.*)\1$/, "$2"));
  return refs;
}

/** How many images a stored message carries, as `inline_images=false` shows each: `[image]`, or an attach hint. */
export const imageCount = (text: string) => (text.match(/\[image\]|\[screenshot\]|\[Image attached at: [^\]\n]+\]/g) ?? []).length;

/** Each included message as the preview shows it. */
export type IncludedMessage = { role: "user" | "assistant"; excerpt: string };

/**
 * What a branch from a message would hold, for the owner to check before it's made. `count`: the spine rows Hermes
 * copies, hidden ones included. `messages`: the ones Hermes Chat shows. `hidden`: hidden rows copied with them, such as
 * a project's instructions. `toolCalls`: tool calls before the branch point, whose results aren't copied. `files`: the
 * Server files the copied messages refer to, and whether each is still there (`unknown` when it couldn't be checked).
 * `images`: images sent with those messages. `model`: what the parent runs on, which the branch is switched to.
 */
export type BranchPreview = {
  chatId: string;
  itemId: string;
  parentTitle: string;
  count: number;
  point: BranchPoint;
  messages: IncludedMessage[];
  hidden: number;
  toolCalls: number;
  files: { path: string; state: "there" | "missing" | "unknown" }[];
  images: number;
  model?: ModelPick;
  /** `spineKey` of the rows copied, to check the chat and what Hermes made against. */
  fingerprint: string;
};

/**
 * A message's first words for the preview: its `@file:` refs as a count, and without Markdown's emphasis and code
 * marks, so it reads as the transcript shows it.
 */
export const excerpt = (text: string, max = 90) => {
  const refs = fileRefs(text).length;
  const words = norm(typedText(text).replace(/@file:(`[^`\n]+`|"[^"\n]+"|'[^'\n]+'|\S+)/g, "").replace(/\*\*|__|`/g, ""));
  const t = refs ? `[${refs} ${refs === 1 ? "file" : "files"}] ${words}`.trim() : words;
  return t.length > max ? `${t.slice(0, max - 1).replace(/\s+\S*$/, "")}…` : t;
};

/** The preview of a branch through `spine[index]`, `rows` being the stored rows the spine came from. */
export function previewOf(
  chat: Pick<Chat, "id" | "title" | "model">,
  itemId: string,
  rows: StoredBranchRow[],
  spine: SpineRow[],
  index: number,
): Omit<BranchPreview, "files"> & { refs: string[] } {
  const kept = spine.slice(0, index + 1);
  const last = kept[kept.length - 1];
  // Tool calls answered before the branch point: their tool rows are left out of the branch.
  const toolCalls = rows.filter((r) => r.role === "tool" && r.id < last.id).length;
  const shown = kept.filter((r) => !r.hidden);
  const refs = [...new Set(shown.filter((r) => r.role === "user").flatMap((r) => fileRefs(r.text)))];
  return {
    chatId: chat.id,
    itemId,
    parentTitle: chat.title,
    count: kept.length,
    point: { role: last.role, excerpt: excerpt(last.text, 120), rowId: last.id },
    messages: shown.map((r) => ({ role: r.role, excerpt: excerpt(r.text) })),
    hidden: kept.length - shown.length,
    toolCalls,
    refs,
    images: shown.filter((r) => r.role === "user").reduce((n, r) => n + imageCount(r.text), 0),
    model: chat.model,
    fingerprint: spineKey(kept),
  };
}

/**
 * Why no branch can be made from the chat now, or nothing. A reply running, a Question waiting, or a message not yet
 * confirmed would leave it unclear where the chat ends, so Hermes Chat waits for them.
 */
export function branchBlocked(chat: Chat, connected: boolean): string | undefined {
  if (!connected) return "Not connected to Hermes.";
  if (chat.running || chat.stopping) return "Wait for the reply to finish: while Hermes is replying, it isn't clear where this chat ends.";
  const asked = chat.items.find(isWaiting);
  if (asked) return asked.kind === "approval" ? "Hermes is waiting for an Approval in this chat. Answer it first." : "Hermes is waiting for your answer to a question in this chat. Answer it first.";
  if (chat.items.some((i) => i.kind === "user" && i.outgoing && i.outgoing.state !== "failed"))
    return "A message to this chat isn't confirmed yet. Wait until Hermes has it.";
  if (chat.loading || chat.savedAt !== undefined) return "This chat is still loading from Hermes.";
  return undefined;
}

/**
 * A fingerprint of spine rows, whose they are, whether hidden, and their words exactly as stored: equal for the same
 * rows read the same way, from the parent or from a branch Hermes copied them to. Two 32-bit FNV-1a hashes, so no text
 * is kept.
 */
export function spineKey(rows: Pick<SpineRow, "role" | "text" | "hidden">[]): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ rows.length;
  for (const r of rows) {
    const s = `${r.role}${r.hidden ? "h" : ""}\u0000${r.text}\u0001`;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      a = Math.imul(a ^ c, 0x01000193);
      b = Math.imul(b ^ c, 0x01000193) ^ (b >>> 15);
    }
  }
  return `${rows.length}-${(a >>> 0).toString(16)}${(b >>> 0).toString(16)}`;
}
