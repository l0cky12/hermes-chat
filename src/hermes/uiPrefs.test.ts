// @vitest-environment jsdom
// The display preferences: what reads back from the one stored document, how changes merge into it, how older
// documents are brought up to date, who hears of a change, and that clearing the chat cache leaves them alone.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localChatCache } from "./chatCache";
import {
  DEFAULT_UI_PREFS,
  UI_PREFS_KEY,
  UI_PREFS_VERSION,
  chatToReopen,
  forgetOpenChat,
  getUIPrefs,
  migrateUIPrefs,
  rememberOpenChat,
  setUIPrefs,
  subscribe,
  toggleModelFavorite,
  type UIPrefs,
} from "./uiPrefs";

const stored = (): Record<string, unknown> => JSON.parse(localStorage.getItem(UI_PREFS_KEY) ?? "null");
/** Another window of the app writing the document, as the `storage` event reports it. */
function writeFromOtherWindow(value: string | null, key: string | null = UI_PREFS_KEY) {
  if (key === null) localStorage.clear();
  else if (value === null) localStorage.removeItem(key);
  else localStorage.setItem(key, value);
  window.dispatchEvent(new StorageEvent("storage", { key, newValue: value }));
}

const unsubscribers: (() => void)[] = [];
const listen = () => {
  const fn = vi.fn<(p: Readonly<UIPrefs>) => void>();
  unsubscribers.push(subscribe(fn));
  return fn;
};

beforeEach(() => localStorage.clear());
afterEach(() => {
  unsubscribers.splice(0).forEach((u) => u());
  vi.restoreAllMocks();
});

describe("reading", () => {
  it("is the defaults when nothing is stored", () => {
    expect(getUIPrefs()).toEqual({ theme: "system", reopenLastChat: true, checkUpdatesOnLaunch: true, lastOpenChat: {}, reasoningBlocks: true, modelPicker: null, modelPicks: {}, modelFavorites: [], statusBar: ["context", "model", "status"], previewWidth: null, screenshotShortcut: "Ctrl+Shift+S", templates: [], terminalKind: "server", followUp: "queue", idleCompact: { enabled: false, percent: 70, idleMinutes: 15 }, chatSectionsShown: ["pinned", "inbox", "snoozed", "working", "settled"], chatSectionsCollapsed: ["snoozed", "archived", "settled"], agentOffice: "building", officeQuality: "normal", inboxAutoDismissDays: null });
    expect(getUIPrefs()).toEqual(DEFAULT_UI_PREFS);
  });

  it("is the defaults when the document is unreadable or not a document", () => {
    for (const raw of ["{not json", "null", "[1,2]", '"dark"', "42"]) {
      localStorage.setItem(UI_PREFS_KEY, raw);
      expect(getUIPrefs()).toEqual(DEFAULT_UI_PREFS);
    }
  });

  it("takes each valid field and puts each invalid one back at its default", () => {
    localStorage.setItem(
      UI_PREFS_KEY,
      JSON.stringify({
        v: 1,
        theme: "neon",
        reopenLastChat: false,
        checkUpdatesOnLaunch: "yes",
        reasoningBlocks: "no",
        modelPicker: { provider: "anthropic", model: "claude-opus-5-5", effort: "max", fast: true, extra: 1 },
        modelFavorites: ["openai/gpt-5", "no-slash", 7, "openai/gpt-5", "anthropic/claude-opus-5-5"],
        statusBar: ["model", 3, "", "tokens", "model"],
        lastOpenChat: { default: "c1", work: 7, "": "c2", home: "" },
        previewWidth: 12.5,
        terminalKind: "laptop",
        followUp: "interrupt",
        idleCompact: { enabled: "yes", percent: 100, idleMinutes: 30 },
        chatSectionsShown: ["settled", "bogus", "inbox", "settled"],
        chatSectionsCollapsed: "inbox",
        agentOffice: "floor",
        officeQuality: "ultra",
        inboxAutoDismissDays: "7",
      }),
    );
    expect(getUIPrefs()).toEqual({
      theme: "system",
      reopenLastChat: false,
      checkUpdatesOnLaunch: true,
      lastOpenChat: { default: "c1" },
      reasoningBlocks: true,
      modelPicker: { provider: "anthropic", model: "claude-opus-5-5", effort: "max", fast: true },
      modelPicks: {},
      modelFavorites: ["openai/gpt-5", "anthropic/claude-opus-5-5"],
      statusBar: ["model", "tokens"],
      previewWidth: null, screenshotShortcut: "Ctrl+Shift+S", templates: [], terminalKind: "server", followUp: "queue",
      idleCompact: { enabled: false, percent: 70, idleMinutes: 30 },
      // A version 1 list gains Pinned, new in version 2.
      chatSectionsShown: ["pinned", "inbox", "settled"],
      chatSectionsCollapsed: ["snoozed", "archived", "settled"],
      agentOffice: "building",
      officeQuality: "normal",
      inboxAutoDismissDays: null,
    });
  });

  it("keeps message templates, checked, and says when the change couldn't be stored", () => {
    const tpl = { id: "t1", name: "Restart", description: "", body: "Restart {service}" };
    expect(setUIPrefs({ templates: [tpl, { ...tpl, id: "t2" }] })).toBe(true);
    expect(stored().templates).toEqual([tpl]);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    expect(setUIPrefs({ templates: [] })).toBe(false);
    // Held until the app closes, but not stored.
    expect(getUIPrefs().templates).toEqual([]);
    expect(stored().templates).toEqual([tpl]);
    // Saving the same thing again, once storage takes it, is really written, not taken as already kept.
    vi.restoreAllMocks();
    expect(setUIPrefs({ templates: [] })).toBe(true);
    expect(stored().templates).toEqual([]);
  });

  it("keeps which computer the Terminal was on last, the Hermes server's until one is picked", () => {
    expect(getUIPrefs().terminalKind).toBe("server");
    setUIPrefs({ terminalKind: "local" });
    expect(stored().terminalKind).toBe("local");
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ v: 1, terminalKind: "local" }));
    expect(getUIPrefs().terminalKind).toBe("local");
    // Something this version doesn't know isn't a pick: the server's again.
    for (const bad of ["laptop", 1, null]) {
      localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ v: 1, terminalKind: bad }));
      expect(getUIPrefs().terminalKind).toBe("server");
    }
  });

  it("keeps Idle compaction, off until turned on, each field checked on its own", () => {
    expect(getUIPrefs().idleCompact).toEqual({ enabled: false, percent: 70, idleMinutes: 15 });
    setUIPrefs({ idleCompact: { enabled: true, percent: 80, idleMinutes: 30 } });
    expect(stored().idleCompact).toEqual({ enabled: true, percent: 80, idleMinutes: 30 });
    // A value no window could mean leaves the old one.
    setUIPrefs({ idleCompact: { enabled: true, percent: 4, idleMinutes: 2.5 } });
    expect(getUIPrefs().idleCompact).toEqual({ enabled: true, percent: 80, idleMinutes: 30 });
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ v: 1, idleCompact: "on" }));
    expect(getUIPrefs().idleCompact).toEqual({ enabled: false, percent: 70, idleMinutes: 15 });
  });

  it("keeps what sending does while a reply runs, queueing until steering is picked", () => {
    expect(getUIPrefs().followUp).toBe("queue");
    setUIPrefs({ followUp: "steer" });
    expect(stored().followUp).toBe("steer");
    // Hermes's own `interrupt` mode isn't one this app offers: it is read as the default.
    for (const bad of ["interrupt", true, null]) {
      localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ v: 1, followUp: bad }));
      expect(getUIPrefs().followUp).toBe("queue");
    }
  });

  it("keeps how long finished inbox entries stay, never dismissing them until a time is picked", () => {
    expect(getUIPrefs().inboxAutoDismissDays).toBeNull();
    setUIPrefs({ inboxAutoDismissDays: 7 });
    expect(stored().inboxAutoDismissDays).toBe(7);
    // A time that isn't a time leaves the old one.
    setUIPrefs({ inboxAutoDismissDays: -1 });
    expect(getUIPrefs().inboxAutoDismissDays).toBe(7);
    setUIPrefs({ inboxAutoDismissDays: null });
    expect(stored().inboxAutoDismissDays).toBeNull();
    // A newer app or a hand edit may store a time Settings doesn't offer: it is kept.
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ v: 2, inboxAutoDismissDays: 3 }));
    expect(getUIPrefs().inboxAutoDismissDays).toBe(3);
    for (const bad of [0, -2, "7", true, [7]]) {
      localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ v: 2, inboxAutoDismissDays: bad }));
      expect(getUIPrefs().inboxAutoDismissDays).toBeNull();
    }
  });

  it("keeps the preview pane's width, and drops one no window could have", () => {
    setUIPrefs({ previewWidth: 520 });
    expect(getUIPrefs().previewWidth).toBe(520);
    expect(stored().previewWidth).toBe(520);
    for (const bad of [-5, 50, 9000, 420.5]) {
      localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ v: 1, previewWidth: bad }));
      expect(getUIPrefs().previewWidth).toBeNull();
    }
  });

  it("keeps the profile a model was picked in, and drops an effort Hermes doesn't take", () => {
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ v: 1, modelPicker: { provider: "openai", model: "gpt-5", effort: "hgih", profile: "work" } }));
    expect(getUIPrefs().modelPicker).toEqual({ provider: "openai", model: "gpt-5", profile: "work" });
  });

  it("keeps picks for same-named profiles on two connections through reloads", () => {
    const a = "aaaaaaaa-aaaa-4000-8000-aaaaaaaaaaaa\ndefault";
    const b = "bbbbbbbb-bbbb-4000-8000-bbbbbbbbbbbb\ndefault";
    setUIPrefs({ modelPicker: { profile: a, provider: "anthropic", model: "a", effort: "high" } });
    setUIPrefs({ modelPicker: { profile: b, provider: "openai", model: "b" } });
    expect(getUIPrefs().modelPicks).toEqual({ [a]: { provider: "anthropic", model: "a", effort: "high" }, [b]: { provider: "openai", model: "b" } });
    writeFromOtherWindow(JSON.stringify(stored()));
    expect(getUIPrefs().modelPicks[a].model).toBe("a");
    expect(getUIPrefs().modelPicks[b].model).toBe("b");
  });

  it("stars and unstars a model without picking it", () => {
    setUIPrefs({ modelPicker: { provider: "anthropic", model: "claude-sonnet-5-5" } });
    toggleModelFavorite("openai/gpt-5");
    toggleModelFavorite("anthropic/claude-opus-5-5");
    expect(getUIPrefs().modelFavorites).toEqual(["openai/gpt-5", "anthropic/claude-opus-5-5"]);
    toggleModelFavorite("openai/gpt-5");
    expect(getUIPrefs()).toMatchObject({ modelFavorites: ["anthropic/claude-opus-5-5"], modelPicker: { model: "claude-sonnet-5-5" } });
    expect(stored().modelFavorites).toEqual(["anthropic/claude-opus-5-5"]);
  });

  it("drops a model pick without a provider and model", () => {
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ v: 1, modelPicker: { model: "x" } }));
    expect(getUIPrefs().modelPicker).toBeNull();
  });

  it("returns the same object until the document changes", () => {
    const first = getUIPrefs();
    expect(getUIPrefs()).toBe(first);
    setUIPrefs({ theme: "dark" });
    expect(getUIPrefs()).not.toBe(first);
    expect(getUIPrefs()).toBe(getUIPrefs());
  });
});

describe("writing", () => {
  it("keeps everything in one versioned document under one key", () => {
    setUIPrefs({ theme: "light" });
    expect(Object.keys(localStorage)).toEqual([UI_PREFS_KEY]);
    expect(stored()).toEqual({ ...DEFAULT_UI_PREFS, theme: "light", v: UI_PREFS_VERSION });
  });

  it("merges a patch, leaving fields not given, or given as undefined, as they were", () => {
    setUIPrefs({ theme: "dark", reopenLastChat: false });
    setUIPrefs({ reasoningBlocks: false, theme: undefined });
    expect(getUIPrefs()).toEqual({ ...DEFAULT_UI_PREFS, theme: "dark", reopenLastChat: false, reasoningBlocks: false });
  });

  it("replaces the status bar and model pick whole, and forgets the pick on null", () => {
    setUIPrefs({ statusBar: ["model", "tokens"], modelPicker: { provider: "openai", model: "o5", effort: "high" } });
    setUIPrefs({ statusBar: ["cost"], modelPicker: { provider: "anthropic", model: "claude-sonnet-5-5" } });
    expect(getUIPrefs().statusBar).toEqual(["cost"]);
    expect(getUIPrefs().modelPicker).toEqual({ provider: "anthropic", model: "claude-sonnet-5-5" });
    setUIPrefs({ modelPicker: null });
    expect(getUIPrefs().modelPicker).toBeNull();
    expect(stored().modelPicker).toBeNull();
  });

  it("doesn't share arrays with the caller", () => {
    const items = ["model"];
    setUIPrefs({ statusBar: items });
    items.push("tokens");
    expect(getUIPrefs().statusBar).toEqual(["model"]);
  });

  it("leaves a field as it was when given a value that isn't valid", () => {
    setUIPrefs({ theme: "dark" });
    setUIPrefs({ theme: "neon" as UIPrefs["theme"] });
    expect(getUIPrefs().theme).toBe("dark");
  });

  it("keeps fields a newer version of the app wrote", () => {
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ v: UI_PREFS_VERSION, theme: "dark", density: "compact" }));
    setUIPrefs({ reasoningBlocks: false });
    expect(stored()).toMatchObject({ v: UI_PREFS_VERSION, theme: "dark", density: "compact", reasoningBlocks: false });
  });

  it("holds a change until the app closes when storage won't take it", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    const heard = listen();
    expect(() => setUIPrefs({ theme: "dark" })).not.toThrow();
    expect(getUIPrefs().theme).toBe("dark");
    expect(heard).toHaveBeenCalledOnce();
  });
});

describe("migration", () => {
  it("reads a document written without a version as version 1, and stamps the version on the next write", () => {
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ theme: "light", reopenLastChat: false }));
    expect(getUIPrefs()).toMatchObject({ theme: "light", reopenLastChat: false });
    setUIPrefs({ reasoningBlocks: false });
    expect(stored()).toEqual({ ...DEFAULT_UI_PREFS, theme: "light", reopenLastChat: false, reasoningBlocks: false, v: UI_PREFS_VERSION });
  });

  it("runs each step from the stored version up to the current one, in order", () => {
    const steps = {
      0: (d: Record<string, unknown>) => ({ ...d, steps: ["0→1"] }),
      1: (d: Record<string, unknown>) => ({ ...d, theme: d.darkMode ? "dark" : "light", darkMode: undefined, steps: [...(d.steps as string[]), "1→2"] }),
      2: (d: Record<string, unknown>) => ({ ...d, steps: [...(d.steps as string[]), "2→3"] }),
    };
    expect(migrateUIPrefs({ darkMode: true }, steps, 3)).toEqual({ theme: "dark", darkMode: undefined, steps: ["0→1", "1→2", "2→3"], v: 3 });
    expect(migrateUIPrefs({ v: 2, theme: "light", steps: [] }, steps, 3)).toEqual({ theme: "light", steps: ["2→3"], v: 3 });
    expect(migrateUIPrefs({ v: 3, theme: "light" }, steps, 3)).toEqual({ theme: "light", v: 3 });
  });

  it("starts over from the defaults when a version has no way forward or isn't a version", () => {
    expect(migrateUIPrefs({ v: 1, theme: "dark" }, {}, 2)).toEqual({ v: 2 });
    expect(migrateUIPrefs({ v: "1", theme: "dark" })).toEqual({ v: UI_PREFS_VERSION });
    expect(migrateUIPrefs({ v: 1.5, theme: "dark" })).toEqual({ v: UI_PREFS_VERSION });
  });

  it("shows the building, new in version 3, to whoever picked the Desks or the Scene", () => {
    for (const [saved, read] of [["desks", "building"], ["scene", "building"], ["list", "list"], ["off", "off"]]) {
      localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ v: 2, agentOffice: saved }));
      expect(getUIPrefs().agentOffice).toBe(read);
    }
  });

  it("keeps the office's quality, and reads one it doesn't know as Normal", () => {
    for (const [saved, read] of [["low", "low"], ["normal", "normal"], ["ultra", "normal"], [3, "normal"]]) {
      localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ v: UI_PREFS_VERSION, officeQuality: saved }));
      expect(getUIPrefs().officeQuality).toBe(read);
    }
  });

  it("shows Pinned, new in version 2, above the sections a version 1 document picked", () => {
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ v: 1, chatSectionsShown: ["settled", "inbox"], chatSectionsCollapsed: ["inbox"] }));
    expect(getUIPrefs().chatSectionsShown).toEqual(["pinned", "inbox", "settled"]);
    expect(getUIPrefs().chatSectionsCollapsed).toEqual(["inbox"]);
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ v: 1, theme: "dark" }));
    expect(getUIPrefs().chatSectionsShown).toEqual(DEFAULT_UI_PREFS.chatSectionsShown);
  });

  it("reads a newer version's document as it is, taking the fields this version knows", () => {
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ v: UI_PREFS_VERSION + 1, theme: "dark", density: "compact" }));
    expect(getUIPrefs().theme).toBe("dark");
  });
});

describe("subscribe", () => {
  it("fires with the new prefs on a change in this window", () => {
    const heard = listen();
    setUIPrefs({ theme: "dark" });
    expect(heard).toHaveBeenCalledOnce();
    expect(heard).toHaveBeenLastCalledWith(expect.objectContaining({ theme: "dark" }));
    expect(heard.mock.calls[0][0]).toBe(getUIPrefs());
  });

  it("doesn't fire when a patch changes nothing", () => {
    setUIPrefs({ theme: "dark" });
    const heard = listen();
    setUIPrefs({ theme: "dark" });
    setUIPrefs({});
    expect(heard).not.toHaveBeenCalled();
  });

  it("fires when another window changes the document", () => {
    const heard = listen();
    writeFromOtherWindow(JSON.stringify({ v: 1, theme: "light", reasoningBlocks: false }));
    expect(heard).toHaveBeenCalledOnce();
    expect(heard).toHaveBeenLastCalledWith(expect.objectContaining({ theme: "light", reasoningBlocks: false }));
    expect(getUIPrefs().theme).toBe("light");
  });

  it("fires when another window removes the document or clears localStorage, with the defaults", () => {
    setUIPrefs({ theme: "dark" });
    const heard = listen();
    writeFromOtherWindow(null);
    expect(heard).toHaveBeenLastCalledWith(DEFAULT_UI_PREFS);
    setUIPrefs({ theme: "dark" });
    heard.mockClear();
    writeFromOtherWindow(null, null);
    expect(heard).toHaveBeenCalledOnce();
    expect(getUIPrefs()).toEqual(DEFAULT_UI_PREFS);
  });

  it("ignores other keys and writes that change nothing", () => {
    setUIPrefs({ theme: "dark" });
    const heard = listen();
    writeFromOtherWindow("[]", "hermes-chat.chats.x");
    writeFromOtherWindow(localStorage.getItem(UI_PREFS_KEY));
    writeFromOtherWindow(JSON.stringify({ ...stored(), unknown: 1 }));
    expect(heard).not.toHaveBeenCalled();
  });

  it("stops firing once unsubscribed, in this window and from others", () => {
    const heard = vi.fn();
    const stop = subscribe(heard);
    const other = listen();
    stop();
    stop();
    setUIPrefs({ theme: "dark" });
    writeFromOtherWindow(JSON.stringify({ v: 1, theme: "light" }));
    expect(heard).not.toHaveBeenCalled();
    expect(other).toHaveBeenCalledTimes(2);
  });
});

describe("Clear local cache", () => {
  it("deletes the chat lists and Saved copies and keeps the display preferences", () => {
    setUIPrefs({ theme: "dark", statusBar: ["model"], modelPicker: { provider: "anthropic", model: "claude-opus-5-5" } });
    const prefsBefore = localStorage.getItem(UI_PREFS_KEY);
    const cache = localChatCache({ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" });
    cache.save("default", []);
    cache.saveTranscript("default", "a", [{ kind: "user", id: "1", text: "hi" }]);
    expect(cache.bytes()).toBeGreaterThan(0);

    cache.clear();
    expect(cache.bytes()).toBe(0);
    expect(cache.loadTranscript("default", "a")).toBeUndefined();
    expect(localStorage.getItem(UI_PREFS_KEY)).toBe(prefsBefore);
    expect(getUIPrefs()).toMatchObject({ theme: "dark", statusBar: ["model"] });
    // The prefs never count toward the cache's size either.
    setUIPrefs({ theme: "light" });
    expect(cache.bytes()).toBe(0);
  });
});

describe("the last open chat", () => {
  it("is kept for each profile apart", () => {
    rememberOpenChat("default", "c1");
    rememberOpenChat("work", "w1");
    rememberOpenChat("default", "c2");
    expect(stored().lastOpenChat).toEqual({ default: "c2", work: "w1" });
    expect(chatToReopen("default")).toBe("c2");
    expect(chatToReopen("work")).toBe("w1");
    expect(chatToReopen("home")).toBeUndefined();
  });

  it("is dropped for a profile on the New chat pane, and the others stay", () => {
    rememberOpenChat("default", "c1");
    rememberOpenChat("work", "w1");
    rememberOpenChat("default", null);
    expect(stored().lastOpenChat).toEqual({ work: "w1" });
  });

  it("is forgotten only while it is still the chat named", () => {
    rememberOpenChat("default", "c1");
    forgetOpenChat("default", "c0");
    expect(chatToReopen("default")).toBe("c1");
    forgetOpenChat("default", "c1");
    expect(chatToReopen("default")).toBeUndefined();
  });

  it("isn't reopened with the setting off, and is still kept", () => {
    setUIPrefs({ reopenLastChat: false });
    rememberOpenChat("default", "c1");
    expect(chatToReopen("default")).toBeUndefined();
    setUIPrefs({ reopenLastChat: true });
    expect(chatToReopen("default")).toBe("c1");
  });

  it("writes nothing when the chat is already the one kept", () => {
    rememberOpenChat("default", "c1");
    const fn = listen();
    rememberOpenChat("default", "c1");
    rememberOpenChat("work", null);
    expect(fn).not.toHaveBeenCalled();
  });
  it("keeps a screenshot shortcut in its stored shape, or none", () => {
    for (const ok of ["Alt+F12", "Ctrl+Alt+Shift+Super+9", "PrintScreen", "Super+PrintScreen"]) {
      setUIPrefs({ screenshotShortcut: ok });
      expect(getUIPrefs().screenshotShortcut).toBe(ok);
    }
    setUIPrefs({ screenshotShortcut: null });
    expect(getUIPrefs().screenshotShortcut).toBeNull();
    // Out of order, unknown keys and lowercase letters aren't stored shapes; the last good value stays.
    for (const bad of ["Shift+Ctrl+S", "Ctrl+s", "Ctrl+Tab", "Ctrl+", "F25", 7]) {
      setUIPrefs({ screenshotShortcut: bad as string });
      expect(getUIPrefs().screenshotShortcut).toBeNull();
    }
  });

});
