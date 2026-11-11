// Clone profile (ADR 0074): a new Hermes profile made from another one, through Hermes's own profile route. Nothing on
// the server is copied or written by this app directly.
//
// At the deployed `f0d94882` (`hermes_cli/web_routers/profiles.py`, `hermes_cli/profiles.py`):
// - `POST /api/profiles` `{name, …}` builds the profile in a hidden staging folder and renames it into place, so a
//   refusal or a failure while building leaves nothing behind. It refuses a name Hermes already has, a reserved one and
//   an invalid one (400).
// - Without `clone_from` the profile is fresh: an empty `.env`, Hermes's built-in skills, and only what the body gives:
//   `soul` (SOUL.md), `description`, and `provider` with `model`, which Hermes checks against its model list and
//   reports as `model_set`/`model_error` rather than failing the create.
// - With `clone_from` Hermes copies the source's `config.yaml`, `.env` (its API keys), SOUL.md, every skill folder,
//   both memory files and its plugins, and drops messaging channels. It never copies chats, scheduled jobs or the
//   gateway's state. That is the full copy, sent only when the owner opts in.
// - `DELETE /api/profiles/{name}` removes a profile's folder.
//
// The default is the fresh profile: SOUL.md, the model and the description go in the create body, and the source's own
// skills follow one at a time through Settings → Skills' copy (skills.ts), each read back. Memory can't be copied that
// way (Hermes has no call that adds an entry, ADR 0118), so only the full copy has it.
import type { RestMethod } from "./pipe";
import { answered, deadline, sameSoul, type PersonaApi, type Soul } from "./persona";
import { nameProblem, readProfileRows, type ProfileRow } from "./profiles";
import type { SkillRow, SkillsApi } from "./skills";

/** What the default (fresh) clone can carry over, each picked or not. */
export type Part = "persona" | "model" | "description" | "skills";

/** Every category the dialog shows, in its order: the pickable parts, then what only the full copy has, then what never goes. */
export type Category = Part | "keys" | "memory" | "never";
export const CATEGORY_LABELS: Record<Category, string> = {
  persona: "Persona (SOUL.md)",
  model: "Model",
  description: "Description",
  skills: "Own skills",
  keys: "API keys and settings",
  memory: "Memory",
  never: "Chats, scheduled jobs and messaging channels",
};
export const CATEGORIES = Object.keys(CATEGORY_LABELS) as Category[];

/** What a clone would do with one category, shown before anything is written. `available`: the source has it to copy. */
export type CategoryPlan = { copied: boolean; available: boolean; note: string };

/** The source as read before cloning. */
export type Source = {
  profile: ProfileRow;
  soul: Soul;
  /** Its own (Local) skills, the ones a fresh clone can copy. */
  skills: SkillRow[];
  /** Every name its skill list shows, for reading one (skills.ts `read`). */
  listed: string[];
  /** Why its skills couldn't be listed, if they couldn't. */
  skillsProblem?: string;
};

/** `fresh`: a new profile with only the picked parts. `full`: Hermes's copy of the source, API keys included. */
export type Plan = { kind: "fresh"; source: string; name: string; parts: ReadonlySet<Part> } | { kind: "full"; source: string; name: string };

/** One stage of a clone, as the dialog lists them while it runs. */
export type Stage = "name" | "create" | "skills" | "check";
export type StageState = "pending" | "running" | "done" | "failed" | "skipped";
export type OnStage = (stage: Stage, state: StageState, note?: string) => void;

/**
 * How one category came out, read back from the new profile: `copied`, it has what was sent; `failed`, it doesn't
 * (`note` says why); `left`, not picked or never copied; `unchecked`, Hermes copied it but this app can't read it back.
 */
export type Result = { category: Category; state: "copied" | "failed" | "left" | "unchecked"; note: string };

/** A skill copy that failed, to try again. */
export type FailedSkill = { row: SkillRow; problem: string };

/**
 * How a clone ended:
 * - `refused`: nothing was created (Hermes refused, or the request never went), so trying again is safe.
 * - `unsure`: Hermes's answer was lost and its list doesn't show the profile, or couldn't be read. It may still appear.
 * - `made`: the profile is on the server. `answered`: Hermes said it made it, rather than it being found after a lost
 *   answer; only then does this app offer to delete it. `results`: each category, read back.
 */
export type Outcome =
  | { kind: "refused"; problem: string }
  | { kind: "unsure"; problem: string }
  | { kind: "made"; name: string; answered: boolean; results: Result[]; failedSkills: FailedSkill[] };

/** How long each call may go unanswered. A create seeds skills in a subprocess and checks the model, so it is slow. */
export const CLONE_TIMEOUTS = { readMs: 30_000, createMs: 120_000, deleteMs: 60_000 };

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const said = (e: unknown) => (e instanceof Error ? e.message : String(e));

const modelOf = (p: ProfileRow) => (p.model && p.provider ? { provider: p.provider, model: p.model } : undefined);

/** Which parts `plan` carries over that the source has. The full copy carries all it has. A missing SOUL.md isn't sent as an empty one. */
function carries(plan: Pick<Plan, "kind"> & { parts?: ReadonlySet<Part> }, source: Source): Record<Part, boolean> {
  const pick = (p: Part) => plan.kind === "full" || !!plan.parts?.has(p);
  return {
    persona: source.soul.exists && pick("persona"),
    model: !!modelOf(source.profile) && pick("model"),
    description: !!source.profile.description && pick("description"),
    skills: (plan.kind === "full" || source.skills.length > 0) && pick("skills"),
  };
}

/** What each category would do under `plan`, from what the source has. */
export function preview(plan: Pick<Plan, "kind"> & { parts?: ReadonlySet<Part> }, source: Source): Record<Category, CategoryPlan> {
  const full = plan.kind === "full";
  const go = carries(plan, source);
  const model = modelOf(source.profile);
  const skills = source.skills;
  return {
    persona: {
      copied: go.persona,
      available: source.soul.exists,
      note: source.soul.exists ? `${source.soul.content.length.toLocaleString("en-US")} characters, as Hermes has it now` : "The source has none, so Hermes's default goes in",
    },
    model: { copied: go.model, available: !!model, note: model ? `${model.model} (${model.provider})${full ? "" : ". Hermes checks it against its model list"}` : "The source names no model of its own" },
    description: { copied: go.description, available: !!source.profile.description, note: source.profile.description || "The source has none" },
    skills: {
      copied: go.skills,
      available: full || skills.length > 0,
      note: full
        ? "Every skill folder, with all its files"
        : source.skillsProblem
          ? `Couldn't list them: ${source.skillsProblem}`
          : skills.length
            ? `${skills.map((s) => s.name).join(", ")}: SKILL.md only, the files beside it stay`
            : "The source has none of its own",
    },
    keys: {
      copied: full,
      available: true,
      note: full
        ? "config.yaml and .env, with every API key in them. Hermes leaves out messaging bot tokens"
        : "Not copied: the clone starts with an empty .env and Hermes's default settings (toolsets, MCP servers, memory provider)",
    },
    memory: { copied: full, available: true, note: full ? "Both memory files" : "Not copied: Hermes has no call that adds memory entries, so only the full copy has it" },
    never: { copied: false, available: false, note: "Never copied" },
  };
}

/** Sorts an error from a profile call into words for the owner, and whether it certainly changed nothing. */
function profileProblem(e: unknown, doing: string): { problem: string; unwritten: boolean } {
  const message = said(e);
  if (/^Not connected to Hermes|^The chat connection is closed|^Hermes Chat doesn't relay/.test(message)) return { problem: message, unwritten: true };
  const a = answered(e);
  if (!a) return { problem: `Couldn't ${doing}: ${message}`, unwritten: false };
  const reason = a.detail ? ` Hermes said: ${a.detail}` : "";
  if (a.status === 405 || (a.status === 404 && /^(not found$|no such api endpoint\b)/i.test(a.detail)))
    return { problem: `This Hermes server can't ${doing}: it has no route for it. Updating Hermes adds it.`, unwritten: true };
  // Hermes refuses before building anything: a taken, reserved or invalid name, or a source it can't find.
  if (a.status >= 400 && a.status < 500) return { problem: `Hermes didn't ${doing}.${reason}`, unwritten: true };
  return { problem: `Couldn't ${doing} (Hermes answered ${a.status}).${reason}`, unwritten: false };
}

/** Lists, makes and removes profiles for the Clone profile dialog. Every call names its profiles. */
export class ProfileCloneApi {
  constructor(
    private rest: (method: RestMethod, pathAndQuery: string, body?: unknown) => Promise<unknown>,
    private persona: PersonaApi,
    private skills: SkillsApi,
    private timeouts = CLONE_TIMEOUTS,
  ) {}

  /** Every profile Hermes has, in its order. */
  async profiles(): Promise<ProfileRow[]> {
    return readProfileRows(await deadline(this.rest("GET", "api/profiles"), this.timeouts.readMs, "listing profiles"));
  }

  /**
   * What `name` has that a clone could carry over, read now, alongside `profiles`, the list still being read. A skill
   * list that fails leaves skills out and says why.
   */
  async source(name: string, profiles: Promise<readonly ProfileRow[]>): Promise<Source> {
    const [list, soul, skills] = await Promise.all([
      profiles,
      this.persona.read(name),
      this.skills.rows(name).then(
        (rows) => ({ rows, problem: undefined }),
        (e: unknown) => ({ rows: [] as SkillRow[], problem: said(e) }),
      ),
    ]);
    const profile = list.find((p) => p.name === name);
    if (!profile) throw new Error(`Hermes doesn't list a profile named ${name} now.`);
    return { profile, soul, skills: skills.rows.filter((r) => r.source === "agent"), listed: skills.rows.map((r) => r.name), skillsProblem: skills.problem };
  }

  /**
   * Makes the profile `plan` names from `source`, then reads it back. The name is checked against Hermes's list, read
   * again now; Hermes refuses a taken name itself too, so a profile made meanwhile is never replaced.
   */
  async clone(plan: Plan, source: Source, onStage: OnStage): Promise<Outcome> {
    onStage("name", "running");
    let before: ProfileRow[];
    try {
      before = await this.profiles();
    } catch (e) {
      const { problem } = profileProblem(e, "list profiles");
      onStage("name", "failed", problem);
      return { kind: "refused", problem };
    }
    const taken = nameProblem(plan.name, before);
    if (taken) {
      onStage("name", "failed", taken);
      return { kind: "refused", problem: taken };
    }
    onStage("name", "done");

    const go = carries(plan, source);
    const description = go.description ? source.profile.description : undefined;
    const body =
      plan.kind === "fresh"
        ? { name: plan.name, ...(go.persona && { soul: source.soul.content }), ...(description && { description }), ...(go.model && modelOf(source.profile)) }
        : { name: plan.name, clone_from: plan.source, ...(description && { description }) };

    onStage("create", "running");
    let answer: Record<string, unknown>;
    try {
      const res = await deadline(this.rest("POST", "api/profiles", body), this.timeouts.createMs, `creating ${plan.name}`);
      if (!isObj(res) || res.ok !== true) throw new Error(`Hermes didn't say it created ${plan.name}.`);
      answer = res;
    } catch (e) {
      const { problem, unwritten } = profileProblem(e, `create ${plan.name}`);
      if (unwritten) {
        onStage("create", "failed", problem);
        return { kind: "refused", problem };
      }
      return this.settle(plan, source, onStage, problem);
    }
    onStage("create", "done");
    return this.finish(plan, source, answer, onStage);
  }

  /**
   * After a lost answer: whether Hermes lists `plan.name` now, and if so, the rest of the clone. `lost`: what happened
   * to the answer, when this follows it at once.
   */
  async settle(plan: Plan, source: Source, onStage: OnStage, lost?: string): Promise<Outcome> {
    onStage("create", "running");
    let listed: boolean;
    try {
      listed = (await this.profiles()).some((p) => p.name === plan.name);
    } catch (e) {
      const problem = `${lost ? `${lost} ` : ""}Reading Hermes's profiles to tell whether it was made failed: ${profileProblem(e, "list profiles").problem}`;
      onStage("create", "failed", problem);
      return { kind: "unsure", problem };
    }
    if (!listed) {
      const problem = `${lost ? `${lost} ` : ""}Hermes doesn't list ${plan.name} now, but it may still be making it.`;
      onStage("create", "failed", problem);
      return { kind: "unsure", problem };
    }
    onStage("create", "done", "Hermes's answer was lost, but it lists the profile now");
    return this.finish(plan, source, undefined, onStage);
  }

  /** Copies the skills `rows` from the source into the clone, one at a time, each read back. Returns the ones that failed. */
  async copySkills(plan: Plan, source: Source, rows: readonly SkillRow[], onStage: OnStage): Promise<FailedSkill[]> {
    onStage("skills", "running", `0 of ${rows.length}`);
    const failed: FailedSkill[] = [];
    for (const [i, row] of rows.entries()) {
      try {
        await this.skills.copy(plan.source, plan.name, row, source.listed);
      } catch (e) {
        failed.push({ row, problem: said(e) });
      }
      onStage("skills", "running", `${i + 1} of ${rows.length}`);
    }
    const copied = rows.length - failed.length;
    onStage("skills", failed.length ? "failed" : "done", `${copied} of ${rows.length} copied`);
    return failed;
  }

  /**
   * The skill copies, then each category read back from the new profile. `answer`: Hermes's answer to the create, if it
   * came. Without it the profile Hermes lists may be another client's, so nothing more is written to it.
   */
  private async finish(plan: Plan, source: Source, answer: Record<string, unknown> | undefined, onStage: OnStage): Promise<Outcome> {
    const copy = plan.kind === "fresh" && carries(plan, source).skills;
    const withheld = copy && !answer;
    const failedSkills = copy && !withheld ? await this.copySkills(plan, source, source.skills, onStage) : [];
    if (plan.kind === "full") onStage("skills", "skipped", "Hermes copied them with the profile");
    else if (withheld) onStage("skills", "skipped", "Hermes's answer was lost, so nothing is written to the profile it lists");
    else if (!copy) onStage("skills", "skipped");
    const results = await this.check(plan, source, answer, failedSkills, onStage, withheld);
    return { kind: "made", name: plan.name, answered: !!answer, results, failedSkills };
  }

  /**
   * Reads the new profile back and says how each category came out. Called again after skills are tried again.
   * `withheld`: the skills weren't copied, as Hermes's answer to the create was lost.
   */
  async check(
    plan: Plan,
    source: Source,
    answer: Record<string, unknown> | undefined,
    failedSkills: readonly FailedSkill[],
    onStage: OnStage,
    withheld = false,
  ): Promise<Result[]> {
    onStage("check", "running");
    const go = carries(plan, source);
    const full = plan.kind === "full";
    const out = new Map<Category, Result>();
    const put = (category: Category, state: Result["state"], note: string) => out.set(category, { category, state, note });
    let problem: string | undefined;

    let row: ProfileRow | undefined;
    try {
      row = (await this.profiles()).find((p) => p.name === plan.name);
      if (!row) problem = `Hermes doesn't list ${plan.name} when read back.`;
    } catch (e) {
      problem = `Couldn't read ${plan.name} back: ${profileProblem(e, "list profiles").problem}`;
    }

    if (!go.persona) put("persona", "left", source.soul.exists ? "Not picked: Hermes's default SOUL.md went in" : "The source has none, so Hermes's default went in");
    else
      try {
        const soul = await this.persona.read(plan.name);
        if (sameSoul(soul, source.soul)) put("persona", "copied", "SOUL.md reads back as the source's");
        else put("persona", "failed", "SOUL.md reads back differently from the source's");
      } catch (e) {
        put("persona", "unchecked", `Couldn't read SOUL.md back: ${said(e)}`);
      }

    const model = modelOf(source.profile);
    if (!go.model) put("model", "left", model ? "Not picked: Hermes's default model setting went in" : "The source names no model of its own");
    else if (!full && answer?.model_set === false)
      put("model", "failed", `Hermes didn't set it${str(answer.model_error) ? `: ${str(answer.model_error)!.replace(/([^.!?])$/, "$1.")}` : "."} Pick one in Settings → Model on the new profile.`);
    else if (!row) put("model", "unchecked", problem ?? "");
    else if (row.model === model?.model && row.provider === model?.provider) put("model", "copied", `${row.model} (${row.provider})`);
    else put("model", "failed", `It reads back as ${row.model ?? "none"} (${row.provider ?? "no provider"}). Pick one in Settings → Model on the new profile.`);

    if (!go.description) put("description", "left", source.profile.description ? "Not picked" : "The source has none");
    else if (!row) put("description", "unchecked", problem ?? "");
    else if (row.description === source.profile.description) put("description", "copied", row.description);
    else put("description", "failed", "It reads back differently from the source's");

    if (!go.skills) put("skills", "left", source.skills.length ? "Not picked: the clone has Hermes's built-in skills only" : "The source has none of its own; the clone has Hermes's built-in skills");
    else if (withheld)
      put(
        "skills",
        "failed",
        `Not copied: Hermes's answer to the create was lost, so this app can't tell ${plan.name} is this clone and writes nothing more to it. Copy them in Settings → Skills once you've checked it.`,
      );
    else if (!full)
      put(
        "skills",
        failedSkills.length ? "failed" : "copied",
        failedSkills.length
          ? `${failedSkills.length} of ${source.skills.length} didn't copy: ${failedSkills.map((f) => `${f.row.name} (${f.problem})`).join("; ")}`
          : `${source.skills.length} copied, SKILL.md only`,
      );
    else if (source.skillsProblem) put("skills", "unchecked", `Hermes copied every skill folder. Its skills couldn't be compared with the source's: ${source.skillsProblem}`);
    else
      try {
        const there = new Set((await this.skills.rows(plan.name)).map((s) => s.name));
        const missing = source.skills.filter((s) => !there.has(s.name)).map((s) => s.name);
        if (missing.length) put("skills", "failed", `Not in the clone: ${missing.join(", ")}`);
        else put("skills", "copied", source.skills.length ? `All ${source.skills.length} of its own are listed, with Hermes's built-in ones` : "Every skill folder");
      } catch (e) {
        put("skills", "unchecked", `Couldn't list the clone's skills: ${said(e)}`);
      }

    if (full) {
      put("keys", "unchecked", "Hermes copied config.yaml and .env with their API keys. This app never reads .env, so they aren't read back here");
      put("memory", "unchecked", "Hermes copied both memory files. They aren't read back here");
    } else {
      put("keys", "left", `Not copied: add API keys for ${plan.name} in Hermes, or with \`hermes -p ${plan.name} setup\` on the server`);
      put("memory", "left", "Not copied: Hermes has no call that adds memory entries");
    }
    put("never", "left", "Not copied");

    onStage("check", problem ? "failed" : "done", problem);
    return CATEGORIES.map((c) => out.get(c)!);
  }

  /** Tries the skills that didn't copy again, then reads the clone back. `answered`: as the clone's outcome says. */
  async retrySkills(plan: Plan, source: Source, failed: readonly FailedSkill[], answered: boolean, onStage: OnStage): Promise<Outcome> {
    const failedSkills = await this.copySkills(plan, source, failed.map((f) => f.row), onStage);
    const results = await this.check(plan, source, undefined, failedSkills, onStage);
    return { kind: "made", name: plan.name, answered, results, failedSkills };
  }

  /** Removes `name`, which this app just made, and reads the list back to confirm it's gone. */
  async remove(name: string): Promise<void> {
    try {
      await deadline(this.rest("DELETE", `api/profiles/${encodeURIComponent(name)}`), this.timeouts.deleteMs, `deleting ${name}`);
    } catch (e) {
      const { problem } = profileProblem(e, `delete ${name}`);
      let gone = false;
      try {
        gone = !(await this.profiles()).some((p) => p.name === name);
      } catch {
        // The list can't tell either: the delete's own problem says it.
      }
      if (gone) return;
      throw new Error(problem);
    }
    if ((await this.profiles()).some((p) => p.name === name)) throw new Error(`Hermes said it deleted ${name}, but still lists it.`);
  }
}
