// What crosses an extension's port (ADR 0126, sections 2, 3, 4 and 6): JSON-RPC 2.0 as JSON text, checked here before
// the runtime acts on it. Pure: the runtime (extensions.ts) owns the frame, the calls and the deadlines.
import { PERMISSIONS, type Permission } from "./extensionPermissions";

export const RPC_LIMITS = {
  /** A message over this many UTF-8 bytes stops the extension. */
  bytes: 256 * 1024,
  /** More messages than this in one second stop the extension. */
  perSecond: 50,
  nodes: 200,
  rows: 200,
  columns: 12,
  text: 4000,
  label: 200,
  note: 4000,
  logText: 2000,
} as const;

export const ERRORS = {
  invalid_params: -32602,
  method_not_found: -32601,
  permission_denied: -32001,
  no_open_call: -32002,
} as const;
export type ErrorName = keyof typeof ERRORS;

type Id = string | number;
export type Incoming =
  | { kind: "result"; id: Id; result: unknown }
  | { kind: "error"; id: Id; message: string }
  | { kind: "request"; id?: Id; method: string; params: Record<string, unknown> };

type Raw = Record<string, unknown>;
const isObject = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is Id => typeof v === "string" || (typeof v === "number" && Number.isSafeInteger(v));
const utf8 = new TextEncoder();

/** Parses one message from an extension, or says why it is broken. A broken message stops the extension. */
export function parseIncoming(data: unknown): Incoming | { kind: "broken"; why: string } {
  if (typeof data !== "string") return { kind: "broken", why: "sent something other than JSON text" };
  if (data.length > RPC_LIMITS.bytes || utf8.encode(data).length > RPC_LIMITS.bytes) return { kind: "broken", why: `sent a message over ${RPC_LIMITS.bytes / 1024} KB` };
  let m: unknown;
  try {
    m = JSON.parse(data);
  } catch {
    return { kind: "broken", why: "sent a message that isn't JSON" };
  }
  if (!isObject(m) || m.jsonrpc !== "2.0") return { kind: "broken", why: "sent a message that isn't JSON-RPC 2.0" };
  if (typeof m.method === "string") {
    if (m.id !== undefined && !isId(m.id)) return { kind: "broken", why: "sent a request with a bad id" };
    if (m.params !== undefined && !isObject(m.params)) return { kind: "broken", why: `sent ${m.method} with params that aren't an object` };
    return { kind: "request", id: m.id, method: m.method, params: m.params ?? {} };
  }
  if (!isId(m.id)) return { kind: "broken", why: "sent an answer with no id" };
  if ("result" in m) return { kind: "result", id: m.id, result: m.result };
  if (isObject(m.error) && typeof m.error.message === "string") return { kind: "error", id: m.id, message: m.error.message.slice(0, RPC_LIMITS.note) };
  return { kind: "broken", why: "sent an answer with neither a result nor an error" };
}

/** A node of an extension's view (section 6). The app draws it with its own components; nothing is HTML. */
export type ViewNode =
  | { kind: "heading"; text: string }
  | { kind: "text"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "table"; columns: string[]; rows: string[][] }
  | { kind: "facts"; facts: { label: string; value: string }[] }
  | { kind: "notice"; text: string }
  | { kind: "button"; label: string; command: string; arg: string };

const str = (v: unknown, max: number) => typeof v === "string" && v.length <= max;
const strs = (v: unknown, count: number, max: number) => Array.isArray(v) && v.length <= count && v.every((x) => str(x, max));
const KEYS: Record<ViewNode["kind"], readonly string[]> = {
  heading: ["text"],
  text: ["text"],
  list: ["items"],
  table: ["columns", "rows"],
  facts: ["facts"],
  notice: ["text"],
  button: ["label", "command", "arg"],
};

function parseNode(n: unknown): ViewNode | string {
  if (!isObject(n) || typeof n.kind !== "string" || !Object.hasOwn(KEYS, n.kind)) return "a node of an unknown kind";
  const kind = n.kind as ViewNode["kind"];
  const extra = Object.keys(n).find((k) => k !== "kind" && !KEYS[kind].includes(k));
  if (extra) return `a ${kind} node with an unknown key "${extra}"`;
  const L = RPC_LIMITS;
  switch (kind) {
    case "heading":
      return str(n.text, L.label) ? { kind, text: n.text as string } : "a heading over the length cap";
    case "text":
    case "notice":
      return str(n.text, L.text) ? { kind, text: n.text as string } : `a ${kind} over the length cap`;
    case "list":
      return strs(n.items, L.rows, L.text) ? { kind, items: n.items as string[] } : "a list that isn't text within its caps";
    case "table": {
      const cols = n.columns as string[];
      const ok = strs(n.columns, L.columns, L.label) && Array.isArray(n.rows) && n.rows.length <= L.rows && n.rows.every((r) => strs(r, cols.length, L.label));
      return ok ? { kind, columns: cols, rows: n.rows as string[][] } : "a table that isn't text within its caps";
    }
    case "facts": {
      const ok = Array.isArray(n.facts) && n.facts.length <= L.rows && n.facts.every((f) => isObject(f) && Object.keys(f).every((k) => k === "label" || k === "value") && str(f.label, L.label) && str(f.value, L.label));
      return ok ? { kind, facts: (n.facts as Raw[]).map((f) => ({ label: f.label as string, value: f.value as string })) } : "facts that aren't label and value text";
    }
    case "button":
      return str(n.label, L.label) && typeof n.command === "string" && (n.arg === undefined || str(n.arg, L.text))
        ? { kind, label: n.label as string, command: n.command, arg: (n.arg as string | undefined) ?? "" }
        : "a button without a label and a command";
  }
}

/** The view an extension sent, or why it was refused. */
export function parseView(nodes: unknown): ViewNode[] | string {
  if (!Array.isArray(nodes) || nodes.length > RPC_LIMITS.nodes) return `a view must be a list of at most ${RPC_LIMITS.nodes} nodes`;
  const out: ViewNode[] = [];
  for (const n of nodes) {
    const v = parseNode(n);
    if (typeof v === "string") return v;
    out.push(v);
  }
  return out;
}

const LEVELS = { debug: "DEBUG", info: "INFO", warning: "WARNING", error: "ERROR" } as const;

/**
 * The methods an extension can call, and what each needs (section 3). A method with a `permission` needs the owner's
 * grant, and, when the permission is `during: "call"`, an open call whose id it names. `chat.read`'s answer is built by
 * the runtime from the call's chat. `project.read` and `storage` have no method yet: no bundled extension asks for them
 * and install from a file waits for Delivery step 4, so a call to one gets `method_not_found`.
 */
export const METHODS = {
  "chat.read": { permission: "chat.read", parse: (p: Raw) => (typeof p.call === "string" ? { call: p.call } : "needs a call id") },
  "chat.draft": {
    permission: "chat.draft",
    parse: (p: Raw) => (typeof p.call === "string" && str(p.text, RPC_LIMITS.text) && p.text ? { call: p.call, text: p.text as string } : "needs a call id and text"),
  },
  "view.update": {
    permission: undefined,
    parse: (p: Raw) => {
      if (typeof p.id !== "string") return "needs a view id";
      const nodes = parseView(p.nodes);
      return typeof nodes === "string" ? nodes : { id: p.id, nodes };
    },
  },
  log: {
    permission: undefined,
    parse: (p: Raw) => (typeof p.level === "string" && Object.hasOwn(LEVELS, p.level) && typeof p.text === "string" ? { level: LEVELS[p.level as keyof typeof LEVELS], text: p.text.slice(0, RPC_LIMITS.logText) } : "needs a level (debug, info, warning, error) and text"),
  },
} as const satisfies Record<string, { permission: Permission | undefined; parse: (p: Raw) => object | string }>;

export type MethodName = keyof typeof METHODS;
export type Params<M extends MethodName> = Exclude<ReturnType<(typeof METHODS)[M]["parse"]>, string>;

/** The permissions some method serves today. A bundled manifest may ask only for these (bundled.test.ts). */
export const SERVED: ReadonlySet<Permission> = new Set(Object.values(METHODS).flatMap((m) => (m.permission ? [m.permission] : [])));

/**
 * Whether a call to `method` may go ahead, given the owner's grants and the open call, if any. `openCall` is the id of
 * the call open now, still on its chat. Pure, so each permission is tested against each call state.
 */
export function authorize(method: string, params: Raw, grants: ReadonlySet<Permission>, openCall: string | undefined): { ok: true; method: MethodName; params: object } | { ok: false; error: ErrorName; why: string } {
  if (!Object.hasOwn(METHODS, method)) return { ok: false, error: "method_not_found", why: `${method} isn't a method of this app` };
  const name = method as MethodName;
  const spec = METHODS[name];
  const parsed = spec.parse(params);
  if (typeof parsed === "string") return { ok: false, error: "invalid_params", why: `${method} ${parsed}` };
  const permission = spec.permission;
  if (permission) {
    if (!grants.has(permission)) return { ok: false, error: "permission_denied", why: `${method} needs the ${permission} permission, which isn't granted` };
    if (PERMISSIONS[permission].during === "call" && (!openCall || (parsed as { call: string }).call !== openCall))
      return { ok: false, error: "no_open_call", why: `${method} works only during a call the owner started, and names that call` };
  }
  return { ok: true, method: name, params: parsed };
}

export const request = (id: number | undefined, method: string, params: object) => JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params });
export const answer = (id: Id, result: unknown) => JSON.stringify({ jsonrpc: "2.0", id, result: result ?? null });
export const refusal = (id: Id, error: ErrorName, why: string) => JSON.stringify({ jsonrpc: "2.0", id, error: { code: ERRORS[error], message: `${error}: ${why}` } });
