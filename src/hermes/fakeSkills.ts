// A fake Hermes's skills, for tests of Settings → Skills: `GET /api/skills`, `PUT /api/skills/toggle` and
// `GET`/`PUT /api/skills/content` as the deployed `bf0203a` answers them (`hermes_cli/web_routers/skills.py`,
// `tools/skill_manager_tool.py`), and `POST /api/skills` and the skill archive behind `DELETE /api/learning/node` as
// `f0d94882` answers them (`_create_skill`, `skill_usage.archive_skill`). Each SKILL.md and its supporting files are nodes on the fake server's disk
// (`FakeServerFiles`), so the Server files listing sees the same folders.
import type { FakeServerFiles } from "./fakeServerFiles";
import type { RestRequest } from "./fakeHermes";
import { skillSlug } from "./skillCommands";
import { RestError } from "./pipe";

/** One skill folder: where it is on the server and what `provenance` Hermes gives it. */
export type FakeSkill = { dir: string; source: "hub" | "bundled" | "external" | "agent"; category?: string };

const answered = (status: number, detail: string) => new RestError(status, JSON.stringify({ detail }));

/** The front matter fields Hermes's YAML parse would find, read only as far as these tests need. */
function frontmatter(content: string): Record<string, string> | undefined {
  const c = content.replace(/^﻿/, "");
  if (!c.startsWith("---")) return undefined;
  const end = /\n---\s*\n/.exec(c.slice(3));
  if (!end) return undefined;
  const out: Record<string, string> = {};
  for (const line of c.slice(3, 3 + end.index).split("\n")) {
    const m = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

export class FakeSkills {
  /** False: the server is older than the skills routes, and answers them as `bf0203a` answers a path it hasn't. */
  routes = true;
  /** Each profile's skill folders; a profile left out has none. */
  folders: Record<string, FakeSkill[]> = {};
  /** Each profile's `skills.disabled`. */
  disabled: Record<string, Set<string>> = {};
  /** Each profile's `skills.platform_disabled`, as config.yaml holds it. */
  platformDisabled: Record<string, Record<string, unknown>> = {};
  /** While set, `PUT …/content` refuses with this status and reason and writes nothing (a scan block, a full disk). */
  writeRefusal?: { status: number; detail: string };
  /** While set, `PUT …/content` writes the file, then fails this way, as a connection lost before the answer. */
  writeLost?: string;
  /** While set, `PUT …/toggle` saves, then fails this way. */
  toggleLost?: string;
  /** Runs as a `PUT …/content` arrives, before it writes: another client's write in the middle of a Save. */
  beforeWrite?: () => void;
  /** Runs after a `PUT …/content` wrote: another client writing again before the read-back. */
  afterWrite?: () => void;
  /** While set, `GET …/content` waits for it before it answers: a read held up on the way. */
  readGate?: Promise<void>;
  /** Profiles `GET /api/config` and the skill routes know, besides `default`. */
  profiles = new Set<string>(["default"]);
  /** False: the server is older than `POST /api/skills` (`bf0203a` has no create route). */
  createRoute = true;
  /** While set, `POST /api/skills` creates the skill, then fails this way, as a connection lost before the answer. */
  createLost?: string;
  /** Skills Hermes refuses to archive because they're pinned (`hermes curator pin`), by profile. */
  pinned: Record<string, Set<string>> = {};
  /** Each profile's archived skill folders (`skills/.archive/`), most recent last. */
  archived: Record<string, FakeSkill[]> = {};

  constructor(private disk: FakeServerFiles) {}

  /** Puts a skill on the server: its SKILL.md, and any supporting files by path inside its folder. */
  add(profile: string, skill: FakeSkill, content: string, files: Record<string, string> = {}) {
    this.profiles.add(profile);
    (this.folders[profile] ??= []).push(skill);
    this.disk.nodes[`${skill.dir}/SKILL.md`] = { text: content };
    for (const [rel, text] of Object.entries(files)) this.disk.nodes[`${skill.dir}/${rel}`] = { text };
  }

  /** SKILL.md of the skill in `dir`, as the file holds it now. */
  file(dir: string): string {
    const node = this.disk.nodes[`${dir}/SKILL.md`];
    return node && "text" in node ? node.text : "";
  }

  /** Another client writing SKILL.md directly. */
  write(dir: string, content: string) {
    this.disk.nodes[`${dir}/SKILL.md`] = { text: content };
  }

  /** `skills.platform_disabled` for `GET /api/config`. */
  config(profile: string) {
    return { platform_disabled: this.platformDisabled[profile] ?? {} };
  }

  /**
   * The skills `commands.catalog` lists for a profile as Hermes scans them for commands (`scan_skill_commands`): by front
   * matter name, leaving out one in `skills.disabled`, the later of two whose slug is the same, and any skill whose
   * name two skills share. The per-platform lists aren't applied: the dashboard's own process names no platform.
   */
  commandSkills(profile: string): { slug: string; name: string; description: string; body: string }[] {
    const skills = this.folders[profile] ?? [];
    const names = skills.map((s) => this.nameOf(s));
    const out: { slug: string; name: string; description: string; body: string }[] = [];
    skills.forEach((s, i) => {
      const name = names[i];
      const slug = skillSlug(name);
      if (names.filter((n) => n === name).length > 1 || this.disabled[profile]?.has(name) || !slug || out.some((o) => o.slug === slug)) return;
      const text = this.file(s.dir);
      out.push({ slug, name, description: frontmatter(text)?.description || `Invoke the ${name} skill`, body: text.replace(/^---[\s\S]*?\n---\s*\n/, "").trim() });
    });
    return out;
  }

  private nameOf(s: FakeSkill) {
    return frontmatter(this.file(s.dir))?.name || s.dir.slice(s.dir.lastIndexOf("/") + 1);
  }

  private scope(profile: string | null): FakeSkill[] {
    const p = profile || "default";
    if (!this.profiles.has(p)) throw answered(404, `Profile '${p}' does not exist.`);
    return this.folders[p] ?? [];
  }

  /** `_find_skill`: the directory name first, then the front matter name, refusing a name two skills claim. */
  private find(profile: string | null, name: string): FakeSkill | undefined {
    const skills = this.scope(profile);
    const byDir = skills.find((s) => s.dir.endsWith(`/${name}`) && (!name.includes("/") || s.dir.includes(`/skills/${name}`)));
    if (byDir) return byDir;
    const byName = skills.filter((s) => frontmatter(this.file(s.dir))?.name === name);
    return byName.length === 1 ? byName[0] : undefined;
  }

  /** A profile's own skills folder on the fake server. */
  static home(profile: string) {
    return profile === "default" ? "/home/liam/.hermes/skills" : `/home/liam/.hermes/profiles/${profile}/skills`;
  }

  /** `archive_skill` behind `DELETE /api/learning/node`: refuses what Hermes refuses, else moves the folder aside. */
  archive(profile: string, name: string): { ok: boolean; message: string } {
    // `_find_skill_dir`: by front matter name only, never a folder path.
    const found = (this.folders[profile] ?? []).find((s) => frontmatter(this.file(s.dir))?.name === name);
    if (!found) return { ok: false, message: `skill '${name}' not found` };
    if (this.pinned[profile]?.has(name)) return { ok: false, message: `'${name}' is pinned — unpin it first (hermes curator unpin ${name})` };
    if (found.source === "hub") return { ok: false, message: `skill '${name}' is hub-installed; never archive` };
    if (found.source === "bundled") return { ok: false, message: `skill '${name}' is a bundled built-in; enable curator.prune_builtins to allow pruning it` };
    if (found.source === "external") return { ok: false, message: `skill '${name}' lives in skills.external_dirs; external skills are read-only to the curator` };
    this.folders[profile] = (this.folders[profile] ?? []).filter((s) => s !== found);
    (this.archived[profile] ??= []).push(found);
    for (const path of Object.keys(this.disk.nodes)) if (path.startsWith(`${found.dir}/`)) delete this.disk.nodes[path];
    return { ok: true, message: `archived '${name}' — restore with: hermes curator restore ${name}` };
  }

  /** Answers one request under `/api/skills`, or undefined for a path these routes don't have. */
  route(req: RestRequest): (() => unknown) | undefined {
    if (!req.path.startsWith("/api/skills")) return undefined;
    if (!this.routes) return () => Promise.reject(answered(404, `No such API endpoint: ${req.path}`));
    const profile = req.query.get("profile");
    const at = `${req.method} ${req.path}`;
    if (at === "GET /api/skills")
      return () => {
        const skills = this.scope(profile);
        const names = skills.map((s) => this.nameOf(s));
        return skills.map((s, i) => {
          const fm = frontmatter(this.file(s.dir)) ?? {};
          // `find_all_skills`: a name two skills in one tier share is listed by each one's path in its skills folder.
          const name = names.filter((n) => n === names[i]).length > 1 ? s.dir.slice(s.dir.indexOf("/skills/") + 8) : names[i];
          return { name, description: fm.description ?? "", category: s.category ?? null, enabled: !this.disabled[profile || "default"]?.has(name), usage: 0, provenance: s.source };
        });
      };
    if (at === "PUT /api/skills/toggle")
      return () => {
        this.scope(profile);
        const { name, enabled } = req.body as { name: string; enabled: boolean };
        const set = (this.disabled[profile || "default"] ??= new Set());
        if (enabled) set.delete(name);
        else if (name !== "hermes-agent") set.add(name);
        if (this.toggleLost) throw new Error(this.toggleLost);
        return { ok: true, name, enabled };
      };
    if (at === "GET /api/skills/content")
      return async () => {
        await this.readGate;
        const name = req.query.get("name") ?? "";
        const found = this.find(profile, name);
        if (!found) throw answered(404, `Skill '${name}' not found.`);
        return { name, content: this.file(found.dir).replace(/^﻿/, "").replace(/\r\n?/g, "\n"), path: `${found.dir}/SKILL.md` };
      };
    if (at === "PUT /api/skills/content")
      return () => {
        const { name, content } = req.body as { name: string; content: string };
        // `_validate_frontmatter`, worded as Hermes words it.
        const fm = frontmatter(content);
        if (!content.trim()) throw answered(400, "Content cannot be empty.");
        if (!content.replace(/^﻿/, "").startsWith("---")) throw answered(400, "SKILL.md must start with YAML frontmatter (---). See existing skills for format.");
        if (!fm) throw answered(400, "SKILL.md frontmatter is not closed. Ensure you have a closing '---' line.");
        for (const f of ["name", "description"]) if (!(f in fm)) throw answered(400, `Frontmatter must include '${f}' field.`);
        const found = this.find(profile, name);
        if (!found) throw answered(404, `Skill '${name}' not found in active profile '${profile || "default"}'.`);
        this.beforeWrite?.();
        if (this.writeRefusal) throw answered(this.writeRefusal.status, this.writeRefusal.detail);
        this.write(found.dir, content);
        this.afterWrite?.();
        if (this.writeLost) throw new Error(this.writeLost);
        return { success: true, message: `Skill '${name}' updated (full rewrite).`, path: found.dir };
      };
    if (at === "POST /api/skills" && this.createRoute)
      return () => {
        const p = profile || "default";
        this.scope(profile);
        const { name, content, category } = req.body as { name: string; content: string; category?: string };
        const valid = /^[a-z0-9][a-z0-9._-]*$/;
        if (!name || name.length > 64 || !valid.test(name))
          throw answered(400, `Invalid skill name '${name}'. Use lowercase letters, numbers, hyphens, dots, and underscores. Must start with a letter or digit.`);
        if (category !== undefined && (!valid.test(category) || category.length > 64)) throw answered(400, `Invalid category '${category}'.`);
        const fm = frontmatter(content);
        if (!fm) throw answered(400, "SKILL.md must start with YAML frontmatter (---). See existing skills for format.");
        for (const f of ["name", "description"]) if (!(f in fm)) throw answered(400, `Frontmatter must include '${f}' field.`);
        const existing = this.find(profile, name);
        if (existing) throw answered(400, `A skill named '${name}' already exists at ${existing.dir}.`);
        const dir = `${FakeSkills.home(p)}${category ? `/${category}` : ""}/${name}`;
        this.add(p, { dir, source: "agent", category }, content);
        if (this.createLost) throw new Error(this.createLost);
        return { success: true, message: `Skill '${name}' created.`, path: `${category ? `${category}/` : ""}${name}`, skill_md: `${dir}/SKILL.md` };
      };
    return () => Promise.reject(answered(405, "Method Not Allowed"));
  }
}
