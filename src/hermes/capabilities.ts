// What the connected Hermes server can do: the typed contract that the transport, Connection diagnostics, and every
// screen that depends on a server route or method share (ADR 0044, docs/compatibility.md). There is one store per
// Hermes (one sign-in), kept in memory only.
//
// Where each answer comes from, in this order:
// 1. What Hermes says about itself: `GET /api/health` (version, build, commit), `GET /api/status` (release date and the
//    sign-in gate), the `gateway.ready` frame (protocol generation), `client.capabilities` (the server→client requests
//    it may send, such as Approvals) and `gateway.capabilities` (feature flags). A version string alone proves nothing
//    about a route.
// 2. What the app's own traffic shows: every dashboard GET and JSON-RPC request the screens make is observed, so a
//    route that answered, or one that is missing, settles that capability without asking again.
// 3. A check, only for what neither of those settled: one request per capability that only reads, with a time limit.
//    Nothing is ever written to find out. A capability with no read to check it by stays unknown until its screen
//    checks it.
//
// Every answer is one of four states. `supported`: Hermes answered the route or method. `unsupported`: Hermes has no
// such route or method (its own 404 or a 405, or JSON-RPC "method not found"). `unknown`: Hermes answered in a way that
// settles nothing, such as a refusal or an answer of the wrong shape. `unreachable`: no answer came, such as a timeout,
// a dropped connection or a 5xx, which may pass. Every capability starts `unknown`, and only `unsupported` holds a
// screen back or refuses a write.
import { redact as redactSecrets } from "./logs";

/** The features whose server support is tracked. */
export type CapabilityId =
  | "chat"
  | "approvals"
  | "approvalAnswers"
  | "projects"
  | "commands"
  | "liveSessions"
  | "memory"
  | "toolsets"
  | "toolsetSwitches"
  | "persona"
  | "skills"
  | "serverFiles"
  | "scheduledJobs"
  | "automations"
  | "outputs"
  | "botMode"
  | "subagents"
  | "subagentRoster";

export type CapabilityState = "supported" | "unsupported" | "unknown" | "unreachable";

/** How a state was learnt: Hermes said so, a check made for it, or a screen's own request. */
export type CapabilitySource = "advertised" | "probed" | "observed";

export type Capability = {
  id: CapabilityId;
  state: CapabilityState;
  source?: CapabilitySource;
  /** Why, in the owner's words. Never holds a secret (`redact`). */
  why?: string;
  /** When this state was learnt; none while not checked yet. */
  checkedAt?: number;
};

/** A check that only reads: a dashboard GET, or a JSON-RPC request whose method only reads. */
/**
 * `lacks`: for an answer not of `shape`, why it shows Hermes doesn't have the feature, such as an older answer that
 * leaves the feature's field out; none when it shows nothing. Such an answer makes the capability unsupported.
 */
type Probe =
  | { kind: "rest"; path: (profile: string) => string; maxBytes?: number; shape: (body: unknown) => boolean; lacks?: (body: unknown) => string | undefined }
  | { kind: "rpc"; method: string; params: (profile: string) => Record<string, unknown>; shape: (result: unknown) => boolean; lacks?: (result: unknown) => string | undefined };

export type CapabilitySpec = {
  id: CapabilityId;
  /** Its name in the app. */
  label: string;
  /** Where in the app it is used. */
  usedBy: string;
  /** What Hermes must have, in the owner's words. */
  needs: string;
  /** What the app does without it. */
  without: string;
  /** Its section of the compatibility guide (docs/compatibility.md). */
  anchor: string;
  /** How it is checked when nothing else has settled it. None for one learnt only from what Hermes says or a screen checks. */
  probe?: Probe;
  /** Dashboard routes, as the relay names them (`api/…`, no query). A GET's answer settles the capability. */
  routes?: RegExp[];
  /** JSON-RPC methods whose answers settle it. */
  methods?: string[];
  /** Dashboard routes whose `POST`, `PUT`, `PATCH` or `DELETE` is refused here while the capability is unsupported. */
  writeRoutes?: RegExp[];
  /** JSON-RPC methods that change something, refused here while the capability is unsupported. */
  writeMethods?: RegExp;
  /** Why it is unknown before anything has settled it, when no check will. */
  notChecked?: string;
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isList = (v: unknown) => Array.isArray(v);
/** A `profiles.list` answer whose rows report their Bot Chat (`canonical_session`, null for none yet). */
const botRoster = (r: unknown) => isObj(r) && isList(r.profiles) && (r.profiles as unknown[]).every((p) => isObj(p) && "canonical_session" in p);
/** A `profiles.list` from a Hermes older than Bot Mode: its rows are profiles, but none reports a Bot Chat. */
const rosterWithoutBotChats = (r: unknown) =>
  isObj(r) && isList(r.profiles) && (r.profiles as unknown[]).length > 0 && (r.profiles as unknown[]).every((p) => isObj(p) && typeof p.name === "string" && !("canonical_session" in p))
    ? "This Hermes lists its profiles but doesn't report their Bot Chats, so it has no Bot Mode."
    : undefined;

/** The name a check gives where it must name something, so nothing real is read. */
export const PROBE_NAME = "__hermes_chat_probe__";

/**
 * The capability contract: what each feature needs, how it is checked, which writes it guards, and what the app does
 * without it. The order is the order Connection diagnostics lists them in.
 */
export const CAPABILITIES: readonly CapabilitySpec[] = [
  {
    id: "chat",
    label: "Chats",
    usedBy: "The chat list, transcripts and composer",
    needs: "The dashboard's legacy session protocol on /api/ws.",
    without: "Hermes Chat doesn't connect, and the sign-in screen says why.",
    anchor: "chats-and-the-session-protocol",
    notChecked: "Known once a connection opens.",
  },
  {
    id: "approvals",
    label: "Approvals",
    usedBy: "Approval cards in a chat",
    needs: "Hermes lists approval among the requests it sends this app (client.capabilities).",
    without: "Approval cards don't show. Hermes decides by the profile's own settings, or waits.",
    anchor: "approvals",
    notChecked: "Known once a connection opens.",
  },
  {
    id: "approvalAnswers",
    label: "Answering Approvals",
    usedBy: "Approval cards in a chat another Hermes app also has open",
    needs: "approval.respond on /api/ws.",
    without: "Approvals are answered in reply to Hermes's request. Another Hermes app with the chat open keeps showing the card until Hermes next lists the chat as not waiting.",
    anchor: "answering-approvals",
    notChecked: "Diagnostics can't check this by reading. Known once this app answers an Approval.",
    methods: ["approval.respond"],
    writeMethods: /^approval\.respond$/,
  },
  {
    id: "projects",
    label: "Projects",
    usedBy: "The project switcher and project screens",
    needs: "The projects.* methods on /api/ws.",
    without: "The chat list works. The project menu says Hermes doesn't support projects, and offers no New project.",
    anchor: "projects",
    probe: { kind: "rpc", method: "projects.list", params: (profile) => ({ profile }), shape: (r) => isObj(r) || isList(r) },
    methods: ["projects.list"],
    // Not `projects.membership.*`: no Hermes has that store yet (ADR 0033), so its "method not found" is expected.
    writeMethods: /^projects\.(?!list$|get$|membership\.)/,
  },
  {
    id: "commands",
    label: "Hermes's slash commands",
    usedBy: "/steer and /context in the composer",
    needs: "commands.catalog, command.dispatch and slash.exec on /api/ws.",
    without: "Those commands say that Hermes needs an update. The app's own commands still work.",
    anchor: "slash-commands",
    probe: { kind: "rpc", method: "commands.catalog", params: (profile) => ({ profile }), shape: isObj },
    methods: ["commands.catalog"],
    writeMethods: /^(command\.dispatch|slash\.exec)$/,
  },
  {
    id: "liveSessions",
    label: "Work in other profiles",
    usedBy: "The inbox's running and waiting entries for other profiles",
    needs: "session.active_list on /api/ws.",
    without: "The inbox still lists Unread chats and Failed messages in every profile, and says it can't see running work elsewhere.",
    anchor: "the-inbox",
    probe: { kind: "rpc", method: "session.active_list", params: () => ({}), shape: (r) => isObj(r) && isList(r.sessions) },
    methods: ["session.active_list"],
  },
  {
    id: "memory",
    label: "Memory",
    usedBy: "Settings → Memory",
    needs: "The learning.* methods on /api/ws, and GET /api/profiles/active.",
    without: "Settings → Memory explains what is missing, and reads or writes nothing.",
    anchor: "memory",
    // `learning.detail` for a name no skill or memory has only looks it up, and answers `ok: false`.
    probe: { kind: "rpc", method: "learning.detail", params: () => ({ id: PROBE_NAME }), shape: isObj },
    methods: ["learning.frames", "learning.detail"],
    writeMethods: /^learning\.(edit|delete)$/,
  },
  {
    id: "toolsets",
    label: "Toolsets",
    usedBy: "Settings → Toolsets",
    needs: "GET /api/tools/toolsets.",
    without: "Settings → Toolsets explains what is missing, and reads or writes nothing.",
    anchor: "toolsets",
    probe: { kind: "rest", path: (profile) => `api/tools/toolsets?${new URLSearchParams({ profile })}`, shape: isList },
    routes: [/^api\/tools\/toolsets$/],
    // Its only write is a switch, which `toolsetSwitches` guards: a missing switch route mustn't hold the list back.
  },
  {
    id: "toolsetSwitches",
    label: "Toolset switches",
    usedBy: "The switches in Settings → Toolsets",
    needs: "PUT /api/tools/toolsets/{name}.",
    without: "Settings → Toolsets shows each toolset's state without switches.",
    anchor: "toolsets",
    notChecked: "Diagnostics can't check this by reading. Settings → Toolsets checks it when it opens (ADR 0021).",
    // A switch only: the write check Settings → Toolsets sends goes to a name no toolset has (`PROBE_NAME`), and is
    // let through so it can find the route again.
    writeRoutes: [new RegExp(`^api\\/tools\\/toolsets\\/(?!${PROBE_NAME}$)[^/]+$`)],
  },
  {
    id: "persona",
    label: "Persona",
    usedBy: "Settings → Persona",
    needs: "GET and PUT /api/profiles/{name}/soul.",
    without: "Settings → Persona explains what is missing, and reads or writes nothing.",
    anchor: "persona",
    probe: { kind: "rest", path: (profile) => `api/profiles/${encodeURIComponent(profile)}/soul`, shape: isObj },
    routes: [/^api\/profiles\/[^/]+\/soul$/],
    writeRoutes: [/^api\/profiles\/[^/]+\/soul$/],
  },
  {
    id: "skills",
    label: "Skills",
    usedBy: "Settings → Skills",
    needs: "GET /api/skills, and PUT /api/skills/toggle and /api/skills/content to change them.",
    without: "Settings → Skills explains what is missing, and reads or writes nothing.",
    anchor: "skills",
    probe: { kind: "rest", path: (profile) => `api/skills?${new URLSearchParams({ profile })}`, maxBytes: 2 * 1024 * 1024, shape: isList },
    routes: [/^api\/skills$/],
    // The edit and switch writes. Copying to another profile (`POST api/skills`, ADR 0057) isn't owned: a server without
    // that route still lists, switches and edits skills, and the copy's refusal is shown per skill.
    writeRoutes: [/^api\/skills\//],
  },
  {
    id: "serverFiles",
    label: "Server files",
    usedBy: "The Server files screen and file previews",
    needs: "The dashboard's managed-files routes, GET /api/files and GET /api/files/read.",
    without: "The Server files screen explains what is missing, and reads, uploads or saves nothing.",
    anchor: "server-files",
    probe: { kind: "rest", path: () => "api/files", maxBytes: 512 * 1024, shape: isObj },
    routes: [/^api\/files$/, /^api\/files\/read$/],
    // Uploads and saved edits (ADR 0023, 0024) go through Rust, which the transport asks first by these paths.
    writeRoutes: [/^api\/files\//],
  },
  {
    id: "scheduledJobs",
    label: "Scheduled jobs",
    usedBy: "The Scheduled jobs screen",
    needs: "The cron routes under /api/cron/. The profile's gateway must also run on the server to run jobs.",
    without: "The Scheduled jobs screen explains what is missing, and reads or writes nothing.",
    anchor: "scheduled-jobs",
    probe: { kind: "rest", path: (profile) => `api/cron/jobs?${new URLSearchParams({ profile })}`, maxBytes: 2 * 1024 * 1024, shape: (b) => isList(b) || isObj(b) },
    routes: [/^api\/cron\/jobs$/],
    writeRoutes: [/^api\/cron\//],
  },
  {
    id: "automations",
    label: "Automations",
    usedBy: "The Automations screen",
    needs: "The webhook routes under /api/webhooks.",
    without: "The Automations screen explains what is missing, and reads or writes nothing.",
    anchor: "automations",
    probe: { kind: "rest", path: (profile) => `api/webhooks?${new URLSearchParams({ profile })}`, maxBytes: 2 * 1024 * 1024, shape: (b) => isObj(b) && isList(b.subscriptions) },
    routes: [/^api\/webhooks$/],
    writeRoutes: [/^api\/webhooks(\/|$)/],
  },
  {
    id: "outputs",
    label: "Outputs",
    usedBy: "The Outputs screen",
    needs: "GET /api/fs/list, and GET /api/sessions/{id}/messages with tool rows.",
    without: "The Outputs screen explains what is missing, and reads nothing.",
    anchor: "outputs",
    probe: { kind: "rest", path: (profile) => `api/fs/list?${new URLSearchParams({ path: "/", profile })}`, maxBytes: 512 * 1024, shape: isObj },
    routes: [/^api\/fs\/list$/],
  },
  {
    id: "botMode",
    label: "Bot Mode",
    usedBy: "The Bots view",
    needs: "profiles.list on /api/ws, reporting each profile's Bot Chat (canonical_session), and session.list by title.",
    without: "The Bots button doesn't show. Every profile's chats still open from the profile switcher.",
    anchor: "bot-mode",
    // Only a roster whose rows report their Bot Chat counts: an older profiles.list has no Bot Mode.
    probe: { kind: "rpc", method: "profiles.list", params: () => ({}), shape: botRoster, lacks: rosterWithoutBotChats },
    methods: ["profiles.list"],
  },
  {
    id: "subagents",
    label: "Subagents",
    usedBy: "The Subagents panel in a chat",
    needs: "The subagent.* events, and subagent.list, subagent.tail, subagent.steer and subagent.interrupt on /api/ws.",
    without: "The Subagents panel shows what the events say, but not what happened while the app was disconnected, and has no Steer or Stop.",
    anchor: "subagents",
    // `subagent.list` needs a chat's live session, so there's nothing to read without one.
    notChecked: "Known once a chat opened on this connection lists its subagents.",
    methods: ["subagent.list", "subagent.tail"],
    writeMethods: /^subagent\.(steer|interrupt)$/,
  },
  {
    id: "subagentRoster",
    label: "Subagents in chats not opened",
    usedBy: "Keeping a chat not opened since launch in Working while its background subagents run",
    needs: "subagent.roster on /api/ws.",
    without: "Only a chat opened on this connection stays in Working while its background subagents run. Others go to the Inbox when their reply ends.",
    anchor: "subagents-in-chats-not-opened",
    probe: { kind: "rpc", method: "subagent.roster", params: (profile) => ({ profile }), shape: (r) => isObj(r) && isList(r.sessions) },
    methods: ["subagent.roster"],
  },
];

const SPECS = new Map(CAPABILITIES.map((c) => [c.id, c]));
export const specOf = (id: CapabilityId): CapabilitySpec => SPECS.get(id)!;

/** Where the compatibility guide is published, so the link works from any build of the app. */
export const GUIDE_URL = "https://github.com/l0cky12/hermes-chat/blob/main/docs/compatibility.md";
export const guideUrl = (id?: CapabilityId) => (id ? `${GUIDE_URL}#${specOf(id).anchor}` : GUIDE_URL);

/** The protocol generation Hermes speaks on /api/ws: `legacy`, the one this app supports, or `canonical`. */
export type Protocol = "legacy" | "canonical";

/**
 * What Hermes says about itself. Only these fields are kept from its answers: no paths, ids, tokens or headers.
 * `version`: its base version. `build`: its display version, which may name a commit. `authRequired`: the dashboard
 * asks for a sign-in. `authProviders` and `authFlows`: the sign-in providers and flows it lists, by name. `flags`: the
 * feature flags `gateway.capabilities` turns on, by name.
 */
export type ServerFacts = {
  version?: string;
  build?: string;
  commit?: string;
  releaseDate?: string;
  protocol?: Protocol;
  authRequired?: boolean;
  authProviders?: string[];
  authFlows?: string[];
  flags?: string[];
  /** Hermes counts a 4404 answer to a window-owned request as one client declining (`client.capabilities` `declines_not_shown`). */
  declinesNotShown?: boolean;
  /** Why the version couldn't be read, if it couldn't. */
  versionWhy?: string;
  /** Why the feature flags couldn't be read, if they couldn't. */
  flagsWhy?: string;
};

export type CapabilitySnapshot = {
  facts: ServerFacts;
  caps: Record<CapabilityId, Capability>;
  /** A check is under way. */
  checking: boolean;
  /** When the last whole check finished; none before the first. */
  checkedAt?: number;
  /** No connection is up: what shows is as last checked. */
  stale: boolean;
};

/** A failed request, read the way the Rust relay and FakeHermes word it. */
export type Failure = { status?: number; reason: string; rpcCode?: number };

const messageOf = (e: unknown) => (e instanceof Error ? e.message : isObj(e) && typeof e.message === "string" ? e.message : String(e));

/** Reads a REST or JSON-RPC failure: an HTTP status and Hermes's reason, a JSON-RPC code, or neither. */
export function failureOf(e: unknown): Failure {
  if (isObj(e) && typeof e.code === "number") return { rpcCode: e.code, reason: messageOf(e) };
  const message = messageOf(e);
  if (/sign-in has expired/i.test(message)) return { status: 401, reason: message };
  const m = /^The dashboard answered (\d{3}): ([\s\S]*)$/.exec(message);
  if (!m) return { reason: message };
  let reason = m[2].trim();
  try {
    const d = JSON.parse(reason).detail;
    if (typeof d === "string" && d.trim()) reason = d.trim();
  } catch {
    // Not JSON, or cut short: the text as it came.
  }
  return { status: Number(m[1]), reason };
}

/** JSON-RPC "method not found": the server has no such method. */
const NO_SUCH_METHOD = -32601;
/** JSON-RPC "invalid params", and Hermes's own code for params its contract refuses: the method is there, in another shape. */
const BAD_PARAMS = new Set([-32602, 4000]);

/**
 * A route the server doesn't have: FastAPI's own 404 `Not Found`, Hermes's `No such API endpoint` for a path under
 * /api/, or a 405 for a method the path doesn't take. A route that is there and refuses names its own reason.
 */
export const isNoRoute = (f: Failure) => f.status === 405 || (f.status === 404 && /^(not found$|no such api endpoint\b)/i.test(f.reason));

/** What a failed request means for its capability, with why. */
export function stateOfFailure(f: Failure): { state: CapabilityState; why: string } {
  if (f.rpcCode === NO_SUCH_METHOD) return { state: "unsupported", why: "Hermes has no such method." };
  if (f.rpcCode !== undefined && BAD_PARAMS.has(f.rpcCode)) return { state: "unknown", why: `Hermes has the method, but its contract changed shape: ${f.reason}` };
  // Hermes's own 5xxx codes are failures inside the method, which may pass.
  if (f.rpcCode !== undefined && f.rpcCode >= 5000) return { state: "unreachable", why: `Hermes failed to answer the check, which may pass: ${f.reason}` };
  if (f.rpcCode !== undefined) return { state: "unknown", why: `Hermes has the method, but refused the check: ${f.reason}` };
  if (isNoRoute(f)) return { state: "unsupported", why: `Hermes has no such route (it answered ${f.status}).` };
  if (f.status === 401) return { state: "unknown", why: "The dashboard sign-in has expired. Sign in again to check." };
  if (f.status === 403) return { state: "unknown", why: `Hermes refused this sign-in: ${f.reason}` };
  if (f.status !== undefined && f.status >= 500) return { state: "unreachable", why: `Hermes answered ${f.status}, which may pass: ${f.reason}` };
  // A route that answered with a reason of its own, such as no such profile, is there.
  if (f.status !== undefined) return { state: "supported", why: `Hermes has the route, and answered ${f.status}: ${f.reason}` };
  if (/doesn't relay/.test(f.reason)) return { state: "unknown", why: f.reason };
  // An answer past the size limit is still an answer: the route is there.
  if (/over the \d+ MB limit/.test(f.reason)) return { state: "supported", why: "Hermes answered, with more than the check reads." };
  return { state: "unreachable", why: f.reason };
}

/**
 * Takes anything that looks like a secret out of text the owner may copy, by the Logs screen's rules (logs.ts: cookies,
 * authorization headers, bearer and web tokens, provider keys, user names and passwords in URLs, tickets and keys in URL
 * queries, `secret=` pairs). The webview never has the password or the extra request headers' values, so this is a
 * second line.
 */
export const redact = (text: string): string => redactSecrets(text).text;

/** A short string from an answer, or nothing: only plain text, and no more than `max` characters. */
const plainText = (v: unknown, max: number) => (typeof v === "string" && v.trim() && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v) ? v.trim() : undefined);
/** A short string from an answer that doesn't look like a secret, or nothing. */
const shortText = (v: unknown, max = 80) => {
  const t = plainText(v, max);
  return t && unsecret(t) ? t : undefined;
};
/** Text the redaction leaves as it is. A fact that looks like a secret isn't kept or shown at all. */
const unsecret = (t: string) => redact(t) === t;
/** A version as Hermes reports it. A git checkout without a release says `unknown`, which is no version. */
const versionText = (v: unknown) => {
  const t = shortText(v);
  return t && t.toLowerCase() !== "unknown" ? t : undefined;
};
const NAME = /^[A-Za-z0-9_.-]{1,40}$/;
const names = (v: unknown) => (Array.isArray(v) ? v.filter((n): n is string => typeof n === "string" && NAME.test(n) && unsecret(n)).slice(0, 20) : undefined);

/** The facts in a `GET /api/health` answer; undefined for one that isn't an object. */
export function healthFacts(body: unknown): ServerFacts | undefined {
  if (!isObj(body)) return undefined;
  // Only hex is kept, which the redaction would take for a key-like line.
  const commit = plainText(body.commit, 64);
  return {
    version: versionText(body.version),
    build: versionText(body.displayVersion),
    commit: commit && /^[0-9a-f]{7,64}$/i.test(commit) ? commit : undefined,
    authRequired: typeof body.auth_required === "boolean" ? body.auth_required : undefined,
  };
}

/** The facts in a `GET /api/status` answer, past which nothing of it is kept; undefined for one that isn't an object. */
export function statusFacts(body: unknown): ServerFacts | undefined {
  if (!isObj(body)) return undefined;
  return {
    version: versionText(body.version),
    releaseDate: shortText(body.release_date, 40),
    authRequired: typeof body.auth_required === "boolean" ? body.auth_required : undefined,
    authProviders: names(body.auth_providers),
    authFlows: names(body.auth_flows),
  };
}

/** The protocol a `gateway.ready` payload names. The app connects only on the legacy one (`ProtocolMismatchError`). */
export const protocolOf = (payload: Record<string, unknown>): Protocol => (payload.session_authority ? "canonical" : "legacy");

/** The feature flags a `gateway.capabilities` answer turns on; undefined for an answer that isn't an object. */
export function flagsFrom(result: unknown): string[] | undefined {
  if (!isObj(result)) return undefined;
  return Object.entries(result)
    .filter(([k, v]) => v === true && NAME.test(k) && unsecret(k))
    .map(([k]) => k)
    .sort()
    .slice(0, 20);
}

/** What a `client.capabilities` answer says of Approvals: Hermes sends this app `approval` requests, or doesn't. */
export function approvalsFrom(result: unknown): Pick<Capability, "state" | "why"> {
  if (!isObj(result) || !Array.isArray(result.server_requests)) return { state: "unknown", why: "Hermes didn't list the requests it may send this app." };
  return result.server_requests.includes("approval")
    ? { state: "supported", why: "Hermes lists approval among the requests it sends this app." }
    : { state: "unsupported", why: "Hermes doesn't list approval among the requests it sends this app." };
}

/**
 * The first release (`v2026.9.14`) that sends server requests as JSON-RPC (`ebe8cda8ea`) to every client attached to a
 * chat (`de25545dce`). Before it, Hermes asked through notifications this app doesn't read. `declines_not_shown`
 * (`e33f1a0faf`) came later, in 0.21.6.
 */
const SHARED_CHATS_SINCE = [0, 21, 3];

/**
 * Whether Hermes shares a chat between the clients that have it open: each gets every server request, and the first
 * answer settles it, an error included (ADR 0094). `declines_not_shown` came later, so it says so before the version
 * is read.
 */
export function sharesChats(f: ServerFacts): boolean {
  if (f.declinesNotShown) return true;
  const v = /^v?(\d+)\.(\d+)\.(\d+)/.exec(f.version ?? f.build ?? "");
  if (!v) return false;
  for (let i = 0; i < 3; i++) {
    const d = Number(v[i + 1]) - SHARED_CHATS_SINCE[i];
    if (d) return d > 0;
  }
  return true;
}

/** What a failed `client.capabilities` means for Approvals. A Hermes without it is older than the requests this app reads. */
export function approvalsFailed(e: unknown): Pick<Capability, "state" | "why"> {
  const f = failureOf(e);
  if (f.rpcCode === NO_SUCH_METHOD)
    return { state: "unsupported", why: "Hermes is older than client.capabilities, and doesn't ask for Approvals in the way this app reads." };
  return stateOfFailure(f);
}

/** How the store reaches Hermes. Each call fails as the transport words it. */
export type CapabilityIO = {
  get(pathAndQuery: string, maxBytes?: number): Promise<string>;
  rpc(method: string, params: Record<string, unknown>): Promise<unknown>;
};

/** Per request, so one slow route can't hold up the rest. The checks run side by side. */
export const PROBE_TIMEOUT_MS = 8_000;
/** Past this, a reconnect to the same build checks everything again. */
export const RECHECK_AFTER_MS = 15 * 60_000;
/**
 * How long after a connection opens its check starts, so the chat list loads first and the app's own requests settle
 * what they can. A check is never sent for what they settled meanwhile.
 */
export const CHECK_DELAY_MS = 2_000;
/** The most a fact read (`/api/health`, `/api/status`) may answer. */
const FACTS_MAX_BYTES = 64 * 1024;

/** One connection: `gen` names it, `profile` is the profile its requests name. */
type Scope = { gen: number; profile: string };

const fresh = (): Record<CapabilityId, Capability> =>
  Object.fromEntries(CAPABILITIES.map((c) => [c.id, { id: c.id, state: "unknown", ...(c.notChecked && { why: c.notChecked }) }])) as Record<CapabilityId, Capability>;

const settled = (c: Capability) => c.state === "supported" || c.state === "unsupported";

/** `p`, or a rejection once `ms` pass. */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`Hermes didn't answer within ${Math.round(ms / 1000)} s.`)), ms)));
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** The key a capability's check settles: its route's, or its method. */
const probeKey = (spec: CapabilitySpec) => (spec.probe!.kind === "rpc" ? spec.probe!.method : spec.routes![0].source);

/**
 * Whether a screen's answer shows the route or method there, as the app reads it: JSON for a route, and of the shape
 * the capability's check wants when it is the route or method that check reads.
 */
function valid(spec: CapabilitySpec, key: string, answer: unknown): boolean {
  let value = answer;
  if (typeof answer === "string") {
    try {
      value = JSON.parse(answer);
    } catch {
      return false;
    }
  }
  return spec.probe && probeKey(spec) === key ? spec.probe.shape(value) : value !== undefined;
}

/** A write refused here because the connected Hermes lacks what it needs. Nothing was sent. */
export class CapabilityUnsupportedError extends Error {
  constructor(readonly capability: CapabilityId) {
    // Worded as the relay's own refusals are, which every screen already reads as certainly not sent.
    super(`Hermes Chat doesn't relay this: the connected Hermes server doesn't support ${specOf(capability).label}, so nothing was sent. See Settings → Diagnostics.`);
  }
}

/** The capability a dashboard request's path belongs to, for its writes; none for a path no capability guards. */
/** Every capability that guards a write: a route can belong to more than one, such as a toolset switch. */
const writeRouteOwners = (path: string) => CAPABILITIES.filter((c) => c.writeRoutes?.some((r) => r.test(path)));
const writeMethodOwners = (method: string) => CAPABILITIES.filter((c) => c.writeMethods?.test(method));

/**
 * What the connected Hermes can do: the facts it gives about itself and each capability's state. The transport calls
 * `connected` on each new connection, `disconnected` when it drops or changes profile, and `observe` with each answer
 * the screens' own requests get. Screens read `get`, and diagnostics calls `refresh`. Answers for a connection no
 * longer current are dropped, so a late answer from before a reconnect, a profile switch or a sign-out can't replace
 * newer ones. `liveGen` is the transport's own connection count, read at each answer, so a connection let go without
 * `disconnected` yet still drops its answers.
 */
export class CapabilityStore {
  private snap: CapabilitySnapshot = { facts: {}, caps: fresh(), checking: false, stale: true };
  private listeners = new Set<() => void>();
  private scope?: Scope;
  /** Counts checks started. A check's answers land only while it is the latest. */
  private run = 0;
  /** Counts the changes to each capability, so a check that started before a newer answer doesn't replace it. */
  private revs = new Map<CapabilityId, number>();
  /** For each capability, the routes and methods Hermes was found to lack, by key (`found`). */
  private missing = new Map<CapabilityId, Set<string>>();
  /** The build the last whole check was for. */
  private checkedFor?: string;
  /** When the current connection opened: what was settled since then needs no check. */
  private connectedAt = 0;
  /** The check waiting to start on the current connection. */
  private due?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly io: CapabilityIO,
    private readonly liveGen: () => number,
    private readonly now: () => number = Date.now,
    private readonly timeoutMs = PROBE_TIMEOUT_MS,
    private readonly delayMs = CHECK_DELAY_MS,
  ) {}

  readonly subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  readonly getSnapshot = (): CapabilitySnapshot => this.snap;
  get(id: CapabilityId): Capability {
    return this.snap.caps[id];
  }

  private set(change: Partial<CapabilitySnapshot>) {
    this.snap = { ...this.snap, ...change };
    for (const fn of this.listeners) fn();
  }

  private setCap(id: CapabilityId, cap: Omit<Capability, "id" | "checkedAt">) {
    const why = cap.why === undefined ? undefined : redact(cap.why);
    this.revs.set(id, (this.revs.get(id) ?? 0) + 1);
    this.set({ caps: { ...this.snap.caps, [id]: { id, ...cap, why, checkedAt: this.now() } } });
  }

  /** Puts back a capability as it starts, before anything is learnt. */
  private setCapRaw(id: CapabilityId, cap: Capability) {
    this.revs.set(id, (this.revs.get(id) ?? 0) + 1);
    this.set({ caps: { ...this.snap.caps, [id]: cap } });
  }

  private current = (scope: Scope, run?: number) => this.scope === scope && scope.gen === this.liveGen() && (run === undefined || run === this.run);

  /**
   * A new connection is up: `gen` names it, `ready` is its `gateway.ready` payload, and `told` the `client.capabilities`
   * answer once it comes (a promise, since it may never). Reads what Hermes says about itself, then checks what nothing
   * has settled, unless this is the same build checked lately with nothing left in doubt.
   */
  connected(gen: number, profile: string, ready: Record<string, unknown>, told: Promise<unknown>) {
    const scope: Scope = { gen, profile };
    this.scope = scope;
    this.connectedAt = this.now();
    this.run++;
    clearTimeout(this.due);
    // The canonical protocol never gets this far (`ProtocolMismatchError`), so a connection that is up is legacy.
    this.set({ facts: { ...this.snap.facts, protocol: protocolOf(ready) }, stale: false });
    this.setCap("chat", { state: "supported", source: "advertised", why: "Hermes speaks the legacy session protocol on this connection." });
    const learnt = (declinesNotShown: boolean, approvals: Pick<Capability, "state" | "why">) => {
      if (!this.current(scope)) return;
      this.set({ facts: { ...this.snap.facts, declinesNotShown } });
      this.setCap("approvals", { source: "advertised", ...approvals });
    };
    told.then(
      (r) => learnt(isObj(r) && r.declines_not_shown === true, approvalsFrom(r)),
      (e) => learnt(false, approvalsFailed(e)),
    );
    this.due = setTimeout(() => void this.check(scope, false), this.delayMs);
  }

  /** The connection dropped, closed or changed profile: what shows stays, marked as last checked, and checks under way are dropped. */
  disconnected() {
    if (!this.scope && this.snap.stale && !this.snap.checking) return;
    this.scope = undefined;
    clearTimeout(this.due);
    this.run++;
    this.set({ checking: false, stale: true });
  }

  /** Checks again now, from diagnostics: the facts, then every capability with a check. */
  refresh(): Promise<void> {
    const scope = this.scope;
    if (!scope || !this.current(scope)) return Promise.resolve();
    clearTimeout(this.due);
    return this.check(scope, true);
  }

  /**
   * One answer a screen's own request got: `route` for a dashboard GET (`api/…`, query and all), or `method` for a
   * JSON-RPC request. `error` is its failure; none for one that answered. Settles the capabilities that route or
   * method belongs to, for the connection `gen` it went out on.
   */
  observe(gen: number, call: { route: string } | { method: string }, error?: unknown, answer?: unknown) {
    if (!this.scope || this.scope.gen !== gen || gen !== this.liveGen()) return;
    for (const [spec, key] of this.readOwners(call)) {
      if (error === undefined) {
        // Only an answer of the shape the app reads counts, so a 200 that is an HTML page or a changed shape settles
        // nothing (`valid`).
        if (this.snap.caps[spec.id].state === "supported" && !this.missing.get(spec.id)?.size) continue;
        if (!valid(spec, key, answer)) {
          const lacking = spec.probe && probeKey(spec) === key ? spec.probe.lacks?.(answer) : undefined;
          if (lacking) this.found(spec.id, key, { state: "unsupported", source: "observed", why: lacking });
          continue;
        }
        this.found(spec.id, key, { state: "supported", source: "observed", why: "Hermes answered this app's own request." });
        continue;
      }
      const { state, why } = stateOfFailure(failureOf(error));
      // Only a sure answer from the screens' traffic replaces what a check found. A timeout or refusal there says
      // nothing new about the route.
      if (state === "supported" || state === "unsupported") this.found(spec.id, key, { state, source: "observed", why });
    }
  }

  /**
   * A write a screen sent that failed: `route` for a dashboard write (`api/…`), or `method` for a JSON-RPC one. When
   * Hermes says it has no such route or method, the capability that write belongs to is not supported, and the next
   * write for it is refused before it is sent.
   */
  observeWrite(gen: number, call: { route: string } | { method: string }, error: unknown) {
    if (!this.scope || this.scope.gen !== gen || gen !== this.liveGen()) return;
    const { state, why } = stateOfFailure(failureOf(error));
    if (state !== "unsupported") return;
    const path = "route" in call ? call.route.split("?")[0] : undefined;
    const owners = path !== undefined ? writeRouteOwners(path) : writeMethodOwners((call as { method: string }).method);
    for (const spec of owners) {
      const key = path !== undefined ? `write ${spec.writeRoutes!.find((r) => r.test(path))!.source}` : `write ${(call as { method: string }).method}`;
      this.found(spec.id, key, { state, source: "observed", why: `${why.replace(/\.$/, "")}, for a change this app sends (${path ?? (call as { method: string }).method}).` });
    }
  }

  /** The capabilities a read belongs to, each with the key of the route or method that settles it. */
  private readOwners(call: { route: string } | { method: string }): [CapabilitySpec, string][] {
    if ("method" in call) return CAPABILITIES.filter((c) => c.methods?.includes(call.method)).map((c): [CapabilitySpec, string] => [c, call.method]);
    const path = call.route.split("?")[0];
    return CAPABILITIES.flatMap((c): [CapabilitySpec, string][] => {
      const r = c.routes?.find((r) => r.test(path));
      return r ? [[c, r.source]] : [];
    });
  }

  /**
   * What one route or method (`key`) showed. Hermes lacking any route or method a capability needs makes it not
   * supported; only an answer from that same route or method takes that back, so a sibling route that answers (the
   * file list, when reading a file has no route) can't.
   */
  private found(id: CapabilityId, key: string, cap: Omit<Capability, "id" | "checkedAt">) {
    const missing = this.missing.get(id) ?? new Set<string>();
    if (cap.state === "unsupported") missing.add(key);
    else missing.delete(key);
    this.missing.set(id, missing);
    if (cap.state !== "unsupported" && missing.size) return;
    this.setCap(id, cap);
  }

  /** What a screen found by its own check, such as Settings → Toolsets' write check (ADR 0021). */
  report(gen: number, id: CapabilityId, state: CapabilityState, why: string) {
    if (!this.scope || this.scope.gen !== gen || gen !== this.liveGen()) return;
    // The screen's own check covers all of it, so it takes back what a failed write showed.
    this.missing.delete(id);
    this.setCap(id, { state, source: "observed", why });
  }

  /**
   * The capability whose missing support refuses this request, or none. Only writes are refused: a dashboard `POST`,
   * `PUT`, `PATCH` or `DELETE` on a route a capability guards, or a JSON-RPC method that changes something. Reads
   * still go, so their answers can show the capability is there after all.
   */
  refuses(call: { rest: string; path: string } | { rpc: string }): CapabilityId | undefined {
    const owners = "rest" in call ? (call.rest === "GET" ? [] : writeRouteOwners(call.path.split("?")[0])) : writeMethodOwners(call.rpc);
    return owners.find((c) => this.snap.caps[c.id].state === "unsupported")?.id;
  }

  private async check(scope: Scope, force: boolean): Promise<void> {
    const run = ++this.run;
    this.set({ checking: true });
    const facts = await this.readFacts();
    if (!this.current(scope, run)) return;
    // A build is known by its commit when Hermes names one, else by its version: a git checkout has no version.
    const key = facts.commit ?? facts.build ?? facts.version;
    const sameBuild = key !== undefined && key === this.checkedFor;
    this.set({ facts: { ...facts, protocol: this.snap.facts.protocol, declinesNotShown: this.snap.facts.declinesNotShown } });
    // Another build may have other routes: only what this connection learnt stands.
    if (!sameBuild && this.checkedFor !== undefined) {
      const kept = Object.values(this.snap.caps).filter((c) => (c.checkedAt ?? 0) >= this.connectedAt);
      for (const id of [...this.missing.keys()]) if (!kept.some((c) => c.id === id)) this.missing.delete(id);
      this.set({ caps: { ...fresh(), ...Object.fromEntries(kept.map((c) => [c.id, c])) } });
    }
    // Check again asks each screen to find out afresh what diagnostics can't check by reading (toolset switches).
    if (force) {
      const start = fresh();
      for (const c of CAPABILITIES)
        if (!c.probe && c.notChecked && c.id !== "chat" && c.id !== "approvals") {
          this.missing.delete(c.id);
          this.setCapRaw(c.id, start[c.id]);
        }
    }
    // Not checked again: what this connection's own requests have settled, and on a reconnect to the same build, what
    // was settled less than RECHECK_AFTER_MS ago, by each capability's own time: reading the facts renews none.
    const known = (c: Capability) =>
      settled(c) && ((c.checkedAt ?? 0) >= this.connectedAt || (sameBuild && c.checkedAt !== undefined && this.now() - c.checkedAt < RECHECK_AFTER_MS));
    const due = CAPABILITIES.filter((c) => c.probe && (force || !known(this.snap.caps[c.id])));
    await Promise.all(due.map((c) => this.probe(c, scope, run)));
    if (!this.current(scope, run)) return;
    this.checkedFor = key;
    this.set({ checking: false, checkedAt: this.now() });
  }

  /** The version from `/api/health`, or `/api/status` on a server without it, the sign-in gate, and the feature flags. */
  private async readFacts(): Promise<ServerFacts> {
    const read = (path: string) => within(this.io.get(path, FACTS_MAX_BYTES), this.timeoutMs).then((t) => JSON.parse(t) as unknown);
    const caught = <T>(p: Promise<T>) => p.catch((e: unknown) => (e instanceof Error ? e : new Error(messageOf(e))));
    const [health, status, flags] = await Promise.all([
      caught(read("api/health").then(healthFacts)),
      caught(read("api/status").then(statusFacts)),
      caught(within(this.io.rpc("gateway.capabilities", {}), this.timeoutMs).then(flagsFrom)),
    ]);
    const h = health instanceof Error ? undefined : health;
    const s = status instanceof Error ? undefined : status;
    // `/api/health` names the build this process booted from, so it wins where both say.
    const facts: ServerFacts = {
      version: h?.version ?? s?.version,
      build: h?.build,
      commit: h?.commit,
      releaseDate: s?.releaseDate,
      authRequired: h?.authRequired ?? s?.authRequired,
      authProviders: s?.authProviders,
      authFlows: s?.authFlows,
    };
    if (facts.version === undefined && facts.build === undefined && facts.commit === undefined) {
      const why = [health, status].map((r) => (r instanceof Error ? stateOfFailure(failureOf(r)).why : undefined)).find(Boolean);
      facts.versionWhy = redact(why ?? "Hermes didn't say which version it is.");
    }
    if (Array.isArray(flags)) facts.flags = flags;
    else if (flags instanceof Error) {
      const f = failureOf(flags);
      facts.flagsWhy = redact(f.rpcCode === NO_SUCH_METHOD ? "This Hermes advertises no feature flags (it has no gateway.capabilities)." : stateOfFailure(f).why);
    } else facts.flagsWhy = "Hermes answered gateway.capabilities with something other than a list of flags.";
    return facts;
  }

  private async probe(spec: CapabilitySpec, scope: Scope, run: number) {
    const probe = spec.probe!;
    const rev = this.revs.get(spec.id);
    let result: Omit<Capability, "id" | "checkedAt">;
    try {
      // The answer is checked for its shape and then let go: nothing of it is kept.
      const answer =
        probe.kind === "rest"
          ? JSON.parse(await within(this.io.get(probe.path(scope.profile), probe.maxBytes), this.timeoutMs))
          : await within(this.io.rpc(probe.method, probe.params(scope.profile)), this.timeoutMs);
      const lacking = probe.shape(answer) ? undefined : probe.lacks?.(answer);
      result = probe.shape(answer)
        ? { state: "supported", source: "probed", why: "Hermes answered the check." }
        : lacking
          ? { state: "unsupported", source: "probed", why: lacking }
          : { state: "unknown", source: "probed", why: "Hermes answered with something other than what this app reads, so it may have changed." };
    } catch (e) {
      result = { source: "probed", ...(e instanceof SyntaxError ? { state: "unknown", why: "Hermes answered with something that isn't JSON." } : stateOfFailure(failureOf(e))) };
    }
    // A screen's own answer that came in meanwhile is newer, and stands.
    if (this.current(scope, run) && this.revs.get(spec.id) === rev) this.found(spec.id, probeKey(spec), result);
  }
}

const STATE_TEXT: Record<CapabilityState, string> = {
  supported: "Supported",
  unsupported: "Not supported",
  unknown: "Unknown",
  unreachable: "Couldn't check",
};
export const stateText = (s: CapabilityState) => STATE_TEXT[s];

const SOURCE_TEXT: Record<CapabilitySource, string> = { advertised: "Hermes says so", probed: "checked", observed: "seen in use" };
export const sourceText = (s?: CapabilitySource) => (s ? SOURCE_TEXT[s] : "not checked yet");

export const protocolText = (p?: Protocol) =>
  p === "legacy" ? "Legacy session protocol" : p === "canonical" ? "Canonical session protocol (not supported)" : "Not known until connected";

/** The version as one line: the version and its build when they differ, or why it isn't known. */
export function versionLine(f: ServerFacts): string {
  const v = f.version ?? f.build;
  if (!v) return f.versionWhy ? `Not known: ${f.versionWhy}` : "Not read yet";
  return f.version && f.build && f.build !== f.version ? `${f.version} (${f.build})` : v;
}

/** The sign-in as one line: how this app signs in, and what the dashboard offers. */
export function authLine(f: ServerFacts, signIn: string): string {
  const gate = f.authRequired === false ? "; the dashboard doesn't ask for a sign-in" : f.authProviders?.length ? `; the dashboard offers ${f.authProviders.join(", ")}` : "";
  return `${signIn}${gate}`;
}

/**
 * The plain-text report Copy puts on the clipboard: what diagnostics shows, with anything secret-looking taken out.
 * `server`: the connection's address. `headers`: how many extra request headers it sends, never their values.
 */
export function reportText(snap: CapabilitySnapshot, ctx: { app: string; server?: string; signIn: string; headers: number; unsecure: boolean; profile: string }): string {
  const f = snap.facts;
  const when = (t?: number) => (t === undefined ? "not checked yet" : new Date(t).toISOString());
  const lines = [
    "Hermes Chat connection diagnostics",
    `App: ${ctx.app}`,
    `Server: ${ctx.server ?? "not connected"}${ctx.unsecure ? " (Unsecure)" : ""}`,
    `Profile: ${ctx.profile}`,
    `Hermes version: ${versionLine(f)}`,
    ...(f.commit ? [`Commit: ${f.commit}`] : []),
    ...(f.releaseDate ? [`Release date: ${f.releaseDate}`] : []),
    `Protocol: ${protocolText(f.protocol)}`,
    `Sign-in: ${authLine(f, ctx.signIn)}`,
    `Feature flags: ${f.flags ? (f.flags.length ? f.flags.join(", ") : "none turned on") : (f.flagsWhy ?? "not read yet")}`,
    `Extra request headers: ${ctx.headers} (values never shown)`,
    `Last checked: ${when(snap.checkedAt)}${snap.stale ? " (not connected now: as last checked)" : ""}`,
    "",
    ...CAPABILITIES.map((c) => {
      const cap = snap.caps[c.id];
      return `${c.label}: ${stateText(cap.state)} (${sourceText(cap.source)}${cap.checkedAt ? `, ${when(cap.checkedAt)}` : ""})${cap.why ? ` - ${cap.why}` : ""}`;
    }),
  ];
  return redact(lines.join("\n"));
}
