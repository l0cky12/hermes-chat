// Scheduled jobs (GLOSSARY.md "Scheduled job", ADR 0011): Hermes's own cron jobs for one profile, read and written over
// dashboard REST `/api/cron/*` (`hermes_cli/web_routers/cron.py` at the deployed `bf0203a`). Hermes stores each job in
// the profile's `cron/jobs.json` and its gateway's scheduler runs it, so jobs keep running with this app closed. This
// app only lists them and asks Hermes to change them; it never schedules anything itself.
//
// Hermes's cron routes have no idempotency key and no revision, so this file supplies what it can around them:
// - Every write is followed by reading the profile's list back, and only that read decides whether it worked.
// - A per-job route answers for a job in ANOTHER profile when the named one doesn't have it (`_job_owner_profile`), so
//   every action first checks that the profile's own list holds the job, and checks the profile on every answer.
// - A create whose answer is lost is looked for in the list before anything is sent again (`create`).
// - An edit sends only the fields the owner changed, after checking that nobody changed the job's shown fields since
//   the owner opened it (`update`). Fields this app doesn't show are never sent, so Hermes keeps them.
import type { RestMethod } from "./pipe";
import { type Schedule, type Zone, knownZone, offsetAt, offsetLabel, storedSchedule } from "./schedule";

/** How Hermes last ran a job, from its execution ledger (`cron/executions.py`). */
export type Execution = { status: string; claimedAt?: string; finishedAt?: string; error?: string; delivery?: string };

/** A scheduled job as Hermes lists it (`cron.jobs._normalize_job_record` plus the dashboard's profile stamp). */
export type CronJob = {
  id: string;
  name: string;
  prompt: string;
  /** Hermes's label for the schedule (`schedule_display`), and the schedule itself when this app can read it. */
  scheduleText: string;
  schedule?: Schedule;
  enabled: boolean;
  /** `scheduled`, `paused`, `completed` (a one-shot or a finished repeat) or `error`. */
  state: string;
  pausedReason?: string;
  /** ISO times with Hermes's offset. A paused job keeps a `nextRunAt` it won't run at. */
  nextRunAt?: string;
  lastRunAt?: string;
  createdAt?: string;
  lastStatus?: string;
  lastError?: string;
  lastDeliveryError?: string;
  /** Where results go: `local` (saved on the server only), a platform such as `telegram`, `origin`, … */
  deliver: string;
  /** `times` null runs forever. */
  repeat: { times: number | null; completed: number };
  /** A script job: Hermes runs `script` and delivers what it prints, with no agent. */
  noAgent: boolean;
  script?: string;
  skills: string[];
  model?: string;
  provider?: string;
  workdir?: string;
  toolsets: string[];
  contextFrom: string[];
  profile: string;
  latest?: Execution;
  /** Seconds since the profile's scheduler last checked its jobs; null when it never has, undefined when Hermes doesn't say. */
  heartbeatAge?: number | null;
};

/** A place Hermes can deliver a job's results (`GET /api/cron/delivery-targets`). */
export type DeliveryTarget = { id: string; name: string; ready: boolean };

/** One run of a job (`GET /api/cron/jobs/{id}/runs`): an agent session, or a script job's saved output. */
export type JobRun = { id: string; title: string; preview?: string; startedAt: number; endedAt?: number; running: boolean; script: boolean; status?: string };

/** The fields the editor sets. `schedule` is the schedule as typed, `repeat` null for no limit. */
export type JobFields = { name: string; prompt: string; schedule: string; deliver: string; repeat: number | null };

/** What a manual run came to. `completed` is false when Hermes took the run but recorded no result yet. */
export type RunOutcome = { job?: CronJob; completed: boolean };

export type CronErrorKind =
  /** The server has no cron routes. */
  | "unsupported"
  /** The dashboard refused: signed out, or not allowed. */
  | "forbidden"
  /** Not connected: nothing was sent. */
  | "offline"
  /** The job isn't in this profile's list. */
  | "gone"
  /** Hermes refused the request, and said why: nothing changed. */
  | "refused"
  /** The request may or may not have taken effect. */
  | "unknown"
  /** A manual run while one is under way. */
  | "busy"
  /** Run history isn't kept yet for this profile. */
  | "unavailable";

export class CronError extends Error {
  constructor(
    readonly kind: CronErrorKind,
    message: string,
  ) {
    super(message);
  }
}

/** Someone changed the job's shown fields since the owner opened it. `job` is how Hermes has it now. */
export class CronConflict extends Error {
  constructor(
    readonly job: CronJob,
    readonly fields: string[],
  ) {
    super(`This job was changed in another Hermes client since you opened it (${fields.join(", ")}). Your edits are still here: Save again to replace those changes, or Reload to start from the job as it is now.`);
  }
}

export type RestFn = (method: RestMethod, pathAndQuery: string, body?: unknown) => Promise<unknown>;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown) => (typeof v === "string" ? v : "");
const opt = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : typeof v === "string" && v ? [v] : []);

/** A job row as Hermes sends it, or undefined if it isn't one. */
export function toJob(v: unknown): CronJob | undefined {
  if (!isObj(v) || typeof v.id !== "string" || !v.id) return undefined;
  const scheduleText = text(v.schedule_display) || "?";
  const repeat = isObj(v.repeat) ? v.repeat : {};
  const latest = isObj(v.latest_execution) ? v.latest_execution : undefined;
  return {
    id: v.id,
    name: text(v.name) || v.id,
    prompt: text(v.prompt),
    scheduleText,
    schedule: storedSchedule(v.schedule, scheduleText),
    enabled: v.enabled !== false,
    state: text(v.state) || "scheduled",
    pausedReason: opt(v.paused_reason),
    nextRunAt: opt(v.next_run_at),
    lastRunAt: opt(v.last_run_at),
    createdAt: opt(v.created_at),
    lastStatus: opt(v.last_status),
    lastError: opt(v.last_error),
    lastDeliveryError: opt(v.last_delivery_error),
    deliver: text(v.deliver) || "local",
    repeat: { times: typeof repeat.times === "number" ? repeat.times : null, completed: typeof repeat.completed === "number" ? repeat.completed : 0 },
    noAgent: v.no_agent === true,
    script: opt(v.script),
    skills: strings(v.skills),
    model: opt(v.model),
    provider: opt(v.provider),
    workdir: opt(v.workdir),
    toolsets: strings(v.enabled_toolsets),
    contextFrom: strings(v.context_from),
    profile: text(v.profile),
    latest: latest && {
      status: text(latest.status),
      claimedAt: opt(latest.claimed_at),
      finishedAt: opt(latest.finished_at),
      error: opt(latest.error),
      delivery: opt(latest.delivery_outcome),
    },
    heartbeatAge: !("scheduler_heartbeat_age_s" in v) ? undefined : typeof v.scheduler_heartbeat_age_s === "number" ? v.scheduler_heartbeat_age_s : null,
  };
}

function toRun(v: unknown): JobRun | undefined {
  if (!isObj(v) || typeof v.id !== "string") return undefined;
  const startedAt = typeof v.started_at === "number" ? v.started_at * 1000 : undefined;
  if (startedAt === undefined) return undefined;
  // A script run's row is its output doc: the title starts with the ledger's status (`FAILED · …`), and the text
  // with the doc's own header (`# Cron Job: … ---`), which only repeats the job.
  const titled = /^([A-Z][A-Z ]*[A-Z]) · ([\s\S]*)$/.exec(text(v.title));
  const plain = (t: string) => t.replace(/^# Cron Job:[\s\S]*?---\s*/, "").trim();
  return {
    id: v.id,
    title: plain(titled ? titled[2] : text(v.title)) || "Run",
    preview: opt(plain(text(v.preview))),
    ...(titled && { status: sentence(titled[1].toLowerCase()).replace(/\.$/, "") }),
    startedAt,
    endedAt: typeof v.ended_at === "number" ? v.ended_at * 1000 : undefined,
    running: v.scheduler_owned === true || (v.ended_at == null && v.is_active === true),
    script: v.source === "cron_output",
  };
}

const sentence = (s: string) => {
  const t = s.trim();
  return t ? `${t[0].toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? "" : "."}` : t;
};

/**
 * A failed call as the owner reads it, and whether it may have taken effect. The Rust relay words a dashboard error
 * `The dashboard answered 404: {"detail":…}`; it can't reach the dashboard as `Can't reach the Hermes dashboard: …`.
 */
export function cronError(e: unknown): CronError {
  if (e instanceof CronError) return e;
  const message = e instanceof Error ? e.message : String(e);
  if (message === "Not connected to Hermes." || message === "The chat connection is closed.")
    return new CronError("offline", "Hermes Chat isn't connected to Hermes, so nothing was sent. Jobs keep running on the server.");
  if (/sign-in has expired/.test(message)) return new CronError("forbidden", "The dashboard sign-in has expired, so nothing was changed. Sign in again.");
  if (/doesn't relay/.test(message)) return new CronError("unsupported", "This version of Hermes Chat can't send that to Hermes.");
  const m = /^The dashboard answered (\d{3}): ([\s\S]*)$/.exec(message);
  if (!m) return new CronError("unknown", `Hermes didn't answer: ${message}`);
  const status = Number(m[1]);
  let detail: unknown = m[2].trim();
  try {
    detail = JSON.parse(m[2]).detail ?? detail;
  } catch {
    // Not JSON, or cut short by the relay: the text as it came.
  }
  const said = typeof detail === "string" ? detail : isObj(detail) && typeof detail.message === "string" ? detail.message : JSON.stringify(detail);
  if ((status === 404 || status === 405) && said === "Not Found") return new CronError("unsupported", "This Hermes server has no scheduled jobs. Updating Hermes adds them.");
  if (status === 404 && /^Profile '.*' does not exist\.$/.test(said)) return new CronError("gone", `${said} It may have been deleted in another Hermes client.`);
  if (status === 404) return new CronError("gone", "This job isn't on the server any more: it was deleted in another Hermes client.");
  if (status === 401 || status === 403) return new CronError("forbidden", `The dashboard doesn't allow this: ${said}`);
  if (status === 409) return new CronError("busy", sentence(said));
  if (status === 503 && /Session store/i.test(said)) return new CronError("unavailable", "Run history isn't kept until this profile's gateway has started on the server.");
  // A 424 means Hermes saved the job but an external scheduler didn't take it; the read-back sorts out the rest.
  if (status === 400 || status === 422) return new CronError("refused", sentence(said));
  return new CronError("unknown", `Hermes answered ${status}: ${sentence(said)}`);
}

const q = (profile: string) => `profile=${encodeURIComponent(profile)}`;
const jobPath = (id: string) => `api/cron/jobs/${encodeURIComponent(id)}`;

/** The shown fields, as compared for a conflict and checked after a save. */
function shown(j: CronJob): Record<string, string> {
  const s = j.schedule;
  return {
    name: j.name,
    prompt: j.prompt,
    schedule: s ? (s.kind === "cron" ? `cron ${s.expr}` : s.kind === "interval" ? `every ${s.minutes}m` : `once ${s.runAt}`) : j.scheduleText,
    delivery: j.deliver,
    "repeat limit": String(j.repeat.times),
    "paused or running": String(j.enabled),
  };
}

/** The job in `jobs` that a create of `body` made, of those not in `before`: the newest if several match. */
function created(jobs: CronJob[], before: Set<string>, body: Record<string, unknown>): CronJob | undefined {
  const name = text(body.name).trim();
  const prompt = text(body.prompt).trim();
  const fresh = jobs.filter((j) => !before.has(j.id) && j.prompt.trim() === prompt && (!name || j.name === name) && j.deliver === body.deliver);
  return fresh.sort((a, b) => Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? ""))[0];
}

/** A create whose answer was lost: the ids the list had before it went, and what it asked for. */
type Unsure = { before: Set<string>; body: Record<string, unknown> };

/**
 * Hermes's scheduled jobs. Every call names the profile, since each profile has its own jobs, and every answer is
 * checked to be from that profile.
 */
export class CronApi {
  /** Per profile: a create that may have been made, until a later read of the list settles it. */
  private unsure = new Map<string, Unsure>();
  /** Per profile: the create under way, so a second press of Create can't send a second one. */
  private creating = new Map<string, Promise<CronJob>>();

  constructor(private rest: RestFn) {}

  private async call(method: RestMethod, path: string, body?: unknown): Promise<unknown> {
    try {
      return await this.rest(method, path, body);
    } catch (e) {
      throw cronError(e);
    }
  }

  /** The profile's jobs, paused and finished ones included, in Hermes's order. */
  async list(profile: string): Promise<CronJob[]> {
    const rows = await this.call("GET", `api/cron/jobs?${q(profile)}`);
    if (!Array.isArray(rows)) throw new CronError("unknown", "Hermes answered without a list of jobs.");
    // The list route is scoped to the profile; a row stamped with another is left out rather than shown here.
    return rows.map(toJob).filter((j): j is CronJob => !!j && (!j.profile || j.profile === profile));
  }

  /** The profile's `timezone` setting (`config.yaml`), or "" when it has none and Hermes uses the server's zone. */
  async timezone(profile: string): Promise<string> {
    const config = await this.call("GET", `api/config?${q(profile)}`);
    return isObj(config) && typeof config.timezone === "string" ? config.timezone.trim() : "";
  }

  /** Where the profile can deliver results. `ready` is false for a platform with no home channel set. */
  async targets(profile: string): Promise<DeliveryTarget[]> {
    const res = await this.call("GET", `api/cron/delivery-targets?${q(profile)}`);
    const rows = isObj(res) && Array.isArray(res.targets) ? res.targets : [];
    return rows.filter(isObj).filter((t) => typeof t.id === "string" && t.id).map((t) => ({ id: t.id as string, name: text(t.name) || (t.id as string), ready: t.home_target_set !== false }));
  }

  /** The job's latest runs, newest first. Reads only. */
  async runs(profile: string, job: CronJob, limit = 20): Promise<JobRun[]> {
    const res = await this.call("GET", `${jobPath(job.id)}/runs?${q(profile)}&limit=${limit}`);
    const rows = isObj(res) && Array.isArray(res.runs) ? res.runs : [];
    return rows.map(toRun).filter((r): r is JobRun => !!r);
  }

  /** The job as the profile's list has it now; throws `gone` when the list doesn't hold it. */
  private async owned(profile: string, id: string): Promise<CronJob> {
    const job = (await this.list(profile)).find((j) => j.id === id);
    if (!job) throw new CronError("gone", `This job isn't in the ${profile} profile any more: it was deleted in another Hermes client.`);
    return job;
  }

  /**
   * One write. Resolves with Hermes's answer, or with the failure when the answer was lost and the write may have
   * taken effect; any other failure throws, since nothing changed.
   */
  private async attempt(method: RestMethod, path: string, body?: unknown): Promise<[unknown, CronError | undefined]> {
    try {
      return [await this.rest(method, path, body), undefined];
    } catch (e) {
      const failure = cronError(e);
      if (failure.kind !== "unknown") throw failure;
      return [undefined, failure];
    }
  }

  /** The job an answer describes, refusing one from another profile. */
  private answered(profile: string, v: unknown): CronJob | undefined {
    const job = toJob(v);
    if (job?.profile && job.profile !== profile) throw new CronError("unknown", `Hermes answered for a job in the ${job.profile} profile, not ${profile}. Check both profiles' jobs.`);
    return job;
  }

  /**
   * Creates a job and returns it as the list has it afterwards. Pressing Create again while one is under way waits for
   * that one. If Hermes's answer is lost, the list is read to find the job; if the list doesn't have it, the next
   * create in this profile looks again first, since a slow server may still save it, and returns that job instead of
   * sending a second one.
   */
  create(profile: string, fields: JobFields, paused: boolean): Promise<CronJob> {
    const under = this.creating.get(profile);
    if (under) return under;
    const p = this.tryCreate(profile, fields, paused).finally(() => this.creating.delete(profile));
    this.creating.set(profile, p);
    return p;
  }

  private async tryCreate(profile: string, fields: JobFields, paused: boolean): Promise<CronJob> {
    const body: Record<string, unknown> = {
      name: fields.name.trim(),
      prompt: fields.prompt.trim(),
      schedule: fields.schedule.trim(),
      deliver: fields.deliver || "local",
      ...(fields.repeat !== null && { repeat: fields.repeat }),
      ...(paused && { paused: true }),
    };
    const jobs = await this.list(profile);
    const earlier = this.unsure.get(profile);
    if (earlier) {
      const made = created(jobs, earlier.before, earlier.body);
      this.unsure.delete(profile);
      if (made && JSON.stringify(earlier.body) === JSON.stringify(body)) return made;
      if (made) throw new CronError("refused", `Your earlier try did create “${made.name}”: it's in the list now. Edit that job instead of creating another.`);
    }
    const before = new Set(jobs.map((j) => j.id));
    const [raw, failure] = await this.attempt("POST", `api/cron/jobs?${q(profile)}`, body);
    const answer = this.answered(profile, raw);
    let after: CronJob[];
    try {
      after = await this.list(profile);
    } catch {
      this.unsure.set(profile, { before, body });
      throw new CronError("unknown", "Hermes didn't confirm the job, and the list couldn't be read to check. It may have been created: refresh the list before creating it again. Create checks the list first.");
    }
    const made = answer ? after.find((j) => j.id === answer.id) : created(after, before, body);
    if (made) return made;
    if (answer) throw new CronError("unknown", "Hermes answered that it created the job, but the list doesn't have it. Another Hermes client may have deleted it at once.");
    this.unsure.set(profile, { before, body });
    throw new CronError("unknown", `${failure!.message} The job isn't in the list, so it wasn't created. Create again to retry; it checks the list first.`);
  }

  /**
   * Saves the owner's edits to `base`, the job as it was when the editor opened, and returns the job as the list has
   * it afterwards. Only the fields that differ from `base` are sent. Throws `CronConflict` if the job's shown fields
   * changed in another client meanwhile; passing that conflict's job as `base` saves over them.
   */
  async update(profile: string, base: CronJob, edits: Partial<JobFields>): Promise<CronJob> {
    const now = await this.owned(profile, base.id);
    const was = shown(base);
    const is = shown(now);
    const changed = Object.keys(was).filter((k) => was[k] !== is[k] && k !== "paused or running");
    if (changed.length) throw new CronConflict(now, changed);
    const updates: Record<string, unknown> = {};
    if (edits.name !== undefined && edits.name.trim() !== base.name) updates.name = edits.name.trim();
    if (edits.prompt !== undefined && edits.prompt.trim() !== base.prompt.trim()) updates.prompt = edits.prompt.trim();
    if (edits.schedule !== undefined) updates.schedule = edits.schedule.trim();
    if (edits.deliver !== undefined && edits.deliver !== base.deliver) updates.deliver = edits.deliver;
    if (edits.repeat !== undefined && edits.repeat !== base.repeat.times) updates.repeat = edits.repeat ?? "forever";
    if (!Object.keys(updates).length) return now;

    const [raw, failure] = await this.attempt("PUT", `${jobPath(base.id)}?${q(profile)}`, { updates });
    const answer = this.answered(profile, raw);
    const back = await this.readBack(profile, base.id, "Hermes didn't confirm the change");
    if (!back) throw new CronError("gone", "The job was deleted in another Hermes client as it was saved.");
    const wrong = [
      updates.name !== undefined && back.name !== updates.name && "name",
      updates.prompt !== undefined && back.prompt.trim() !== updates.prompt && "prompt",
      updates.deliver !== undefined && back.deliver !== updates.deliver && "delivery",
      updates.repeat !== undefined && back.repeat.times !== (edits.repeat ?? null) && "repeat limit",
      updates.schedule !== undefined &&
        (answer ? shown(back).schedule !== shown(answer).schedule : shown(back).schedule === shown(base).schedule && back.scheduleText === base.scheduleText) &&
        "schedule",
    ].filter((w): w is string => !!w);
    if (!wrong.length) return back;
    if (failure) throw new CronError("unknown", `${failure.message} The job as Hermes has it now doesn't have your changes, so they weren't saved.`);
    throw new CronError("unknown", `Hermes took the change, but reading the job back shows a different ${wrong.join(", ")}: another Hermes client may have changed it at the same moment.`);
  }

  /** The job from the list after a write; throws `unknown` when the list can't be read. */
  private async readBack(profile: string, id: string, why: string): Promise<CronJob | undefined> {
    try {
      return (await this.list(profile)).find((j) => j.id === id);
    } catch {
      throw new CronError("unknown", `${why}, and the list couldn't be read to check. Refresh to see how the job is now.`);
    }
  }

  /** Pauses or resumes a job; resolves with the job as the list has it afterwards, once it shows the change. */
  async setPaused(profile: string, job: CronJob, paused: boolean): Promise<CronJob> {
    const now = await this.owned(profile, job.id);
    if (now.enabled === !paused) return now;
    const [raw, failure] = await this.attempt("POST", `${jobPath(job.id)}/${paused ? "pause" : "resume"}?${q(profile)}`);
    this.answered(profile, raw);
    const back = await this.readBack(profile, job.id, `Hermes didn't confirm the ${paused ? "pause" : "resume"}`);
    if (!back) throw new CronError("gone", "The job was deleted in another Hermes client.");
    if (back.enabled === !paused) return back;
    throw new CronError("unknown", `${failure ? `${failure.message} ` : ""}The job is still ${paused ? "running on its schedule" : "paused"} on the server.`);
  }

  /** Deletes a job for good, in every Hermes client; resolves once the list no longer has it. */
  async remove(profile: string, job: CronJob): Promise<void> {
    await this.owned(profile, job.id);
    let failure: CronError | undefined;
    try {
      await this.call("DELETE", `${jobPath(job.id)}?${q(profile)}`);
    } catch (e) {
      failure = cronError(e);
      if (failure.kind === "gone") return;
      if (failure.kind !== "unknown") throw failure;
    }
    if (!(await this.readBack(profile, job.id, "Hermes didn't confirm the delete"))) return;
    throw new CronError("unknown", `${failure ? `${failure.message} ` : ""}The job is still on the server.`);
  }

  /**
   * Asks Hermes to run the job now, on the server, as its schedule would. Hermes answers once the run has finished,
   * which can take as long as the job does. A paused job is resumed by it (Hermes's own rule).
   */
  async runNow(profile: string, job: CronJob): Promise<RunOutcome> {
    const before = await this.owned(profile, job.id);
    let raw: unknown;
    try {
      raw = await this.call("POST", `${jobPath(job.id)}/trigger?${q(profile)}`);
    } catch (e) {
      const err = cronError(e);
      if (err.kind === "busy") throw new CronError("busy", "This job is running already. Its result shows here once it finishes.");
      if (err.kind === "unknown")
        throw new CronError("unknown", `${err.message} Hermes may still be running the job, or have finished it: refresh to see its last run.`);
      throw err;
    }
    const answer = this.answered(profile, raw);
    const back = (await this.list(profile).catch(() => undefined))?.find((j) => j.id === job.id) ?? answer;
    return { job: back, completed: !!back && back.lastRunAt !== before.lastRunAt };
  }
}

/** A job's last result in words, from `last_status` (`cron/jobs.py` `_record_run_outcome` and the scheduler). */
export function statusLabel(status: string): { text: string; tone: "good" | "bad" | "warn" } {
  const known: Record<string, [string, "good" | "bad" | "warn"]> = {
    ok: ["Succeeded", "good"],
    error: ["Failed", "bad"],
    delivery_failed: ["Ran, but delivery failed", "warn"],
    delivery_queued: ["Ran; delivery is queued", "warn"],
    blocked_config: ["Blocked by its settings", "bad"],
    suppressed: ["Ran; nothing to deliver", "good"],
  };
  const [t, tone] = known[status] ?? [sentence(status.replace(/_/g, " ")).replace(/\.$/, ""), "warn"];
  return { text: t, tone };
}

/**
 * The time zone the profile's jobs are scheduled in, as far as the app can tell. `named`: Hermes names it, so
 * daylight-saving changes can be previewed. `note` says what the app couldn't confirm.
 */
export type JobsZone = { zone: Zone; label: string; named: boolean; note?: string };

/** The UTC offset an ISO time from Hermes carries, in ms, or undefined. */
function stampOffset(iso: string): number | undefined {
  if (/Z$/i.test(iso)) return 0;
  const m = /([+-])(\d\d):(\d\d)$/.exec(iso);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000 : undefined;
}

/**
 * Hermes schedules a profile's jobs in its `timezone` setting, else the server's own zone, which it doesn't name
 * (`hermes_time`). `setting` is the profile's `timezone` ("" when unset, undefined when it couldn't be read). The
 * times Hermes stamped when it saved and ran jobs (`created_at`, `last_run_at`) show the offset it really used.
 */
export function jobsZone(setting: string | undefined, jobs: CronJob[], here = Intl.DateTimeFormat().resolvedOptions().timeZone): JobsZone {
  const stamps = jobs.flatMap((j) => [j.lastRunAt, j.createdAt]).filter((s): s is string => !!s && !Number.isNaN(Date.parse(s)));
  if (setting && knownZone(setting)) {
    const off = stamps.some((s) => stampOffset(s) !== undefined && stampOffset(s) !== offsetAt(setting, Date.parse(s)));
    return {
      zone: setting,
      label: setting,
      named: true,
      ...(off && { note: `Some times Hermes recorded use another offset than ${setting}. The server may set its time zone another way, such as HERMES_TIMEZONE; times here follow ${setting}.` }),
    };
  }
  const latest = stamps.sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  const offset = latest === undefined ? undefined : stampOffset(latest);
  const unknown = setting ? `Hermes names the time zone “${setting}”, which this computer doesn't know.` : setting === undefined ? "Hermes Chat couldn't read the profile's time zone setting." : "Hermes uses the server's own time zone and doesn't name it.";
  if (offset !== undefined) {
    const label = offsetLabel(offset);
    return { zone: `${offset < 0 ? "-" : "+"}${label.slice(4)}`, label: `the server's time, ${label}`, named: false, note: `${unknown} Times show its offset now, ${label}, so daylight-saving changes can't be previewed.` };
  }
  return { zone: here, label: `this computer's time zone, ${here}`, named: false, note: `${unknown} Until it has saved a job, times show in this computer's time zone, which may differ from the server's.` };
}
