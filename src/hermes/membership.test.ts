// @vitest-environment jsdom
// Project membership kept by Hermes (ADR 0109), against FakeHermes's version of the proposed `projects.membership.*`
// contract. Two computers are two ProjectsStores, each with its own storage, over one server; one can be cut off.
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeHermes, row } from "./fakeHermes";
import { connect, type Hermes } from "./transport";
import { ProjectsStore, type ProjectsApi } from "./projects";
import { PROJECTS_KEY, PROJECTS_VERSION, projectLinks, projectScope, readLinks, type LinksStorage } from "./projectLinks";
import { addOp, effectiveChats, nextBatch, planMigration, type MembershipApi, type MembershipOp } from "./membership";

const running: Hermes[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((h) => h.close()));
  localStorage.clear();
});

const CONNECTION = { mode: "url" as const, sshTarget: "", url: "https://hermes.example", username: "owner" };
const SCOPE = projectScope(CONNECTION, "default");
const project = (id: string, name: string) => ({ id, slug: id, name, primary_path: "/srv/app", archived: false, created_at: 1, folders: [{ path: "/srv/app", label: null, is_primary: true, added_at: 1 }] });

function server(store = true) {
  const s = new FakeHermes();
  s.sessions = [row("backup", 1, { title: "Nightly backup" }), row("nas", 2, { title: "NAS disks" }), row("notes", 3, { title: "Notes" })];
  s.otherProfiles = { work: [row("standup", 1, { title: "Standup" })] };
  s.serverDirs = new Set(["/srv/app"]);
  s.projects.default = [project("p_home", "Home lab"), project("p_docs", "Docs")];
  s.projects.work = [project("p_work", "Work")];
  s.membershipStore = store;
  return s;
}

function memoryStorage(): LinksStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

/** One computer: its own storage, and a switch that cuts its membership calls off as a dropped network would. */
function computer(hermes: Hermes, profile = "default", storage = memoryStorage()) {
  const net = { offline: false };
  const real = hermes.projects.membership!;
  const cut = <T,>(fn: () => Promise<T>) => (net.offline ? Promise.reject(new Error("The connection to Hermes dropped.")) : fn());
  const api: ProjectsApi = {
    ...hermes.projects,
    membership: { list: (p) => cut(() => real.list(p)), apply: (p, ops) => cut(() => real.apply(p, ops)) },
  };
  const links = projectLinks(storage);
  const store = new ProjectsStore(api, links, projectScope(CONNECTION, profile), profile);
  return { store, storage, links, net, scope: projectScope(CONNECTION, profile) };
}

async function setUp(s = server()) {
  const hermes = await connect(s.openPipe);
  running.push(hermes);
  return { s, hermes };
}

const onServer = (s: FakeHermes, profile = "default") =>
  (s.membership[profile] ?? []).map((l) => `${l.project_id}:${l.session_id}`).sort();
const shown = (c: { store: ProjectsStore }) =>
  Object.entries(c.store.getSnapshot().chats).flatMap(([p, ids]) => ids.map((id) => `${p}:${id}`)).sort();
const sent = (s: FakeHermes, method: string) => s.requests.filter((r) => r.method === method).map((r) => r.params);

describe("a Hermes without a membership store", () => {
  it("keeps membership on this computer, as before, and says so", async () => {
    const { s, hermes } = await setUp(server(false));
    const a = computer(hermes);
    await a.store.load();
    expect(a.store.getSnapshot().membership).toMatchObject({ state: "local", moved: false, pending: [] });
    a.store.setChat("p_home", "backup", true);
    expect(shown(a)).toEqual(["p_home:backup"]);
    await a.store.syncNow();
    expect(sent(s, "projects.membership.apply")).toEqual([]);
    expect(a.links.read(a.scope)).toMatchObject({ chats: { p_home: ["backup"] } });
    expect(a.links.read(a.scope).synced).toBeUndefined();
  });
});

describe("moving this computer's membership to Hermes", () => {
  it("previews what it will send, sends only what Hermes lacks, and keeps a recovery copy", async () => {
    const { s, hermes } = await setUp();
    // Another computer already put `nas` and `notes` in Home lab.
    s.membership.default = [
      { project_id: "p_home", session_id: "nas", added_at: 1 },
      { project_id: "p_home", session_id: "notes", added_at: 1 },
    ];
    const a = computer(hermes);
    a.links.setChat(a.scope, "p_home", "nas", true);
    a.links.setChat(a.scope, "p_home", "backup", true);
    a.links.setChat(a.scope, "p_docs", "backup", true);
    await a.store.load();
    const { membership } = a.store.getSnapshot();
    expect(membership.state).toBe("preview");
    expect(membership.preview).toMatchObject({
      add: [{ projectId: "p_home", chatId: "backup" }, { projectId: "p_docs", chatId: "backup" }],
      already: [{ projectId: "p_home", chatId: "nas" }],
      serverOnly: [{ projectId: "p_home", chatId: "notes" }],
    });
    // Nothing is sent before the owner agrees, and this computer's grouping is shown meanwhile.
    expect(sent(s, "projects.membership.apply")).toEqual([]);
    expect(shown(a)).toEqual(["p_docs:backup", "p_home:backup", "p_home:nas"]);

    await a.store.migrate();
    expect(onServer(s)).toEqual(["p_docs:backup", "p_home:backup", "p_home:nas", "p_home:notes"]);
    expect(shown(a)).toEqual(onServer(s));
    expect(a.store.getSnapshot().membership).toMatchObject({ state: "synced", moved: true, pending: [] });
    const kept = a.links.read(a.scope);
    expect(kept.recovery?.chats).toEqual({ p_home: ["backup", "nas"], p_docs: ["backup"] });
    expect(a.store.getSnapshot().membership.recoveryAt).toBe(kept.recovery?.at);
  });

  it("run twice, or from a second computer with the same links, makes no duplicate records", async () => {
    const { s, hermes } = await setUp();
    const a = computer(hermes);
    a.links.setChat(a.scope, "p_home", "backup", true);
    await a.store.load();
    await a.store.migrate();
    await a.store.migrate();
    expect(onServer(s)).toEqual(["p_home:backup"]);
    expect(sent(s, "projects.membership.apply")).toHaveLength(1);

    // A second computer had grouped the same chat the same way: nothing to send, so it moves without a preview.
    const b = computer(hermes);
    b.links.setChat(b.scope, "p_home", "backup", true);
    await b.store.load();
    expect(b.store.getSnapshot().membership).toMatchObject({ state: "synced", moved: true });
    expect(sent(s, "projects.membership.apply")).toHaveLength(1);
    expect(s.membership.default).toHaveLength(1);
    expect(b.links.read(b.scope).recovery?.chats).toEqual({ p_home: ["backup"] });
  });

  it("a move cut short keeps this computer's grouping shown and finishes at the next sync", async () => {
    const { s, hermes } = await setUp();
    const a = computer(hermes);
    a.links.setChat(a.scope, "p_home", "backup", true);
    a.links.setChat(a.scope, "p_docs", "nas", true);
    await a.store.load();
    s.membershipFails = undefined;
    // The list answers, then the network drops before the changes are sent.
    const real = hermes.projects.membership!;
    let applies = 0;
    a.store["api"] = { ...hermes.projects, membership: { list: real.list, apply: () => (++applies, Promise.reject(new Error("The connection to Hermes dropped."))) } };
    await a.store.migrate();
    expect(applies).toBe(1);
    expect(onServer(s)).toEqual([]);
    expect(shown(a)).toEqual(["p_docs:nas", "p_home:backup"]);
    expect(a.store.getSnapshot().membership).toMatchObject({ state: "pending", moved: true });
    expect(a.store.getSnapshot().membership.pending).toHaveLength(2);
    expect(a.store.getSnapshot().membership.error).toMatch(/2 changes wait on this computer: The connection to Hermes dropped/);

    a.store["api"] = hermes.projects;
    await a.store.load();
    expect(onServer(s)).toEqual(["p_docs:nas", "p_home:backup"]);
    expect(a.store.getSnapshot().membership).toMatchObject({ state: "synced", pending: [] });
  });

  it("Not now keeps membership here and stops asking until the owner moves it", async () => {
    const { s, hermes } = await setUp();
    const a = computer(hermes);
    a.links.setChat(a.scope, "p_home", "backup", true);
    await a.store.load();
    a.store.postponeMigration();
    expect(a.store.getSnapshot().membership).toMatchObject({ state: "local", preview: { later: true } });
    await a.store.load();
    expect(a.store.getSnapshot().membership.state).toBe("local");
    a.store.setChat("p_docs", "nas", true);
    expect(sent(s, "projects.membership.apply")).toEqual([]);
    await a.store.migrate();
    expect(onServer(s)).toEqual(["p_docs:nas", "p_home:backup"]);
  });
});

describe("two computers", () => {
  async function both() {
    const { s, hermes } = await setUp();
    s.membership.default = [{ project_id: "p_home", session_id: "nas", added_at: 1 }];
    const a = computer(hermes);
    const b = computer(hermes);
    await a.store.load();
    await b.store.load();
    return { s, a, b };
  }

  it("shows one computer's add and remove on the other after a refresh, leaving other links alone", async () => {
    const { s, a, b } = await both();
    a.store.setChat("p_docs", "backup", true);
    a.store.setChat("p_home", "backup", true);
    await a.store.syncNow();
    expect(onServer(s)).toEqual(["p_docs:backup", "p_home:backup", "p_home:nas"]);
    await b.store.load();
    expect(shown(b)).toEqual(["p_docs:backup", "p_home:backup", "p_home:nas"]);

    b.store.setChat("p_home", "nas", false);
    await b.store.syncNow();
    await a.store.load();
    // The same chat stays in both of its projects; only the link taken out went.
    expect(shown(a)).toEqual(["p_docs:backup", "p_home:backup"]);
  });

  it("concurrent changes to different links both land", async () => {
    const { s, a, b } = await both();
    a.store.setChat("p_docs", "notes", true);
    b.store.setChat("p_home", "nas", false);
    await Promise.all([a.store.syncNow(), b.store.syncNow()]);
    await a.store.load();
    await b.store.load();
    expect(onServer(s)).toEqual(["p_docs:notes"]);
    expect(shown(a)).toEqual(["p_docs:notes"]);
    expect(shown(b)).toEqual(["p_docs:notes"]);
  });

  it("an offline change waits, shown as pending, and goes when the computer is back", async () => {
    const { s, a } = await both();
    a.net.offline = true;
    a.store.setChat("p_docs", "backup", true);
    await a.store.syncNow();
    expect(shown(a)).toContain("p_docs:backup");
    expect(a.store.getSnapshot().membership).toMatchObject({ state: "pending", pending: [{ projectId: "p_docs", chatId: "backup", member: true }] });
    expect(onServer(s)).toEqual(["p_home:nas"]);
    // It survives a restart: a new store over the same storage still has it.
    const again = new ProjectsStore(a.store["api"], projectLinks(a.storage), a.scope, "default");
    expect(again.getSnapshot().membership.pending).toHaveLength(1);
    a.net.offline = false;
    await a.store.load();
    expect(onServer(s)).toEqual(["p_docs:backup", "p_home:nas"]);
    expect(a.store.getSnapshot().membership).toMatchObject({ state: "synced", pending: [] });
  });

  it("both taking the same chat out offline agree: no conflict", async () => {
    const { s, a, b } = await both();
    a.net.offline = b.net.offline = true;
    a.store.setChat("p_home", "nas", false);
    b.store.setChat("p_home", "nas", false);
    a.net.offline = b.net.offline = false;
    await a.store.load();
    await b.store.load();
    expect(onServer(s)).toEqual([]);
    expect(b.store.getSnapshot().membership).toMatchObject({ state: "synced", pending: [] });
  });

  it("a link the other computer changed meanwhile is a conflict: Hermes's state stands until the owner picks", async () => {
    const { s, a, b } = await both();
    // B, offline, puts Nightly backup in Docs.
    b.net.offline = true;
    b.store.setChat("p_docs", "backup", true);
    // A, online, puts it in Docs and then takes it out again: the owner decided against it after B last synced.
    a.store.setChat("p_docs", "backup", true);
    await a.store.syncNow();
    a.store.setChat("p_docs", "backup", false);
    await a.store.syncNow();
    b.net.offline = false;
    await b.store.load();
    const snap = b.store.getSnapshot();
    expect(snap.membership.state).toBe("pending");
    expect(snap.membership.pending).toMatchObject([{ projectId: "p_docs", chatId: "backup", member: true, conflict: { serverMember: false } }]);
    // Hermes's state is the one shown.
    expect(shown(b)).toEqual(["p_home:nas"]);
    expect(onServer(s)).toEqual(["p_home:nas"]);

    // Keep mine: sent again over the revision the conflict showed, and it lands.
    b.store.keepMine(snap.membership.pending[0].opId);
    await b.store.syncNow();
    expect(onServer(s)).toEqual(["p_docs:backup", "p_home:nas"]);
    expect(b.store.getSnapshot().membership).toMatchObject({ state: "synced", pending: [] });
  });

  it("Use Hermes's drops the owner's change", async () => {
    const { s, a, b } = await both();
    b.net.offline = true;
    b.store.setChat("p_home", "nas", false);
    a.store.setChat("p_home", "nas", false);
    await a.store.syncNow();
    a.store.setChat("p_home", "nas", true);
    await a.store.syncNow();
    b.net.offline = false;
    await b.store.load();
    const [op] = b.store.getSnapshot().membership.pending;
    expect(op.conflict).toEqual({ serverMember: true, rev: 2 });
    b.store.useHermes(op.opId);
    await b.store.syncNow();
    expect(onServer(s)).toEqual(["p_home:nas"]);
    expect(b.store.getSnapshot().membership).toMatchObject({ state: "synced", pending: [] });
  });

  it("this computer's own quick changes never conflict with each other", async () => {
    const { s, a } = await both();
    a.store.setChat("p_docs", "notes", true);
    const first = a.store.syncNow();
    // Taken out again while the add is on its way.
    a.store.setChat("p_docs", "notes", false);
    await first;
    await a.store.syncNow();
    expect(onServer(s)).toEqual(["p_home:nas"]);
    expect(a.store.getSnapshot().membership).toMatchObject({ state: "synced", pending: [] });
  });
});

describe("deleted projects, missing chats and retries", () => {
  it("deleting a project removes its links, never its chats or folders, and drops changes waiting for it", async () => {
    const { s, hermes } = await setUp();
    s.membership.default = [
      { project_id: "p_home", session_id: "nas", added_at: 1 },
      { project_id: "p_docs", session_id: "nas", added_at: 1 },
    ];
    const a = computer(hermes);
    await a.store.load();
    a.net.offline = true;
    a.store.setChat("p_home", "backup", true);
    a.net.offline = false;
    await a.store.delete("p_home");
    expect(onServer(s)).toEqual(["p_docs:nas"]);
    expect(s.sessions.map((r) => r.id)).toEqual(["backup", "nas", "notes"]);
    expect(s.serverDirs.has("/srv/app")).toBe(true);
    expect(a.store.getSnapshot().membership.pending).toEqual([]);
    await a.store.load();
    expect(shown(a)).toEqual(["p_docs:nas"]);
  });

  it("a change for a chat Hermes no longer has is refused and said so; other changes still land", async () => {
    const { s, hermes } = await setUp();
    const a = computer(hermes);
    await a.store.load();
    a.net.offline = true;
    a.store.setChat("p_home", "notes", true);
    a.store.setChat("p_home", "backup", true);
    s.sessions = s.sessions.filter((r) => r.id !== "notes");
    a.net.offline = false;
    await a.store.syncNow();
    expect(onServer(s)).toEqual(["p_home:backup"]);
    expect(a.store.getSnapshot().membership.refused).toEqual([{ link: { projectId: "p_home", chatId: "notes" }, why: "no_session" }]);
    expect(a.store.getSnapshot().membership.pending).toEqual([]);
  });

  it("a deleted chat leaves every project, on Hermes and here", async () => {
    const { s, hermes } = await setUp();
    s.membership.default = [{ project_id: "p_home", session_id: "nas", added_at: 1 }, { project_id: "p_docs", session_id: "nas", added_at: 1 }];
    const a = computer(hermes);
    await a.store.load();
    // Deleted in Hermes (here, the fake's own `DELETE /api/sessions/{id}`), then forgotten here as App.tsx does.
    s["deleteSession"]("nas", new URLSearchParams({ profile: "default", request_id: "r-1", expected_revision: "0", expected_generation: "0" }));
    a.store.forgetChat("nas");
    expect(shown(a)).toEqual([]);
    await a.store.load();
    expect(onServer(s)).toEqual([]);
  });

  it("an op retried after a lost answer is answered the same, and isn't applied twice", async () => {
    const { s, hermes } = await setUp();
    const api = hermes.projects.membership!;
    const op: MembershipOp = { opId: "op-1", projectId: "p_home", chatId: "nas", member: true, base: 0, at: 1 };
    const first = await api.apply("default", [op]);
    // Meanwhile another computer takes it out.
    await api.apply("default", [{ ...op, opId: "op-2", member: false, base: first.revision }]);
    const retried = await api.apply("default", [op]);
    expect(retried.results).toEqual(first.results);
    expect(onServer(s)).toEqual([]);
  });

  it("keeps each profile's membership apart", async () => {
    const { s, hermes } = await setUp();
    s.membership.work = [{ project_id: "p_work", session_id: "standup", added_at: 1 }];
    const work = computer(hermes, "work");
    const home = computer(hermes, "default");
    await work.store.load();
    await home.store.load();
    expect(shown(work)).toEqual(["p_work:standup"]);
    expect(shown(home)).toEqual([]);
    expect(sent(s, "projects.membership.list")).toEqual([{ profile: "work" }, { profile: "default" }]);
    // A project id from another profile is refused there.
    home.store.setChat("p_work", "nas", true);
    await home.store.syncNow();
    expect(onServer(s, "work")).toEqual(["p_work:standup"]);
  });

  it("an older Hermes after the move shows the last links read and keeps changes waiting", async () => {
    const { s, hermes } = await setUp();
    s.membership.default = [{ project_id: "p_home", session_id: "nas", added_at: 1 }];
    const a = computer(hermes);
    await a.store.load();
    s.membershipStore = false;
    a.store.setChat("p_docs", "nas", true);
    await a.store.syncNow();
    expect(a.store.getSnapshot().membership).toMatchObject({ state: "stranded", moved: true });
    expect(shown(a)).toEqual(["p_docs:nas", "p_home:nas"]);
    expect(a.store.getSnapshot().membership.pending).toHaveLength(1);
  });
});

/**
 * One computer whose `apply` can be held until released, or can lose its answer after Hermes applied it, and whose list
 * can fail: the cases a real network makes.
 */
function flaky(hermes: Hermes, storage = memoryStorage()) {
  const real = hermes.projects.membership!;
  // `listsLeft`: how many more lists answer before they fail, when set.
  const net = { held: undefined as undefined | Promise<void>, loseAnswer: false, listFails: false, listsLeft: undefined as number | undefined, applies: 0 };
  let release = () => {};
  const membership: MembershipApi = {
    list: (p) => {
      if (net.listsLeft !== undefined && net.listsLeft-- <= 0) net.listFails = true;
      return net.listFails ? Promise.reject(new Error("The connection to Hermes dropped.")) : real.list(p);
    },
    apply: async (p, ops) => {
      net.applies++;
      const res = await real.apply(p, ops);
      if (net.held) await net.held;
      if (net.loseAnswer) throw new Error("The connection to Hermes dropped.");
      return res;
    },
  };
  const hold = () => (net.held = new Promise<void>((r) => (release = () => ((net.held = undefined), r()))));
  const links = projectLinks(storage);
  const scope = projectScope(CONNECTION, "default");
  const make = () => new ProjectsStore({ ...hermes.projects, membership }, projectLinks(storage), scope, "default");
  return { store: make(), make, links, net, hold, release: () => release(), storage };
}

describe("lost answers and quick changes", () => {
  it("an add whose answer was lost, then undone offline and across a restart, ends taken out", async () => {
    const { s, hermes } = await setUp();
    const a = flaky(hermes);
    await a.store.load();
    a.net.loseAnswer = true;
    a.store.setChat("p_home", "nas", true);
    await a.store.syncNow();
    // Hermes applied it; this computer never heard. The change stays, marked as sent.
    expect(onServer(s)).toEqual(["p_home:nas"]);
    expect(a.store.getSnapshot().membership.pending).toMatchObject([{ member: true, sent: true }]);
    a.net.listFails = true;
    a.store.setChat("p_home", "nas", false);
    expect(a.store.getSnapshot().membership.pending.map((o) => o.member)).toEqual([true, false]);
    // Restart, back online.
    a.net.loseAnswer = a.net.listFails = false;
    const again = a.make();
    await again.load();
    expect(onServer(s)).toEqual([]);
    expect(again.getSnapshot().membership).toMatchObject({ state: "synced", pending: [] });
    expect(again.getSnapshot().chats).toEqual({});
  });

  it("add, remove, add, remove while the first add is on its way ends taken out, with no conflict", async () => {
    const { s, hermes } = await setUp();
    const a = flaky(hermes);
    await a.store.load();
    a.hold();
    a.store.setChat("p_home", "nas", true);
    const first = a.store.syncNow();
    await vi.waitFor(() => expect(a.net.applies).toBe(1));
    a.store.setChat("p_home", "nas", false);
    a.store.setChat("p_home", "nas", true);
    a.store.setChat("p_home", "nas", false);
    expect(a.store.getSnapshot().chats).toEqual({});
    a.release();
    await first;
    await a.store.syncNow();
    expect(onServer(s)).toEqual([]);
    expect(a.store.getSnapshot().membership).toMatchObject({ state: "synced", pending: [] });
    expect(a.net.applies).toBe(2);
  });

  it("sends a change only after the answer to the one before it on the same link", async () => {
    const { s, hermes } = await setUp();
    const a = flaky(hermes);
    await a.store.load();
    a.net.loseAnswer = true;
    a.store.setChat("p_docs", "backup", true);
    await a.store.syncNow();
    a.store.setChat("p_docs", "backup", false);
    a.net.loseAnswer = false;
    await a.store.syncNow();
    // The undo's own sync retried the add while answers were still lost. Every call carried one op, and the remove went
    // only after the add's answer.
    const applied = s.requests.filter((r) => r.method === "projects.membership.apply").map((r) => (r.params.ops as { member: boolean }[]).map((o) => o.member));
    expect(applied).toEqual([[true], [true], [true], [false]]);
    expect(onServer(s)).toEqual([]);
    expect(a.store.getSnapshot().membership.pending).toEqual([]);
  });

  it("a change answered before a failed read-back is the base for the next one", async () => {
    const { s, hermes } = await setUp();
    const a = flaky(hermes);
    await a.store.load();
    // Another computer's write, so the revisions this one knows lag behind.
    await hermes.projects.membership!.apply("default", [{ opId: "other", projectId: "p_docs", chatId: "notes", member: true, base: 0, at: 1 }]);
    // The list before the write answers; the read-back after it fails.
    a.net.listsLeft = 1;
    a.store.setChat("p_home", "nas", true);
    await a.store.syncNow();
    expect(onServer(s)).toEqual(["p_docs:notes", "p_home:nas"]);
    expect(a.store.getSnapshot().membership.error).toMatch(/dropped/);
    a.net.listsLeft = undefined;
    a.net.listFails = false;
    a.store.setChat("p_home", "nas", false);
    await a.store.syncNow();
    expect(onServer(s)).toEqual(["p_docs:notes"]);
    expect(a.store.getSnapshot().membership).toMatchObject({ state: "synced", pending: [] });
  });

  it("links to a project deleted elsewhere stay in the preview and reach the recovery copy, even after a failed check", async () => {
    const { s, hermes } = await setUp();
    const a = flaky(hermes);
    const scope = projectScope(CONNECTION, "default");
    // Known from an earlier read; deleted in another client since.
    a.links.remember(scope, [
      { id: "p_home", name: "Home lab", folders: [], archived: false },
      { id: "p_old", name: "Old", folders: [], archived: false },
    ]);
    a.links.setChat(scope, "p_old", "nas", true);
    a.links.setChat(scope, "p_home", "backup", true);
    // The first read of the projects drops Old, and the membership check then fails.
    a.net.listFails = true;
    await a.store.load();
    expect(a.store.getSnapshot().membership.state).toBe("local");
    expect(a.store.getSnapshot().chats).toEqual({ p_home: ["backup"] });
    expect(a.links.read(scope).setAside).toEqual({ p_old: ["nas"] });
    a.net.listFails = false;
    await a.store.load();
    await a.store.load();
    expect(a.store.getSnapshot().membership.preview).toMatchObject({ add: [{ projectId: "p_home", chatId: "backup" }], noProject: [{ projectId: "p_old", chatId: "nas" }] });
    await a.store.syncNow();
    expect(a.store.getSnapshot().membership.preview?.noProject).toEqual([{ projectId: "p_old", chatId: "nas" }]);
    expect(a.links.read(scope).recovery).toBeUndefined();
    await a.store.migrate();
    expect(onServer(s)).toEqual(["p_home:backup"]);
    expect(a.links.read(scope).recovery?.chats).toEqual({ p_home: ["backup"], p_old: ["nas"] });
    expect(a.links.read(scope).setAside).toBeUndefined();
  });

  it("Not now is kept across a restart, and the recovery copy has links added meanwhile", async () => {
    const { s, hermes } = await setUp();
    const a = flaky(hermes);
    const scope = projectScope(CONNECTION, "default");
    a.links.setChat(scope, "p_home", "backup", true);
    await a.store.load();
    a.store.postponeMigration();
    const again = a.make();
    await again.load();
    expect(again.getSnapshot().membership).toMatchObject({ state: "local", preview: { later: true } });
    // Still this computer's: a change stays here.
    again.setChat("p_docs", "notes", true);
    expect(s.requests.filter((r) => r.method === "projects.membership.apply")).toEqual([]);
    await again.migrate();
    expect(onServer(s)).toEqual(["p_docs:notes", "p_home:backup"]);
    expect(a.links.read(scope).recovery?.chats).toEqual({ p_docs: ["notes"], p_home: ["backup"] });
    expect(a.links.read(scope).postponed).toBeUndefined();
  });

  it("Not now holds even once another computer has put every link on Hermes", async () => {
    const { s, hermes } = await setUp();
    const a = flaky(hermes);
    const scope = projectScope(CONNECTION, "default");
    a.links.setChat(scope, "p_home", "backup", true);
    await a.store.load();
    a.store.postponeMigration();
    s.membership.default = [{ project_id: "p_home", session_id: "backup", added_at: 1 }, { project_id: "p_docs", session_id: "nas", added_at: 1 }];
    await a.store.load();
    expect(a.store.getSnapshot().membership).toMatchObject({ state: "local", moved: false, preview: { add: [], later: true } });
    expect(a.store.getSnapshot().chats).toEqual({ p_home: ["backup"] });
    await a.store.migrate();
    expect(a.store.getSnapshot().membership).toMatchObject({ state: "synced", moved: true });
    expect(a.store.getSnapshot().chats).toEqual({ p_home: ["backup"], p_docs: ["nas"] });
  });
});

describe("membership operations", () => {
  const next = (member: boolean, opId = "n") => ({ opId, projectId: "p", chatId: "c", member, at: 2 });

  it("a change and its undo, before either is sent, cancel out", () => {
    const one = addOp([], next(true, "a"), false, 4);
    expect(one).toEqual([{ ...next(true, "a"), base: 4 }]);
    expect(addOp(one, next(false, "b"), false, 9)).toEqual([]);
  });

  it("a change made after another was sent follows it, and changing it back again cancels only the unsent one", () => {
    const one = addOp([], next(true, "a"), false, 4).map((o) => ({ ...o, sent: true as const }));
    const two = addOp(one, next(false, "b"), false, 4);
    expect(two.map((o) => [o.opId, o.member, o.base])).toEqual([["a", true, 4], ["b", false, 4]]);
    // add (sent) → remove → add → remove: the unsent remove is cancelled by the add, then made again.
    const three = addOp(two, next(true, "c"), false, 4);
    expect(three.map((o) => o.opId)).toEqual(["a"]);
    const four = addOp(three, next(false, "d"), false, 4);
    expect(four.map((o) => [o.opId, o.member])).toEqual([["a", true], ["d", false]]);
  });

  it("sends only the first change of each link, and never a conflict", () => {
    const op = (opId: string, chatId: string, extra: Partial<MembershipOp> = {}): MembershipOp => ({ opId, projectId: "p", chatId, member: true, base: 0, at: 1, ...extra });
    const pending = [op("a", "x"), op("b", "x", { member: false }), op("c", "y", { conflict: { serverMember: false, rev: 2 } }), op("d", "z")];
    expect(nextBatch(pending, new Set()).map((o) => o.opId)).toEqual(["a", "d"]);
    expect(nextBatch(pending, new Set(["a"])).map((o) => o.opId)).toEqual(["d"]);
  });

  it("choosing again on a conflict is based on what the conflict showed", () => {
    const conflicted: MembershipOp = { opId: "a", projectId: "p", chatId: "c", member: true, base: 1, at: 1, conflict: { serverMember: false, rev: 7 } };
    expect(addOp([conflicted], next(false, "b"), false, 1)).toEqual([]);
    expect(addOp([conflicted], next(true, "b"), false, 1)).toEqual([{ ...next(true, "b"), base: 7 }]);
  });

  it("shows pending changes over Hermes's links, but not conflicts", () => {
    const pending: MembershipOp[] = [
      { opId: "a", projectId: "p", chatId: "x", member: true, base: 0, at: 1 },
      { opId: "b", projectId: "p", chatId: "y", member: false, base: 0, at: 1 },
      { opId: "c", projectId: "q", chatId: "x", member: true, base: 0, at: 1, conflict: { serverMember: false, rev: 3 } },
    ];
    expect(effectiveChats({ p: ["y", "z"] }, pending)).toEqual({ p: ["x", "z"] });
  });

  it("the preview sets aside links to projects Hermes no longer has", () => {
    const plan = planMigration({ gone: ["x"], p: ["y"] }, [], new Set(["p"]));
    expect(plan).toEqual({ add: [{ projectId: "p", chatId: "y" }], already: [], serverOnly: [], noProject: [{ projectId: "gone", chatId: "x" }] });
  });

  it("stores pending changes and the recovery copy, and reads a version 1 document as before", () => {
    const storage = memoryStorage();
    storage.setItem(PROJECTS_KEY, JSON.stringify({ v: 1, scopes: { [SCOPE]: { chats: { p_home: ["nas"] }, known: [] } } }));
    expect(readLinks(JSON.parse(storage.getItem(PROJECTS_KEY)!))[SCOPE]).toEqual({ chats: { p_home: ["nas"] }, known: [] });
    const links = projectLinks(storage);
    const op: MembershipOp = { opId: "a", projectId: "p_home", chatId: "x", member: true, base: 3, at: 5, conflict: { serverMember: false, rev: 4 } };
    links.update(SCOPE, (s) => ({ ...s, synced: { v: 1, at: 9 }, revision: 3, pending: [op, { ...op, opId: "", base: -1 } as MembershipOp], recovery: { at: 9, chats: { p_home: ["nas"] } } }));
    const doc = JSON.parse(storage.getItem(PROJECTS_KEY)!);
    expect(doc.v).toBe(PROJECTS_VERSION);
    expect(readLinks(doc)[SCOPE]).toEqual({ chats: { p_home: ["nas"] }, known: [], synced: { v: 1, at: 9 }, revision: 3, pending: [op], recovery: { at: 9, chats: { p_home: ["nas"] } } });
  });
});
