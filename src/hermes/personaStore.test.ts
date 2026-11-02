// What this computer keeps for Settings → Persona: one unsaved edit and the replaced versions, per connection and
// profile, surviving a storage that can't be written.
import { describe, expect, it } from "vitest";
import { EARLIER_KEPT, PersonaStore, personaKey } from "./personaStore";

function memoryStorage(failWrites = false) {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (failWrites) throw new Error("QuotaExceededError");
      items.set(k, v);
    },
    removeItem: (k: string) => void items.delete(k),
  };
}

const ssh = { mode: "ssh" as const, sshTarget: "liam@hermes", url: "", username: "liam" };
const url = { mode: "url" as const, sshTarget: "", url: "http://hermes:9119", username: "liam" };

describe("PersonaStore", () => {
  it("keeps each connection and profile's edit apart, across a restart", () => {
    const storage = memoryStorage();
    const store = new PersonaStore(storage);
    const base = { exists: true, content: "# Base\n" };
    store.setDraft(personaKey(ssh, "default"), { text: "# A\n", base, at: 1 });
    store.setDraft(personaKey(ssh, "work"), { text: "# B\n", base, at: 2 });
    const again = new PersonaStore(storage);
    expect(again.draft(personaKey(ssh, "default"))?.text).toBe("# A\n");
    expect(again.draft(personaKey(ssh, "work"))?.text).toBe("# B\n");
    expect(again.draft(personaKey(url, "default"))).toBeUndefined();
    again.setDraft(personaKey(ssh, "default"), undefined);
    expect(new PersonaStore(storage).draft(personaKey(ssh, "default"))).toBeUndefined();
  });

  it("keeps the newest replaced versions, once each", () => {
    const store = new PersonaStore(memoryStorage());
    const key = personaKey(ssh, "default");
    store.addEarlier(key, { exists: false, content: "" }, 1);
    for (let i = 0; i < EARLIER_KEPT + 2; i++) store.addEarlier(key, { exists: true, content: `v${i}` }, 10 + i);
    store.addEarlier(key, { exists: true, content: `v${EARLIER_KEPT + 1}` }, 99);
    const kept = store.earlier(key);
    expect(kept).toHaveLength(EARLIER_KEPT);
    expect(kept[0]).toEqual({ exists: true, content: `v${EARLIER_KEPT + 1}`, replacedAt: 10 + EARLIER_KEPT + 1 });
  });

  it("ignores what it can't read, and keeps edits in memory when storage is full", () => {
    const storage = memoryStorage();
    storage.items.set(`${personaKey(ssh, "default")}.draft`, "{not json");
    storage.items.set(`${personaKey(ssh, "default")}.earlier`, JSON.stringify([{ content: 1 }]));
    expect(new PersonaStore(storage).draft(personaKey(ssh, "default"))).toBeUndefined();
    expect(new PersonaStore(storage).earlier(personaKey(ssh, "default"))).toEqual([]);

    const full = new PersonaStore(memoryStorage(true));
    full.setDraft("k", { text: "# Kept\n", base: { exists: false, content: "" }, at: 1 });
    expect(full.draft("k")?.text).toBe("# Kept\n");
  });
});
