import { describe, expect, it } from "vitest";
import { CAPABILITIES } from "./capabilities";
import {
  compareVersions,
  EXTENSION_API,
  installStatus,
  type Manifest,
  type ManifestProblem,
  parseManifest,
  planUpdate,
  type Version,
} from "./extensionManifest";
import type { Permission } from "./extensionPermissions";

const GOOD = {
  manifest: 1,
  id: "dev.example.chat-stats",
  name: "Chat stats",
  version: "1.0.0",
  api: 1,
  main: "main.js",
  commands: [{ name: "stats", description: "Count this chat's messages and words" }],
  views: [{ id: "stats", title: "Chat stats" }],
  permissions: ["chat.read"],
  needs: ["chat"],
};

const text = (over: Record<string, unknown> = {}, drop: string[] = []) => {
  const o: Record<string, unknown> = { ...GOOD, ...over };
  for (const k of drop) delete o[k];
  return JSON.stringify(o);
};

const problem = (t: string): ManifestProblem | undefined => {
  const r = parseManifest(t);
  return r.ok ? undefined : r.problem;
};

const manifest = (over: Record<string, unknown> = {}, drop: string[] = []): Manifest => {
  const r = parseManifest(text(over, drop));
  if (!r.ok) throw new Error(`fixture refused: ${JSON.stringify(r.problem)}`);
  return r.manifest;
};

const v = (s: string) => s as Version;

describe("parseManifest", () => {
  it("reads the ADR's example", () => {
    expect(parseManifest(text())).toEqual({
      ok: true,
      manifest: {
        manifest: 1,
        id: "dev.example.chat-stats",
        name: "Chat stats",
        version: "1.0.0",
        api: 1,
        main: "main.js",
        commands: [{ name: "stats", description: "Count this chat's messages and words" }],
        views: [{ id: "stats", title: "Chat stats" }],
        permissions: ["chat.read"],
        needs: ["chat"],
      },
    });
  });

  it("defaults the four optional lists to empty", () => {
    const m = manifest({}, ["commands", "views", "permissions", "needs"]);
    expect([m.commands, m.views, m.permissions, m.needs]).toEqual([[], [], [], []]);
  });

  it.each([
    ["not JSON", "{", { kind: "notJson" }],
    ["an array", "[]", { kind: "wrongType", at: "", want: "object" }],
    ["null", "null", { kind: "wrongType", at: "", want: "object" }],
    ["no id", text({}, ["id"]), { kind: "missing", at: "id" }],
    ["no main", text({}, ["main"]), { kind: "missing", at: "main" }],
    ["a numeric name", text({ name: 3 }), { kind: "wrongType", at: "name", want: "string" }],
    ["an object for commands", text({ commands: {} }), { kind: "wrongType", at: "commands", want: "array" }],
    ["a string command", text({ commands: ["stats"] }), { kind: "wrongType", at: "commands[0]", want: "object" }],
    ["a command with no description", text({ commands: [{ name: "a" }] }), { kind: "missing", at: "commands[0].description" }],
  ])("refuses %s", (_, t, expected) => expect(problem(t)).toEqual(expected));

  describe("format", () => {
    it.each([
      ["2", 2],
      ['"1"', "1"],
    ])("refuses manifest %s and says what it found", (_, found) => {
      expect(problem(text({ manifest: found }))).toEqual({ kind: "unknownFormat", found, reads: [1] });
    });

    it("refuses a missing manifest", () => {
      expect(problem(text({}, ["manifest"]))).toEqual({ kind: "unknownFormat", found: undefined, reads: [1] });
    });

    it("reports a format-2 file's format before its unknown keys", () => {
      expect(problem(text({ manifest: 2, homepage: "x" }))).toMatchObject({ kind: "unknownFormat", found: 2 });
    });
  });

  describe("api", () => {
    it("parses another major version, for installStatus to judge", () => {
      expect(manifest({ api: 2 }).api).toBe(2);
    });

    it.each([0, 1.5, "1", -1, null])("refuses api %j", (api) => {
      expect(problem(text({ api }))).toEqual({ kind: "wrongType", at: "api", want: "positive integer" });
    });
  });

  describe("version", () => {
    it.each(["1.0", "01.0.0", "v1.0.0", "1.0.0-", ""])("refuses %j as not semver", (version) => {
      expect(problem(text({ version }))).toEqual({ kind: "badVersion", why: "notSemver" });
    });

    it("refuses build metadata", () => {
      expect(problem(text({ version: "1.0.0+b" }))).toEqual({ kind: "badVersion", why: "buildMetadata" });
    });

    it("refuses upper case", () => {
      expect(problem(text({ version: "1.0.0-RC" }))).toEqual({ kind: "badVersion", why: "upperCase" });
    });

    it("accepts a prerelease", () => {
      expect(manifest({ version: "1.0.0-beta.1" }).version).toBe("1.0.0-beta.1");
    });
  });

  describe("permissions and needs", () => {
    it.each(["chat.send", "fs.read"])("refuses permission %s and names it", (value) => {
      expect(problem(text({ permissions: [value] }))).toEqual({ kind: "unknownPermission", value });
    });

    it("refuses a permission twice", () => {
      expect(problem(text({ permissions: ["chat.read", "storage", "chat.read"] }))).toEqual({
        kind: "duplicate",
        at: "permissions[2]",
        value: "chat.read",
      });
    });

    it("refuses a need the app doesn't have", () => {
      expect(problem(text({ needs: ["nope"] }))).toEqual({ kind: "unknownNeed", value: "nope" });
    });

    it("refuses a need twice", () => {
      expect(problem(text({ needs: ["chat", "chat"] }))).toMatchObject({ kind: "duplicate", value: "chat" });
    });

    it("pins the capability ids, which extensions name in needs", () => {
      expect(
        CAPABILITIES.map((c) => c.id),
        "Capability ids are part of the extension contract (ADR 0126, section 7). Renaming or removing one breaks extensions that name it in `needs`, so it raises EXTENSION_API.",
      ).toEqual([
        "chat",
        "approvals",
        "approvalAnswers",
        "projects",
        "commands",
        "liveSessions",
        "memory",
        "toolsets",
        "toolsetSwitches",
        "persona",
        "profiles",
        "skills",
        "serverFiles",
        "scheduledJobs",
        "automations",
        "outputs",
        "botMode",
        "subagents",
        "subagentRoster",
      ]);
    });
  });

  describe("id", () => {
    it.each([
      ["a device name", "con", "deviceName"],
      ["a device name inside", "dev.nul.x", "deviceName"],
      ["com1", "com1", "deviceName"],
      ["lpt9", "lpt9", "deviceName"],
      ["a device name with an extension-like tail", "dev.aux.txt", "deviceName"],
      ["upper case", "Dev.x", "shape"],
      ["an empty part", "a..b", "shape"],
      ["an empty id", "", "shape"],
      ["65 characters", "a".repeat(65), "shape"],
    ])("refuses %s", (_, id, why) => expect(problem(text({ id }))).toEqual({ kind: "badId", why }));

    it("accepts 64 characters and a name that only starts like a device", () => {
      expect(manifest({ id: "a".repeat(64) }).id).toHaveLength(64);
      expect(manifest({ id: "dev.console" }).id).toBe("dev.console");
    });
  });

  describe("main", () => {
    it.each(["../main.js", "/main.js", "a/../b.js", "a//b.js"])("refuses %j as traversal", (main) => {
      expect(problem(text({ main }))).toEqual({ kind: "badMain", why: "traversal" });
    });

    it.each(["./main.js", "a\\b.js", "C:main.js", "main.js.", ".hidden.js", ""])("refuses %j as a bad shape", (main) => {
      expect(problem(text({ main }))).toEqual({ kind: "badMain", why: "shape" });
    });

    it.each(["nul.txt", "lib/COM1.js", "aux"])("refuses %j as a device name", (main) => {
      expect(problem(text({ main }))).toEqual({ kind: "badMain", why: "deviceName" });
    });

    it.each(["main.js", "lib/main.js"])("accepts %j", (main) => expect(manifest({ main }).main).toBe(main));

    it("refuses more than 8 parts", () => {
      expect(problem(text({ main: "a/b/c/d/e/f/g/h/i.js" }))).toEqual({ kind: "tooMany", at: "main", max: 8 });
    });
  });

  describe("limits and text", () => {
    it("refuses a file over 16 KiB", () => {
      const t = text({ description: "x".repeat(17_000) });
      expect(problem(t)).toEqual({ kind: "tooLarge", bytes: t.length, max: 16_384 });
    });

    it("counts bytes, not characters", () => {
      const t = text({ name: "é".repeat(8_200) });
      expect(problem(t)).toMatchObject({ kind: "tooLarge" });
    });

    it("refuses a 65-character name", () => {
      expect(problem(text({ name: "n".repeat(65) }))).toEqual({ kind: "tooLong", at: "name", max: 64 });
    });

    it("refuses a 201-character description", () => {
      const commands = [{ name: "a", description: "d".repeat(201) }];
      expect(problem(text({ commands }))).toEqual({ kind: "tooLong", at: "commands[0].description", max: 200 });
    });

    it("refuses 21 commands", () => {
      const commands = Array.from({ length: 21 }, (_, i) => ({ name: `c${i}`, description: "d" }));
      expect(problem(text({ commands }))).toEqual({ kind: "tooMany", at: "commands", max: 20 });
    });

    it("refuses 6 views", () => {
      const views = Array.from({ length: 6 }, (_, i) => ({ id: `v${i}`, title: "t" }));
      expect(problem(text({ views }))).toEqual({ kind: "tooMany", at: "views", max: 5 });
    });

    it.each([
      ["a right-to-left override", "Chat‮stats"],
      ["a bidi isolate", "Chat⁦stats"],
      ["a newline", "Chat\nstats"],
      ["a C1 control", "Chat\u0085stats"],
      ["only spaces", "   "],
      ["nothing", ""],
    ])("refuses a name with %s", (_, name) => expect(problem(text({ name }))).toEqual({ kind: "badText", at: "name" }));

    it("refuses a view title with a control character", () => {
      expect(problem(text({ views: [{ id: "a", title: "t‏" }] }))).toEqual({ kind: "badText", at: "views[0].title" });
    });
  });

  describe("unknown keys", () => {
    it("refuses one at the top", () => {
      expect(problem(text({ homepage: "https://example.com" }))).toEqual({ kind: "unknownKey", at: "homepage" });
    });

    it("refuses one in a command, with its path", () => {
      expect(problem(text({ commands: [{ name: "a", description: "d", args: [] }] }))).toEqual({
        kind: "unknownKey",
        at: "commands[0].args",
      });
    });

    it("refuses one in a view", () => {
      expect(problem(text({ views: [{ id: "a", title: "t", icon: "x" }] }))).toEqual({ kind: "unknownKey", at: "views[0].icon" });
    });

    it("refuses __proto__ as a key", () => {
      expect(problem(`{"__proto__":{},${text().slice(1)}`)).toEqual({ kind: "unknownKey", at: "__proto__" });
    });
  });

  describe("command names and view ids", () => {
    it.each(["Stats", "/stats", "st ats", ""])("refuses the command name %j", (name) => {
      expect(problem(text({ commands: [{ name, description: "d" }] }))).toEqual({ kind: "badName", at: "commands[0].name" });
    });

    it("refuses a command twice", () => {
      const commands = [
        { name: "a", description: "d" },
        { name: "a", description: "e" },
      ];
      expect(problem(text({ commands }))).toEqual({ kind: "duplicate", at: "commands[1].name", value: "a" });
    });

    it("refuses a bad view id and a repeated one", () => {
      expect(problem(text({ views: [{ id: "A", title: "t" }] }))).toEqual({ kind: "badName", at: "views[0].id" });
      const views = [
        { id: "a", title: "t" },
        { id: "a", title: "u" },
      ];
      expect(problem(text({ views }))).toEqual({ kind: "duplicate", at: "views[1].id", value: "a" });
    });
  });
});

describe("installStatus", () => {
  it("is usable for the api the app runs", () => {
    expect(EXTENSION_API).toBe(1);
    expect(installStatus(manifest({ api: 1 }))).toEqual({ kind: "usable" });
  });

  it("is incompatible for another api, and says which", () => {
    expect(installStatus(manifest({ api: 2 }))).toEqual({ kind: "incompatible", needsApi: 2, runsApi: 1 });
  });

  it.each(["owner", "failures"] as const)("is disabled when %s disabled it", (why) => {
    expect(installStatus(manifest(), why)).toEqual({ kind: "disabled", why });
  });

  it("says incompatible before disabled", () => {
    expect(installStatus(manifest({ api: 2 }), "owner")).toEqual({ kind: "incompatible", needsApi: 2, runsApi: 1 });
  });
});

describe("compareVersions", () => {
  it.each([
    ["1.0.0-alpha", "1.0.0-alpha.1"],
    ["1.0.0-alpha.1", "1.0.0-beta"],
    ["1.0.0-beta", "1.0.0"],
    ["1.10.0", "2.0.0"],
    ["1.2.3", "1.2.10"],
    ["1.0.0-2", "1.0.0-10"],
    ["1.0.0-2", "1.0.0-a"],
  ])("puts %s below %s", (low, high) => {
    expect(compareVersions(v(low), v(high))).toBe(-1);
    expect(compareVersions(v(high), v(low))).toBe(1);
  });

  it("finds equal versions equal", () => expect(compareVersions(v("1.0.0-rc.1"), v("1.0.0-rc.1"))).toBe(0));
});

describe("planUpdate", () => {
  const installed = (grants: Permission[], over: Record<string, unknown> = {}) => ({
    manifest: manifest({ permissions: ["chat.read", "storage"], ...over }),
    grants,
  });
  const next = (version: string, permissions: string[], over: Record<string, unknown> = {}) =>
    manifest({ version, permissions, ...over });

  it("applies an upgrade that asks for nothing new", () => {
    expect(planUpdate(installed(["chat.read", "storage"]), next("1.1.0", ["chat.read", "storage"]))).toEqual({
      kind: "apply",
      drops: [],
      wipesStorage: false,
    });
  });

  it("holds an upgrade that adds a permission, and names it", () => {
    expect(planUpdate(installed(["chat.read", "storage"]), next("1.1.0", ["chat.read", "storage", "project.read"]))).toEqual({
      kind: "pending",
      asks: ["project.read"],
      drops: [],
      wipesStorage: false,
    });
  });

  it("holds an upgrade that asks again for a withdrawn grant", () => {
    expect(planUpdate(installed(["storage"]), next("1.1.0", ["chat.read", "storage"]))).toEqual({
      kind: "pending",
      asks: ["chat.read"],
      drops: [],
      wipesStorage: false,
    });
  });

  it("applies an upgrade that drops chat.read, and says storage goes", () => {
    expect(planUpdate(installed(["chat.read", "storage"]), next("1.1.0", ["storage"]))).toEqual({
      kind: "apply",
      drops: ["chat.read"],
      wipesStorage: true,
    });
  });

  it("keeps storage when only storage is dropped", () => {
    expect(planUpdate(installed(["chat.read", "storage"]), next("1.1.0", ["chat.read"]))).toEqual({
      kind: "apply",
      drops: ["storage"],
      wipesStorage: false,
    });
  });

  it("compares with the grants the owner holds, not the old manifest", () => {
    expect(planUpdate(installed(["storage"]), next("1.1.0", ["storage"]))).toEqual({
      kind: "apply",
      drops: [],
      wipesStorage: false,
    });
  });

  it("asks before a downgrade, and keeps what it also asks for", () => {
    expect(planUpdate(installed(["chat.read", "storage"], { version: "2.0.0" }), next("1.0.0", ["chat.read", "storage", "chat.draft"]))).toEqual({
      kind: "confirmDowngrade",
      from: "2.0.0",
      to: "1.0.0",
      asks: ["chat.draft"],
      drops: [],
      wipesStorage: false,
    });
  });

  it("refuses the same version", () => {
    expect(planUpdate(installed(["chat.read"]), next("1.0.0", ["chat.read"]))).toEqual({ kind: "refuse", why: "sameVersion" });
  });

  it("refuses another id", () => {
    expect(planUpdate(installed(["chat.read"]), next("2.0.0", ["chat.read"], { id: "dev.other" }))).toEqual({
      kind: "refuse",
      why: "otherId",
    });
  });

  it("refuses a candidate the app can't run", () => {
    expect(planUpdate(installed(["chat.read"]), next("2.0.0", ["chat.read"], { api: 2 }))).toEqual({
      kind: "refuse",
      why: "incompatible",
      needsApi: 2,
      runsApi: 1,
    });
  });
});
