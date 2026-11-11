import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeHermes, row, type RestRequest } from "./fakeHermes";
import { memoryCache } from "./memoryCache";
import { totalUnread } from "./otherProfiles";
import { type ChatCache, connect } from "./transport";
import { RestError } from "./pipe";

const read = () => Date.now() / 1000 - 60;
const unreadRow = (id: string, daysAgo = 0, over = {}) => row(id, daysAgo, { last_read_at: 0, ...over });

/** Signed in to the `default` profile of a server that also has `work` and `aegis`. */
async function signedIn(cache: ChatCache = memoryCache()) {
  const server = new FakeHermes();
  server.sessions = [unreadRow("home-1", 1), row("home-2", 1)];
  server.otherProfiles = {
    work: [unreadRow("work-1"), unreadRow("work-2", 2, { pinned: true }), row("work-3", 1, { last_read_at: read() })],
    aegis: [row("aegis-1", 1, { last_read_at: read() })],
  };
  const hermes = await connect(server.openPipe, undefined, cache);
  await hermes.sync();
  const others = () => hermes.getSnapshot().others;
  const unreadOf = () => Object.fromEntries(Object.entries(others().byName).map(([n, p]) => [n, p.unread]));
  return { server, hermes, others, unreadOf };
}

/** The profiles whose lists were read, in order. */
const listed = (server: FakeHermes) => server.restRequests.filter((r) => r.path === "/api/sessions").map((r) => r.query.get("profile"));

/**
 * Holds back answers to `GET /api/sessions` for the profiles named. Each answer is read when the request arrives and
 * delivered late: `release(name)` lets that profile's oldest go, `releaseNewest(name)` its newest.
 */
function holdLists(server: FakeHermes, ...names: string[]) {
  const list = server.rest["GET /api/sessions"];
  const held = new Map<string, (() => void)[]>();
  let inFlight = 0;
  let mostInFlight = 0;
  server.rest["GET /api/sessions"] = (req: RestRequest) => {
    const name = req.query.get("profile") ?? "default";
    if (!names.includes(name)) return list(req);
    inFlight++;
    mostInFlight = Math.max(mostInFlight, inFlight);
    const answer = (() => {
      try {
        return { ok: list(req) };
      } catch (e) {
        return { err: e };
      }
    })();
    return new Promise((resolve, reject) =>
      held.set(name, [
        ...(held.get(name) ?? []),
        () => {
          inFlight--;
          if ("err" in answer) reject(answer.err);
          else resolve(answer.ok);
        },
      ]),
    );
  };
  return {
    release: (name: string) => held.get(name)?.shift()?.(),
    releaseNewest: (name: string) => held.get(name)?.pop()?.(),
    releaseAll: () => [...held.values()].forEach((fns) => fns.splice(0).forEach((f) => f())),
    mostInFlight: () => mostInFlight,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => void vi.useRealTimers());

describe("Unread in other profiles", () => {
  it("counts each other profile's Unread chats, from that profile's own list", async () => {
    const { server, hermes, others, unreadOf } = await signedIn();
    await hermes.checkOtherProfiles();

    expect(unreadOf()).toEqual({ work: 2, aegis: 0 });
    expect(others().byName.work).toMatchObject({ more: false });
    expect(hermes.checkTimes.get().byProfile).toEqual({ work: expect.any(Number), aegis: expect.any(Number) });
    // The profile shown has its own dots in the list, so it isn't among the others.
    expect(others().byName.default).toBeUndefined();
    const reads = server.restRequests.filter((r) => r.path === "/api/sessions" && r.query.get("profile") !== "default");
    expect(reads.map((r) => r.query.get("profile")).sort()).toEqual(["aegis", "work"]);
    expect(reads[0].query.get("exclude_sources")).toBe("cron");
  });

  it("doesn't touch the chat socket or the profile shown", async () => {
    const { server, hermes } = await signedIn();
    const before = server.requests.length;
    const chats = hermes.getSnapshot().chats;
    await hermes.checkOtherProfiles();

    expect(server.wsProfiles).toEqual(["default"]);
    expect(server.opened).toBe(1);
    // The socket is only asked what is live across the server, and which of the shown profile's chats have background
    // subagents running, which neither picks nor changes a profile.
    expect(server.requests.slice(before).map((r) => [r.method, r.params])).toEqual([
      ["subagent.roster", { profile: "default" }],
      ["session.active_list", {}],
    ]);
    expect(hermes.getSnapshot()).toMatchObject({ profile: "default", chats });
  });

  it("never marks a chat read by looking", async () => {
    const { server, hermes } = await signedIn();
    const watermarks = () => server.otherProfiles.work.map((s) => s.last_read_at);
    const before = watermarks();
    await hermes.checkOtherProfiles();

    expect(server.restRequests.filter((r) => r.method !== "GET" || r.path.endsWith("/mutation-snapshot"))).toEqual([]);
    expect(watermarks()).toEqual(before);
  });

  it("counts only chats the profile's list would show", async () => {
    const { server, hermes, unreadOf } = await signedIn();
    server.otherProfiles.work = [
      unreadRow("recent", 1),
      unreadRow("archived", 1, { archived: true }),
      unreadRow("old", 40),
      unreadRow("cron", 1, { source: "cron" }),
    ];
    await hermes.checkOtherProfiles();
    expect(unreadOf().work).toBe(1);
  });

  it("counts older chats in a profile whose older history was pulled", async () => {
    const cache = memoryCache();
    cache.pulled.add("work");
    const { server, hermes, unreadOf } = await signedIn(cache);
    server.otherProfiles.work = [unreadRow("recent", 1), unreadRow("old", 40)];
    await hermes.checkOtherProfiles();
    expect(unreadOf().work).toBe(2);
  });

  it("says there may be more when the profile has more chats than one check reads", async () => {
    const { server, hermes, others } = await signedIn();
    server.otherProfiles.work = Array.from({ length: 60 }, (_, i) => row(`w-${i}`, 1 + i / 100, { last_read_at: read() }));
    server.otherProfiles.work[0] = unreadRow("w-0", 0);
    await hermes.checkOtherProfiles();
    expect(others().byName.work).toMatchObject({ unread: 1, more: true });
    // One page per profile, however long its list.
    expect(listed(server).filter((p) => p === "work")).toHaveLength(1);
  });

  it("totals the other profiles for the switcher", () => {
    const total = totalUnread({
      byName: {
        work: { unread: 2 },
        aegis: { unread: 1, more: true },
        anvil: { unread: 0 },
        argus: { error: "The dashboard answered 500" },
      },
    });
    expect(total).toEqual({ unread: 3, more: true, withUnread: ["work", "aegis"], failed: ["argus"] });
    expect(totalUnread({ byName: {} })).toEqual({ unread: 0, more: false, withUnread: [], failed: [] });
  });

  it("works for however many profiles the server has", async () => {
    const { server, hermes, unreadOf } = await signedIn();
    server.otherProfiles = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`p${i}`, i % 2 ? [unreadRow(`p${i}-1`)] : []]));
    await hermes.checkOtherProfiles();
    expect(unreadOf()).toEqual({ p0: 0, p1: 1, p2: 0, p3: 1, p4: 0, p5: 1, p6: 0 });
  });

  describe("when something fails", () => {
    it("says which profile couldn't be checked, and still shows the others", async () => {
      const { server, hermes, others } = await signedIn();
      const list = server.rest["GET /api/sessions"];
      server.rest["GET /api/sessions"] = (req) => {
        if (req.query.get("profile") === "aegis") throw new RestError(500, "database is locked");
        return list(req);
      };
      await hermes.checkOtherProfiles();
      expect(others().byName.work).toMatchObject({ unread: 2 });
      expect(others().byName.aegis).toEqual({ error: "The dashboard answered 500: database is locked", sends: [] });
      expect(totalUnread(others())).toMatchObject({ unread: 2, failed: ["aegis"] });
    });

    it("keeps the last answer, with the time it was read, when a later check fails", async () => {
      vi.useFakeTimers();
      const { server, hermes, others } = await signedIn();
      await hermes.checkOtherProfiles();
      const first = others().byName.work;

      server.rest["GET /api/sessions"] = () => {
        throw new RestError(503, "", "The dashboard answered 503");
      };
      await vi.advanceTimersByTimeAsync(15_000);
      await hermes.checkOtherProfiles();
      expect(others().byName.work).toEqual({ ...first, error: "The dashboard answered 503" });
      await hermes.close();
    });

    it("says so when the profiles can't be listed, and keeps what it knew", async () => {
      vi.useFakeTimers();
      const { server, hermes, others } = await signedIn();
      await hermes.checkOtherProfiles();
      server.rest["GET /api/profiles"] = () => {
        throw new RestError(502, "", "The dashboard answered 502");
      };
      await vi.advanceTimersByTimeAsync(15_000);
      await hermes.checkOtherProfiles();
      expect(others().error).toBe("Couldn't list the profiles: The dashboard answered 502");
      expect(others().byName.work).toMatchObject({ unread: 2 });
      await hermes.close();
    });

    it("drops a profile that is gone from the server", async () => {
      vi.useFakeTimers();
      const { server, hermes, others } = await signedIn();
      await hermes.checkOtherProfiles();
      delete server.otherProfiles.aegis;
      await vi.advanceTimersByTimeAsync(15_000);
      await hermes.checkOtherProfiles();
      expect(Object.keys(others().byName)).toEqual(["work"]);
      await hermes.close();
    });

    it("checks nothing while there is no connection", async () => {
      const { server, hermes, others } = await signedIn();
      server.refuse = "ssh: connect to host hermes port 22: Connection refused";
      server.drop();
      const before = server.restRequests.length;
      await hermes.checkOtherProfiles();
      expect(server.restRequests.length).toBe(before);
      expect(others().byName).toEqual({});
      await hermes.close();
    });
  });

  describe("limits", () => {
    it("reads at most two profiles at once", async () => {
      const { server, hermes, unreadOf } = await signedIn();
      server.otherProfiles = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`p${i}`, [unreadRow(`p${i}-1`)]]));
      const hold = holdLists(server, ...Object.keys(server.otherProfiles));
      const checking = hermes.checkOtherProfiles();
      for (let i = 0; i < 6; i++) {
        await settle();
        hold.releaseAll();
      }
      await checking;
      expect(hold.mostInFlight()).toBe(2);
      expect(Object.values(unreadOf())).toEqual([1, 1, 1, 1, 1, 1]);
    });

    it("joins a check under way, and skips one asked for within 15 seconds of the last", async () => {
      vi.useFakeTimers();
      const { server, hermes } = await signedIn();
      await Promise.all([hermes.checkOtherProfiles(), hermes.checkOtherProfiles()]);
      expect(listed(server).filter((p) => p === "work")).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(10_000);
      await hermes.checkOtherProfiles();
      expect(listed(server).filter((p) => p === "work")).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(5_000);
      await hermes.checkOtherProfiles();
      expect(listed(server).filter((p) => p === "work")).toHaveLength(2);
      await hermes.close();
    });

    it("reads at most 20 profiles per check, the ones checked longest ago first", async () => {
      vi.useFakeTimers();
      const { server, hermes } = await signedIn();
      const names = Array.from({ length: 25 }, (_, i) => `p${String(i).padStart(2, "0")}`);
      server.otherProfiles = Object.fromEntries(names.map((n) => [n, []]));
      await hermes.checkOtherProfiles();
      const first = listed(server).filter((p) => p !== "default");
      expect(first).toHaveLength(20);
      expect(Object.keys(hermes.checkTimes.get().byProfile)).toHaveLength(20);

      await vi.advanceTimersByTimeAsync(15_000);
      await hermes.checkOtherProfiles();
      const second = listed(server).filter((p) => p !== "default").slice(20);
      expect(second).toHaveLength(20);
      // The five left out last time go first.
      expect(second.slice(0, 5).sort()).toEqual(names.filter((n) => !first.includes(n)));
      await hermes.close();
    });
  });

  describe("a check that finds nothing new", () => {
    /** Signed in, with a reply running in `work`, checked once; `later` moves the clock past the gap between checks. */
    async function checkedOnce() {
      const signed = await signedIn();
      signed.server.liveSessions = [{ id: "rt-w", session_key: "work-1", status: "working", last_active: Math.floor(Date.now() / 1000) }];
      await signed.hermes.checkOtherProfiles();
      let told = 0;
      signed.hermes.subscribe(() => told++);
      return { ...signed, told: () => told, later: () => vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 20_000 }) };
    }

    it("tells no one, and leaves the snapshot as it was, though it says when it checked", async () => {
      const { hermes, told, later } = await checkedOnce();
      const before = hermes.getSnapshot();
      later();
      await hermes.checkOtherProfiles();
      expect(told()).toBe(0);
      expect(hermes.getSnapshot()).toBe(before);
      const now = Date.now();
      expect(hermes.checkTimes.get()).toEqual({ others: now, live: now, byProfile: { work: now, aegis: now } });
    });

    it("tells no one when only the live check runs, as the office's does", async () => {
      const { hermes, told, later } = await checkedOnce();
      const before = hermes.getSnapshot();
      later();
      await hermes.checkLive();
      expect(told()).toBe(0);
      expect(hermes.getSnapshot()).toBe(before);
      expect(hermes.checkTimes.get().live).toBe(Date.now());
    });

    it("tells listeners when a session starts", async () => {
      const { server, hermes, told, later } = await checkedOnce();
      server.liveSessions.push({ id: "rt-a", session_key: "aegis-1", status: "waiting", last_active: Math.floor(Date.now() / 1000) });
      later();
      await hermes.checkLive();
      expect(told()).toBeGreaterThan(0);
      expect(hermes.getSnapshot().live?.sessions.map((s) => s.chatId)).toEqual(["work-1", "aegis-1"]);
    });

    it("tells listeners when another profile gains an Unread chat", async () => {
      const { server, hermes, told, later, unreadOf } = await checkedOnce();
      server.otherProfiles.aegis.push(unreadRow("aegis-2"));
      later();
      await hermes.checkOtherProfiles();
      expect(told()).toBeGreaterThan(0);
      expect(unreadOf()).toEqual({ work: 2, aegis: 1 });
    });
  });

  describe("after the connection or profile changes", () => {
    it("drops an answer that arrives after the owner switched profile, and asks nothing more", async () => {
      const { server, hermes, others } = await signedIn();
      server.otherProfiles = { work: [unreadRow("work-1")], aegis: [unreadRow("aegis-1")], anvil: [unreadRow("anvil-1")] };
      const hold = holdLists(server, "work", "aegis", "anvil");
      const checking = hermes.checkOtherProfiles();
      await settle();
      expect(listed(server).filter((p) => p !== "default")).toHaveLength(2);

      // The answers arrive once the socket is open for `work`, where any further request would go too.
      await hermes.switchProfile("work");
      hold.releaseAll();
      await checking;
      hold.releaseAll();
      await hermes.idle();
      // The old check read two profiles, and the new profile's list was read once, by the switch.
      expect(listed(server).filter((p) => p === "anvil")).toEqual([]);
      expect(others().byName.work).toBeUndefined();
      expect(others().byName.aegis).toBeUndefined();
    });

    it("shows the profile switched away from as its list last showed it", async () => {
      const { hermes, others } = await signedIn();
      await hermes.switchProfile("work");
      expect(others().byName).toEqual({
        default: { unread: 1, more: false, chats: expect.arrayContaining([expect.objectContaining({ id: "home-1", unread: true })]), sends: [] },
      });
      expect(hermes.checkTimes.get().byProfile.default).toEqual(expect.any(Number));
    });

    it("shows nothing for a profile switched away from before its list was read", async () => {
      const server = new FakeHermes();
      server.otherProfiles = { work: [] };
      const hermes = await connect(server.openPipe);
      await hermes.switchProfile("work");
      expect(hermes.getSnapshot().others.byName).toEqual({});
    });

    it("keeps an older check's answer from replacing a newer one", async () => {
      const { server, hermes, others } = await signedIn();
      const hold = holdLists(server, "aegis");
      const old = hermes.checkOtherProfiles();
      await settle();
      server.otherProfiles.aegis = [unreadRow("aegis-2"), unreadRow("aegis-3")];

      // A dropped and reopened connection makes the next check a new one.
      server.drop();
      await hermes.reconnect();
      await hermes.idle();
      const fresh = hermes.checkOtherProfiles();
      await settle();
      hold.releaseNewest("aegis");
      await fresh;
      expect(others().byName.aegis).toMatchObject({ unread: 2 });

      // The old check's answer, read before the new activity, arrives last.
      hold.release("aegis");
      await old;
      expect(others().byName.aegis).toMatchObject({ unread: 2 });
    });

    it("drops answers that arrive after sign-out, and a new sign-in starts with none", async () => {
      const { server, hermes, others } = await signedIn();
      const hold = holdLists(server, "work", "aegis");
      const checking = hermes.checkOtherProfiles();
      await settle();
      await hermes.close();
      hold.releaseAll();
      await checking;
      expect(others().byName).toEqual({});

      const again = await connect(server.openPipe);
      expect(again.getSnapshot().others).toEqual({ byName: {} });
      await again.close();
    });
  });
});
