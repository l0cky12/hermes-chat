// Scheduled jobs (GLOSSARY.md "Scheduled job", ADR 0013): Hermes's own cron jobs for one profile, read and written over
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
import { rowText } from "./branch";
import { RestError, type RestMethod } from "./pipe";
import { CapabilityUnsupportedError } from "./capabilities";
import { type Schedule, type Zone, knownZone, offsetAt, offsetLabel, parseSchedule, storedSchedule } from "./schedule";
import { errorText, isObj } from "./values";

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
  /** The platform of the chat the job was made from (`origin.platform`), where a bare platform delivery can fall back. */
  originPlatform?: string;
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

/** How one run went, as far as Hermes recorded it. `unknown`: Hermes has no outcome for it. */
export type RunState = "running" | "succeeded" | "failed" | "unknown";

/**
 * One run of a job (`GET /api/cron/jobs/{id}/runs`): an agent session, or a script job's saved output. `error` is what
 * Hermes recorded about a failure; `note` says why the state is what it is when that isn't plain. `sessionId` is the
 * agent run's Hermes session, whose reply `CronApi.runResult` reads.
 */
export type JobRun = {
  id: string;
  title: string;
  preview?: string;
  startedAt: number;
  endedAt?: number;
  state: RunState;
  error?: string;
  note?: string;
  script: boolean;
  sessionId?: string;
};

/** What an agent run replied, read from its session. `reply` is undefined when the session has no reply. */
export type RunResult = { reply?: string; at?: number };

/** How many runs the history shows at first, and adds each time the owner asks for more. */
export const RUNS_PAGE = 20;

/** The fields the editor sets. `schedule` is the schedule as typed, `repeat` null for no limit. */
export type JobFields = { name: string; prompt: string; schedule: string; deliver: string; repeat: number | null };

/** What a manual run came to. `completed` is false when Hermes took the run but recorded no result yet. */
/**
 * What a manual run came to. `completed` is false when Hermes took the run but recorded no result yet. `job` is the
 * job as the list has it after; undefined when the list no longer has it (a one-shot Hermes removed, or a delete
 * elsewhere). `unverified`: the list couldn't be read, so `job` is only Hermes's answer.
 */
export type RunOutcome = { job?: CronJob; completed: boolean; unverified?: boolean };

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

/** The most runs Hermes lists for a job (`_list_cron_job_runs_sync`): it takes a limit but no offset. */
export const RUNS_MAX = 100;

/**
 * What Hermes does with a run the scheduler missed, say while the server was down (`cron/jobs.py`
 * `_compute_grace_seconds`, `_fast_forward_missed_recurring`, `ONESHOT_GRACE_SECONDS`). A recurring run up to half its
 * period late (2 minutes to 2 hours) still runs; later than that, missed runs become one run as soon as Hermes can,
 * or none when `cron.catch_up_missed` is off. A one-shot more than 2 minutes late doesn't run.
 */
export function missedRunNote(s: Schedule, periodMs: number | undefined, catchUp: boolean): string {
  if (s.kind === "once") return "If the server's scheduler isn't running at that time, and only starts more than 2 minutes later, Hermes doesn't run it.";
  const grace = Math.max(120, Math.min(Math.floor((periodMs ?? 0) / 2000), 7200));
  const said = grace >= 3600 ? `${+(grace / 3600).toFixed(1)} ${grace === 3600 ? "hour" : "hours"}` : `${Math.round(grace / 60)} minutes`;
  return `If the server's scheduler is down when a run is due, Hermes still runs it up to ${said} late. ${
    catchUp ? "Later than that, the runs it missed become one run as soon as it can, and the schedule goes on." : "Later than that, Hermes skips it (cron.catch_up_missed is off for this profile)."
  }`;
}

export type RestFn = (method: RestMethod, pathAndQuery: string, body?: unknown) => Promise<unknown>;

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
    originPlatform: isObj(v.origin) ? opt(v.origin.platform) : undefined,
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

/**
 * A script run's row is its output doc, titled with the execution ledger's status (`COMPLETED · …`, `FAILED · …`,
 * `_execution_status_title`) or, for the one row Hermes makes from the job when no doc survived (id `…:latest`), its
 * `last_status`, alone or with `last_error` (`OK`, `ERROR · …`, `_cron_output_status_label`). What each says about the
 * run; `error` is said before whatever Hermes recorded with it.
 */
const SCRIPT_STATES: Record<string, { state: RunState; error?: string; note?: string }> = {
  completed: { state: "succeeded" },
  ok: { state: "succeeded" },
  suppressed: { state: "succeeded", note: "Ran; nothing to deliver." },
  delivery_queued: { state: "succeeded", note: "Ran; delivery is queued." },
  delivery_failed: { state: "failed", error: "The run finished, but delivering its result failed." },
  failed: { state: "failed" },
  error: { state: "failed" },
  blocked_config: { state: "failed", error: "Blocked by the job's settings." },
};

/**
 * How an agent run's session ended (`cron/scheduler.py`): `cron_complete` when its last row is a real reply,
 * `cron_incomplete_no_output` when the turn died before one. A run that was compressed continues in a new session,
 * and Hermes lists only the first (`list_cron_job_runs`).
 */
function agentState(v: Record<string, unknown>, running: boolean): Pick<JobRun, "state" | "error" | "note"> {
  if (running) return { state: "running" };
  const reason = text(v.end_reason);
  if (v.ended_at == null)
    return { state: "unknown", note: "Hermes has no end recorded for this run, and no scheduler is running it: its process may have stopped." };
  if (reason === "cron_complete") return { state: "succeeded" };
  if (reason === "cron_incomplete_no_output") return { state: "failed", error: "The run ended without a final reply from the agent." };
  if (reason === "compression") return { state: "unknown", note: "Hermes compressed this run and went on in a new session, which it doesn't list, so how it ended isn't shown." };
  return { state: "unknown", note: reason ? `Hermes recorded the run's end as “${reason}”.` : "Hermes recorded no outcome for this run." };
}

function toRun(v: unknown): JobRun | undefined {
  if (!isObj(v) || typeof v.id !== "string") return undefined;
  const startedAt = typeof v.started_at === "number" ? v.started_at * 1000 : undefined;
  if (startedAt === undefined) return undefined;
  // The doc's text starts with its own header (`# Cron Job: … ---`), which only repeats the job.
  // Only Hermes's own row from the job may be a status alone: an output doc's title is what the script printed.
  const titled = /^([A-Z][A-Z ]*[A-Z]) · ([\s\S]*)$/.exec(text(v.title)) ?? (v.id.endsWith(":latest") ? /^([A-Z][A-Z ]*[A-Z])()$/.exec(text(v.title)) : null);
  const plain = (t: string) => t.replace(/^# Cron Job:[\s\S]*?---\s*/, "").trim();
  const script = v.source === "cron_output";
  const running = v.scheduler_owned === true || (v.ended_at == null && v.is_active === true);
  const detail = plain(titled ? titled[2] : text(v.title));
  const title = detail || "Run";
  const preview = opt(plain(text(v.preview)));
  let outcome: Pick<JobRun, "state" | "error" | "note">;
  if (!script) outcome = agentState(v, running);
  else if (!titled) outcome = { state: "unknown", note: "Hermes kept this run's output, but no record of how it ended." };
  else {
    const word = titled[1].toLowerCase().replace(/ /g, "_");
    // Own keys only: a status such as `CONSTRUCTOR` must not reach the object's prototype.
    const known = Object.prototype.hasOwnProperty.call(SCRIPT_STATES, word) ? SCRIPT_STATES[word] : undefined;
    const said = (lead: string) => (detail ? `${lead.replace(/\.$/, "")}: ${detail}` : lead);
    outcome = !known
      ? { state: "unknown", note: `Hermes recorded “${sentence(titled[1].toLowerCase()).replace(/\.$/, "")}”.` }
      : known.state === "failed"
        ? { state: "failed", error: known.error ? said(known.error) : detail || "Hermes recorded the run as failed, with no reason." }
        : { state: known.state, ...(known.note && { note: known.note }) };
  }
  return {
    id: v.id,
    title,
    preview,
    startedAt,
    endedAt: typeof v.ended_at === "number" && v.ended_at * 1000 >= startedAt ? v.ended_at * 1000 : undefined,
    ...outcome,
    script,
    ...(v.source === "cron" && { sessionId: v.id }),
  };
}

/**
 * What Hermes would do with a job's `deliver` (`cron/scheduler_delivery.py` `_resolve_single_delivery_target`), checked
 * against the profile's targets (`cron_delivery_targets`): each place it names that Hermes can't deliver to, in words.
 * `local`, `origin` and `all` always resolve or fall back on the server, so they are never a problem here. A platform
 * named alone goes to its home channel, or to the chat the job came from on that platform (`originPlatform`).
 */
export function deliveryProblems(deliver: string, targets: DeliveryTarget[], originPlatform?: string): string[] {
  const named = (p: string) => p.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return deliver
    .split(",")
    .map((d) => d.trim())
    .filter((d) => d && !["local", "origin", "all"].includes(d))
    .flatMap((d) => {
      // `parse_bot_chat_deliver_token`: `bot-chat` alone (or with no name) is the job's own profile; a name is
      // matched as `normalize_profile_name` does, trimmed and lowercased.
      if (/^bot-chat(:|$)/i.test(d)) {
        const name = d.slice(9).trim();
        return !name || targets.some((t) => t.id === `bot-chat:${name.toLowerCase()}`) ? [] : [`Bot Chat (${name}) isn't a profile on this server, so Hermes won't deliver there.`];
      }
      const platform = d.includes(":") ? d.slice(0, d.indexOf(":")) : d;
      const t = targets.find((x) => x.id === platform.toLowerCase());
      if (!t) return [`${named(platform)} isn't set up on this profile's gateway, so Hermes won't deliver there.`];
      if (!d.includes(":") && !t.ready && originPlatform !== platform)
        return [`${t.name} has no home channel set on the server, so Hermes won't deliver there.`];
      return [];
    });
}

const sentence = (s: string) => {
  const t = s.trim();
  return t ? `${t[0].toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? "" : "."}` : t;
};

/**
 * A failed call as the owner reads it, and whether it may have taken effect. A dashboard answer is a `RestError`; the
 * Rust relay words one it can't reach as `Can't reach the Hermes dashboard: …`.
 */
export function cronError(e: unknown): CronError {
  if (e instanceof CronError) return e;
  const message = errorText(e);
  if (message === "Not connected to Hermes." || message === "The chat connection is closed.")
    return new CronError("offline", "Hermes Chat isn't connected to Hermes, so nothing was sent. Jobs keep running on the server.");
  if (e instanceof RestError && e.status === 401) return new CronError("forbidden", "The dashboard sign-in has expired, so nothing was changed. Sign in again.");
  if (e instanceof CapabilityUnsupportedError) return new CronError("unsupported", "This Hermes server has no scheduled jobs, so nothing was sent. Updating Hermes adds them.");
  if (!(e instanceof RestError)) return /doesn't relay/.test(message) ? new CronError("unsupported", "This version of Hermes Chat can't send that to Hermes.") : new CronError("unknown", `Hermes didn't answer: ${message}`);
  const status = e.status;
  let detail: unknown = e.body.trim();
  try {
    detail = JSON.parse(e.body).detail ?? detail;
  } catch {
    // Not JSON, or cut short by the relay: the text as it came.
  }
  const said = typeof detail === "string" ? detail : isObj(detail) && typeof detail.message === "string" ? detail.message : JSON.stringify(detail);
  if ((status === 404 || status === 405) && said === "Not Found") return new CronError("unsupported", "This Hermes server has no scheduled jobs. Updating Hermes adds them.");
  if (status === 404 && /^Profile '.*' does not exist\.$/.test(said)) return new CronError("gone", `${said} It may have been deleted in another Hermes client.`);
  if (status === 404) return new CronError("gone", "This job isn't on the server any more: it was deleted in another Hermes client.");
  if (status === 403) return new CronError("forbidden", `The dashboard doesn't allow this: ${said}`);
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

/**
 * A create whose answer was lost: the ids the list had before it went, and what it asked for. `warned`: the owner has
 * been told it may still appear, so the next create sends anew.
 */
type Unsure = { before: Set<string>; body: Record<string, unknown>; warned?: boolean };

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

  /**
   * The profile's scheduling settings (`config.yaml`): `timezone`, "" when it has none and Hermes uses the server's
   * zone, and `catchUp`, false when `cron.catch_up_missed` is off and Hermes skips runs missed by more than their grace.
   */
  async scheduling(profile: string): Promise<{ timezone: string; catchUp: boolean }> {
    const config = await this.call("GET", `api/config?${q(profile)}`);
    const cron = isObj(config) && isObj(config.cron) ? config.cron : {};
    return { timezone: isObj(config) && typeof config.timezone === "string" ? config.timezone.trim() : "", catchUp: cron.catch_up_missed !== false };
  }

  /** The profile's `timezone` setting, or "" when it has none. */
  async timezone(profile: string): Promise<string> {
    return (await this.scheduling(profile)).timezone;
  }

  /** Where the profile can deliver results. `ready` is false for a platform with no home channel set. */
  async targets(profile: string): Promise<DeliveryTarget[]> {
    const res = await this.call("GET", `api/cron/delivery-targets?${q(profile)}`);
    const rows = isObj(res) && Array.isArray(res.targets) ? res.targets : [];
    return rows.filter(isObj).filter((t) => typeof t.id === "string" && t.id).map((t) => ({ id: t.id as string, name: text(t.name) || (t.id as string), ready: t.home_target_set !== false }));
  }

  /**
   * The job's latest runs, newest first, up to `limit`: Hermes lists at most 100 (`RUNS_MAX`) and has no paging past
   * them. Reads only, and only this profile's: Hermes would read another's copy.
   */
  async runs(profile: string, job: CronJob, limit = 20): Promise<JobRun[]> {
    await this.owned(profile, job.id);
    const res = await this.call("GET", `${jobPath(job.id)}/runs?${q(profile)}&limit=${limit}`);
    const rows = isObj(res) && Array.isArray(res.runs) ? res.runs : [];
    if (rows.some((r) => isObj(r) && typeof r.profile === "string" && r.profile !== profile))
      throw new CronError("gone", "Hermes answered with the runs of this job's copy in another profile, so they aren't shown here.");
    // A script run's rows carry no profile: had the job gone meanwhile, they could be another profile's copy's. So the
    // job must still be this profile's once they are read.
    await this.owned(profile, job.id);
    return rows.map(toRun).filter((r): r is JobRun => !!r);
  }

  /**
   * The other profiles that have a job with this id: Hermes copies a profile's jobs into a profile made from it. Hermes
   * acts on such a copy if this profile's job is gone when a change arrives (`_job_owner_profile`), so the screen says
   * so. Profiles whose jobs can't be read are left out; it never throws.
   */
  async copiesOf(profile: string, id: string): Promise<string[]> {
    const names = (await this.profiles().catch(() => [])).filter((n) => n !== profile);
    const found = await Promise.all(names.map((n) => this.list(n).then((jobs) => (jobs.some((j) => j.id === id) ? n : ""), () => "")));
    return found.filter(Boolean);
  }

  /** The server's profiles by name (`GET /api/profiles`), each with its own jobs. */
  async profiles(): Promise<string[]> {
    const res = await this.call("GET", "api/profiles");
    return (isObj(res) && Array.isArray(res.profiles) ? res.profiles : []).map((p) => (isObj(p) ? text(p.name) : "")).filter(Boolean);
  }

  /**
   * The reply an agent run ended with: the newest assistant text in its session (`GET /api/sessions/{id}/messages`,
   * which opens only the named profile's store, unlike the per-job cron routes). Reads only. A script run has no
   * session; its output is the run's preview.
   */
  async runResult(profile: string, run: JobRun): Promise<RunResult> {
    if (!run.sessionId) throw new CronError("refused", "This run has no agent session: what it printed is shown with the run.");
    const res = await this.call("GET", `api/sessions/${encodeURIComponent(run.sessionId)}/messages?${q(profile)}&order=latest&limit=50`).catch((e: CronError) => {
      if (e.kind === "gone") throw new CronError("gone", "This run's session isn't on the server any more.");
      throw e;
    });
    if (!isObj(res)) throw new CronError("unknown", "Hermes answered without the run's messages.");
    if (typeof res.profile === "string" && res.profile !== profile) throw new CronError("unknown", `Hermes answered with a session in the ${res.profile} profile, not ${profile}, so it isn't shown.`);
    const rows = Array.isArray(res.messages) ? res.messages.filter(isObj) : [];
    // `order=latest` is the newest page, in stored order (row ids rising), so the reply is the replying row with the
    // highest id. A hidden row is Hermes's own, not the agent's reply.
    const replies = rows.filter((m) => m.role === "assistant" && m.display_kind !== "hidden" && rowText(m.content).trim());
    const rowId = (m: Record<string, unknown>) => (typeof m.id === "number" ? m.id : -1);
    const last = replies.reduce<Record<string, unknown> | undefined>((best, m) => (!best || rowId(m) >= rowId(best) ? m : best), undefined);
    return last ? { reply: rowText(last.content).trim(), ...(typeof last.timestamp === "number" && { at: last.timestamp * 1000 }) } : {};
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
      if (made) {
        this.unsure.delete(profile);
        if (JSON.stringify(earlier.body) === JSON.stringify(body)) return made;
        throw new CronError("refused", `Your earlier try did create “${made.name}”: it's in the list now. Edit that job instead of creating another.`);
      }
      // Hermes may still be saving it after the connection dropped: a list without it proves nothing. Say so once, and
      // send anew only when the owner presses Create again.
      if (!earlier.warned) {
        earlier.warned = true;
        throw new CronError("unknown", "Your last try may still be saved by Hermes: the list doesn't show it yet. Refresh in a moment. If it still isn't there, press Create again to send it anew; if both arrive, delete one.");
      }
      this.unsure.delete(profile);
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
    throw new CronError("unknown", `${failure!.message} The job isn't in the list yet. Hermes may still save it, so refresh before creating it again; Create checks the list first.`);
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
    // With a new schedule the repeat limit goes too, even unchanged: Hermes re-derives it when the schedule's kind
    // changes (a one-shot's 1 becomes no limit), and the owner saw and kept the one in the form.
    if (edits.repeat !== undefined && (edits.repeat !== base.repeat.times || updates.schedule !== undefined)) updates.repeat = edits.repeat ?? "forever";
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
      updates.schedule !== undefined && (answer ? shown(back).schedule !== shown(answer).schedule : !(await this.scheduleIs(profile, back, String(updates.schedule)))) && "schedule",
    ].filter((w): w is string => !!w);
    if (!wrong.length) return back;
    if (failure) throw new CronError("unknown", `${failure.message} The job as Hermes has it now doesn't have your changes, so they weren't saved.`);
    throw new CronError("unknown", `Hermes took the change, but reading the job back shows a different ${wrong.join(", ")}: another Hermes client may have changed it at the same moment.`);
  }

  /**
   * Whether a job's schedule is the one `typed` asks for, when Hermes's answer was lost: by Hermes's label for it
   * (`parse_schedule`'s `display`) and its expression, interval or instant. A time without an offset is read in the
   * profile's zone; when that can't be read, or for `in 30m`, which Hermes counts from its own clock, only a run
   * within five minutes of the one asked for counts.
   */
  private async scheduleIs(profile: string, job: CronJob, typed: string): Promise<boolean> {
    let want: Schedule;
    try {
      want = parseSchedule(typed, "UTC", 0);
    } catch {
      return false;
    }
    const s = job.schedule;
    if (job.scheduleText !== want.display || s?.kind !== want.kind) return false;
    if (want.kind === "cron") return s.kind === "cron" && s.expr === want.expr;
    if (want.kind === "interval") return s.kind === "interval" && s.minutes === want.minutes;
    if (s.kind !== "once") return false;
    if (/^in /i.test(typed.trim())) return Math.abs(s.runAt - (parseSchedule(typed, "UTC", Date.now()) as { runAt: number }).runAt) < 5 * 60_000;
    if (/(Z|[+-]\d{2}:?\d{2})$/i.test(typed.trim())) return s.runAt === want.runAt;
    const zone = await this.timezone(profile).catch(() => "");
    return !!zone && knownZone(zone) && s.runAt === (parseSchedule(typed, zone, 0) as { runAt: number }).runAt;
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
    const copies = await this.copiesOf(profile, job.id);
    let failure: CronError | undefined;
    try {
      await this.call("DELETE", `${jobPath(job.id)}?${q(profile)}`);
    } catch (e) {
      failure = cronError(e);
      if (failure.kind === "gone") return;
      if (failure.kind !== "unknown") throw failure;
    }
    const still = await this.readBack(profile, job.id, "Hermes didn't confirm the delete");
    if (copies.length) {
      // A copy elsewhere that went with it means Hermes deleted that one: this profile's job was gone first.
      // Only a read that worked can show a copy gone; a profile that can't be read says nothing.
      const gone = (await Promise.all(copies.map((c) => this.list(c).then((jobs) => (jobs.some((j) => j.id === job.id) ? "" : c), () => "")))).filter(Boolean);
      if (gone.length)
        throw new CronError("unknown", `Hermes deleted the copy of this job in the ${gone.join(" and ")} profile, since this profile's job had just been deleted elsewhere. That can't be undone here.`);
    }
    if (!still) return;
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
    const ran = (j?: CronJob) => !!j && (j.lastRunAt !== before.lastRunAt || j.state === "completed");
    const jobs = await this.list(profile).catch(() => undefined);
    if (!jobs) return { job: answer, completed: ran(answer), unverified: true };
    const back = jobs.find((j) => j.id === job.id);
    // Gone from the list: a one-shot Hermes removed once it ran, or a delete in another client.
    return back ? { job: back, completed: ran(back) } : { completed: ran(answer) };
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
