// Idle compaction (GLOSSARY.md "Idle compaction", ADR 0119): once a chat open on Hermes here has had nothing happen in
// it for the owner's idle time, and Hermes last measured its context window at least the owner's percent full, the app
// has Hermes compact it, as Compact now does (ADR 0025). Idle is when it costs least: the provider's prompt cache has
// gone cold by then, so the next message pays for the whole context anyway, and it pays for less once compacted.
// One compaction per measure: the meter keeps Hermes's last measure until the next reply, so a chat compacted, or one
// Hermes wouldn't compact, isn't asked again until Hermes measures it anew. Its idle time alone can't re-arm it: Hermes
// may move the chat's last activity as it compacts, and the list's sync then starts a new idle stretch with the same
// stale measure. Nothing here is kept; the prefs are in uiPrefs.ts.
import { isWaiting, type Chat, type ConnectionStatus } from "./model";
import type { CompactResult } from "./contextInspect";
import type { IdleCompactPrefs } from "./uiPrefs";

/** How often the app looks for an idle chat to compact. */
export const IDLE_COMPACT_CHECK_MS = 30_000;

/** What the compactor needs of the connection: `Hermes` has it. */
export type IdleCompactApi = {
  compact(chatId: string): Promise<CompactResult>;
  cannotCompact(): boolean;
};

/** A compaction the compactor asked for, and what came of it: Hermes's answer, or why it failed. */
export type IdleCompaction = { chatId: string; title: string; percent: number; idleMinutes: number } & ({ result: CompactResult } | { error: string });

/** What in a chat counts as something happening: a change in any of it starts a new idle stretch. */
function activityOf(c: Chat): string {
  return [c.runtimeId ?? "", c.running ? 1 : 0, c.loading ? 1 : 0, c.items.length, c.updatedAt].join("|");
}

/** Hermes's measure of the chat's context window, as the meter shows it; a new reply brings a new one. */
function measureOf(c: Chat): string {
  const m = c.live?.context;
  return m ? [c.runtimeId ?? "", m.used, m.max, m.percent].join("|") : "";
}

/**
 * Whether `c` is due for an idle compaction at `now`, given when its idle stretch began (`idleSince`). Only a chat
 * open on Hermes on this connection, with a compactor (`live.compactions` reported), measured at least `percent` full,
 * with no reply running and nothing waiting on the owner, idle for at least `idleMinutes`.
 */
export function isDue(c: Chat, prefs: IdleCompactPrefs, idleSince: number | undefined, now: number): boolean {
  if (!prefs.enabled || idleSince === undefined) return false;
  if (!c.runtimeId || c.running || c.stopping || c.loading || c.archived) return false;
  if (c.live?.compactions === undefined || !c.live.context) return false;
  if (c.live.context.percent < prefs.percent) return false;
  if (c.items.some((i) => isWaiting(i) || (i.kind === "user" && i.outgoing?.state === "sending"))) return false;
  return now - idleSince >= prefs.idleMinutes * 60_000;
}

/**
 * Watches the chats (`observe`, on every change) and, on each `check`, has Hermes compact the chat that has been due
 * longest, one at a time. `report` hears what each compaction came to. Keyed to one connection: make a new one when
 * the connection changes.
 */
export class IdleCompactor {
  /** Each chat's activity as last seen, and when it was first seen so. */
  private seen = new Map<string, { activity: string; since: number }>();
  /** The measure (`measureOf`) each chat was last compacted at, or tried. */
  private tried = new Map<string, string>();
  private running = false;

  constructor(
    private api: IdleCompactApi,
    private prefs: () => IdleCompactPrefs,
    private report: (c: IdleCompaction) => void,
  ) {}

  /** Notes the chats as they are now. An idle stretch starts when a chat's activity changes, or it is first seen. */
  observe(chats: Chat[], now: number) {
    const ids = new Set<string>();
    for (const c of chats) {
      ids.add(c.id);
      const activity = activityOf(c);
      if (this.seen.get(c.id)?.activity !== activity) this.seen.set(c.id, { activity, since: now });
    }
    for (const id of [...this.seen.keys()]) if (!ids.has(id)) this.seen.delete(id);
    for (const id of [...this.tried.keys()]) if (!ids.has(id)) this.tried.delete(id);
  }

  /** The chats due now, idle longest first. */
  due(chats: Chat[], now: number): Chat[] {
    const prefs = this.prefs();
    if (!prefs.enabled || this.api.cannotCompact()) return [];
    return chats
      .filter((c) => {
        const s = this.seen.get(c.id);
        return s && this.tried.get(c.id) !== measureOf(c) && isDue(c, prefs, s.since, now);
      })
      .sort((a, b) => this.seen.get(a.id)!.since - this.seen.get(b.id)!.since);
  }

  /**
   * Compacts the chat due longest, if any and if no compaction from here is still waiting on Hermes. Resolves once
   * Hermes has answered. Does nothing unless connected.
   */
  async check(chats: Chat[], status: ConnectionStatus, now: number): Promise<void> {
    if (this.running || status !== "connected") return;
    this.observe(chats, now);
    const c = this.due(chats, now)[0];
    if (!c) return;
    const s = this.seen.get(c.id)!;
    this.tried.set(c.id, measureOf(c));
    const base = { chatId: c.id, title: c.title, percent: c.live!.context!.percent, idleMinutes: Math.floor((now - s.since) / 60_000) };
    this.running = true;
    try {
      this.report({ ...base, result: await this.api.compact(c.id) });
    } catch (e) {
      this.report({ ...base, error: e instanceof Error ? e.message : String(e) });
    } finally {
      this.running = false;
    }
  }
}

/** A line for the owner about an idle compaction, or undefined when there is nothing worth saying. */
export function idleCompactionNote(c: IdleCompaction): string | undefined {
  const name = `“${c.title || "Untitled chat"}”`;
  if ("error" in c) return `Couldn't compact ${name} while it was idle: ${c.error}`;
  const r = c.result;
  if (r.kind !== "compacted") return undefined;
  const tokens =
    r.beforeTokens !== undefined && r.afterTokens !== undefined
      ? `: about ${r.beforeTokens.toLocaleString("en-US")} → ${r.afterTokens.toLocaleString("en-US")} tokens, as Hermes estimates`
      : r.beforeMessages !== undefined && r.afterMessages !== undefined
        ? `: ${r.beforeMessages} → ${r.afterMessages} messages`
        : "";
  return `Compacted ${name}, idle ${c.idleMinutes} min at ${Math.round(c.percent)}% full${tokens}.`;
}
