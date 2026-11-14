// Settings → Toolsets: which toolsets Hermes offers the model, for one profile, read from and written to dashboard
// REST on the deployed `bf0203a` (`hermes_cli/web_routers/tools.py`):
//
// - `GET /api/tools/toolsets?profile=` lists the configurable toolsets with `enabled` as Hermes resolves it now
//   (`_get_platform_tools`, after `agent.disabled_toolsets`), and `configured` (its keys or provider are set up).
// - `PUT /api/tools/toolsets/{name}?profile=` with `{enabled}` adds or removes one toolset from the profile's
//   `platform_toolsets.<platform>` in its config.yaml, under the config mutation lock, keeping every other entry
//   (`_save_platform_tools`). The config-only `stt` flips `stt.enabled` instead. Enabling may start a background
//   `hermes tools post-setup` install on the server (`post_setup_started`).
// - `GET /api/tools/toolsets/{name}/config?profile=` lists its providers and their readiness, used here to show a
//   provider that still needs setup and to warn before an enable that may start an install. Env vars come as `is_set`
//   flags, never values.
// - Two facts of the profile's config come from Rust (`Pipe.toolsetGuards`), never the config itself: which platforms'
//   lists name `no_mcp`, which any toggle clears (`_save_platform_tools`), and whether coding focus mode swaps the list.
//
// What the setting reaches: `platform` is `cli` for nearly every toolset, and `platform_toolsets.cli` is what Hermes
// builds this app's chats with (`tui_gateway/agent_factory._load_enabled_toolsets`), as well as the CLI, the TUI and
// the official desktop app. A toolset restricted to another platform (Discord's) targets that platform instead. An
// agent's toolsets are fixed when Hermes builds it, so a chat Hermes already has open, and any reply running in it,
// keeps the tools it started with; new chats get the change. The list is the profile's default: a server started with
// `HERMES_TUI_TOOLSETS` uses that list instead, and with `agent.coding_context: focus` Hermes picks a coding selection in
// a code workspace (`_load_enabled_toolsets` checks both first).
//
// What one open chat has is a separate read, over the WS socket: `tools.show {session_id}` lists the tools Hermes offers
// that chat's agent (the toolsets it was built with, less `agent.disabled_toolsets` and tools whose requirements aren't
// met), or, before its agent is built, what the profile would build it with. Hermes has no write for one chat that keeps
// the conversation (`tools.configure` with a session rebuilds the agent and clears its in-memory history), and none for
// the whole server (`HERMES_TUI_TOOLSETS` is the dashboard process's environment), so neither is offered here.
//
// Nothing is taken on trust: every change is checked against a fresh read first (another client may have changed it),
// and reported as saved only once a read afterwards shows it.

import { RestError, type ToolsetGuards } from "./pipe";
import { errorText, textOrEmpty } from "./values";
import type { AppMethod } from "./canonicalVerbs";

export type { ToolsetGuards };

/** One toolset as Hermes lists it for a profile. */
export type Toolset = {
  name: string;
  label: string;
  description: string;
  /** The platform whose toolset list the switch writes: `cli` for this app's chats. */
  platform: string;
  platformLabel: string;
  /** On for `platform`, as Hermes resolves it now. */
  enabled: boolean;
  /** Its API keys or provider are set up; when false its tools may not be offered even while on. */
  configured: boolean;
  tools: string[];
  /** A setting with no tools of its own (`stt`): the switch is its config section's `enabled` flag. */
  configOnly: boolean;
};

/** Whether this server takes toolset changes from this app, and if not, why. */
export type WriteSupport = { ok: true } | { ok: false; reason: string };

export type ToolsetList = { profile: string; toolsets: Toolset[]; readAt: number };

/** What a change came to. Every kind but `unknown` carries what Hermes has now, read after the attempt. */
export type ToolsetChange =
  /**
   * Read back as asked. `installing`: Hermes started a background install for it on the server. `warning`: Hermes
   * answered with this error, yet reads it back as asked. `mcpBack`: the platform's `no_mcp` was cleared by the save.
   * `everywhereBack`: the save removed it from `agent.disabled_toolsets`, so it's back on every platform that lists it.
   */
  | { kind: "saved"; list: ToolsetList; installing?: string; warning?: string; mcpBack?: boolean; everywhereBack?: boolean }
  /**
   * Not sent: checked again just before the write, the change now needs the owner to confirm something they weren't
   * asked about (`cautions`, all of them, to ask again).
   */
  | { kind: "confirm"; cautions: Caution[]; list: ToolsetList }
  /** Not sent: Hermes already had it otherwise, or no longer lists it; another client changed it. */
  | { kind: "conflict"; list: ToolsetList; now?: boolean }
  /** Refused with a 4xx, which Hermes answers before writing; `list`, when it could be read again. */
  | { kind: "rejected"; reason: string; list?: ToolsetList }
  /** Sent and accepted, but Hermes reads it back the other way. */
  | { kind: "mismatch"; list: ToolsetList }
  /**
   * Hermes didn't confirm it: the answer was lost, or a server error, and a read afterwards (`list`, if any) doesn't
   * show it as asked. It may have been written, or may yet land.
   */
  | { kind: "unknown"; reason: string; list?: ToolsetList };

/** A change being written, one at a time for the whole app (`ToolsetsApi.pending`). */
export type Pending = { profile: string; name: string; enabled: boolean };

/**
 * What to tell the owner before a change is sent, for them to confirm. `install`: Hermes will start installing these on
 * the server. `noMcp`: the save clears the platform's `no_mcp`, so MCP servers come back. `everywhere`: the toolset is in
 * `agent.disabled_toolsets`, and turning it on removes it from that list, so it comes back on every platform that lists
 * it, not only this app's chats. `unchecked`: what couldn't be checked, so any of these may happen.
 */
export type Caution =
  | { kind: "install"; keys: string[] }
  | { kind: "noMcp"; platform: string }
  | { kind: "everywhere"; name: string }
  | { kind: "unchecked"; what: string };

/** A caution's identity, to tell whether the owner already confirmed it. */
const cautionKey = (c: Caution) =>
  c.kind === "install"
    ? `install:${[...c.keys].sort().join(",")}`
    : c.kind === "noMcp"
      ? `noMcp:${c.platform}`
      : c.kind === "everywhere"
        ? `everywhere:${c.name}`
        : `unchecked:${c.what}`;

/** The toolsets whose providers Hermes checks for readiness at `bf0203a` (`TOOL_CATEGORIES`). */
const PROVIDER_TOOLSETS = ["web", "browser", "image_gen", "video_gen", "x_search", "tts", "stt", "computer_use"];

/** One JSON-RPC call over the connection's WS socket; resolves to the result, rejects with a `code` on Hermes's error. */
export type Rpc = (method: AppMethod, params: Record<string, unknown>) => Promise<unknown>;

/**
 * What one open chat is offered, read from Hermes. `read`: the tool names its agent has now. `closed`: Hermes no longer
 * has the chat open, so it gets the profile's list when it is opened again. `unsupported`: this Hermes doesn't say.
 */
export type ChatTools = { kind: "read"; tools: Set<string>; readAt: number } | { kind: "closed" } | { kind: "unsupported"; reason: string };

const rpcCode = (e: unknown) => (e && typeof e === "object" && typeof (e as { code?: unknown }).code === "number" ? (e as { code: number }).code : undefined);

/** One signed-in dashboard REST call; resolves to the parsed JSON body. */
export type Rest = (method: "GET" | "PUT", pathAndQuery: string, body?: unknown) => Promise<unknown>;

/** The toolset name the write-support check sends with an invalid body. Rust relays this name only with that body. */
export const PROBE_NAME = "__hermes_chat_probe__";
/** Names this app sends in a path: Hermes's own keys are all like this. Others are shown but can't be switched here. */
const SAFE_NAME = /^[A-Za-z0-9_.-]+$/;
export const changeableName = (name: string) => SAFE_NAME.test(name) && name !== "." && name !== ".." && name !== PROBE_NAME;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});

/** `_POST_SETUP_INSTALLED` at `bf0203a`: the installs the toggle route starts itself when they aren't done. */
const INSTALL_ON_ENABLE = new Set(["cua_driver"]);

/** `_CONFIG_ONLY_TOOLSETS` at `bf0203a`. */
const CONFIG_ONLY = new Set(["stt"]);

/** A failed dashboard call: the HTTP status and Hermes's reason when it answered, none when it couldn't be reached. */
export type Failure = { status?: number; reason: string; signedOut?: boolean; notRelayed?: boolean };

/** Reads a failed call: a dashboard answer (`RestError`), a call the relay refused to send, or neither. */
export function failureOf(e: unknown): Failure {
  const message = errorText(e);
  if (!(e instanceof RestError)) return /^Hermes Chat doesn't relay /.test(message) ? { reason: message, notRelayed: true } : { reason: message };
  if (e.status === 401) return { status: 401, reason: message, signedOut: true };
  let reason = e.detail;
  try {
    const d = JSON.parse(e.body).detail;
    if (Array.isArray(d)) reason = d.map((x) => textOrEmpty(obj(x).msg)).filter(Boolean).join("; ") || reason;
  } catch {
    // Not JSON, or cut short by the relay: the text as it came.
  }
  return { status: e.status, reason };
}

/** FastAPI's own "no such route", as opposed to a route refusing, which names its own reason. */
const noRoute = (f: Failure) => f.status === 405 || (f.status === 404 && f.reason === "Not Found");

export class UnsupportedServerError extends Error {}

function rowsFrom(res: unknown): Toolset[] {
  if (!Array.isArray(res)) throw new Error("Hermes answered with something other than a toolset list.");
  return res.flatMap((r): Toolset[] => {
    const row = obj(r);
    const name = textOrEmpty(row.name);
    if (!name || typeof row.enabled !== "boolean") return [];
    const platform = textOrEmpty(row.platform) || "cli";
    return [
      {
        name,
        label: textOrEmpty(row.label) || name,
        description: textOrEmpty(row.description),
        platform,
        platformLabel: textOrEmpty(row.platform_label) || platform,
        enabled: row.enabled,
        // Older servers may not say; then it isn't claimed to need setup.
        configured: row.configured !== false,
        tools: Array.isArray(row.tools) ? row.tools.filter((t): t is string => typeof t === "string") : [],
        configOnly: CONFIG_ONLY.has(name),
      },
    ];
  });
}

/** What a provider's readiness (`provider_readiness_status`) means for the owner. */
const READINESS: Record<string, string> = {
  needs_setup: "isn't installed or set up on the server",
  needs_keys: "has no API key on the server",
  needs_auth: "needs a sign-in on the server",
};

/**
 * Settings → Toolsets' reads and writes. Every call names its profile, so a profile switch can't redirect one. Writes go
 * one at a time for the whole app, whichever screen asked, and `pending` says which is on its way.
 */
export class ToolsetsApi {
  private queue: Promise<unknown> = Promise.resolve();
  private current?: Pending;
  private listeners = new Set<() => void>();

  constructor(
    private readonly rest: Rest,
    /** The profile's `no_mcp` platforms and coding focus, from Rust. */
    private readonly readGuards: (profile: string) => Promise<ToolsetGuards>,
    /** Called after a change Hermes may have taken, so cached reads that depend on it are dropped. */
    private readonly changed: (profile: string, name: string) => void = () => {},
    /** The WS socket, for what one open chat has (`chatTools`). */
    private readonly rpc?: Rpc,
    /**
     * Called as the write check starts, for where to say what it found: whether Hermes has the switch's route
     * (capabilities.ts `toolsetSwitches`). Asked at the start, so an answer that comes after a reconnect or profile
     * switch is told to the connection it went out on.
     */
    private readonly checkingWrites: () => (found: "supported" | "unsupported" | "unknown", why: string) => void = () => () => {},
  ) {}

  /**
   * The tools Hermes offers `profile`'s chat whose live session is `runtimeId`, from `tools.show`. Two limits of that
   * call are checked first:
   * - It picks the session's own toolsets, but checks each tool's requirements (keys, packages, plugins) as the profile
   *   the dashboard runs as (`get_tool_definitions` runs outside the session's profile scope). So it is read only for a
   *   chat of that profile (`GET /api/profiles/active` → `current`).
   * - It answers an id Hermes no longer holds with its launch profile's list instead of an error, so the answer counts
   *   only when `session.status` still finds the session after it: then it was there while `tools.show` read it.
   */
  async chatTools(profile: string, runtimeId: string): Promise<ChatTools> {
    if (!this.rpc) return { kind: "unsupported", reason: "This app can't ask Hermes about one chat here." };
    const served = textOrEmpty(obj(await this.rest("GET", "api/profiles/active")).current);
    if (served !== profile)
      return {
        kind: "unsupported",
        reason: `Hermes checks what a chat is offered as the profile its dashboard runs as${served && served !== "custom" ? `, ${served}` : ""}, so it can't say for certain for a chat in the ${profile} profile.`,
      };
    let shown: Json;
    try {
      shown = obj(await this.rpc("tools.show", { session_id: runtimeId }));
      await this.rpc("session.status", { session_id: runtimeId });
    } catch (e) {
      if (rpcCode(e) === -32601) return { kind: "unsupported", reason: "This Hermes server doesn't say which tools an open chat has." };
      if (rpcCode(e) === 4001) return { kind: "closed" };
      throw e;
    }
    if (!Array.isArray(shown.sections)) throw new Error("Hermes answered with something other than a tool list.");
    const tools = new Set(shown.sections.flatMap((s) => (Array.isArray(obj(s).tools) ? (obj(s).tools as unknown[]) : [])).map((t) => textOrEmpty(obj(t).name)).filter(Boolean));
    return { kind: "read", tools, readAt: Date.now() };
  }

  /** The change on its way, if any. */
  readonly pending = (): Pending | undefined => this.current;
  readonly subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  private setPending(p: Pending | undefined) {
    this.current = p;
    for (const fn of this.listeners) fn();
  }

  private path(profile: string, name?: string, rest = "") {
    const q = new URLSearchParams({ profile }).toString();
    return `api/tools/toolsets${name === undefined ? "" : `/${encodeURIComponent(name)}`}${rest}?${q}`;
  }

  /** `GET /api/tools/toolsets` for `profile`. A server without the route throws `UnsupportedServerError`. */
  async list(profile: string): Promise<ToolsetList> {
    try {
      return { profile, toolsets: rowsFrom(await this.rest("GET", this.path(profile))), readAt: Date.now() };
    } catch (e) {
      const f = failureOf(e);
      if (noRoute(f))
        throw new UnsupportedServerError(
          "This Hermes server doesn't list toolsets: it has no /api/tools/toolsets route. Updating Hermes adds it.",
        );
      throw new Error(f.reason);
    }
  }

  /** The profile's `no_mcp` platforms, coding focus and `agent.disabled_toolsets`; undefined when the config couldn't be read. */
  guards(profile: string): Promise<ToolsetGuards | undefined> {
    return this.readGuards(profile).then(
      (g) => ({ ...g, noMcpUnclear: g.noMcpUnclear ?? [], disabledEverywhere: g.disabledEverywhere ?? [], disabledUnclear: g.disabledUnclear ?? false }),
      () => undefined,
    );
  }

  /**
   * Whether the server has the route that changes a toolset, asked without changing anything: a `PUT` for a name no
   * toolset has, with an `enabled` that isn't true or false. FastAPI refuses the body (422) before the route runs; a
   * server that took the body would still refuse the unknown name (400) before reading the config.
   */
  async writeSupport(profile: string): Promise<WriteSupport> {
    const tell = this.checkingWrites();
    const found = (state: "supported" | "unsupported" | "unknown", support: WriteSupport): WriteSupport => {
      tell(state, support.ok ? "Hermes refused the write check before changing anything, as it does when it has the route." : support.reason);
      return support;
    };
    try {
      await this.rest("PUT", this.path(profile, PROBE_NAME), { enabled: "probe" });
      // Nothing should take that body; say so rather than guess.
      return found("unknown", { ok: false, reason: "Hermes answered the write check in a way this app doesn't expect, so it won't change toolsets." });
    } catch (e) {
      const f = failureOf(e);
      if (f.signedOut) throw e;
      if (f.status === 422 || f.status === 400) return found("supported", { ok: true });
      if (noRoute(f)) return found("unsupported", { ok: false, reason: "This Hermes server lists toolsets but has no route to change them. Updating Hermes adds it." });
      if (f.status === 403) return found("unknown", { ok: false, reason: `Hermes doesn't let this sign-in change toolsets: ${f.reason}` });
      if (f.status === undefined && !f.notRelayed) throw new Error(f.reason);
      return found("unknown", { ok: false, reason: `Hermes didn't take the write check: ${f.reason}` });
    }
  }

  private async providers(profile: string, name: string): Promise<{ rows: Json[]; active: string }> {
    const res = obj(await this.rest("GET", this.path(profile, name, "/config")));
    return { rows: Array.isArray(res.providers) ? res.providers.map(obj) : [], active: textOrEmpty(res.active_provider) };
  }

  /**
   * For each listed toolset with providers, what keeps the one Hermes would use from working: the active provider's
   * readiness, or, with none active, that no provider is ready. Toolsets without a problem, or whose providers couldn't
   * be read, are left out. Hermes's own `configured` only checks keys, so a keyless provider whose package is missing
   * (Local Whisper without faster-whisper) shows only here.
   */
  async setupProblems(profile: string, list: ToolsetList): Promise<Record<string, string>> {
    const names = list.toolsets.map((t) => t.name).filter((n) => PROVIDER_TOOLSETS.includes(n));
    const out: Record<string, string> = {};
    await Promise.all(
      names.map(async (name) => {
        const read = await this.providers(profile, name).catch(() => undefined);
        if (!read?.rows.length) return;
        // Hermes can have several providers active at once (web's search and extract each pick one), so every one
        // in use is checked; the none-ready rule is only for when none is active.
        const flagged = read.rows.filter((p) => p.is_active === true);
        const active = flagged.length ? flagged : read.rows.filter((p) => read.active && textOrEmpty(p.name) === read.active);
        if (active.length) {
          const bad = active.filter((p) => READINESS[textOrEmpty(p.status)]);
          if (bad.length === 1) out[name] = `Its provider, ${textOrEmpty(bad[0].name)}, ${READINESS[textOrEmpty(bad[0].status)]}.`;
          else if (bad.length) out[name] = `Its providers in use need setup: ${bad.map((p) => `${textOrEmpty(p.name)} ${READINESS[textOrEmpty(p.status)]}`).join("; ")}.`;
        } else if (!read.rows.some((p) => p.status === "ready")) {
          out[name] = "None of its providers is ready on the server.";
        }
      }),
    );
    return out;
  }

  /**
   * What to tell the owner before turning `t` to `enabled`. The toggle route installs only a `post_setup` with a
   * registered installed-check that fails (`_post_setup_already_installed`, which at `bf0203a` has one: `cua_driver`);
   * other providers that need setup, such as web's `ddgs`, are left to `hermes tools`. Whatever couldn't be checked is
   * said too, rather than assumed safe.
   */
  async cautions(profile: string, t: Toolset, enabled: boolean): Promise<Caution[]> {
    return (await this.cautionsAndGuards(profile, t, enabled)).cautions;
  }

  private async cautionsAndGuards(profile: string, t: Toolset, enabled: boolean): Promise<{ cautions: Caution[]; guards?: ToolsetGuards }> {
    if (t.configOnly) return { cautions: [] };
    const out: Caution[] = [];
    const [guards, installs] = await Promise.all([
      this.guards(profile),
      enabled
        ? this.providers(profile, t.name).then(
            ({ rows }) => [...new Set(rows.filter((p) => INSTALL_ON_ENABLE.has(textOrEmpty(p.post_setup)) && p.status === "needs_setup").map((p) => textOrEmpty(p.post_setup)))],
            () => undefined,
          )
        : Promise.resolve([] as string[]),
    ]);
    if (installs === undefined) out.push({ kind: "unchecked", what: `whether turning ${t.label} on starts an install on the server` });
    else if (installs.length) out.push({ kind: "install", keys: installs });
    if (!guards)
      out.push({
        kind: "unchecked",
        what: enabled
          ? `whether the profile has MCP servers turned off with no_mcp, which any change here clears, or ${t.label} turned off on every platform with agent.disabled_toolsets, which turning it on clears`
          : `whether the profile has MCP servers turned off with no_mcp, which any change here clears`,
      });
    else {
      if (guards.noMcp.includes(t.platform)) out.push({ kind: "noMcp", platform: t.platform });
      else if (guards.noMcpUnclear.includes(t.platform))
        out.push({
          kind: "unchecked",
          what: `whether the profile has MCP servers turned off for ${t.platformLabel} with no_mcp, which any change here clears: the profile saves that platform's list in a form this app can't read for certain`,
        });
      if (enabled && guards.disabledEverywhere.includes(t.name)) out.push({ kind: "everywhere", name: t.name });
      else if (enabled && guards.disabledUnclear)
        out.push({
          kind: "unchecked",
          what: `whether agent.disabled_toolsets turns ${t.label} off on every platform, which turning it on here clears: the profile saves that list in a form this app can't read for certain`,
        });
    }
    return { cautions: out, guards };
  }

  /**
   * Turns `name` on or off for `profile`, if Hermes still has it as `expected` (what the owner saw), then reads it back.
   * Sends nothing when it doesn't: another client changed it, and the owner sees that first. Changes wait their turn:
   * one is written at a time, so a later one is checked against what the earlier one left. `accepted`: the cautions the
   * owner confirmed; they are checked again just before the write, and anything new is asked about instead of sent.
   */
  set(profile: string, name: string, enabled: boolean, expected: boolean, accepted: Caution[] = []): Promise<ToolsetChange> {
    const run = async () => {
      this.setPending({ profile, name, enabled });
      try {
        return await this.write(profile, name, enabled, expected, accepted);
      } finally {
        this.setPending(undefined);
      }
    };
    const done = this.queue.then(run, run);
    this.queue = done.catch(() => {});
    return done;
  }

  private async write(profile: string, name: string, enabled: boolean, expected: boolean, accepted: Caution[]): Promise<ToolsetChange> {
    if (!changeableName(name)) return { kind: "rejected", reason: "This app can't send that toolset's name to Hermes." };
    const before = await this.list(profile);
    const row = before.toolsets.find((t) => t.name === name);
    if (!row) return { kind: "conflict", list: before };
    if (row.enabled !== expected) return { kind: "conflict", list: before, now: row.enabled };
    if (row.enabled === enabled) return { kind: "saved", list: before };
    // What the owner confirmed may no longer be all there is: another client may have set no_mcp, or an install may now
    // be due. Checked here, inside the queue, right before the write.
    const check = await this.cautionsAndGuards(profile, row, enabled);
    const covered = new Set(accepted.map(cautionKey));
    if (check.cautions.some((c) => !covered.has(cautionKey(c)))) return { kind: "confirm", cautions: check.cautions, list: before };
    const had = {
      noMcp: !row.configOnly && !!check.guards?.noMcp.includes(row.platform),
      everywhere: !row.configOnly && enabled && !!check.guards?.disabledEverywhere.includes(row.name),
    };

    let answer: Json;
    try {
      answer = obj(await this.rest("PUT", this.path(profile, name), { enabled }));
    } catch (e) {
      const f = failureOf(e);
      // Whatever the error, what Hermes has now is read back before saying what happened: an error answer is no proof
      // that nothing was written, and a lost answer no proof that it was. Only a request the relay refused never left.
      if (f.notRelayed) return { kind: "rejected", reason: f.reason };
      this.changed(profile, name);
      const list = await this.list(profile).catch(() => undefined);
      const now = list?.toolsets.find((t) => t.name === name)?.enabled;
      if (now === enabled) return { kind: "saved", list: list!, warning: f.reason, ...(await this.clearedBySave(profile, row, had)) };
      // A 4xx is answered before anything is written (validation, an unknown name, the sign-in). A lost answer or a
      // server error may have written it, even when the read shows otherwise (a composite in agent.disabled_toolsets).
      if (f.status === undefined || f.status >= 500) return { kind: "unknown", reason: f.reason, list };
      return { kind: "rejected", reason: f.reason, list };
    }
    this.changed(profile, name);
    const after = await this.list(profile).catch((e) => e as Error);
    if (after instanceof Error) return { kind: "unknown", reason: `Hermes took the change, but reading it back failed: ${after.message}` };
    const now = after.toolsets.find((t) => t.name === name);
    if (answer.ok !== true || now?.enabled !== enabled) return { kind: "mismatch", list: after };
    const installing = textOrEmpty(answer.post_setup_started);
    return { kind: "saved", list: after, ...(installing ? { installing } : {}), ...(await this.clearedBySave(profile, row, had)) };
  }

  /**
   * What else the save cleared, read back: the platform's `no_mcp`, and the toolset's name in `agent.disabled_toolsets`.
   * Nothing for what it didn't have, or when the config can't be read again, or read for certain.
   */
  private async clearedBySave(profile: string, row: Toolset, had: { noMcp: boolean; everywhere: boolean }): Promise<{ mcpBack?: boolean; everywhereBack?: boolean }> {
    if (!had.noMcp && !had.everywhere) return {};
    const now = await this.guards(profile);
    if (!now) return {};
    return {
      // Only a read that can tell: a list it can't read for certain may still name it.
      ...(had.noMcp && !now.noMcp.includes(row.platform) && !now.noMcpUnclear.includes(row.platform) ? { mcpBack: true } : {}),
      ...(had.everywhere && !now.disabledEverywhere.includes(row.name) && !now.disabledUnclear ? { everywhereBack: true } : {}),
    };
  }
}
