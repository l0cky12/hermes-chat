// Clone profile against the fake dashboard (which mirrors `POST`/`DELETE /api/profiles` at `f0d94882`): picked parts
// only, no API keys unless the full copy is asked for, a taken name refused before anything is written, a server
// failure, a lost answer settled by reading back, skills tried again, and removing what the clone made. All data is
// synthetic.
import { afterEach, describe, expect, it } from "vitest";
import { FakeHermes } from "./fakeHermes";
import { connect, type Hermes } from "./transport";
import { nameProblem, preview, type OnStage, type Outcome, type Part, type Plan, type Stage, type StageState } from "./profileClone";
import { RestError } from "./pipe";

const running: Hermes[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((h) => h.close()));
});

const HOME = "/home/liam/.hermes";
const skill = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

async function signedIn() {
  const server = new FakeHermes();
  server.otherProfiles = { work: [] };
  server.souls = { default: "You are Hermes.\n", work: "You are Work, a terse release engineer.\n" };
  server.profileModel.work = { model: "anthropic/claude-sonnet-4.5", provider: "openrouter", reasoning_effort: "medium", fast: false };
  server.profileMeta.work = { description: "Release engineering agent" };
  server.profileEnv.work = { OPENROUTER_API_KEY: "sk-or-synthetic-91", TELEGRAM_BOT_TOKEN: "000:synthetic" };
  server.memory.work = { memory: ["Work ships on Fridays."], profile: [] };
  server.skills.add("work", { dir: `${HOME}/profiles/work/skills/ops/release-notes`, source: "agent", category: "ops" }, skill("release-notes", "Draft release notes"), {
    "references/template.md": "## Template",
  });
  server.skills.add("work", { dir: `${HOME}/profiles/work/skills/triage`, source: "agent" }, skill("triage", "Sort new issues"));
  server.skills.add("work", { dir: `${HOME}/profiles/work/skills/github`, source: "bundled" }, skill("github", "Work with GitHub"));
  server.cron.jobs.work = [{ id: "nightly", name: "nightly", prompt: "say hi", schedule: { kind: "cron", expr: "0 3 * * *", display: "0 3 * * *" } } as never];
  const hermes = await connect(server.openPipe, "default");
  running.push(hermes);
  return { server, api: hermes.profileClone };
}

function recorder() {
  const seen: string[] = [];
  const onStage: OnStage = (stage: Stage, state: StageState, note?: string) => seen.push(`${stage} ${state}${note ? `: ${note}` : ""}`);
  return { seen, onStage };
}

const fresh = (parts: Part[], name = "work-2"): Plan => ({ kind: "fresh", source: "work", name, parts: new Set(parts) });
const made = (o: Outcome) => {
  if (o.kind !== "made") throw new Error(`expected made, got ${o.kind}: ${"problem" in o ? o.problem : ""}`);
  return o;
};
const stateOf = (o: Outcome, category: string) => made(o).results.find((r) => r.category === category)!;
const creates = (server: FakeHermes) => server.restRequests.filter((r) => r.method === "POST" && r.path === "/api/profiles").map((r) => r.body);

describe("cloning a profile", () => {
  it("makes a fresh profile with only the picked parts, each read back, and no API keys", async () => {
    const { server, api } = await signedIn();
    const source = await api.source("work", api.profiles());
    expect(source.skills.map((s) => s.name)).toEqual(["release-notes", "triage"]);
    const { seen, onStage } = recorder();

    const out = made(await api.clone(fresh(["persona", "model", "skills"]), source, onStage));

    expect(creates(server)).toEqual([{ name: "work-2", soul: "You are Work, a terse release engineer.\n", provider: "openrouter", model: "anthropic/claude-sonnet-4.5" }]);
    expect(server.profileEnv["work-2"]).toEqual({});
    expect(server.souls["work-2"]).toBe("You are Work, a terse release engineer.\n");
    expect(server.skills.folders["work-2"].map((s) => s.dir)).toEqual([`${HOME}/profiles/work-2/skills/ops/release-notes`, `${HOME}/profiles/work-2/skills/triage`]);
    expect(server.memory["work-2"]).toBeUndefined();
    expect(server.cron.jobs["work-2"]).toBeUndefined();
    expect(out.answered).toBe(true);
    expect(out.results.map((r) => `${r.category} ${r.state}`)).toEqual([
      "persona copied",
      "model copied",
      "description left",
      "skills copied",
      "keys left",
      "memory left",
      "never left",
    ]);
    expect(seen).toEqual(["name running", "name done", "create running", "create done", "skills running: 0 of 2", "skills running: 1 of 2", "skills running: 2 of 2", "skills done: 2 of 2 copied", "check running", "check done"]);
  });

  it("leaves out every part not picked, and says what the clone has instead", async () => {
    const { server, api } = await signedIn();
    const source = await api.source("work", api.profiles());
    const out = made(await api.clone(fresh(["description"]), source, () => {}));
    expect(creates(server)).toEqual([{ name: "work-2", description: "Release engineering agent" }]);
    expect(stateOf(out, "description")).toMatchObject({ state: "copied", note: "Release engineering agent" });
    expect(stateOf(out, "persona")).toMatchObject({ state: "left", note: "Not picked: Hermes's default SOUL.md went in" });
    expect(stateOf(out, "skills")).toMatchObject({ state: "left" });
    expect(server.skills.folders["work-2"]).toBeUndefined();
  });

  it("previews what each category does before anything is written, for the fresh clone and the full copy", async () => {
    const { server, api } = await signedIn();
    const source = await api.source("work", api.profiles());
    const safe = preview({ kind: "fresh", parts: new Set<Part>(["persona", "skills"]) }, source);
    expect(safe.persona.copied).toBe(true);
    expect(safe.model.copied).toBe(false);
    expect(safe.skills.note).toBe("release-notes, triage: SKILL.md only, the files beside it stay");
    expect(safe.keys).toMatchObject({ copied: false });
    expect(safe.keys.note).toMatch(/empty \.env/);
    expect(safe.memory.copied).toBe(false);
    const full = preview({ kind: "full" }, source);
    expect(Object.values(full).map((c) => c.copied)).toEqual([true, true, true, true, true, true, false]);
    expect(full.keys.note).toMatch(/every API key/);
    expect(server.restRequests.filter((r) => r.method !== "GET")).toEqual([]);
  });

  it("copies the API keys, memory and skill folders only in the full copy, never bot tokens, chats or jobs", async () => {
    const { server, api } = await signedIn();
    const source = await api.source("work", api.profiles());
    const { seen, onStage } = recorder();
    const out = made(await api.clone({ kind: "full", source: "work", name: "work-full" }, source, onStage));
    expect(creates(server)).toEqual([{ name: "work-full", clone_from: "work", description: "Release engineering agent" }]);
    expect(server.profileEnv["work-full"]).toEqual({ OPENROUTER_API_KEY: "sk-or-synthetic-91" });
    expect(server.memory["work-full"].memory).toEqual(["Work ships on Fridays."]);
    expect(server.cron.jobs["work-full"]).toBeUndefined();
    expect(out.results.map((r) => `${r.category} ${r.state}`)).toEqual([
      "persona copied",
      "model copied",
      "description copied",
      "skills copied",
      "keys unchecked",
      "memory unchecked",
      "never left",
    ]);
    expect(seen).toContain("skills skipped: Hermes copied them with the profile");
  });

  it("doesn't call the full copy's skills read back when the source's skills couldn't be listed", async () => {
    const { server, api } = await signedIn();
    server.skills.routes = false;
    const source = await api.source("work", api.profiles());
    expect(source.skillsProblem).toBeTruthy();
    expect(preview({ kind: "fresh", parts: new Set<Part>(["skills"]) }, source).skills).toMatchObject({ copied: false, available: false });
    const out = made(await api.clone({ kind: "full", source: "work", name: "work-full" }, source, () => {}));
    expect(stateOf(out, "skills").state).toBe("unchecked");
    expect(stateOf(out, "skills").note).toMatch(/^Hermes copied every skill folder. Its skills couldn't be compared with the source's: /);
  });

  it("sends no SOUL.md when the source has none, so Hermes's default goes in, but copies one that is there and empty", async () => {
    const { server, api } = await signedIn();
    delete server.souls.work;
    const none = await api.source("work", api.profiles());
    expect(preview({ kind: "fresh", parts: new Set<Part>(["persona"]) }, none).persona).toMatchObject({ copied: false, available: false });
    const out = made(await api.clone(fresh(["persona"]), none, () => {}));
    expect(creates(server)).toEqual([{ name: "work-2" }]);
    expect(server.souls["work-2"]).toBe("You are Hermes, a helpful assistant.\n");
    expect(stateOf(out, "persona")).toMatchObject({ state: "left", note: "The source has none, so Hermes's default went in" });

    server.souls.work = "";
    const empty = await api.source("work", api.profiles());
    const again = made(await api.clone(fresh(["persona"], "work-3"), empty, () => {}));
    expect(creates(server)[1]).toEqual({ name: "work-3", soul: "" });
    expect(server.souls["work-3"]).toBe("");
    expect(stateOf(again, "persona").state).toBe("copied");
  });

  it("refuses a taken name before writing anything, read again from Hermes, and never replaces a profile", async () => {
    const { server, api } = await signedIn();
    const profiles = await api.profiles();
    expect(nameProblem("work", profiles)).toMatch(/already a profile named work/);
    expect(nameProblem("Work 2", profiles)).toMatch(/lowercase letters/);
    expect(nameProblem("test", profiles)).toMatch(/keeps the name test/);
    expect(nameProblem("default", profiles)).toMatch(/keeps the name default/);
    const source = await api.source("work", api.profiles());
    // Another client makes the name after the dialog read the list.
    server.otherProfiles["late"] = [];
    server.souls.late = "Someone else's.\n";
    const { seen, onStage } = recorder();
    const out = await api.clone(fresh(["persona"], "late"), source, onStage);
    expect(out).toEqual({ kind: "refused", problem: "There's already a profile named late. Pick another name: a clone never replaces a profile." });
    expect(creates(server)).toEqual([]);
    expect(server.souls.late).toBe("Someone else's.\n");
    expect(seen.at(-1)).toMatch(/^name failed/);
  });

  it("shows Hermes's own refusal when the name is taken between the check and the create, and nothing changes", async () => {
    const { server, api } = await signedIn();
    const source = await api.source("work", api.profiles());
    server.profileCreateError = new RestError(400, `{"detail":"A profile named 'work-2' already exists."}`);
    const out = await api.clone(fresh(["persona"]), source, () => {});
    expect(out).toEqual({ kind: "refused", problem: "Hermes didn't create work-2. Hermes said: A profile named 'work-2' already exists." });
    expect(server.otherProfiles["work-2"]).toBeUndefined();
  });

  it("settles a server failure by reading the list: nothing made is said as unsure, and Check again finds it later", async () => {
    const { server, api } = await signedIn();
    const source = await api.source("work", api.profiles());
    server.profileCreateError = new RestError(502, `Bad Gateway`);
    const plan = fresh(["persona"]);
    const out = await api.clone(plan, source, () => {});
    expect(out.kind).toBe("unsure");
    expect(out.kind === "unsure" && out.problem).toMatch(/Hermes answered 502.*doesn't list work-2 now, but it may still be making it/);

    // Hermes finished making it after all.
    server.profileCreateError = undefined;
    server.otherProfiles["work-2"] = [];
    server.souls["work-2"] = source.soul.content;
    const again = made(await api.settle(plan, source, () => {}));
    expect(again.answered).toBe(false);
    expect(stateOf(again, "persona").state).toBe("copied");
  });

  it("goes on after a lost answer when Hermes lists the profile, but doesn't count it as answered", async () => {
    const { server, api } = await signedIn();
    const source = await api.source("work", api.profiles());
    server.profileCreateLost = "Can't reach the Hermes dashboard: connection reset";
    const { seen, onStage } = recorder();
    const out = made(await api.clone(fresh(["persona", "model"]), source, onStage));
    expect(out.answered).toBe(false);
    expect(seen).toContain("create done: Hermes's answer was lost, but it lists the profile now");
    expect(stateOf(out, "model").state).toBe("copied");
  });

  it("writes nothing more to a profile it found after a lost answer, as it may be another client's", async () => {
    const { server, api } = await signedIn();
    const source = await api.source("work", api.profiles());
    server.beforeProfileCreate = () => {
      server.otherProfiles["work-2"] = [];
      server.skills.profiles.add("work-2");
      server.souls["work-2"] = "Another client's.\n";
    };
    server.profileCreateError = "Can't reach the Hermes dashboard: connection reset";
    const before = server.restRequests.length;
    const { seen, onStage } = recorder();
    const out = made(await api.clone(fresh(["persona", "skills"]), source, onStage));
    expect(server.restRequests.slice(before).filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.path}`)).toEqual(["POST /api/profiles"]);
    expect(server.skills.folders["work-2"]).toBeUndefined();
    expect(out).toMatchObject({ answered: false, failedSkills: [] });
    expect(stateOf(out, "skills")).toMatchObject({ state: "failed" });
    expect(stateOf(out, "skills").note).toMatch(/^Not copied: Hermes's answer to the create was lost/);
    expect(stateOf(out, "persona")).toMatchObject({ state: "failed", note: "SOUL.md reads back differently from the source's" });
    expect(seen).toContain("skills skipped: Hermes's answer was lost, so nothing is written to the profile it lists");
  });

  it("reports a model Hermes wouldn't set in Hermes's words, not as copied", async () => {
    const { server, api } = await signedIn();
    const source = await api.source("work", api.profiles());
    server.profileModelError = "Model `anthropic/claude-sonnet-4.5` was not found in this provider's model listing.";
    const out = made(await api.clone(fresh(["persona", "model"]), source, () => {}));
    expect(stateOf(out, "model")).toEqual({
      category: "model",
      state: "failed",
      note: "Hermes didn't set it: Model `anthropic/claude-sonnet-4.5` was not found in this provider's model listing. Pick one in Settings → Model on the new profile.",
    });
    expect(stateOf(out, "persona").state).toBe("copied");
  });

  it("lists a skill that didn't copy, and copies only that one when tried again", async () => {
    const { server, api } = await signedIn();
    const source = await api.source("work", api.profiles());
    server.skills.createRoute = false;
    const plan = fresh(["skills"]);
    const out = made(await api.clone(plan, source, () => {}));
    expect(out.failedSkills.map((f) => f.row.name)).toEqual(["release-notes", "triage"]);
    expect(stateOf(out, "skills").state).toBe("failed");

    server.skills.createRoute = true;
    const before = server.restRequests.length;
    const { seen, onStage } = recorder();
    const again = made(await api.retrySkills(plan, source, out.failedSkills, out.answered, onStage));
    expect(again.failedSkills).toEqual([]);
    expect(stateOf(again, "skills")).toMatchObject({ state: "copied", note: "2 copied, SKILL.md only" });
    expect(server.restRequests.slice(before).filter((r) => r.method === "POST").map((r) => r.path)).toEqual(["/api/skills", "/api/skills"]);
    expect(seen.at(-1)).toBe("check done");
  });

  it("deletes the clone it made, and confirms it's gone", async () => {
    const { server, api } = await signedIn();
    const source = await api.source("work", api.profiles());
    made(await api.clone(fresh(["persona"]), source, () => {}));
    await api.remove("work-2");
    expect(server.otherProfiles["work-2"]).toBeUndefined();
    expect((await api.profiles()).map((p) => p.name)).toEqual(["default", "work"]);
    expect(server.otherProfiles.work).toBeDefined();
  });

  it("leaves the source unchanged when the clone is edited", async () => {
    const { server, api } = await signedIn();
    const hermes = running[0];
    const source = await api.source("work", api.profiles());
    made(await api.clone(fresh(["persona", "skills"]), source, () => {}));
    const soul = await hermes.persona.read("work-2");
    await hermes.persona.save("work-2", soul, "You are the clone.\n");
    expect(server.souls["work-2"]).toBe("You are the clone.\n");
    expect(server.souls.work).toBe("You are Work, a terse release engineer.\n");
    expect(server.skills.file(`${HOME}/profiles/work/skills/triage`)).toBe(skill("triage", "Sort new issues"));
  });
});
