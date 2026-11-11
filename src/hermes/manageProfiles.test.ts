// Settings → Profiles' calls (profiles.ts, ADR 0144) through the real transport against FakeHermes, whose profile routes
// follow `hermes_cli/web_routers/profiles.py` at the deployed `f0d94882`. All data is synthetic.
import { describe, expect, it } from "vitest";
import { FakeHermes } from "./fakeHermes";
import { memoryCache } from "./memoryCache";
import { ProfileError, nameIssue, nameProblem, type ProfileFailure } from "./profiles";
import { connect } from "./transport";

async function signedIn(setup: (s: FakeHermes) => void = () => {}) {
  const server = new FakeHermes();
  server.otherProfiles = { work: [], research: [] };
  setup(server);
  const hermes = await connect(server.openPipe, undefined, memoryCache());
  await hermes.sync();
  return { server, hermes, api: hermes.manageProfiles };
}

const failureOf = async (p: Promise<unknown>): Promise<ProfileFailure> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof ProfileError) return e.failure;
    throw e;
  }
  throw new Error("It didn't fail.");
};
const writes = (server: FakeHermes) => server.restRequests.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.path}`);

describe("Settings → Profiles' calls", () => {
  it("lists every profile with what each row shows", async () => {
    const { api } = await signedIn((s) => {
      s.profileModel.work = { model: "gpt-6.1", provider: "openai", reasoning_effort: "medium", fast: false };
      s.profileMeta.work = { description: "Writes code", description_auto: true };
      s.profileMeta.default = { display_name: "Main" };
      s.gatewaysRunning.add("work");
      s.distributions.research = "papers";
      s.skills.add("work", { dir: "/home/liam/.hermes/profiles/work/skills/a", source: "agent" }, "---\nname: a\ndescription: A\n---\n");
    });
    expect(await api.list()).toEqual([
      { name: "default", isDefault: true, displayName: "Main", description: "", skillCount: 0 },
      { name: "work", model: "gpt-6.1", provider: "openai", description: "Writes code", descriptionAuto: true, skillCount: 1, gatewayRunning: true },
      { name: "research", description: "", skillCount: 0, distribution: "papers" },
    ]);
  });

  it("keeps default's display name for the switcher from each list read", async () => {
    const { hermes, api } = await signedIn((s) => (s.profileMeta.default = { display_name: "Main" }));
    await api.list();
    expect(hermes.getSnapshot().defaultName).toBe("Main");
    await api.rename("default", "Home");
    expect(hermes.getSnapshot().defaultName).toBe("Home");
  });

  it("makes a blank profile, and says when Hermes didn't set its model", async () => {
    const { server, api } = await signedIn((s) => (s.profileModelError = "Unknown model x/y"));
    expect(await api.create({ name: "papers", description: " Reads papers ", provider: "openrouter", model: "x/y", soul: "Be brief." })).toEqual({
      name: "papers",
      answered: true,
      modelSet: false,
      modelError: "Unknown model x/y",
    });
    expect(server.restRequests.find((r) => r.method === "POST")?.body).toEqual({ name: "papers", description: "Reads papers", provider: "openrouter", model: "x/y", soul: "Be brief." });
    expect(server.souls.papers).toBe("Be brief.");
    expect(await api.create({ name: "notes" })).toEqual({ name: "notes", answered: true, modelSet: true });
  });

  it("shows Hermes's own refusal of a taken name, and never sends a name Hermes wouldn't take", async () => {
    const { server, api } = await signedIn();
    expect(await failureOf(api.create({ name: "work" }))).toEqual({ kind: "refused", status: 400, detail: expect.stringMatching(/already exists/) });
    expect(await failureOf(api.create({ name: "Work 2" }))).toMatchObject({ kind: "unsent" });
    expect(await failureOf(api.create({ name: "default" }))).toMatchObject({ kind: "unsent" });
    expect(writes(server)).toEqual(["POST /api/profiles"]);
  });

  it("checks a name as typed against Hermes's rule, its reserved names and the profiles listed", () => {
    const rows = [{ name: "default" }, { name: "work" }];
    expect(nameIssue("", rows)).toBe("empty");
    expect(nameIssue("Work", rows)).toBe("invalid");
    expect(nameIssue("-x", rows)).toBe("invalid");
    expect(nameIssue("a".repeat(65), rows)).toBe("invalid");
    expect(nameIssue("sudo", rows)).toBe("reserved");
    expect(nameIssue("work", rows)).toBe("taken");
    expect(nameIssue("work", rows, "work")).toBeUndefined();
    expect(nameIssue("work_2", rows)).toBeUndefined();
    expect(nameProblem("work", rows)).toMatch(/a clone never replaces a profile/);
  });

  it("renames a profile, and sets only a display name for default", async () => {
    const { server, api } = await signedIn();
    expect(await api.rename("work", "coder")).toEqual({ name: "coder" });
    expect(Object.keys(server.otherProfiles)).toEqual(["research", "coder"]);
    expect(await api.rename("default", "  Main ")).toEqual({ name: "default", displayName: "Main" });
    expect(server.profileMeta.default.display_name).toBe("Main");
    expect(await failureOf(api.rename("default", " "))).toEqual({ kind: "refused", status: 400, detail: "Display name cannot be empty." });
    expect(await failureOf(api.rename("research", "coder"))).toMatchObject({ kind: "refused", detail: expect.stringMatching(/already exists/) });
    expect(await failureOf(api.rename("gone", "other"))).toMatchObject({ kind: "gone" });
  });

  it("settles a rename whose answer was lost by the list", async () => {
    const { server, api } = await signedIn();
    server.profileRenameLost = "The connection dropped.";
    expect(await api.rename("work", "coder")).toEqual({ name: "coder" });
    server.profileRenameLost = undefined;
    // Lost before Hermes renamed anything: the list still has the old name, so it stays lost.
    server.profileRenameError = new Error("The connection dropped.");
    expect(await failureOf(api.rename("research", "papers"))).toEqual({ kind: "lost", message: "The connection dropped." });
  });

  it("saves a description and a model through their own routes, whichever profile is shown", async () => {
    const { server, api } = await signedIn();
    expect(await api.describe("work", "  Writes code ")).toBe("Writes code");
    expect(server.profileMeta.work).toMatchObject({ description: "Writes code", description_auto: false });
    await api.setModel("research", "openai", "gpt-6.1");
    expect(server.profileModel.research).toMatchObject({ model: "gpt-6.1", provider: "openai" });
    expect(writes(server)).toEqual(["PUT /api/profiles/work/description", "PUT /api/profiles/research/model"]);
  });

  it("has Hermes write a description, or says why it couldn't", async () => {
    const { server, api } = await signedIn();
    expect(await api.describeAuto("work")).toEqual({ ok: true, description: "Writes and reviews code." });
    expect(server.profileMeta.work).toMatchObject({ description_auto: true });
    expect(server.restRequests.find((r) => r.path.endsWith("describe-auto"))?.body).toEqual({ overwrite: true });
    server.describeAuto = { ok: false, reason: "auxiliary client unavailable" };
    expect(await api.describeAuto("work")).toEqual({ ok: false, reason: "auxiliary client unavailable" });
  });

  it("deletes a profile; one already gone and one Hermes is still settling count as deleted; default never goes", async () => {
    const { server, api } = await signedIn();
    expect(await api.remove("work")).toEqual({ kind: "deleted" });
    expect(await api.remove("work")).toEqual({ kind: "alreadyGone" });
    server.profileSettlementPending = "hermes profile delete research --settle";
    expect(await api.remove("research")).toEqual({ kind: "settling", retryCommand: "hermes profile delete research --settle" });
    expect("research" in server.otherProfiles).toBe(false);
    expect(await failureOf(api.remove("default"))).toMatchObject({ kind: "refused" });
    expect(writes(server)).toEqual(["DELETE /api/profiles/work", "DELETE /api/profiles/work", "DELETE /api/profiles/research"]);
  });

  it("counts a profile's chats as Hermes counts them, and leaves out a count it can't read", async () => {
    const { api } = await signedIn();
    expect(await api.chatCount("default")).toBe(0);
    expect(await api.chatCount("Not A Name")).toBeUndefined();
  });

  it("disables only the change whose route the server lacks, and sends it no more", async () => {
    const { server, hermes, api } = await signedIn((s) => s.profileRoutesMissing.add("rename"));
    expect(await failureOf(api.rename("work", "coder"))).toEqual({ kind: "noRoute", action: "rename" });
    await waitFor(() => hermes.capabilities.lacksAction("profiles", "rename"));
    expect(hermes.capabilities.get("profiles").lacking).toEqual(["PATCH /api/profiles/{name}"]);
    expect(await failureOf(api.rename("work", "coder"))).toEqual({ kind: "noRoute", action: "rename" });
    // The second rename never went; deleting, on the same path, still does.
    expect(writes(server)).toEqual(["PATCH /api/profiles/work"]);
    expect(await api.remove("work")).toEqual({ kind: "deleted" });
    expect(hermes.capabilities.get("profiles").state).not.toBe("unsupported");
  });

  it("names a route that's missing for a path with another method as missing too (405)", async () => {
    const { api } = await signedIn((s) => s.profileRoutesMissing.add("remove"));
    expect(await failureOf(api.remove("work"))).toEqual({ kind: "noRoute", action: "remove" });
  });
});

async function waitFor(ok: () => boolean) {
  for (let i = 0; i < 50 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(ok()).toBe(true);
}
