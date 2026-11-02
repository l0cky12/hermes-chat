// Scheduled jobs against a REAL Hermes dashboard: skipped unless HERMES_LIVE_DASHBOARD is set, and refused unless
// every profile on that server lives under /tmp, so it can only run against a throwaway HERMES_HOME. It makes only
// "[fixture]" jobs that deliver locally, runs only a script job it made (the fixture script prints one line), and
// deletes what it made. Set up a server as ADR 0011 describes, then:
//
//   HERMES_LIVE_DASHBOARD=http://127.0.0.2:9339 HERMES_LIVE_USER=fixture HERMES_LIVE_PASSWORD=… \
//   HERMES_LIVE_HOME=/tmp/hcron/home npx vitest run src/hermes/cronJobs.live.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CronApi, CronConflict, type RestFn } from "./cronJobs";
import { parseSchedule } from "./schedule";

// This app's tsconfig has no Node types; vitest runs the file in Node.
declare const process: { env: Record<string, string | undefined> };
const readText = async (path: string): Promise<string> =>
  ((await import(/* @vite-ignore */ "node:fs" as string)) as { readFileSync(p: string, e: string): string }).readFileSync(path, "utf8");

const BASE = process.env.HERMES_LIVE_DASHBOARD;
const HOME = process.env.HERMES_LIVE_HOME ?? "";

/** dashboard REST with the sign-in cookies, failing in the Rust relay's words. */
function dashboard(): RestFn & { raw: RestFn } {
  let cookie = "";
  const send = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(new URL(path, BASE), { method, headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie()) cookie = [...cookie.split("; ").filter((p) => p && !p.startsWith(c.split("=")[0] + "=")), c.split(";")[0]].join("; ");
    return res;
  };
  const rest = async (method: string, path: string, body?: unknown) => {
    if (!cookie) await send("POST", "auth/password-login", { provider: "basic", username: process.env.HERMES_LIVE_USER, password: process.env.HERMES_LIVE_PASSWORD });
    const res = await send(method, path, body);
    const text = await res.text();
    if (!res.ok) throw new Error(`The dashboard answered ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  };
  return Object.assign(rest as RestFn, { raw: rest as RestFn });
}

const fixture = { prompt: "[fixture] Do nothing. This job exists only to test Hermes Chat.", deliver: "local", repeat: null };

describe.skipIf(!BASE)("against a throwaway Hermes", () => {
  const rest = dashboard();
  const cron = new CronApi(rest);

  // Set only once the server is known to be a throwaway; cleanup does nothing without it.
  let safe = false;
  /** The jobs there before this run, by profile: cleanup never touches them. */
  const before = new Map<string, Set<string>>();

  // Every test waits on this: vitest runs none of the suite's tests when its beforeAll throws.
  beforeAll(async () => {
    const { profiles } = (await rest("GET", "api/profiles")) as { profiles: { name: string; path: string }[] };
    const real = profiles.filter((p) => !p.path.startsWith("/tmp/"));
    if (!profiles.length || real.length) throw new Error(`Refusing to run: ${real.map((p) => p.path).join(", ") || "no profiles"} isn't a throwaway home under /tmp.`);
    for (const p of ["default", "fixture-b"]) before.set(p, new Set((await cron.list(p)).map((j) => j.id)));
    safe = true;
  });

  // vitest runs afterAll even when beforeAll threw, so it checks `safe` first. Only jobs this run made, by their names.
  afterAll(async () => {
    if (!safe) return;
    for (const [profile, had] of before) {
      const jobs = await cron.list(profile).catch(() => []);
      for (const j of jobs.filter((j) => !had.has(j.id) && j.name.startsWith("[fixture] live"))) await rest("DELETE", `api/cron/jobs/${j.id}?profile=${profile}`).catch(() => {});
    }
  });

  it("creates, edits, pauses, resumes and deletes, each checked by reading back and on disk", async () => {
    const zone = await cron.timezone("default");
    expect(zone).toBe("America/Chicago");
    const job = await cron.create("default", { ...fixture, name: "[fixture] live weekday", schedule: "0 9 * * 1-5" }, true);
    expect(job).toMatchObject({ enabled: false, state: "paused", profile: "default" });
    // Hermes keeps it in the profile's own store, which its gateway's scheduler reads.
    const onDisk = JSON.parse(await readText(`${HOME}/cron/jobs.json`)).jobs as { id: string }[];
    expect(onDisk.some((j) => j.id === job.id)).toBe(true);

    const resumed = await cron.setPaused("default", job, false);
    expect(resumed.enabled).toBe(true);
    expect(Date.parse(resumed.nextRunAt!)).toBeGreaterThan(Date.now());
    const edited = await cron.update("default", resumed, { name: "[fixture] live renamed", schedule: "weekdays at 9:30pm" });
    expect(edited).toMatchObject({ name: "[fixture] live renamed", schedule: { kind: "cron", expr: "30 21 * * 1-5" } });

    // Another client edits it; a save from the old copy stops.
    await rest.raw("PUT", `api/cron/jobs/${job.id}?profile=default`, { updates: { prompt: `${fixture.prompt} Edited elsewhere.` } });
    const conflict = await cron.update("default", edited, { name: "[fixture] stale" }).catch((e) => e);
    expect(conflict).toBeInstanceOf(CronConflict);
    expect((conflict as CronConflict).fields).toEqual(["prompt"]);

    const paused = await cron.setPaused("default", edited, true);
    expect(paused.enabled).toBe(false);
    await cron.remove("default", paused);
    expect((await cron.list("default")).some((j) => j.id === job.id)).toBe(false);
  });

  it("reads a time in a spring-forward gap as Hermes does", async () => {
    const typed = "2027-03-14T02:30";
    const job = await cron.create("default", { ...fixture, name: "[fixture] live DST gap", schedule: typed }, true);
    expect(job.schedule).toEqual(parseSchedule(typed, "America/Chicago", Date.now()));
    expect(new Date((job.schedule as { runAt: number }).runAt).toISOString()).toBe("2027-03-14T08:30:00.000Z");
    await cron.remove("default", job);
    await expect(cron.create("default", { ...fixture, name: "[fixture] live past", schedule: "2026-11-01T01:30" }, true)).rejects.toMatchObject({ kind: "refused" });
  });

  it("sends one create for a double press, and finds a create whose answer was lost", async () => {
    const before = (await cron.list("default")).length;
    const [a, b] = await Promise.all([1, 2].map(() => cron.create("default", { ...fixture, name: "[fixture] live double", schedule: "every 6h" }, true)));
    expect(a.id).toBe(b.id);
    let lose = true;
    const lossy = new CronApi(async (method, path, body) => {
      const answer = await rest(method, path, body);
      if (method === "POST" && lose) {
        lose = false;
        throw new Error("Can't reach the Hermes dashboard: connection closed before message completed");
      }
      return answer;
    });
    const found = await lossy.create("default", { ...fixture, name: "[fixture] live lost answer", schedule: "every 6h" }, true);
    const jobs = await cron.list("default");
    expect(jobs.filter((j) => j.name === "[fixture] live lost answer")).toHaveLength(1);
    expect(jobs).toHaveLength(before + 2);
    for (const j of [a, found]) await cron.remove("default", j);
  });

  it("keeps to the profile it names, though Hermes's per-job routes don't", async () => {
    const theirs = await cron.create("fixture-b", { ...fixture, name: "[fixture] live B", schedule: "0 9 * * *" }, true);
    expect(theirs.profile).toBe("fixture-b");
    // London, not Chicago: each profile has its own time zone.
    expect(await cron.timezone("fixture-b")).toBe("Europe/London");
    await expect(cron.setPaused("default", theirs, false)).rejects.toMatchObject({ kind: "gone" });
    await expect(cron.remove("default", theirs)).rejects.toMatchObject({ kind: "gone" });
    expect((await cron.list("fixture-b")).find((j) => j.id === theirs.id)).toMatchObject({ enabled: false });
    await cron.remove("fixture-b", theirs);
  });

  it("runs a script fixture now and tells a finished run", async () => {
    const raw = (await rest("POST", "api/cron/jobs?profile=default", { name: "[fixture] live script", schedule: "every 1d", no_agent: true, script: "fixture-echo.sh", deliver: "local", paused: true })) as { id: string };
    const job = (await cron.list("default")).find((j) => j.id === raw.id)!;
    expect(job.noAgent).toBe(true);
    const outcome = await cron.runNow("default", job);
    expect(outcome).toMatchObject({ completed: true, job: { lastStatus: "ok", enabled: true } });
    const runs = await cron.runs("default", outcome.job!).catch((e) => e);
    // Without a session store Hermes can't list runs; with one, the script's output doc is a run.
    if (Array.isArray(runs)) expect(runs[0]?.preview).toMatch(/fixture ran at/);
    else expect(runs).toMatchObject({ kind: "unavailable" });
    await cron.remove("default", outcome.job!);
  });
});
