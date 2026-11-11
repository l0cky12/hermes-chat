// What this computer keeps for Settings → Persona, in localStorage per connection and profile:
// - the unsaved edit, with the SOUL.md it started from, so closing the app, signing out or a crash doesn't lose it;
// - the versions of SOUL.md that saves from this app replaced, newest first, so a change can be undone.
// Nothing here is shown as saved: only Hermes, read back, says that (persona.ts).
import { type ScopeSource, connectionScope } from "./connections";
import type { Soul } from "./persona";

export const PERSONA_PREFIX = "hermes-chat.persona.";
const PREFIX = PERSONA_PREFIX;
/** How many replaced versions are kept per connection and profile. */
export const EARLIER_KEPT = 5;

export type PersonaStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** An edit not saved to Hermes. `base`: the SOUL.md it started from, which a Save checks Hermes still has. */
export type PersonaDraft = { text: string; base: Soul; at: number };
/** A SOUL.md a save from this app replaced, and when. */
export type EarlierSoul = Soul & { replacedAt: number };

/** Where a connection and profile's persona edits are kept. */
export function personaKey(connection: ScopeSource, profile: string): string {
  return PREFIX + connectionScope(connection, profile);
}

const isSoul = (s: unknown): s is Soul =>
  !!s && typeof (s as Soul).exists === "boolean" && typeof (s as Soul).content === "string";

export class PersonaStore {
  /** Kept in memory too, so a storage that is full or can't be written still keeps them until the app closes. */
  private memory = new Map<string, string | null>();
  /** Keys whose latest value storage refused: they last only until the app closes. */
  private notStored = new Set<string>();

  constructor(private storage: PersonaStorage) {}

  private read<T>(key: string, valid: (v: unknown) => v is T): T | undefined {
    let raw = this.memory.get(key);
    if (raw === undefined) {
      try {
        raw = this.storage.getItem(key);
      } catch {
        raw = null;
      }
      this.memory.set(key, raw);
    }
    if (!raw) return undefined;
    try {
      const v: unknown = JSON.parse(raw);
      return valid(v) ? v : undefined;
    } catch {
      return undefined;
    }
  }

  /** Whether storage took it; either way it is kept in memory until the app closes. */
  private write(key: string, value: unknown): boolean {
    const raw = value === undefined ? null : JSON.stringify(value);
    this.memory.set(key, raw);
    try {
      if (raw === null) this.storage.removeItem(key);
      else this.storage.setItem(key, raw);
      this.notStored.delete(key);
      return true;
    } catch {
      this.notStored.add(key);
      return false;
    }
  }

  draft(key: string): PersonaDraft | undefined {
    return this.read(`${key}.draft`, (v): v is PersonaDraft => {
      const d = v as PersonaDraft;
      return !!d && typeof d.text === "string" && typeof d.at === "number" && isSoul(d.base);
    });
  }

  /** Keeps the edit; undefined deletes it. False: storage didn't take it, so it would be lost on closing the app. */
  setDraft(key: string, draft: PersonaDraft | undefined): boolean {
    return this.write(`${key}.draft`, draft);
  }

  /** Whether the edit kept for `key` is in storage, so it outlives the app closing. True when there is none. */
  draftStored(key: string): boolean {
    return !this.notStored.has(`${key}.draft`);
  }

  /** Saves under way, by connection and profile, kept here so a reopened editor waits for one started before. */
  private saves = new Map<string, Promise<unknown>>();

  /** Waits for this connection's saves, then releases its persisted and failed-write copies. */
  async forget(owns: (key: string) => boolean): Promise<void> {
    await Promise.all([...this.saves].filter(([key]) => owns(key)).map(([, done]) => done));
    for (const key of this.memory.keys()) {
      if (!owns(key)) continue;
      this.storage.removeItem(key);
      this.memory.delete(key);
      this.notStored.delete(key);
    }
  }

  /**
   * Waits for the saves of the keys `move` moves, then moves each kept copy where it says (null: drops it), in storage
   * and memory: a profile renamed or deleted (profileLocalData.ts). Keys only in storage are the caller's to move.
   * Each new copy is written before the old one goes; one storage refuses stays where it was, and the move throws
   * once the rest are done.
   */
  async move(move: (key: string) => string | null | undefined): Promise<void> {
    await Promise.all([...this.saves].filter(([key]) => move(key) !== undefined).map(([, done]) => done));
    let failed = 0;
    for (const [key, raw] of [...this.memory]) {
      const to = move(key);
      if (to === undefined) continue;
      // A copy only memory held (storage refused it before) stays only in memory under its new key.
      const onlyInMemory = this.notStored.has(key);
      if (to !== null && raw !== null && !onlyInMemory)
        try {
          this.storage.setItem(to, raw);
        } catch {
          failed++;
          continue;
        }
      this.storage.removeItem(key);
      this.memory.delete(key);
      this.notStored.delete(key);
      if (to === null) continue;
      this.memory.set(to, raw);
      if (onlyInMemory) this.notStored.add(to);
    }
    if (failed) throw new Error(`${failed} persona ${failed === 1 ? "copy" : "copies"} couldn't be moved.`);
  }

  /** Notes a save of `key` under way until `done` settles. */
  trackSave(key: string, done: Promise<unknown>) {
    const settled = done.then(
      () => {},
      () => {},
    );
    this.saves.set(key, settled);
    void settled.then(() => {
      if (this.saves.get(key) === settled) this.saves.delete(key);
    });
  }

  /** A save of `key` still under way, which settles (never rejects) when it is done; undefined when there is none. */
  saveUnderWay(key: string): Promise<unknown> | undefined {
    return this.saves.get(key);
  }

  earlier(key: string): EarlierSoul[] {
    return (
      this.read(`${key}.earlier`, (v): v is EarlierSoul[] =>
        Array.isArray(v) && v.every((e) => isSoul(e) && typeof (e as EarlierSoul).replacedAt === "number"),
      ) ?? []
    );
  }

  /** Keeps `soul` as the version a save just replaced. The same text twice in a row is kept once. */
  addEarlier(key: string, soul: Soul, replacedAt: number): EarlierSoul[] {
    const list = this.earlier(key);
    const same = list[0] && list[0].exists === soul.exists && list[0].content === soul.content;
    const next = same ? list : [{ ...soul, replacedAt }, ...list].slice(0, EARLIER_KEPT);
    this.write(`${key}.earlier`, next);
    return next;
  }
}
