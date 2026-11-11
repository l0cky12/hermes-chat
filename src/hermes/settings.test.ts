import { afterEach, describe, expect, it, vi } from "vitest";
import { type Account, type Keyring, removeConnection, savedSignIn, signIn, signInForm, signOut, signOutToSignIn } from "./account";
import { localChatCache } from "./chatCache";
import { type SavedConnection, Connections, addressKey, addressOf } from "./connections";
import { FakeHermes, row } from "./fakeHermes";
import { memoryCache } from "./memoryCache";
import type { SignInDetails } from "./tauriPipe";
import { connect, readSaved } from "./transport";
import { RestError } from "./pipe";

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

/** A Storage kept in memory. */
export function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
  };
}

/** What the keyring keeps for a password saved for `d`'s address. */
const entry = (d: SignInDetails, password = d.password) => JSON.stringify({ v: 1, for: addressKey(d), password });

/** An account against a fake dashboard whose password is `hunter2`, with one connection `c` not saved yet. */
function account(keyring = memoryKeyring(), headerKeyring = memoryKeyring()) {
  const server = new FakeHermes();
  const connections = new Connections(memoryStorage());
  const sent: SignInDetails[] = [];
  const a: Account = {
    connections,
    secrets: () => ({ password: keyring, headers: headerKeyring, token: { saved: async () => undefined, keep: async () => {}, delete: async () => {} } }),
    connect: async (_c, d) => {
      sent.push(d);
      if (d.password !== "hunter2") throw new Error("Wrong username or password.");
      return connect(server.openPipe, "default");
    },
    readSaved: (_c, _d, reason) => readSaved(server.openPipe, reason, memoryCache()),
    openSaved: () => undefined,
  };
  const c = connections.draft(details);
  return { server, keyring, headerKeyring, account: a, c, sent, saved: () => connections.get(c.id)! };
}

describe("Saved password", () => {
  it("is saved in the system keyring once Hermes has signed in, with the address it is for, and the rest of the sign-in beside it", async () => {
    const { account: a, c, keyring, saved } = account();
    await signIn(c, details, a);
    expect(JSON.parse(keyring.password!)).toEqual({ v: 1, for: addressKey(details), password: "hunter2" });
    expect(addressOf(saved())).toEqual({ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" });
    expect(a.connections.current()?.id).toBe(c.id);
  });

  it("isn't saved when the sign-in fails, and nor is a new connection", async () => {
    const { account: a, c, keyring } = account();
    await expect(signIn(c, { ...details, password: "wrong" }, a)).rejects.toThrow("Wrong username or password.");
    expect(keyring.password).toBeUndefined();
    expect(a.connections.recent()).toEqual([]);
  });

  it("signs in at the next launch without asking", async () => {
    const first = account();
    await signIn(first.c, details, first.account);
    const saved = await savedSignIn(first.saved(), first.account);
    expect(saved).toEqual({ ...details, headers: [] });
    expect((await first.account.connect(first.saved(), saved!)).getSnapshot().status).toBe("connected");
    expect(first.server.opened).toBe(2);
  });

  it("asks at launch when no password is saved, or the keyring can't be read", async () => {
    const { account: a, c } = account();
    expect(await savedSignIn(c, a)).toBeUndefined();
    const broken = memoryKeyring(entry(details));
    broken.broken = "no Secret Service running";
    const other = account(broken);
    expect(await savedSignIn(other.c, other.account)).toBeUndefined();
  });

  it("asks when the keyring entry isn't one this app saved for the address", async () => {
    for (const stored of ["hunter2", "{}", '{"v":1,"password":"hunter2"}', entry({ ...details, sshTarget: "liam@elsewhere" }), "null", "42"]) {
      const { account: a, c } = account(memoryKeyring(stored));
      expect(await savedSignIn(c, a), stored).toBeUndefined();
    }
  });

  it("still signs in when the keyring can't save, and says the password wasn't kept", async () => {
    const keyring = memoryKeyring();
    keyring.broken = "no Secret Service running";
    const { account: a, c } = account(keyring);
    const { hermes, notSaved } = await signIn(c, details, a);
    expect(hermes.getSnapshot().status).toBe("connected");
    expect(notSaved).toBe("Couldn't save the password in the system keyring: no Secret Service running");
  });

  it("is never sent to an edited address, even when the keyring couldn't save the new one", async () => {
    const { account: a, c, keyring, saved } = account();
    const { hermes } = await signIn(c, details, a);
    await hermes.close();
    keyring.broken = "the keyring is locked";
    await signIn(saved(), { ...details, sshTarget: "liam@new-host" }, a);
    keyring.broken = undefined;
    // The keyring still holds the old address's password, but the connection is at the new address now.
    expect(JSON.parse(keyring.password!).for).toBe(addressKey(details));
    expect(await savedSignIn(saved(), a)).toBeUndefined();
  });
});

describe("Extra request headers", () => {
  const access: SignInDetails = {
    ...details,
    mode: "url",
    url: "https://hermes.example.com",
    headers: [
      { name: "CF-Access-Client-Id", value: "id.access" },
      { name: "CF-Access-Client-Secret", value: "s3cret" },
    ],
  };

  it("are saved in the system keyring, never beside the rest of the sign-in, and come back at launch", async () => {
    const first = account();
    await signIn(first.c, access, first.account);
    expect(JSON.parse(first.headerKeyring.password!)).toEqual({ url: "https://hermes.example.com", headers: access.headers });
    expect(addressOf(first.saved())).toEqual({ mode: "url", sshTarget: "liam@hermes", url: "https://hermes.example.com", username: "liam" });
    expect(JSON.stringify(first.saved())).not.toContain("s3cret");
    expect(await savedSignIn(first.saved(), first.account)).toEqual(access);
  });

  it("stay after Sign out, so the sign-in screen still has them", async () => {
    const { account: a, c, saved } = account();
    const { hermes } = await signIn(c, access, a);
    await signOut(hermes, saved(), a);
    expect(await savedSignIn(saved(), a)).toBeUndefined();
    expect(await signInForm(saved(), a)).toEqual({ ...access, password: "" });
  });

  it("are deleted from the keyring when the owner signs in with none", async () => {
    const { account: a, c, headerKeyring, saved } = account();
    await signIn(c, access, a);
    await signIn(saved(), { ...access, headers: [] }, a);
    expect(headerKeyring.password).toBeUndefined();
  });

  it("are none when the keyring entry is unreadable or isn't a list of headers", async () => {
    const url = '"url":""';
    for (const [stored, want] of [
      ["not json", []],
      ['[{"name":"X","value":"1"}]', []],
      [`{${url},"headers":{"name":"X"}}`, []],
      [`{${url},"headers":[{"name":"X"},{"name":"Y","value":"1"},null]}`, [{ name: "Y", value: "1" }]],
    ] as const) {
      const { account: a, c } = account(memoryKeyring(entry(details)), memoryKeyring(stored));
      expect((await savedSignIn(c, a))?.headers, stored).toEqual(want);
    }
  });

  it("still sign in when the keyring can't save them, and say so without the values", async () => {
    const headerKeyring = memoryKeyring();
    headerKeyring.broken = "the keyring is locked";
    const { account: a, c } = account(memoryKeyring(), headerKeyring);
    const { notSaved, kept } = await signIn(c, access, a);
    expect(notSaved).toBe("Couldn't save the extra request headers in the system keyring: the keyring is locked");
    expect(kept).toEqual({ password: true, headers: false });
  });

  it("never go to another URL, even when the keyring couldn't save the new URL's headers", async () => {
    const { account: a, c, headerKeyring, saved } = account();
    const { hermes } = await signIn(c, access, a);
    await signOut(hermes, saved(), a);
    headerKeyring.broken = "the keyring is locked";
    const elsewhere: SignInDetails = { ...access, url: "https://other.example.com", headers: [{ name: "CF-Access-Client-Secret", value: "other" }] };
    await signIn(saved(), elsewhere, a);
    headerKeyring.broken = undefined;
    // The keyring still holds the first URL's headers, but the connection is now at the other URL.
    expect(JSON.parse(headerKeyring.password!).url).toBe("https://hermes.example.com");
    expect((await savedSignIn(saved(), a))?.headers).toEqual([]);
    expect((await signInForm(saved(), a)).headers).toEqual([]);
  });

  it("are back on the sign-in screen only once Sign out has read them", async () => {
    const { account: a, c, headerKeyring, saved } = account();
    const { hermes } = await signIn(c, access, a);
    let release!: () => void;
    const load = headerKeyring.load;
    headerKeyring.load = () => new Promise((r) => (release = () => r(load())));
    let done = false;
    const out = signOutToSignIn(hermes, saved(), a).then((r) => ((done = true), r));
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(done).toBe(false);
    release();
    expect(await out).toEqual({ initial: { ...access, password: "" }, error: undefined });
  });
});

describe("Sign out", () => {
  it("closes the connection and deletes the saved password from the keyring", async () => {
    const { account: a, c, keyring, server, saved } = account();
    const { hermes } = await signIn(c, details, a);
    await signOut(hermes, saved(), a);
    expect(server.closed).toBe(true);
    expect(keyring.password).toBeUndefined();
    // The next sign-in screen still has everything but the password.
    expect(saved().username).toBe("liam");
    expect(await savedSignIn(saved(), a)).toBeUndefined();
  });

  it("deletes the password even when closing the connection fails", async () => {
    const { account: a, c, keyring, saved } = account();
    const { hermes } = await signIn(c, details, a);
    hermes.close = () => Promise.reject(new Error("the Rust side is gone"));
    await signOut(hermes, saved(), a);
    expect(keyring.password).toBeUndefined();
  });

  it("signs out even when the keyring can't delete the password, and says so", async () => {
    const { account: a, c, keyring, server, saved } = account();
    const { hermes } = await signIn(c, details, a);
    keyring.broken = "the keyring is locked";
    await expect(signOut(hermes, saved(), a)).rejects.toThrow(
      "Signed out, but couldn't delete the saved password from the system keyring: the keyring is locked",
    );
    expect(server.closed).toBe(true);
  });
});

describe("Saved connections", () => {
  /** Two servers, each with its own password, and a keyring with an entry per connection id. */
  function twoServers() {
    const servers = { "https://alpha.example.com": new FakeHermes(), "https://bravo.example.com": new FakeHermes() };
    const passwords = { "https://alpha.example.com": "alpha-pass", "https://bravo.example.com": "bravo-pass" };
    const keyring = new Map<string, string>();
    const k = (name: string): Keyring => ({
      load: async () => keyring.get(name),
      save: async (v) => void keyring.set(name, v),
      delete: async () => void keyring.delete(name),
    });
    const sent: { to: string; password: string }[] = [];
    const a: Account = {
      connections: new Connections(memoryStorage()),
      secrets: (c) => ({ password: k(`password/${c.id}`), headers: k(`headers/${c.id}`), token: { saved: async () => undefined, keep: async () => {}, delete: async () => {} } }),
      connect: async (_c, d) => {
        sent.push({ to: d.url, password: d.password });
        if (passwords[d.url as keyof typeof passwords] !== d.password) throw new Error("Wrong username or password.");
        return connect(servers[d.url as keyof typeof servers].openPipe, "default");
      },
      readSaved: () => undefined,
      openSaved: () => undefined,
    };
    const at = (url: string, password: string): SignInDetails => ({ mode: "url", sshTarget: "", url, username: "owner", password, headers: [] });
    return { servers, keyring, sent, a, at };
  }

  it("keep each connection's password apart, and sign each in with its own", async () => {
    const { a, at, sent } = twoServers();
    const one = a.connections.draft(at("https://alpha.example.com", ""), "Home");
    const two = a.connections.draft(at("https://bravo.example.com", ""), "Home");
    await (await signIn(one, at("https://alpha.example.com", "alpha-pass"), a)).hermes.close();
    await (await signIn(two, at("https://bravo.example.com", "bravo-pass"), a)).hermes.close();
    expect(a.connections.recent().map((c) => c.name)).toEqual(["Home", "Home"]);
    expect(await savedSignIn(a.connections.get(one.id)!, a)).toMatchObject({ url: "https://alpha.example.com", password: "alpha-pass" });
    expect(await savedSignIn(a.connections.get(two.id)!, a)).toMatchObject({ url: "https://bravo.example.com", password: "bravo-pass" });
    // Neither password ever went to the other server.
    expect(sent).toEqual([
      { to: "https://alpha.example.com", password: "alpha-pass" },
      { to: "https://bravo.example.com", password: "bravo-pass" },
    ]);
  });

  it("removing one deletes its keyring entries and local data, leaves the other's, and sends nothing to Hermes", async () => {
    const { a, at, keyring, servers } = twoServers();
    const one = a.connections.draft(at("https://alpha.example.com", ""), "Alpha");
    const two = a.connections.draft(at("https://bravo.example.com", ""), "Bravo");
    await (await signIn(one, at("https://alpha.example.com", "alpha-pass"), a)).hermes.close();
    await (await signIn(two, at("https://bravo.example.com", "bravo-pass"), a)).hermes.close();
    const requests = servers["https://alpha.example.com"].requests.length;
    const forgot: string[] = [];
    await removeConnection(a.connections.get(one.id)!, a, async (c) => void forgot.push(c.id));
    expect(forgot).toEqual([one.id]);
    expect([...keyring.keys()]).toEqual([`password/${two.id}`]);
    expect(a.connections.recent().map((c) => c.id)).toEqual([two.id]);
    expect(servers["https://alpha.example.com"].requests.length).toBe(requests);
  });

  it("removing the one in use leaves none in use, rather than picking another", async () => {
    const { a, at } = twoServers();
    const one = a.connections.draft(at("https://alpha.example.com", ""), "Alpha");
    const two = a.connections.draft(at("https://bravo.example.com", ""), "Alpha");
    await (await signIn(one, at("https://alpha.example.com", "alpha-pass"), a)).hermes.close();
    await (await signIn(two, at("https://bravo.example.com", "bravo-pass"), a)).hermes.close();
    await removeConnection(a.connections.get(two.id)!, a, async () => {});
    expect(a.connections.current()).toBeUndefined();
  });

  it("removing keeps the connection when the keyring can't delete its secrets", async () => {
    const { a, at } = twoServers();
    const one = a.connections.draft(at("https://alpha.example.com", ""), "Alpha");
    await (await signIn(one, at("https://alpha.example.com", "alpha-pass"), a)).hermes.close();
    const locked: Keyring = { load: async () => undefined, save: async () => {}, delete: () => Promise.reject(new Error("the keyring is locked")) };
    const forget = vi.fn(async () => {});
    const stuck = { ...a, secrets: () => ({ password: locked, headers: locked, token: { saved: async () => undefined, keep: async () => {}, delete: async () => {} } }) };
    await expect(removeConnection(a.connections.get(one.id)!, stuck, forget)).rejects.toThrow("The connection is still saved");
    expect(forget).not.toHaveBeenCalled();
    expect(a.connections.recent()).toHaveLength(1);
  });

  it("a removed connection's details are named in no other connection's sign-in", async () => {
    const { a, at } = twoServers();
    const one: SavedConnection = a.connections.draft(at("https://alpha.example.com", ""), "Alpha");
    await (await signIn(one, at("https://alpha.example.com", "alpha-pass"), a)).hermes.close();
    expect(await signInForm(a.connections.draft(at("https://bravo.example.com", "")), a)).toMatchObject({ password: "", headers: [] });
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
      expect(localChatCache({ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }).bytes()).toBe(listBytes);
      localChatCache({ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }).clear();
      expect(localChatCache({ mode: "ssh", sshTarget: "liam@hermes", url: "", username: "liam" }).bytes()).toBe(0);
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
      throw new RestError(503, "store busy");
    };
    await expect(hermes.pullOlderHistory()).rejects.toThrow("The dashboard answered 503: store busy");
    expect(hermes.getSnapshot().olderPulled).toBe(false);
    expect(cache.olderPulled("default")).toBe(false);
    expect(ids(hermes)).toEqual(["recent", "recent-loose"]);
  });
});
