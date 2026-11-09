// Settings → Skills: the skills Hermes offers the model in a profile, listed, turned on or off, and their SKILL.md
// edited, through the dashboard's own routes (GLOSSARY.md "Skill", ADR 0030). At the deployed `bf0203a`,
// `hermes_cli/web_routers/skills.py`:
// - `GET /api/skills?profile=` → `[{name, description, category, enabled, usage, provenance}]`: every loadable skill in
//   the profile's skills folder, `skills.create_dir` and `skills.external_dirs` (`find_all_skills`). `enabled` is the
//   profile's global `skills.disabled` list only; `provenance` is `hub`, `bundled`, `external` or `agent`.
// - `PUT /api/skills/toggle?profile=` `{name, enabled}` → adds the name to, or takes it off, `skills.disabled` under the
//   config lock. `hermes-agent` is essential: Hermes silently keeps it on.
// - `GET /api/skills/content?name=&profile=` → `{name, content, path}`: SKILL.md read with `utf-8-sig` and universal
//   newlines (`_find_skill`: directory name first, then `category/name`, then front matter `name:`).
// - `PUT /api/skills/content?profile=` `{name, content}` → `_edit_skill`: Hermes's own front matter and size check
//   (400 with its reason), then an atomic whole-file write that keeps the file's mode. No revision or If-Match.
//
// Copying a skill to another profile and archiving one (ADR 0118) use two routes the deployed `f0d94882` has:
// - `POST /api/skills?profile=` `{name, content, category}` → `_create_skill`: Hermes's own name, front matter, size and
//   security checks, and a refusal (400) when the profile already has a skill by that name. It writes SKILL.md only.
// - `DELETE /api/learning/node?profile=` `{id: <skill name>}` → `skill_usage.archive_skill`: the skill's folder moves to
//   the profile's `skills/.archive/`, and `hermes curator restore <name>` brings it back. Hermes refuses a pinned skill,
//   one from the Skills Hub, a built-in one (unless `curator.prune_builtins`), and one in an external folder.
//
// Hermes has no conditional write, so a Save first reads SKILL.md again and writes only if it is still the file and text
// the editor started from, then reads it back (as Persona does, ADR 0014). Skill text is instructions for the agent from
// wherever it came from: it is only ever shown as plain text.
import type { RestMethod } from "./pipe";
import { answered, asReadBack, deadline } from "./persona";
import { pyStrip } from "./memory";
import { MINE_MARK, SPLIT_MARK, THEIRS_MARK } from "./textEdit";

/** Where a skill came from, as `GET /api/skills` says (`provenance`). An unknown word is kept as Hermes sent it. */
export type SkillSource = "hub" | "bundled" | "external" | "agent";

/**
 * One skill as Hermes lists it. `scope`: `shared` for a skill in a folder `skills.external_dirs` names, which other
 * profiles may list too; `profile` for one in the profile's own skills folder.
 */
export type SkillRow = { name: string; description: string; category?: string; enabled: boolean; source: SkillSource | string; scope: "profile" | "shared" };

/**
 * A profile's skills as read from Hermes. `offFor`: skills a per-platform list (`skills.platform_disabled.tui` or
 * `.desktop`, the platforms this app's chats run as) keeps off, by name. `platformsRead` false: the config couldn't be
 * read, so `offFor` is empty for want of knowing.
 */
export type SkillsView = { profile: string; skills: SkillRow[]; offFor: Record<string, string[]>; platformsRead: boolean; readAt: number };

/** One skill's SKILL.md as Hermes has it: the name it was asked for, the file on the server, and its text. */
export type SkillFile = { name: string; path: string; content: string };

/** The text a save of this skill replaced, kept while this sign-in lasts, so the edit can be undone from here. */
export type SkillVersion = { content: string; replacedAt: number };

/**
 * Why a skill call failed:
 * - `disconnected`: no connection to Hermes. `signed-out`: the sign-in expired.
 * - `unsupported`: this Hermes server has no such route.
 * - `not-found`: Hermes has no skill by that name in the profile now.
 * - `identity`: Hermes resolves the name to another skill's file, so editing it could change the wrong skill.
 * - `permission`: the server refused, or its file system did. `refused`: Hermes turned the change down (its reason).
 */
export type SkillsProblemKind = "disconnected" | "signed-out" | "unsupported" | "not-found" | "identity" | "permission" | "refused" | "error";

export class SkillsError extends Error {
  constructor(
    readonly kind: SkillsProblemKind,
    message: string,
    readonly status?: number,
    /** The request never left this computer. */
    readonly unsent = false,
  ) {
    super(message);
  }
}

/**
 * How a Save ended:
 * - `saved`: Hermes has exactly what was sent, read back. `previous`: the file it replaced.
 * - `conflict`: SKILL.md changed on the server since the editor read it; nothing was written. `server`: what it is now.
 * - `changed`: written, but reading back found other text, so something else wrote too. `server`: what it is now.
 * - `unverified`: Hermes may have saved it, but reading back failed (`problem`), so it isn't known.
 */
export type SkillSaveResult =
  | { kind: "saved"; file: SkillFile; previous: SkillFile }
  | { kind: "conflict"; server: SkillFile }
  | { kind: "changed"; server: SkillFile; previous: SkillFile }
  | { kind: "unverified"; problem: SkillsError };

/** A switch's outcome, read back: `confirmed` when Hermes lists the skill as asked. `lost`: Hermes didn't answer the write. */
export type ToggleResult = { view: SkillsView; confirmed: boolean; lost?: SkillsError };

/** What a skill's body names under its own folder (`references/…`, `templates/…`, `assets/…`), checked on the server. */
export type ReferenceCheck = { missing: string[]; outside: string[]; unchecked?: string };

/** Skills Hermes keeps on whatever the config says (`agent.skill_utils.ESSENTIAL_SKILLS`). */
export const ESSENTIAL_SKILLS: ReadonlySet<string> = new Set(["hermes-agent"]);
/** The Hermes platforms this app's chats run as: `tui`, or `desktop` on a dashboard started with `HERMES_DESKTOP`. */
export const APP_PLATFORMS = ["tui", "desktop"] as const;
/** `skill_manager_tool` limits: SKILL.md's length and the description's, in characters (Python `len`). */
export const MAX_SKILL_CHARS = 100_000;
export const MAX_DESCRIPTION_CHARS = 1024;
/** How long a read or a write may go unanswered. The relay has no deadline of its own. */
export const SKILL_TIMEOUTS = { readMs: 30_000, writeMs: 60_000 };
/** Hermes's rule for a new skill's folder name and its category (`VALID_NAME_RE`, at most 64 characters). */
export const creatableName = (n: string) => n.length <= 64 && /^[a-z0-9][a-z0-9._-]*$/.test(n);

/**
 * Whether Hermes archives this skill when asked (`archive_skill`): only the profile's own skills. Skills Hub and
 * external-folder skills never are, and built-in ones only on a server set to prune them. Hermes finds the skill to
 * archive by its front matter name (`_find_skill_dir`), so one the list names by its path (two skills declare the same
 * name) can't be archived: sending the path finds nothing, and sending the shared name could archive the other one.
 */
export const archivable = (row: SkillRow) => row.source === "agent" && !row.name.includes("/");

/**
 * What became of one skill a copy, move or archive was asked for:
 * - `done`: the change is read back from Hermes. `file`: the copy as the target profile has it.
 * - `copied-only`: a move whose copy is read back, but the original couldn't be archived (`problem`), so it's in both.
 * - `failed`: nothing changed for this skill (`problem`), as far as reading back shows.
 * - `unsure`: Hermes's answer was lost and reading back couldn't tell (`problem`).
 */
export type TransferOutcome =
  | { name: string; kind: "done"; file?: SkillFile }
  | { name: string; kind: "copied-only" | "failed" | "unsure"; problem: string };

/** How many replaced versions are kept per skill. */
const KEEP_VERSIONS = 10;

const chars = (s: string) => [...s].length;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Whether Hermes Chat sends a skill name to Hermes at all (the Rust relay checks the same): one line, no backslash, and
 * no `.` or `..` path segment or leading `/`, so a name can't point Hermes's lookup outside the skills folders.
 */
export function safeSkillName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 256 &&
    !/[\u0000-\u001f\u007f\\]/.test(name) &&
    !name.startsWith("/") &&
    !name.split("/").some((seg) => seg === "." || seg === ".." || seg === "")
  );
}

/** SKILL.md split as `_validate_frontmatter` does: `null` when the front matter isn't closed, undefined when there is none. */
function splitFrontmatter(content: string): { yaml: string; body: string } | null | undefined {
  const c = content.replace(/^﻿/, "");
  if (!c.startsWith("---")) return undefined;
  const end = /\n---\s*\n/.exec(c.slice(3));
  if (!end) return null;
  return { yaml: c.slice(3, 3 + end.index), body: c.slice(3 + end.index + end[0].length) };
}

/**
 * Front matter in a YAML form that could give a key some other way than a plain `key:` line, which this reader doesn't
 * follow: a complex (`?`), tagged, anchored, aliased or merged (`<<`) key, a double-quoted key with an escape (which can
 * spell `name`), or a flow mapping. Hermes's PyYAML would read those; this app can't check them, so it says so.
 */
const murkyYaml = (yaml: string) =>
  yaml.split("\n").some((l) => /^[?!&*%@`{[]/.test(l) || /^<<[ \t]*:/.test(l) || /^"[^"]*\\/.test(l));

/**
 * A top-level `key:` of the front matter, and its value when it's a plain one-line scalar. A key given twice counts as
 * its last, as PyYAML's `safe_load` reads it. `murky`: the front matter has a form `murkyYaml` names, so no key can be
 * read for certain.
 */
function field(yaml: string, key: string): { value?: string; murky?: boolean } | undefined {
  if (murkyYaml(yaml)) return { murky: true };
  const re = new RegExp(`^(["']?)${key}\\1[ \\t]*:(.*)$`);
  const lines = yaml.split("\n");
  let found: { value?: string } | undefined;
  lines.forEach((line, i) => {
    const m = re.exec(line);
    if (!m) return;
    let v: string | undefined = m[2].replace(/[ \t]+#.*$/, "").trim();
    // An indented line after it continues the value over several lines.
    const continued = /^[ \t]+\S/.test(lines[i + 1] ?? "");
    // Block scalars, anchors, aliases, tags and flow values aren't read here, nor a double-quoted value with an escape.
    if (!v || continued || /^[|>&*!{[]/.test(v)) v = undefined;
    else if (v.startsWith('"')) v = /^"([^"\\]*)"$/.exec(v)?.[1];
    else if (v.startsWith("'")) v = /^'((?:[^']|'')*)'$/.exec(v)?.[1]?.replace(/''/g, "'");
    found = { value: v };
  });
  return found;
}

/**
 * The front matter `name:` of a SKILL.md: its value when it's plain, `null` when it's there but written in a form this
 * app doesn't read (a block scalar, a value over several lines, an anchor, a flow value, or front matter `murkyYaml`
 * names), undefined when there is none.
 */
export function frontmatterName(content: string): string | null | undefined {
  const fm = splitFrontmatter(content);
  const n = fm ? field(fm.yaml, "name") : undefined;
  return n ? (n.value ?? null) : undefined;
}

/** The name a skill's SKILL.md gives itself, as opened: its front matter `name:`, or the list's name's last part. */
export function declaredName(file: SkillFile): string {
  return frontmatterName(file.content) || file.name.slice(file.name.lastIndexOf("/") + 1);
}

/**
 * Why Hermes would refuse `content` as `name`'s SKILL.md, or this screen won't send it, each as something to fix. The
 * checks follow `_validate_frontmatter` and `_validate_content_size` at `bf0203a`; Hermes's own YAML parse still has the
 * last word, and its refusal is shown as it words it. `name`: the front matter name the file had when opened
 * (`declaredName`), which an edit here can't change. It can differ from the list's name, such as `writing/example`.
 */
export function skillProblems(content: string, name: string): string[] {
  if (!pyStrip(content)) return ["SKILL.md can't be empty. It needs front matter with name and description, then the skill's instructions."];
  const out: string[] = [];
  const fm = splitFrontmatter(content);
  if (fm === undefined) out.push("SKILL.md has to start with front matter: a line holding only ---, then the name: and description: fields, then another --- line.");
  else if (fm === null) out.push("The front matter isn't closed. Add a line holding only --- after its last field.");
  else {
    const n = field(fm.yaml, "name");
    const d = field(fm.yaml, "description");
    if (n?.murky)
      out.push(
        "The front matter uses a YAML form Hermes Chat doesn't read (a tagged, anchored, merged, complex or escaped key, or a flow mapping), so it can't check the name isn't changed. Write each field as a plain key: value line.",
      );
    else if (!n) out.push(`The front matter needs a name: field. This skill's is name: ${name}`);
    else if (n.value === undefined)
      out.push(`Write the name as one plain line, name: ${name}, so Hermes Chat can check it isn't changed.`);
    else if (n.value !== name)
      out.push(`The name is "${n.value}" here but "${name}" on the server. Renaming a skill isn't supported here, as its chats and settings know it by name; change it back to name: ${name}`);
    if (!d) out.push("The front matter needs a description: field, which the agent reads to decide when to use the skill.");
    else if (!d.murky && d.value !== undefined && chars(d.value) > MAX_DESCRIPTION_CHARS)
      out.push(`The description is ${chars(d.value).toLocaleString("en-US")} characters; Hermes takes at most ${MAX_DESCRIPTION_CHARS.toLocaleString("en-US")}. Move detail into the body.`);
    if (!pyStrip(fm.body)) out.push("There's nothing after the front matter. Hermes needs the skill's instructions there.");
  }
  if (chars(content) > MAX_SKILL_CHARS)
    out.push(`SKILL.md is ${chars(content).toLocaleString("en-US")} characters; Hermes takes at most ${MAX_SKILL_CHARS.toLocaleString("en-US")}. Move detail into a file under references/.`);
  const lines = content.split("\n");
  if (lines.some((l) => l === MINE_MARK || l === THEIRS_MARK) && lines.includes(SPLIT_MARK))
    out.push(`Merge markers are still in the text (${MINE_MARK}). Settle each one, keeping the lines you want, then save.`);
  return out;
}

/**
 * The files a SKILL.md's body names in its own folder, as Hermes's linter finds them (`skill_linter._check_body`
 * `dangling-reference`): `references/`, `templates/` or `assets/` paths, without globs or bare folders. A full stop that
 * ends a sentence isn't part of the path. `scripts/` is left out, as Hermes does: skills cite repository scripts too.
 */
export function referencedPaths(content: string): string[] {
  const fm = splitFrontmatter(content);
  const body = fm ? fm.body : content;
  const seen = new Set<string>();
  for (const m of body.matchAll(/(?:references|templates|assets)\/[\p{L}\p{N}\p{M}_./-]+/gu)) {
    const rel = m[0].replace(/\.+$/, "");
    if (rel.includes("*") || rel.endsWith("/")) continue;
    seen.add(rel);
  }
  return [...seen];
}

const DENIED = /permission denied|errno 13\b|errno 1\b|operation not permitted|read-only file system|errno 30\b/i;

/** Sorts an error from a skills call. `doing`: what was asked, for the message. */
export function skillsError(e: unknown, doing: "list" | "read" | "save" | "toggle" | "copy" | "archive", name?: string): SkillsError {
  if (e instanceof SkillsError) return e;
  const message = e instanceof Error ? e.message : String(e);
  const what = {
    list: "list skills",
    read: `read ${name ?? "the skill"}`,
    save: `save ${name ?? "the skill"}`,
    toggle: `change ${name ?? "the skill"}`,
    copy: `copy ${name ?? "the skill"}`,
    archive: `archive ${name ?? "the skill"}`,
  }[doing];
  if (/^Not connected to Hermes|^The chat connection is closed/.test(message)) return new SkillsError("disconnected", "Not connected to Hermes.", undefined, true);
  if (/^Can't reach the Hermes dashboard/.test(message)) return new SkillsError("disconnected", message);
  if (/^The dashboard sign-in has expired/.test(message)) return new SkillsError("signed-out", message);
  if (/^Hermes Chat doesn't relay/.test(message)) return new SkillsError("unsupported", message, undefined, true);
  const a = answered(message);
  if (!a) return new SkillsError("error", `Couldn't ${what}: ${message}`);
  const said = a.detail ? ` Hermes said: ${a.detail}${/[.!?]$/.test(a.detail) ? "" : "."}` : "";
  const route = {
    list: "GET /api/skills",
    read: "GET /api/skills/content",
    save: "PUT /api/skills/content",
    toggle: "PUT /api/skills/toggle",
    copy: "POST /api/skills",
    archive: "DELETE /api/learning/node",
  }[doing];
  // A route the server doesn't have: `bf0203a` answers `404 No such API endpoint: <path>`, plain FastAPI `404 Not Found`,
  // and 405 for a method a path doesn't take.
  if ((a.status === 404 && /^(not found$|no such api endpoint\b)/i.test(a.detail)) || a.status === 405)
    return new SkillsError("unsupported", `This Hermes server can't ${what}: it has no ${route} route. Updating Hermes adds it.`, a.status);
  if (a.status === 404) return new SkillsError("not-found", `Hermes has no skill named ${name ?? "that"} in this profile now. It may have been removed or renamed.${said}`, a.status);
  if (a.status === 403 || a.status === 401 || DENIED.test(a.detail)) return new SkillsError("permission", `Hermes isn't allowed to ${what}.${said}`, a.status);
  if (a.status === 400 || a.status === 422)
    return new SkillsError("refused", `Hermes didn't ${{ save: "save it", copy: "copy it", archive: "archive it" }[doing as string] ?? "do it"}:${said || " it gave no reason."}`, a.status);
  return new SkillsError("error", `Couldn't ${what} (Hermes answered ${a.status}).${said}`, a.status);
}

/** A failed write that certainly changed nothing: it never went out, or Hermes refused it before writing (any 4xx). */
const certainlyUnwritten = (e: SkillsError) => e.unsent || (e.status !== undefined && e.status >= 400 && e.status < 500);

/** Hermes's `_normalize_skill_names`: null is none, one string is one name (not its characters), a list its names. */
function skillNames(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  const items = Array.isArray(v) ? v : [v];
  return items.map((i) => pyStrip(typeof i === "string" ? i : JSON.stringify(i))).filter(Boolean);
}

const sameFile = (a: SkillFile, b: SkillFile) => a.path === b.path && asReadBack(a.content) === asReadBack(b.content);

/** Lists, reads, writes and switches a named profile's skills. Every call names its profile. */
export class SkillsApi {
  private versions = new Map<string, SkillVersion[]>();

  constructor(
    private rest: (method: RestMethod, pathAndQuery: string, body?: unknown) => Promise<unknown>,
    private timeouts = SKILL_TIMEOUTS,
    private now = () => Date.now(),
  ) {}

  /** `profile`'s skills as `list` orders them, without reading which ones a per-platform list keeps off. */
  async rows(profile: string): Promise<SkillRow[]> {
    let res: unknown;
    try {
      res = await deadline(this.rest("GET", `api/skills?${new URLSearchParams({ profile })}`), this.timeouts.readMs, "listing skills");
    } catch (e) {
      throw skillsError(e, "list");
    }
    if (!Array.isArray(res)) throw new SkillsError("unsupported", "This Hermes server answered the skill list in a shape Hermes Chat doesn't understand.");
    const skills: SkillRow[] = res.flatMap((r) => {
      if (!isObj(r) || typeof r.name !== "string" || !r.name) return [];
      const source = typeof r.provenance === "string" && r.provenance ? r.provenance : "agent";
      return [
        {
          name: r.name,
          description: typeof r.description === "string" ? r.description : "",
          category: typeof r.category === "string" && r.category ? r.category : undefined,
          enabled: r.enabled !== false,
          source,
          scope: source === "external" ? "shared" : "profile",
        },
      ];
    });
    // The owner's own skills first, the ones that came with Hermes last; by name within each.
    const rank = (r: SkillRow) => {
      const i = ["agent", "external", "hub", "bundled"].indexOf(r.source);
      return i < 0 ? 4 : i;
    };
    skills.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    return skills;
  }

  /** `profile`'s skills, Local ones first and Built in last, with which ones a per-platform list keeps off in this app's chats. */
  async list(profile: string): Promise<SkillsView> {
    const skills = await this.rows(profile);
    // No prototype: a skill may be named "constructor" or "__proto__".
    const offFor: Record<string, string[]> = Object.create(null);
    let platformsRead = true;
    try {
      // Only `skills.platform_disabled` is kept from the config.
      const config = await deadline(this.rest("GET", `api/config?${new URLSearchParams({ profile })}`), this.timeouts.readMs, "reading the config");
      const lists = isObj(config) && isObj(config.skills) && isObj(config.skills.platform_disabled) ? config.skills.platform_disabled : {};
      const per = APP_PLATFORMS.map((platform) => [platform, new Set(skillNames(lists[platform]))] as const);
      // Hermes matches a list entry against a skill's declared name or its list name (`is_disabled_entry`). A skill's
      // list name is its declared name unless two skills share that, when it's the skill's path (`writing/one`). So only
      // an entry no row is listed by can mean such a skill, and only then are their SKILL.md files read to tell.
      const listed = new Set(skills.map((r) => r.name));
      const declared = new Map<string, string>();
      if (per.some(([, names]) => [...names].some((n) => !listed.has(n))))
        await Promise.all(
          skills
            .filter((r) => r.name.includes("/"))
            .map(async (r) => {
              try {
                const d = frontmatterName((await this.read(profile, r.name, [...listed])).content);
                if (typeof d === "string") declared.set(r.name, d);
                else platformsRead = false;
              } catch {
                platformsRead = false;
              }
            }),
        );
      for (const [platform, names] of per)
        for (const row of skills) {
          const own = declared.get(row.name);
          if (!ESSENTIAL_SKILLS.has(row.name) && (names.has(row.name) || (own !== undefined && names.has(own)))) (offFor[row.name] ??= []).push(platform);
        }
    } catch {
      platformsRead = false;
    }
    return { profile, skills, offFor, platformsRead, readAt: this.now() };
  }

  /**
   * `name`'s SKILL.md in `profile`. `listed`: every name the list shows. Rejects with `identity` when Hermes resolves the
   * name to a file whose front matter names another listed skill (a directory named like another skill's name).
   */
  async read(profile: string, name: string, listed: readonly string[]): Promise<SkillFile> {
    if (!safeSkillName(name)) throw new SkillsError("identity", `"${name}" isn't a skill name Hermes Chat sends to Hermes, so this skill can't be opened here.`, undefined, true);
    let res: unknown;
    try {
      res = await deadline(this.rest("GET", `api/skills/content?${new URLSearchParams({ name, profile })}`), this.timeouts.readMs, `reading ${name}`);
    } catch (e) {
      throw skillsError(e, "read", name);
    }
    if (!isObj(res) || typeof res.content !== "string" || typeof res.path !== "string" || !res.path)
      throw new SkillsError("unsupported", "This Hermes server answered the skill read in a shape Hermes Chat doesn't understand.");
    const declared = frontmatterName(res.content);
    if (declared === null)
      throw new SkillsError(
        "identity",
        `${res.path} gives its name in a form Hermes Chat doesn't read (not a plain name: line), so it can't check which skill the file is. Edit it on the server.`,
      );
    if (declared !== undefined && declared !== name && listed.includes(declared))
      throw new SkillsError(
        "identity",
        `Hermes finds ${name} at ${res.path}, but that file is the ${declared} skill. Hermes looks a name up by folder first, so the two skills clash, and saving here could change the wrong one. Rename one of their folders on the server.`,
      );
    return { name, path: res.path, content: res.content };
  }

  /** Which files `content`'s body names that aren't in `file`'s folder on the server, read through Server files' listing. */
  async checkReferences(file: SkillFile, content: string): Promise<ReferenceCheck> {
    const dir = file.path.replace(/\/[^/]*$/, "");
    const rels = referencedPaths(content);
    const outside = rels.filter((r) => r.split("/").some((seg) => seg === ".." || seg === "."));
    const inside = rels.filter((r) => !outside.includes(r));
    const byFolder = new Map<string, string[]>();
    for (const rel of inside) {
      const folder = `${dir}/${rel.slice(0, rel.lastIndexOf("/"))}`;
      byFolder.set(folder, [...(byFolder.get(folder) ?? []), rel]);
    }
    const missing: string[] = [];
    let unchecked: string | undefined;
    await Promise.all(
      [...byFolder].map(async ([folder, wanted]) => {
        let names: Set<string>;
        try {
          const res = await deadline(this.rest("GET", `api/files?${new URLSearchParams({ path: folder })}`), this.timeouts.readMs, "listing the skill's folder");
          const entries = isObj(res) && Array.isArray(res.entries) ? res.entries : [];
          names = new Set(entries.flatMap((e) => (isObj(e) && typeof e.name === "string" && e.broken_link !== true ? [e.name] : [])));
        } catch (e) {
          const a = answered(e instanceof Error ? e.message : String(e));
          // A folder that isn't there: everything named in it is missing.
          if (a?.status === 404 && /^path not found$/i.test(a.detail)) names = new Set();
          else {
            unchecked = `Couldn't list ${folder} on the server to check the files the skill names: ${a ? `${a.status} ${a.detail}` : e instanceof Error ? e.message : String(e)}`;
            return;
          }
        }
        for (const rel of wanted) if (!names.has(rel.slice(rel.lastIndexOf("/") + 1))) missing.push(rel);
      }),
    );
    return { missing: missing.sort(), outside, unchecked };
  }

  /**
   * Saves `content` as `base.name`'s SKILL.md if Hermes still has `base`, then reads it back. Rejects with a
   * SkillsError when nothing was written, or when it can't be told whether it was.
   */
  async save(profile: string, base: SkillFile, content: string, listed: readonly string[]): Promise<SkillSaveResult> {
    const before = await this.read(profile, base.name, listed);
    const sent: SkillFile = { ...before, content: asReadBack(content) };
    if (!sameFile(before, base)) {
      // A save whose answer was lost, and that went through: Hermes already has this text.
      if (sameFile(before, sent)) return this.kept(profile, { kind: "saved", file: before, previous: base });
      return { kind: "conflict", server: before };
    }
    if (sameFile(before, sent)) return { kind: "saved", file: before, previous: before };
    try {
      const res = await deadline(
        this.rest("PUT", `api/skills/content?${new URLSearchParams({ profile })}`, { name: base.name, content }),
        this.timeouts.writeMs,
        "the save",
      );
      if (!isObj(res) || res.success !== true) throw new SkillsError("error", "Hermes didn't say it saved SKILL.md.");
    } catch (e) {
      const err = skillsError(e, "save", base.name);
      if (certainlyUnwritten(err)) throw err;
      let now: SkillFile;
      try {
        now = await this.read(profile, base.name, listed);
      } catch (again) {
        throw new SkillsError(
          "error",
          `Couldn't tell whether ${base.name} was saved: ${err.message} Reading it back also failed: ${skillsError(again, "read", base.name).message} Your edit is still here; reload once connected to see what Hermes has.`,
          err.status,
        );
      }
      if (sameFile(now, sent)) return this.kept(profile, { kind: "saved", file: now, previous: before });
      if (sameFile(now, before)) throw err;
      return this.kept(profile, { kind: "changed", server: now, previous: before });
    }
    let after: SkillFile;
    try {
      after = await this.read(profile, base.name, listed);
    } catch (e) {
      this.keep(profile, before);
      return { kind: "unverified", problem: skillsError(e, "read", base.name) };
    }
    return this.kept(profile, sameFile(after, sent) ? { kind: "saved", file: after, previous: before } : { kind: "changed", server: after, previous: before });
  }

  /** Turns `name` on or off in `profile`'s `skills.disabled`, then reads the list back to see whether Hermes has it so. */
  async setEnabled(profile: string, name: string, enabled: boolean): Promise<ToggleResult> {
    if (!safeSkillName(name)) throw new SkillsError("identity", `"${name}" isn't a skill name Hermes Chat sends to Hermes.`, undefined, true);
    let lost: SkillsError | undefined;
    try {
      await deadline(this.rest("PUT", `api/skills/toggle?${new URLSearchParams({ profile })}`, { name, enabled }), this.timeouts.writeMs, "the change");
    } catch (e) {
      const err = skillsError(e, "toggle", name);
      if (certainlyUnwritten(err)) throw err;
      lost = err;
    }
    let view: SkillsView;
    try {
      view = await this.list(profile);
    } catch (e) {
      if (!lost) throw new SkillsError("error", `Hermes took the change, but reading the list back failed: ${skillsError(e, "list").message}`);
      throw new SkillsError("error", `Couldn't tell whether ${name} was turned ${enabled ? "on" : "off"}: ${lost.message} Reading the list back also failed. Reload once connected to see.`, lost.status);
    }
    const row = view.skills.find((s) => s.name === name);
    return { view, confirmed: !!row && row.enabled === enabled, lost };
  }

  /**
   * Copies `row`'s SKILL.md from profile `from` to profile `to`, as a new skill with the name its front matter declares
   * and the same category, then reads it back from `to`. Only SKILL.md goes: a skill's other files stay where they are.
   * `listed`: every name `from`'s list shows. Rejects with a SkillsError when Hermes didn't create it, or when it can't
   * be told whether it did.
   */
  async copy(from: string, to: string, row: SkillRow, listed: readonly string[]): Promise<SkillFile> {
    if (from === to) throw new SkillsError("refused", "A skill can't be copied to the profile it's in.", undefined, true);
    const source = await this.read(from, row.name, listed);
    const name = declaredName(source);
    if (!creatableName(name))
      throw new SkillsError(
        "refused",
        `Hermes takes a new skill's name only in lowercase letters, digits, dots, dashes and underscores, starting with a letter or digit, so "${name}" can't be copied as it is. Rename it on the server first.`,
        undefined,
        true,
      );
    // The copy keeps the category, as the question says, or isn't made: Hermes would put it at the top level otherwise.
    if (row.category && !creatableName(row.category))
      throw new SkillsError(
        "refused",
        `${name} is in the category "${row.category}", and Hermes takes a new skill's category only in lowercase letters, digits, dots, dashes and underscores, so the copy couldn't keep it. Rename that category's folder on the server first.`,
        undefined,
        true,
      );
    const category = row.category || undefined;
    const sent = asReadBack(source.content);
    const there = async () => {
      try {
        return await this.read(to, name, [name]);
      } catch (e) {
        if (e instanceof SkillsError && e.kind === "not-found") return undefined;
        throw e;
      }
    };
    try {
      const res = await deadline(
        this.rest("POST", `api/skills?${new URLSearchParams({ profile: to })}`, { name, content: source.content, ...(category && { category }) }),
        this.timeouts.writeMs,
        "the copy",
      );
      if (!isObj(res) || res.success !== true) throw new SkillsError("error", "Hermes didn't say it created the skill.");
    } catch (e) {
      const err = skillsError(e, "copy", name);
      if (certainlyUnwritten(err)) throw err;
      let now: SkillFile | undefined;
      try {
        now = await there();
      } catch (again) {
        throw new SkillsError("error", `Couldn't tell whether ${name} was copied to ${to}: ${err.message} Reading it back also failed: ${skillsError(again, "read", name).message}`, err.status);
      }
      if (now && asReadBack(now.content) === sent) return now;
      if (!now) throw err;
      throw new SkillsError("error", `${to} has a skill named ${name} now, but its SKILL.md isn't the one sent: ${err.message}`, err.status);
    }
    let after: SkillFile | undefined;
    try {
      after = await there();
    } catch (e) {
      throw new SkillsError("error", `Hermes said it created ${name} in ${to}, but reading it back failed: ${skillsError(e, "read", name).message}`);
    }
    if (!after) throw new SkillsError("error", `Hermes said it created ${name} in ${to}, but ${to} doesn't list it when read back.`);
    if (asReadBack(after.content) !== sent) throw new SkillsError("error", `Hermes created ${name} in ${to}, but its SKILL.md reads back differently from what was sent.`);
    return after;
  }

  /**
   * Archives `name` in `profile` (Hermes moves its folder to `skills/.archive/`), then reads the list back. Resolves to
   * the list as read back when `name` is gone from it. Rejects with a SkillsError when Hermes refused, or when the
   * skill is still listed.
   */
  async archive(profile: string, name: string): Promise<SkillsView> {
    // Hermes takes an id starting `memory:` for a memory entry.
    if (!safeSkillName(name) || name.startsWith("memory:")) throw new SkillsError("identity", `"${name}" isn't a skill name Hermes Chat sends to Hermes.`, undefined, true);
    if (name.includes("/"))
      throw new SkillsError("refused", `${name} is listed by its folder path because another skill declares the same name, and Hermes archives a skill by that name, so it can't be archived from here.`, undefined, true);
    let lost: SkillsError | undefined;
    try {
      await deadline(this.rest("DELETE", `api/learning/node?${new URLSearchParams({ profile })}`, { id: name }), this.timeouts.writeMs, "archiving it");
    } catch (e) {
      const err = skillsError(e, "archive", name);
      if (certainlyUnwritten(err)) throw err;
      lost = err;
    }
    let view: SkillsView;
    try {
      view = await this.list(profile);
    } catch (e) {
      throw new SkillsError(
        "error",
        lost
          ? `Couldn't tell whether ${name} was archived: ${lost.message} Reading the list back also failed.`
          : `Hermes archived ${name}, but reading the list back failed: ${skillsError(e, "list").message}`,
        lost?.status,
      );
    }
    if (view.skills.some((s) => s.name === name))
      throw new SkillsError("error", lost ? `Hermes didn't answer (${lost.message}), and ${name} is still listed.` : `Hermes answered, but ${name} is still listed in ${profile}.`, lost?.status);
    return view;
  }

  /** What saves from here replaced in `profile`'s file at `path`, most recent first. Kept for this sign-in only. */
  versionsOf(profile: string, path: string): readonly SkillVersion[] {
    return this.versions.get(`${profile}\n${path}`) ?? [];
  }

  private keep(profile: string, previous: SkillFile) {
    const key = `${profile}\n${previous.path}`;
    const list = this.versions.get(key) ?? [];
    if (list[0]?.content === previous.content) return;
    this.versions.set(key, [{ content: previous.content, replacedAt: this.now() }, ...list].slice(0, KEEP_VERSIONS));
  }

  private kept(profile: string, r: SkillSaveResult): SkillSaveResult {
    if (r.kind === "saved" || r.kind === "changed") this.keep(profile, r.previous);
    return r;
  }
}
