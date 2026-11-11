// Settings → Memory → External memory's reads and writes, against the fake dashboard (fakeMemoryProviders.ts).
import { describe, expect, it } from "vitest";
import { FakeHermes } from "./fakeHermes";
import { BYTEROVER, HONCHO, RETAINDB } from "./fakeMemoryProviders";
import { copiedValues, sameValue, storeOf, valueProblem, visible, type ProviderField } from "./memoryProviders";
import { RestError } from "./pipe";
import { connect } from "./transport";

async function setUp() {
  const server = new FakeHermes();
  server.otherProfiles = { research: [], work: [] };
  const fake = server.memoryProviders.add({ ...HONCHO, profiles: ["default", "research"] }, { ...RETAINDB }, { ...BYTEROVER });
  fake.active = { default: "honcho", research: "honcho", work: "" };
  fake.set("default", "honcho", { workspace: "shared-ws", aiPeer: "hermes", peerName: "owner" });
  fake.setSecret("default", "honcho", "apiKey");
  const hermes = await connect(server.openPipe, "default");
  return { server, fake, api: hermes.memoryProviders };
}

describe("memory providers", () => {
  it("reads each profile's provider and the providers Hermes finds for it", async () => {
    const { api } = await setUp();
    const work = await api.read("work");
    expect(work.active).toBe("");
    expect(work.providers.map((p) => [p.name, p.status])).toEqual([
      ["retaindb", "needs_config"],
      ["byterover", "unavailable"],
    ]);
    expect(work.providers[1].setup.external[0].install).toContain("byterover.dev/install.sh");
    expect((await api.read("default")).providers.map((p) => p.name)).toContain("honcho");
  });

  it("reads a declared surface first, and the legacy one when there is none", async () => {
    const { api } = await setUp();
    const honcho = await api.form("research", "honcho");
    expect(honcho.surface).toBe("declared");
    const ws = honcho.fields.find((f) => f.key === "workspace")!;
    // Blank means the profile's own host, which Hermes puts in the placeholder.
    expect([ws.value, ws.inUse]).toEqual(["", "hermes_research"]);
    expect(honcho.fields.find((f) => f.key === "timeout")!.main).toBe(false);
    const retain = await api.form("work", "retaindb");
    expect(retain.surface).toBe("legacy");
    expect(retain.fields.map((f) => [f.key, f.kind, f.value, f.main])).toEqual([
      ["api_key", "secret", "", true],
      ["base_url", "text", "https://api.retaindb.com", true],
      ["project", "text", "", true],
    ]);
  });

  it("says which profiles share a Honcho store", async () => {
    const { api, fake } = await setUp();
    let rows = await api.overview(["default", "research", "work"]);
    const store = (p: string) => rows.find((r) => r.profile === p && r.ok && "store" in r) as { store?: { key: string } } | undefined;
    expect(store("default")!.store!.key).not.toBe(store("research")!.store!.key);
    expect(rows.find((r) => r.profile === "work")).toEqual({ profile: "work", ok: true, active: "" });
    fake.set("research", "honcho", { workspace: "shared-ws", aiPeer: "hermes", peerName: "owner" });
    rows = await api.overview(["default", "research", "work"]);
    expect(store("default")!.store!.key).toBe(store("research")!.store!.key);
  });

  it("keeps the other profiles when one can't be read", async () => {
    const { api, fake } = await setUp();
    fake.readFailures.work = new RestError(500, `{"detail":"boom"}`);
    const rows = await api.overview(["default", "work"]);
    expect(rows[0].ok).toBe(true);
    expect(rows[1]).toEqual({ profile: "work", ok: false, reason: "boom" });
  });

  it("copies another profile's settings so both point at the same store, never a secret", async () => {
    const { api } = await setUp();
    const values = copiedValues(await api.form("default", "honcho"), await api.form("research", "honcho"));
    expect(values).toEqual({ workspace: "shared-ws", peerName: "owner", aiPeer: "hermes" });
    // The source's blank workspace means its own host, so the copy names that host.
    const { fake, api: api2 } = await setUp();
    fake.values.default.honcho = {};
    expect(copiedValues(await api2.form("default", "honcho"), await api2.form("research", "honcho"))).toEqual({ workspace: "hermes", aiPeer: "hermes" });
  });

  it("saves declared settings, switching the provider, and reads them back", async () => {
    const { api, fake } = await setUp();
    fake.active.research = "";
    const form = await api.form("research", "honcho");
    const change = await api.save(form, { workspace: "shared-ws", apiKey: "k-1", peerName: "" }, "");
    expect(change.kind).toBe("saved");
    // Only what changed, and a typed secret; a blank text clears its key.
    expect(fake.writes).toEqual([
      { method: "PUT", path: "/api/memory/providers/honcho/config", profile: "research", body: { values: { workspace: "shared-ws", apiKey: "k-1", peerName: "" } } },
    ]);
    expect(fake.active.research).toBe("honcho");
    expect(change.kind === "saved" && change.form!.fields.find((f) => f.key === "apiKey")!.isSet).toBe(true);
  });

  it("never sends a blank secret, or an empty save that would switch the provider unchecked", async () => {
    const { api, fake } = await setUp();
    const form = await api.form("research", "honcho");
    expect(await api.save(form, { apiKey: "  " }, "honcho")).toMatchObject({ kind: "refused", wrote: false });
    expect(fake.writes).toEqual([]);
  });

  it("sends nothing when a changed setting is no longer what the owner saw", async () => {
    const { api, fake } = await setUp();
    const form = await api.form("research", "honcho");
    fake.set("research", "honcho", { workspace: "theirs" });
    const change = await api.save(form, { workspace: "mine" }, "honcho");
    expect(change).toMatchObject({ kind: "conflict", what: "Workspace" });
    expect(fake.writes).toEqual([]);
  });

  it("says a legacy save Hermes refused as not ready still wrote its settings", async () => {
    const { api, fake } = await setUp();
    const form = await api.form("work", "retaindb");
    const change = await api.save(form, { project: "p1" }, "");
    expect(change).toMatchObject({ kind: "refused", wrote: true });
    expect(change.kind === "refused" && change.reason).toMatch(/not ready \(needs config\)/);
    expect(fake.values.work.retaindb.project).toBe("p1");
    expect(fake.active.work).toBe("");
    // With the key it is ready, and the save switches the profile to it.
    expect((await api.save((await api.form("work", "retaindb")), { api_key: "k" }, "")).kind).toBe("saved");
    expect(fake.active.work).toBe("retaindb");
  });

  it("settles a lost answer by reading back", async () => {
    const { api, fake } = await setUp();
    fake.active.research = "";
    fake.dropNext = "stored";
    expect((await api.save(await api.form("research", "honcho"), { workspace: "w" }, "")).kind).toBe("saved");
    fake.dropNext = "lost";
    const change = await api.save(await api.form("research", "honcho"), { workspace: "w2" }, "honcho");
    expect(change.kind).toBe("unknown");
  });

  it("switches provider only from the one the owner saw, and Hermes refuses one that isn't ready", async () => {
    const { api, fake } = await setUp();
    expect((await api.use("research", "", "honcho")).kind).toBe("saved");
    expect(fake.active.research).toBe("");
    expect(await api.use("research", "honcho", "retaindb")).toMatchObject({ kind: "conflict" });
    const refused = await api.use("work", "retaindb", "");
    expect(refused).toMatchObject({ kind: "refused" });
    expect(fake.active.work).toBe("");
    expect(fake.writes.map((w) => w.body)).toEqual([{ provider: "" }, { provider: "retaindb" }]);
  });

  it("installs a provider's declared requirements and reads the providers again", async () => {
    const { api, fake } = await setUp();
    const out = await api.setup("work", "byterover", (await api.read("work")).providers.find((p) => p.name === "byterover")!.setup);
    expect(out.kind).toBe("done");
    expect(out.kind === "done" && out.steps.map((s) => [s.kind, s.status])).toEqual([["external_install", "installed"]]);
    expect(out.kind === "done" && out.memory!.providers.find((p) => p.name === "byterover")!.status).toBe("ready");
    expect(fake.writes).toEqual([{ method: "POST", path: "/api/memory/providers/byterover/setup", profile: "work", body: { values: {} } }]);
  });

  it("won't save over a provider switch made elsewhere, as saving also switches", async () => {
    const { api, fake } = await setUp();
    const form = await api.form("research", "honcho");
    fake.active.research = "";
    expect(await api.save(form, { workspace: "w" }, "honcho")).toMatchObject({ kind: "conflict", what: "provider" });
    expect(fake.writes).toEqual([]);
  });

  it("installs nothing when what a provider needs changed since the owner confirmed it", async () => {
    const { api, fake } = await setUp();
    const shown = (await api.read("work")).providers.find((p) => p.name === "byterover")!.setup;
    fake.providers.find((p) => p.name === "byterover")!.external = [{ name: "brv", install: "curl https://elsewhere | sh", check: "brv --version" }];
    expect((await api.setup("work", "byterover", shown)).kind).toBe("changed");
    expect(fake.writes).toEqual([]);
  });

  it("says a setup whose answer was lost may not have finished", async () => {
    const { api, fake } = await setUp();
    fake.dropNext = "lost";
    const out = await api.setup("work", "byterover", (await api.read("work")).providers.find((p) => p.name === "byterover")!.setup);
    expect(out.kind).toBe("unknown");
  });

  it("doesn't send a setting the owner can't see, or call an all-blank refused save written", async () => {
    const { api, fake } = await setUp();
    const form = await api.form("work", "retaindb");
    form.fields.find((f) => f.key === "project")!.when = { base_url: "https://other" };
    expect(await api.save(form, { project: "hidden" }, "")).toMatchObject({ kind: "refused", reason: "There are no changed settings to save." });
    // Blank clears it; Hermes refuses as not ready, and a blank can't show a write.
    fake.set("work", "retaindb", { project: "p0" });
    expect(await api.save(await api.form("work", "retaindb"), { project: "" }, "")).toMatchObject({ kind: "refused", wrote: false });
  });

  it("says when the server has no memory routes", async () => {
    const { api, fake } = await setUp();
    fake.routes = false;
    await expect(api.read("default")).rejects.toThrow(/no \/api\/memory route/);
  });

  it("checks values the way Hermes reads them", () => {
    const f = (kind: ProviderField["kind"], extra: Partial<ProviderField> = {}): ProviderField => ({
      key: "k", label: "K", kind, description: "", placeholder: "", value: "", isSet: false, options: [], required: false, group: "", main: true, url: "", ...extra,
    });
    expect(valueProblem(f("number"), "abc")).toMatch(/number/);
    expect(valueProblem(f("number"), "0x10")).toMatch(/number/);
    expect(valueProblem(f("number"), "1.5e3")).toBeUndefined();
    expect(valueProblem(f("json"), "{")).toMatch(/JSON/);
    expect(valueProblem(f("json"), "3")).toMatch(/object or list/);
    expect(valueProblem(f("text", { required: true }), "")).toMatch(/required/);
    expect(valueProblem(f("secret", { required: true, isSet: true }), "")).toBeUndefined();
    expect(sameValue("json", '{"a": "b"}', '{"a":"b"}')).toBe(true);
    expect(sameValue("number", "30", "30.0")).toBe(true);
    expect(sameValue("bool", "True", "true")).toBe(true);
    expect(visible(f("text", { when: { mode: "cloud" } }), { mode: "local" })).toBe(false);
    expect(storeOf({ profile: "p", name: "mem0", label: "", docsUrl: "", surface: "legacy", fields: [], readAt: 0 })).toBeUndefined();
  });
});
