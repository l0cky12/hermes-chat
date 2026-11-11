// What removing a saved connection deletes from this computer, and the deleting (ADR 0112). Everything is found by the
// connection's scope (connections.ts), so another connection's data, even for a profile of the same name, is never
// touched. Nothing here talks to Hermes: the server's chats, projects, jobs and settings stay as they are.
import { CACHE_PREFIXES, forgetLiveChatData } from "./chatCache";
import { type SavedConnection, inScope, isPrefOf, scopeParts } from "./connections";
import { DRAFT_PREFIX } from "./drafts";
import { IMPORTS_KEY } from "./importTranscripts";
import { INBOX_PREFIX } from "./inbox";
import { OUTPUTS_KEY } from "./outputs";
import { PERSONA_PREFIX, type PersonaStore } from "./personaStore";
import type { DefaultsDoc } from "./projectDefaults";
import { PROJECTS_KEY } from "./projectLinks";
import { SNOOZE_KEY } from "./snooze";
import { forgetTagScopes, type TagsFile } from "./tags";
import { terminalTargetKey } from "./terminal";
import { sending, unsaved } from "./unsaved";
import { getUIPrefs, setUIPrefs } from "./uiPrefs";
import { WORKTREE_CHATS_KEY } from "./worktrees";
import { isObj } from "./values";

/** What removing a connection deletes on this computer, in the owner's words, for the question it asks first. */
export const REMOVED_LOCALLY = [
  "its saved password or token and extra request headers, from the system keyring",
  "its address and username",
  "drafts, Failed messages and Queued messages, with the screenshots waiting in them",
  "the chat lists and Saved copies kept for reading offline, and which profile was shown",
  "which chats are in each project, and the projects' defaults for new chats",
  "tags, Saved filters, snoozes, branch origins, the imports record, and which chats were started in a worktree",
  "unsaved persona edits and the persona versions kept to put back",
  "the Outputs index, inbox dismissals, the chat to reopen, the model pick, and the terminal's SSH target",
] as const;

/** What stays: everything on the server. */
export const KEPT_ON_SERVER = "Nothing on the Hermes server is changed: its chats, projects, scheduled jobs, memory and settings stay there, and you can add the connection again to see them.";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

/** Rewrites a `{scopes: {...}}` document without the connection's scopes, keeping everything else as stored. */
function dropScopes(storage: Store, key: string, parts: string[]) {
  let doc: unknown;
  try {
    doc = JSON.parse(storage.getItem(key) ?? "null");
  } catch {
    return;
  }
  if (!isObj(doc) || !isObj(doc.scopes)) return;
  const scopes = Object.fromEntries(Object.entries(doc.scopes).filter(([s]) => !inScope(parts, s)));
  if (Object.keys(scopes).length === Object.keys(doc.scopes).length) return;
  storage.setItem(key, JSON.stringify({ ...doc, scopes }));
}

/**
 * Deletes everything this computer keeps for `c` but its keyring entries and the connection itself (account.ts
 * `removeConnection` does those). `defaults`: the project defaults file. `tags`: the tags file. `afterwards`: lets go of the screenshots no
 * message needs any more (tauriScreenshot.ts `syncScreenshotOutbox`).
 */
export async function forgetConnectionData(
  c: SavedConnection,
  { storage = localStorage as Store, defaults, tags, persona, afterwards }: { storage?: Store; defaults?: DefaultsDoc; tags?: TagsFile; persona?: PersonaStore; afterwards?: () => Promise<void> } = {},
): Promise<void> {
  const parts = scopeParts(c);
  const prefixes = [...CACHE_PREFIXES(), DRAFT_PREFIX, PERSONA_PREFIX, INBOX_PREFIX];
  const owns = (k: string) => prefixes.some((p) => {
    if (!k.startsWith(p)) return false;
    const scope = k.slice(p.length);
    return inScope(parts, p === PERSONA_PREFIX ? scope.replace(/\.(draft|earlier)$/, "") : scope);
  });
  await persona?.forget(owns);
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k && owns(k)) keys.push(k);
  }
  for (const k of keys) storage.removeItem(k);
  for (const k of unsaved.keys()) if (owns(k)) unsaved.delete(k);
  for (const item of sending) if (owns(item.key)) { item.captured = true; sending.delete(item); }
  forgetLiveChatData(parts);
  dropScopes(storage, PROJECTS_KEY, parts);
  dropScopes(storage, OUTPUTS_KEY, parts);
  dropScopes(storage, SNOOZE_KEY, parts);
  dropScopes(storage, IMPORTS_KEY, parts);
  dropScopes(storage, WORKTREE_CHATS_KEY, parts);
  storage.removeItem(terminalTargetKey(c));

  const { lastOpenChat, modelPicker, modelPicks } = getUIPrefs();
  const left = Object.fromEntries(Object.entries(lastOpenChat).filter(([k]) => !isPrefOf(c, k)));
  const pickGone = modelPicker?.profile !== undefined && isPrefOf(c, modelPicker.profile);
  const picks = Object.fromEntries(Object.entries(modelPicks).filter(([k]) => !isPrefOf(c, k)));
  if (Object.keys(left).length !== Object.keys(lastOpenChat).length || pickGone || Object.keys(picks).length !== Object.keys(modelPicks).length)
    setUIPrefs({ lastOpenChat: left, modelPicks: picks, ...(pickGone && { modelPicker: null }) });

  await defaults?.forgetScopes((s) => inScope(parts, s));
  if (tags) await forgetTagScopes(tags, (s) => inScope(parts, s));
  await afterwards?.().catch(() => {});
}
