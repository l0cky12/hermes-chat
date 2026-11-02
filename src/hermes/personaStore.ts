// What this computer keeps for Settings → Persona, in localStorage per connection and profile:
// - the unsaved edit, with the SOUL.md it started from, so closing the app, signing out or a crash doesn't lose it;
// - the versions of SOUL.md that saves from this app replaced, newest first, so a change can be undone.
// Nothing here is shown as saved: only Hermes, read back, says that (persona.ts).
import type { SavedSignIn } from "./account";
import type { Soul } from "./persona";

const PREFIX = "hermes-chat.persona.";
/** How many replaced versions are kept per connection and profile. */
export const EARLIER_KEPT = 5;

export type PersonaStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** An edit not saved to Hermes. `base`: the SOUL.md it started from, which a Save checks Hermes still has. */
export type PersonaDraft = { text: string; base: Soul; at: number };
/** A SOUL.md a save from this app replaced, and when. */
export type EarlierSoul = Soul & { replacedAt: number };

/** Where a connection and profile's persona edits are kept. */
export function personaKey(connection: SavedSignIn, profile: string): string {
  const target = connection.mode === "ssh" ? connection.sshTarget : connection.url;
  return PREFIX + JSON.stringify([connection.mode, target, connection.username, profile]);
}

const isSoul = (s: unknown): s is Soul =>
  !!s && typeof (s as Soul).exists === "boolean" && typeof (s as Soul).content === "string";

export class PersonaStore {
  /** Kept in memory too, so a storage that is full or can't be written still keeps them until the app closes. */
  private memory = new Map<string, string | null>();

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

  private write(key: string, value: unknown) {
    const raw = value === undefined ? null : JSON.stringify(value);
    this.memory.set(key, raw);
    try {
      if (raw === null) this.storage.removeItem(key);
      else this.storage.setItem(key, raw);
    } catch {
      // Only a restart loses it.
    }
  }

  draft(key: string): PersonaDraft | undefined {
    return this.read(`${key}.draft`, (v): v is PersonaDraft => {
      const d = v as PersonaDraft;
      return !!d && typeof d.text === "string" && typeof d.at === "number" && isSoul(d.base);
    });
  }

  /** Keeps the edit; undefined deletes it. */
  setDraft(key: string, draft: PersonaDraft | undefined) {
    this.write(`${key}.draft`, draft);
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
