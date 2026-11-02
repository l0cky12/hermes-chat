// Scheduled jobs (GLOSSARY.md "Scheduled job", ADR 0011): the profile's cron jobs, which Hermes keeps and runs on the
// server, also while Hermes Chat is closed. The screen lists them with their schedule, time zone and next run, and
// creates, edits, pauses, resumes, runs and deletes them through Hermes. Every change shows only once Hermes, read
// back, has it.
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, CalendarClock, CircleAlert, History, Pause, Pencil, Play, Plus, RefreshCw, Trash2, Zap } from "lucide-react";
import { CronConflict, CronError, type CronApi, type CronJob, type DeliveryTarget, type JobFields, type JobRun, type JobsZone, jobsZone, statusLabel } from "../hermes/cronJobs";
import { type Schedule, ScheduleError, clockChangeNote, explainSchedule, formatInstant, isoIn, offsetAt, parseSchedule, upcomingRuns } from "../hermes/schedule";
import { Spinner } from "./bits";

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const HERE = Intl.DateTimeFormat().resolvedOptions().timeZone;
/** A scheduler that hasn't checked the jobs for this long is likely not running (it checks about every minute). */
const STALE_SCHEDULER_S = 300;

type Loaded = { jobs: CronJob[]; zone: JobsZone; targets: DeliveryTarget[] };
type View = { kind: "list" } | { kind: "job"; id: string } | { kind: "edit"; id?: string };

/** An instant on the jobs' clock, and on this computer's when that reads differently. */
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

function deliveryLabel(id: string, targets: DeliveryTarget[]): string {
  if (id === "local") return "Saved on the server only";
  if (id === "origin") return "Back where it was created";
  const t = targets.find((x) => x.id === id);
  return t ? t.name : id;
}

/** Whether a job will run on its schedule, and what to say instead when it won't. */
function runState(j: CronJob): { runs: true } | { runs: false; why: string; tone: "muted" | "bad" } {
  if (j.state === "completed") return { runs: false, why: "Finished: it has no more runs.", tone: "muted" };
  if (!j.enabled || j.state === "paused") return { runs: false, why: "Paused: it won't run until resumed.", tone: "muted" };
  if (j.state === "error") return { runs: false, why: j.lastError ?? "Hermes can't work out its next run.", tone: "bad" };
  if (!j.nextRunAt) return { runs: false, why: "Hermes has no next run for it.", tone: "muted" };
  return { runs: true };
}

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
        <ol className="job-runs-preview">
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
export function ScheduledJobs({ api, profile, connected, onClose }: { api: CronApi; profile: string; connected: boolean; onClose: () => void }) {
  const [loaded, setLoaded] = useState<Loaded>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<CronError | Error>();
  const [view, setView] = useState<View>({ kind: "list" });
  /** What happened to a job that has left the list, said on the list. */
  const [notice, setNotice] = useState<string>();
  const live = useRef(true);
  useEffect(() => {
    // Set again on mount: StrictMode mounts twice, and a flag only cleared would drop every load after the first.
    live.current = true;
    return () => void (live.current = false);
  }, []);

  const load = async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [jobs, setting, targets] = await Promise.all([
        api.list(profile),
        api.timezone(profile).catch(() => undefined),
        api.targets(profile).catch(() => [] as DeliveryTarget[]),
      ]);
      if (!live.current) return;
      setLoaded({ jobs, zone: jobsZone(setting, jobs), targets });
    } catch (e) {
      if (live.current) setError(e as Error);
    } finally {
      if (live.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (connected) void load();
    else setLoading(false);
  }, [connected]);

  /** A job as Hermes read it back after a change, put in the list. `null` takes it out. */
  const apply = (id: string, job: CronJob | null) =>
    setLoaded((l) => l && { ...l, jobs: job ? (l.jobs.some((j) => j.id === id) ? l.jobs.map((j) => (j.id === id ? job : j)) : [...l.jobs, job]) : l.jobs.filter((j) => j.id !== id) });

  const unsupported = error instanceof CronError && (error.kind === "unsupported" || error.kind === "forbidden");
  const jobs = loaded?.jobs ?? [];
  const shown = view.kind !== "list" && view.id ? jobs.find((j) => j.id === view.id) : undefined;
  const heartbeat = jobs.find((j) => j.heartbeatAge !== undefined)?.heartbeatAge;

  return (
    <div className="settings jobs-screen">
      <div className="settings-inner">
        <button className="back" onClick={view.kind === "list" ? onClose : () => setView(view.kind === "edit" && view.id ? { kind: "job", id: view.id } : { kind: "list" })}>
          <ArrowLeft size={15} /> {view.kind === "list" ? "Back to chat" : view.kind === "edit" && view.id ? "Back to the job" : "Back to the jobs"}
        </button>
        {view.kind === "list" && (
          <>
            <h1 className="project-title">
              <CalendarClock size={20} /> <span>Scheduled jobs</span>
            </h1>
            <p className="muted">
              Jobs Hermes runs on the server for the <span className="mono">{profile}</span> profile, at the times set here, also while Hermes Chat is
              closed.{loaded && <> Times are in {loaded.zone.label}.</>}
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
                <button className="btn primary" disabled={!connected || !loaded} onClick={() => setView({ kind: "edit" })}>
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
                <p>{messageOf(error)}</p>
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
                {jobs.map((j) => (
                  <li key={j.id}>
                    <button className="job-row" onClick={() => setView({ kind: "job", id: j.id })}>
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
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        {view.kind === "job" && loaded && shown && (
          <JobDetail key={shown.id} api={api} profile={profile} connected={connected} job={shown} loaded={loaded} onChanged={apply} onEdit={() => setView({ kind: "edit", id: shown.id })} onDeleted={() => setView({ kind: "list" })}
            onToast={(text) => {
              setNotice(text);
              setView({ kind: "list" });
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
            onSaved={(job) => {
              apply(job.id, job);
              setView({ kind: "job", id: job.id });
            }}
            onCancel={() => setView(view.id ? { kind: "job", id: view.id } : { kind: "list" })}
          />
        )}
      </div>
    </div>
  );
}

function JobDetail({
  api,
  profile,
  connected,
  job,
  loaded,
  onChanged,
  onEdit,
  onDeleted,
  onToast,
}: {
  api: CronApi;
  profile: string;
  connected: boolean;
  job: CronJob;
  loaded: Loaded;
  onChanged: (id: string, job: CronJob | null) => void;
  onEdit: () => void;
  onDeleted: () => void;
  /** Says something on the list, once this job has left it. */
  onToast?: (text: string) => void;
}) {
  const [busy, setBusy] = useState<"pause" | "resume" | "run" | "delete">();
  const [confirm, setConfirm] = useState<"run" | "delete">();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [runs, setRuns] = useState<JobRun[] | string>();
  const [copies, setCopies] = useState<string[]>([]);
  useEffect(() => {
    if (connected) void api.copiesOf(profile, job.id).then(setCopies);
  }, [connected, job.id]);
  const copyNote =
    copies.length > 0 &&
    `The ${copies.join(" and ")} ${copies.length === 1 ? "profile has a copy" : "profiles have copies"} of this job, with the same id. If this one is deleted in another Hermes client while you change it here, Hermes changes ${copies.length === 1 ? "that copy" : "one of those copies"} instead; Hermes Chat says so if it notices.`;
  const zone = loaded.zone;
  const offline = connected ? undefined : "Connect to Hermes to change this job.";
  const paused = !job.enabled || job.state === "paused";

  const readRuns = () =>
    void api.runs(profile, job).then(
      (r) => setRuns(r),
      (e) => setRuns(messageOf(e)),
    );
  useEffect(() => {
    if (connected) readRuns();
  }, [connected, job.lastRunAt]);

  const act = async (what: NonNullable<typeof busy>, fn: () => Promise<void>) => {
    setBusy(what);
    setError(undefined);
    setNotice(undefined);
    setConfirm(undefined);
    try {
      await fn();
    } catch (e) {
      setError(messageOf(e));
      if (e instanceof CronError && e.kind === "gone") onChanged(job.id, null);
    } finally {
      setBusy(undefined);
    }
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
      if (!outcome.job) {
        onChanged(job.id, null);
        onToast?.(said);
        return;
      }
      if (!outcome.unverified) onChanged(job.id, outcome.job);
      setNotice(outcome.unverified ? `${said} The list couldn't be read afterwards to confirm it; refresh to check.` : said);
    });

  const deliver = deliveryLabel(job.deliver, loaded.targets);
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
      <h1 className="project-title">
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
        <button className="btn" disabled={!connected || !!busy} title={offline} onClick={() => setConfirm("run")}>
          <Zap size={14} /> {busy === "run" ? "Running on the server…" : "Run now"}
        </button>
        <button className="btn danger" disabled={!connected || !!busy} title={offline} onClick={() => setConfirm("delete")}>
          <Trash2 size={14} /> {busy === "delete" ? "Deleting…" : "Delete"}
        </button>
      </div>
      {copyNote && (
        <p className="job-banner" role="note">
          <CircleAlert size={14} /> {copyNote}
        </p>
      )}
      {confirm === "run" && (
        <div className="confirm" role="alertdialog" aria-label="Run this job now?" onKeyDown={(e) => e.key === "Escape" && setConfirm(undefined)}>
          <span>
            Run “{job.name}” now? On the server, Hermes {job.noAgent ? "runs its script" : "sends its prompt to the agent, which can use its tools,"} and
            delivers the result: {deliver.toLowerCase()}. This is a real run, and can take as long as the job does.
            {paused && " Hermes also resumes the job, so it runs on its schedule again afterwards."}
          </span>
          <div className="confirm-actions">
            <button className="btn" autoFocus onClick={() => setConfirm(undefined)}>
              Cancel
            </button>
            <button className="btn primary" onClick={() => void runNow()}>
              Run now
            </button>
          </div>
        </div>
      )}
      {confirm === "delete" && (
        <div className="confirm" role="alertdialog" aria-label="Delete this job?" onKeyDown={(e) => e.key === "Escape" && setConfirm(undefined)}>
          <span>Delete “{job.name}”? Hermes removes it for good, in every Hermes client, and it won't run again. This can't be undone.</span>
          <div className="confirm-actions">
            <button className="btn" autoFocus onClick={() => setConfirm(undefined)}>
              Cancel
            </button>
            <button
              className="btn danger"
              onClick={() =>
                void act("delete", async () => {
                  await api.remove(profile, job);
                  onChanged(job.id, null);
                  onDeleted();
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
        <p className="muted small">Time zone: {zone.label}.</p>
        <p>
          <NextRun job={job} zone={zone} />
        </p>
        {runState(job).runs && (
          <>
            <h3 className="job-sub">Upcoming runs</h3>
            <Upcoming schedule={job.schedule} zone={zone} first={Date.parse(job.nextRunAt!)} remaining={job.repeat.times === null ? null : job.repeat.times - job.repeat.completed} />
          </>
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

      <section>
        <h2>
          <History size={14} /> Runs
        </h2>
        <p>
          <LastRun job={job} zone={zone} />
        </p>
        {job.lastError && <p className="bad small">{job.lastError}</p>}
        {job.lastDeliveryError && <p className="bad small">Delivery: {job.lastDeliveryError}</p>}
        {job.latest && ["claimed", "running"].includes(job.latest.status) && <p className="muted small">A run is under way on the server.</p>}
        {runs === undefined ? (
          connected && (
            <div className="empty-hint">
              <Spinner /> Reading the run history…
            </div>
          )
        ) : typeof runs === "string" ? (
          <p className="muted small">{runs}</p>
        ) : runs.length ? (
          <ul className="job-history">
            {runs.map((r) => (
              <li key={r.id}>
                <div>
                  <When at={r.startedAt} zone={zone} />
                  {r.running && <span className="badge">Running</span>}
                  {r.status && <span className={`badge ${r.status === "Failed" ? "warn" : ""}`}>{r.status}</span>}
                </div>
                <div className="job-history-title">{r.title}</div>
                {r.preview && r.preview !== r.title && <div className="muted small job-history-preview">{r.preview}</div>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">Hermes has no runs of this job on record.</p>
        )}
      </section>
    </>
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
  onSaved,
  onCancel,
}: {
  api: CronApi;
  profile: string;
  connected: boolean;
  /** The job edited; undefined for a new one. */
  job?: CronJob;
  loaded: Loaded;
  onSaved: (job: CronJob) => void;
  onCancel: () => void;
}) {
  const zone = loaded.zone;
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

  const scheduleChanged = !base || form.schedule.trim() !== initial(base).schedule.trim();
  const parsed = useMemo((): Schedule | ScheduleError | undefined => {
    if (!form.schedule.trim() && !touched) return undefined;
    try {
      return parseSchedule(form.schedule, zone.zone, Date.now());
    } catch (e) {
      return e instanceof ScheduleError ? e : new ScheduleError(messageOf(e));
    }
  }, [form.schedule, zone.zone, touched]);
  const once = parsed && !(parsed instanceof ScheduleError) && parsed.kind === "once";
  const repeatProblem = !once && repeatText.trim() && !/^[1-9]\d{0,5}$/.test(repeatText.trim()) ? "Enter how many runs, a whole number from 1." : undefined;
  const promptProblem = !form.prompt.trim() && !(base && (base.noAgent || base.script || base.skills.length)) ? "Write what Hermes should do each time." : undefined;
  // A schedule left as it was isn't checked again: Hermes already has it, and a one-shot may be due by now.
  const scheduleProblem = scheduleChanged ? (parsed instanceof ScheduleError ? parsed.message : parsed ? undefined : "Enter a schedule.") : undefined;
  const problems = [promptProblem, scheduleProblem, repeatProblem].filter(Boolean);

  const targets = loaded.targets.length ? loaded.targets : [{ id: "local", name: "Local (save only)", ready: true }];
  const options = targets.some((t) => t.id === form.deliver) ? targets : [...targets, { id: form.deliver, name: deliveryLabel(form.deliver, []), ready: true }];

  const save = async () => {
    setTouched(true);
    if (problems.length || saving) return;
    setSaving(true);
    setError(undefined);
    const fields: JobFields = { ...form, repeat: once ? null : repeatText.trim() ? Number(repeatText) : null };
    try {
      if (!base) onSaved(await api.create(profile, fields, paused));
      else {
        const edits: Partial<JobFields> = { name: fields.name, prompt: fields.prompt, deliver: fields.deliver, ...(scheduleChanged && { schedule: fields.schedule }), ...(!once && { repeat: fields.repeat }) };
        onSaved(await api.update(profile, base, edits));
      }
    } catch (e) {
      if (e instanceof CronConflict) {
        setConflict(e);
        setBase(e.job);
      } else setError(messageOf(e));
    } finally {
      setSaving(false);
    }
  };

  const preview = parsed && !(parsed instanceof ScheduleError) ? parsed : !scheduleChanged ? base?.schedule : undefined;

  return (
    <>
      <h1 className="project-title">
        <CalendarClock size={20} /> <span>{job ? `Edit ${job.name}` : "New scheduled job"}</span>
      </h1>
      <p className="muted">
        In the <span className="mono">{profile}</span> profile. Hermes keeps the job on the server and runs it there, so it runs while Hermes Chat is closed.
      </p>
      <form
        className="job-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
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
            Times are in {zone.label}.{" "}
            {EXAMPLES.map((x) => (
              <button key={x} type="button" className="job-example" onClick={() => set({ schedule: x })}>
                {x}
              </button>
            ))}
          </span>
          {scheduleProblem && (touched || parsed instanceof ScheduleError) && <span className="field-hint err" role="alert">{scheduleProblem}</span>}
        </label>
        {preview && (
          <div className="job-preview" aria-live="polite">
            <div>
              <strong>{explainSchedule(preview, zone.zone)}</strong>
            </div>
            <Upcoming
              schedule={preview}
              zone={zone}
              first={!scheduleChanged && base?.nextRunAt ? Date.parse(base.nextRunAt) : undefined}
              remaining={once || !/^[1-9]\d*$/.test(repeatText.trim()) ? null : Number(repeatText) - (scheduleChanged ? 0 : (base?.repeat.completed ?? 0))}
            />
            {scheduleChanged && <p className="muted small">Hermes works out the runs again when it saves the job.</p>}
          </div>
        )}
        <label className="field">
          <span className="field-label">Deliver to</span>
          <select value={form.deliver} onChange={(e) => set({ deliver: e.target.value })}>
            {options.map((t) => (
              <option key={t.id} value={t.id} disabled={!t.ready && t.id !== form.deliver}>
                {deliveryLabel(t.id, targets)}
                {!t.ready ? " (no home channel set on the server)" : ""}
              </option>
            ))}
          </select>
          <span className="field-hint">Only the places this profile's gateway has set up.</span>
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
          <button type="submit" className="btn primary" disabled={!connected || saving} title={connected ? undefined : "Connect to Hermes to save."}>
            {saving ? "Saving…" : base ? (conflict ? "Save over their changes" : "Save") : "Create job"}
          </button>
        </div>
      </form>
    </>
  );
}
