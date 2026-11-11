// Scheduled jobs (GLOSSARY.md "Scheduled job", ADR 0013): the profile's cron jobs, which Hermes keeps and runs on the
// server, also while Hermes Chat is closed. The screen lists them with their schedule, time zone and next run, and
// creates, edits, pauses, resumes, runs and deletes them through Hermes. Every change shows only once Hermes, read
// back, has it. Every read is sequenced: an answer that a newer read, another job or another profile has superseded
// is dropped, never shown.
import { type RefObject, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ArrowLeft, CalendarClock, ChevronDown, ChevronRight, CircleAlert, History, MessageSquare, Pause, Pencil, Play, Plus, RefreshCw, Trash2, Wrench, Zap } from "lucide-react";
import {
  CronConflict,
  CronError,
  RUNS_MAX,
  RUNS_PAGE,
  type CronApi,
  type CronJob,
  type DeliveryTarget,
  type JobFields,
  type JobRun,
  type JobsZone,
  type RunResult,
  type RunState,
  deliveryProblems,
  jobsZone,
  missedRunNote,
  statusLabel,
} from "../hermes/cronJobs";
import { type Schedule, ScheduleError, clockChangeNote, explainSchedule, formatInstant, isoIn, offsetAt, parseSchedule, upcomingRuns } from "../hermes/schedule";
import { type Troubleshoot, type TroubleshootMessage, type TroubleshootStore, type TroubleshootInput, gatherTroubleshoot, jobChanges, troubleshootMessage } from "../hermes/troubleshoot";
import { Spinner } from "./bits";
import { errorText } from "../hermes/values";

const HERE = Intl.DateTimeFormat().resolvedOptions().timeZone;
/** A scheduler that hasn't checked the jobs for this long is likely not running (it checks about every minute). */
const STALE_SCHEDULER_S = 300;
/** `returnTo` for the editor of a new job, which has no id. */
const NEW = "\u0000new";

/** A profile's jobs and what scheduling them needs. `targets` is undefined when Hermes's list of them couldn't be read. */
type Loaded = { jobs: CronJob[]; zone: JobsZone; targets?: DeliveryTarget[]; catchUp: boolean };
/** `ask`: open the job with its Troubleshoot preview started, as the list's Troubleshoot button does. */
type View = { kind: "list" } | { kind: "job"; id: string; ask?: boolean } | { kind: "edit"; id?: string };

/**
 * Handing a job to Hermes in a new chat (ADR 0053). `start` starts the chat in this profile with the message, which
 * the app shows; `openChat` shows an earlier one. Left out, the screen has no Troubleshoot buttons.
 */
export type TroubleshootWiring = {
  store: TroubleshootStore;
  scope: string;
  start: (job: CronJob, text: string) => Promise<unknown>;
  openChat: (chatId: string) => void;
};
const NO_TROUBLES: Troubleshoot[] = [];
const noSubscribe = () => () => {};

/** Reads a profile's jobs, time zone, catch-up setting and delivery targets. Only the job list is required. */
async function readProfile(api: CronApi, profile: string): Promise<Loaded> {
  const [jobs, setting, targets] = await Promise.all([api.list(profile), api.scheduling(profile).catch(() => undefined), api.targets(profile).catch(() => undefined)]);
  return { jobs, zone: jobsZone(setting?.timezone, jobs), targets, catchUp: setting?.catchUp ?? true };
}

/**
 * Orders a component's reads: `next()` starts one and supersedes those before it, and `current(n)` is true only for
 * the latest while the component is mounted. StrictMode's extra unmount supersedes the reads of the first mount.
 */
function useSequence() {
  const seq = useRef(0);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      // eslint-disable-next-line react-hooks/exhaustive-deps -- predates the hook lint (#493)
      seq.current++;
    };
  }, []);
  return useMemo(() => ({ next: () => ++seq.current, current: (n: number) => live.current && n === seq.current, live: () => live.current }), []);
}

/** An instant on the schedule's clock, and on this computer's when that reads differently. */
function When({ at, zone }: { at: number; zone: JobsZone }) {
  const there = formatInstant(at, zone.zone);
  const differs = zone.zone !== HERE && offsetAt(zone.zone, at) !== offsetAt(HERE, at);
  return (
    <span>
      {there}
      {differs && <span className="faint"> · {formatInstant(at, HERE, { weekday: false, year: false })} here</span>}
    </span>
  );
}

/** Which clock the times on this screen are on: the schedule's, and this computer's beside it when they differ. */
function zoneSentence(zone: JobsZone): string {
  // A zone Hermes doesn't name is only how times are shown here; the banner below says what is unknown.
  if (!zone.named) return `Times are shown in ${zone.label}, which may not be the zone Hermes runs this profile's jobs in.`;
  const differs = zone.zone !== HERE && offsetAt(zone.zone, Date.now()) !== offsetAt(HERE, Date.now());
  return `Times are in ${zone.label}, the schedule time zone Hermes runs this profile's jobs in.${differs ? ` Where this computer's time zone, ${HERE}, reads differently, its time is shown too, marked “here”.` : ""}`;
}

function deliveryLabel(id: string, targets: DeliveryTarget[] | undefined): string {
  if (id === "local") return "Saved on the server only";
  if (id === "origin") return "Back where it was created";
  return id
    .split(",")
    .map((d) => targets?.find((x) => x.id === d.trim())?.name ?? d.trim())
    .join(", ");
}

/** Whether a job will run on its schedule, and what to say instead when it won't. */
function runState(j: CronJob): { runs: true } | { runs: false; why: string; tone: "muted" | "bad" } {
  if (j.state === "completed") return { runs: false, why: "Finished: it has no more runs.", tone: "muted" };
  if (!j.enabled || j.state === "paused") return { runs: false, why: "Paused: it won't run until resumed.", tone: "muted" };
  if (j.state === "error") return { runs: false, why: j.lastError ?? "Hermes can't work out its next run.", tone: "bad" };
  if (!j.nextRunAt) return { runs: false, why: "Hermes has no next run for it.", tone: "muted" };
  return { runs: true };
}

/** Whether Hermes's ledger says a run of the job is under way now. */
const underWay = (j: CronJob) => !!j.latest && ["claimed", "running"].includes(j.latest.status);

function NextRun({ job, zone }: { job: CronJob; zone: JobsZone }) {
  const s = runState(job);
  if (!s.runs) return <span className={s.tone === "bad" ? "bad" : "muted"}>{s.why}</span>;
  return (
    <span>
      Next: <When at={Date.parse(job.nextRunAt!)} zone={zone} />
    </span>
  );
}

function LastRun({ job, zone }: { job: CronJob; zone: JobsZone }) {
  if (!job.lastRunAt) return <span className="faint">Hasn't run yet</span>;
  const status = job.lastStatus ? statusLabel(job.lastStatus) : undefined;
  return (
    <span>
      Last run: {status && <span className={`job-status ${status.tone}`}>{status.text}</span>}
      {status && " · "}
      <When at={Date.parse(job.lastRunAt)} zone={zone} />
    </span>
  );
}

function stateBadge(j: CronJob) {
  if (underWay(j)) return <span className="badge">Running</span>;
  if (j.state === "completed") return <span className="badge">Finished</span>;
  if (!j.enabled || j.state === "paused") return <span className="badge">Paused</span>;
  if (j.state === "error") return <span className="badge warn">Error</span>;
  return null;
}

/** The upcoming runs Hermes's rules make, from its own next run, with what the next clock change does. */
function Upcoming({ schedule, zone, first, remaining }: { schedule?: Schedule; zone: JobsZone; first?: number; remaining?: number | null }) {
  if (!schedule) return <p className="muted small">Hermes Chat can't preview this schedule; Hermes's own next run is shown above.</p>;
  const count = Math.min(5, remaining ?? 5);
  const from = first ?? Date.now();
  // A one-shot has its one run; anything else follows Hermes's next run with the ones after it, up to its limit.
  const later = schedule.kind === "once" ? [] : upcomingRuns(schedule, zone.zone, from, first === undefined ? count : count - 1);
  if (!later) return <p className="muted small">Hermes Chat can't preview this cron expression. Hermes checks it, and works out the runs itself.</p>;
  const runs = (schedule.kind === "once" ? [first ?? schedule.runAt] : first === undefined ? later : [first, ...later]).slice(0, Math.max(0, count));
  const note = zone.named ? clockChangeNote(schedule, zone.zone, from) : undefined;
  return (
    <>
      {runs.length ? (
        <ol className="job-runs-preview" aria-label="Upcoming runs">
          {runs.map((r) => (
            <li key={r}>
              <When at={r} zone={zone} />
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted small">No more runs.</p>
      )}
      {note && (
        <p className="field-hint block job-dst">
          <CircleAlert size={13} />
          {note}
        </p>
      )}
    </>
  );
}

/**
 * The profile's scheduled jobs. `api` reaches Hermes; nothing here schedules anything itself. The screen starts again
 * when the profile changes (App keys it on the profile).
 */
export function ScheduledJobs({
  api,
  profile,
  connected,
  onClose,
  troubleshoot,
  openJob,
}: {
  api: CronApi;
  profile: string;
  connected: boolean;
  onClose: () => void;
  troubleshoot?: TroubleshootWiring;
  /** The job to show first, instead of the list. */
  openJob?: string;
}) {
  const [loaded, setLoaded] = useState<Loaded>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<CronError | Error>();
  const [view, setView] = useState<View>(openJob ? { kind: "job", id: openJob } : { kind: "list" });
  /** When the newest list read that worked started: a change Hermes made before then is in the list. */
  const [readAt, setReadAt] = useState<number>();
  /** What happened to a job that has left the list, or went to another profile, said on the list. */
  const [notice, setNotice] = useState<string>();
  const loads = useSequence();
  /** Whether a list read is under way, so a write landing meanwhile can supersede it. */
  const listing = useRef(false);
  /** The job whose row to focus when the list shows again. */
  const returnTo = useRef<string | undefined>(undefined);
  const heading = useRef<HTMLHeadingElement>(null);
  const listHeading = useRef<HTMLHeadingElement>(null);
  const newJob = useRef<HTMLButtonElement>(null);

  const load = async () => {
    const n = loads.next();
    listing.current = true;
    setLoading(true);
    setError(undefined);
    const started = Date.now();
    try {
      const got = await readProfile(api, profile);
      if (loads.current(n)) {
        setLoaded(got);
        setReadAt(started);
      }
    } catch (e) {
      if (loads.current(n)) setError(e as Error);
    } finally {
      if (loads.current(n)) {
        listing.current = false;
        setLoading(false);
      }
    }
  };

  // This profile's troubleshooting chats. When one's reply ends, the jobs are read again so its changes show.
  const allTroubles = useSyncExternalStore(troubleshoot?.store.subscribe ?? noSubscribe, troubleshoot?.store.getSnapshot ?? (() => NO_TROUBLES));
  const troubles = useMemo(() => allTroubles.filter((t) => t.scope === troubleshoot?.scope && t.profile === profile), [allTroubles, troubleshoot?.scope, profile]);
  const troubleOf = (id: string) => troubles.find((t) => t.jobId === id);
  const endedKey = troubles.filter((t) => t.phase === "ended").map((t) => `${t.id}@${t.endedAt}`).join(" ");
  const endedSeen = useRef(endedKey);
  useEffect(() => {
    if (endedKey === endedSeen.current) return;
    const before = new Set(endedSeen.current.split(" "));
    endedSeen.current = endedKey;
    if (connected && endedKey.split(" ").some((k) => k && !before.has(k))) void load();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- predates the hook lint (#493)
  }, [endedKey]);

  useEffect(() => {
    if (connected) void load();
    else {
      // A read under way when the connection went is superseded: its answer, if one comes, is dropped.
      loads.next();
      listing.current = false;
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- predates the hook lint (#493)
  }, [connected]);

  /** Moves to another view, putting focus where the owner can carry on with the keyboard. */
  const go = (next: View) => {
    if (view.kind !== "list" && next.kind === "list") returnTo.current = view.id ?? NEW;
    setView(next);
  };
  useEffect(() => {
    if (view.kind !== "list") {
      heading.current?.focus();
      return;
    }
    const id = returnTo.current;
    returnTo.current = undefined;
    // Back from a job: its row, or the heading when the job has left the list. Back from a new one: New job.
    const to = id === NEW ? newJob.current : id ? document.querySelector<HTMLElement>(`.job-row[data-job-id="${CSS.escape(id)}"]`) : undefined;
    if (id) (to ?? listHeading.current)?.focus();
  }, [view]);

  /**
   * A job as Hermes read it back after a change, put in the list. `null` takes it out. A list read that started before
   * the change could answer with the job as it was, so it is superseded and the list is read again, after the change.
   */
  const apply = (id: string, job: CronJob | null) => {
    setLoaded((l) => l && { ...l, jobs: job ? (l.jobs.some((j) => j.id === id) ? l.jobs.map((j) => (j.id === id ? job : j)) : [...l.jobs, job]) : l.jobs.filter((j) => j.id !== id) });
    if (listing.current && loads.live()) void load();
  };

  const unsupported = error instanceof CronError && (error.kind === "unsupported" || error.kind === "forbidden");
  const jobs = loaded?.jobs ?? [];
  const shown = view.kind !== "list" && view.id ? jobs.find((j) => j.id === view.id) : undefined;
  const heartbeat = jobs.find((j) => j.heartbeatAge !== undefined)?.heartbeatAge;

  return (
    <div className="settings jobs-screen">
      <div className="settings-inner">
        <button className="back" onClick={view.kind === "list" ? onClose : () => go(view.kind === "edit" && view.id ? { kind: "job", id: view.id } : { kind: "list" })}>
          <ArrowLeft size={15} /> {view.kind === "list" ? "Back to chat" : view.kind === "edit" && view.id ? "Back to the job" : "Back to the jobs"}
        </button>
        {view.kind === "list" && (
          <>
            <h1 className="project-title" ref={listHeading} tabIndex={-1}>
              <CalendarClock size={20} /> <span>Scheduled jobs</span>
            </h1>
            <p className="muted">
              Jobs Hermes runs on the server for the <span className="mono">{profile}</span> profile, at the times set here, also while Hermes Chat is
              closed.{loaded && <> {zoneSentence(loaded.zone)}</>}
            </p>
          </>
        )}
        {!connected && (
          <p className="job-banner" role="status">
            <CircleAlert size={14} /> Not connected to Hermes. Jobs keep running on the server; reconnect to see or change them.
            {loaded && " The list below is as it was last read."}
          </p>
        )}
        {loaded?.zone.note && view.kind === "list" && (
          <p className="job-banner" role="note">
            <CircleAlert size={14} /> {loaded.zone.note}
          </p>
        )}
        {view.kind === "list" && heartbeat === null && (
          <p className="job-banner" role="note">
            <CircleAlert size={14} /> Hermes hasn't recorded its scheduler running for this profile. Jobs run only while the profile's gateway runs on the
            server.
          </p>
        )}
        {view.kind === "list" && typeof heartbeat === "number" && heartbeat > STALE_SCHEDULER_S && (
          <p className="job-banner" role="note">
            <CircleAlert size={14} /> Hermes's scheduler last checked this profile's jobs {Math.round(heartbeat / 60)} minutes ago, so they may not be
            running. Jobs run only while the profile's gateway runs on the server.
          </p>
        )}

        {view.kind === "list" && (
          <>
            {!unsupported && (
              <div className="jobs-actions">
                <button ref={newJob} className="btn primary" disabled={!connected || !loaded} onClick={() => go({ kind: "edit" })}>
                  <Plus size={14} /> New job
                </button>
                <button className="btn" disabled={!connected || loading} onClick={() => void load()}>
                  <RefreshCw size={14} /> Refresh
                </button>
              </div>
            )}
            {notice && (
              <p className="job-notice" role="status">
                {notice}
              </p>
            )}
            {loading && !loaded && (
              <div className="empty-hint" role="status">
                <Spinner /> Loading the jobs…
              </div>
            )}
            {error && (
              <div className="job-error" role="alert">
                <p>{errorText(error)}</p>
                {!unsupported && connected && (
                  <button className="btn" onClick={() => void load()}>
                    Try again
                  </button>
                )}
              </div>
            )}
            {loaded && !jobs.length && !error && (
              <div className="empty-hint jobs-empty">
                No scheduled jobs in this profile yet. A job sends its prompt to Hermes at the times you set, and Hermes delivers the reply where you choose.
              </div>
            )}
            {loaded && jobs.length > 0 && (
              <ul className="job-list">
                {jobs.map((j) => {
                  const problem = loaded.targets && deliveryProblems(j.deliver, loaded.targets, j.originPlatform)[0];
                  const trouble = troubleOf(j.id);
                  return (
                    <li key={j.id} className={troubleshoot ? "job-item has-trouble" : "job-item"}>
                      <button className="job-row" data-job-id={j.id} onClick={() => go({ kind: "job", id: j.id })}>
                        <div className="job-row-head">
                          <span className="job-name">{j.name}</span>
                          {stateBadge(j)}
                        </div>
                        <div className="job-row-line">
                          {j.schedule ? explainSchedule(j.schedule, loaded.zone.zone) : j.scheduleText}
                          <span className="mono faint"> · {j.scheduleText}</span>
                        </div>
                        <div className="job-row-line">
                          <NextRun job={j} zone={loaded.zone} />
                        </div>
                        <div className="job-row-line small">
                          <LastRun job={j} zone={loaded.zone} />
                          <span className="faint"> · {deliveryLabel(j.deliver, loaded.targets)}</span>
                        </div>
                        {problem && <div className="job-row-line small job-status warn">{problem}</div>}
                        {trouble && <div className="job-row-line small job-trouble-line">{troubleLine(trouble, j, loaded.zone, readAt)}</div>}
                      </button>
                      {troubleshoot && (
                        <button
                          className="btn small job-row-trouble"
                          disabled={!connected}
                          aria-label={`Troubleshoot ${j.name}`}
                          title="Hand this job to Hermes in a new chat, to find and fix what's wrong"
                          onClick={() => go({ kind: "job", id: j.id, ask: true })}
                        >
                          <Wrench size={13} /> Troubleshoot
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}

        {view.kind === "job" && loaded && shown && (
          <JobDetail
            key={shown.id}
            api={api}
            profile={profile}
            connected={connected}
            job={shown}
            loaded={loaded}
            heading={heading}
            troubleshoot={troubleshoot}
            trouble={troubleOf(shown.id)}
            ask={view.ask}
            reading={{ at: readAt, loading, error: error && errorText(error), reload: () => void load() }}
            onChanged={apply}
            onEdit={() => go({ kind: "edit", id: shown.id })}
            onDeleted={() => go({ kind: "list" })}
            onToast={(text) => {
              setNotice(text);
              go({ kind: "list" });
            }}
          />
        )}
        {view.kind === "job" && loaded && !shown && <p className="muted">This job isn't in the list any more: it was deleted in another Hermes client.</p>}
        {view.kind === "edit" && loaded && (view.id === undefined || shown) && (
          <JobEditor
            key={view.id ?? "new"}
            api={api}
            profile={profile}
            connected={connected}
            job={shown}
            loaded={loaded}
            heading={heading}
            onSaved={(job, where) => {
              if (where !== profile) {
                setNotice(`Created “${job.name}” in the ${where} profile. Its jobs and runs show when you switch to that profile.`);
                go({ kind: "list" });
                return;
              }
              apply(job.id, job);
              go({ kind: "job", id: job.id });
            }}
            onSeen={(job) => apply(job.id, job)}
            onCancel={() => go(view.id ? { kind: "job", id: view.id } : { kind: "list" })}
          />
        )}
      </div>
    </div>
  );
}

const RUN_STATES: Record<RunState, { text: string; className: string }> = {
  running: { text: "Running", className: "run-running" },
  succeeded: { text: "Succeeded", className: "run-succeeded" },
  failed: { text: "Failed", className: "run-failed" },
  unknown: { text: "Unknown", className: "run-unknown" },
};

/** "1 min 20 s": how long a run took. */
function took(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 1) return "under a second";
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min${s % 60 ? ` ${s % 60} s` : ""}` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}

/** One run in the history: its state, when, how it ended, and its result. */
function RunRow({
  run,
  zone,
  result,
  onResult,
  onTroubleshoot,
}: {
  run: JobRun;
  zone: JobsZone;
  result?: RunResult | string | "loading";
  onResult?: () => void;
  /** Hands the job to Hermes with this run picked out; offered on a failed run. */
  onTroubleshoot?: () => void;
}) {
  const state = RUN_STATES[run.state];
  const open = result !== undefined;
  const resultId = `job-run-result-${run.id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  return (
    <li>
      <div className="job-history-head">
        <span className={`badge ${state.className}`}>{state.text}</span>
        <span>
          {run.script ? "Finished " : "Started "}
          <When at={run.startedAt} zone={zone} />
        </span>
        {!run.script && run.endedAt !== undefined && <span className="faint">took {took(run.endedAt - run.startedAt)}</span>}
      </div>
      {run.error && <div className="bad small job-history-error">{run.error}</div>}
      {run.note && <div className="muted small">{run.note}</div>}
      {run.script && run.preview && !run.error && <div className="muted small job-history-preview">{run.preview}</div>}
      {onTroubleshoot && run.state === "failed" && (
        <button type="button" className="btn small job-run-trouble" onClick={onTroubleshoot}>
          <Wrench size={13} /> Troubleshoot this run
        </button>
      )}
      {onResult && (
        <button type="button" className="job-result-toggle" aria-expanded={open} aria-controls={resultId} onClick={onResult}>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />} {open ? "Hide the result" : "Show the result"}
        </button>
      )}
      {open && (
        <div id={resultId} className="job-result" role="region" aria-label="Run result">
          {result === "loading" ? (
            <span className="muted small">
              <Spinner /> Reading the run's reply…
            </span>
          ) : typeof result === "string" ? (
            <span className="bad small">{result}</span>
          ) : result.reply ? (
            <pre className="job-prompt">{result.reply}</pre>
          ) : (
            <span className="muted small">This run's session has no reply from the agent.</span>
          )}
        </div>
      )}
    </li>
  );
}

function JobDetail({
  api,
  profile,
  connected,
  job,
  loaded,
  heading,
  onChanged,
  onEdit,
  onDeleted,
  onToast,
  troubleshoot,
  trouble,
  ask,
  reading,
}: {
  api: CronApi;
  profile: string;
  connected: boolean;
  job: CronJob;
  loaded: Loaded;
  heading: RefObject<HTMLHeadingElement | null>;
  onChanged: (id: string, job: CronJob | null) => void;
  onEdit: () => void;
  onDeleted: () => void;
  /** Says something on the list, once this job has left it. */
  onToast?: (text: string) => void;
  troubleshoot?: TroubleshootWiring;
  /** The newest troubleshooting chat for this job, in this app run. */
  trouble?: Troubleshoot;
  /** Start the Troubleshoot preview at once. */
  ask?: boolean;
  /** The screen's list reads: when the newest that worked started, whether one is under way, and why the last failed. */
  reading?: ListReading;
}) {
  const [busy, setBusy] = useState<"pause" | "resume" | "run" | "delete">();
  const [confirm, setConfirm] = useState<"run" | "delete">();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  /** The latest history read: its rows and the limit it asked for, or why it failed. */
  const [runs, setRuns] = useState<{ rows: JobRun[]; limit: number } | string>();
  const [runLimit, setRunLimit] = useState(RUNS_PAGE);
  const [readingRuns, setReadingRuns] = useState(false);
  /** Each run's result once asked for, by run id, so a late answer lands only on its own run. */
  const [results, setResults] = useState<Record<string, RunResult | string | "loading">>({});
  const [copies, setCopies] = useState<string[]>([]);
  const historyReads = useSequence();
  const copyReads = useSequence();
  const life = useSequence();
  const runButton = useRef<HTMLButtonElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  /** The Troubleshoot preview: being read, ready (the message, editable), or why it couldn't be read. */
  const [prep, setPrep] = useState<"reading" | (TroubleshootMessage & { input: TroubleshootInput }) | { failed: string }>();
  const [message, setMessage] = useState("");
  const [starting, setStarting] = useState(false);
  const prepReads = useSequence();
  const prepare = (run?: JobRun) => {
    const n = prepReads.next();
    setPrep("reading");
    setStarting(false);
    void gatherTroubleshoot(api, profile, job, { zone: loaded.zone, targets: loaded.targets }, run).then(
      (input) => {
        if (!prepReads.current(n)) return;
        const m = troubleshootMessage(input);
        setPrep({ ...m, input });
        setMessage(m.text);
      },
      (e) => prepReads.current(n) && setPrep({ failed: errorText(e) }),
    );
  };
  const closePrep = () => {
    prepReads.next();
    setPrep(undefined);
  };
  useEffect(() => {
    if (ask && troubleshoot && connected) prepare();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- predates the hook lint (#493)
  }, []);
  const startChat = async () => {
    if (!troubleshoot || typeof prep !== "object" || !("input" in prep)) return;
    setStarting(true);
    try {
      await troubleshoot.start(prep.input.job, message);
      if (life.live()) setPrep(undefined);
    } catch (e) {
      if (life.live()) setPrep({ failed: errorText(e) });
    } finally {
      if (life.live()) setStarting(false);
    }
  };

  useEffect(() => {
    if (!connected) return;
    const n = copyReads.next();
    void api.copiesOf(profile, job.id).then((c) => copyReads.current(n) && setCopies(c));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- predates the hook lint (#493)
  }, [connected, job.id]);
  const copyNote =
    copies.length > 0 &&
    `The ${copies.join(" and ")} ${copies.length === 1 ? "profile has a copy" : "profiles have copies"} of this job, with the same id. If this one is deleted in another Hermes client while you change it here, Hermes changes ${copies.length === 1 ? "that copy" : "one of those copies"} instead; Hermes Chat says so if it notices.`;
  const zone = loaded.zone;
  const offline = connected ? undefined : "Connect to Hermes to change this job.";
  const paused = !job.enabled || job.state === "paused";
  const problems = loaded.targets ? deliveryProblems(job.deliver, loaded.targets, job.originPlatform) : [];

  const readRuns = (limit = runLimit) => {
    const n = historyReads.next();
    setReadingRuns(true);
    void api.runs(profile, job, limit).then(
      (rows) => historyReads.current(n) && setRuns({ rows, limit }),
      (e) => historyReads.current(n) && setRuns(errorText(e)),
    ).finally(() => historyReads.current(n) && setReadingRuns(false));
  };
  useEffect(() => {
    if (connected) readRuns();
    else historyReads.next();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- predates the hook lint (#493)
  }, [connected, job.lastRunAt, runLimit, trouble?.endedAt]);

  /** Each run's latest result read: a newer read, a Hide, or the run changing supersedes an older one. */
  const resultReads = useRef<Record<string, number>>({});
  const readResult = (run: JobRun) => {
    const n = (resultReads.current[run.id] = (resultReads.current[run.id] ?? 0) + 1);
    const mine = () => life.live() && resultReads.current[run.id] === n;
    setResults((r) => ({ ...r, [run.id]: "loading" }));
    void api.runResult(profile, run).then(
      (res) => mine() && setResults((r) => ({ ...r, [run.id]: res })),
      (e) => mine() && setResults((r) => ({ ...r, [run.id]: errorText(e) })),
    );
  };
  const showResult = (run: JobRun) => {
    if (results[run.id] === undefined) return readResult(run);
    resultReads.current[run.id] = (resultReads.current[run.id] ?? 0) + 1;
    setResults((r) => {
      const rest = { ...r };
      delete rest[run.id];
      return rest;
    });
  };
  // A run whose state or end changed since its result was read (it was running) is read again.
  const seen = useRef<Record<string, string>>({});
  useEffect(() => {
    if (typeof runs !== "object") return;
    for (const r of runs.rows) {
      const now = `${r.state}:${r.endedAt ?? ""}`;
      const was = seen.current[r.id];
      seen.current[r.id] = now;
      if (was !== undefined && was !== now && results[r.id] !== undefined && connected) readResult(r);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- predates the hook lint (#493)
  }, [runs]);

  const act = async (what: NonNullable<typeof busy>, fn: () => Promise<void>) => {
    setBusy(what);
    setError(undefined);
    setNotice(undefined);
    setConfirm(undefined);
    try {
      await fn();
    } catch (e) {
      // What Hermes's list now says goes to the list even if the owner has left this job meanwhile.
      if (e instanceof CronError && e.kind === "gone") onChanged(job.id, null);
      if (life.live()) setError(errorText(e));
    } finally {
      if (life.live()) setBusy(undefined);
    }
  };

  /** Closes a confirmation without acting, giving focus back to the button that opened it. */
  const dismiss = () => {
    const back = confirm === "run" ? runButton : deleteButton;
    setConfirm(undefined);
    requestAnimationFrame(() => back.current?.focus());
  };

  const runNow = () =>
    act("run", async () => {
      const outcome = await api.runNow(profile, job);
      const status = outcome.job?.lastStatus ? statusLabel(outcome.job.lastStatus).text : undefined;
      const said = !outcome.completed
        ? "Hermes took the run, but hasn't recorded its result yet. Refresh later to see it."
        : !outcome.job
          ? "The run finished, and the job is no longer in the list: Hermes removes a one-shot once it has run, or it was deleted elsewhere."
          : `The run finished: ${status ?? "Hermes recorded no result"}.${outcome.job.lastError ? ` ${outcome.job.lastError}` : ""}`;
      // The list takes what Hermes read back whether or not the owner is still on this job; only this view's notice,
      // and moving to the list, wait on the owner still being here.
      if (!outcome.job) {
        onChanged(job.id, null);
        if (life.live()) onToast?.(said);
        return;
      }
      if (!outcome.unverified) onChanged(job.id, outcome.job);
      if (!life.live()) return;
      setNotice(outcome.unverified ? `${said} The list couldn't be read afterwards to confirm it; refresh to check.` : said);
      readRuns();
    });

  const deliver = deliveryLabel(job.deliver, loaded.targets);
  const history = typeof runs === "object" ? runs : undefined;
  const rows = history?.rows;
  const running = underWay(job) || !!rows?.some((r) => r.state === "running");
  const kept = [
    job.noAgent && ["Runs", `the script ${job.script ?? ""} with no agent, and delivers what it prints`],
    !job.noAgent && job.script && ["Script", `${job.script}, run before the prompt`],
    job.skills.length > 0 && ["Skills", job.skills.join(", ")],
    job.model && ["Model", [job.provider, job.model].filter(Boolean).join(" / ")],
    job.workdir && ["Folder", job.workdir],
    job.toolsets.length > 0 && ["Toolsets", job.toolsets.join(", ")],
    job.contextFrom.length > 0 && ["Uses output of", job.contextFrom.join(", ")],
  ].filter((k): k is [string, string] => !!k);

  return (
    <>
      <h1 className="project-title" ref={heading} tabIndex={-1}>
        <CalendarClock size={20} /> <span>{job.name}</span> {stateBadge(job)}
      </h1>
      <div className="jobs-actions">
        <button className="btn" disabled={!connected || !!busy} title={offline} onClick={onEdit}>
          <Pencil size={14} /> Edit
        </button>
        <button
          className="btn"
          disabled={!connected || !!busy || job.state === "completed"}
          title={offline}
          onClick={() =>
            void act(paused ? "resume" : "pause", async () => {
              onChanged(job.id, await api.setPaused(profile, job, !paused));
            })
          }
        >
          {paused ? <Play size={14} /> : <Pause size={14} />} {busy === "pause" ? "Pausing…" : busy === "resume" ? "Resuming…" : paused ? "Resume" : "Pause"}
        </button>
        <button ref={runButton} className="btn" disabled={!connected || !!busy} title={offline} onClick={() => setConfirm("run")}>
          <Zap size={14} /> {busy === "run" ? "Running on the server…" : "Run now"}
        </button>
        <button ref={deleteButton} className="btn danger" disabled={!connected || !!busy} title={offline} onClick={() => setConfirm("delete")}>
          <Trash2 size={14} /> {busy === "delete" ? "Deleting…" : "Delete"}
        </button>
        {troubleshoot && (
          <button className="btn" disabled={!connected || !!busy || prep === "reading" || starting} title={offline} onClick={() => prepare()}>
            <Wrench size={14} /> Troubleshoot
          </button>
        )}
      </div>
      {prep !== undefined && (
        <TroublePreview
          profile={profile}
          job={job}
          prep={prep}
          message={message}
          starting={starting}
          connected={connected}
          onMessage={setMessage}
          onStart={() => void startChat()}
          onCancel={closePrep}
        />
      )}
      {trouble && !prep && troubleshoot && (
        <TroublePanel
          trouble={trouble}
          job={job}
          zone={zone.zone}
          reading={reading}
          connected={connected}
          busy={!!busy}
          onOpenChat={troubleshoot.openChat}
          onRunNow={() => setConfirm("run")}
          onDismiss={() => troubleshoot.store.dismiss(trouble.id)}
        />
      )}
      {copyNote && (
        <p className="job-banner" role="note">
          <CircleAlert size={14} /> {copyNote}
        </p>
      )}
      {confirm === "run" && (
        <div className="confirm" role="alertdialog" aria-label="Run this job now?" onKeyDown={(e) => e.key === "Escape" && dismiss()}>
          <span>
            Run “{job.name}” now? On the server, Hermes {job.noAgent ? "runs its script" : "sends its prompt to the agent, which can use its tools,"} and
            delivers the result: {deliver.toLowerCase()}. This is a real run, and can take as long as the job does.
            {paused && " Hermes also resumes the job, so it runs on its schedule again afterwards."}
            {running && " A run of this job is under way on the server: Hermes runs one at a time and refuses another until it ends."}
            {problems.length > 0 && ` ${problems.join(" ")}`}
          </span>
          <div className="confirm-actions">
            <button className="btn" autoFocus onClick={dismiss}>
              Cancel
            </button>
            <button className="btn primary" onClick={() => void runNow()}>
              Run now
            </button>
          </div>
        </div>
      )}
      {confirm === "delete" && (
        <div className="confirm" role="alertdialog" aria-label="Delete this job?" onKeyDown={(e) => e.key === "Escape" && dismiss()}>
          <span>Delete “{job.name}”? Hermes removes it for good, in every Hermes client, and it won't run again. This can't be undone.</span>
          <div className="confirm-actions">
            <button className="btn" autoFocus onClick={dismiss}>
              Cancel
            </button>
            <button
              className="btn danger"
              onClick={() =>
                void act("delete", async () => {
                  await api.remove(profile, job);
                  onChanged(job.id, null);
                  if (life.live()) onDeleted();
                })
              }
            >
              Delete job
            </button>
          </div>
        </div>
      )}
      {busy === "run" && (
        <p className="job-banner" role="status">
          <Spinner /> Hermes is running the job on the server. It answers when the run has finished.
        </p>
      )}
      {error && (
        <p className="sign-in-error small" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="job-notice" role="status">
          {notice}
        </p>
      )}

      <section>
        <h2>Schedule</h2>
        <p>
          {job.schedule ? explainSchedule(job.schedule, zone.zone) : "Hermes Chat can't read this schedule."} <span className="mono faint">{job.scheduleText}</span>
        </p>
        <p className="muted small">
          {zone.named ? `Schedule time zone: ${zone.label}. ` : `Schedule time zone: not named by Hermes. Times are shown in ${zone.label}. `}
          {zone.named && zone.zone !== HERE && `Shown beside it where it differs: this computer's, ${HERE}.`}
        </p>
        <p>
          <NextRun job={job} zone={zone} />
        </p>
        {runState(job).runs && (
          <>
            <h3 className="job-sub">Upcoming runs</h3>
            <Upcoming schedule={job.schedule} zone={zone} first={Date.parse(job.nextRunAt!)} remaining={job.repeat.times === null ? null : job.repeat.times - job.repeat.completed} />
          </>
        )}
        {job.schedule && (
          <p className="muted small">
            {missedRunNote(job.schedule, (() => {
              const two = job.schedule.kind === "once" ? undefined : upcomingRuns(job.schedule, zone.zone, Date.now(), 2);
              return two && two.length === 2 ? two[1] - two[0] : undefined;
            })(), loaded.catchUp)}
          </p>
        )}
        {job.repeat.times !== null && (
          <p className="muted small">
            Runs {job.repeat.times} {job.repeat.times === 1 ? "time" : "times"} in all; {job.repeat.completed} done.
          </p>
        )}
      </section>

      <section>
        <h2>{job.noAgent ? "Script" : "Prompt"}</h2>
        {job.prompt ? <pre className="job-prompt">{job.prompt}</pre> : <p className="muted">{job.noAgent ? `Runs ${job.script}.` : "No prompt."}</p>}
        <p className="muted small">Delivers to: {deliver}.</p>
        {problems.map((p) => (
          <p key={p} className="job-banner" role="note">
            <CircleAlert size={14} /> {p}
          </p>
        ))}
        {!loaded.targets && job.deliver !== "local" && <p className="muted small">Hermes Chat couldn't read where this profile can deliver, so it can't check this job's delivery.</p>}
        {kept.length > 0 && (
          <dl className="job-kept">
            {kept.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
            <p className="muted small">Set in another Hermes client. Editing here keeps these as they are.</p>
          </dl>
        )}
      </section>

      <section aria-labelledby="job-runs-heading">
        <div className="job-section-head">
          <h2 id="job-runs-heading">
            <History size={14} /> Runs
          </h2>
          {connected && (
            <button className="btn small" disabled={readingRuns} onClick={() => readRuns()}>
              <RefreshCw size={13} /> {readingRuns ? "Reading…" : "Refresh runs"}
            </button>
          )}
        </div>
        <p>
          <LastRun job={job} zone={zone} />
        </p>
        {job.lastError && <p className="bad small">{job.lastError}</p>}
        {job.lastDeliveryError && <p className="bad small">Delivery: {job.lastDeliveryError}</p>}
        {running && <p className="muted small">A run is under way on the server.</p>}
        {runs === undefined ? (
          connected && (
            <div className="empty-hint" role="status">
              <Spinner /> Reading the run history…
            </div>
          )
        ) : typeof runs === "string" ? (
          <p className="muted small" role="alert">
            {runs}
          </p>
        ) : runs.rows.length ? (
          <ul className="job-history" aria-label="Run history, newest first">
            {runs.rows.map((r) => (
              <RunRow
                key={r.id}
                run={r}
                zone={zone}
                result={results[r.id]}
                onResult={r.sessionId && connected ? () => showResult(r) : undefined}
                onTroubleshoot={troubleshoot && connected && !busy && !starting ? () => prepare(r) : undefined}
              />
            ))}
          </ul>
        ) : (
          <p className="muted small">Hermes has no runs of this job on record.</p>
        )}
        {history && history.rows.length >= history.limit && (
          history.limit < RUNS_MAX ? (
            <button className="btn" disabled={readingRuns || !connected} onClick={() => setRunLimit(Math.min(RUNS_MAX, history.limit + RUNS_PAGE))}>
              {readingRuns && runLimit > history.limit ? "Reading…" : "Show more runs"}
            </button>
          ) : (
            <p className="muted small">Hermes lists a job's latest {RUNS_MAX} runs; older ones aren't shown.</p>
          )
        )}
        {rows && rows.length > 0 && <p className="faint small">Showing the latest {rows.length} {rows.length === 1 ? "run" : "runs"}.</p>}
      </section>
    </>
  );
}

/** The screen's list reads, as the Troubleshooting panel needs them. */
type ListReading = { at?: number; loading: boolean; error?: string; reload: () => void };

/** Whether the list was read after the troubleshooting reply ended, so the job shown has Hermes's changes. */
const readSince = (t: Troubleshoot, at?: number) => t.endedAt !== undefined && at !== undefined && at >= t.endedAt;

/** A troubleshooting chat's state in a line, for the job's row in the list. */
function troubleLine(t: Troubleshoot, job: CronJob, zone: JobsZone, readAt?: number): string {
  if (t.phase === "failed") return "Troubleshooting didn't start.";
  if (t.phase !== "ended") return "Hermes is troubleshooting this job in a chat.";
  if (!readSince(t, readAt)) return "Troubleshooting chat ended: reading the job again…";
  const n = jobChanges(t.before, job, zone.zone).length;
  return n ? `Troubleshooting chat ended: ${n} ${n === 1 ? "change" : "changes"} to this job. Open it to see what changed.` : "Troubleshooting chat ended: nothing on this job changed.";
}

/** The message a Troubleshoot chat starts with, shown and editable before anything is sent. */
function TroublePreview({
  profile,
  job,
  prep,
  message,
  starting,
  connected,
  onMessage,
  onStart,
  onCancel,
}: {
  profile: string;
  job: CronJob;
  prep: "reading" | (TroubleshootMessage & { input: TroubleshootInput }) | { failed: string };
  message: string;
  starting: boolean;
  connected: boolean;
  onMessage: (text: string) => void;
  onStart: () => void;
  onCancel: () => void;
}) {
  // Opened from a run far down the page, the preview would be out of sight: bring it into view, and put focus in it.
  const box = useRef<HTMLElement>(null);
  useEffect(() => {
    box.current?.scrollIntoView?.({ block: "nearest" });
    box.current?.focus({ preventScroll: true });
  }, []);
  return (
    <section
      ref={box}
      tabIndex={-1}
      className="job-trouble"
      aria-label="Troubleshoot in a new chat"
      onKeyDown={(e) => e.key === "Escape" && !starting && onCancel()}
    >
      <h2>
        <Wrench size={14} /> Troubleshoot in a new chat
      </h2>
      {prep === "reading" ? (
        <p className="muted small" role="status">
          <Spinner /> Reading “{job.name}” and its latest runs…
        </p>
      ) : "failed" in prep ? (
        <>
          <p className="sign-in-error small" role="alert">
            {prep.failed}
          </p>
          <div className="confirm-actions">
            <button className="btn" onClick={onCancel}>
              Close
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="small">
            Hermes Chat starts a new chat in the <span className="mono">{profile}</span> profile, the job's, with the message below. Hermes looks for the
            cause and can change this job with its own cron tools; it is asked to say what it changes, and this screen reads the job again when its reply
            ends, to show what changed. The message goes to the model as written: check it, and edit out anything you don't want sent.
          </p>
          {(prep.cut.length > 0 || prep.hidden.length > 0) && (
            <ul className="muted small job-trouble-notes">
              {prep.cut.length > 0 && <li>Cut short to fit: {prep.cut.join(", ")}. Hermes can read the whole of it on the server.</li>}
              {prep.hidden.length > 0 && (
                <li>
                  Hidden, as it looked like a secret: {prep.hidden.join(", ")}. Hermes Chat recognises common key and token shapes only, so read the
                  message before sending.
                </li>
              )}
            </ul>
          )}
          <textarea className="job-trouble-message" aria-label="First message" value={message} spellCheck={false} onChange={(e) => onMessage(e.target.value)} />
          <div className="confirm-actions">
            <button className="btn" disabled={starting} onClick={onCancel}>
              Cancel
            </button>
            <button className="btn primary" disabled={starting || !connected || !message.trim()} onClick={onStart}>
              <MessageSquare size={14} /> {starting ? "Starting the chat…" : "Start the chat"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/** What a troubleshooting chat came to: where it is, and what changed on the job since it started. */
function TroublePanel({
  trouble,
  job,
  zone,
  reading,
  connected,
  busy,
  onOpenChat,
  onRunNow,
  onDismiss,
}: {
  trouble: Troubleshoot;
  job: CronJob;
  zone: string;
  reading?: ListReading;
  connected: boolean;
  busy: boolean;
  onOpenChat: (chatId: string) => void;
  onRunNow: () => void;
  onDismiss: () => void;
}) {
  const ended = trouble.phase === "ended";
  // What changed is said only from a list read that started after the reply ended (or, while Hermes works, after the
  // chat started, as changes so far): never from a read that could predate Hermes's change.
  const confirmed = ended && readSince(trouble, reading?.at);
  const sofar = trouble.phase === "working" && reading?.at !== undefined && reading.at >= trouble.startedAt;
  const changes = confirmed || sofar ? jobChanges(trouble.before, job, zone) : [];
  return (
    <section className="job-trouble" aria-label="Troubleshooting">
      <h2>
        <Wrench size={14} /> Troubleshooting
      </h2>
      {trouble.phase === "failed" ? (
        <p className="sign-in-error small" role="alert">
          {trouble.reason}
        </p>
      ) : confirmed ? (
        <p className="small" role="status">
          Hermes's reply in the troubleshooting chat has ended, and this job was read again.{" "}
          {changes.length ? "What changed on the job since the chat started:" : "Nothing on the job has changed since the chat started."}
        </p>
      ) : ended ? (
        reading?.loading || (!reading?.error && connected) ? (
          <p className="small" role="status">
            <Spinner /> Hermes's reply in the troubleshooting chat has ended. Reading the job again…
          </p>
        ) : (
          <p className="sign-in-error small" role="alert">
            Hermes's reply in the troubleshooting chat has ended, but the job couldn't be read again
            {reading?.error ? `: ${reading.error}` : ", since Hermes Chat isn't connected"}. What changed shows once it has been read.
          </p>
        )
      ) : (
        <>
          <p className="small" role="status">
            <Spinner /> {trouble.phase === "starting" ? "Starting the chat…" : "Hermes is working on this job in a chat. This screen reads the job again when its reply ends."}
          </p>
          {trouble.unconfirmed && (
            <p className="muted small">
              Hermes didn't confirm the first message ({trouble.unconfirmed}), so it may or may not have it. Open the chat to see.
            </p>
          )}
          {changes.length > 0 && <p className="small">Changes so far, as the job was last read:</p>}
        </>
      )}
      {changes.length > 0 && (
        <ul className="job-changes" aria-label="What changed">
          {changes.map((c) =>
            c.long ? (
              <li key={c.field}>
                <span className="job-change-field">{c.field}</span> changed:
                <div className="job-change-pair">
                  <span className="faint small">Before</span>
                  <pre className="job-prompt">{c.before ?? "(none)"}</pre>
                  <span className="faint small">Now</span>
                  <pre className="job-prompt">{c.after ?? "(none)"}</pre>
                </div>
              </li>
            ) : (
              <li key={c.field}>
                <span className="job-change-field">{c.field}</span>: <span className="mono">{c.before ?? "(none)"}</span> → <span className="mono">{c.after ?? "(none)"}</span>
              </li>
            ),
          )}
        </ul>
      )}
      <div className="jobs-actions">
        {confirmed && (
          <button className="btn primary" disabled={!connected || busy} onClick={onRunNow}>
            <Zap size={14} /> Run now to check the fix
          </button>
        )}
        {ended && !confirmed && !reading?.loading && reading && (
          <button className="btn" disabled={!connected} onClick={reading.reload}>
            <RefreshCw size={14} /> Try again
          </button>
        )}
        {trouble.phase === "working" && reading && (
          <button className="btn" disabled={!connected || reading.loading} title="Read the job as it is now, to see the changes so far" onClick={reading.reload}>
            <RefreshCw size={14} /> Read the job again
          </button>
        )}
        {trouble.chatId && (
          <button className="btn" onClick={() => onOpenChat(trouble.chatId!)}>
            <MessageSquare size={14} /> Open the chat
          </button>
        )}
        {(ended || trouble.phase === "failed") && (
          <button className="btn" onClick={onDismiss}>
            Dismiss
          </button>
        )}
      </div>
      {confirmed && <p className="faint small">Run now is a real run, with the job's real delivery: it asks first. The chat stays in your chat list.</p>}
      {job.state === "completed" && confirmed && <p className="faint small">The job has no more runs on its schedule.</p>}
    </section>
  );
}

/** The schedule text to edit a job's schedule from: Hermes's label when it reads back as the same schedule. */
function scheduleInput(job: CronJob, zone: JobsZone): string {
  const s = job.schedule;
  if (!s) return job.scheduleText;
  if (s.kind === "once") return isoIn(zone.zone, s.runAt, false);
  try {
    const again = parseSchedule(job.scheduleText, zone.zone, Date.now());
    if (s.kind === "cron" && again.kind === "cron" && again.expr === s.expr) return job.scheduleText;
    if (s.kind === "interval" && again.kind === "interval" && again.minutes === s.minutes) return job.scheduleText;
  } catch {
    // Hermes's label isn't a schedule it reads (`once at …`): use the schedule itself.
  }
  return s.kind === "cron" ? s.expr : `every ${s.minutes}m`;
}

const EXAMPLES = ["every day at 9am", "weekdays at 8:30am", "every monday 9am", "every 2h", "0 9 * * 1-5", "in 30m"];

function JobEditor({
  api,
  profile,
  connected,
  job,
  loaded,
  heading,
  onSaved,
  onSeen,
  onCancel,
}: {
  api: CronApi;
  profile: string;
  connected: boolean;
  /** The job edited; undefined for a new one. */
  job?: CronJob;
  loaded: Loaded;
  heading: RefObject<HTMLHeadingElement | null>;
  /** The job as Hermes has it after the save, and the profile it is in. */
  onSaved: (job: CronJob, profile: string) => void;
  /** The job as Hermes has it now, read while saving, for the list. */
  onSeen: (job: CronJob) => void;
  onCancel: () => void;
}) {
  // A new job can go in any of the server's profiles; an edited one stays in its own, since Hermes has no move.
  const [where, setWhere] = useState(profile);
  const [profiles, setProfiles] = useState<string[]>([profile]);
  /** The chosen profile's jobs and settings: this screen's for its own profile, read for another, or why not. */
  const [context, setContext] = useState<Loaded | string | undefined>(loaded);
  const contextReads = useSequence();
  const profileReads = useSequence();
  useEffect(() => {
    if (job || !connected) return;
    const n = profileReads.next();
    void api.profiles().then(
      (names) => profileReads.current(n) && setProfiles(names.includes(profile) ? names : [profile, ...names]),
      () => {},
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps -- predates the hook lint (#493)
  }, [connected]);
  const ctx = typeof context === "object" ? context : undefined;
  const zone = (ctx ?? loaded).zone;

  // The job as the edits started from: after a conflict, the job as Hermes has it now.
  const [base, setBase] = useState(job);
  const initial = (j?: CronJob): JobFields => ({
    name: j?.name ?? "",
    prompt: j?.prompt ?? "",
    schedule: j ? scheduleInput(j, zone) : "",
    deliver: j?.deliver ?? "local",
    repeat: j?.repeat.times ?? null,
  });
  const [form, setForm] = useState<JobFields>(() => initial(job));
  // A one-shot's limit of 1 is Hermes's own, not the owner's: a one-shot made recurring starts with none.
  const repeatOf = (j?: CronJob) => (j?.repeat.times && j.schedule?.kind !== "once" ? String(j.repeat.times) : "");
  const [repeatText, setRepeatText] = useState(repeatOf(job));
  const [paused, setPaused] = useState(false);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [conflict, setConflict] = useState<CronConflict>();
  const set = (patch: Partial<JobFields>) => setForm((f) => ({ ...f, ...patch }));

  /** Puts the new job in another profile: reads that profile's zone and delivery targets, dropping any older read. */
  const choose = (p: string) => {
    setWhere(p);
    const n = contextReads.next();
    const take = (got: Loaded) => {
      setContext(got);
      // A delivery the chosen profile doesn't offer would go nowhere there.
      setForm((f) => (f.deliver === "local" || got.targets?.some((t) => t.id === f.deliver) ? f : { ...f, deliver: "local" }));
    };
    if (p === profile) return take(loaded);
    setContext(undefined);
    void readProfile(api, p).then(
      (got) => contextReads.current(n) && take(got),
      (e) => contextReads.current(n) && setContext(`Hermes Chat couldn't read the ${p} profile's jobs: ${errorText(e)}`),
    );
  };

  const scheduleChanged = !base || form.schedule.trim() !== initial(base).schedule.trim();
  const parsed = useMemo((): Schedule | ScheduleError | undefined => {
    if (!form.schedule.trim() && !touched) return undefined;
    try {
      return parseSchedule(form.schedule, zone.zone, Date.now());
    } catch (e) {
      return e instanceof ScheduleError ? e : new ScheduleError(errorText(e));
    }
  }, [form.schedule, zone.zone, touched]);
  // A schedule left as it was keeps its kind even when it no longer reads (a one-shot that is due by now).
  const once = scheduleChanged ? !!parsed && !(parsed instanceof ScheduleError) && parsed.kind === "once" : base?.schedule?.kind === "once";
  const repeatProblem = !once && repeatText.trim() && !/^[1-9]\d{0,5}$/.test(repeatText.trim()) ? "Enter how many runs, a whole number from 1." : undefined;
  const promptProblem = !form.prompt.trim() && !(base && (base.noAgent || base.script || base.skills.length)) ? "Write what Hermes should do each time." : undefined;
  // A schedule left as it was isn't checked again: Hermes already has it, and a one-shot may be due by now.
  const scheduleProblem = scheduleChanged ? (parsed instanceof ScheduleError ? parsed.message : parsed ? undefined : "Enter a schedule.") : undefined;
  const problems = [promptProblem, scheduleProblem, repeatProblem].filter(Boolean);

  const known = ctx?.targets;
  const targets = known?.length ? known : [{ id: "local", name: "Local (save only)", ready: true }];
  const options = targets.some((t) => t.id === form.deliver) ? targets : [...targets, { id: form.deliver, name: deliveryLabel(form.deliver, []), ready: true }];
  const deliveryProblem = known ? deliveryProblems(form.deliver, known, base?.originPlatform)[0] : undefined;

  const save = async () => {
    setTouched(true);
    if (problems.length || saving || !ctx) return;
    setSaving(true);
    setError(undefined);
    const fields: JobFields = { ...form, repeat: once ? null : repeatText.trim() ? Number(repeatText) : null };
    const into = where;
    // A save that lands after the owner left the editor still goes to this profile's list; only moving on waits.
    const done = (job: CronJob, where: string) => (contextReads.live() ? onSaved(job, where) : where === profile && onSeen(job));
    try {
      if (!base) done(await api.create(into, fields, paused), into);
      else {
        const edits: Partial<JobFields> = { name: fields.name, prompt: fields.prompt, deliver: fields.deliver, ...(scheduleChanged && { schedule: fields.schedule }), ...(!once && { repeat: fields.repeat }) };
        done(await api.update(profile, base, edits), profile);
      }
    } catch (e) {
      if (e instanceof CronConflict) onSeen(e.job);
      if (!contextReads.live()) return;
      if (e instanceof CronConflict) {
        setConflict(e);
        setBase(e.job);
      } else setError(errorText(e));
    } finally {
      if (contextReads.live()) setSaving(false);
    }
  };

  const preview = parsed && !(parsed instanceof ScheduleError) ? parsed : !scheduleChanged ? base?.schedule : undefined;
  const limit = once ? 1 : /^[1-9]\d*$/.test(repeatText.trim()) ? Number(repeatText) : null;
  const startsPaused = base ? !base.enabled || base.state === "paused" : paused;

  return (
    <>
      <h1 className="project-title" ref={heading} tabIndex={-1}>
        <CalendarClock size={20} /> <span>{job ? `Edit ${job.name}` : "New scheduled job"}</span>
      </h1>
      <p className="muted">Hermes keeps the job on the server and runs it there, so it runs while Hermes Chat is closed.</p>
      <form
        className="job-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {base ? (
          <p className="field">
            <span className="field-label">Profile</span>
            <span>
              <span className="mono">{profile}</span>
              <span className="field-hint"> Hermes can't move a job to another profile; to run it in another, create it there.</span>
            </span>
          </p>
        ) : (
          <label className="field">
            <span className="field-label" id="job-profile-label">
              Profile
            </span>
            <select value={where} disabled={saving} aria-labelledby="job-profile-label" aria-describedby="job-profile-help" onChange={(e) => choose(e.target.value)}>
              {profiles.map((p) => (
                <option key={p} value={p}>
                  {p}
                  {p === profile ? " (this one)" : ""}
                </option>
              ))}
            </select>
            <span className="field-hint" id="job-profile-help">
              Each profile has its own jobs, time zone and delivery places.
              {context === undefined && " Reading that profile's settings…"}
            </span>
            {typeof context === "string" && (
              <span className="field-hint err" role="alert">
                {context}
              </span>
            )}
          </label>
        )}
        <label className="field">
          <span className="field-label">Name</span>
          <input value={form.name} placeholder="Named after the prompt if left empty" maxLength={200} onChange={(e) => set({ name: e.target.value })} />
        </label>
        <label className="field">
          <span className="field-label">{base?.noAgent ? "Prompt (not used: this job runs a script)" : "Prompt"}</span>
          <textarea rows={5} value={form.prompt} aria-invalid={touched && !!promptProblem} placeholder="What Hermes should do each time, as you'd ask in a chat" onChange={(e) => set({ prompt: e.target.value })} />
          {touched && promptProblem && <span className="field-hint err">{promptProblem}</span>}
        </label>
        <label className="field">
          <span className="field-label">Schedule</span>
          <input
            value={form.schedule}
            spellCheck={false}
            aria-invalid={touched && !!scheduleProblem}
            aria-describedby="job-schedule-help"
            placeholder="every day at 9am"
            onChange={(e) => set({ schedule: e.target.value })}
            onBlur={() => form.schedule.trim() && setTouched(true)}
          />
          <span className="field-hint" id="job-schedule-help">
            {!ctx ? `Reading the ${where} profile's time zone…` : zone.named ? `Times are in ${zone.label}, the ${where} profile's schedule time zone.` : `Times are shown in ${zone.label}.`}{" "}
            {EXAMPLES.map((x) => (
              <button key={x} type="button" className="job-example" onClick={() => set({ schedule: x })}>
                {x}
              </button>
            ))}
          </span>
          {scheduleProblem && (touched || parsed instanceof ScheduleError) && <span className="field-hint err" role="alert">{scheduleProblem}</span>}
          {ctx?.zone.note && (
            <span className="field-hint job-dst" role="note">
              {ctx.zone.note}
            </span>
          )}
        </label>
        {preview && ctx && (
          <div className="job-preview" aria-live="polite">
            <div>
              <strong>{explainSchedule(preview, zone.zone)}</strong>
            </div>
            <Upcoming
              schedule={preview}
              zone={zone}
              first={!scheduleChanged && base?.nextRunAt ? Date.parse(base.nextRunAt) : undefined}
              remaining={once || !/^[1-9]\d*$/.test(repeatText.trim()) ? null : Number(repeatText) - (base?.repeat.completed ?? 0)}
            />
            {scheduleChanged && <p className="muted small">Hermes works out the runs again when it saves the job.</p>}
          </div>
        )}
        <label className="field">
          <span className="field-label" id="job-deliver-label">
            Deliver to
          </span>
          <select value={form.deliver} aria-labelledby="job-deliver-label" aria-describedby="job-deliver-help" onChange={(e) => set({ deliver: e.target.value })}>
            {options.map((t) => (
              <option key={t.id} value={t.id} disabled={!t.ready && t.id !== form.deliver}>
                {deliveryLabel(t.id, targets)}
                {!t.ready ? " (no home channel set on the server)" : ""}
              </option>
            ))}
          </select>
          <span className="field-hint" id="job-deliver-help">
            {ctx && !known
              ? "Hermes Chat couldn't read where this profile can deliver, so only saving on the server is offered."
              : "Only the places this profile's gateway has set up. Nothing is sent to try it: the first delivery is the job's first real run."}
          </span>
          {deliveryProblem && <span className="field-hint err">{deliveryProblem}</span>}
        </label>
        {!once && (
          <label className="field">
            <span className="field-label">Stop after this many runs</span>
            <input value={repeatText} inputMode="numeric" placeholder="Leave empty to keep running" aria-invalid={!!repeatProblem} onChange={(e) => setRepeatText(e.target.value)} />
            {repeatProblem && <span className="field-hint err">{repeatProblem}</span>}
          </label>
        )}
        {!base && (
          <label className="job-check">
            <input type="checkbox" checked={paused} onChange={(e) => setPaused(e.target.checked)} /> Create it paused, so it doesn't run until you resume it
          </label>
        )}
        {preview && ctx && !problems.length && (
          <section className="job-summary" aria-label="Summary">
            <h3 className="job-sub">Summary</h3>
            <dl className="job-kept">
              <div>
                <dt>Job</dt>
                <dd>{form.name.trim() || "Named by Hermes after its prompt"}</dd>
              </div>
              <div>
                <dt>Profile</dt>
                <dd>{where}</dd>
              </div>
              <div>
                <dt>Runs</dt>
                <dd>
                  {explainSchedule(preview, zone.zone)}, {zone.named ? `on the schedule time zone, ${zone.label}` : `shown in ${zone.label}; Hermes Chat can't confirm the ${where} profile's own time zone`}
                </dd>
              </div>
              <div>
                <dt>Stops</dt>
                <dd>{limit === 1 ? "After its one run" : limit ? `After ${limit} runs${base?.repeat.completed ? ` (${base.repeat.completed} done)` : ""}` : "Never: it runs until paused or deleted"}</dd>
              </div>
              <div>
                <dt>Delivers to</dt>
                <dd>{deliveryLabel(form.deliver, targets)}</dd>
              </div>
              <div>
                <dt>Starts</dt>
                <dd>{startsPaused ? "Paused: it won't run until resumed" : "At the first upcoming run above"}</dd>
              </div>
            </dl>
          </section>
        )}
        {conflict && (
          <div className="job-error" role="alert">
            <p>{conflict.message}</p>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setForm(initial(conflict.job));
                setRepeatText(repeatOf(conflict.job));
                setConflict(undefined);
              }}
            >
              Reload
            </button>
          </div>
        )}
        {error && (
          <p className="sign-in-error small" role="alert">
            {error}
          </p>
        )}
        <div className="confirm-actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!connected || saving || !ctx} title={connected ? undefined : "Connect to Hermes to save."}>
            {saving ? "Saving…" : base ? (conflict ? "Save over their changes" : "Save") : "Create job"}
          </button>
        </div>
      </form>
    </>
  );
}
