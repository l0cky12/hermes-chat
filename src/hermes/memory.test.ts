// @vitest-environment jsdom
// Settings → Memory's reads and writes against a fake Hermes that answers `learning.*`, `GET /api/profiles/active` and
// `GET /api/memory` the way the deployed `bf0203a` did when probed with a throwaway home holding synthetic memory
// (research doc "Memory"). Every entry here is synthetic.
import { afterEach, describe, expect, it } from "vitest";
import { FakeHermes } from "./fakeHermes";
import { connect, type Hermes } from "./transport";
import {
  MemoryConflictError,
  MemoryPermissionError,
  MemoryRefusedError,
  MemoryUnsupportedError,
  MemoryUnsureError,
  MemoryUnverifiedError,
  entryProblem,
  pyStrip,
  resourceChars,
} from "./memory";

const running: Hermes[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((h) => h.close()));
});

const FALCON = "Project Falcon uses Postgres 16; migrations live in db/migrations.";
const SHORT = "Owner prefers short answers with a code sample first.";
const SAM = "Name: Sam Example. Works in UTC+1.";

function server() {
  const s = new FakeHermes();
  s.otherProfiles = { research: [] };
  s.memory = {
    default: { memory: [FALCON, SHORT], profile: [SAM] },
    research: { memory: ["Research profile: cite sources as numbered footnotes."], profile: [] },
  };
  return s;
}

async function setUp(s = server()) {
  const hermes = await connect(s.openPipe);
  running.push(hermes);
  return { s, hermes };
}

const learning = (s: FakeHermes) => s.requests.filter((r) => r.method.startsWith("learning."));

describe("loading memory", () => {
  it("reads both files' entries in Hermes's order, with the profile's folder and file sizes", async () => {
    const { s, hermes } = await setUp();
    const view = await hermes.memory.load("default");
    expect(view.profile).toBe("default");
    expect(view.home).toBe("/home/liam/.hermes");
    expect(view.resources.memory.entries.map((e) => e.text)).toEqual([FALCON, SHORT]);
    expect(view.resources.profile.entries.map((e) => e.text)).toEqual([SAM]);
    expect(view.resources.memory.bytes).toBe(new TextEncoder().encode(`${FALCON}\n§\n${SHORT}`).length);
    expect(view.provider).toBeUndefined();
    // Never a `profile` param: the deployed contracts refuse one (4000).
    expect(learning(s).every((r) => !("profile" in r.params))).toBe(true);
    expect(s.restRequests.map((r) => `${r.method} ${r.path}${r.query.size ? `?${r.query}` : ""}`)).toContain("GET /api/memory?profile=default");
  });

  it("reads each entry in full, though the list carries only its first 1,200 characters", async () => {
    const s = server();
    const long = `Runbook: ${"step ".repeat(300)}done.`;
    s.memoryLimit.memory = 5000;
    s.memory.default.memory = [long];
    const { hermes } = await setUp(s);
    const view = await hermes.memory.load("default");
    expect(view.resources.memory.entries[0].text).toBe(long);
  });

  it("is empty for a profile with no memory yet", async () => {
    const s = server();
    s.memory.default = { memory: [], profile: [] };
    const { hermes } = await setUp(s);
    const view = await hermes.memory.load("default");
    expect(view.resources.memory.entries).toEqual([]);
    expect(view.resources.profile.entries).toEqual([]);
  });

  it("names an external memory provider the profile also uses", async () => {
    const s = server();
    s.memoryProvider = "honcho";
    const { hermes } = await setUp(s);
    expect((await hermes.memory.load("default")).provider).toBe("honcho");
  });

  it("says a server without the learning methods can't edit memory", async () => {
    const s = server();
    s.learningMethods = false;
    const { hermes } = await setUp(s);
    const e = await hermes.memory.load("default").catch((x) => x);
    expect(e).toBeInstanceOf(MemoryUnsupportedError);
    expect(e.reason).toBe("server");
    expect(e.message).toMatch(/no memory editing calls/);
  });

  it("starts over when an entry changes between being listed and being read", async () => {
    const s = server();
    let changed = false;
    s.beforeLearning = (method) => {
      if (method === "learning.detail" && !changed) {
        changed = true;
        s.memory.default.memory[1] = "Owner prefers short answers; code first.";
      }
    };
    const { hermes } = await setUp(s);
    const view = await hermes.memory.load("default");
    expect(view.resources.memory.entries.map((e) => e.text)).toEqual([FALCON, "Owner prefers short answers; code first."]);
  });

  it("fails while disconnected", async () => {
    const { s, hermes } = await setUp();
    s.drop();
    await expect(hermes.memory.load("default")).rejects.toThrow(/Not connected/);
  });
});

describe("profile isolation", () => {
  it("refuses a profile other than the one the dashboard runs as, without asking for its memory", async () => {
    const { s, hermes } = await setUp();
    const e = await hermes.memory.load("research").catch((x) => x);
    expect(e).toBeInstanceOf(MemoryUnsupportedError);
    expect(e.reason).toBe("profile");
    expect(e.served).toBe("default");
    expect(e.message).toMatch(/runs as, which is default/);
    // learning.* would have answered with default's memory under research's name.
    expect(learning(s)).toEqual([]);
  });

  it("edits only the served profile's memory, and leaves the others' alone", async () => {
    const { s, hermes } = await setUp();
    const view = await hermes.memory.load("default");
    await hermes.memory.save("default", view.resources.memory.entries[0], "Project Falcon uses Postgres 17.");
    expect(s.memory.default.memory).toEqual(["Project Falcon uses Postgres 17.", SHORT]);
    expect(s.memory.research.memory).toEqual(["Research profile: cite sources as numbered footnotes."]);
  });

  it("won't write if the dashboard now runs as another profile", async () => {
    const { s, hermes } = await setUp();
    const view = await hermes.memory.load("default");
    s.servedProfile = "research";
    const e = await hermes.memory.save("default", view.resources.memory.entries[0], "changed").catch((x) => x);
    expect(e).toBeInstanceOf(MemoryUnsupportedError);
    expect(s.requests.some((r) => r.method === "learning.edit")).toBe(false);
    expect(s.memory.default.memory[0]).toBe(FALCON);
  });

  it("can't tell which profile a dashboard on a custom home runs as, so edits none", async () => {
    const s = server();
    s.servedProfile = "custom";
    const { hermes } = await setUp(s);
    const e = await hermes.memory.load("default").catch((x) => x);
    expect(e.reason).toBe("profile");
    expect(e.message).toMatch(/doesn't say which/);
  });
});

describe("saving an entry", () => {
  it("checks the entry is unchanged, writes it, and reads it back", async () => {
    const { s, hermes } = await setUp();
    const view = await hermes.memory.load("default");
    const before = s.requests.length;
    const { view: after, entry } = await hermes.memory.save("default", view.resources.memory.entries[1], "  Owner prefers short answers.\n");
    expect(entry.text).toBe("Owner prefers short answers.");
    expect(after.resources.memory.entries.map((e) => e.text)).toEqual([FALCON, "Owner prefers short answers."]);
    const sent = s.requests.slice(before).map((r) => r.method);
    expect(sent.indexOf("learning.detail")).toBeLessThan(sent.indexOf("learning.edit"));
    expect(sent.slice(sent.indexOf("learning.edit"))).toContain("learning.frames");
    expect(s.last("learning.edit")!.params).toEqual({ id: view.resources.memory.entries[1].id, content: "Owner prefers short answers." });
  });

  it("finds a conflict before writing when the agent changed the entry meanwhile, and writes nothing", async () => {
    const { s, hermes } = await setUp();
    const view = await hermes.memory.load("default");
    s.memory.default.memory[1] = "Owner wants long answers now.";
    const e = await hermes.memory.save("default", view.resources.memory.entries[1], "My edit").catch((x) => x);
    expect(e).toBeInstanceOf(MemoryConflictError);
    expect(e.view.resources.memory.entries.map((x: { text: string }) => x.text)).toEqual([FALCON, "Owner wants long answers now."]);
    expect(s.requests.some((r) => r.method === "learning.edit")).toBe(false);
    expect(s.memory.default.memory).toEqual([FALCON, "Owner wants long answers now."]);
  });

  it("is a conflict when the entry changes between the check and the write, as Hermes refuses under its lock", async () => {
    const s = server();
    s.beforeLearning = (method) => {
      if (method === "learning.edit") s.memory.default.memory[1] = "Changed by the agent just now.";
    };
    const { hermes } = await setUp(s);
    const view = await hermes.memory.load("default");
    const e = await hermes.memory.save("default", view.resources.memory.entries[1], "My edit").catch((x) => x);
    expect(e).toBeInstanceOf(MemoryConflictError);
    expect(s.memory.default.memory).toEqual([FALCON, "Changed by the agent just now."]);
  });

  it("is a conflict when the entry was removed", async () => {
    const { s, hermes } = await setUp();
    const view = await hermes.memory.load("default");
    s.memory.default.memory = [FALCON];
    const e = await hermes.memory.save("default", view.resources.memory.entries[1], "My edit").catch((x) => x);
    expect(e).toBeInstanceOf(MemoryConflictError);
    expect(e.view.resources.memory.entries).toHaveLength(1);
  });

  it("reports Hermes's refusal when the file would pass its limit, and writes nothing", async () => {
    const { s, hermes } = await setUp();
    const view = await hermes.memory.load("default");
    const e = await hermes.memory.save("default", view.resources.memory.entries[1], "x".repeat(2300)).catch((x) => x);
    expect(e).toBeInstanceOf(MemoryRefusedError);
    expect(e.message).toMatch(/Replacement would put memory at 2,369\/2,200 chars/);
    expect(s.memory.default.memory[1]).toBe(SHORT);
  });

  it("refuses an empty entry and one that would split, before asking Hermes", async () => {
    const { s, hermes } = await setUp();
    const view = await hermes.memory.load("default");
    const n = s.requests.length;
    await expect(hermes.memory.save("default", view.resources.memory.entries[0], " \n ")).rejects.toThrow(/can't be empty/);
    await expect(hermes.memory.save("default", view.resources.memory.entries[0], "one\n§\ntwo")).rejects.toThrow(/several entries/);
    expect(s.requests.length).toBe(n);
  });

  it("says a permission failure is one", async () => {
    const s = server();
    s.learningError = { code: 5000, message: "learning.edit failed: [Errno 13] Permission denied: '/home/liam/.hermes/memories/.mem_x'" };
    const { hermes } = await setUp(s);
    const view = await hermes.memory.load("default");
    const e = await hermes.memory.save("default", view.resources.memory.entries[0], "changed").catch((x) => x);
    expect(e).toBeInstanceOf(MemoryPermissionError);
    expect(s.memory.default.memory[0]).toBe(FALCON);
  });

  it("can't say whether a write made it when the connection drops before Hermes answers", async () => {
    const s = server();
    const { hermes } = await setUp(s);
    const view = await hermes.memory.load("default");
    s.dropOnLearning = "applied";
    const e = await hermes.memory.save("default", view.resources.memory.entries[0], "Postgres 17").catch((x) => x);
    expect(e).toBeInstanceOf(MemoryUnsureError);
    // Hermes did write it; reading again once connected shows so.
    await hermes.reconnect();
    expect((await hermes.memory.load("default")).resources.memory.entries[0].text).toBe("Postgres 17");
  });

  it("says when Hermes reports a save that reading back doesn't show", async () => {
    const s = server();
    s.beforeLearning = (method, params) => {
      // The agent replaces the entry right after Hermes wrote the owner's edit.
      if (method === "learning.frames" && s.memory.default.memory[0] === "Postgres 17") s.memory.default.memory[0] = "Postgres 18 (agent)";
      void params;
    };
    const { hermes } = await setUp(s);
    const view = await hermes.memory.load("default");
    const e = await hermes.memory.save("default", view.resources.memory.entries[0], "Postgres 17").catch((x) => x);
    expect(e).toBeInstanceOf(MemoryUnverifiedError);
    expect(e.view.resources.memory.entries[0].text).toBe("Postgres 18 (agent)");
  });
});

describe("removing an entry", () => {
  it("removes it and reads back that it's gone", async () => {
    const { s, hermes } = await setUp();
    const view = await hermes.memory.load("default");
    const after = await hermes.memory.remove("default", view.resources.profile.entries[0]);
    expect(after.resources.profile.entries).toEqual([]);
    expect(s.memory.default.profile).toEqual([]);
  });

  it("is a conflict when the entry changed meanwhile, and removes nothing", async () => {
    const { s, hermes } = await setUp();
    const view = await hermes.memory.load("default");
    s.memory.default.profile[0] = "Name: Sam Example. Works in UTC+2.";
    await expect(hermes.memory.remove("default", view.resources.profile.entries[0])).rejects.toBeInstanceOf(MemoryConflictError);
    expect(s.memory.default.profile).toEqual(["Name: Sam Example. Works in UTC+2."]);
  });
});

describe("recovering what a save replaced", () => {
  it("keeps what a confirmed save replaced, and saving it puts the entry back", async () => {
    const { s, hermes } = await setUp();
    const view = await hermes.memory.load("default");
    const { entry } = await hermes.memory.save("default", view.resources.memory.entries[0], "Postgres 17");
    const before = hermes.memory.replacedBy("default", entry);
    expect(before).toMatchObject({ text: FALCON, saved: "Postgres 17" });
    expect(typeof before?.savedAt).toBe("number");
    // Restoring is an ordinary checked save, and is itself recoverable.
    const back = await hermes.memory.save("default", entry, before!.text);
    expect(s.memory.default.memory[0]).toBe(FALCON);
    expect(hermes.memory.replacedBy("default", back.entry)?.text).toBe("Postgres 17");
  });

  it("won't save an entry as another entry's exact text, so a restore can't later overwrite the survivor", async () => {
    const s = server();
    s.memory.default.memory = ["First", "Second"];
    const { hermes } = await setUp(s);
    const view = await hermes.memory.load("default");
    const e = await hermes.memory.save("default", view.resources.memory.entries[0], "  Second\n").catch((x) => x);
    expect(e).toBeInstanceOf(MemoryRefusedError);
    expect(e.message).toMatch(/Another entry in MEMORY.md already says exactly this/);
    expect(s.memory.default.memory).toEqual(["First", "Second"]);
    expect(learning(s).some((r) => r.method === "learning.edit")).toBe(false);
    expect(hermes.memory.replacedBy("default", view.resources.memory.entries[1])).toBeUndefined();
  });

  it("offers nothing once the entry changed after the save, or for a save that didn't read back", async () => {
    const s = server();
    const { hermes } = await setUp(s);
    const view = await hermes.memory.load("default");
    const { entry } = await hermes.memory.save("default", view.resources.memory.entries[0], "Postgres 17");
    s.memory.default.memory[0] = "Postgres 18 (agent)";
    const now = (await hermes.memory.load("default")).resources.memory.entries[0];
    expect(hermes.memory.replacedBy("default", now)).toBeUndefined();
    expect(hermes.memory.replacedBy("default", entry)).toBeDefined();

    s.beforeLearning = (method) => {
      if (method === "learning.frames" && s.memory.default.memory[1] === "Short.") s.memory.default.memory[1] = "Long (agent).";
    };
    const short = (await hermes.memory.load("default")).resources.memory.entries[1];
    await expect(hermes.memory.save("default", short, "Short.")).rejects.toBeInstanceOf(MemoryUnverifiedError);
    expect(hermes.memory.replacedBy("default", { ...short, text: "Short." })).toBeUndefined();
  });

  it("keeps nothing for a lost answer or a conflict", async () => {
    const s = server();
    const { hermes } = await setUp(s);
    let view = await hermes.memory.load("default");
    s.memory.default.profile[0] = "Name: Sam Example. Works in UTC+2.";
    await expect(hermes.memory.save("default", view.resources.profile.entries[0], "Name: Sam.")).rejects.toBeInstanceOf(MemoryConflictError);
    view = await hermes.memory.load("default");
    s.dropOnLearning = "applied";
    await expect(hermes.memory.save("default", view.resources.memory.entries[0], "Postgres 17")).rejects.toBeInstanceOf(MemoryUnsureError);
    await hermes.reconnect();
    view = await hermes.memory.load("default");
    for (const e of [...view.resources.memory.entries, ...view.resources.profile.entries]) expect(hermes.memory.replacedBy("default", e)).toBeUndefined();
  });

  it("is kept per profile and file, the latest ten, and not by a new sign-in", async () => {
    const s = server();
    const { hermes } = await setUp(s);
    let entry = (await hermes.memory.load("default")).resources.memory.entries[0];
    for (let i = 1; i <= 11; i++) entry = (await hermes.memory.save("default", entry, `Version ${i}`)).entry;
    expect(hermes.memory.replacedBy("default", entry)?.text).toBe("Version 10");
    expect(hermes.memory.replacedBy("research", entry)).toBeUndefined();
    expect(hermes.memory.replacedBy("default", { ...entry, source: "profile" })).toBeUndefined();
    // The eleventh save pushed out the first, which replaced FALCON.
    expect(hermes.memory.replacedBy("default", { ...entry, text: "Version 1" })).toBeUndefined();
    expect(hermes.memory.replacedBy("default", { ...entry, text: "Version 2" })?.text).toBe("Version 1");
    const again = await connect(s.openPipe);
    running.push(again);
    expect(again.memory.replacedBy("default", entry)).toBeUndefined();
  });
});

describe("entry text", () => {
  it("strips as Python does", () => {
    expect(pyStrip("  hi \x1c")).toBe("hi");
    expect(pyStrip("﻿hi")).toBe("﻿hi");
  });

  it("counts characters as Hermes does, delimiters included", () => {
    expect(resourceChars([{ text: "ab" }, { text: "😀" }])).toBe(2 + 3 + 1);
  });

  it("allows a § inside a line", () => {
    expect(entryProblem("See § 4 of the runbook")).toBeUndefined();
    expect(entryProblem("one\n§")).toMatch(/several/);
  });
});

describe("any profile's memory through the profile-scoped routes (ADR 0118)", () => {
  /** A server with `GET /api/learning/graph` and `/api/learning/node`, as the deployed `f0d94882`. */
  const withRoutes = () => {
    const s = server();
    s.learningRoutes = true;
    return s;
  };
  const rest = (s: FakeHermes) => s.restRequests.filter((r) => r.path.startsWith("/api/learning")).map((r) => `${r.method} ${r.path}?${r.query}`);

  it("reads a profile the dashboard doesn't run as, naming it in every call, and no socket call", async () => {
    const { s, hermes } = await setUp(withRoutes());
    const view = await hermes.memory.load("research");
    expect(view.resources.memory.entries.map((e) => e.text)).toEqual(["Research profile: cite sources as numbered footnotes."]);
    expect(view.home).toBe("/home/liam/.hermes/profiles/research");
    expect(rest(s).every((c) => c.endsWith("profile=research"))).toBe(true);
    expect(learning(s)).toEqual([]);
    expect(hermes.memory.anyProfile()).toBe(true);
  });

  it("edits and removes another profile's entries, checked first and read back, and leaves the served one's alone", async () => {
    const { s, hermes } = await setUp(withRoutes());
    s.memory.research.memory.push("Second research note.");
    let view = await hermes.memory.load("research");
    const saved = await hermes.memory.save("research", view.resources.memory.entries[0], "Research profile: cite sources inline.");
    expect(saved.entry.text).toBe("Research profile: cite sources inline.");
    expect(s.memory.research.memory).toEqual(["Research profile: cite sources inline.", "Second research note."]);
    view = await hermes.memory.remove("research", saved.view.resources.memory.entries[1]);
    expect(s.memory.research.memory).toEqual(["Research profile: cite sources inline."]);
    expect(view.resources.memory.entries).toHaveLength(1);
    expect(s.memory.default.memory).toEqual([FALCON, SHORT]);
    const put = s.restRequests.find((r) => r.method === "PUT")!;
    expect(put.body).toEqual({ id: expect.stringMatching(/^memory:memory:0:[0-9a-f]{12}$/), content: "Research profile: cite sources inline." });
  });

  it("finds a conflict when the entry changed since it was read, and writes nothing", async () => {
    const { s, hermes } = await setUp(withRoutes());
    const view = await hermes.memory.load("research");
    s.memory.research.memory = ["Research profile: changed by the agent."];
    const e = await hermes.memory.save("research", view.resources.memory.entries[0], "mine").catch((x) => x);
    expect(e).toBeInstanceOf(MemoryConflictError);
    expect(s.restRequests.some((r) => r.method === "PUT")).toBe(false);
  });

  it("shows Hermes's own refusal, such as the file's limit", async () => {
    const s = withRoutes();
    s.memoryLimit.memory = 60;
    const { hermes } = await setUp(s);
    const view = await hermes.memory.load("research");
    const e = await hermes.memory.save("research", view.resources.memory.entries[0], "x".repeat(80)).catch((x) => x);
    expect(e).toBeInstanceOf(MemoryRefusedError);
    expect(e.message).toMatch(/Replacement would put memory at 80\/60 chars/);
  });

  it("removes several entries one at a time, leaving one that changed since it was read, then reads back once", async () => {
    const { s, hermes } = await setUp(withRoutes());
    const view = await hermes.memory.load("default");
    const [falcon, short] = view.resources.memory.entries;
    const [sam] = view.resources.profile.entries;
    s.memory.default.memory = [FALCON, "Owner prefers short answers."];
    const r = await hermes.memory.removeMany("default", [falcon, short]);
    expect(r.outcomes.map((o) => [o.entry.text, o.kind])).toEqual([
      [FALCON, "removed"],
      [SHORT, "changed"],
    ]);
    expect(s.memory.default.memory).toEqual(["Owner prefers short answers."]);
    expect(r.view!.resources.memory.entries.map((e) => e.text)).toEqual(["Owner prefers short answers."]);
    expect(s.memory.default.profile).toEqual([SAM]);
    expect(sam.text).toBe(SAM);
  });

  it("says which of several removals Hermes refused", async () => {
    const { s, hermes } = await setUp(withRoutes());
    const view = await hermes.memory.load("default");
    s.learningRestRefusal = { status: 400, detail: "MEMORY.md is locked by another process" };
    const r = await hermes.memory.removeMany("default", view.resources.memory.entries);
    expect(r.outcomes.map((o) => o.kind)).toEqual(["failed", "removed"]);
    expect(r.outcomes[0].problem).toBe("MEMORY.md is locked by another process");
    expect(s.memory.default.memory).toEqual([FALCON]);
  });

  it("settles a removal whose answer was lost by reading back, and doesn't try the rest", async () => {
    const { s, hermes } = await setUp(withRoutes());
    const view = await hermes.memory.load("default");
    s.dropOnLearning = "applied";
    const r = await hermes.memory.removeMany("default", view.resources.memory.entries);
    expect(r.outcomes.map((o) => o.kind)).toEqual(["removed", "skipped"]);
    expect(s.memory.default.memory).toEqual([SHORT]);
  });

  it("falls back to the socket calls, for the served profile only, on a server without the routes", async () => {
    const { s, hermes } = await setUp();
    expect((await hermes.memory.load("default")).resources.memory.entries).toHaveLength(2);
    expect(hermes.memory.anyProfile()).toBe(false);
    expect(learning(s).length).toBeGreaterThan(0);
    const e = await hermes.memory.load("research").catch((x) => x);
    expect(e).toBeInstanceOf(MemoryUnsupportedError);
    expect(e.reason).toBe("profile");
  });

  it("says plainly when the profile isn't on the server", async () => {
    const { hermes } = await setUp(withRoutes());
    const e = await hermes.memory.load("nobody").catch((x) => x);
    expect(e.message).toMatch(/Hermes has no such profile: Profile 'nobody' does not exist/);
  });
});
