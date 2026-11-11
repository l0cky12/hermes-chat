import { isObj } from "./values";
// Templates (GLOSSARY.md "Template", ADR 0028): messages the owner reuses, with blanks filled in each time. They are
// data, kept in this computer's UI prefs (uiPrefs.ts `templates`), and reach Hermes only as text the owner sends from
// the composer. Nothing here is evaluated: a placeholder is replaced by the value typed for it, verbatim, once.
//
// The placeholder format:
//   {name}           required: Insert waits until it has a value
//   {name?}          optional: left blank, it becomes nothing
//   {name=default}   optional: left blank, it becomes `default` (one line, no `}`)
//   {name...}        multiline input; combines with the others: {name...?}, {name...=default}
//   \{               a literal `{`, so `\{name}` stays `{name}`
// A name starts with a letter or `_`, then letters, digits, `_` or `-`; any Unicode letter counts. Any other brace is
// literal text, so JSON, `{{ jinja }}`, `{{host}}`, `${{ ci }}` and `{a,b}` need no escaping: a blank touching another
// brace (`{{x}}`) is literal too. `${VAR}` and f-string `{x}` do need it.

export type Template = {
  id: string;
  name: string;
  description: string;
  body: string;
  /** Shown only with this project: a project of one connection and profile (projectLinks.ts `projectScope`). */
  project?: { scope: string; id: string; name: string };
};

export const NAME_MAX = 80;
export const DESCRIPTION_MAX = 300;
export const BODY_MAX = 20_000;
/** The most templates kept: they live in localStorage with the other prefs, which a browser caps at a few MB. */
export const TEMPLATES_MAX = 300;

// A blank right inside another brace pair (`{{host}}`, `${{ci}}`) is someone else's syntax, left as written.
const TOKEN = /\\\{|(?<!\{)\{([\p{L}_][\p{L}\p{N}_-]*)(\.\.\.)?(?:(\?)|=([^}\n]*))?\}(?!\})/gu;

export type Field = { name: string; required: boolean; default?: string; multiline: boolean };

/** The blanks in `body`, in order of first use. A name used twice is one blank, filled in both places. */
export function fieldsOf(body: string): Field[] {
  const fields = new Map<string, Field>();
  for (const m of body.matchAll(TOKEN)) {
    const [, name, dots, optional, def] = m;
    if (!name) continue;
    const f = fields.get(name) ?? { name, required: true, multiline: false };
    if (optional || def !== undefined) f.required = false;
    if (def !== undefined && f.default === undefined) f.default = def;
    if (dots) f.multiline = true;
    fields.set(name, f);
  }
  // Optional anywhere makes it optional everywhere: one blank, one answer.
  return [...fields.values()];
}

/** A run of the rendered message: literal text, a value filled in, or a required blank still empty. */
export type Segment = { text: string; field?: string; missing?: boolean };

const blank = (v: string | undefined) => !v || !v.trim();
/** The value typed for `name`: own properties only, so a blank called `constructor` or `__proto__` is just a name. */
export const valueOf = (values: Record<string, string>, name: string): string | undefined => (Object.hasOwn(values, name) ? values[name] : undefined);

/** `body` with `values` filled in. `missing`: required blanks with no value; their `{name}` stays in the text. */
export function render(body: string, values: Record<string, string>): { text: string; segments: Segment[]; missing: string[] } {
  const fields = new Map(fieldsOf(body).map((f) => [f.name, f]));
  const segments: Segment[] = [];
  const missing = new Set<string>();
  let at = 0;
  const literal = (text: string) => {
    if (!text) return;
    const last = segments[segments.length - 1];
    if (last && last.field === undefined) last.text += text;
    else segments.push({ text });
  };
  for (const m of body.matchAll(TOKEN)) {
    literal(body.slice(at, m.index));
    at = m.index + m[0].length;
    const name = m[1];
    if (!name) {
      literal("{");
      continue;
    }
    const f = fields.get(name)!;
    const v = valueOf(values, name);
    if (v !== undefined && !blank(v)) segments.push({ text: v, field: name });
    else if (f.default !== undefined && f.default !== "") segments.push({ text: f.default, field: name });
    else if (f.required) {
      missing.add(name);
      segments.push({ text: `{${name}}`, field: name, missing: true });
    }
  }
  literal(body.slice(at));
  return { text: segments.map((s) => s.text).join(""), segments, missing: [...missing] };
}

/** The draft after inserting `text`: in place of it, or after it with a blank line between. */
export const insertInto = (draft: string, text: string, how: "replace" | "append") =>
  how === "replace" || !draft.trim() ? text : `${draft.trimEnd()}\n\n${text}`;

const sameName = (a: string, b: string) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

/** What is wrong with a template the owner is saving, if anything. `others`: every other template kept. */
export function problemOf(t: Pick<Template, "name" | "description" | "body">, others: readonly Template[]): string | undefined {
  const name = t.name.trim();
  if (!name) return "Give the template a name.";
  if (name.length > NAME_MAX) return `Keep the name under ${NAME_MAX} characters.`;
  if (others.some((o) => sameName(o.name, name))) return `There's already a template called “${name}”. Pick another name.`;
  if (t.description.length > DESCRIPTION_MAX) return `Keep the description under ${DESCRIPTION_MAX} characters.`;
  if (!t.body.trim()) return "Write the message the template inserts.";
  if (t.body.length > BODY_MAX) return `Keep the message under ${BODY_MAX.toLocaleString("en")} characters; it's ${t.body.length.toLocaleString("en")}.`;
  return undefined;
}

/** `name`, or `name (2)`, `name (3)`… whichever no template in `taken` has. */
export function freeName(name: string, taken: readonly { name: string }[]): string {
  const base = name.trim().slice(0, NAME_MAX - 6);
  if (!taken.some((t) => sameName(t.name, name))) return name.trim();
  for (let n = 2; ; n++) if (!taken.some((t) => sameName(t.name, `${base} (${n})`))) return `${base} (${n})`;
}

/** One kept template, checked; undefined if it isn't one. */
function toTemplate(v: unknown): Template | undefined {
  if (!isObj(v)) return undefined;
  const { id, name, description, body, project } = v;
  if (typeof id !== "string" || !id || id.length > 100) return undefined;
  if (typeof name !== "string" || !name.trim() || name.length > NAME_MAX) return undefined;
  if (typeof body !== "string" || !body.trim() || body.length > BODY_MAX) return undefined;
  const desc = typeof description === "string" && description.length <= DESCRIPTION_MAX ? description : "";
  const p =
    isObj(project) && typeof project.scope === "string" && typeof project.id === "string" && typeof project.name === "string" && project.id
      ? { scope: project.scope, id: project.id, name: project.name }
      : undefined;
  return { id, name: name.trim(), description: desc, body, ...(p && { project: p }) };
}

/** The templates kept in the prefs, checked: one per id and name, at most TEMPLATES_MAX. Not a list: undefined. */
export function toTemplates(v: unknown): Template[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: Template[] = [];
  for (const raw of v) {
    const t = toTemplate(raw);
    if (t && out.length < TEMPLATES_MAX && !out.some((o) => o.id === t.id || sameName(o.name, t.name))) out.push(t);
  }
  return out;
}

/** Templates offered with project `here` (ids in `scope`): every unscoped one, and those scoped to one of `here`. */
export const offeredHere = (t: Template, scope: string, here: readonly string[]) => !t.project || (t.project.scope === scope && here.includes(t.project.id));

/** Templates no longer tied to a project this app deleted: they're kept, shown everywhere. */
export const unscope = (list: readonly Template[], scope: string, projectId: string): Template[] =>
  list.map((t) => (t.project?.scope === scope && t.project.id === projectId ? (({ project: _, ...rest }) => rest)(t) : t));

/** The export file's format and version. Bump the version when a field changes meaning. */
export const EXPORT_FORMAT = "hermes-chat-templates";
export const EXPORT_VERSION = 1;

/**
 * An export file. A project is left out: its id means something only on one connection and profile. Nothing else
 * the app knows goes in, so no sign-in or address does.
 */
export function exportFile(list: readonly Template[]): string {
  const templates = list.map(({ name, description, body }) => ({ name, description, body }));
  return JSON.stringify({ format: EXPORT_FORMAT, version: EXPORT_VERSION, templates }, null, 2) + "\n";
}

/** The largest file Import reads. */
export const IMPORT_MAX_BYTES = 2 * 1024 * 1024;

export type Imported = { added: Template[]; skipped: number; renamed: { from: string; to: string }[]; overLimit: number };

/**
 * The templates in an export file, as new templates beside `existing`: each gets a new id, a name already taken gets
 * ` (2)`, and an entry that isn't a valid template is skipped and counted. Throws, saying why, for a file that isn't
 * an export at all or comes from a newer version.
 */
export function readImport(text: string, existing: readonly Template[], newId: () => string = () => crypto.randomUUID()): Imported {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error("This file isn't a templates export: it isn't JSON.");
  }
  if (!isObj(doc) || doc.format !== EXPORT_FORMAT || !Array.isArray(doc.templates)) throw new Error("This file isn't a Hermes Chat templates export.");
  if (!Number.isSafeInteger(doc.version) || (doc.version as number) < 1) throw new Error("This templates export has no version this app can read.");
  if ((doc.version as number) > EXPORT_VERSION) throw new Error("A newer version of Hermes Chat made this export. Update this one to import it.");
  const out: Imported = { added: [], skipped: 0, renamed: [], overLimit: 0 };
  const taken: { name: string }[] = [...existing];
  for (const raw of doc.templates) {
    // Stored templates forgive a bad description; an import counts it as a bad entry instead of dropping it quietly.
    const badDescription = isObj(raw) && raw.description !== undefined && (typeof raw.description !== "string" || raw.description.length > DESCRIPTION_MAX);
    const t = isObj(raw) && !badDescription ? toTemplate({ ...raw, id: "x", project: undefined }) : undefined;
    if (!t) {
      out.skipped++;
      continue;
    }
    if (existing.length + out.added.length >= TEMPLATES_MAX) {
      out.overLimit++;
      continue;
    }
    const name = freeName(t.name, taken);
    if (name !== t.name) out.renamed.push({ from: t.name, to: name });
    const added = { ...t, id: newId(), name };
    taken.push(added);
    out.added.push(added);
  }
  return out;
}
