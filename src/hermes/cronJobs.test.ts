// @vitest-environment jsdom
// Scheduled jobs against a fake Hermes whose cron routes behave the way the deployed `bf0203a` did when probed with a
// throwaway HERMES_HOME (ADR 0013), including its per-job routes acting on another profile's job.
import { afterEach, describe, expect, it } from "vitest";
import { FakeHermes } from "./fakeHermes";
import { connect, type Hermes } from "./transport";
import { CronApi, CronConflict, CronError, cronError, deliveryProblems, missedRunNote, statusLabel, type JobFields } from "./cronJobs";
import { RestError } from "./pipe";

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

  it("words what Hermes does with a missed run", () => {
    const daily = { kind: "cron" as const, expr: "0 9 * * *", display: "" };
    expect(missedRunNote(daily, 86_400_000, true)).toMatch(/up to 2 hours late\. Later than that, the runs it missed become one run/);
    expect(missedRunNote({ kind: "interval", minutes: 10, display: "" }, 600_000, false)).toMatch(/up to 5 minutes late\. Later than that, Hermes skips it/);
    expect(missedRunNote({ kind: "interval", minutes: 1, display: "" }, 60_000, true)).toMatch(/up to 2 minutes late/);
    expect(missedRunNote({ kind: "once", runAt: 0, display: "" }, undefined, true)).toMatch(/more than 2 minutes later, Hermes doesn't run it/);
  });

  it("reads the profile's time zone and delivery targets", async () => {
    const { s, cron } = await setUp();
    expect(await cron.timezone("default")).toBe("America/Chicago");
    expect(await cron.scheduling("default")).toEqual({ timezone: "America/Chicago", catchUp: true });
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
      { id: "cron_output:x:1", title: "fixture ran at 2026-11-02T20:39:36Z", preview: "fixture ran at 2026-11-02T20:39:36Z", startedAt: 1_793_651_976_000, endedAt: 1_793_651_976_000, state: "succeeded", script: true },
      { id: "local-abc", title: "Morning brief", preview: "Summarize…", startedAt: 1_793_640_000_000, endedAt: undefined, state: "running", script: false, sessionId: "local-abc" },
    ]);
  });
});

describe("run history", () => {
  // Rows as the deployed `bf0203a` answered on a throwaway HERMES_HOME (2026-11-04), its gateway running the jobs
  // with no Hermes Chat process: a script that printed a line, one that exited 3, an agent job with no model set,
  // and the same agent job against a loopback stand-in model.
  const REAL = [
    {
      id: "local-54afb7",
      title: "[fixture] agent · Nov 04 09:37",
      preview: "[IMPORTANT: You are running as a scheduled cron job. DELIVER...",
      source: "cron",
      started_at: 1793806654.122434,
      ended_at: 1793806655.5490303,
      end_reason: "cron_complete",
      is_active: false,
      scheduler_owned: false,
      profile: "default",
      cron_execution_id: "4b6630e5",
    },
    {
      id: "cron_output:c251:2026-11-04_09-35-34",
      title: "COMPLETED · # Cron Job: [fixture] echo **Job ID:** c251bbd77765 **Run Time:** 2026-11-04 09:35:34 **Mode:** no_agent (script) --- [fixture] ok at 15:35:34",
      preview: "# Cron Job: [fixture] echo **Job ID:** c251bbd77765 **Run Time:** 2026-11-04 09:35:34 **Mode:** no_agent (script) --- [fixture] ok at 15:35:34",
      source: "cron_output",
      started_at: 1793806534.0,
      ended_at: 1793806534.0,
      end_reason: null,
      is_active: false,
      scheduler_owned: null,
      profile: null,
    },
    {
      id: "cron_output:5e34:2026-11-04_09-35-34",
      title: "FAILED · Script exited with code 3\nstdout:\n[fixture] about to fail",
      preview: "# Cron Job: [fixture] fails **Job ID:** 5e3452a77317 **Run Time:** 2026-11-04 09:35:34 **Mode:** no_agent (script) **Status:** script failed Script exited with code 3 stdout: [fix…",
      source: "cron_output",
      started_at: 1793806533.0,
      ended_at: 1793806533.0,
      is_active: false,
      scheduler_owned: null,
      profile: null,
    },
    {
      id: "cron_output:3ce9:2026-11-04_09-35-34",
      title: "FAILED · RuntimeError: Cron job '[fixture] agent' has no model configured (job.model=None, HERMES_MODEL='', config.yaml model.default missing or empty).",
      preview: "# Cron Job: 3ce9dfd6d5bd (FAILED) RuntimeError: Cron job '[fixture] agent' has no model configured…",
      source: "cron_output",
      started_at: 1793806532.0,
      ended_at: 1793806532.0,
      is_active: false,
      scheduler_owned: null,
      profile: null,
    },
  ];

  it("tells each run's state from what Hermes recorded, with its error", async () => {
    const { s, cron } = await setUp();
    const job = await cron.create("default", fields(), true);
    s.cron.runs[job.id] = REAL;
    const runs = await cron.runs("default", job);
    expect(runs.map((r) => [r.state, r.error ?? null])).toEqual([
      ["succeeded", null],
      ["succeeded", null],
      ["failed", "Script exited with code 3\nstdout:\n[fixture] about to fail"],
      ["failed", expect.stringMatching(/^RuntimeError: Cron job '\[fixture\] agent' has no model configured/)],
    ]);
    expect(runs[0]).toMatchObject({ sessionId: "local-54afb7", script: false, startedAt: 1793806654.122434 * 1000, endedAt: 1793806655.5490303 * 1000 });
    expect(runs[1]).toMatchObject({ preview: "[fixture] ok at 15:35:34", script: true });
    expect(runs[1].sessionId).toBeUndefined();
  });

  it("says when a run's outcome is unknown, and why", async () => {
    const { s, cron } = await setUp();
    const job = await cron.create("default", fields(), true);
    const at = 1_793_800_000;
    s.cron.runs[job.id] = [
      // Two runs at once: a manual one claimed while the scheduler's was still going.
      { id: "local-a", source: "cron", started_at: at, ended_at: null, is_active: false, scheduler_owned: true, profile: "default" },
      { id: "local-b", source: "cron", started_at: at - 5, ended_at: null, is_active: true, scheduler_owned: false, profile: "default" },
      // Never closed, and no live scheduler owns it: its process died.
      { id: "local-c", source: "cron", started_at: at - 600, ended_at: null, is_active: false, scheduler_owned: false, profile: "default" },
      { id: "local-d", source: "cron", started_at: at - 700, ended_at: at - 650, end_reason: "cron_incomplete_no_output", profile: "default" },
      { id: "local-e", source: "cron", started_at: at - 800, ended_at: at - 790, end_reason: "compression", profile: "default" },
      { id: "local-f", source: "cron", started_at: at - 900, ended_at: at - 890, end_reason: "agent_close", profile: "default" },
      // Output Hermes kept with no ledger record, and the one row it makes from the job when no output survived.
      { id: "cron_output:x:old", title: "plain output", preview: "plain output", source: "cron_output", started_at: at - 1000 },
      { id: "cron_output:x:latest", title: "DELIVERY FAILED · Telegram said no", preview: "Telegram said no", source: "cron_output", started_at: at - 1100 },
      { id: "cron_output:x:odd", title: "SKIPPED BY HOOK · output", source: "cron_output", started_at: at - 1200 },
    ];
    const runs = await cron.runs("default", job);
    expect(runs.map((r) => r.state)).toEqual(["running", "running", "unknown", "failed", "unknown", "unknown", "unknown", "failed", "unknown"]);
    expect(runs[2].note).toMatch(/no end recorded for this run, and no scheduler is running it/);
    expect(runs[3].error).toBe("The run ended without a final reply from the agent.");
    expect(runs[4].note).toMatch(/compressed this run and went on in a new session/);
    expect(runs[5].note).toBe("Hermes recorded the run's end as “agent_close”.");
    expect(runs[6].note).toMatch(/no record of how it ended/);
    // Hermes's own words come after the state's.
    expect(runs[7].error).toBe("The run finished, but delivering its result failed: Telegram said no");
    expect(runs[8].note).toBe("Hermes recorded “Skipped by hook”.");
  });

  it("reads the row Hermes makes from the job when no output survived, with or without its error", async () => {
    const { s, cron } = await setUp();
    const job = await cron.create("default", fields(), true);
    const latest = (title: string, preview?: string) => ({ id: `cron_output:${job.id}:latest`, title, ...(preview && { preview }), source: "cron_output", started_at: 1_793_800_000 });
    const one = async (row: Record<string, unknown>) => {
      s.cron.runs[job.id] = [row];
      return (await cron.runs("default", job))[0];
    };
    // `_list_cron_output_runs`: the status alone when the job has no `last_error`.
    expect(await one(latest("OK"))).toMatchObject({ state: "succeeded" });
    expect(await one(latest("SUPPRESSED"))).toMatchObject({ state: "succeeded", note: "Ran; nothing to deliver." });
    expect(await one(latest("DELIVERY FAILED"))).toMatchObject({ state: "failed", error: "The run finished, but delivering its result failed." });
    expect(await one(latest("ERROR"))).toMatchObject({ state: "failed", error: "Hermes recorded the run as failed, with no reason." });
    expect(await one(latest("BLOCKED CONFIG · Missing API key", "Missing API key"))).toMatchObject({ state: "failed", error: "Blocked by the job's settings: Missing API key" });
    expect(await one(latest("Script-only run"))).toMatchObject({ state: "unknown" });
    // A status named like an object's own machinery is just a status this app doesn't know.
    for (const odd of ["CONSTRUCTOR", "TO STRING", "HAS OWN PROPERTY · x", "PROTO"]) expect(await one(latest(odd))).toMatchObject({ state: "unknown" });
    // An output doc's title is what the script printed, so a shout there isn't a status.
    expect(await one({ id: `cron_output:${job.id}:2026-11-04_09-35-34`, title: "OK", preview: "OK", source: "cron_output", started_at: 1_793_800_000 })).toMatchObject({ state: "unknown", preview: "OK" });
  });

  it("asks for the newest runs a page at a time, as far as Hermes's limit", async () => {
    const { s, cron } = await setUp();
    const job = await cron.create("default", fields(), true);
    s.cron.runs[job.id] = Array.from({ length: 130 }, (_, i) => ({ id: `cron_output:${job.id}:${i}`, title: `COMPLETED · run ${i}`, source: "cron_output", started_at: 1_793_600_000 - i * 60 }));
    expect(await cron.runs("default", job)).toHaveLength(20);
    expect(await cron.runs("default", job, 40)).toHaveLength(40);
    expect((await cron.runs("default", job, 100)).at(-1)!.title).toBe("run 99");
    expect(s.restRequests.filter((r) => r.path.endsWith("/runs")).map((r) => r.query.get("limit"))).toEqual(["20", "40", "100"]);
  });

  it("reads an agent run's reply from its own profile's session", async () => {
    const { s, cron } = await setUp();
    s.transcripts["local-run"] = [
      { role: "user", text: "[IMPORTANT: You are running as a scheduled cron job.] Fixture only.", row_id: 1 },
      { role: "assistant", text: "[fixture] Done.", row_id: 2 },
    ];
    const run = { id: "local-run", title: "", startedAt: 0, state: "succeeded" as const, script: false, sessionId: "local-run" };
    expect(await cron.runResult("default", run)).toEqual({ reply: "[fixture] Done." });
    const read = s.restRequests.at(-1)!;
    expect(read.path).toBe("/api/sessions/local-run/messages");
    expect([read.query.get("profile"), read.query.get("order")]).toEqual(["default", "latest"]);
    await expect(cron.runResult("default", { ...run, sessionId: undefined, script: true })).rejects.toMatchObject({ kind: "refused" });
  });

  it("takes the newest reply from a page in stored order, and refuses another profile's session", async () => {
    // As the deployed server answers `order=latest`: the newest page, oldest row first.
    const page = (profile: string) => ({
      session_id: "local-run",
      profile,
      messages: [
        { id: 7, role: "assistant", content: "First try." },
        { id: 8, role: "tool", content: "{}" },
        { id: 9, role: "assistant", content: [{ type: "text", text: "Final answer." }] },
        { id: 10, role: "assistant", content: "Hidden note.", display_kind: "hidden" },
      ],
    });
    const run = { id: "local-run", title: "", startedAt: 0, state: "succeeded" as const, script: false, sessionId: "local-run" };
    const api = new CronApi(async () => page("default"));
    expect((await api.runResult("default", run)).reply).toBe("Final answer.");
    await expect(new CronApi(async () => page("work")).runResult("default", run)).rejects.toMatchObject({ kind: "unknown", message: expect.stringMatching(/work profile, not default/) });
    await expect(new CronApi(async () => ({ messages: [] })).runResult("default", run)).resolves.toEqual({});
    await expect(
      new CronApi(async () => {
        throw new RestError(404, '{"detail":"Session not found"}');
      }).runResult("default", run),
    ).rejects.toMatchObject({ kind: "gone", message: "This run's session isn't on the server any more." });
  });
});

describe("delivery", () => {
  const targets = [
    { id: "local", name: "Local (save only)", ready: true },
    { id: "telegram", name: "Telegram", ready: true },
    { id: "discord", name: "Discord", ready: false },
    { id: "bot-chat:default", name: "Bot Chat (default)", ready: true },
  ];

  it("says which places Hermes can't deliver a job to", () => {
    for (const ok of ["local", "origin", "all", "telegram", "telegram:-100123", "discord:4242", "bot-chat:default", "local,telegram"]) expect(deliveryProblems(ok, targets)).toEqual([]);
    // `parse_bot_chat_deliver_token`: alone, or with no name, it is the job's own profile; names are normalized.
    for (const own of ["bot-chat", "bot-chat:", "Bot-Chat", "bot-chat:Default", "bot-chat: default "]) expect(deliveryProblems(own, targets)).toEqual([]);
    expect(deliveryProblems("discord", targets)).toEqual(["Discord has no home channel set on the server, so Hermes won't deliver there."]);
    // A platform named alone falls back to the chat the job came from on it.
    expect(deliveryProblems("discord", targets, "discord")).toEqual([]);
    expect(deliveryProblems("slack", targets)).toEqual(["Slack isn't set up on this profile's gateway, so Hermes won't deliver there."]);
    expect(deliveryProblems("home_assistant:abc", targets)).toEqual(["Home Assistant isn't set up on this profile's gateway, so Hermes won't deliver there."]);
    expect(deliveryProblems("bot-chat:gone", targets)).toEqual(["Bot Chat (gone) isn't a profile on this server, so Hermes won't deliver there."]);
    expect(deliveryProblems("telegram, slack", targets)).toHaveLength(1);
  });

  it("reads the job's origin platform", async () => {
    const { s, cron } = await setUp();
    const row = s.cron.add("default", { name: "From Discord", prompt: "p", schedule: "0 9 * * *", deliver: "discord" });
    row.origin = { platform: "discord", chat_id: "42" };
    expect((await cron.list("default"))[0]).toMatchObject({ deliver: "discord", originPlatform: "discord" });
  });
});

describe("permission failures and overlapping runs", () => {
  it("says the dashboard refused, and changes nothing, when it doesn't allow a write", async () => {
    const { s, cron } = await setUp();
    s.cron.failNext = { match: /^POST /, when: "before", message: new RestError(403, '{"detail":"Forbidden"}') };
    await expect(cron.create("default", fields(), false)).rejects.toMatchObject({ kind: "forbidden", message: "The dashboard doesn't allow this: Forbidden" });
    expect(s.cron.jobs.default).toHaveLength(0);
    // A refusal is certain, so the next press sends at once instead of warning about a job that may exist.
    await cron.create("default", fields(), false);
    expect(s.cron.jobs.default).toHaveLength(1);
    const job = (await cron.list("default"))[0];
    s.cron.failNext = { match: /pause$/, when: "before", message: new RestError(403, '{"detail":"Forbidden"}') };
    await expect(cron.setPaused("default", job, true)).rejects.toMatchObject({ kind: "forbidden" });
    expect(s.cron.jobs.default[0].enabled).toBe(true);
  });

  it("says a reading the dashboard refuses is refused, not missing", async () => {
    const { s, cron } = await setUp();
    const route = s.cron.route.bind(s.cron);
    s.cron.route = (req) => (req.path === "/api/cron/jobs" ? () => Promise.reject(new RestError(403, '{"detail":"Not allowed for this user"}')) : route(req));
    await expect(cron.list("default")).rejects.toMatchObject({ kind: "forbidden", message: "The dashboard doesn't allow this: Not allowed for this user" });
  });

  it("doesn't start a second run while one is under way", async () => {
    const { s, cron } = await setUp();
    const job = await cron.create("default", fields(), false);
    s.cron.failNext = { match: /trigger$/, when: "before", message: new RestError(409, '{"detail":"Job is already running or was claimed by another scheduler"}') };
    await expect(cron.runNow("default", job)).rejects.toMatchObject({ kind: "busy", message: "This job is running already. Its result shows here once it finishes." });
    expect(s.cron.jobs.default[0].last_run_at).toBeNull();
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

  it("checks a lost one-shot edit by its instant, not only Hermes's label", async () => {
    const { s, cron, job } = await withJob();
    s.cron.failNext = { match: /^PUT /, when: "before" };
    const original = s.cron.route.bind(s.cron);
    s.cron.route = (req) => {
      // Another client saves 15:00 at +05:30 between the failed PUT and the read-back: the same label, 5½ hours off.
      if (req.method === "GET" && writes(s).length === 2)
        Object.assign(s.cron.jobs.default[0], { schedule: { kind: "once", run_at: "2026-11-05T15:00:00+05:30", display: "once at 2026-11-05 15:00" }, schedule_display: "once at 2026-11-05 15:00" });
      return original(req);
    };
    await expect(cron.update("default", job, { schedule: "2026-11-05T15:00:00Z" })).rejects.toThrow(/weren't saved/);
  });

  it("accepts a lost one-shot edit that Hermes saved, reading a time without an offset in the profile's zone", async () => {
    const { s, cron, job } = await withJob();
    s.cron.failNext = { match: /^PUT /, when: "after" };
    expect(await cron.update("default", job, { schedule: "2026-11-05T15:00" })).toMatchObject({ schedule: { kind: "once", runAt: Date.parse("2026-11-05T15:00:00-06:00") } });
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

  it("doesn't show unstamped script runs from another profile's copy when this job went meanwhile", async () => {
    const { s, cron } = await setUp();
    const job = await cron.create("default", fields(), true);
    s.cron.jobs.work.push(structuredClone(s.cron.jobs.default[0]));
    s.cron.runs[job.id] = [{ id: "cron_output:x:1", title: "COMPLETED · work's output", source: "cron_output", started_at: 1 }];
    const original = s.cron.route.bind(s.cron);
    s.cron.route = (req) => {
      if (req.path.endsWith("/runs")) s.cron.jobs.default = []; // deleted elsewhere: Hermes answers with work's copy
      return original(req);
    };
    await expect(cron.runs("default", job)).rejects.toMatchObject({ kind: "gone" });
  });

  it("claims a copy was deleted only when its profile was read and lacks it", async () => {
    const { s, cron } = await setUp();
    const job = await cron.create("default", fields(), false);
    s.cron.jobs.work.push(structuredClone(s.cron.jobs.default[0]));
    const original = s.cron.route.bind(s.cron);
    let deleted = false;
    s.cron.route = (req) => {
      if (req.method === "DELETE") deleted = true;
      if (deleted && req.method === "GET" && req.query.get("profile") === "work") return () => Promise.reject(new Error("Can't reach the Hermes dashboard: connection reset"));
      return original(req);
    };
    await cron.remove("default", job);
    expect(s.cron.jobs.work).toHaveLength(1);
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
    [new Error("Not connected to Hermes."), "offline"],
    [new Error("The chat connection is closed."), "offline"],
    [new Error("Can't reach the Hermes dashboard: connection reset"), "unknown"],
    [new RestError(404, '{"detail":"Not Found"}'), "unsupported"],
    [new RestError(404, '{"detail":"Job not found"}'), "gone"],
    [new RestError(403, '{"detail":"Forbidden"}'), "forbidden"],
    [new RestError(401, "", "The dashboard sign-in has expired. Sign in again."), "forbidden"],
    [new RestError(409, '{"detail":"Job is already running or was claimed by another scheduler"}'), "busy"],
    [new RestError(400, '{"detail":"Invalid duration: \'banana\'."}'), "refused"],
    [new RestError(500, '{"detail":"boom"}'), "unknown"],
    [new Error("Hermes Chat doesn't relay POST api/cron/jobs."), "unsupported"],
  ])("%s → %s", (e, kind) => expect(cronError(e).kind).toBe(kind));

  it("words last statuses", () => {
    expect(statusLabel("ok")).toEqual({ text: "Succeeded", tone: "good" });
    expect(statusLabel("delivery_failed").tone).toBe("warn");
    expect(statusLabel("some_new_state").text).toBe("Some new state");
  });
});

