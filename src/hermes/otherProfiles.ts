// Unread chats in the profiles the app doesn't show. The socket announces store changes only for the profiles the
// dashboard process serves (research doc "sessions.changed across profiles"), so the other profiles are polled over
// dashboard REST instead, without touching the chat socket. A check only reads lists: it never moves a chat's read
// watermark. Each check belongs to the connection and profile shown when it started; once either changes, what it
// finds is dropped and it asks nothing more.
import { sameFields, type CheckTimes, type ListedChat, type OtherProfile, type OtherProfiles, type SavedSend, type SeenFailure } from "./model";

/** How often the app checks the other profiles. What it shows can be this far behind. */
export const CHECK_EVERY_MS = 120_000;
/** A check asked for sooner than this after the last one, for the same connection and profile, is skipped. */
const MIN_GAP_MS = 15_000;
/** The most profiles one check reads at once. */
const AT_ONCE = 2;
/** The most profiles one check reads; the ones checked longest ago go first, so a big server is covered in turns. */
const PER_CHECK = 20;

/** The connection (pipe generation) and the profile shown. */
export type Scope = { connection: number; profile: string };

/** What a check needs from the transport. `scope` is undefined while there is no connection. */
export type OtherProfilesPort = {
  scope(): Scope | undefined;
  profiles(): Promise<string[]>;
  unreadIn(profile: string): Promise<{ unread: number; more: boolean; chats: ListedChat[] }>;
  /** The profile's Failed messages, as this computer keeps them; read even when the server can't be. */
  sendsIn(profile: string): SavedSend[];
  publish(others: OtherProfiles): void;
};

export const noOthers: OtherProfiles = { byName: {} };

const sameScope = (a?: Scope, b?: Scope) => !!a && !!b && a.connection === b.connection && a.profile === b.profile;

/** `CheckTimes`, for `useSyncExternalStore`: `get` answers the same object until a time changes. */
export class CheckTimesStore {
  private times: CheckTimes = { byProfile: {} };
  private listeners = new Set<() => void>();

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  get = () => this.times;

  set(patch: Partial<CheckTimes>) {
    this.times = { ...this.times, ...patch };
    for (const fn of this.listeners) fn();
  }
}

export class OtherProfilesCheck {
  private state: OtherProfiles = noOthers;
  private running?: { scope: Scope; done: Promise<void> };
  private last?: { scope: Scope; at: number };

  constructor(
    private port: OtherProfilesPort,
    private times: CheckTimesStore,
  ) {}

  /**
   * Checks the profiles not shown for Unread chats, a few at a time. A call while a check for the same connection and
   * profile is running joins it; one less than `MIN_GAP_MS` after the last start is skipped.
   */
  check(): Promise<void> {
    const scope = this.port.scope();
    if (!scope) return Promise.resolve();
    if (this.running && sameScope(this.running.scope, scope)) return this.running.done;
    if (sameScope(this.last?.scope, scope) && Date.now() - this.last!.at < MIN_GAP_MS) return Promise.resolve();
    this.last = { scope, at: Date.now() };
    const done = this.run(scope).finally(() => this.running?.done === done && (this.running = undefined));
    this.running = { scope, done };
    return done;
  }

  /**
   * The owner switched from `from` to `to`. `to` is shown now, so it leaves these results. `from` gets what its list
   * showed, read at `listedAt`, if it was listed on this connection.
   */
  switched(from: string, to: string, fromList?: { unread: number; listedAt: number; chats: ListedChat[] }, failures: SeenFailure[] = []) {
    const { [to]: _shown, ...byName } = this.state.byName;
    const { [to]: _shownAt, ...byProfile } = this.times.get().byProfile;
    if (fromList) {
      byName[from] = { unread: fromList.unread, more: false, chats: fromList.chats, sends: this.port.sendsIn(from) };
      byProfile[from] = fromList.listedAt;
    }
    // Failures seen there stay until the owner is back in the profile, whatever later checks find.
    if (failures.length) byName[from] = { ...byName[from], failures };
    this.times.set({ byProfile });
    this.publish({ ...this.state, byName });
  }

  private async run(scope: Scope) {
    const current = () => sameScope(this.port.scope(), scope);
    let names: string[];
    try {
      names = await this.port.profiles();
    } catch (e) {
      if (current()) this.publish({ ...this.state, error: `Couldn't list the profiles: ${(e as Error).message}` });
      return;
    }
    if (!current()) return;
    const others = names.filter((n) => n !== scope.profile);
    // Profiles gone from the server leave the results.
    const kept = <T>(all: Record<string, T>) => Object.fromEntries(others.flatMap((n) => (n in all ? [[n, all[n]]] : [])));
    const byProfile = kept(this.times.get().byProfile);
    this.times.set({ others: Date.now(), byProfile });
    this.publish({ byName: kept(this.state.byName), error: undefined });
    const due = [...others].sort((a, b) => (byProfile[a] ?? -Infinity) - (byProfile[b] ?? -Infinity)).slice(0, PER_CHECK);
    await eachAtMost(due, AT_ONCE, async (name) => {
      if (!current()) return;
      let found: OtherProfile;
      let readAt: number | undefined;
      try {
        const failures = this.state.byName[name]?.failures;
        found = { ...(await this.port.unreadIn(name)), sends: this.port.sendsIn(name), ...(failures && { failures }) };
        readAt = Date.now();
      } catch (e) {
        // An earlier answer stays, with the time it was read.
        found = { ...this.state.byName[name], sends: this.port.sendsIn(name), error: (e as Error).message };
      }
      if (!current()) return;
      if (readAt !== undefined) this.times.set({ byProfile: { ...this.times.get().byProfile, [name]: readAt } });
      const was = this.state.byName[name];
      this.publish({ ...this.state, byName: { ...this.state.byName, [name]: was && sameProfile(was, found) ? was : found } });
    });
  }

  /** Tells the transport, unless every profile keeps the same answer and the error is the same. */
  private publish(state: OtherProfiles) {
    if (state.error === this.state.error && sameFields(state.byName, this.state.byName)) return;
    this.state = state;
    this.port.publish(state);
  }
}

/**
 * Totals the other profiles' results for the profile switcher: Unread chats across them, whether there may be more,
 * and the profiles whose latest check failed.
 */
export function totalUnread(others: OtherProfiles): { unread: number; more: boolean; withUnread: string[]; failed: string[] } {
  const entries = Object.entries(others.byName);
  return {
    unread: entries.reduce((n, [, p]) => n + (p.unread ?? 0), 0),
    more: entries.some(([, p]) => p.more),
    withUnread: entries.filter(([, p]) => (p.unread ?? 0) > 0).map(([n]) => n),
    failed: entries.filter(([, p]) => p.error).map(([n]) => n),
  };
}

/** Every field the same, a list of rows compared row by row. */
function sameProfile(a: OtherProfile, b: OtherProfile): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as (keyof OtherProfile)[]);
  return [...keys].every((k) => {
    const x = a[k];
    const y = b[k];
    return x === y || (Array.isArray(x) && Array.isArray(y) && x.length === y.length && x.every((r: object, i) => sameFields(r, y[i])));
  });
}

/** Runs `fn` over `items`, at most `n` at a time. */
async function eachAtMost<T>(items: T[], n: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}
