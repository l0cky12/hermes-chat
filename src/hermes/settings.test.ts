import { afterEach, describe, expect, it, vi } from "vitest";
import { type Account, type Keyring, savedSignIn, signIn, signOut } from "./account";
import { localChatCache } from "./chatCache";
import { FakeHermes, row } from "./fakeHermes";
import { memoryCache } from "./memoryCache";
import type { SignInDetails } from "./tauriPipe";
import { connect } from "./transport";

const details: SignInDetails = { mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam", password: "hunter2" };

function memoryKeyring(password?: string): Keyring & { password?: string; broken?: string } {
  const k: Keyring & { password?: string; broken?: string } = {
    password,
    load: async () => (k.broken ? Promise.reject(new Error(k.broken)) : k.password),
    save: async (p) => (k.broken ? Promise.reject(new Error(k.broken)) : void (k.password = p)),
    delete: async () => (k.broken ? Promise.reject(new Error(k.broken)) : void (k.password = undefined)),
  };
  return k;
}

/** An account against a fake dashboard whose password is `hunter2`. */
function account(keyring = memoryKeyring()) {
  const server = new FakeHermes();
  let saved: Omit<SignInDetails, "password"> = { mode: "ssh", sshTarget: "", url: "", username: "" };
  const a: Account = {
    keyring,
    store: { load: () => saved, save: (d) => void (saved = d) },
    connect: async (d) => {
      if (d.password !== "hunter2") throw new Error("Wrong username or password.");
      return connect(server.openPipe, "default");
    },
  };
  return { server, keyring, account: a, saved: () => saved };
}

describe("Saved password", () => {
  it("is saved in the system keyring once Hermes has signed in, and the rest of the sign-in beside it", async () => {
    const { account: a, keyring, saved } = account();
    await signIn(details, a);
    expect(keyring.password).toBe("hunter2");
    expect(saved()).toEqual({ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" });
  });

  it("isn't saved when the sign-in fails", async () => {
    const { account: a, keyring } = account();
    await expect(signIn({ ...details, password: "wrong" }, a)).rejects.toThrow("Wrong username or password.");
    expect(keyring.password).toBeUndefined();
  });

  it("signs in at the next launch without asking", async () => {
    const first = account();
    await signIn(details, first.account);
    const { account: a, server } = account(first.keyring);
    a.store = first.account.store;
    const saved = await savedSignIn(a);
    expect(saved).toEqual(details);
    expect((await a.connect(saved!)).getSnapshot().status).toBe("connected");
    expect(server.opened).toBe(1);
  });

  it("asks at launch when no password is saved, or the keyring can't be read", async () => {
    expect(await savedSignIn(account().account)).toBeUndefined();
    const broken = memoryKeyring("hunter2");
    broken.broken = "no Secret Service running";
    expect(await savedSignIn(account(broken).account)).toBeUndefined();
  });

  it("still signs in when the keyring can't save, and says the password wasn't kept", async () => {
    const keyring = memoryKeyring();
    keyring.broken = "no Secret Service running";
    const { account: a } = account(keyring);
    const { hermes, notSaved } = await signIn(details, a);
    expect(hermes.getSnapshot().status).toBe("connected");
    expect(notSaved).toBe("Couldn't save the password in the system keyring: no Secret Service running");
  });
});

describe("Sign out", () => {
  it("closes the connection and deletes the saved password from the keyring", async () => {
    const { account: a, keyring, server, saved } = account();
    const { hermes } = await signIn(details, a);
    await signOut(hermes, a);
    expect(server.closed).toBe(true);
    expect(keyring.password).toBeUndefined();
    // The next sign-in screen still has everything but the password.
    expect(saved().username).toBe("liam");
    expect(await savedSignIn(a)).toBeUndefined();
  });

  it("deletes the password even when closing the connection fails", async () => {
    const { account: a, keyring } = account();
    const { hermes } = await signIn(details, a);
    hermes.close = () => Promise.reject(new Error("the Rust side is gone"));
    await signOut(hermes, a);
    expect(keyring.password).toBeUndefined();
  });

  it("signs out even when the keyring can't delete the password, and says so", async () => {
    const { account: a, keyring, server } = account();
    const { hermes } = await signIn(details, a);
    keyring.broken = "the keyring is locked";
    await expect(signOut(hermes, a)).rejects.toThrow(
      "Signed out, but couldn't delete the saved password from the system keyring: the keyring is locked",
    );
    expect(server.closed).toBe(true);
  });
});

describe("Clear local cache", () => {
  it("shows the storage the saved chat lists use, and clears it without touching the server", async () => {
    const server = new FakeHermes();
    server.sessions = [row("a", 1), row("b", 2, { pinned: true })];
    const cache = memoryCache();
    const hermes = await connect(server.openPipe, "default", cache);
    await hermes.sync();
    expect(hermes.cacheBytes()).toBeGreaterThan(0);

    const sent = [server.requests.length, server.restRequests.length];
    hermes.clearCache();
    expect(hermes.cacheBytes()).toBe(0);
    expect(cache.saved).toEqual({});
    expect([server.requests.length, server.restRequests.length]).toEqual(sent);
    expect(server.sessions.map((s) => s.id)).toEqual(["a", "b"]);
    // The list on screen stays; it comes from the server.
    expect(
      hermes
        .getSnapshot()
        .chats.map((c) => c.id)
        .sort(),
    ).toEqual(["a", "b"]);
  });

  describe("in localStorage", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("counts and deletes only the chat lists, keeping the sign-in and the profile shown last", () => {
      const store = new Map<string, string>([
        ["hermes-chat.sign-in", '{"username":"liam"}'],
        ["hermes-chat.profile", "work"],
        ["hermes-chat.chats.default", "[]"],
        ["hermes-chat.chats.work", '[{"id":"w"}]'],
        ["other-app", "x"],
      ]);
      vi.stubGlobal("localStorage", {
        get length() {
          return store.size;
        },
        key: (i: number) => [...store.keys()][i] ?? null,
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      });
      // localStorage keeps text as UTF-16: two bytes a character, key and value.
      const listBytes = 2 * ("hermes-chat.chats.default[]".length + 'hermes-chat.chats.work[{"id":"w"}]'.length);
      expect(localChatCache.bytes()).toBe(listBytes);
      localChatCache.clear();
      expect(localChatCache.bytes()).toBe(0);
      expect([...store.keys()]).toEqual(["hermes-chat.sign-in", "hermes-chat.profile", "other-app"]);
    });
  });
});

describe("Pull older history", () => {
  async function withOlderChats() {
    const server = new FakeHermes();
    const old = Array.from({ length: 150 }, (_, i) => row(`o${i}`, 31 + i, { source: i % 2 ? "telegram" : "hermes-chat" }));
    server.sessions = [row("recent", 1, { pinned: true }), row("recent-loose", 2), ...old, row("old-gone", 60, { archived: true })];
    const cache = memoryCache();
    const hermes = await connect(server.openPipe, "default", cache);
    await hermes.sync();
    return { server, hermes, cache, old };
  }
  const ids = (hermes: { getSnapshot(): { chats: { id: string }[] } }) =>
    hermes
      .getSnapshot()
      .chats.map((c) => c.id)
      .sort();

  it("pulls the profile's chats older than a month into Settled, and says which", async () => {
    const { hermes, old } = await withOlderChats();
    expect(hermes.getSnapshot().olderPulled).toBe(false);
    expect((await hermes.pullOlderHistory()).map((c) => c.id).sort()).toEqual(old.map((r) => r.id).sort());
    expect(ids(hermes)).toEqual(["recent", "recent-loose", ...old.map((r) => r.id)].sort());
    const chats = hermes.getSnapshot().chats;
    expect(chats.filter((c) => c.id.startsWith("o")).every((c) => c.settled)).toBe(true);
    expect(chats.find((c) => c.id === "recent")?.settled).toBe(false);
    expect(hermes.getSnapshot().olderPulled).toBe(true);
  });

  it("leaves an older chat pinned in another Hermes client Active", async () => {
    const { server, hermes } = await withOlderChats();
    server.sessions.push(row("old-pin", 90, { pinned: true }));
    const added = await hermes.pullOlderHistory();
    expect(added.find((c) => c.id === "old-pin")?.settled).toBe(false);
    expect(server.sessions.find((s) => s.id === "old-pin")?.pinned).toBe(true);
  });

  it("says so when the owner switches profile before the older chats arrive, and leaves both profiles a month long", async () => {
    const { server, hermes, cache } = await withOlderChats();
    server.otherProfiles.work = [row("w-new", 1), row("w-old", 45)];
    const pulling = hermes.pullOlderHistory();
    const switching = hermes.switchProfile("work");
    await expect(pulling).rejects.toThrow("Switched to the work profile before the older chats arrived.");
    await switching;
    await hermes.idle();
    expect(cache.olderPulled("default")).toBe(false);
    expect(ids(hermes)).toEqual(["w-new"]);
  });

  it("only reads from the server: nothing is pinned or marked read", async () => {
    const { server, hermes } = await withOlderChats();
    const before = server.restRequests.length;
    await hermes.pullOlderHistory();
    expect(server.restRequests.slice(before).every((r) => r.method === "GET")).toBe(true);
  });

  it("keeps the older chats through later refreshes and the next launch", async () => {
    const { server, hermes, cache } = await withOlderChats();
    await hermes.pullOlderHistory();
    await hermes.sync();
    expect(ids(hermes)).toHaveLength(152);
    const again = await connect(server.openPipe, "default", cache);
    await again.sync();
    expect(again.getSnapshot().olderPulled).toBe(true);
    expect(ids(again)).toHaveLength(152);
  });

  it("is kept per profile", async () => {
    const { server, hermes } = await withOlderChats();
    server.otherProfiles.work = [row("w-new", 1), row("w-old", 45)];
    await hermes.pullOlderHistory();
    await hermes.switchProfile("work");
    await hermes.idle();
    expect(hermes.getSnapshot().olderPulled).toBe(false);
    expect(ids(hermes)).toEqual(["w-new"]);
  });

  it("reports a failure and leaves the list a month long", async () => {
    const { server, hermes, cache } = await withOlderChats();
    server.rest["GET /api/sessions"] = () => {
      throw new Error("The dashboard answered 503: store busy");
    };
    await expect(hermes.pullOlderHistory()).rejects.toThrow("The dashboard answered 503: store busy");
    expect(hermes.getSnapshot().olderPulled).toBe(false);
    expect(cache.olderPulled("default")).toBe(false);
    expect(ids(hermes)).toEqual(["recent", "recent-loose"]);
  });
});
