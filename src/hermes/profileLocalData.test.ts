// @vitest-environment jsdom
// A profile's rename moves everything this computer keeps for it, its delete forgets it, and removing a connection
// forgets every profile's, all through one list (profileLocalData.ts, ADR 0144). The first test reads the app's source
// for every storage key it names, so a new one can't be left out of that list. All data is synthetic.
import { afterEach, describe, expect, it } from "vitest";
import { moveLiveChatData } from "./chatCache";
import { connectionScope, prefScope, type ScopeSource } from "./connections";
import { forgetConnectionData } from "./forgetConnection";
import { drafts, draftKey } from "./drafts";
import { inboxAcks, inboxScope, type InboxEntry } from "./inbox";
import { PersonaStore, personaKey } from "./personaStore";
import {
  CONNECTION_KEYS,
  LocalMoveError,
  NOT_PER_PROFILE,
  PROFILE_KEYS,
  SCOPED_DOCS,
  clearRename,
  forgetProfileLocally,
  noteRename,
  renameProfileLocally,
  renamePending,
} from "./profileLocalData";
import { storageDefaultsFile, defaultsDoc } from "./projectDefaults";
import { getUIPrefs, setUIPrefs } from "./uiPrefs";
import { sending, unsaved } from "./unsaved";

afterEach(() => {
  localStorage.clear();
  unsaved.clear();
  sending.clear();
});

/** Every storage key a source file names: a string that starts as the app's keys do. */
export function storageKeysIn(source: string): string[] {
  return [...source.matchAll(/["'`](hermes-(?:chat\.[A-Za-z0-9._-]*|ui-prefs))/g)].map((m) => m[1]);
}

/** The app's own source, tests and fakes left out. */
const SOURCES = Object.entries(import.meta.glob<string>(["/src/**/*.{ts,tsx}", "!/src/**/*.test.{ts,tsx}", "!/src/**/fake*.ts"], { query: "?raw", import: "default", eager: true }));

const LISTED = new Set([...PROFILE_KEYS.map((k) => k.prefix), ...CONNECTION_KEYS.map((k) => k.prefix), ...SCOPED_DOCS, ...Object.keys(NOT_PER_PROFILE)]);
const unlisted = (keys: string[]) => [...new Set(keys)].filter((k) => !LISTED.has(k)).sort();

describe("the list of what this computer keeps per profile", () => {
  it("names every storage key the app's source uses, or says why it holds nothing of one profile", () => {
    const found = SOURCES.flatMap(([, text]) => storageKeysIn(text));
    expect(found.length).toBeGreaterThan(20);
    expect(unlisted(found)).toEqual([]);
  });

  it("would catch a new key left out", () => {
    expect(unlisted(storageKeysIn(`export const STARS_PREFIX = "hermes-chat.stars.";\nconst x = "hermes-chat.drafts-v2";`))).toEqual(["hermes-chat.drafts-v2", "hermes-chat.stars."]);
  });
});

const home: ScopeSource = { id: "c1", mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" };
const other: ScopeSource = { id: "c2", mode: "ssh", sshTarget: "liam@other", url: "", username: "liam" };
const key = (prefix: string, c: ScopeSource, ...rest: string[]) => prefix + connectionScope(c, ...rest);
const doc = (scopes: Record<string, unknown>) => JSON.stringify({ v: 1, scopes });

/** One of each shape this computer keeps, for profile `p` of connection `c`. */
function seed(c: ScopeSource, p: string) {
  const s = (...rest: string[]) => connectionScope(c, p, ...rest);
  localStorage.setItem(key("hermes-chat.chats.", c, p), "[]");
  localStorage.setItem(key("hermes-chat.transcript.", c, p, "chat-1"), "{}");
  localStorage.setItem(key("hermes-chat.outbox.", c, p, "chat-1"), "[]");
  localStorage.setItem(key("hermes-chat.queue.", c, p, "chat-1"), `{"items":[{"id":"q1","text":"later"}]}`);
  localStorage.setItem(key("hermes-chat.undelivered.", c, p, "chat-1"), "[]");
  localStorage.setItem(key("hermes-chat.branches.", c, p), "{}");
  localStorage.setItem(key("hermes-chat.draft.", c, p, "chat-1"), "half a thought");
  localStorage.setItem(`${key("hermes-chat.persona.", c, p)}.draft`, `{"text":"x"}`);
  localStorage.setItem(`${key("hermes-chat.persona.", c, p)}.earlier`, "[]");
  for (const d of SCOPED_DOCS) {
    const before = JSON.parse(localStorage.getItem(d) ?? `{"v":1,"scopes":{}}`);
    localStorage.setItem(d, JSON.stringify({ ...before, scopes: { ...before.scopes, [s()]: { [`${d}-${p}`]: true } } }));
  }
}

const keysNow = () => Object.keys(localStorage).sort();

describe("renaming a profile on this computer", () => {
  it("moves every kind of data from the old name to the new one, and leaves another connection's same-named profile alone", async () => {
    seed(home, "work");
    seed(other, "work");
    seed(home, "research");
    localStorage.setItem(key("hermes-chat.profile.", home), "work");
    localStorage.setItem(key("hermes-chat.older-pulled.", home), `["work","research"]`);
    localStorage.setItem(key("hermes-chat.inbox-dismissed.", home), JSON.stringify({ "completed work chat-1": [1, 2], "resumed waiting work chat-1": [1, 2], "completed research chat-2": [1, 2] }));
    setUIPrefs({
      lastOpenChat: { [prefScope(home, "work")]: "chat-1", [prefScope(other, "work")]: "chat-9" },
      modelPicks: { [prefScope(home, "work")]: { provider: "openai", model: "gpt-6.1" } },
      templates: [{ id: "t1", name: "Plan", description: "", body: "x", project: { scope: connectionScope(home, "work"), id: "p1", name: "P" } }],
    } as never);
    const tags = storageDefaultsFile(() => localStorage, "hermes-chat.tags");
    await tags.swap(null, doc({ [connectionScope(home, "work")]: { tags: [] }, [connectionScope(other, "work")]: { tags: [] } }));
    const defaultsFile = storageDefaultsFile(() => localStorage, "hermes-chat.project-defaults");
    await defaultsFile.swap(null, doc({ [connectionScope(home, "work")]: { p1: { rev: 1 } } }));

    const before = keysNow();
    await renameProfileLocally(home, "work", "coder", { tags, defaults: defaultsDoc(defaultsFile) });

    // Every per-profile key of home/work is now home/coder's; nothing else moved.
    const moved = before.map((k) => k.replace(connectionScope(home, "work").slice(0, -1), connectionScope(home, "coder").slice(0, -1))).sort();
    expect(keysNow()).toEqual(moved);
    expect(localStorage.getItem(key("hermes-chat.draft.", home, "coder", "chat-1"))).toBe("half a thought");
    expect(localStorage.getItem(key("hermes-chat.draft.", other, "work", "chat-1"))).toBe("half a thought");
    for (const d of SCOPED_DOCS) {
      const scopes = JSON.parse(localStorage.getItem(d)!).scopes;
      expect(Object.keys(scopes).sort()).toEqual([connectionScope(home, "coder"), connectionScope(home, "research"), connectionScope(other, "work")].sort());
      expect(scopes[connectionScope(home, "coder")]).toEqual({ [`${d}-work`]: true });
    }
    expect(localStorage.getItem(key("hermes-chat.profile.", home))).toBe("coder");
    expect(JSON.parse(localStorage.getItem(key("hermes-chat.older-pulled.", home))!)).toEqual(["coder", "research"]);
    expect(Object.keys(JSON.parse(localStorage.getItem(key("hermes-chat.inbox-dismissed.", home))!))).toEqual(["completed coder chat-1", "resumed waiting coder chat-1", "completed research chat-2"]);
    const prefs = getUIPrefs();
    expect(prefs.lastOpenChat).toEqual({ [prefScope(home, "coder")]: "chat-1", [prefScope(other, "work")]: "chat-9" });
    expect(Object.keys(prefs.modelPicks)).toEqual([prefScope(home, "coder")]);
    expect(prefs.templates[0].project?.scope).toBe(connectionScope(home, "coder"));
    expect(Object.keys(JSON.parse((await tags.read())!).scopes).sort()).toEqual([connectionScope(home, "coder"), connectionScope(other, "work")].sort());
    expect(Object.keys(JSON.parse((await defaultsFile.read())!).scopes)).toEqual([connectionScope(home, "coder")]);
  });

  it("moves what is only in memory too: persona edits, unsaved drafts, messages on their way, and failed-write queues", async () => {
    const persona = new PersonaStore(localStorage);
    persona.setDraft(personaKey(home, "work"), { text: "Be terse.", base: { content: "", exists: false }, at: 1 });
    const draftKey = key("hermes-chat.draft.", home, "work", "chat-1");
    unsaved.set(draftKey, "not stored");
    const item = { key: key("hermes-chat.draft.", home, "work", "null"), text: "on its way" };
    sending.add(item);
    await renameProfileLocally(home, "work", "coder", { persona });
    expect(persona.draft(personaKey(home, "coder"))?.text).toBe("Be terse.");
    expect(persona.draft(personaKey(home, "work"))).toBeUndefined();
    expect([...unsaved.keys()]).toEqual([key("hermes-chat.draft.", home, "coder", "chat-1")]);
    expect(item.key).toBe(key("hermes-chat.draft.", home, "coder", "null"));
    // The live copies are moved by the same key rule.
    moveLiveChatData(() => undefined);
  });

  it("keeps the old copy when the new one can't be written, and says how many didn't move", async () => {
    const kept = key("hermes-chat.draft.", home, "work", "chat-1");
    localStorage.setItem(kept, "half a thought");
    const refusing = {
      get length() {
        return localStorage.length;
      },
      key: (i: number) => localStorage.key(i),
      getItem: (k: string) => localStorage.getItem(k),
      removeItem: (k: string) => localStorage.removeItem(k),
      setItem: (k: string, v: string) => {
        if (k.includes('"coder"')) throw new DOMException("full", "QuotaExceededError");
        localStorage.setItem(k, v);
      },
    };
    await expect(renameProfileLocally(home, "work", "coder", { storage: refusing })).rejects.toBeInstanceOf(LocalMoveError);
    expect(localStorage.getItem(kept)).toBe("half a thought");
  });

  it("keeps a persona edit under the old name when its new copy can't be written, so reopening still has it", async () => {
    // A full storage refuses every new copy, for the persona store and the walk alike.
    const refusing = {
      get length() {
        return localStorage.length;
      },
      key: (i: number) => localStorage.key(i),
      getItem: (k: string) => localStorage.getItem(k),
      removeItem: (k: string) => localStorage.removeItem(k),
      setItem: (k: string, v: string) => {
        if (k.includes('"coder"')) throw new DOMException("full", "QuotaExceededError");
        localStorage.setItem(k, v);
      },
    };
    const persona = new PersonaStore(refusing);
    persona.setDraft(personaKey(home, "work"), { text: "Be terse.", base: { content: "", exists: false }, at: 1 });
    await expect(renameProfileLocally(home, "work", "coder", { persona, storage: refusing })).rejects.toBeInstanceOf(LocalMoveError);
    expect(new PersonaStore(localStorage).draft(personaKey(home, "work"))?.text).toBe("Be terse.");
  });

  it("moves the Drafts held in memory with their undo history, and forgets them with the profile", async () => {
    const store = drafts(localStorage);
    const from = draftKey(home, "work", "chat-1");
    const to = draftKey(home, "coder", "chat-1");
    store.set(from, "first");
    store.set(from, "second");
    await renameProfileLocally(home, "work", "coder", { drafts: store });
    expect(store.get(to)).toBe("second");
    expect(store.get(from)).toBe("");
    expect(store.undo(to)).toBe("first");
    await forgetProfileLocally(home, "coder", { drafts: store });
    expect(store.get(to)).toBe("");
  });

  it("lets the inbox read its dismissals again under the new name", async () => {
    const acks = inboxAcks(localStorage, inboxScope(home));
    const entry = (profile: string): InboxEntry => ({ key: `completed ${profile} chat-1`, kind: "completed", profile, chatId: "chat-1", title: "t", at: 5, summary: "" }) as InboxEntry;
    acks.dismiss(entry("work"));
    await renameProfileLocally(home, "work", "coder");
    acks.reload();
    expect(acks.isDismissed(entry("coder"))).toBe(true);
    // A later dismissal no longer writes the old name back.
    acks.dismiss({ ...entry("research"), key: "completed research chat-2", chatId: "chat-2" } as InboxEntry);
    expect(Object.keys(JSON.parse(localStorage.getItem(key("hermes-chat.inbox-dismissed.", home))!)).sort()).toEqual(["completed coder chat-1", "completed research chat-2"]);
  });

  it("notes a rename sent to Hermes until this computer's data has moved", () => {
    noteRename(home, "work", "coder");
    expect(renamePending(home)).toEqual({ from: "work", to: "coder" });
    expect(renamePending(other)).toBeUndefined();
    clearRename(home);
    expect(renamePending(home)).toBeUndefined();
  });
});

describe("forgetting a deleted profile on this computer", () => {
  it("removes that profile's data only, leaving the connection's other profiles and another connection's same-named one", async () => {
    seed(home, "work");
    seed(home, "research");
    seed(other, "work");
    localStorage.setItem(key("hermes-chat.older-pulled.", home), `["work","research"]`);
    setUIPrefs({ lastOpenChat: { [prefScope(home, "work")]: "chat-1", [prefScope(home, "research")]: "chat-2" } } as never);
    await forgetProfileLocally(home, "work");
    expect(keysNow().filter((k) => k.includes(connectionScope(home, "work").slice(0, -1)))).toEqual([]);
    expect(localStorage.getItem(key("hermes-chat.draft.", home, "research", "chat-1"))).toBe("half a thought");
    expect(localStorage.getItem(key("hermes-chat.draft.", other, "work", "chat-1"))).toBe("half a thought");
    for (const d of SCOPED_DOCS) expect(Object.keys(JSON.parse(localStorage.getItem(d)!).scopes).sort()).toEqual([connectionScope(home, "research"), connectionScope(other, "work")].sort());
    expect(JSON.parse(localStorage.getItem(key("hermes-chat.older-pulled.", home))!)).toEqual(["research"]);
    expect(getUIPrefs().lastOpenChat).toEqual({ [prefScope(home, "research")]: "chat-2" });
  });

  it("is the same list removing a connection walks, which now forgets pins, clears and stop-waiting too", async () => {
    seed(home, "work");
    seed(other, "work");
    localStorage.setItem(key("hermes-chat.profile.", home), "work");
    noteRename(home, "work", "coder");
    await forgetConnectionData(home as never);
    expect(keysNow().filter((k) => k.includes(JSON.stringify(["connection", "c1"]).slice(0, -1)))).toEqual([]);
    for (const d of SCOPED_DOCS) expect(Object.keys(JSON.parse(localStorage.getItem(d)!).scopes)).toEqual([connectionScope(other, "work")]);
    expect(renamePending(home)).toBeUndefined();
  });
});
