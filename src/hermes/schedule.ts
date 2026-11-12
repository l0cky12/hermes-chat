// Scheduled job schedules (GLOSSARY.md "Scheduled job", ADR 0013): what Hermes's scheduler makes of a schedule as the
// owner typed it, when it will run, and how to say so. Hermes is the judge: it parses the schedule again when a job is
// saved, and its own `next_run_at` is the next run shown. This file mirrors `cron/jobs.py` `parse_schedule` and
// `compute_next_run` at the deployed `bf0203a`, so the editor can explain a schedule and preview its runs before it is
// saved. `schedule.test.ts` checks it against what Hermes's own code answers (tools/cron-golden.py), DST changes
// included.
//
// A cron schedule follows the wall clock of the profile's time zone: Hermes finds the next matching wall-clock time
// and attaches the zone. A time that doesn't exist (clocks spring forward) runs as if the clock hadn't changed, an hour
// later by the new clock; a time that happens twice (clocks go back) runs once, the first time. An interval counts
// elapsed time from the last run, so it ignores clock changes.

/** A schedule as Hermes stores it. `runAt` is an instant in ms; `display` is Hermes's own label for it. */
export type Schedule =
  | { kind: "once"; runAt: number; display: string }
  | { kind: "interval"; minutes: number; display: string }
  | { kind: "cron"; expr: string; display: string };

/**
 * The time zone Hermes schedules a profile's jobs in: an IANA name such as `America/Chicago`, or a fixed UTC offset
 * such as `-06:00` when Hermes uses the server's own zone and doesn't name it.
 */
export type Zone = string;

const MIN = 60_000;
const DAY = 86_400_000;
/** `ONESHOT_GRACE_SECONDS`: a one-shot up to two minutes in the past still runs. */
export const ONESHOT_GRACE_MS = 120_000;

const FIXED = /^([+-])(\d\d):(\d\d)$/;

/** Whether `zone` is a time zone this computer knows. */
export function knownZone(zone: string): boolean {
  if (FIXED.test(zone)) return true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const partsFormat = new Map<string, Intl.DateTimeFormat>();
function wallParts(zone: string): Intl.DateTimeFormat {
  let f = partsFormat.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    partsFormat.set(zone, f);
  }
  return f;
}

/** The zone's offset from UTC at instant `ms`, in ms (UTC−06:00 is −21 600 000). */
export function offsetAt(zone: Zone, ms: number): number {
  const fixed = FIXED.exec(zone);
  if (fixed) return (fixed[1] === "-" ? -1 : 1) * (Number(fixed[2]) * 60 + Number(fixed[3])) * MIN;
  const p: Record<string, number> = {};
  for (const { type, value } of wallParts(zone).formatToParts(ms)) if (type !== "literal") p[type] = Number(value);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wall - (ms - (((ms % 1000) + 1000) % 1000));
}

/** The wall clock at `ms` in `zone`, as ms in a UTC-based "naive" timeline (read it with `getUTC*`). */
export const wallOf = (zone: Zone, ms: number) => ms + offsetAt(zone, ms);

/**
 * The instants a wall-clock time stands for in `zone`, as Python's `replace(tzinfo=zone, fold=…)` resolves it:
 * `[fold 0, fold 1]`. The two are equal unless the time is in a clock change: a time that happens twice gives its
 * first and second instants, and a time that doesn't exist gives the instant by the old offset (later) and by the new
 * (earlier).
 */
export function instantsOf(zone: Zone, wall: number): [number, number] {
  const before = offsetAt(zone, wall - DAY);
  const after = offsetAt(zone, wall + DAY);
  if (before === after) return [wall - before, wall - before];
  const okBefore = offsetAt(zone, wall - before) === before;
  const okAfter = offsetAt(zone, wall - after) === after;
  if (okBefore !== okAfter) {
    const o = okBefore ? before : after;
    return [wall - o, wall - o];
  }
  // Both fit (a repeated time) or neither does (a skipped one).
  return [wall - before, wall - after];
}

// --- Cron expressions (croniter, as Hermes uses it) --------------------------------------------------------------

type Field = Set<number>;
/** A parsed 5-field cron expression. `domAny`/`dowAny`: the field is `*`, which decides how the two day fields join. */
export type Cron = { minute: Field; hour: Field; dom: Field; lastDom: boolean; month: Field; dow: Field; domAny: boolean; dowAny: boolean };

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of the month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS, base: 1 },
  { name: "day of the week", min: 0, max: 7, names: DAYS, base: 0 },
] as const;

/** Thrown for an expression Hermes would refuse; the message says why. */
export class ScheduleError extends Error {}
/** An expression this app can't read but Hermes may take (seconds, `H`, …): Hermes checks it on save. */
class Unreadable extends Error {}

function fieldValue(raw: string, f: (typeof FIELDS)[number]): number {
  const names = "names" in f ? f.names : undefined;
  const at = names?.indexOf(raw.toLowerCase() as never) ?? -1;
  if (names && at >= 0) return at + ("base" in f ? f.base : 0);
  if (!/^\d+$/.test(raw)) throw new Unreadable(raw);
  const n = Number(raw);
  if (n < f.min || n > f.max) throw new ScheduleError(`There's no ${f.name} ${raw}: use ${f.min}–${f.max}.`);
  return n;
}

function parseField(text: string, i: number): { set: Field; last: boolean } {
  const f = FIELDS[i];
  const set: Field = new Set();
  let last = false;
  for (const part of text.split(",")) {
    if (!part) throw new ScheduleError(`The ${f.name} field has an empty item.`);
    if (i === 2 && part.toUpperCase() === "L") {
      last = true;
      continue;
    }
    const [range, stepText, extra] = part.split("/");
    if (extra !== undefined) throw new ScheduleError(`${part} has more than one /.`);
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText)) throw new Unreadable(part);
      step = Number(stepText);
      if (step === 0) throw new ScheduleError(`A step of 0 in ${part} never moves on.`);
    }
    // croniter's bounds: the week runs 0–6, and 7 is another name for Sunday, read as 0 before anything else.
    const [MIN, MAX] = i === 4 ? [0, 6] : [f.min, f.max];
    const alias = (v: number) => (i === 4 && v === 7 ? 0 : v);
    let lo: number, hi: number;
    let ranged = false;
    if (range === "*") [lo, hi] = [MIN, MAX];
    else if (range.includes("-")) {
      const [a, b, more] = range.split("-");
      if (more !== undefined || !a || !b) throw new Unreadable(part);
      [lo, hi] = [alias(fieldValue(a, f)), alias(fieldValue(b, f))];
      ranged = true;
    } else {
      lo = alias(fieldValue(range, f));
      hi = stepText === undefined ? lo : MAX;
    }
    const span = (a: number, b: number) => Array.from({ length: Math.max(0, Math.ceil((b + 1 - a) / step)) }, (_, k) => a + k * step);
    let values: number[];
    if (lo > hi) {
      // A range that runs backwards (`fri-mon`, `22-2`) wraps round the end of the field, as croniter's `_expand`
      // does: to the end with the step, then from the start, skipped ahead by what the step carried past the end.
      values = span(lo, MAX);
      let skip = 0;
      const lastOne = values[values.length - 1];
      if (lastOne !== undefined && lastOne - MIN + step > MAX - MIN + 1 && MAX - lastOne < step) skip = step - (MAX - lastOne);
      values.push(...span(MIN + skip, hi));
    } else if ((ranged || stepText !== undefined) && lo === hi) {
      values = span(MIN, MAX); // `sun-sun`, `0-7`, `6/2` in the week, `59/2`: croniter takes the whole cycle
    } else values = span(lo, hi);
    for (const v of values) set.add(v);
  }
  return { set, last };
}

/**
 * Reads a 5-field cron expression. Throws `ScheduleError` saying what's wrong when Hermes would refuse it, and returns
 * undefined for one it may take that this app can't preview (a seconds field, croniter's `H`, …).
 */
export function parseCron(expr: string): Cron | undefined {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return undefined;
  try {
    const [minute, hour, dom, month, dow] = parts.map(parseField);
    // croniter reads a day field that names every day as `*`, which joins the two with AND, unless the other day
    // field's text has no `*` in it (`_expand`'s LEN_MEANS_ALL): `*/2 * */1` is odd dates, `1 * */1` every day.
    const domAny = parts[2] === "*" || (dom.set.size === 31 && !dom.last && parts[4].includes("*"));
    const dowAny = parts[4] === "*" || (dow.set.size === 7 && parts[2].includes("*"));
    return { minute: minute.set, hour: hour.set, dom: dom.set, lastDom: dom.last, month: month.set, dow: dow.set, domAny, dowAny };
  } catch (e) {
    if (e instanceof Unreadable) return undefined;
    throw e;
  }
}

const daysIn = (y: number, m0: number) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();

function dayMatches(c: Cron, d: Date): boolean {
  const day = d.getUTCDate();
  const dom = c.dom.has(day) || (c.lastDom && day === daysIn(d.getUTCFullYear(), d.getUTCMonth()));
  const dow = c.dow.has(d.getUTCDay());
  // croniter joins the two day fields with OR when neither is `*`, as cron does.
  return !c.domAny && !c.dowAny ? dom || dow : dom && dow;
}

/** The first wall-clock minute strictly after `wall` that `c` matches, or undefined within 30 years. */
export function nextWall(c: Cron, wall: number): number | undefined {
  let t = Math.floor(wall / MIN) * MIN + MIN;
  const end = wall + 30 * 366 * DAY;
  while (t < end) {
    const d = new Date(t);
    if (!c.month.has(d.getUTCMonth() + 1)) {
      t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    } else if (!dayMatches(c, d)) {
      t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
    } else if (!c.hour.has(d.getUTCHours())) {
      t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1);
    } else if (!c.minute.has(d.getUTCMinutes())) {
      t += MIN;
    } else return t;
  }
  return undefined;
}

/** `compute_next_run` for a cron schedule: the next run strictly after the instant `after`, in `zone`. */
export function nextCronRun(c: Cron, zone: Zone, after: number): number | undefined {
  let wall = nextWall(c, wallOf(zone, after));
  // Try both instants of each candidate wall time, the earliest after `after` wins: inside the repeated hour the
  // first instant of the next wall time can be before `after`.
  for (let i = 0; i < 2 && wall !== undefined; i++) {
    for (const at of instantsOf(zone, wall)) if (at > after) return at;
    wall = nextWall(c, wall);
  }
  return wall === undefined ? undefined : instantsOf(zone, wall)[0];
}

/**
 * The next `count` runs of `schedule` after the instant `from`, as Hermes's scheduler would make them, each run
 * counted from the one before. Undefined when this app can't work them out (a cron expression it can't read).
 */
export function upcomingRuns(schedule: Schedule, zone: Zone, from: number, count: number): number[] | undefined {
  if (schedule.kind === "once") return schedule.runAt > from - ONESHOT_GRACE_MS ? [schedule.runAt] : [];
  if (schedule.kind === "interval") return Array.from({ length: count }, (_, i) => from + (i + 1) * schedule.minutes * MIN);
  const c = parseCron(schedule.expr);
  if (!c) return undefined;
  const runs: number[] = [];
  for (let at: number | undefined = from; runs.length < count; ) {
    at = nextCronRun(c, zone, at);
    if (at === undefined) break;
    runs.push(at);
  }
  return runs;
}

// --- Schedules as typed (`parse_schedule`) ------------------------------------------------------------------------

const DURATION = /^(\d*)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/;
const UNIT_MINUTES: Record<string, number> = { m: 1, h: 60, d: 1440 };

/** `parse_duration`: minutes, or undefined. */
function duration(text: string): number | undefined {
  const m = DURATION.exec(text.trim().toLowerCase());
  return m ? (m[1] ? Number(m[1]) : 1) * UNIT_MINUTES[m[2][0]] : undefined;
}

const WEEKDAY: Record<string, string> = {
  sunday: "0", sun: "0", monday: "1", mon: "1", tuesday: "2", tue: "2", tues: "2", wednesday: "3", wed: "3", weds: "3",
  thursday: "4", thu: "4", thur: "4", thurs: "4", friday: "5", fri: "5", saturday: "6", sat: "6",
};
const DAYSPEC: Record<string, string> = { day: "*", daily: "*", everyday: "*", weekday: "1-5", weekdays: "1-5", weekend: "0,6", weekends: "0,6" };

/** `_parse_clock_time`: `[hour, minute]` in 24 hours, or undefined. */
function parseClock(text: string): [number, number] | undefined {
  const t = text.trim().toLowerCase().replace(/ /g, "");
  if (t === "noon" || t === "midday") return [12, 0];
  if (t === "midnight") return [0, 0];
  const m = /^(\d{1,2})(?::(\d{2}))?(am|pm)?$/.exec(t);
  if (!m) return undefined;
  let hour = Number(m[1]);
  const minute = Number(m[2] ?? 0);
  if (m[3]) {
    if (hour < 1 || hour > 12) return undefined;
    hour = (hour % 12) + (m[3] === "pm" ? 12 : 0);
  }
  return hour > 23 || minute > 59 ? undefined : [hour, minute];
}

/** `_natural_every_to_cron`: "monday 9am", "weekdays at 9:30pm" as a cron expression, or undefined. */
function naturalCron(rest: string): string | undefined {
  const tokens = rest.toLowerCase().replace(/,/g, " ").split(/\s+/).filter(Boolean);
  if (!tokens.length) return undefined;
  let dow = DAYSPEC[tokens[0]];
  let idx = 1;
  if (dow === undefined) {
    const days: string[] = [];
    idx = tokens.length;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] === "and") continue;
      const d = WEEKDAY[tokens[i]];
      if (d === undefined) {
        idx = i;
        break;
      }
      if (!days.includes(d)) days.push(d);
    }
    if (!days.length) return undefined;
    dow = days.join(",");
  }
  let time = tokens.slice(idx);
  if (time[0] === "at") time = time.slice(1);
  if (!time.length) return undefined;
  const at = parseClock(time.join(" "));
  return at && `${at[1]} ${at[0]} * * ${dow}`;
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,6}))?)?)?(Z|[+-]\d{2}:?\d{2})?$/i;
const pad = (n: number) => String(n).padStart(2, "0");

/** A timestamp as Python's `datetime.fromisoformat` reads it; a time without an offset is wall time in `zone`. */
function isoInstant(text: string, zone: Zone): { at: number; display: string } {
  const m = ISO.exec(text);
  if (!m) throw new ScheduleError(`Hermes can't read ${text} as a date and time. Write it like 2026-11-05T15:00.`);
  const [y, mo, d, h, mi, s] = [1, 2, 3, 4, 5, 6].map((i) => Number(m[i] ?? 0));
  if (mo < 1 || mo > 12) throw new ScheduleError(`${text} has no month ${mo}.`);
  if (d < 1 || d > daysIn(y, mo - 1)) throw new ScheduleError(`${text} has no day ${d} in that month.`);
  if (h > 23 || mi > 59 || s > 59) throw new ScheduleError(`${text} isn't a time of day.`);
  const wall = Date.UTC(y, mo - 1, d, h, mi, s) + Number((m[7] ?? "").padEnd(3, "0").slice(0, 3) || 0);
  const display = `once at ${m[1]}-${m[2]}-${m[3]} ${pad(h)}:${pad(mi)}`;
  const off = m[8];
  if (!off) return { at: instantsOf(zone, wall)[0], display };
  if (off.toUpperCase() === "Z") return { at: wall, display };
  const o = /^([+-])(\d{2}):?(\d{2})$/.exec(off)!;
  return { at: wall - (o[1] === "-" ? -1 : 1) * (Number(o[2]) * 60 + Number(o[3])) * MIN, display };
}

const EXAMPLES = "Try every 30m, every day at 9am, weekdays at 9:30pm, 0 9 * * 1-5, in 2h, or 2026-11-05T15:00.";

/**
 * Reads a schedule the way Hermes's `parse_schedule` does, with `now` the server's clock and `zone` the profile's
 * time zone. Throws `ScheduleError` saying what's wrong. A cron expression this app can't read is returned as it is,
 * for Hermes to check when the job is saved.
 *
 * It is stricter than Hermes in one place: Hermes takes an interval of 0 minutes, which would run the job on every
 * check of the scheduler; this refuses it.
 */
export function parseSchedule(typed: string, zone: Zone, now: number): Schedule {
  const schedule = typed.trim();
  if (!schedule) throw new ScheduleError(`Enter a schedule. ${EXAMPLES}`);
  const lower = schedule.toLowerCase();
  const every = lower.startsWith("every ");
  const rest = every ? schedule.slice(6).trim() : lower;
  const natural = naturalCron(rest);
  if (natural !== undefined) return { kind: "cron", expr: natural, display: schedule };
  const interval = (minutes: number | undefined, text: string): Schedule => {
    if (minutes === undefined) throw new ScheduleError(`Hermes can't read “${text}” as a length of time. Use minutes, hours or days, like 30m, 2h or 1d.`);
    if (minutes < 1) throw new ScheduleError("Run it at most once a minute: an interval of 0 would run it on every check.");
    return { kind: "interval", minutes, display: `every ${minutes}m` };
  };
  if (every) return interval(duration(rest), rest);

  const parts = schedule.split(/\s+/);
  if (parts.length >= 5 && parts.slice(0, 5).every((p) => /^[A-Za-z\d*\-,/]+$/.test(p))) {
    if (parts.length === 5) parseCron(schedule); // throws for a field Hermes would refuse
    return { kind: "cron", expr: schedule, display: schedule };
  }
  if (schedule.includes("T") || /^\d{4}-\d{2}-\d{2}/.test(schedule)) {
    const { at, display } = isoInstant(schedule, zone);
    if (at < now - ONESHOT_GRACE_MS) throw new ScheduleError("That time has already passed. Pick a time in the future.");
    return { kind: "once", runAt: at, display };
  }
  if (lower.startsWith("in ")) {
    const text = schedule.slice(3).trim();
    const minutes = duration(text);
    if (minutes === undefined) throw new ScheduleError(`Hermes can't read “${text}” after “in”. Use e.g. in 30m or in 2h.`);
    return { kind: "once", runAt: now + minutes * MIN, display: `once in ${text}` };
  }
  const bare = duration(schedule);
  if (bare !== undefined) return interval(bare, schedule);
  if (parts.length > 1 && parts.length < 5 && parts.every((p) => /^[\d*\-,/]+$/.test(p)))
    throw new ScheduleError(`A cron expression has 5 fields: minute, hour, day of the month, month and day of the week. ${EXAMPLES}`);
  throw new ScheduleError(`Hermes can't read “${schedule}” as a schedule. ${EXAMPLES}`);
}

/** A schedule as Hermes sends it in a job (`schedule` dict), or undefined if it isn't one. */
export function storedSchedule(v: unknown, display: string): Schedule | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const s = v as Record<string, unknown>;
  if (s.kind === "cron" && typeof s.expr === "string") return { kind: "cron", expr: s.expr, display };
  if (s.kind === "interval" && typeof s.minutes === "number") return { kind: "interval", minutes: s.minutes, display };
  if (s.kind === "once" && typeof s.run_at === "string" && !Number.isNaN(Date.parse(s.run_at))) return { kind: "once", runAt: Date.parse(s.run_at), display };
  return undefined;
}

// --- Saying it ---------------------------------------------------------------------------------------------------

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const list = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);
const clock = (h: number, m: number) => `${h % 12 || 12}:${pad(m)} ${h < 12 ? "AM" : "PM"}`;
const sorted = (s: Field) => [...s].sort((a, b) => a - b);
const every = (n: number, unit: string) => (n === 1 ? `every ${unit}` : `every ${n} ${unit}s`);

function minutesText(minutes: number): string {
  if (minutes % 1440 === 0) return every(minutes / 1440, "day");
  if (minutes % 60 === 0) return every(minutes / 60, "hour");
  return every(minutes, "minute");
}

/** A step pattern such as 0,15,30,45: its step, if the set is every n-th value from 0. */
function stepOf(set: Field, size: number): number | undefined {
  const v = sorted(set);
  if (v.length < 2 || v[0] !== 0) return undefined;
  const step = v[1] - v[0];
  return size % step === 0 && v.length === size / step && v.every((x, i) => x === i * step) ? step : undefined;
}

function timesText(c: Cron): string {
  const hours = sorted(c.hour);
  const minutes = sorted(c.minute);
  const minuteStep = stepOf(c.minute, 60);
  const allHours = hours.length === 24;
  const contiguous = hours.every((h, i) => i === 0 || h === hours[i - 1] + 1);
  const during = `during the hours starting ${list(hours.map((h) => clock(h, 0)))}`;
  if (minutes.length === 60) return allHours ? "every minute" : contiguous ? `every minute from ${clock(hours[0], 0)} to ${clock(hours[hours.length - 1], 59)}` : `every minute ${during}`;
  if (minuteStep) {
    const each = every(minuteStep, "minute");
    if (allHours) return each;
    if (contiguous) return `${each} from ${clock(hours[0], 0)} to ${clock(hours[hours.length - 1], 60 - minuteStep)}`;
    return `${each} ${during}`;
  }
  if (allHours) return minutes.length === 1 && minutes[0] === 0 ? "every hour, on the hour" : `every hour at ${list(minutes.map((m) => `:${pad(m)}`))}`;
  if (hours.length * minutes.length <= 8) return `at ${list(hours.flatMap((h) => minutes.map((m) => clock(h, m))))}`;
  return `at ${list(minutes.map((m) => `:${pad(m)}`))} past each of the hours ${list(hours.map(String))}`;
}

function daysText(c: Cron): string {
  const dows = sorted(c.dow);
  const doms = sorted(c.dom);
  const domText = [...doms.map((d) => `day ${d}`), ...(c.lastDom ? ["the last day"] : [])];
  const weekdays = dows.join(",") === "1,2,3,4,5" ? "on weekdays" : dows.join(",") === "0,6" ? "on weekends" : `on ${list(dows.map((d) => `${DAY_NAMES[d]}s`))}`;
  const allDom = !c.lastDom && doms.length === 31;
  const allDow = dows.length === 7;
  let days: string;
  if (!c.domAny && !c.dowAny) days = allDom || allDow ? "every day" : `on ${list(domText)} of the month, and ${weekdays}`;
  else if (allDom && allDow) days = "every day";
  else if (allDom) days = weekdays;
  else if (allDow) days = `on ${list(domText)} of the month`;
  else days = `on ${list(domText)} of the month, if it's ${weekdays.replace(/^on /, "a ")}`;
  const months = sorted(c.month);
  return months.length === 12 ? days : `${days}, in ${list(months.map((m) => MONTH_NAMES[m - 1]))}`;
}

/** The schedule in words, without its time zone: "Every day at 9:00 AM", "Every 30 minutes". */
export function explainSchedule(s: Schedule, zone: Zone): string {
  if (s.kind === "interval") return `${cap(minutesText(s.minutes))}, counted from the last run`;
  if (s.kind === "once") return `Once, ${formatInstant(s.runAt, zone)}`;
  const c = parseCron(s.expr);
  if (!c) return `Cron expression ${s.expr}`;
  const days = daysText(c);
  const times = timesText(c);
  return cap(days === "every day" && times.startsWith("every") ? times : `${days} ${times}`);
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

// --- Times in a zone ---------------------------------------------------------------------------------------------

const formats = new Map<string, Intl.DateTimeFormat>();
function format(zone: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = zone + JSON.stringify(opts);
  let f = formats.get(key);
  if (!f) formats.set(key, (f = new Intl.DateTimeFormat(undefined, { ...opts, timeZone: zone })));
  return f;
}

/** `UTC−06:00`. */
export function offsetLabel(offsetMs: number): string {
  const m = Math.round(Math.abs(offsetMs) / MIN);
  return `UTC${offsetMs < 0 ? "−" : "+"}${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/** "Tue, Nov 3, 2026, 9:00 AM CST": the instant on the zone's clock, with the zone's abbreviation or offset. */
export function formatInstant(ms: number, zone: Zone, { weekday = true, year = true, date = true } = {}): string {
  const opts: Intl.DateTimeFormatOptions = {
    ...(date && { ...(weekday && { weekday: "short" }), month: "short", day: "numeric", ...(year && { year: "numeric" }) }),
    hour: "numeric",
    minute: "2-digit",
  };
  if (FIXED.test(zone)) return `${format("UTC", opts).format(ms + offsetAt(zone, ms))} ${offsetLabel(offsetAt(zone, ms))}`;
  return format(zone, { ...opts, timeZoneName: "short" }).format(ms);
}

/** A zone change in the next year: when, and the offsets either side. */
export type ClockChange = { at: number; from: number; to: number };

/** The clock changes in `zone` between `from` and a year later (none for a fixed offset). */
export function clockChanges(zone: Zone, from: number, span = 366 * DAY): ClockChange[] {
  if (FIXED.test(zone)) return [];
  const out: ClockChange[] = [];
  const step = 6 * 3_600_000;
  let prev = offsetAt(zone, from);
  for (let t = from + step; t <= from + span; t += step) {
    const o = offsetAt(zone, t);
    if (o === prev) continue;
    // To the millisecond: `from` needn't fall on a minute, and a change found a little late shifts every wall time
    // worked out from it.
    let [lo, hi] = [t - step, t];
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (offsetAt(zone, mid) === prev) lo = mid;
      else hi = mid;
    }
    out.push({ at: hi, from: prev, to: o });
    prev = o;
  }
  return out;
}

/**
 * What a schedule does at the zone's next clock change, in words, or undefined when the change doesn't touch it.
 * Hermes's own rules: of the wall times that don't exist (clocks go forward), the first runs by the old clock and the
 * rest are skipped; wall times that happen twice (clocks go back) run only the first time; an interval keeps counting
 * elapsed time.
 */
export function clockChangeNote(s: Schedule, zone: Zone, from: number): string | undefined {
  const change = clockChanges(zone, from)[0];
  if (!change || s.kind === "once") return undefined;
  const forward = change.to > change.from;
  const shift = Math.abs(change.to - change.from);
  const amount = shift === 3_600_000 ? "an hour" : `${shift / MIN} minutes`;
  // The wall time the clocks change at, by the old clock (2:00 AM), and the span of wall times skipped or repeated.
  const spanStart = forward ? wallOf(zone, change.at - 1) + 1 : wallOf(zone, change.at);
  const spanEnd = spanStart + shift;
  const hm = (w: number) => clock(new Date(w).getUTCHours(), new Date(w).getUTCMinutes());
  const label = forward ? spanStart : spanEnd;
  const head = `Clocks go ${forward ? "forward" : "back"} ${amount} on ${format("UTC", { weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(label)} at ${hm(label)}.`;
  if (s.kind === "interval") return `${head} An interval counts elapsed time, so its runs keep their spacing and land ${forward ? "later" : "earlier"} by the clock afterwards.`;
  const c = parseCron(s.expr);
  if (!c) return undefined;
  const named: number[] = [];
  for (let w = nextWall(c, spanStart - 1); w !== undefined && w < spanEnd; w = nextWall(c, w)) named.push(w);
  if (!named.length) return undefined;
  const times = named.length === 1 ? hm(named[0]) : `${hm(named[0])} to ${hm(named[named.length - 1])}`;
  if (!forward) return `${head} ${named.length === 1 ? `${times} happens` : `The times from ${times} happen`} twice that day; Hermes runs ${named.length === 1 ? "it" : "them"} only the first time.`;
  const moved = instantsOf(zone, named[0])[0];
  const ran = upcomingRuns(s, zone, change.at - 1, 1)?.[0] === moved;
  if (!ran) return `${head} ${times} ${named.length === 1 ? "doesn't" : "don't"} exist that day, and Hermes skips ${named.length === 1 ? "it" : "them"}.`;
  const at = formatInstant(moved, zone, { date: false });
  return named.length === 1
    ? `${head} ${times} doesn't exist that day; Hermes runs it by the old clock, at ${at}.`
    : `${head} The times from ${times} don't exist that day; Hermes runs the first by the old clock, at ${at}, and skips the rest.`;
}

/** `instant` as an ISO time on the zone's clock, `2026-11-03T09:00:00-06:00`, or without seconds and offset. */
export function isoIn(zone: Zone, ms: number, withOffset = true): string {
  const w = new Date(wallOf(zone, ms));
  const head = `${w.getUTCFullYear()}-${pad(w.getUTCMonth() + 1)}-${pad(w.getUTCDate())}T${pad(w.getUTCHours())}:${pad(w.getUTCMinutes())}`;
  if (!withOffset) return head;
  const o = offsetAt(zone, ms);
  const m = Math.abs(o) / MIN;
  return `${head}:${pad(w.getUTCSeconds())}${o < 0 ? "-" : "+"}${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}
