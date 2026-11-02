// Schedules against what Hermes's own scheduler code answers: cronGolden.json is written by tools/cron-golden.py, which
// runs `cron.jobs.parse_schedule` and `compute_next_run` from the deployed checkout with the clock and zone pinned.
import { describe, expect, it } from "vitest";
import golden from "./cronGolden.json";
import {
  ScheduleError,
  clockChangeNote,
  clockChanges,
  explainSchedule,
  formatInstant,
  instantsOf,
  nextCronRun,
  offsetAt,
  parseCron,
  parseSchedule,
  upcomingRuns,
} from "./schedule";

const at = (iso: string) => Date.parse(iso);

describe("next runs, as Hermes's compute_next_run makes them", () => {
  it.each(golden.cron.map((c) => [`${c.zone} ${c.expr} after ${c.base}`, c] as const))("%s", (_, c) => {
    const cron = parseCron(c.expr);
    expect(cron).toBeDefined();
    const runs: number[] = [];
    let after = at(c.base);
    for (const _expected of c.runs) {
      after = nextCronRun(cron!, c.zone, after)!;
      runs.push(after);
    }
    // Hermes writes a skipped wall time with the old offset (2027-03-14T02:30:00-06:00): compare instants.
    expect(runs).toEqual(c.runs.map(at));
  });

  it.each(golden.interval.map((c) => [`${c.zone} every ${c.minutes}m after ${c.base}`, c] as const))("%s", (_, c) => {
    expect(upcomingRuns({ kind: "interval", minutes: c.minutes, display: "" }, c.zone, at(c.base), c.runs.length)).toEqual(c.runs.map(at));
  });

  it("covers both kinds of clock change in the golden data", () => {
    const chicago = golden.cron.find((c) => c.zone === "America/Chicago" && c.expr === "30 2 * * *" && c.base.startsWith("2027-03-14"))!;
    // 2:30 AM doesn't exist on 14 March 2027: Hermes runs it at 3:30 AM CDT, 08:30 UTC.
    expect(new Date(at(chicago.runs[0])).toISOString()).toBe("2027-03-14T08:30:00.000Z");
    const back = golden.cron.find((c) => c.zone === "America/Chicago" && c.expr === "*/15 * * * *" && c.base === "2026-11-01T01:20:00-05:00")!;
    // The repeated hour isn't run again: 1:45 AM CDT is followed by 2:00 AM CST.
    expect(back.runs.slice(1, 3)).toEqual(["2026-11-01T01:45:00-05:00", "2026-11-01T02:00:00-06:00"]);
  });
});

describe("reading schedules, as Hermes's parse_schedule does", () => {
  const strict = new Set(["every 0m", "0m"]); // Hermes takes these; the app refuses them.
  it.each(golden.parse.map((p) => [`${p.zone} ${JSON.stringify(p.input)}`, p] as const))("%s", (_, p) => {
    const now = at(p.now);
    if ("error" in p || strict.has(p.input)) {
      expect(() => parseSchedule(p.input, p.zone, now)).toThrow(ScheduleError);
      return;
    }
    const r = p.result as Record<string, unknown>;
    // parse_schedule reads a past timestamp; create_job and update_job then refuse it, so the editor does at once.
    if (r.kind === "once" && at(r.run_at as string) < now - 120_000) {
      expect(() => parseSchedule(p.input, p.zone, now)).toThrow(/already passed/);
      return;
    }
    const got = parseSchedule(p.input, p.zone, now);
    expect(got.kind).toBe(r.kind);
    expect(got.display).toBe(r.display);
    if (got.kind === "cron") expect(got.expr).toBe(r.expr);
    if (got.kind === "interval") expect(got.minutes).toBe(r.minutes);
    if (got.kind === "once") expect(got.runAt).toBe(at(r.run_at as string));
  });

  it("refuses a one-shot more than two minutes in the past, as Hermes does when saving", () => {
    const now = at("2026-11-02T14:00:00-06:00");
    expect(() => parseSchedule("2026-11-02T13:57", "America/Chicago", now)).toThrow(/already passed/);
    expect(parseSchedule("2026-11-02T13:59", "America/Chicago", now).kind).toBe("once");
  });

  it("reads a time without an offset on the profile's clock, the first time when it happens twice", () => {
    const now = at("2026-10-01T00:00:00Z");
    const s = parseSchedule("2026-11-01T01:30", "America/Chicago", now);
    expect(s).toMatchObject({ kind: "once", runAt: at("2026-11-01T01:30:00-05:00") });
    expect(parseSchedule("2026-11-01T01:30", "Europe/London", now)).toMatchObject({ runAt: at("2026-11-01T01:30:00Z") });
  });

  it("says what is wrong with a cron field", () => {
    expect(() => parseSchedule("0 25 * * *", "UTC", 0)).toThrow("There's no hour 25: use 0–23.");
    expect(() => parseSchedule("*/0 * * * *", "UTC", 0)).toThrow(/step of 0/);
    expect(() => parseSchedule("0 9 * *", "UTC", 0)).toThrow(/5 fields/);
  });

  it("leaves expressions it can't read for Hermes to check, without a preview", () => {
    const s = parseSchedule("0 9 * * 1 30", "UTC", 0);
    expect(s).toEqual({ kind: "cron", expr: "0 9 * * 1 30", display: "0 9 * * 1 30" });
    expect(upcomingRuns(s, "UTC", 0, 3)).toBeUndefined();
  });
});

describe("time zones", () => {
  it("resolves repeated and skipped wall times like Python's fold", () => {
    const repeated = Date.UTC(2026, 10, 1, 1, 30);
    expect(instantsOf("America/Chicago", repeated)).toEqual([at("2026-11-01T01:30:00-05:00"), at("2026-11-01T01:30:00-06:00")]);
    const skipped = Date.UTC(2027, 2, 14, 2, 30);
    expect(instantsOf("America/Chicago", skipped)).toEqual([at("2027-03-14T03:30:00-05:00"), at("2027-03-14T01:30:00-06:00")]);
    expect(instantsOf("Asia/Kolkata", Date.UTC(2026, 0, 1, 9))).toEqual([at("2026-01-01T09:00:00+05:30"), at("2026-01-01T09:00:00+05:30")]);
  });

  it("finds clock changes, including half-hour ones", () => {
    expect(clockChanges("America/Chicago", at("2026-11-02T00:00:00Z")).map((c) => new Date(c.at).toISOString())).toEqual(["2027-03-14T08:00:00.000Z"]);
    expect(clockChanges("America/Chicago", at("2026-10-01T00:00:00Z")).map((c) => [new Date(c.at).toISOString(), (c.to - c.from) / 3_600_000])).toEqual([
      ["2026-11-01T07:00:00.000Z", -1],
      ["2027-03-14T08:00:00.000Z", 1],
    ]);
    const lh = clockChanges("Australia/Lord_Howe", at("2026-09-01T00:00:00Z"))[0];
    expect(lh.to - lh.from).toBe(30 * 60_000);
    expect(clockChanges("Asia/Kolkata", 0)).toEqual([]);
    expect(clockChanges("-06:00", 0)).toEqual([]);
  });

  it("uses a fixed offset when Hermes doesn't name the zone", () => {
    expect(offsetAt("-06:00", 0)).toBe(-6 * 3_600_000);
    expect(formatInstant(at("2026-11-03T15:00:00Z"), "-06:00")).toMatch(/9:00\sAM UTC−06:00$/);
  });

  it("explains what a schedule does at the next clock change", () => {
    const before = at("2027-03-01T00:00:00Z");
    const cron = (expr: string) => ({ kind: "cron" as const, expr, display: expr });
    expect(formatInstant(at("2027-03-14T08:30:00Z"), "America/Chicago", { date: false })).toMatch(/^3:30\sAM CDT$/);
    expect(clockChangeNote(cron("30 2 * * *"), "America/Chicago", before)).toBe(
      "Clocks go forward an hour on Sun, Mar 14, 2027 at 2:00 AM. 2:30 AM doesn't exist that day; Hermes runs it by the old clock, at " +
        formatInstant(at("2027-03-14T08:30:00Z"), "America/Chicago", { date: false }) +
        ".",
    );
    expect(clockChangeNote(cron("*/15 * * * *"), "America/Chicago", before)).toMatch(/The times from 2:00 AM to 2:45 AM don't exist that day; Hermes runs the first by the old clock, at .*, and skips the rest\./);
    expect(clockChangeNote(cron("30 1 * * *"), "America/Chicago", at("2026-10-01T00:00:00Z"))).toBe(
      "Clocks go back an hour on Sun, Nov 1, 2026 at 2:00 AM. 1:30 AM happens twice that day; Hermes runs it only the first time.",
    );
    expect(clockChangeNote(cron("0 9 * * *"), "America/Chicago", before)).toBeUndefined();
    // From any instant, not only a whole minute: a time just after the skipped hour isn't in it.
    const unaligned = at("2026-11-02T20:41:37.123Z");
    expect(clockChanges("America/Chicago", unaligned)[0].at).toBe(at("2027-03-14T08:00:00Z"));
    expect(clockChangeNote(cron("30 3 * * *"), "America/Chicago", unaligned)).toBeUndefined();
    expect(clockChangeNote(cron("30 2 * * *"), "America/Chicago", unaligned)).toMatch(/^Clocks go forward an hour on Sun, Mar 14, 2027 at 2:00 AM\. 2:30 AM doesn't exist/);
    expect(clockChangeNote({ kind: "interval", minutes: 60, display: "" }, "America/Chicago", before)).toMatch(/counts elapsed time/);
    expect(clockChangeNote(cron("30 2 * * *"), "Asia/Kolkata", before)).toBeUndefined();
  });
});

describe("schedules in words", () => {
  const say = (typed: string) => explainSchedule(parseSchedule(typed, "UTC", 0), "UTC");
  it.each([
    ["0 9 * * *", "Every day at 9:00 AM"],
    ["every day at 9am", "Every day at 9:00 AM"],
    ["weekdays at 9:30pm", "On weekdays at 9:30 PM"],
    ["0 7,19 * * *", "Every day at 7:00 AM and 7:00 PM"],
    ["*/15 6-15 * * 1-5", "On weekdays every 15 minutes from 6:00 AM to 3:45 PM"],
    ["*/30 * * * *", "Every 30 minutes"],
    ["0 * * * *", "Every hour, on the hour"],
    ["0 8 * * 0", "On Sundays at 8:00 AM"],
    ["0 9 1 * *", "On day 1 of the month at 9:00 AM"],
    ["0 9 1 * 1", "On day 1 of the month, and on Mondays at 9:00 AM"],
    ["0 9 1 jan,jul *", "On day 1 of the month, in January and July at 9:00 AM"],
    ["every 30m", "Every 30 minutes, counted from the last run"],
    ["2h", "Every 2 hours, counted from the last run"],
    ["* 0,12 * * *", "Every minute during the hours starting 12:00 AM and 12:00 PM"],
    ["0 9 * * 5-1/2", "On Sundays and Fridays at 9:00 AM"],
    ["0 9 * * 0-7", "Every day at 9:00 AM"],
    ["1d", "Every day, counted from the last run"],
  ])("%s → %s", (typed, words) => expect(say(typed)).toBe(words));
});
