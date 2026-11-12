// Troubleshooting a scheduled job (GLOSSARY.md "Troubleshoot", ADR 0053): the Jobs screen hands a job to Hermes in a
// new chat in the job's profile. The first message is built here from what the Jobs screen reads anyway (the job, its
// newest runs and their results, the delivery problems and scheduler warnings it flags), with long text cut and
// recognisable secrets hidden. Hermes then works on the job with its own cron tools; this app changes nothing itself.
// Once the chat's reply ends, the Jobs screen reads the job again and shows what changed since the chat started.
import { type CronApi, type CronJob, type DeliveryTarget, type JobRun, type JobsZone, type RunResult, deliveryProblems, statusLabel } from "./cronJobs";
import { redactSecrets } from "./secrets";
import { explainSchedule, isoIn } from "./schedule";
import type { Delivery } from "./transport";
import { errorText } from "./values";

/** How many of the newest runs the message carries (and the run the owner picked, when it is older). */
export const TROUBLESHOOT_RUNS = 5;
/** The most of a job's prompt the message carries before cutting its middle. */
export const PROMPT_LIMIT = 4000;
/** The most of one run's output, or of one error, the message carries before cutting its middle. */
export const OUTPUT_LIMIT = 1200;
/** A scheduler that hasn't checked the jobs for this long is likely not running, as the Jobs screen says. */
const STALE_SCHEDULER_S = 300;

/** What the message is built from: all of it read by the Jobs screen's own routes. */
export type TroubleshootInput = {
  profile: string;
  job: CronJob;
  zone: JobsZone;
  /** The profile's delivery targets; undefined when Hermes's list of them couldn't be read. */
  targets?: DeliveryTarget[];
  /** The newest runs, newest first, or why they couldn't be read. */
  runs: JobRun[] | string;
  /** Each agent run's reply, or why it couldn't be read, by run id. */
  results: Record<string, RunResult | string>;
  /** The run the owner pressed Troubleshoot on, if any. */
  picked?: string;
};

/** The message, and what was left out of it: `cut` names each text cut short, `hidden` each kind of secret hidden. */
export type TroubleshootMessage = { text: string; cut: string[]; hidden: string[] };

/**
 * `text` no longer than `limit`: its start and end with the middle cut out, since an error's cause is often at the
 * end of what a run printed and its context at the start. Says how much was cut, in the text.
 */
export function clip(text: string, limit: number): { text: string; cut: boolean } {
  if (text.length <= limit) return { text, cut: false };
  const head = Math.floor(limit / 3);
  const tail = limit - head;
  const gone = text.length - head - tail;
  return { text: `${text.slice(0, head)}\n[… ${gone} characters cut by Hermes Chat …]\n${text.slice(text.length - tail)}`, cut: true };
}

/** A Markdown fence for `text` that `text` can't close early. */
function fenced(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}

const RUN_WORDS: Record<JobRun["state"], string> = { running: "Running", succeeded: "Succeeded", failed: "Failed", unknown: "Unknown" };

/** Whether Hermes runs the job on its schedule, in words. `safe` hides secrets in Hermes's own text. */
function stateWords(j: CronJob, safe: (t: string) => string): string {
  if (j.state === "completed") return "finished (no more runs)";
  if (!j.enabled || j.state === "paused") return `paused${j.pausedReason ? ` (${safe(j.pausedReason)})` : ""}`;
  if (j.state === "error") return "error: Hermes can't work out its next run";
  return "scheduled (not paused)";
}

/**
 * The first message of a troubleshooting chat. Every text from the server (prompt, errors, output, names, settings) goes
 * through `redactSecrets` (the support bundle's patterns) and is cut to its limit; what was hidden or cut is listed, and the
 * message asks Hermes to read the job itself rather than write a marker back.
 */
export function troubleshootMessage(input: TroubleshootInput): TroubleshootMessage {
  const { job, profile, zone } = input;
  const cut: string[] = [];
  const hidden = new Set<string>();
  const safe = (t: string) => {
    const r = redactSecrets(t);
    r.kinds.forEach((k) => hidden.add(k));
    return r.text;
  };
  const block = (t: string, limit: number, what: string) => {
    const c = clip(safe(t), limit);
    if (c.cut) cut.push(what);
    return fenced(c.text);
  };
  const at = (ms: number) => isoIn(zone.zone, ms);
  // Hermes's own labels and ids go through `safe` too: anything the server sent may hold a secret.
  const atIso = (iso: string) => (Number.isNaN(Date.parse(iso)) ? iso : at(Date.parse(iso)));
  const name = safe(job.name);
  const out: string[] = [];

  out.push(
    `Please troubleshoot my scheduled job “${name}” (id \`${job.id}\`) in the ${profile} profile. Find out why it fails or doesn't do what it should, and fix it with your cron tools: change its prompt, script, schedule or delivery as needed.`,
    "",
    "- Work only on this job, in this profile. Don't create, delete or run jobs: I'll use Run now in Hermes Chat to check the fix.",
    "- Before each change, say what you will change and why. When you're done, list every change you made to the job, each with its old and new value, or say that you changed nothing.",
    "- If the cause is outside the job (a missing credential, a platform that isn't set up, the gateway not running), say what I need to do rather than working around it.",
    "- Hermes Chat cut long text and hid what looked like secrets below (marked “[… cut …]” or “[redacted …]”). They are unchanged on the server: read the job with your cron tool when you need them, and never write a marker back into the job.",
    "",
    "## The job",
    `- Name: ${name}`,
    `- Id: \`${job.id}\``,
    `- Profile: ${profile}`,
    `- Schedule: \`${safe(job.scheduleText)}\`${job.schedule ? ` (${explainSchedule(job.schedule, zone.zone)})` : ""}`,
    `- Time zone: ${zone.named ? zone.zone : `not named by Hermes; times below are in ${zone.label}`}`,
    `- State: ${stateWords(job, safe)}`,
  );
  if (job.nextRunAt) out.push(`- Next run: ${atIso(job.nextRunAt)}`);
  if (job.repeat.times !== null) out.push(`- Repeat: ${job.repeat.times} ${job.repeat.times === 1 ? "time" : "times"} in all, ${job.repeat.completed} done`);
  out.push(`- Delivers to: \`${safe(job.deliver)}\`${job.originPlatform ? ` (made from ${safe(job.originPlatform)})` : ""}`);
  if (job.lastRunAt) out.push(`- Last run: ${atIso(job.lastRunAt)}${job.lastStatus ? `, ${statusLabel(job.lastStatus).text.toLowerCase()} (\`${job.lastStatus}\`)` : ""}`);
  else out.push("- Last run: it hasn't run yet");
  if (job.model) out.push(`- Model: ${safe([job.provider, job.model].filter(Boolean).join(" / "))}`);
  if (job.skills.length) out.push(`- Skills: ${safe(job.skills.join(", "))}`);
  if (job.toolsets.length) out.push(`- Toolsets: ${safe(job.toolsets.join(", "))}`);
  if (job.workdir) out.push(`- Folder: ${safe(job.workdir)}`);
  if (job.contextFrom.length) out.push(`- Uses the output of: ${safe(job.contextFrom.join(", "))}`);
  if (job.lastError) out.push("", "Last error Hermes recorded:", block(job.lastError, OUTPUT_LIMIT, "the job's last error"));
  if (job.lastDeliveryError) out.push("", "Last delivery error Hermes recorded:", block(job.lastDeliveryError, OUTPUT_LIMIT, "the job's last delivery error"));

  if (job.noAgent) {
    out.push("", "## Script", `It runs the script \`${safe(job.script ?? "?")}\` with no agent and delivers what it prints. The script's own text is on the server; read it there.`);
    if (job.prompt.trim()) out.push("", "Its prompt field:", block(job.prompt, PROMPT_LIMIT, "the prompt"));
  } else {
    out.push("", "## Prompt", job.prompt.trim() ? block(job.prompt, PROMPT_LIMIT, "the prompt") : "(no prompt)");
    if (job.script) out.push("", `Before the prompt it runs the script \`${safe(job.script)}\`, whose text is on the server.`);
  }

  // What the Jobs screen flags, as it flags it.
  const flags: string[] = [];
  if (input.targets) flags.push(...deliveryProblems(job.deliver, input.targets, job.originPlatform));
  else if (job.deliver !== "local") flags.push("Hermes Chat couldn't read where this profile can deliver, so it couldn't check this job's delivery.");
  if (job.heartbeatAge === null) flags.push("Hermes hasn't recorded its scheduler running for this profile: jobs run only while the profile's gateway runs.");
  else if (typeof job.heartbeatAge === "number" && job.heartbeatAge > STALE_SCHEDULER_S)
    flags.push(`Hermes's scheduler last checked this profile's jobs ${Math.round(job.heartbeatAge / 60)} minutes ago, so it may not be running.`);
  out.push("", "## Problems Hermes Chat flags", ...(flags.length ? flags.map((f) => `- ${safe(f)}`) : ["- None."]));

  out.push("", "## Recent runs, newest first");
  if (typeof input.runs === "string") out.push(`Hermes Chat couldn't read the run history: ${safe(input.runs)}`);
  else if (!input.runs.length) out.push("Hermes has no runs of this job on record.");
  else
    input.runs.forEach((r, i) => {
      const result = input.results[r.id];
      out.push(
        "",
        `### ${i + 1}. ${RUN_WORDS[r.state]}${r.id === input.picked ? " (the run I picked)" : ""}`,
        `- ${r.script ? "Script run" : "Agent run"}, ${r.script ? "finished" : "started"} ${at(r.startedAt)}${!r.script && r.endedAt !== undefined ? `, ended ${at(r.endedAt)}` : ""}`,
      );
      if (!r.script && r.sessionId) out.push(`- Session: \`${safe(r.sessionId)}\``);
      if (r.error) out.push("- Error:", block(r.error, OUTPUT_LIMIT, `run ${i + 1}'s error`));
      if (r.note) out.push(`- Note: ${safe(r.note)}`);
      if (r.script && r.preview) out.push("- Output (Hermes serves only the start of it):", block(r.preview, OUTPUT_LIMIT, `run ${i + 1}'s output`));
      if (typeof result === "string") out.push(`- Its reply couldn't be read: ${safe(result)}`);
      else if (result?.reply) out.push("- The agent's last reply:", block(result.reply, OUTPUT_LIMIT, `run ${i + 1}'s reply`));
      else if (result) out.push("- The agent left no reply.");
    });

  // A last pass over the whole message catches what any line above let through unredacted: ids, the profile, Hermes's
  // status words, a timestamp it sent that isn't one. Text already redacted isn't matched again.
  return { text: safe(out.join("\n")), cut, hidden: [...hidden] };
}

/**
 * Reads what the message needs, over the Jobs screen's own routes: the job as the profile's list has it now, its
 * newest runs (with `picked` added when it is older), and the reply of each agent run among them. Only the job is
 * required; a history or reply that can't be read is said in the message instead.
 */
export async function gatherTroubleshoot(
  api: CronApi,
  profile: string,
  job: CronJob,
  seen: { zone: JobsZone; targets?: DeliveryTarget[] },
  picked?: JobRun,
): Promise<TroubleshootInput> {
  const now = (await api.list(profile)).find((j) => j.id === job.id);
  if (!now) throw new Error(`This job isn't in the ${profile} profile any more: it was deleted in another Hermes client.`);
  let runs: JobRun[] | string;
  try {
    runs = await api.runs(profile, now, TROUBLESHOOT_RUNS);
    if (picked && !runs.some((r) => r.id === picked.id)) runs = [...runs, picked];
  } catch (e) {
    runs = errorText(e);
  }
  const results: Record<string, RunResult | string> = {};
  if (typeof runs !== "string")
    await Promise.all(
      runs
        .filter((r) => r.sessionId && r.state !== "running")
        .map((r) =>
          api.runResult(profile, r).then(
            (res) => void (results[r.id] = res),
            (e: unknown) => void (results[r.id] = errorText(e)),
          ),
        ),
    );
  return { profile, job: now, zone: seen.zone, targets: seen.targets, runs, results, ...(picked && { picked: picked.id }) };
}

/** One change to a job, as the owner reads it. `before` and `after` are undefined for a value that isn't set. */
export type JobChange = { field: string; before?: string; after?: string; long?: boolean };

/**
 * The schedule as the owner reads it, with what Hermes's label leaves out: the expression, the interval, or the
 * instant of a one-shot (whose label, such as `once in 30m`, stays the same when it is moved).
 */
function scheduleWords(j: CronJob, zone?: string): string {
  const s = j.schedule;
  if (!s) return j.scheduleText;
  const what = s.kind === "cron" ? s.expr : s.kind === "interval" ? `every ${s.minutes} min` : zone ? isoIn(zone, s.runAt) : new Date(s.runAt).toISOString();
  return what === j.scheduleText ? what : `${j.scheduleText} (${what})`;
}

/**
 * What differs between the job as it was when troubleshooting started and as the list has it now. `zone` is the
 * schedule time zone, to show a one-shot's instant in.
 */
export function jobChanges(before: CronJob, after: CronJob, zone?: string): JobChange[] {
  const paused = (j: CronJob) => (j.state === "completed" ? "finished" : !j.enabled || j.state === "paused" ? "paused" : "scheduled");
  const fields: [string, (j: CronJob) => string | undefined, boolean?][] = [
    ["Name", (j) => j.name],
    ["Schedule", (j) => scheduleWords(j, zone)],
    ["State", paused],
    ["Prompt", (j) => j.prompt.trim() || undefined, true],
    ["Script", (j) => j.script],
    ["Runs the agent", (j) => (j.noAgent ? "no, the script only" : "yes")],
    ["Delivers to", (j) => j.deliver],
    ["Repeat", (j) => (j.repeat.times === null ? "no limit" : `${j.repeat.times} times`)],
    ["Model", (j) => [j.provider, j.model].filter(Boolean).join(" / ") || undefined],
    ["Skills", (j) => j.skills.join(", ") || undefined],
    ["Toolsets", (j) => j.toolsets.join(", ") || undefined],
    ["Folder", (j) => j.workdir],
    ["Uses the output of", (j) => j.contextFrom.join(", ") || undefined],
  ];
  return fields.flatMap(([field, of, long]) => {
    const was = of(before);
    const is = of(after);
    return was === is ? [] : [{ field, before: was, after: is, ...(long && { long: true }) }];
  });
}

/**
 * Where a troubleshooting chat is: `starting` until its message is on its way, `working` while Hermes's reply runs,
 * `ended` once the reply has ended (the Jobs screen then reads the job again), `failed` when the chat or its message
 * didn't start, with `reason`.
 */
export type TroublePhase = "starting" | "working" | "ended" | "failed";

/** A job handed to Hermes in a chat. `before`: the job as it was read just before, to show what Hermes changed. */
export type Troubleshoot = {
  id: string;
  /** The connection and profile it belongs to (`projectScope`), so a same-named profile on another server is apart. */
  scope: string;
  profile: string;
  jobId: string;
  jobName: string;
  before: CronJob;
  chatId?: string;
  phase: TroublePhase;
  reason?: string;
  /** Hermes didn't confirm the first message (the connection dropped): it may have it, and be working on it. */
  unconfirmed?: string;
  startedAt: number;
  endedAt?: number;
};

/**
 * What the store watches in the chat store: which profile shows, whether it is connected, and its chats. A chat's
 * `runtimeId` is set while it is attached on this connection; a dropped connection clears it and `running`, and a
 * reconnect's resume sets both again, so only an attached chat's `running` says whether its reply is still going.
 */
export type ChatsView = { profile: string; status: string; chats: readonly { id: string; running?: boolean; runtimeId?: string }[] };

/**
 * The troubleshooting chats started in this app run, kept in memory only: the newest for each job. The chat itself is
 * Hermes's and stays in the chat list; this only remembers which job it was for and how the job was before.
 */
export class TroubleshootStore {
  private list: Troubleshoot[] = [];
  private listeners = new Set<() => void>();
  private seq = 0;

  constructor(private now: () => number = Date.now) {}

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  getSnapshot = () => this.list;

  /** The newest troubleshooting of `jobId` in this connection and profile. */
  forJob(scope: string, profile: string, jobId: string): Troubleshoot | undefined {
    return this.list.find((t) => t.scope === scope && t.profile === profile && t.jobId === jobId);
  }

  /** A new troubleshooting of `job`, in place of an earlier one for the same job. */
  start(scope: string, profile: string, job: CronJob): Troubleshoot {
    const t: Troubleshoot = { id: `t${++this.seq}`, scope, profile, jobId: job.id, jobName: job.name, before: job, phase: "starting", startedAt: this.now() };
    this.set([t, ...this.list.filter((x) => !(x.scope === scope && x.profile === profile && x.jobId === job.id))]);
    return t;
  }

  /** The chat Hermes started for it. */
  opened(id: string, chatId: string) {
    this.patch(id, (t) => ({ ...t, chatId }));
  }

  failed(id: string, reason: string) {
    this.patch(id, (t) => (t.phase === "starting" ? { ...t, phase: "failed", reason } : t));
  }

  /**
   * What became of the first message. One Hermes took, or may have (`unknown`, said to be unconfirmed: it may be
   * changing the job), is followed as working; whether its reply has already ended is `observe`'s to say, with the
   * same checks as any other end. Pass the chat store's state as the answer came, as `view`.
   */
  sent(id: string, delivery: Delivery, view: ChatsView) {
    this.patch(id, (t) => {
      if (t.phase !== "starting") return t;
      if (delivery.delivery === "unsent") return { ...t, phase: "failed", reason: delivery.reason };
      return { ...t, phase: "working", ...(delivery.delivery === "unknown" && { unconfirmed: delivery.reason }) };
    });
    this.observe(view);
  }

  /**
   * Called with the chat store on every change: a working chat of the profile showing, connected and attached, whose
   * reply is no longer running, has ended. A dropped connection isn't an end, nor is the moment after a reconnect
   * before the chat is resumed. A chat that isn't resumed (say, after a profile switch) stays working; the Jobs
   * screen's Read the job again shows the changes so far meanwhile.
   */
  observe(view: ChatsView) {
    if (view.status !== "connected") return;
    const ended = this.list.filter(
      (t) => t.phase === "working" && t.profile === view.profile && view.chats.some((c) => c.id === t.chatId && !!c.runtimeId && !c.running),
    );
    if (!ended.length) return;
    const at = this.now();
    this.set(this.list.map((t) => (ended.includes(t) ? { ...t, phase: "ended", endedAt: at } : t)));
  }

  dismiss(id: string) {
    this.set(this.list.filter((t) => t.id !== id));
  }

  private patch(id: string, fn: (t: Troubleshoot) => Troubleshoot) {
    this.set(this.list.map((t) => (t.id === id ? fn(t) : t)));
  }

  private set(list: Troubleshoot[]) {
    if (list.length === this.list.length && list.every((t, i) => t === this.list[i])) return;
    this.list = list;
    for (const fn of this.listeners) fn();
  }
}

/** What starting a troubleshooting chat needs from the chat store: the existing new-chat and send path. */
export type ChatStarter = {
  readonly profile: string;
  newChat(): Promise<string>;
  send(chatId: string, text: string): Promise<Delivery>;
  getSnapshot(): ChatsView;
};

/**
 * Starts a new chat in `profile`, the job's, and sends `text` as its first message. A chat starts in the profile the
 * app shows, so it refuses when that isn't the job's, and when the profile changes before the message goes. `open`
 * shows the chat once it exists. Throws, with nothing sent, when the chat couldn't start.
 */
export async function startTroubleshoot(
  hermes: ChatStarter,
  store: TroubleshootStore,
  scope: string,
  profile: string,
  job: CronJob,
  text: string,
  open: (chatId: string) => void,
): Promise<Troubleshoot> {
  if (hermes.profile !== profile) throw new Error(`Hermes Chat shows the ${hermes.profile} profile now, not ${profile}, the job's. Nothing was sent.`);
  const t = store.start(scope, profile, job);
  let chatId: string;
  try {
    chatId = await hermes.newChat();
  } catch (e) {
    const reason = `Couldn't start a chat: ${errorText(e)}`;
    store.failed(t.id, reason);
    throw new Error(reason);
  }
  store.opened(t.id, chatId);
  if (hermes.profile !== profile) {
    const reason = `The profile changed to ${hermes.profile} while the chat was starting. It started empty in the ${profile} profile; the message wasn't sent.`;
    store.failed(t.id, reason);
    throw new Error(reason);
  }
  open(chatId);
  const delivery = await hermes.send(chatId, text);
  store.sent(t.id, delivery, hermes.getSnapshot());
  return store.getSnapshot().find((x) => x.id === t.id) ?? t;
}
