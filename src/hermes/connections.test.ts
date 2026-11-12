// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONNECTIONS_KEY, Connections, LEGACY_SIGN_IN_KEY, LIVE_LIMIT_DEFAULT, LIVE_LIMIT_MAX, addressKey, connectionScope, defaultName, inScope, prefScope, scopeParts } from "./connections";
import { draftKey, drafts } from "./drafts";
import { forgetConnectionData } from "./forgetConnection";
import { inboxScope } from "./inbox";
import { PersonaStore, personaKey } from "./personaStore";
import { defaultsDoc, storageDefaultsFile } from "./projectDefaults";
import { PROJECTS_KEY, projectScope } from "./projectLinks";
import { OUTPUTS_KEY } from "./outputs";
import { unsaved, sending, restartHold } from "./unsaved";
import { snapshotDrafts } from "./updates";
import { localChatCache, outboxAttachmentPaths } from "./chatCache";
import { TERMINAL_TARGET_KEY, terminalTargetKey } from "./terminal";
import { getUIPrefs, setUIPrefs } from "./uiPrefs";
import { IMPORTS_KEY } from "./importTranscripts";
import { SNOOZE_KEY } from "./snooze";
import { TAGS_KEY } from "./tags";
import { WORKTREE_CHATS_KEY } from "./worktrees";

const legacy = { mode: "ssh" as const, sshTarget: "liam@hermes", url: "", username: "liam" };
let ids = 0;
const nextId = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`;
const store = (now = () => 1000) => new Connections(localStorage, now, nextId);

beforeEach(() => {
  localStorage.clear();
  ids = 0;
});
afterEach(() => { localStorage.clear(); unsaved.clear(); sending.clear(); restartHold.on = false; vi.restoreAllMocks(); });

describe("Migrating the single saved sign-in", () => {
  it("becomes one connection in use, with a stable id, the first time the list is read", () => {
    localStorage.setItem(LEGACY_SIGN_IN_KEY, JSON.stringify(legacy));
    const first = store();
    const [c] = first.recent();
    expect(first.recent()).toHaveLength(1);
    expect(c).toMatchObject({ ...legacy, name: "hermes", legacy: { scope: ["ssh", "liam@hermes", "liam"], address: addressKey(legacy) } });
    expect(first.current()?.id).toBe(c.id);
    // Read again (the next launch), it is the same connection: the id was kept, not made anew.
    expect(store().current()?.id).toBe(c.id);
    expect(JSON.parse(localStorage.getItem(CONNECTIONS_KEY)!).v).toBe(1);
  });

  it("keeps every key its data was already kept under, so nothing has to move", () => {
    localStorage.setItem(LEGACY_SIGN_IN_KEY, JSON.stringify(legacy));
    // What the app kept before saved connections had ids.
    const before = drafts(localStorage);
    before.set(draftKey(legacy, "default", "chat-1"), "half-written");
    const c = store().current()!;
    expect(draftKey(c, "default", "chat-1")).toBe(draftKey(legacy, "default", "chat-1"));
    expect(drafts(localStorage).get(draftKey(c, "default", "chat-1"))).toBe("half-written");
    expect(projectScope(c, "default")).toBe(projectScope(legacy, "default"));
    expect(personaKey(c, "default")).toBe(personaKey(legacy, "default"));
    expect(inboxScope(c)).toBe(inboxScope(legacy));
    expect(prefScope(c, "default")).toBe("default");
    expect(terminalTargetKey(c)).toBe(TERMINAL_TARGET_KEY);
  });

  it("keeps those keys after its address is edited", () => {
    localStorage.setItem(LEGACY_SIGN_IN_KEY, JSON.stringify(legacy));
    const s = store();
    const c = s.current()!;
    s.save({ ...c, sshTarget: "liam@hermes.tail.ts.net" });
    expect(draftKey(s.get(c.id)!, "default", null)).toBe(draftKey(legacy, "default", null));
  });

  it("leaves a computer with nothing set up with no connection, so setup opens", () => {
    localStorage.setItem(LEGACY_SIGN_IN_KEY, JSON.stringify({ mode: "ssh", sshTarget: " ", url: "", username: "" }));
    expect(store().recent()).toEqual([]);
    expect(store().current()).toBeUndefined();
  });

  it("starts again from the old sign-in when the list can't be read", () => {
    localStorage.setItem(LEGACY_SIGN_IN_KEY, JSON.stringify(legacy));
    localStorage.setItem(CONNECTIONS_KEY, "{not json");
    expect(store().recent().map((c) => c.sshTarget)).toEqual(["liam@hermes"]);
  });
});

describe("Saved connections", () => {
  const at = (url: string) => ({ mode: "url" as const, sshTarget: "", url, username: "owner" });

  it("are listed most recently used first, then the newest added", () => {
    let now = 0;
    const s = store(() => now);
    const a = s.draft(at("https://a.example.com"), "A");
    now = 1;
    const b = s.draft(at("https://b.example.com"), "B");
    now = 2;
    const c = s.draft(at("https://c.example.com"), "C");
    s.save(a);
    s.save(b);
    s.save(c);
    expect(s.recent().map((x) => x.name)).toEqual(["C", "B", "A"]);
    now = 10;
    s.use(a.id);
    expect(s.recent().map((x) => x.name)).toEqual(["A", "C", "B"]);
    expect(s.current()?.id).toBe(a.id);
  });

  it("are told apart by id, so two can share a name", () => {
    const s = store();
    const one = s.draft(at("https://a.example.com"), "Home");
    const two = s.draft(at("https://b.example.com"), "Home");
    s.save(one);
    s.save(two);
    s.rename(two.id, "Home");
    expect(s.recent().map((c) => [c.id, c.name])).toEqual(expect.arrayContaining([
      [two.id, "Home"],
      [one.id, "Home"],
    ]));
  });

  it("name themselves after their host when the owner gives no name", () => {
    expect(defaultName(at("https://hermes.example.com:9119/"))).toBe("hermes.example.com:9119");
    expect(defaultName(legacy)).toBe("hermes");
    expect(store().draft(at("http://hermes:9119"), "   ").name).toBe("hermes:9119");
  });

  it("leave none in use when the one in use is removed: nothing is picked by name or otherwise", () => {
    const s = store();
    const one = s.draft(at("https://a.example.com"), "Home");
    const two = s.draft(at("https://b.example.com"), "Home");
    s.save(one);
    s.save(two);
    s.use(two.id);
    s.remove(two.id);
    expect(s.current()).toBeUndefined();
    expect(store().current()).toBeUndefined();
    expect(s.recent().map((c) => c.id)).toEqual([one.id]);
  });

  it("drop entries that aren't connections, and ids that could name another keyring entry", () => {
    localStorage.setItem(
      CONNECTIONS_KEY,
      JSON.stringify({
        v: 1,
        current: "../dashboard-password",
        connections: [
          { id: "../dashboard-password", name: "x", mode: "url", url: "https://x" },
          { id: "00000000-0000-4000-8000-000000000009", name: "ok", mode: "url", url: "https://ok", username: "o", addedAt: 1 },
          { id: "00000000-0000-4000-8000-000000000009", name: "duplicate", mode: "url", url: "https://dup" },
          { id: "00000000-0000-4000-8000-000000000010", name: "no mode" },
          null,
        ],
      }),
    );
    const s = store();
    expect(s.recent().map((c) => c.name)).toEqual(["ok"]);
    expect(s.current()).toBeUndefined();
  });

  it("keep data apart for same-named profiles on different servers", () => {
    const s = store();
    const one = s.draft(at("https://a.example.com"), "Home");
    const two = s.draft(at("https://b.example.com"), "Home");
    const d = drafts(localStorage);
    d.set(draftKey(one, "default", null), "for alpha");
    d.set(draftKey(two, "default", null), "for bravo");
    expect(d.get(draftKey(one, "default", null))).toBe("for alpha");
    expect(d.get(draftKey(two, "default", null))).toBe("for bravo");
    expect(projectScope(one, "default")).not.toBe(projectScope(two, "default"));
    expect(prefScope(one, "default")).not.toBe(prefScope(two, "default"));
    expect(terminalTargetKey(one)).not.toBe(terminalTargetKey(two));
    expect(scopeParts(one)).toEqual(["connection", one.id]);
  });

  it("keep a change in memory when storage refuses it, and say so", () => {
    const broken = new Connections(
      {
        getItem: () => null,
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
        removeItem: () => {},
      },
      () => 1,
      nextId,
    );
    broken.save(broken.draft(at("https://a.example.com"), "A"));
    expect(broken.unsaved).toBe(true);
    expect(broken.recent()).toHaveLength(1);
  });
});

describe("Live connections (ADR 0125)", () => {
  const two = () => {
    const s = store();
    const a = s.draft({ ...legacy, sshTarget: "liam@alpha" }, "Alpha");
    const b = s.draft({ ...legacy, sshTarget: "liam@bravo" }, "Bravo");
    s.save(a);
    s.save(b);
    return { s, a, b };
  };

  it("keep which are live, the target first, and leave out ones no longer saved", () => {
    const { s, a, b } = two();
    expect(s.live()).toEqual([]);
    s.use(b.id);
    s.setLive([b.id, a.id, "00000000-0000-4000-8000-999999999999", b.id]);
    expect(s.live().map((c) => c.id)).toEqual([b.id, a.id]);
    expect(new Connections(localStorage).live().map((c) => c.id)).toEqual([b.id, a.id]);
    // Using one keeps the live set; removing one drops it from there too.
    s.use(a.id);
    expect(s.live().map((c) => c.id)).toEqual([b.id, a.id]);
    s.remove(b.id);
    expect(s.live().map((c) => c.id)).toEqual([a.id]);
  });

  it("allow three live by default, from 1 to 8, and ignore a limit edited by hand outside that", () => {
    const { s } = two();
    expect(s.liveLimit()).toBe(LIVE_LIMIT_DEFAULT);
    s.setLiveLimit(1);
    expect(new Connections(localStorage).liveLimit()).toBe(1);
    s.setLiveLimit(LIVE_LIMIT_MAX + 1);
    s.setLiveLimit(0);
    s.setLiveLimit(2.5);
    expect(s.liveLimit()).toBe(1);
    const doc = JSON.parse(localStorage.getItem(CONNECTIONS_KEY)!);
    localStorage.setItem(CONNECTIONS_KEY, JSON.stringify({ ...doc, liveLimit: 40, live: "everything" }));
    const read = new Connections(localStorage);
    expect([read.liveLimit(), read.live()]).toEqual([LIVE_LIMIT_DEFAULT, []]);
  });
});

describe("Removing a connection's local data", () => {
  it("deletes only its own keys and scopes, even for a profile of the same name on another connection", async () => {
    const s = store();
    const one = s.draft({ mode: "url", sshTarget: "", url: "https://a.example.com", username: "owner" }, "Home");
    const two = s.draft({ mode: "url", sshTarget: "", url: "https://b.example.com", username: "owner" }, "Home");
    s.save(one);
    s.save(two);
    const persona = new PersonaStore(localStorage);
    for (const c of [one, two]) {
      drafts(localStorage).set(draftKey(c, "default", null), `draft ${c.id}`);
      const cache = localChatCache(c);
      cache.save("default", [{ id: "x", title: "Same chat id", source: "app", settled: false, updatedAt: 1, items: [] }]);
      cache.rememberProfile("default");
      cache.saveQueue("default", "x", { items: [{ id: "q1", text: `queued for ${c.id}` }] });
      persona.setDraft(personaKey(c, "default"), { text: `private ${c.id}`, base: { exists: true, content: "base" }, at: 1 });
      persona.addEarlier(personaKey(c, "default"), { exists: true, content: `earlier ${c.id}` }, 1);
      localStorage.setItem(`hermes-chat.inbox-dismissed.${inboxScope(c)}`, "{}");
      localStorage.setItem(terminalTargetKey(c), `me@${c.id}`);
    }
    localStorage.setItem(PROJECTS_KEY, JSON.stringify({ v: 1, scopes: { [projectScope(one, "default")]: { chats: {} }, [projectScope(two, "default")]: { chats: {} } } }));
    localStorage.setItem(OUTPUTS_KEY, JSON.stringify({ v: 2, scopes: { [projectScope(one, "default")]: {}, [projectScope(two, "default")]: {} } }));
    setUIPrefs({ lastOpenChat: { [prefScope(one, "default")]: "c1", [prefScope(two, "default")]: "c2" }, modelPicker: { provider: "p", model: "m", profile: prefScope(one, "default") } });
    const defaults = defaultsDoc(storageDefaultsFile(() => localStorage));
    await defaults.save(projectScope(one, "default"), "p1", 0, { instructions: "one" });
    await defaults.save(projectScope(two, "default"), "p1", 0, { instructions: "two" });

    await forgetConnectionData(one, { defaults, persona });

    const left = Object.keys(localStorage).filter((k) => k !== CONNECTIONS_KEY && k !== "hermes-ui-prefs");
    expect(left.some((k) => k.includes(one.id))).toBe(false);
    expect(left.filter((k) => k.includes(two.id)).length).toBeGreaterThanOrEqual(5);
    expect(drafts(localStorage).get(draftKey(two, "default", null))).toBe(`draft ${two.id}`);
    expect(localChatCache(two).lastProfile()).toBe("default");
    expect(localChatCache(two).loadQueues("default").x.items[0].text).toBe(`queued for ${two.id}`);
    expect(localChatCache(one).loadQueues("default")).toEqual({});
    expect(localChatCache(one).lastProfile()).toBeUndefined();
    expect(Object.keys(JSON.parse(localStorage.getItem(PROJECTS_KEY)!).scopes)).toEqual([projectScope(two, "default")]);
    expect(Object.keys(JSON.parse(localStorage.getItem(OUTPUTS_KEY)!).scopes)).toEqual([projectScope(two, "default")]);
    expect(getUIPrefs().lastOpenChat).toEqual({ [prefScope(two, "default")]: "c2" });
    expect(getUIPrefs().modelPicker).toBeNull();
    expect(persona.draft(personaKey(one, "default"))).toBeUndefined();
    expect(persona.earlier(personaKey(one, "default"))).toEqual([]);
    expect(persona.draft(personaKey(two, "default"))?.text).toBe(`private ${two.id}`);
    expect(await defaults.read(projectScope(one, "default"))).toEqual({});
    expect(await defaults.read(projectScope(two, "default"))).toMatchObject({ p1: { instructions: "two" } });
  });

  it("also deletes its tags, snoozes, branch origins, imports record and worktree chats, and no other connection's", async () => {
    const s = store();
    const one = s.draft({ mode: "url", sshTarget: "", url: "https://a.example.com", username: "owner" }, "Home");
    const two = s.draft({ mode: "url", sshTarget: "", url: "https://b.example.com", username: "owner" }, "Home");
    s.save(one);
    s.save(two);
    const both = (v: unknown) => ({ [projectScope(one, "default")]: v, [projectScope(two, "default")]: v });
    for (const key of [SNOOZE_KEY, IMPORTS_KEY, WORKTREE_CHATS_KEY]) localStorage.setItem(key, JSON.stringify({ v: 1, scopes: both({ c: 1 }) }));
    const tagsFile = storageDefaultsFile(() => localStorage, TAGS_KEY);
    localStorage.setItem(TAGS_KEY, JSON.stringify({ v: 1, kept: "a newer app's field", scopes: both({ tags: [], chats: {}, filters: [] }) }));
    for (const c of [one, two]) localChatCache(c).saveBranches("default", { links: { b: { parent: "p", title: "t" } }, attempts: [] } as never);

    await forgetConnectionData(one, { tags: tagsFile });

    for (const key of [SNOOZE_KEY, IMPORTS_KEY, WORKTREE_CHATS_KEY, TAGS_KEY])
      expect(Object.keys(JSON.parse(localStorage.getItem(key)!).scopes)).toEqual([projectScope(two, "default")]);
    expect(JSON.parse(localStorage.getItem(TAGS_KEY)!).kept).toBe("a newer app's field");
    const branchKeys = Object.keys(localStorage).filter((k) => k.startsWith("hermes-chat.branches."));
    expect(branchKeys.some((k) => k.includes(one.id))).toBe(false);
    expect(branchKeys.some((k) => k.includes(two.id))).toBe(true);
  });

  it("forgets failed writes, screenshots and unopened legacy Failed messages before a restart", async () => {
    localStorage.setItem(LEGACY_SIGN_IN_KEY, JSON.stringify(legacy));
    const one = store().current()!;
    const other = store().draft({ ...legacy, sshTarget: "liam@other" });
    const held = "hermes-chat.undelivered." + connectionScope(one, "unopened", "chat-1");
    localStorage.setItem(held, "private failed text");
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("full"); });
    const cache = localChatCache(one);
    cache.saveQueue("default", "chat-1", { items: [{ id: "q", text: "private queued text", attachments: [{ path: "/tmp/removed-shot.png", name: "shot.png", size: 12, kind: "image" }] }] });
    const pending = { key: draftKey(one, "default", null), text: "sending for removed" };
    sending.add(pending);
    unsaved.set(draftKey(other, "default", null), "keep the other server");
    set.mockRestore();
    expect(outboxAttachmentPaths()).toContain("/tmp/removed-shot.png");
    await forgetConnectionData(one, { afterwards: async () => { expect(outboxAttachmentPaths()).not.toContain("/tmp/removed-shot.png"); } });
    expect(localStorage.getItem(held)).toBeNull();
    const saved = snapshotDrafts(localStorage);
    expect(saved).not.toContain("private");
    expect(saved).not.toContain("sending for removed");
    expect(saved).toContain("keep the other server");
  });

  it("matches a scope by its leading parts only", () => {
    expect(inScope(["connection", "x"], connectionScope({ mode: "ssh", sshTarget: "", url: "", username: "", id: "x" }, "default", "chat"))).toBe(true);
    expect(inScope(["connection", "x"], JSON.stringify(["connection", "xy", "default"]))).toBe(false);
    expect(inScope(["ssh", "liam@hermes", "liam"], JSON.stringify(["ssh", "liam@hermes", "liam2"]))).toBe(false);
    expect(inScope(["a"], "not json")).toBe(false);
  });
});
