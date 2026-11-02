// @vitest-environment jsdom
// Scheduled jobs against a fake Hermes whose cron routes behave the way the deployed `bf0203a` did when probed with a
// throwaway HERMES_HOME (ADR 0011), including its per-job routes acting on another profile's job.
import { afterEach, describe, expect, it } from "vitest";
import { FakeHermes } from "./fakeHermes";
import { connect, type Hermes } from "./transport";
import { CronConflict, CronError, cronError, statusLabel, type JobFields } from "./cronJobs";

const running: Hermes[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((h) => h.close()));
});

const NOW = Date.parse("2026-11-02T14:00:00-06:00");
const fields = (over: Partial<JobFields> = {}): JobFields => ({ name: "[fixture] Morning check", prompt: "Fixture only.", schedule: "0 9 * * *", deliver: "local", repeat: null, ...over });

async function setUp() {
  const s = new FakeHermes();
  s.cron.now = () => NOW;
  s.otherProfiles = { work: [] };
  s.cron.jobs = { default: [], work: [] };
  const hermes = await connect(s.openPipe);
  running.push(hermes);
  return { s, cron: hermes.cron };
}

/** Lets the list read before the next create through, and fails the one after it, as a connection dropping does. */
function failReadBack(s: FakeHermes) {
  const original = s.cron.route.bind(s.cron);
  let reads = 0;
  s.cron.route = (req) => {
    if (req.method === "GET" && req.path === "/api/cron/jobs" && ++reads === 2) s.cron.failLists = 1;
    return original(req);
  };
}

const writes = (s: FakeHermes) => s.restRequests.filter((r) => r.method !== "GET" && r.path.startsWith("/api/cron"));

describe("listing", () => {
  it("lists the profile's jobs, paused ones too, naming the profile", async () => {
    const { s, cron } = await setUp();
    s.cron.add("default", { name: "Brief", prompt: "p", schedule: "0 9 * * 1-5" });
    s.cron.add("default", { name: "Old", prompt: "p", schedule: "every 2h", paused: true });
    s.cron.add("work", { name: "Theirs", prompt: "p", schedule: "0 9 * * *" });
    const jobs = await cron.list("default");
    expect(jobs.map((j) => [j.name, j.enabled, j.state])).toEqual([
      ["Brief", true, "scheduled"],
      ["Old", false, "paused"],
    ]);
    expect(jobs[0]).toMatchObject({ scheduleText: "0 9 * * 1-5", schedule: { kind: "cron", expr: "0 9 * * 1-5" }, nextRunAt: "2026-11-03T09:00:00-06:00", profile: "default", heartbeatAge: 14 });
    expect(s.restRequests.at(-1)!.query.get("profile")).toBe("default");
  });

  it("says when the server has no scheduled jobs", async () => {
    const { s, cron } = await setUp();
    s.cron.missing = true;
    await expect(cron.list("default")).rejects.toMatchObject({ kind: "unsupported", message: "This Hermes server has no scheduled jobs. Updating Hermes adds them." });
  });

  it("reads the profile's time zone and delivery targets", async () => {
    const { s, cron } = await setUp();
    expect(await cron.timezone("default")).toBe("America/Chicago");
    s.cron.timezone = "";
    expect(await cron.timezone("default")).toBe("");
    expect(await cron.targets("default")).toEqual([
      { id: "local", name: "Local (save only)", ready: true },
      { id: "telegram", name: "Telegram", ready: true },
      { id: "discord", name: "Discord", ready: false },
    ]);
  });

  it("explains run history that isn't kept yet", async () => {
    const { s, cron } = await setUp();
    const job = await cron.create("default", fields(), true);
    s.cron.runsUnavailable = true;
    await expect(cron.runs("default", job)).rejects.toMatchObject({ kind: "unavailable" });
    s.cron.runsUnavailable = false;
    // As the deployed server answered for a script fixture's run.
    const doc = "# Cron Job: [fixture] ticker **Job ID:** 7826604d2706 **Run Time:** 2026-11-02 14:39:36 **Mode:** no_agent (script) --- fixture ran at 2026-11-02T20:39:36Z";
    s.cron.runs[job.id] = [
      { id: "cron_output:x:1", title: `COMPLETED · ${doc}`, preview: doc, source: "cron_output", started_at: 1_793_651_976, ended_at: 1_793_651_976, is_active: false },
      { id: "local-abc", title: "Morning brief", preview: "Summarize…", source: "cron", started_at: 1_793_640_000, ended_at: null, is_active: true, scheduler_owned: true },
    ];
    expect(await cron.runs("default", job)).toEqual([
      { id: "cron_output:x:1", title: "fixture ran at 2026-11-02T20:39:36Z", preview: "fixture ran at 2026-11-02T20:39:36Z", startedAt: 1_793_651_976_000, endedAt: 1_793_651_976_000, running: false, script: true, status: "Completed" },
      { id: "local-abc", title: "Morning brief", preview: "Summarize…", startedAt: 1_793_640_000_000, endedAt: undefined, running: true, script: false },
    ]);
  });
});

describe("creating", () => {
  it("creates a job and returns it as the list has it", async () => {
    const { s, cron } = await setUp();
    const job = await cron.create("default", fields({ repeat: 3 }), false);
    expect(job).toMatchObject({ name: "[fixture] Morning check", repeat: { times: 3, completed: 0 }, enabled: true, profile: "default" });
    expect(writes(s).map((r) => [r.method, r.path, r.body])).toEqual([["POST", "/api/cron/jobs", { name: "[fixture] Morning check", prompt: "Fixture only.", schedule: "0 9 * * *", deliver: "local", repeat: 3 }]]);
  });

  it("creates a job paused, so it won't run until resumed", async () => {
    const { cron } = await setUp();
    expect(await cron.create("default", fields(), true)).toMatchObject({ enabled: false, state: "paused" });
  });

  it("sends one create for a double press", async () => {
    const { s, cron } = await setUp();
    let open!: () => void;
    s.cron.gate = new Promise((r) => (open = r));
    const a = cron.create("default", fields(), false);
    const b = cron.create("default", fields(), false);
    open();
    expect((await a).id).toBe((await b).id);
    expect(writes(s)).toHaveLength(1);
    expect(s.cron.jobs.default).toHaveLength(1);
  });

  it("finds a job whose answer was lost after Hermes saved it, and doesn't create it twice", async () => {
    const { s, cron } = await setUp();
    s.cron.failNext = { match: /^POST \/api\/cron\/jobs$/, when: "after" };
    const job = await cron.create("default", fields(), false);
    expect(job.name).toBe("[fixture] Morning check");
    expect(s.cron.jobs.default).toHaveLength(1);
  });

  it("doesn't send again on the next press when a lost create isn't in the list, since Hermes may still save it", async () => {
    const { s, cron } = await setUp();
    s.cron.failNext = { match: /^POST \/api\/cron\/jobs$/, when: "before" };
    await expect(cron.create("default", fields(), false)).rejects.toThrow(/isn't in the list yet\. Hermes may still save it/);
    const sent = writes(s).length;
    // The next press looks again and warns, sending nothing: a slow server may commit the first one any moment.
    await expect(cron.create("default", fields(), false)).rejects.toThrow(/may still be saved by Hermes/);
    expect(writes(s)).toHaveLength(sent);
    // Pressed once more, the owner has chosen to send it anew.
    await cron.create("default", fields(), false);
    expect(s.cron.jobs.default).toHaveLength(1);
  });

  it("finds a lost create that Hermes saved late, on the next press", async () => {
    const { s, cron } = await setUp();
    s.cron.failNext = { match: /^POST \/api\/cron\/jobs$/, when: "before" };
    await expect(cron.create("default", fields(), false)).rejects.toThrow();
    s.cron.add("default", { ...fields(), schedule: "0 9 * * *" }); // the first POST, committed after the read-back
    const sent = writes(s).length;
    const job = await cron.create("default", fields(), false);
    expect(job.name).toBe("[fixture] Morning check");
    expect(writes(s)).toHaveLength(sent);
    expect(s.cron.jobs.default).toHaveLength(1);
  });

  it("checks the list before sending again when it couldn't be read after a lost answer", async () => {
    const { s, cron } = await setUp();
    s.cron.failNext = { match: /^POST \/api\/cron\/jobs$/, when: "after" };
    failReadBack(s);
    await expect(cron.create("default", fields(), false)).rejects.toThrow(/may have been created/);
    expect(s.cron.jobs.default).toHaveLength(1);
    // Pressing Create again finds the job that was made, and sends nothing.
    const sent = writes(s).length;
    const again = await cron.create("default", fields(), false);
    expect(writes(s)).toHaveLength(sent);
    expect(again.id).toBe(s.cron.jobs.default[0].id);
    expect(s.cron.jobs.default).toHaveLength(1);
  });

  it("refuses to create a second job after an uncertain create of a different one", async () => {
    const { s, cron } = await setUp();
    s.cron.failNext = { match: /^POST \/api\/cron\/jobs$/, when: "after" };
    failReadBack(s);
    await expect(cron.create("default", fields(), false)).rejects.toThrow(/may have been created/);
    await expect(cron.create("default", fields({ prompt: "Fixture, reworded." }), false)).rejects.toThrow(/Your earlier try did create “\[fixture\] Morning check”/);
    expect(s.cron.jobs.default).toHaveLength(1);
  });

  it("shows Hermes's reason when it refuses a schedule, and creates nothing", async () => {
    const { s, cron } = await setUp();
    await expect(cron.create("default", fields({ schedule: "every banana" }), false)).rejects.toMatchObject({ kind: "refused" });
    expect(s.cron.jobs.default).toHaveLength(0);
  });

  it("sends nothing while not connected", async () => {
    const { s, cron } = await setUp();
    s.cron.failNext = { match: /./, when: "before", message: "Not connected to Hermes." };
    await expect(cron.create("default", fields(), false)).rejects.toMatchObject({ kind: "offline" });
    expect(s.cron.jobs.default).toHaveLength(0);
  });
});

describe("editing", () => {
  async function withJob() {
    const t = await setUp();
    const job = await t.cron.create("default", fields(), false);
    return { ...t, job };
  }

  it("sends only the changed fields, keeping the ones this app doesn't show", async () => {
    const { s, cron, job } = await withJob();
    Object.assign(s.cron.jobs.default[0], { model: "fixture-model", skills: ["fixture-skill"], workdir: "/srv/x" });
    const fresh = (await cron.list("default"))[0];
    const saved = await cron.update("default", fresh, { name: "[fixture] Renamed", schedule: "weekdays at 9:30pm", prompt: "Fixture only." });
    expect(writes(s).at(-1)!.body).toEqual({ updates: { name: "[fixture] Renamed", schedule: "weekdays at 9:30pm" } });
    expect(saved).toMatchObject({ id: job.id, name: "[fixture] Renamed", schedule: { kind: "cron", expr: "30 21 * * 1-5" }, model: "fixture-model", skills: ["fixture-skill"], workdir: "/srv/x" });
  });

  it("stops at a change made in another client, and saves over it when asked again", async () => {
    const { s, cron, job } = await withJob();
    s.cron.jobs.default[0].name = "Renamed elsewhere";
    const err = await cron.update("default", job, { prompt: "Mine." }).catch((e) => e);
    expect(err).toBeInstanceOf(CronConflict);
    expect((err as CronConflict).fields).toEqual(["name"]);
    expect(writes(s)).toHaveLength(1);
    const saved = await cron.update("default", (err as CronConflict).job, { prompt: "Mine." });
    expect(saved).toMatchObject({ name: "Renamed elsewhere", prompt: "Mine." });
  });

  it("isn't a conflict when the job was only paused elsewhere", async () => {
    const { s, cron, job } = await withJob();
    s.cron.jobs.default[0].enabled = false;
    await expect(cron.update("default", job, { prompt: "Mine." })).resolves.toMatchObject({ prompt: "Mine." });
  });

  it("decides a lost answer by reading the job back", async () => {
    const { s, cron, job } = await withJob();
    s.cron.failNext = { match: /^PUT /, when: "after" };
    expect(await cron.update("default", job, { name: "Saved anyway" })).toMatchObject({ name: "Saved anyway" });
    s.cron.failNext = { match: /^PUT /, when: "before" };
    const latest = (await cron.list("default"))[0];
    await expect(cron.update("default", latest, { name: "Never sent" })).rejects.toThrow(/weren't saved/);
    expect(s.cron.jobs.default[0].name).toBe("Saved anyway");
  });

  it("reports a refused edit without changing the job", async () => {
    const { s, cron, job } = await withJob();
    await expect(cron.update("default", job, { schedule: "every banana" })).rejects.toBeInstanceOf(CronError);
    expect(s.cron.jobs.default[0].schedule_display).toBe("0 9 * * *");
  });

  it("says the job is gone when another client deleted it", async () => {
    const { s, cron, job } = await withJob();
    s.cron.jobs.default = [];
    await expect(cron.update("default", job, { name: "x" })).rejects.toMatchObject({ kind: "gone" });
  });

  it("keeps the shown repeat limit when the schedule changes kind, instead of Hermes's re-derived one", async () => {
    const { s, cron } = await setUp();
    const job = await cron.create("default", fields({ schedule: "in 2h" }), false);
    expect(job.repeat.times).toBe(1);
    await cron.update("default", job, { schedule: "every 2h", repeat: null });
    expect(writes(s).at(-1)!.body).toEqual({ updates: { schedule: "every 2h", repeat: "forever" } });
    const again = (await cron.list("default"))[0];
    await cron.update("default", again, { schedule: "every 3h", repeat: 4 });
    expect(writes(s).at(-1)!.body).toEqual({ updates: { schedule: "every 3h", repeat: 4 } });
  });

  it("doesn't report a lost schedule edit as saved when another client saved a different one", async () => {
    const { s, cron, job } = await withJob();
    s.cron.failNext = { match: /^PUT /, when: "before" };
    const original = s.cron.route.bind(s.cron);
    s.cron.route = (req) => {
      // Another client sets 15:00 between the failed PUT and the read-back.
      if (req.method === "GET" && writes(s).length === 2) Object.assign(s.cron.jobs.default[0], { schedule: { kind: "cron", expr: "0 15 * * *", display: "0 15 * * *" }, schedule_display: "0 15 * * *" });
      return original(req);
    };
    await expect(cron.update("default", job, { schedule: "0 10 * * *" })).rejects.toThrow(/weren't saved/);
  });

  it("clears a repeat limit with 'forever'", async () => {
    const { s, cron } = await setUp();
    const job = await cron.create("default", fields({ repeat: 5 }), false);
    expect(await cron.update("default", job, { repeat: null })).toMatchObject({ repeat: { times: null } });
    expect(writes(s).at(-1)!.body).toEqual({ updates: { repeat: "forever" } });
  });
});

describe("pausing, resuming, deleting and running", () => {
  it("pauses and resumes, confirmed by the list", async () => {
    const { s, cron } = await setUp();
    const job = await cron.create("default", fields(), false);
    expect(await cron.setPaused("default", job, true)).toMatchObject({ enabled: false, state: "paused" });
    const resumed = await cron.setPaused("default", job, false);
    expect(resumed).toMatchObject({ enabled: true, state: "scheduled", nextRunAt: "2026-11-03T09:00:00-06:00" });
    // Already resumed: nothing to send.
    const sent = writes(s).length;
    await cron.setPaused("default", resumed, false);
    expect(writes(s)).toHaveLength(sent);
  });

  it("settles a lost pause answer from the list", async () => {
    const { s, cron } = await setUp();
    const job = await cron.create("default", fields(), false);
    s.cron.failNext = { match: /\/pause$/, when: "after" };
    expect(await cron.setPaused("default", job, true)).toMatchObject({ enabled: false });
    s.cron.failNext = { match: /\/resume$/, when: "before" };
    await expect(cron.setPaused("default", job, false)).rejects.toThrow(/still paused/);
  });

  it("deletes, confirmed by the job leaving the list", async () => {
    const { s, cron } = await setUp();
    const job = await cron.create("default", fields(), false);
    s.cron.failNext = { match: /^DELETE /, when: "after" };
    await cron.remove("default", job);
    expect(s.cron.jobs.default).toEqual([]);
  });

  it("runs a job now and tells a finished run from one only accepted", async () => {
    const { s, cron } = await setUp();
    const job = await cron.create("default", fields(), true);
    const outcome = await cron.runNow("default", job);
    expect(outcome).toMatchObject({ completed: true, job: { lastStatus: "ok", enabled: true } });
    s.cron.failNext = { match: /\/trigger$/, when: "after" };
    await expect(cron.runNow("default", outcome.job!)).rejects.toThrow(/may still be running the job/);
  });

  it("tells a run whose job then left the list, and one it couldn't read back", async () => {
    const { s, cron } = await setUp();
    const job = await cron.create("default", fields(), false);
    const original = s.cron.route.bind(s.cron);
    s.cron.route = (req) => {
      const handler = original(req);
      if (!req.path.endsWith("/trigger") || !handler) return handler;
      return async () => {
        const answer = await handler();
        s.cron.jobs.default = []; // deleted elsewhere just after the run
        return answer;
      };
    };
    expect(await cron.runNow("default", job)).toEqual({ completed: true });
    s.cron.route = original;
    const next = await cron.create("default", fields({ name: "[fixture] other" }), false);
    s.cron.route = (req) => {
      const handler = original(req);
      if (req.path.endsWith("/trigger")) s.cron.failLists = 1;
      return handler;
    };
    expect(await cron.runNow("default", next)).toMatchObject({ completed: true, unverified: true, job: { id: next.id } });
  });
});

describe("profiles", () => {
  it("never acts on another profile's job, though Hermes's per-job routes would", async () => {
    const { s, cron } = await setUp();
    const theirs = await cron.create("work", fields({ name: "[fixture] Work only" }), true);
    // Hermes resumes work's job when asked in default (`_job_owner_profile`); the app refuses before asking.
    await expect(cron.setPaused("default", theirs, false)).rejects.toMatchObject({ kind: "gone" });
    await expect(cron.remove("default", theirs)).rejects.toMatchObject({ kind: "gone" });
    await expect(cron.runNow("default", theirs)).rejects.toMatchObject({ kind: "gone" });
    await expect(cron.update("default", theirs, { name: "x" })).rejects.toMatchObject({ kind: "gone" });
    expect(writes(s).filter((w) => w.path.includes(theirs.id))).toEqual([]);
    expect(s.cron.jobs.work[0]).toMatchObject({ enabled: false, name: "[fixture] Work only" });
    expect(await cron.list("default")).toEqual([]);
  });

  it("finds copies of a job in other profiles, and says when a delete took a copy", async () => {
    const { s, cron } = await setUp();
    const job = await cron.create("default", fields(), false);
    s.cron.jobs.work.push(structuredClone(s.cron.jobs.default[0])); // Hermes copied it into work
    expect(await cron.copiesOf("default", job.id)).toEqual(["work"]);
    // Another client deletes default's copy as this delete goes: Hermes deletes work's instead.
    const original = s.cron.route.bind(s.cron);
    s.cron.route = (req) => {
      if (req.method === "DELETE") s.cron.jobs.default = [];
      return original(req);
    };
    await expect(cron.remove("default", job)).rejects.toThrow(/deleted the copy of this job in the work profile/);
  });

  it("reads run history only for the profile's own job", async () => {
    const { s, cron } = await setUp();
    const theirs = await cron.create("work", fields(), true);
    await expect(cron.runs("default", theirs)).rejects.toMatchObject({ kind: "gone" });
    const mine = await cron.create("default", fields(), true);
    s.cron.runs[mine.id] = [{ id: "local-x", title: "Run", source: "cron", started_at: 1, profile: "work" }];
    await expect(cron.runs("default", mine)).rejects.toThrow(/copy in another profile/);
  });

  it("keeps an uncertain create's check to its own profile", async () => {
    const { s, cron } = await setUp();
    s.cron.failNext = { match: /^POST \/api\/cron\/jobs$/, when: "before" };
    await expect(cron.create("default", fields(), false)).rejects.toThrow();
    await cron.create("work", fields(), false);
    expect(s.cron.jobs.work).toHaveLength(1);
    expect(s.cron.jobs.default).toHaveLength(0);
  });

  it("refuses an answer stamped with another profile", async () => {
    const { s, cron } = await setUp();
    const job = await cron.create("default", fields(), false);
    // A job id copied into both profiles (Hermes's profile copy) resolves to work if default's copy is gone mid-way.
    s.cron.jobs.work.push({ ...structuredClone(s.cron.jobs.default[0]) });
    const original = s.cron.route.bind(s.cron);
    s.cron.route = (req) => {
      if (req.method === "POST" && req.path.endsWith("/pause")) s.cron.jobs.default = [];
      return original(req);
    };
    await expect(cron.setPaused("default", job, true)).rejects.toThrow(/job in the work profile/);
  });
});

describe("errors and labels", () => {
  it.each([
    ["Not connected to Hermes.", "offline"],
    ["The chat connection is closed.", "offline"],
    ["Can't reach the Hermes dashboard: connection reset", "unknown"],
    ['The dashboard answered 404: {"detail":"Not Found"}', "unsupported"],
    ['The dashboard answered 404: {"detail":"Job not found"}', "gone"],
    ['The dashboard answered 403: {"detail":"Forbidden"}', "forbidden"],
    ["The dashboard sign-in has expired. Sign in again.", "forbidden"],
    ['The dashboard answered 409: {"detail":"Job is already running or was claimed by another scheduler"}', "busy"],
    ['The dashboard answered 400: {"detail":"Invalid duration: \'banana\'."}', "refused"],
    ['The dashboard answered 500: {"detail":"boom"}', "unknown"],
    ["Hermes Chat doesn't relay POST api/cron/jobs.", "unsupported"],
  ])("%s → %s", (message, kind) => expect(cronError(new Error(message)).kind).toBe(kind));

  it("words last statuses", () => {
    expect(statusLabel("ok")).toEqual({ text: "Succeeded", tone: "good" });
    expect(statusLabel("delivery_failed").tone).toBe("warn");
    expect(statusLabel("some_new_state").text).toBe("Some new state");
  });
});

