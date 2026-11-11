// Skills run from the composer (GLOSSARY.md "Skill", ADR 0015). A message runs a skill the way Hermes's own clients run
// one, read in Hermes's source at the deployed `f0d9488` (the same at `bf0203a`):
// - `commands.catalog {profile}` lists the skills Hermes would run as `/name` (`command_discovery._catalog_skills`):
//   `skills` is `{"/slug": {usage, origin}}`, and `pairs` holds `["/slug", description]`. A slug is the skill's front
//   matter name made a command (`skill_commands.slugify_skill_name`). Hermes leaves out a skill in `skills.disabled`,
//   one whose slug a built-in command has, and one whose name two skills share.
// - `command.dispatch {name, arg, session_id}` runs a quick command, a plugin command or a skill bundle before a skill
//   of the same name (`methods_tools.py`). For a skill it answers `{type: "skill", message, name, display}`: `message`
//   is the skill's whole SKILL.md wrapped in Hermes's own instructions, for the model; `display` is the invocation a
//   client shows instead (`/debugging fix the build`). Leading `/skill` words of `arg` load those skills too, up to five
//   in all (`split_stacked_skill_commands`). The client then sends `message` as the chat's next turn, and Hermes's
//   history shows that turn as `display` (`session_history._skill_scaffold_projection`).
// - `$skill` is this app's own way to name a skill anywhere in a message. Hermes has no `$` form: the message goes out as
//   the same `command.dispatch` a leading `/skill` would make, with every skill named stacked in front of the words.
import { COMMANDS, type Rpc } from "./commands";
import type { SkillsView } from "./skills";
import { isObj } from "./values";

/** A skill the composer offers: its command name (`key`, no slash), the name it declares, and what it's for. */
export type SkillCommand = { key: string; name: string; description: string };

/**
 * The skills this composer can run. `offered`: the ones on for the profile and for this app's chats, by key. `listed`:
 * every key Hermes's catalog has, on or off here, so text that would make Hermes load one that's off can be refused.
 */
export type SkillCommands = { offered: readonly SkillCommand[]; listed: ReadonlySet<string> };

/** What `command.dispatch` is asked: the first skill's key, and the rest of the line as Hermes would split it. */
export type SkillCall = { name: string; arg: string };

/**
 * A message that runs skills: `keys` in the order Hermes loads them, the owner's own words (`instruction`), and the
 * call that runs them. `problem`: why it can't go as typed, which the composer says instead of sending.
 */
export type SkillRun = { keys: string[]; instruction: string; call: SkillCall; problem?: string };

/** Hermes loads at most this many skills for one message (`skill_commands._MAX_STACKED_SKILLS`). */
export const MAX_SKILLS = 5;

/** This app's command names, which win over a skill's at the start of a message. Read when used: the modules import each other. */
const isCommandName = (name: string) => COMMANDS.some((c) => c.name === name);

/**
 * A skill name as Hermes makes it a command (`slugify_skill_name`): lower case, spaces and `_` as `-`, then only word
 * characters and `-` kept, runs of `-` made one, and none at either end.
 */
export function skillSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/ /g, "-")
    .replace(/_/g, "-")
    .replace(/[^\p{L}\p{N}_-]/gu, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The skills a `commands.catalog` answer lists, key to description, less any key a quick or plugin command also takes
 * (`taken`, `/name` lower-cased), which `command.dispatch` would run instead. Undefined when Hermes listed no skills
 * field (it can't run them this way) or couldn't tell (`failed`: a discovery of skills, quick or plugin commands
 * failed, so a quick command by the same name can't be ruled out).
 */
export function catalogSkills(res: Record<string, unknown>, taken: ReadonlySet<string>, failed: boolean): Map<string, string> | undefined {
  if (failed || !isObj(res.skills)) return undefined;
  const described = new Map<string, string>();
  for (const p of Array.isArray(res.pairs) ? res.pairs : [])
    if (Array.isArray(p) && typeof p[0] === "string" && typeof p[1] === "string" && !described.has(p[0])) described.set(p[0], p[1]);
  const out = new Map<string, string>();
  for (const k of Object.keys(res.skills)) {
    const key = k.replace(/^\//, "").toLowerCase();
    if (!key || /\s/.test(key) || taken.has(`/${key}`)) continue;
    out.set(key, described.get(k) ?? "");
  }
  return out;
}

/**
 * The catalog's skills that Settings → Skills shows as on for the profile and not kept off for this app's chats
 * (`tui`, `desktop`), sorted by key. A catalog key no listed skill makes, such as a plugin's skill, isn't offered: the
 * app can't tell whether it's on. Neither is a key two listed skills make when either is off. Undefined when the
 * per-platform lists couldn't be read, since which skills they keep off isn't known.
 */
export function offeredSkills(catalog: ReadonlyMap<string, string>, view: SkillsView): SkillCommands | undefined {
  if (!view.platformsRead) return undefined;
  const bySlug = new Map<string, SkillsView["skills"]>();
  for (const s of view.skills) {
    const slug = skillSlug(s.name);
    if (slug) bySlug.set(slug, [...(bySlug.get(slug) ?? []), s]);
  }
  const offered: SkillCommand[] = [];
  for (const [key, description] of catalog) {
    const rows = bySlug.get(key);
    if (!rows?.length || rows.some((r) => !r.enabled || view.offFor[r.name]?.length)) continue;
    offered.push({ key, name: rows[0].name, description: description || rows[0].description });
  }
  offered.sort((a, b) => a.key.localeCompare(b.key));
  return { offered, listed: new Set(catalog.keys()) };
}

/**
 * The `$` menu's query while a skill's name is typed anywhere in a message: `before` is the text before the caret, which
 * must end in `$` and the name's start, the `$` at the start or after a space. `start`: where the `$` is.
 */
export function dollarQuery(before: string): { query: string; start: number } | undefined {
  const m = /(?:^|\s)\$([\p{L}\p{N}_-]*)$/u.exec(before);
  return m ? { query: m[1].toLowerCase(), start: before.length - m[1].length - 1 } : undefined;
}

/**
 * The skills for a query, ranked as the command menu ranks commands (`matchCommands`): keys starting with it first,
 * then keys containing it or descriptions with a word starting with it, each in the order given.
 */
export function matchSkills(query: string, skills: readonly SkillCommand[]): SkillCommand[] {
  const q = query.toLowerCase();
  const starts = skills.filter((s) => s.key.startsWith(q));
  const words = (s: SkillCommand) => s.description.toLowerCase().split(/\W+/);
  return [...starts, ...skills.filter((s) => !starts.includes(s) && (s.key.includes(q) || words(s).some((w) => w.startsWith(q))))];
}

/** Code in backticks, blanked out the same length, so a `$name` in a code span or block isn't a skill. */
const withoutCode = (text: string) => text.replace(/```[\s\S]*?(?:```|$)|`[^`\n]*`/g, (m) => " ".repeat(m.length));

/** `$name` words: a `$` at the start or after a space, then the name, then a space, the end, or punctuation. */
const DOLLAR_REF = /(?<=^|\s)\$([\p{L}\p{N}_-]+)(?=$|[\s.,;:!?)\]}'"])/gu;

/**
 * Whether `text`, as it would be sent, runs skills, and how. A leading `/name` runs the skill with that key, unless a
 * command of this app has the name (the command wins; `$name` still reaches the skill). Leading `/name` words after it
 * stack as Hermes stacks them. Each `$name` of an offered skill anywhere else adds that skill, once. Any other text is
 * an ordinary message (undefined), `$` words that name no offered skill included.
 */
export function skillRun(text: string, skills: SkillCommands): SkillRun | undefined {
  const offered = new Set(skills.offered.map((s) => s.key));
  // Hermes reads a stacked word as an exact key, or with `_` as `-` (`resolve_slash_key`).
  const resolve = (word: string) => {
    const w = word.toLowerCase();
    return skills.listed.has(w) ? w : skills.listed.has(w.replace(/_/g, "-")) ? w.replace(/_/g, "-") : undefined;
  };
  const keys: string[] = [];
  let instruction = text;
  let problem: string | undefined;
  const lead = /^\/(\S+)([\s\S]*)$/.exec(text);
  const first = lead?.[1].toLowerCase();
  if (lead && first && offered.has(first) && !isCommandName(first)) {
    keys.push(first);
    instruction = lead[2].trim();
  }
  // The words Hermes would take as more skills after a leading one: the argument's leading `/name`s, up to four, until
  // one names no skill or repeats one (`split_stacked_skill_commands`). Hermes loads a repeat of the first only once.
  const extras: string[] = [];
  while (keys.length && extras.length < MAX_SKILLS - 1) {
    const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(instruction);
    const key = m && resolve(m[1]);
    if (!m || !key || extras.includes(key)) break;
    if (!offered.has(key)) {
      problem = `Hermes would load the ${key} skill for /${m[1]}, and it's off for this app's chats. Reword the start of the message.`;
      break;
    }
    extras.push(key);
    if (!keys.includes(key)) keys.push(key);
    instruction = (m[2] ?? "").trim();
  }
  // A `$` word must be the key as the menu puts it in, lower case, so `$HOME` or `$PATH` stays a shell variable.
  const named = [...withoutCode(instruction).matchAll(DOLLAR_REF)].map((m) => m[1]).filter((k) => offered.has(k));
  for (const k of named) if (!keys.includes(k)) keys.push(k);
  if (!keys.length) return undefined;
  // With no leading skill, the words go to Hermes after the stacked names: a leading `/name` of a skill would load it too.
  if (!lead || keys[0] !== first) {
    const m = /^\/(\S+)/.exec(instruction);
    const key = m && resolve(m[1]);
    if (key && !problem) problem = `Hermes would load the ${key} skill too, for the /${m[1]} the message starts with. Start it with other words.`;
  }
  if (keys.length > MAX_SKILLS) problem = `Hermes loads at most ${MAX_SKILLS} skills for one message, and this one names ${keys.length}.`;
  const call = { name: keys[0], arg: [...keys.slice(1).map((k) => `/${k}`), instruction].filter(Boolean).join(" ") };
  return { keys, instruction, call, ...(problem && { problem }) };
}

/** The invocation Hermes shows for a skill call, before it answers: `/name` and the rest, spaces made single. */
export const callText = (call: SkillCall) => [`/${call.name}`, ...call.arg.split(/\s+/).filter(Boolean)].join(" ");

// Hermes's markers around a skill's text (`skill_commands.py`), byte for byte.
const INVOKED = "[IMPORTANT: The user has invoked the ";
const SINGLE = "The full skill content is loaded below.]";
const SINGLE_INSTRUCTION = "The user has provided the following instruction alongside the skill invocation: ";
const RUNTIME_NOTE = "\n\n[Runtime note:";
const BUNDLE = " skill bundle,";
const BUNDLE_INSTRUCTION = "\nUser instruction: ";
const BUNDLE_FIRST = "\n\n[Loaded as part of the ";
const EXCERPT_JOINT = "\x1e";

/**
 * What Hermes shows for a stored message that ran a skill (`describe_skill_invocation` with a space between): `/name`
 * or `/a /b`, then the owner's words, spaces made single. Undefined for any other text.
 */
export function skillInvocationText(content: string): string | undefined {
  if (!content.startsWith(INVOKED)) return undefined;
  const name = (/^"([^"]*)"/.exec(content.slice(INVOKED.length))?.[1] ?? "").trim();
  const label = name.startsWith("/") ? name : `/${name}`;
  const cut = (marker: string, stop: string, last: boolean) => {
    const at = last ? content.lastIndexOf(marker) : content.indexOf(marker);
    return at < 0 ? undefined : content.slice(at + marker.length).split(stop)[0].trim();
  };
  const instruction = content.includes(BUNDLE)
    ? cut(BUNDLE_INSTRUCTION, BUNDLE_FIRST, false)
    : content.includes(SINGLE)
      ? cut(SINGLE_INSTRUCTION, RUNTIME_NOTE, true)
      : undefined;
  const words = (instruction ?? "").split(EXCERPT_JOINT)[0].split(/\s+/).filter(Boolean).join(" ");
  if (words) return name ? `${label} ${words}` : words;
  return name ? label : undefined;
}

const NOT_DISPATCHED = 4018;

/**
 * Has Hermes build the message that runs `call` in the live session `sessionId`: the skill text to send as the chat's
 * next turn (`message`), and what the chat shows for it (`display`). Rejects, having sent nothing, when Hermes answers
 * anything but a skill, as a bundle or quick command of the same name would.
 */
export async function runSkill(rpc: Rpc, sessionId: string, call: SkillCall): Promise<{ message: string; display: string }> {
  let res: unknown;
  try {
    res = await rpc("command.dispatch", { name: call.name, arg: call.arg, session_id: sessionId });
  } catch (e) {
    if (isObj(e) && e.code === NOT_DISPATCHED)
      throw new Error(`Hermes has no ${call.name} skill to run for this chat now. It may have been turned off or removed.`);
    throw e;
  }
  if (!isObj(res) || res.type !== "skill" || typeof res.message !== "string" || !res.message.trim())
    throw new Error(`Hermes answered the ${call.name} skill in a way this app doesn't handle, so nothing was sent.`);
  const display = typeof res.display === "string" && res.display.trim() ? res.display.trim() : (skillInvocationText(res.message) ?? callText(call));
  return { message: res.message, display };
}
