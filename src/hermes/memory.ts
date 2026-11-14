// Settings → Memory: the built-in memory Hermes keeps for the profile, read and edited one entry at a time on the
// server (GLOSSARY.md "Memory", ADR 0020). Hermes keeps two files in the profile's home, `memories/MEMORY.md` (its own
// notes) and `memories/USER.md` (what it knows about the owner), each a list of entries separated by a line holding only
// "§" (`tools/memory_tool.py`, `tools/memory_tool_store.py` at the deployed `bf0203a`).
//
// The only client calls Hermes has that change memory are the legacy `learning.*` JSON-RPC methods on `/api/ws`, which
// its own TUI uses for `/journey` (`tui_gateway/methods_tools.py`, `agent/learning_mutations.py`):
// - `learning.frames` lists every entry as a node `memory:<source>:<index>:<fingerprint>`, `source` being `memory` for
//   MEMORY.md and `profile` for USER.md, and the fingerprint a digest of the entry's text.
// - `learning.detail` reads one entry's full text, `learning.edit` replaces it and `learning.delete` removes it. They
//   find the entry by its fingerprint inside the memory tool's own file lock, so a write to an entry that changed or
//   went since it was read is refused ("memory node id is stale"), never applied to another entry.
// - There is no call that adds an entry; only the agent's memory tool does.
// - They take no `profile` and refuse one ("Extra inputs are not permitted"): they always act on the memory of the
//   profile the dashboard process runs as. So over the socket this screen edits memory only when that profile, `GET
//   /api/profiles/active` → `current`, is the profile shown, and checks it again before every write.
//
// The deployed `f0d94882` also has the same calls as profile-scoped dashboard REST (ADR 0118,
// `hermes_cli/web_routers/status.py`): `GET /api/learning/graph?profile=` lists the nodes, `GET /api/learning/node?id=`
// reads one, and `PUT`/`DELETE /api/learning/node` `{id[, content]}` edit or remove it, each through the same
// `agent.learning_mutations` under the memory tool's lock. With those, any profile's memory is read and edited, and the
// socket calls are used only on a server without them.
//
// Memory text comes from the agent and whatever it read, so it is shown as plain text, never rendered, and never kept
// on this computer. The one exception to "never kept": what a save from here replaced, held in this app's memory (never
// on disk) until sign-out or quit, so the owner can put it back (ADR 0040).
import { answered } from "./persona";
import { RestError } from "./pipe";
import { errorText, isObj } from "./values";
import type { AppMethod } from "./canonicalVerbs";

/** Which of the profile's memory files an entry is in, by the name `learning.*` gives it. */
export type MemorySource = "memory" | "profile";

/** The memory files Hermes keeps, in the order it lists them. */
export const MEMORY_RESOURCES: readonly { source: MemorySource; file: string; name: string; about: string }[] = [
  { source: "memory", file: "MEMORY.md", name: "Agent notes", about: "What Hermes noted for itself, such as facts about your setup and projects." },
  { source: "profile", file: "USER.md", name: "User profile", about: "What Hermes noted about you, such as your preferences and how you work." },
];

export const resourceOf = (source: MemorySource) => MEMORY_RESOURCES.find((r) => r.source === source)!;

/** One memory entry. `id` names it to Hermes by its text; once the text changes on the server, the id is stale. */
export type MemoryEntry = { id: string; source: MemorySource; text: string };

/** One memory file as Hermes has it. `bytes`: the file's size, when Hermes reported it. */
export type MemoryResource = { source: MemorySource; file: string; entries: MemoryEntry[]; bytes?: number };

/**
 * The profile's memory as read from Hermes. `home`: the profile's folder on the server, when Hermes reported it.
 * `provider`: an external memory provider the profile also uses, whose memories aren't edited here.
 */
export type MemoryView = {
  profile: string;
  home?: string;
  resources: Record<MemorySource, MemoryResource>;
  provider?: string;
};

/** The line Hermes puts between entries (`ENTRY_DELIMITER`). An entry can't hold it, or it reads back as several. */
export const ENTRY_DELIMITER = "\n§\n";

/**
 * Why memory can't be edited here. `server`: Hermes has no `learning.*` methods, or none this app can use safely.
 * `profile`: the dashboard runs as another profile (`served`), and `learning.*` reach only its memory.
 */
export class MemoryUnsupportedError extends Error {
  constructor(
    readonly reason: "server" | "profile",
    message: string,
    readonly served?: string,
  ) {
    super(message);
  }
}

/** Hermes refused for lack of permission on the server, or the sign-in no longer covers the request. */
export class MemoryPermissionError extends Error {}

/**
 * The entry changed on the server, or went, since it was read, so nothing was written. `view`: memory as Hermes has
 * it now.
 */
export class MemoryConflictError extends Error {
  constructor(readonly view: MemoryView) {
    super("This entry changed on the server, or was removed, since you opened it. Nothing was saved.");
  }
}

/** Hermes answered that it didn't write, with its reason, such as the file's size limit. Nothing was written. */
export class MemoryRefusedError extends Error {}

/** The connection dropped before Hermes answered a write, so it may or may not have made it. */
export class MemoryUnsureError extends Error {}

/** Hermes said it wrote, but reading memory back doesn't show the change. `view`: memory as read back. */
export class MemoryUnverifiedError extends Error {
  constructor(
    message: string,
    readonly view: MemoryView,
  ) {
    super(message);
  }
}

/**
 * What a save from this app replaced: `text` was the entry before it, `saved` the entry the save left, at `savedAt`
 * (ms). Kept in this app's memory only, per profile and file, the most recent `KEEP_REPLACED` (ADR 0040).
 */
export type MemoryReplaced = { text: string; saved: string; savedAt: number };

/**
 * How the memory calls reach Hermes: a legacy JSON-RPC request on `/api/ws`, a dashboard REST read, and the dashboard
 * REST writes to `api/learning/node`. Without `send`, only the socket calls are used.
 */
export type MemoryIO = {
  rpc(method: AppMethod, params: Record<string, unknown>): Promise<unknown>;
  get(pathAndQuery: string): Promise<unknown>;
  send?(method: "PUT" | "DELETE", pathAndQuery: string, body: unknown): Promise<unknown>;
};

/**
 * What became of one entry a removal of several was asked for: `removed`, read back gone; `changed`, it changed or
 * went on the server since it was read, so it wasn't touched; `failed`, Hermes refused (`problem`); `unsure`, the
 * answer was lost and reading back couldn't tell; `skipped`, not tried, as the connection dropped on an earlier one.
 */
export type RemoveOutcome = { entry: MemoryEntry; kind: "removed" | "changed" | "failed" | "unsure" | "skipped"; problem?: string };

export type MemoryApi = {
  /** The profile's memory. Rejects with `MemoryUnsupportedError` when it can't be edited from here. */
  load(profile: string): Promise<MemoryView>;
  /**
   * Replaces `entry`, as last read, with `text`, then reads memory back. Resolves to memory as read back and the entry
   * as saved. Rejects with `MemoryConflictError` when the entry changed on the server since it was read.
   */
  save(profile: string, entry: MemoryEntry, text: string): Promise<{ view: MemoryView; entry: MemoryEntry }>;
  /** Removes `entry`, as last read, then reads memory back to check it's gone. */
  remove(profile: string, entry: MemoryEntry): Promise<MemoryView>;
  /**
   * Removes each of `entries`, as last read, one at a time, then reads memory back once. An entry that changed since
   * it was read is left alone. `view`: memory as read back, missing when that read failed.
   */
  removeMany(profile: string, entries: readonly MemoryEntry[]): Promise<{ view?: MemoryView; outcomes: RemoveOutcome[] }>;
  /** Whether `profile`'s memory goes through the profile-scoped REST routes, as last found; undefined until a read. */
  anyProfile(): boolean | undefined;
  /**
   * What this app's latest confirmed save to `entry`'s text replaced, while the entry still holds what that save left.
   * Undefined once the entry changed since, or when no save from here made it.
   */
  replacedBy(profile: string, entry: MemoryEntry): MemoryReplaced | undefined;
};

// JSON-RPC codes the deployed `bf0203a` answers: method not found (an older server), and params its contract refuses
// (`tui_gateway/contracts`, extra or mistyped fields: a server whose `learning.*` changed shape).
const NO_SUCH_METHOD = -32601;
const BAD_PARAMS = 4000;
/** The smallest timeline `learning.frames` renders (`methods_tools.py` clamps to 20 by 10, two frames); only its
 * nodes are read. */
const FRAMES_PARAMS = { cols: 20, rows: 10, frames: 2 };
/** How often a read starts over when an entry changes between being listed and being read. */
const READ_TRIES = 3;
/** How many replaced texts are kept per profile and file. */
const KEEP_REPLACED = 10;

/** A JSON-RPC error answer: Hermes got the request and answered it. Anything else may not have reached it. */
const rpcCode = (e: unknown): number | undefined => (isObj(e) && typeof e.code === "number" ? e.code : undefined);

/** What `learning.*` answers when the id names text that's no longer there (`agent/learning_mutations.py`). */
const isStale = (message: string) => /\bstale\b/i.test(message);
/** A JSON-RPC refusal for lack of permission: the server's file permissions. */
const isPermission = (message: string) => /permission denied|errno 13|not writable|\b403\b|forbidden/i.test(message);

/**
 * Python's `str.strip()`, which Hermes applies to every entry: the characters `str.isspace()` counts. JavaScript's
 * `trim` differs at the edges (it strips U+FEFF and keeps U+001C to U+001F and U+0085).
 */
const PY_SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_STRIP = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, "g");
export const pyStrip = (s: string) => s.replace(PY_STRIP, "");

/** Characters as Hermes counts them toward a file's limit (Python `len`: code points). */
export const charCount = (s: string) => [...s].length;

/** A file's size as Hermes counts it toward its limit: the entries joined by the delimiter. */
export const resourceChars = (entries: { text: string }[]) =>
  entries.length ? entries.reduce((n, e) => n + charCount(e.text), 0) + charCount(ENTRY_DELIMITER) * (entries.length - 1) : 0;

/**
 * Why `text` can't be saved as one entry, if it can't: Hermes refuses an empty one, and a line holding only "§" would
 * split it into several when Hermes reads the file again.
 */
export function entryProblem(text: string): string | undefined {
  const t = pyStrip(text);
  if (!t) return "An entry can't be empty. To remove it, use Delete.";
  if (/(^|\n)§(\n|$)/.test(t)) return "A line holding only “§” separates entries in Hermes's memory file, so this would be saved as several entries. Change or remove that line.";
}

/**
 * Why `text` can't replace `entry` in a file holding `entries`: another entry already says exactly that. Hermes keeps
 * one copy of identical entries when it next reads the file, so the save would merge the two and drop one.
 */
export function duplicateProblem(text: string, entry: MemoryEntry, entries: readonly MemoryEntry[]): string | undefined {
  const t = pyStrip(text);
  if (t !== entry.text && entries.some((e) => e.id !== entry.id && e.text === t))
    return `Another entry in ${resourceOf(entry.source).file} already says exactly this. Hermes would keep only one of them; to drop this entry, use Delete.`;
}

/** `memory:<source>:<index>:<fingerprint>` → its parts; anything else isn't a memory node. */
function parseId(id: string): { source: MemorySource; index: number; fingerprint?: string } | undefined {
  const parts = id.split(":");
  if (parts[0] !== "memory" || (parts.length !== 3 && parts.length !== 4)) return undefined;
  if (parts[1] !== "memory" && parts[1] !== "profile") return undefined;
  const index = Number(parts[2]);
  if (!Number.isInteger(index) || index < 0) return undefined;
  return { source: parts[1], index, fingerprint: parts[3] || undefined };
}

type Node = { id: string; source: MemorySource; index: number; fingerprint?: string };

/**
 * The memory nodes in a `learning.frames` answer (nodes in `buckets`) or a `GET /api/learning/graph` one (`nodes`), in
 * Hermes's order: MEMORY.md's entries first, then USER.md's.
 */
function memoryNodes(answer: unknown): Node[] {
  let lists: unknown[];
  if (isObj(answer) && Array.isArray(answer.buckets)) lists = answer.buckets.map((b) => (isObj(b) && Array.isArray(b.nodes) ? b.nodes : []));
  else if (isObj(answer) && Array.isArray(answer.nodes)) lists = [answer.nodes];
  else throw new MemoryUnsupportedError("server", "Hermes answered the memory list in a shape this app doesn't know.");
  const seen = new Map<string, Node>();
  for (const list of lists as unknown[][])
    for (const node of list) {
      const id = isObj(node) && typeof node.id === "string" ? node.id : "";
      const parsed = parseId(id);
      if (parsed) seen.set(id, { id, ...parsed });
    }
  return [...seen.values()].sort((a, b) => a.index - b.index);
}

/** A REST answer meaning the server has no such route: `bf0203a`'s `404 No such API endpoint`, FastAPI's `404 Not Found`, or 405. */
const noRoute = (a: { status: number; detail: string } | undefined) => !!a && ((a.status === 404 && /^(not found$|no such api endpoint\b)/i.test(a.detail)) || a.status === 405);

/** What one `learning.detail` or `learning.edit`/`delete` answered: Hermes's `{ok, message, content}`. */
type Answer = { ok: true; content?: string } | { ok: false; message: string };

/**
 * Where `learning.*` go for a profile: `rest`, the profile-scoped dashboard routes; `socket`, the legacy JSON-RPC calls,
 * which reach only the profile the dashboard runs as (`check`).
 */
type Backend = {
  check(profile: string): Promise<void>;
  nodes(profile: string): Promise<Node[]>;
  detail(profile: string, id: string): Promise<Answer>;
  /** Rejects with `MemoryUnsureError` when Hermes's answer was lost, so the write may or may not have happened. */
  write(profile: string, op: "edit" | "delete", id: string, content?: string): Promise<Answer>;
};

/** The route as the relay takes it: `profile` always in the query. */
const learningPath = (what: "graph" | "node", profile: string, id?: string) => `api/learning/${what}?${new URLSearchParams({ ...(id !== undefined && { id }), profile })}`;

/** Thrown by the REST backend's first read when the server has no `api/learning` routes, to use the socket instead. */
class NoRestRoutes extends Error {}

/** A failed `learning.*` or REST call, as the reason the screen shows. */
function classify(e: unknown): Error {
  if (e instanceof MemoryUnsupportedError || e instanceof MemoryPermissionError) return e;
  const code = rpcCode(e);
  if (code === NO_SUCH_METHOD)
    return new MemoryUnsupportedError("server", "This Hermes server has no memory editing calls (`learning.detail`, `learning.edit`). Updating Hermes adds them.");
  if (code === BAD_PARAMS)
    return new MemoryUnsupportedError("server", `This Hermes server's memory calls changed shape, so this app won't use them: ${errorText(e)}`);
  const message = errorText(e);
  const rest = answered(e);
  if (rest?.status === 404 && /profile/i.test(rest.detail)) return new Error(`Hermes has no such profile: ${rest.detail}`);
  const signedOut = () => new MemoryPermissionError(`The dashboard no longer accepts this sign-in: ${message}`);
  const refused = () => new MemoryPermissionError(`Hermes isn't allowed to do that on the server: ${message}`);
  // A dashboard answer is told by its status: its body is server text (#486). Hermes's JSON-RPC answers by its message.
  if (e instanceof RestError) return e.status === 401 ? signedOut() : e.status === 403 ? refused() : e;
  if (/signed out|401|unauthori[sz]ed/i.test(message)) return signedOut();
  if (isPermission(message)) return refused();
  return e instanceof Error ? e : new Error(message);
}

/** The profile's folder and memory sizes, as dashboard REST reports them; missing when it can't. */
async function extras(io: MemoryIO, profile: string): Promise<Pick<MemoryView, "home" | "provider"> & { bytes?: Record<MemorySource, number> }> {
  const q = new URLSearchParams({ profile });
  const [status, profiles] = await Promise.all([io.get(`api/memory?${q}`).catch(() => undefined), io.get("api/profiles").catch(() => undefined)]);
  const files = isObj(status) && isObj(status.builtin_files) ? status.builtin_files : undefined;
  const size = (v: unknown) => (typeof v === "number" && v >= 0 ? v : undefined);
  const memoryBytes = size(files?.memory);
  const userBytes = size(files?.user);
  const listed = isObj(profiles) && Array.isArray(profiles.profiles) ? profiles.profiles : [];
  const row = listed.find((p) => isObj(p) && p.name === profile);
  return {
    home: isObj(row) && typeof row.path === "string" && row.path ? row.path : undefined,
    provider: isObj(status) && typeof status.active === "string" && status.active ? status.active : undefined,
    bytes: memoryBytes !== undefined && userBytes !== undefined ? { memory: memoryBytes, profile: userBytes } : undefined,
  };
}

export function memoryApi(io: MemoryIO, now = () => Date.now()): MemoryApi {
  // What saves from here replaced, by profile and file, most recent first. Lives as long as this connection's client.
  const replaced = new Map<string, MemoryReplaced[]>();
  const rpc = (method: AppMethod, params: Record<string, unknown>) => io.rpc(method, params).catch((e) => Promise.reject(classify(e)));
  /** Whether the server has the profile-scoped REST routes: unknown until the first read finds out. */
  let restRoutes: boolean | undefined = io.send ? undefined : false;

  /** Rejects unless the dashboard runs as `profile`, whose memory `learning.*` reach. */
  const checkServed = async (profile: string) => {
    const active = await io.get("api/profiles/active").catch((e) => Promise.reject(classify(e)));
    const served = isObj(active) && typeof active.current === "string" ? active.current : "";
    if (served === profile) return;
    throw new MemoryUnsupportedError(
      "profile",
      served && served !== "custom"
        ? `Hermes can edit memory only for the profile its dashboard runs as, which is ${served}. The ${profile} profile's memory can't be read or changed from here. Updating Hermes adds the routes that reach every profile.`
        : `Hermes can edit memory only for the profile its dashboard runs as, and it doesn't say which that is, so the ${profile} profile's memory can't be read or changed from here.`,
      served || undefined,
    );
  };

  /** A socket answer as `Answer`; a lost one as `MemoryUnsureError`. */
  const socketWrite = async (method: AppMethod, params: Record<string, unknown>): Promise<Answer> => {
    let res: unknown;
    try {
      res = await io.rpc(method, params);
    } catch (e) {
      if (rpcCode(e) === undefined)
        throw new MemoryUnsureError(`The connection dropped before Hermes answered, so it may or may not have saved the change. Reload once connected to see. (${errorText(e)})`);
      throw classify(e);
    }
    if (isObj(res) && res.ok === true) return { ok: true };
    return { ok: false, message: isObj(res) && typeof res.message === "string" ? res.message : "Hermes didn't say why." };
  };

  const socket: Backend = {
    check: checkServed,
    nodes: async () => memoryNodes(await rpc("learning.frames", FRAMES_PARAMS)),
    detail: async (_profile, id) => {
      const d = await rpc("learning.detail", { id });
      if (isObj(d) && d.ok === true && typeof d.content === "string") return { ok: true, content: d.content };
      return { ok: false, message: isObj(d) && typeof d.message === "string" ? d.message : "no content" };
    },
    write: (_profile, op, id, content) => socketWrite(op === "edit" ? "learning.edit" : "learning.delete", op === "edit" ? { id, content } : { id }),
  };

  const rest: Backend = {
    check: async () => {},
    nodes: async (profile) => {
      let graph: unknown;
      try {
        graph = await io.get(learningPath("graph", profile));
      } catch (e) {
        if (restRoutes === undefined && noRoute(answered(e))) throw new NoRestRoutes();
        throw classify(e);
      }
      return memoryNodes(graph);
    },
    detail: async (profile, id) => {
      try {
        const d = await io.get(learningPath("node", profile, id));
        if (isObj(d) && d.ok === true && typeof d.content === "string") return { ok: true, content: d.content };
        return { ok: false, message: "no content" };
      } catch (e) {
        // `get_learning_node` answers 404 with Hermes's reason, such as a stale id.
        const a = answered(e);
        if (a?.status === 404 && !noRoute(a)) return { ok: false, message: a.detail };
        throw classify(e);
      }
    },
    write: async (profile, op, id, content) => {
      try {
        const res = await io.send!(op === "edit" ? "PUT" : "DELETE", learningPath("node", profile), op === "edit" ? { id, content } : { id });
        if (isObj(res) && res.ok === true) return { ok: true };
        return { ok: false, message: isObj(res) && typeof res.message === "string" ? res.message : "Hermes didn't say why." };
      } catch (e) {
        const a = answered(e);
        // `_learning_mutation` answers a refusal 400 with Hermes's reason; nothing was written.
        if (a?.status === 400) return { ok: false, message: a.detail };
        if (a && a.status < 500) throw classify(e);
        if (/^Not connected to Hermes|^The chat connection is closed/.test(errorText(e))) throw classify(e);
        throw new MemoryUnsureError(`Hermes didn't answer clearly, so it may or may not have made the change. Reload once connected to see. (${errorText(e)})`);
      }
    },
  };

  /** The backend for reads and writes now: REST once known to be there, else the socket. */
  const backend = () => (restRoutes === false ? socket : rest);

  /** The nodes, finding out on the first read whether the server has the REST routes. */
  const nodes = async (profile: string): Promise<{ b: Backend; nodes: Node[] }> => {
    if (restRoutes !== false) {
      try {
        const found = await rest.nodes(profile);
        restRoutes = true;
        return { b: rest, nodes: found };
      } catch (e) {
        if (!(e instanceof NoRestRoutes)) throw e;
        restRoutes = false;
      }
    }
    await socket.check(profile);
    return { b: socket, nodes: await socket.nodes(profile) };
  };

  const read = async (profile: string): Promise<MemoryView> => {
    for (let attempt = 1; ; attempt++) {
      const { b, nodes: found } = await nodes(profile);
      if (found.some((n) => !n.fingerprint))
        throw new MemoryUnsupportedError("server", "This Hermes server names memory entries by position only, so an edit could land on the wrong entry. Updating Hermes fixes this.");
      const details = await Promise.all(found.map((n) => b.detail(profile, n.id)));
      if (details.some((d) => !d.ok && isStale(d.message))) {
        if (attempt < READ_TRIES) continue;
        throw new Error("Memory kept changing on the server while it was read. Try Reload.");
      }
      const resources: Record<MemorySource, MemoryResource> = {
        memory: { source: "memory", file: "MEMORY.md", entries: [] },
        profile: { source: "profile", file: "USER.md", entries: [] },
      };
      found.forEach((n, i) => {
        const d = details[i];
        if (!d.ok || typeof d.content !== "string") throw classify(new Error(`Hermes couldn't read a memory entry: ${d.ok ? "no content" : d.message}`));
        resources[n.source].entries.push({ id: n.id, source: n.source, text: d.content });
      });
      const more = await extras(io, profile);
      if (more.bytes) {
        resources.memory.bytes = more.bytes.memory;
        resources.profile.bytes = more.bytes.profile;
      }
      return { profile, home: more.home, provider: more.provider, resources };
    }
  };

  /** Rejects with a conflict unless `entry` is on the server as it was read. */
  const checkUnchanged = async (profile: string, entry: MemoryEntry) => {
    const now = await backend().detail(profile, entry.id);
    if (now.ok && now.content === entry.text) return;
    if (!now.ok && !isStale(now.message)) throw classify(new Error(now.message));
    throw new MemoryConflictError(await read(profile));
  };

  /** One edit or removal, and what its answer means. */
  const write = async (profile: string, op: "edit" | "delete", entry: MemoryEntry, content?: string) => {
    const res = await backend().write(profile, op, entry.id, content);
    if (res.ok) return;
    if (isStale(res.message)) throw new MemoryConflictError(await read(profile));
    if (isPermission(res.message)) throw new MemoryPermissionError(`Hermes isn't allowed to change the memory file: ${res.message}`);
    throw new MemoryRefusedError(`Hermes didn't ${op === "edit" ? "save it" : "remove it"}: ${res.message}`);
  };

  return {
    load: read,
    async save(profile, entry, text) {
      const problem = entryProblem(text);
      if (problem) throw new MemoryRefusedError(problem);
      const next = pyStrip(text);
      await backend().check(profile);
      await checkUnchanged(profile, entry);
      if (next !== entry.text) {
        // ponytail: checked on a fresh read, not under Hermes's lock; an identical entry written in between still merges.
        const dup = duplicateProblem(next, entry, (await read(profile)).resources[entry.source].entries);
        if (dup) throw new MemoryRefusedError(dup);
        await write(profile, "edit", entry, next);
      }
      const view = await read(profile);
      const saved = view.resources[entry.source].entries.find((e) => e.text === next);
      if (!saved) throw new MemoryUnverifiedError(`Hermes said it saved the entry, but ${entry.source === "memory" ? "MEMORY.md" : "USER.md"} doesn't have it when read back. It may have been changed again meanwhile.`, view);
      if (next !== entry.text) {
        const key = `${profile}\n${entry.source}`;
        replaced.set(key, [{ text: entry.text, saved: next, savedAt: now() }, ...(replaced.get(key) ?? [])].slice(0, KEEP_REPLACED));
      }
      return { view, entry: saved };
    },
    async remove(profile, entry) {
      await backend().check(profile);
      await checkUnchanged(profile, entry);
      await write(profile, "delete", entry);
      const view = await read(profile);
      if (view.resources[entry.source].entries.some((e) => e.text === entry.text))
        throw new MemoryUnverifiedError("Hermes said it removed the entry, but it is still there when read back.", view);
      return view;
    },
    async removeMany(profile, entries) {
      const before = await read(profile);
      const outcomes: RemoveOutcome[] = [];
      let dropped = false;
      for (const entry of entries) {
        if (dropped) {
          outcomes.push({ entry, kind: "skipped" });
          continue;
        }
        // Hermes names an entry by its text, so one whose text is still in its file is the entry as read.
        if (!before.resources[entry.source].entries.some((e) => e.text === entry.text)) {
          outcomes.push({ entry, kind: "changed" });
          continue;
        }
        try {
          // Checked again on the server just before: a socket call reaches only the profile the dashboard runs as.
          await backend().check(profile);
          const res = await backend().write(profile, "delete", entry.id);
          outcomes.push(res.ok ? { entry, kind: "removed" } : isStale(res.message) ? { entry, kind: "changed" } : { entry, kind: "failed", problem: res.message });
        } catch (e) {
          if (e instanceof MemoryUnsureError) {
            dropped = true;
            outcomes.push({ entry, kind: "unsure", problem: e.message });
          } else outcomes.push({ entry, kind: "failed", problem: errorText(classify(e)) });
        }
      }
      let view: MemoryView | undefined;
      try {
        view = await read(profile);
      } catch (e) {
        // Without a read-back, a removal Hermes said it made isn't confirmed.
        return { outcomes: outcomes.map((o) => (o.kind === "removed" ? { ...o, kind: "unsure" as const, problem: `Reading memory back failed: ${errorText(e)}` } : o)) };
      }
      const after = view;
      return {
        view,
        outcomes: outcomes.map((o) => {
          const there = after.resources[o.entry.source].entries.some((e) => e.text === o.entry.text);
          if (o.kind === "removed" && there) return { ...o, kind: "failed" as const, problem: "Hermes said it removed it, but it is still there when read back." };
          if (o.kind === "unsure") return there ? { ...o, kind: "failed" as const } : { entry: o.entry, kind: "removed" as const };
          return o;
        }),
      };
    },
    anyProfile: () => restRoutes,
    replacedBy(profile, entry) {
      return replaced.get(`${profile}\n${entry.source}`)?.find((r) => r.saved === entry.text);
    },
  };
}
