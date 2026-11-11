// Slash commands typed in the composer (GLOSSARY.md "Slash command", ADR 0015). A small explicit registry: actions this
// app already has, and Hermes commands whose behaviour was read in Hermes's source at the deployed `bf0203a`. Nothing
// typed is forwarded to Hermes as a command unless it is in this list; any other text starting with "/" is sent as an
// ordinary message.
import { catalogSkills } from "./skillCommands";
import { isObj } from "./values";

/**
 * `local`: an action of this app, which may write to Hermes through the same calls its buttons use. `server`: a command
 * Hermes runs for the chat's live session. `args`: the argument hint, `<required>` or `[optional]`. `destructive`: asks
 * first, as the chat list's Delete does.
 */
export type CommandDef = {
  name: string;
  args?: string;
  description: string;
  scope: "local" | "server";
  destructive?: boolean;
};

export const COMMANDS: readonly CommandDef[] = [
  { name: "help", description: "Show every command you can use here", scope: "local" },
  { name: "new", description: "Start a new chat", scope: "local" },
  { name: "rename", args: "<title>", description: "Rename this chat in every Hermes client", scope: "local" },
  { name: "delete", description: "Delete this chat in every Hermes client, after asking", scope: "local", destructive: true },
  // `command.dispatch` `_cmd_steer` (tui_gateway/methods_tools.py): queued for after the running reply's next tool call.
  { name: "steer", args: "<message>", description: "Tell the running reply something after its next tool call, without stopping it", scope: "server" },
  // `prompt.btw` (tui_gateway/methods_prompt.py at the deployed `f0d94882`), as Hermes's own clients send it, not
  // `command.dispatch`: it answers later, as a `btw.complete` event (ADR 0070).
  { name: "btw", args: "<question>", description: "Ask a side question about this chat without interrupting the reply or adding to the chat", scope: "server" },
  // `slash.exec` `/context`, answered from the live session (tui_gateway/methods_slash.py `_format_live_context_output`).
  { name: "context", description: "Show what fills this chat's context window, as Hermes counts it", scope: "server" },
];

/** `/steer`, which the composer also uses for a message sent into a running reply (ADR 0057). */
export const STEER: CommandDef = COMMANDS.find((c) => c.name === "steer")!;

/**
 * The command typed: a "/" as the very first character, then a name, then whitespace or the end. The argument is the
 * rest with its outer whitespace trimmed and its inside, new lines included, kept as typed. Undefined for any other
 * text, which is then an ordinary message: a name that isn't in the registry, or words after a command that takes
 * none, as in "/help me read this log".
 */
export function typedCommand(text: string): { def: CommandDef; arg: string } | undefined {
  const m = /^\/(\S+)([\s\S]*)$/.exec(text);
  const def = m && COMMANDS.find((c) => c.name === m[1].toLowerCase());
  const arg = m ? m[2].trim() : "";
  return def && (def.args || !arg) ? { def, arg } : undefined;
}

/** Why `arg` can't go with `def`, or undefined when it can. */
export function argProblem(def: CommandDef, arg: string): string | undefined {
  return def.args?.startsWith("<") && !arg ? `/${def.name} needs ${def.args}.` : undefined;
}

/**
 * The menu's query while the owner types the command's name: what follows the leading "/", up to the caret at the end.
 * Undefined once there is whitespace, so the menu is gone while an argument or a new line is typed.
 */
export function menuQuery(text: string): string | undefined {
  return /^\/\S*$/.test(text) ? text.slice(1).toLowerCase() : undefined;
}

/**
 * The commands for a query: names starting with it first, then names containing it or descriptions with a word starting
 * with it, each in registry order.
 */
export function matchCommands(query: string): CommandDef[] {
  const q = query.toLowerCase();
  const starts = COMMANDS.filter((c) => c.name.startsWith(q));
  const words = (c: CommandDef) => c.description.toLowerCase().split(/\W+/);
  return [...starts, ...COMMANDS.filter((c) => !starts.includes(c) && (c.name.includes(q) || words(c).some((w) => w.startsWith(q))))];
}

/** What the composer holds once a command is picked: its name, and a space for its argument if it takes one. */
export const completion = (def: CommandDef) => `/${def.name}${def.args ? " " : ""}`;

/** How a request to Hermes goes: a JSON-RPC call on `/api/ws`. */
export type Rpc = (method: string, params: Record<string, unknown>) => Promise<unknown>;

/** What a server command came back with: text to show, or a message Hermes wants sent as the chat's next turn. */
export type CommandResult = { kind: "output"; text: string } | { kind: "send"; message: string; notice?: string };

const NO_SUCH_METHOD = -32601;

/**
 * The registry's server commands Hermes lists (`listed`); those a quick or plugin command of the same name replaces
 * (`replaced`); and those that might be replaced by one Hermes couldn't list (`unsure`). `skills`: the skills Hermes
 * would run as commands, key to description (`skillCommands.catalogSkills`), undefined when it can't say.
 */
export type ServerCommandList = { listed: Set<string>; replaced: Set<string>; unsure: Set<string>; skills?: Map<string, string> };

/**
 * Commands that go through `command.dispatch`, which runs a quick command (any shell command) or a plugin command before
 * Hermes's own of the same name (`_dispatch_quick`, `_dispatch_plugin`). `slash.exec /context` is answered from the live
 * session before any of those (`_live_slash_command_output`), and `/btw` is a method of its own, so nothing can replace
 * either.
 */
const REPLACEABLE = new Set(["steer"]);

/**
 * The registry's server commands that this Hermes lists in `commands.catalog` for `profile`, the catalog the official
 * clients' menus are built from. A replaceable command whose name a quick or plugin command takes is `replaced`, and
 * `unsure` when Hermes's discovery of those failed: a failed skill discovery overwrites the warning a failed quick
 * command discovery left (`command_discovery.command_catalog`). Neither is run from here. Rejects saying why when Hermes
 * has no catalog.
 */
export async function listServerCommands(rpc: Rpc, profile: string): Promise<ServerCommandList> {
  const res = await rpc("commands.catalog", { profile }).catch((e) => {
    throw isObj(e) && e.code === NO_SUCH_METHOD ? new Error("This Hermes doesn't list its commands. Update Hermes to use them here; Settings → Diagnostics shows what it supports.") : e;
  });
  if (!isObj(res)) throw new Error("Hermes gave no list of its commands.");
  const failed =
    (typeof res.plugin_discovery_error === "string" && !!res.plugin_discovery_error) ||
    /(quick_commands|plugin command|skill) discovery unavailable/.test(String(res.warning ?? ""));
  // `canon`: every listed name and alias, lower-cased, to the command's own name. Quick commands are listed under
  // "User commands" and plugin commands in `plugin_commands`, by name without the slash.
  const canon = isObj(res.canon) ? res.canon : {};
  const taken = new Set<string>(Object.keys(isObj(res.plugin_commands) ? res.plugin_commands : {}).map((k) => `/${k.toLowerCase()}`));
  // Quick commands are listed under "User commands" and plugin commands under "Plugin commands".
  for (const c of Array.isArray(res.categories) ? res.categories : [])
    if (isObj(c) && (c.name === "User commands" || c.name === "Plugin commands") && Array.isArray(c.pairs))
      for (const p of c.pairs) if (Array.isArray(p) && typeof p[0] === "string") taken.add(p[0].toLowerCase());
  const server = COMMANDS.filter((c) => c.scope === "server").map((c) => c.name);
  const replaced = new Set(server.filter((n) => REPLACEABLE.has(n) && taken.has(`/${n}`)));
  const unsure = new Set(server.filter((n) => REPLACEABLE.has(n) && failed && !replaced.has(n)));
  const skills = catalogSkills(res, taken, failed);
  return {
    listed: new Set(server.filter((n) => canon[`/${n}`] === `/${n}` && !replaced.has(n) && !unsure.has(n))),
    replaced,
    unsure,
    ...(skills && { skills }),
  };
}

/**
 * Runs a server command on the chat's live session `sessionId`. `/steer` goes through `command.dispatch` with the
 * argument as its own field, so its words reach Hermes exactly as typed. `/context` goes through `slash.exec`, which
 * Hermes answers from the live session without starting its slash worker.
 */
export async function runServerCommand(rpc: Rpc, sessionId: string, def: CommandDef, arg: string): Promise<CommandResult> {
  const res =
    def.name === "steer"
      ? await rpc("command.dispatch", { name: def.name, arg, session_id: sessionId })
      : def.name === "context"
        ? await rpc("slash.exec", { command: `/${def.name}`, session_id: sessionId })
        : undefined;
  if (!isObj(res)) throw new Error(`Hermes gave no answer to /${def.name}.`);
  if (res.type === "send" && typeof res.message === "string")
    return { kind: "send", message: res.message, ...(typeof res.notice === "string" && { notice: res.notice }) };
  if ((res.type === undefined || res.type === "exec") && typeof res.output === "string") return { kind: "output", text: res.output };
  throw new Error(`Hermes answered /${def.name} in a way this app doesn't handle.`);
}

/**
 * Asks Hermes a side question about the chat's live session `sessionId` (`prompt.btw`). Resolves with the task id its
 * `btw.complete` answer will carry; rejects saying why Hermes didn't take it.
 */
export async function askSideQuestion(rpc: Rpc, sessionId: string, question: string): Promise<string> {
  const res = await rpc("prompt.btw", { session_id: sessionId, text: question }).catch((e) => {
    throw isObj(e) && e.code === NO_SUCH_METHOD ? new Error("This Hermes can't answer side questions here. Updating Hermes may add it.") : e;
  });
  if (!isObj(res) || typeof res.task_id !== "string" || !res.task_id) throw new Error("Hermes didn't say it took the question.");
  return res.task_id;
}

/**
 * What a `btw.complete` text says. Hermes sends a failure as the text `error: <why>` (`_spawn_side_agent`), with no
 * field of its own, so an answer that starts that way reads as a failure; its words show either way.
 */
export function sideAnswer(text: unknown): { answer: string } | { error: string } {
  const t = typeof text === "string" ? text.trim() : "";
  if (!t) return { error: "Hermes had no answer to it." };
  return t.startsWith("error: ") ? { error: t.slice("error: ".length) } : { answer: t };
}
