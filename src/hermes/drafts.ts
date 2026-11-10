// What the owner has typed in each chat's composer and not sent yet, kept in localStorage per connection, profile
// and chat, so switching chats or restarting the app doesn't lose it. Text only: the chat's staged attachments are
// kept beside it by the screenshot desk, under the same key, for this run only (ADR 0135). A sent message Hermes
// didn't take, or may not have, isn't a draft: it stays in its chat, kept in the chat's outbox (transport.ts
// `Outgoing`), until the owner retries or dismisses it.
//
// Each Draft keeps its own undo history here, in memory only: the webview's history can't be used in the composer,
// since text the app writes (a slash pick, a Draft shown again on a chat switch, another pane on the same Draft)
// breaks it (ADR 0128).
import { type ScopeSource, scopeParts } from "./connections";
import { type EditKind, type History, emptyHistory, record, redo, undo } from "./editHistory";
import { persist } from "./unsaved";

export const DRAFT_PREFIX = "hermes-chat.draft.";
const PREFIX = DRAFT_PREFIX;

/** The storage drafts are kept in: localStorage in the app. */
export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Where a chat's draft is kept. `chatId` null is the new chat the owner hasn't sent anything in yet. */
export function draftKey(connection: ScopeSource, profile: string, chatId: string | null): string {
  return PREFIX + JSON.stringify([...scopeParts(connection), profile, chatId]);
}

export type Drafts = {
  get(key: string): string;
  /** Keeps the text, an undo step unless it is unchanged; empty text deletes the draft. */
  set(key: string, text: string, how?: EditKind): void;
  /** Steps the Draft back or forward and returns its text then, or undefined when there's nothing to step. */
  undo(key: string): string | undefined;
  redo(key: string): string | undefined;
  /** Empties the draft as its message goes, and returns what it held. Its undo history goes too. */
  take(key: string): string;
  /** Puts back text that didn't go, unless the owner has typed something new there meanwhile. */
  putBack(key: string, text: string): void;
  subscribe(fn: () => void): () => void;
};

/**
 * Drafts kept in `storage`. They're read from memory once loaded, so a store that is full or can't be written still
 * keeps them until the app closes.
 */
export function drafts(storage: DraftStorage, now = Date.now): Drafts {
  const texts = new Map<string, string>();
  const histories = new Map<string, History<{ text: string }>>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((fn) => fn());
  const get = (key: string) => {
    let text = texts.get(key);
    if (text === undefined) {
      try {
        text = storage.getItem(key) ?? "";
      } catch {
        text = "";
      }
      texts.set(key, text);
    }
    return text;
  };

  const write = (key: string, text: string) => {
    texts.set(key, text);
    // A failed write keeps it in memory, and for an update's restart (unsaved.ts).
    persist(() => storage, key, text || null);
    notify();
  };
  const set = (key: string, text: string, how: EditKind = "change") => {
    const before = get(key);
    if (before === text) return;
    histories.set(key, record(histories.get(key) ?? emptyHistory(), { text: before }, how, now()));
    write(key, text);
  };
  const step = (key: string, by: typeof undo) => {
    const moved = by(histories.get(key) ?? emptyHistory(), { text: get(key) });
    if (!moved) return undefined;
    histories.set(key, moved.history);
    write(key, moved.state.text);
    return moved.state.text;
  };

  return {
    get,
    set,
    undo: (key) => step(key, undo),
    redo: (key) => step(key, redo),
    take(key) {
      const text = get(key);
      set(key, "");
      histories.delete(key);
      return text;
    },
    putBack(key, text) {
      if (!get(key)) set(key, text);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
}

