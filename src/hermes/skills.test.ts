// Settings → Skills' reads and writes, against the fake dashboard (which mirrors `/api/skills*` at the deployed
// `bf0203a`): profile and shared skills, malformed front matter and missing referenced files, conflicts that keep both
// versions, refused and lost writes, traversal names, switches confirmed by reading back, and profile isolation. Every
// skill here is synthetic.
import { afterEach, describe, expect, it } from "vitest";
import { FakeHermes } from "./fakeHermes";
import { connect, type Hermes } from "./transport";
import { merge3 } from "./textEdit";
import { SkillsApi, SkillsError, declaredName, frontmatterName, referencedPaths, safeSkillName, skillProblems, type SkillFile } from "./skills";
import { RestError } from "./pipe";

const running: Hermes[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((h) => h.close()));
});

const skill = (name: string, description: string, body = "## When to Use\n\nWhen asked.\n") => `---\nname: ${name}\ndescription: ${description}\nversion: 1.0.0\nx-custom: {keep: me}\n---\n\n${body}`;
const NOTES = skill("release-notes", "Write release notes from merged PRs.", "## When to Use\n\nSee references/style.md and templates/notes.md.\n");
const HOME = "/home/liam/.hermes";
const SPARE = `${HOME}/profiles/spare`;

async function signedIn() {
  const server = new FakeHermes();
  server.otherProfiles = { spare: [] };
  const s = server.skills;
  s.add("default", { dir: `${HOME}/skills/writing/release-notes`, source: "agent", category: "writing" }, NOTES, { "references/style.md": "Short.", "templates/notes.md": "# Notes" });
  s.add("default", { dir: `${HOME}/skills/github`, source: "bundled" }, skill("github", "Work with GitHub."));
  s.add("default", { dir: "/srv/shared-skills/house-style", source: "external" }, skill("house-style", "The team's house style."));
  s.add("spare", { dir: `${SPARE}/skills/scratch`, source: "agent" }, skill("scratch", "A spare profile's own skill."));
  const hermes = await connect(server.openPipe, "default");
  running.push(hermes);
  return { server, hermes, api: hermes.skills };
}

const calls = (server: FakeHermes) => server.restRequests.filter((r) => r.path.startsWith("/api/skills")).map((r) => `${r.method} ${r.path}?${r.query}`);
const rejection = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as SkillsError);
const LISTED = ["github", "house-style", "release-notes"];

describe("listing skills", () => {
  it("lists the profile's own and shared skills with source, scope and state, its own first, for the profile named", async () => {
    const { server, api } = await signedIn();
    server.skills.disabled.default = new Set(["github"]);
    const view = await api.list("default");
    expect(view.skills).toEqual([
      { name: "release-notes", description: "Write release notes from merged PRs.", category: "writing", enabled: true, source: "agent", scope: "profile" },
      { name: "house-style", description: "The team's house style.", category: undefined, enabled: true, source: "external", scope: "shared" },
      { name: "github", description: "Work with GitHub.", category: undefined, enabled: false, source: "bundled", scope: "profile" },
    ]);
    expect((await api.list("spare")).skills.map((s) => s.name)).toEqual(["scratch"]);
    expect(calls(server)).toEqual(["GET /api/skills?profile=default", "GET /api/skills?profile=spare"]);
  });

  it("names skills a per-platform list keeps off in this app's chats, as Hermes reads those lists", async () => {
    const { server, api } = await signedIn();
    server.skills.platformDisabled.default = { tui: ["release-notes", " github ", "hermes-agent"], desktop: "github", telegram: ["house-style"] };
    const view = await api.list("default");
    expect(view.offFor).toEqual({ "release-notes": ["tui"], github: ["tui", "desktop"] });
    expect(view.platformsRead).toBe(true);
  });

  it("says when the server has no skills route", async () => {
    const { server, api } = await signedIn();
    server.skills.routes = false;
    expect(await rejection(api.list("default"))).toMatchObject({ kind: "unsupported", message: expect.stringContaining("GET /api/skills") });
  });
});

describe("validating an edit", () => {
  it("catches malformed front matter, a rename and leftover merge markers, each with what to do", () => {
    expect(skillProblems(NOTES, "release-notes")).toEqual([]);
    expect(skillProblems("", "x")[0]).toMatch(/can't be empty/);
    expect(skillProblems("name: x\n\nBody", "x")[0]).toMatch(/has to start with front matter/);
    expect(skillProblems("---\nname: x\ndescription: y\nBody\n", "x")[0]).toMatch(/isn't closed/);
    expect(skillProblems("---\ndescription: y\n---\nBody\n", "x")).toEqual([expect.stringContaining("needs a name: field. This skill's is name: x")]);
    expect(skillProblems("---\nname: x\n---\nBody\n", "x")).toEqual([expect.stringContaining("needs a description: field")]);
    expect(skillProblems("---\nname: x\ndescription: y\n---\n  \n", "x")).toEqual([expect.stringContaining("nothing after the front matter")]);
    expect(skillProblems(skill("renamed", "y"), "x")).toEqual([expect.stringContaining('change it back to name: x')]);
    expect(skillProblems(skill("x", "d".repeat(1025)), "x")).toEqual([expect.stringContaining("1,025 characters")]);
    expect(skillProblems(skill("x", "y", "b".repeat(100_001)), "x")).toEqual([expect.stringContaining("at most 100,000")]);
    const merged = merge3("a\nb\nc", "a\nmine\nc", "a\ntheirs\nc").text;
    expect(skillProblems(skill("x", "y", merged), "x")).toEqual([expect.stringContaining("Merge markers")]);
    // Quoted and commented values are read as YAML does; block scalars are left to Hermes's own parse.
    expect(skillProblems(`---\n"name": 'x'  # the id\ndescription: >\n  long\n---\nBody\n`, "x")).toEqual([]);
    expect(frontmatterName("﻿---\nname: \"x\"\n---\n")).toBe("x");
  });

  it("finds the files a body names in the skill's folder, as Hermes's linter does", () => {
    expect(referencedPaths(NOTES)).toEqual(["references/style.md", "templates/notes.md"]);
    expect(referencedPaths(skill("x", "y", "references/*.md, assets/, references/a.md and references/a.md, scripts/run.sh, references/../../../etc/passwd"))).toEqual([
      "references/a.md",
      "references/../../../etc/passwd",
    ]);
  });

  it("checks referenced files on the server, and says which are missing or point outside the folder", async () => {
    const { server, api } = await signedIn();
    const file = await api.read("default", "release-notes", LISTED);
    expect(await api.checkReferences(file, NOTES)).toEqual({ missing: [], outside: [], unchecked: undefined });
    const edit = NOTES.replace("templates/notes.md", "templates/missing.md and assets/logo.png and references/../../secrets.md");
    expect(await api.checkReferences(file, edit)).toEqual({ missing: ["assets/logo.png", "templates/missing.md"], outside: ["references/../../secrets.md"], unchecked: undefined });
    // A server locked to another folder can't list this one: the check says so instead of guessing.
    server.managedFiles.root = "/srv/elsewhere";
    expect((await api.checkReferences(file, NOTES)).unchecked).toMatch(/Couldn.t list .*release-notes\/(references|templates) on the server.*403 Path outside managed files root/);
  });
});

describe("Codex review round 1 regressions", () => {
  it("reads a name given twice as its last, and refuses a name it can't read plainly", () => {
    const twice = "---\nname: x\ndescription: d\nname: y\n---\nBody\n";
    expect(frontmatterName(twice)).toBe("y");
    expect(skillProblems(twice, "x")).toEqual([expect.stringContaining('"y" here but "x" on the server')]);
    for (const odd of ["name: |\n  x", "name: &id x", "name: *id", "name: !!str x", "name: [x]"]) {
      const content = `---\n${odd}\ndescription: d\n---\nBody\n`;
      expect(frontmatterName(content)).toBeNull();
      expect(skillProblems(content, "x")).toEqual([expect.stringContaining("Write the name as one plain line, name: x")]);
    }
  });

  it("won't open a file whose name it can't read, since it can't tell which skill it is", async () => {
    const api = new SkillsApi(async () => ({ name: "x", content: "---\nname: &a other\ndescription: d\n---\nBody\n", path: "/h/skills/x/SKILL.md" }));
    expect(await rejection(api.read("default", "x", ["x", "other"]))).toMatchObject({ kind: "identity", message: expect.stringContaining("doesn't read") });
  });

  it("keeps skills named like Object's own properties apart from the platform lists", async () => {
    const { server, api } = await signedIn();
    server.skills.add("default", { dir: `${HOME}/skills/constructor`, source: "agent" }, skill("constructor", "Odd name."));
    server.skills.add("default", { dir: `${HOME}/skills/toString`, source: "agent" }, skill("toString", "Odd name too."));
    server.skills.platformDisabled.default = { tui: ["constructor", "__proto__"] };
    const view = await api.list("default");
    expect(view.offFor.constructor).toEqual(["tui"]);
    expect(Object.hasOwn(view.offFor, "__proto__")).toBe(false);
    expect(Object.hasOwn(view.offFor, "toString")).toBe(false);
  });

  it("edits a skill listed by its category path, checking the name the file gives itself", async () => {
    const { server, api } = await signedIn();
    server.skills.add("default", { dir: `${HOME}/skills/writing/example`, source: "agent" }, skill("example", "Writing one."));
    server.skills.add("default", { dir: `${HOME}/skills/notes/example`, source: "agent" }, skill("example", "Notes one."));
    const names = (await api.list("default")).skills.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(["writing/example", "notes/example"]));
    const file = await api.read("default", "writing/example", names);
    expect(file.path).toBe(`${HOME}/skills/writing/example/SKILL.md`);
    expect(declaredName(file)).toBe("example");
    const edit = file.content + "More.\n";
    expect(skillProblems(edit, declaredName(file))).toEqual([]);
    expect(await api.save("default", file, edit, names)).toMatchObject({ kind: "saved" });
    expect(server.skills.file(`${HOME}/skills/writing/example`)).toBe(edit);
    expect(server.skills.file(`${HOME}/skills/notes/example`)).toBe(skill("example", "Notes one."));
  });

  it("marks a skill listed by its category path off when a platform list names it by its own name", async () => {
    const { server, api } = await signedIn();
    server.skills.add("default", { dir: `${HOME}/skills/writing/example`, source: "agent" }, skill("example", "Writing one."));
    server.skills.add("default", { dir: `${HOME}/skills/notes/example`, source: "agent" }, skill("example", "Notes one."));
    server.skills.platformDisabled.default = { tui: ["example"], desktop: ["notes/example"] };
    const view = await api.list("default");
    expect(view.offFor["writing/example"]).toEqual(["tui"]);
    expect(view.offFor["notes/example"]).toEqual(["tui", "desktop"]);
    expect(Object.hasOwn(view.offFor, "example")).toBe(false);
  });
});

describe("Codex review round 2 regressions", () => {
  it("won't read a name continued over lines, escaped, or given by a key spelled another way", () => {
    const fm = (yaml: string) => `---\n${yaml}\ndescription: d\n---\nBody\n`;
    expect(frontmatterName(fm("name: x\n  changed"))).toBeNull();
    expect(skillProblems(fm("name: x\n  changed"), "x")).toEqual([expect.stringContaining("Write the name as one plain line")]);
    expect(frontmatterName(fm('name: "a\\u0062"'))).toBeNull();
    expect(frontmatterName(fm('name: "x'))).toBeNull();
    expect(frontmatterName(fm("name: 'it''s'"))).toBe("it's");
    for (const key of ['name: x\n"na\\u006de": y', "name: x\n!!str name: y", "name: x\n&k name: y", "name: x\n<<: *base", "name: x\n? name\n: y"]) {
      expect(frontmatterName(fm(key))).toBeNull();
      expect(skillProblems(fm(key), "x")).toEqual([expect.stringContaining("YAML form Hermes Chat doesn't read")]);
    }
    expect(frontmatterName("---\n{name: x, description: d}\n---\nBody\n")).toBeNull();
  });

  it("matches a platform list by the name a path-listed skill declares, reading only when it must", async () => {
    const { server, api } = await signedIn();
    server.skills.add("default", { dir: `${HOME}/skills/writing/one`, source: "agent" }, skill("example", "Writing one."));
    server.skills.add("default", { dir: `${HOME}/skills/notes/two`, source: "agent" }, skill("example", "Notes one."));
    server.skills.platformDisabled.default = { tui: ["example"] };
    let view = await api.list("default");
    expect(view.skills.map((s) => s.name)).toEqual(expect.arrayContaining(["writing/one", "notes/two"]));
    expect(view.offFor["writing/one"]).toEqual(["tui"]);
    expect(view.offFor["notes/two"]).toEqual(["tui"]);
    // A folder's name isn't a skill's name: "one" names neither.
    server.skills.platformDisabled.default = { tui: ["one"] };
    view = await api.list("default");
    expect(Object.keys(view.offFor)).toEqual([]);
    expect(view.platformsRead).toBe(true);
    // Lists naming only listed skills need no reads.
    server.skills.platformDisabled.default = { tui: ["github"] };
    const before = server.restRequests.length;
    view = await api.list("default");
    expect(server.restRequests.slice(before).filter((r) => r.path === "/api/skills/content")).toEqual([]);
    expect(view.offFor.github).toEqual(["tui"]);
  });

  it("says it couldn't tell when a path-listed skill's file can't be read", async () => {
    const { server, api } = await signedIn();
    server.skills.add("default", { dir: `${HOME}/skills/writing/one`, source: "agent" }, skill("example", "Writing one."));
    server.skills.add("default", { dir: `${HOME}/skills/notes/two`, source: "agent" }, skill("example", "Notes one."));
    server.skills.platformDisabled.default = { tui: ["example"] };
    server.skills.readGate = Promise.reject(new RestError(500, "{\"detail\":\"boom\"}"));
    server.skills.readGate.catch(() => {});
    const view = await api.list("default");
    expect(view.platformsRead).toBe(false);
  });
});

describe("reading a skill", () => {
  it("reads SKILL.md with its path on the server, for the profile named", async () => {
    const { server, api } = await signedIn();
    expect(await api.read("default", "release-notes", LISTED)).toEqual({ name: "release-notes", path: `${HOME}/skills/writing/release-notes/SKILL.md`, content: NOTES });
    expect(await rejection(api.read("default", "scratch", LISTED))).toMatchObject({ kind: "not-found" });
    expect((await api.read("spare", "scratch", ["scratch"])).path).toBe(`${SPARE}/skills/scratch/SKILL.md`);
    expect(calls(server).at(-1)).toBe("GET /api/skills/content?name=scratch&profile=spare");
  });

  it("refuses a name Hermes resolves to another listed skill's file", async () => {
    const { server, api } = await signedIn();
    // A folder named "github" holding another skill, and the github skill living in a folder of another name.
    server.skills.folders.default = [];
    server.skills.add("default", { dir: `${HOME}/skills/github`, source: "agent" }, skill("gh-helper", "Helps with gh."));
    server.skills.add("default", { dir: `${HOME}/skills/vcs/git-hub`, source: "agent" }, skill("github", "Work with GitHub."));
    expect(await rejection(api.read("default", "github", ["gh-helper", "github"]))).toMatchObject({ kind: "identity", message: expect.stringContaining("that file is the gh-helper skill") });
  });

  it("never sends a name that could point outside the skills folders", async () => {
    const { server, api } = await signedIn();
    for (const name of ["../../etc", "a/../b", "/etc/passwd", "a\\b", "a\nb", "", "a//b"]) {
      expect(safeSkillName(name)).toBe(false);
      expect(await rejection(api.read("default", name, LISTED))).toMatchObject({ kind: "identity", unsent: true });
      expect(await rejection(api.setEnabled("default", name, false))).toMatchObject({ kind: "identity", unsent: true });
    }
    expect(calls(server)).toEqual([]);
    expect(safeSkillName("writing/release-notes")).toBe(true);
  });
});

describe("saving a skill", () => {
  const DIR = `${HOME}/skills/writing/release-notes`;
  const edited = NOTES.replace("When asked.", "When asked.").replace("See references", "Always see references");

  it("writes, reads back, keeps unknown front matter and formatting, and remembers what it replaced", async () => {
    const { server, api } = await signedIn();
    const base = await api.read("default", "release-notes", LISTED);
    const r = await api.save("default", base, edited, LISTED);
    expect(r).toMatchObject({ kind: "saved", file: { content: edited }, previous: base });
    expect(server.skills.file(DIR)).toBe(edited);
    expect(server.skills.file(DIR)).toContain("x-custom: {keep: me}");
    expect(api.versionsOf("default", base.path)).toEqual([{ content: NOTES, replacedAt: expect.any(Number) }]);
    expect(api.versionsOf("spare", base.path)).toEqual([]);
    expect(calls(server)).toEqual([
      "GET /api/skills/content?name=release-notes&profile=default",
      "GET /api/skills/content?name=release-notes&profile=default",
      "PUT /api/skills/content?profile=default",
      "GET /api/skills/content?name=release-notes&profile=default",
    ]);
    expect(server.restRequests.find((q) => q.method === "PUT")?.body).toEqual({ name: "release-notes", content: edited });
  });

  it("writes nothing when another client changed the file, and gives back both versions to merge", async () => {
    const { server, api } = await signedIn();
    const base = await api.read("default", "release-notes", LISTED);
    const theirs = NOTES.replace("version: 1.0.0", "version: 1.1.0");
    server.skills.write(DIR, theirs);
    const r = await api.save("default", base, edited, LISTED);
    expect(r).toEqual({ kind: "conflict", server: { ...base, content: theirs } });
    expect(server.skills.file(DIR)).toBe(theirs);
    expect(calls(server).filter((c) => c.startsWith("PUT"))).toEqual([]);
    // The merge keeps both sides' changes; saving it against the server's version then goes through.
    const merged = merge3(base.content, edited, theirs);
    expect(merged.conflicts).toBe(0);
    expect(merged.text).toContain("version: 1.1.0");
    expect(merged.text).toContain("Always see references");
    expect(await api.save("default", (r as { server: SkillFile }).server, merged.text, LISTED)).toMatchObject({ kind: "saved" });
    expect(server.skills.file(DIR)).toBe(merged.text);
  });

  it("reports another write that landed during the save as a change, with what the server has", async () => {
    const { server, api } = await signedIn();
    const base = await api.read("default", "release-notes", LISTED);
    server.skills.afterWrite = () => server.skills.write(DIR, NOTES + "\nTheirs.\n");
    expect(await api.save("default", base, edited, LISTED)).toMatchObject({ kind: "changed", server: { content: NOTES + "\nTheirs.\n" } });
  });

  it("shows Hermes's own refusals, and a denied write, without writing", async () => {
    const { server, api } = await signedIn();
    const base = await api.read("default", "release-notes", LISTED);
    expect(await rejection(api.save("default", base, "---\nname: release-notes\n---\nBody\n", LISTED))).toMatchObject({
      kind: "refused",
      message: expect.stringContaining("Frontmatter must include 'description' field."),
    });
    server.skills.writeRefusal = { status: 400, detail: "Security scan blocked this skill (dangerous findings)" };
    expect(await rejection(api.save("default", base, edited, LISTED))).toMatchObject({ kind: "refused", message: expect.stringContaining("Security scan blocked") });
    server.skills.writeRefusal = { status: 500, detail: "[Errno 30] Read-only file system: '/srv/shared-skills/house-style/SKILL.md'" };
    const shared = await api.read("default", "house-style", LISTED);
    expect(await rejection(api.save("default", shared, shared.content + "More.\n", LISTED))).toMatchObject({ kind: "permission", message: expect.stringContaining("Read-only file system") });
    expect(server.skills.file(DIR)).toBe(NOTES);
    expect(api.versionsOf("default", base.path)).toEqual([]);
  });

  it("settles a lost answer by reading back: saved if Hermes has it, kept to retry if not", async () => {
    const { server, api } = await signedIn();
    const base = await api.read("default", "release-notes", LISTED);
    server.skills.writeLost = "Can't reach the Hermes dashboard: connection reset";
    expect(await api.save("default", base, edited, LISTED)).toMatchObject({ kind: "saved", file: { content: edited } });
    // Answered but not written (a proxy's 502 before Hermes): the old text is still there, so the error stands.
    server.skills.writeLost = undefined;
    server.skills.writeRefusal = { status: 502, detail: "Bad Gateway" };
    const now = await api.read("default", "release-notes", LISTED);
    expect(await rejection(api.save("default", now, NOTES, LISTED))).toMatchObject({ kind: "error", status: 502 });
    expect(server.skills.file(DIR)).toBe(edited);
  });

  it("can't tell when the connection drops during the save and the read-back fails too", async () => {
    let fail = false;
    const files: Record<string, string> = { a: skill("a", "b") };
    const api = new SkillsApi(async (method, path, body) => {
      if (method === "PUT") {
        files.a = (body as { content: string }).content;
        fail = true;
        throw new Error("Can't reach the Hermes dashboard: connection reset");
      }
      if (fail) throw new Error("Not connected to Hermes.");
      return { name: "a", content: files.a, path: "/h/skills/a/SKILL.md" };
    });
    const base = await api.read("default", "a", ["a"]);
    expect(await rejection(api.save("default", base, skill("a", "c"), ["a"]))).toMatchObject({ kind: "error", message: expect.stringMatching(/Couldn't tell whether a was saved.*Your edit is still here/) });
    // Once connected again, saving the same edit finds Hermes already has it.
    fail = false;
    expect(await api.save("default", base, skill("a", "c"), ["a"])).toMatchObject({ kind: "saved" });
  });

  it("refuses to save while disconnected without sending anything", async () => {
    const { server, hermes, api } = await signedIn();
    const base = await api.read("default", "release-notes", LISTED);
    await hermes.close();
    const before = server.restRequests.length;
    expect(await rejection(api.save("default", base, edited, LISTED))).toMatchObject({ kind: "disconnected", unsent: true });
    expect(server.restRequests.length).toBe(before);
  });
});

describe("turning a skill on or off", () => {
  it("writes the switch for the profile named and confirms it by reading the list back", async () => {
    const { server, api } = await signedIn();
    const off = await api.setEnabled("default", "github", false);
    expect(off.confirmed).toBe(true);
    expect(off.view.skills.find((s) => s.name === "github")?.enabled).toBe(false);
    expect([...server.skills.disabled.default]).toEqual(["github"]);
    expect(server.skills.disabled.spare).toBeUndefined();
    expect(server.restRequests.find((q) => q.path === "/api/skills/toggle")).toMatchObject({ query: new URLSearchParams({ profile: "default" }), body: { name: "github", enabled: false } });
    expect((await api.setEnabled("default", "github", true)).confirmed).toBe(true);
  });

  it("says when reading back doesn't show the change, as for an essential skill", async () => {
    const { server, api } = await signedIn();
    server.skills.add("default", { dir: `${HOME}/skills/hermes-agent`, source: "bundled" }, skill("hermes-agent", "Hermes itself."));
    expect(await api.setEnabled("default", "hermes-agent", false)).toMatchObject({ confirmed: false });
  });

  it("settles a lost answer by reading back", async () => {
    const { server, api } = await signedIn();
    server.skills.toggleLost = "Can't reach the Hermes dashboard: timed out";
    expect(await api.setEnabled("default", "github", false)).toMatchObject({ confirmed: true, lost: { kind: "disconnected" } });
  });
});

describe("copying and archiving across profiles (ADR 0118)", () => {
  const row = async (api: SkillsApi, profile: string, name: string) => (await api.list(profile)).skills.find((s) => s.name === name)!;

  it("copies SKILL.md to another profile as a new Local skill in the same category, and reads it back there", async () => {
    const { server, api } = await signedIn();
    const file = await api.copy("default", "spare", await row(api, "default", "release-notes"), LISTED);
    expect(file).toEqual({ name: "release-notes", path: `${SPARE}/skills/writing/release-notes/SKILL.md`, content: NOTES });
    expect(server.skills.file(`${SPARE}/skills/writing/release-notes`)).toBe(NOTES);
    // Only SKILL.md goes: the original's other files stay where they are.
    expect(server.managedFiles.nodes[`${SPARE}/skills/writing/release-notes/references/style.md`]).toBeUndefined();
    expect(server.managedFiles.nodes[`${HOME}/skills/writing/release-notes/references/style.md`]).toBeDefined();
    const post = server.restRequests.find((r) => r.method === "POST" && r.path === "/api/skills")!;
    expect(post.query.get("profile")).toBe("spare");
    expect(post.body).toEqual({ name: "release-notes", content: NOTES, category: "writing" });
    // The source is untouched.
    expect((await api.list("default")).skills.map((s) => s.name)).toContain("release-notes");
    expect((await api.list("spare")).skills.find((s) => s.name === "release-notes")).toMatchObject({ source: "agent", category: "writing" });
  });

  it("passes on Hermes's refusal when the other profile already has a skill by that name, and writes nothing", async () => {
    const { server, api } = await signedIn();
    server.skills.add("spare", { dir: `${SPARE}/skills/github`, source: "bundled" }, skill("github", "The spare profile's own copy."));
    const e = await rejection(api.copy("default", "spare", await row(api, "default", "github"), LISTED));
    expect(e).toBeInstanceOf(SkillsError);
    expect(e!.kind).toBe("refused");
    expect(e!.message).toContain("A skill named 'github' already exists");
    expect(server.skills.file(`${SPARE}/skills/github`)).toContain("The spare profile's own copy.");
  });

  it("settles a copy whose answer was lost by reading it back from the other profile", async () => {
    const { server, api } = await signedIn();
    server.skills.createLost = "Can't reach the Hermes dashboard: connection reset";
    const file = await api.copy("default", "spare", await row(api, "default", "house-style"), LISTED);
    expect(file.path).toBe(`${SPARE}/skills/house-style/SKILL.md`);
  });

  it("refuses a name Hermes wouldn't take for a new skill before sending it", async () => {
    const { server, api } = await signedIn();
    server.skills.add("default", { dir: `${HOME}/skills/Loud`, source: "agent" }, skill("Loud", "Capital letters."));
    const before = server.restRequests.filter((r) => r.method === "POST").length;
    const e = await rejection(api.copy("default", "spare", await row(api, "default", "Loud"), [...LISTED, "Loud"]));
    expect(e!.kind).toBe("refused");
    expect(e!.unsent).toBe(true);
    expect(server.restRequests.filter((r) => r.method === "POST").length).toBe(before);
  });

  it("refuses to copy or move a skill whose category Hermes wouldn't take for a new one, rather than drop the category", async () => {
    const { server, api } = await signedIn();
    server.learningRoutes = true;
    server.skills.add("default", { dir: `${HOME}/skills/DevOps/deploy`, source: "agent", category: "DevOps" }, skill("deploy", "Deploy."));
    const e = await rejection(api.copy("default", "spare", await row(api, "default", "deploy"), [...LISTED, "deploy"]));
    expect(e!.kind).toBe("refused");
    expect(e!.unsent).toBe(true);
    expect(e!.message).toContain(`the category "DevOps"`);
    expect(server.restRequests.some((r) => r.method === "POST")).toBe(false);
    expect((await api.list("spare")).skills.map((s) => s.name)).not.toContain("deploy");
  });

  it("archives a Local skill, confirmed by its going from the list read back", async () => {
    const { server, api } = await signedIn();
    server.learningRoutes = true;
    const view = await api.archive("default", "release-notes");
    expect(view.skills.map((s) => s.name)).not.toContain("release-notes");
    expect(server.skills.archived.default.map((s) => s.dir)).toEqual([`${HOME}/skills/writing/release-notes`]);
    const del = server.restRequests.find((r) => r.method === "DELETE")!;
    expect(`${del.path}?${del.query}`).toBe("/api/learning/node?profile=default");
    expect(del.body).toEqual({ id: "release-notes" });
  });

  it("passes on Hermes's refusal to archive a built-in, Skills Hub, external or pinned skill", async () => {
    const { server, api } = await signedIn();
    server.learningRoutes = true;
    server.skills.pinned.spare = new Set(["scratch"]);
    expect((await rejection(api.archive("default", "github")))!.message).toContain("is a bundled built-in");
    expect((await rejection(api.archive("default", "house-style")))!.message).toContain("external skills are read-only");
    expect((await rejection(api.archive("spare", "scratch")))!.message).toContain("is pinned");
    expect((await api.list("default")).skills).toHaveLength(3);
  });

  it("never sends a name Hermes would read as a memory entry, or one that leaves the skills folders", async () => {
    const { server, api } = await signedIn();
    for (const name of ["memory:memory:0:0123456789ab", "../x"]) expect((await rejection(api.archive("default", name)))!.unsent).toBe(true);
    expect(server.restRequests.some((r) => r.method === "DELETE")).toBe(false);
  });

  it("never archives a skill listed by its path, which Hermes finds only by the name it declares", async () => {
    const { server, api } = await signedIn();
    server.learningRoutes = true;
    const e = await rejection(api.archive("default", "writing/release-notes"));
    expect(e!.kind).toBe("refused");
    expect(e!.unsent).toBe(true);
    expect(server.restRequests.some((r) => r.method === "DELETE")).toBe(false);
  });

  it("keeps switching and editing skills on a server whose copy route is missing", async () => {
    const { server, hermes, api } = await signedIn();
    server.skills.createRoute = false;
    const e = await rejection(api.copy("default", "spare", await row(api, "default", "release-notes"), LISTED));
    expect(e!.kind).toBe("unsupported");
    expect(hermes.capabilities.get("skills").state).not.toBe("unsupported");
    const r = await api.setEnabled("default", "github", false);
    expect(r.confirmed).toBe(true);
  });

  it("says a server without the archive route can't archive, and changes nothing", async () => {
    const { server, api } = await signedIn();
    expect(server.learningRoutes).toBe(false);
    const e = await rejection(api.archive("default", "release-notes"));
    expect(e!.kind).toBe("unsupported");
    expect(e!.message).toContain("DELETE /api/learning/node");
    expect((await api.list("default")).skills.map((s) => s.name)).toContain("release-notes");
  });
});
