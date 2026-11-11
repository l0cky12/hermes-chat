// What removing a saved connection deletes from this computer, and the deleting (ADR 0112). Everything is found by the
// connection's scope (connections.ts), so another connection's data, even for a profile of the same name, is never
// touched. Nothing here talks to Hermes: the server's chats, projects, jobs and settings stay as they are.
import type { SavedConnection } from "./connections";
import type { PersonaStore } from "./personaStore";
import { forgetConnectionLocally } from "./profileLocalData";
import type { Drafts } from "./drafts";
import type { DefaultsDoc } from "./projectDefaults";
import type { TagsFile } from "./tags";
import { terminalTargetKey } from "./terminal";

/** What removing a connection deletes on this computer, in the owner's words, for the question it asks first. */
export const REMOVED_LOCALLY = [
  "its saved password or token and extra request headers, from the system keyring",
  "its address and username",
  "drafts, Failed messages and Queued messages, with the screenshots waiting in them",
  "the chat lists and Saved copies kept for reading offline, and which profile was shown",
  "which chats are in each project, and the projects' defaults for new chats",
  "tags, Saved filters, pins, snoozes, branch origins, the imports record, and which chats were started in a worktree",
  "unsaved persona edits and the persona versions kept to put back",
  "the Outputs index, inbox dismissals, the chat to reopen, the model pick, and the terminal's SSH target",
] as const;

/** What stays: everything on the server. */
export const KEPT_ON_SERVER = "Nothing on the Hermes server is changed: its chats, projects, scheduled jobs, memory and settings stay there, and you can add the connection again to see them.";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

/**
 * Deletes everything this computer keeps for `c` but its keyring entries and the connection itself (account.ts
 * `removeConnection` does those). `defaults`: the project defaults file. `tags`: the tags file. `afterwards`: lets go of the screenshots no
 * message needs any more (tauriScreenshot.ts `syncScreenshotOutbox`).
 */
export async function forgetConnectionData(
  c: SavedConnection,
  {
    storage = localStorage as Store,
    defaults,
    tags,
    persona,
    drafts,
    afterwards,
  }: { storage?: Store; defaults?: DefaultsDoc; tags?: TagsFile; persona?: PersonaStore; drafts?: Pick<Drafts, "move">; afterwards?: () => Promise<void> } = {},
): Promise<void> {
  // Every profile's data, through the one list a profile's rename and delete walk too (profileLocalData.ts).
  await forgetConnectionLocally(c, { storage, defaults, tags, persona, drafts });
  storage.removeItem(terminalTargetKey(c));
  await afterwards?.().catch(() => {});
}
