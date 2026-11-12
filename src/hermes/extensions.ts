// The extensions the owner installed and the ones running now (ADR 0126, sections 2 to 5). One `Extensions` per window.
// It keeps each extension's install record (version, grants, why it is disabled), starts its host frame on first use,
// brokers every call through extensionRpc.ts, and stops the frame on a missed deadline, a crash, a broken message, an
// idle spell, a grant change, a chat change, a disable or an uninstall. Until Delivery step 4 the only extensions are
// the bundled ones (bundledExtensions.ts): nothing installs from a file.
import { EXTENSION_API, installStatus, type ExtensionId, type InstallStatus, type Manifest, type Version } from "./extensionManifest";
import { isPermission, type Permission } from "./extensionPermissions";
import { answer, authorize, parseIncoming, refusal, request, RPC_LIMITS, type Params, type ViewNode } from "./extensionRpc";
import type { StartHost, Host } from "./extensionHost";
import { note as appNote, type Level } from "./logs";
import type { Item } from "./model";

export const TIMING = {
  activate: 5_000,
  call: 10_000,
  pingEvery: 10_000,
  ping: 5_000,
  idle: 5 * 60_000,
  failures: 3,
  failureWindow: 10 * 60_000,
} as const;

export const EXTENSIONS_KEY = "hermes-chat.extensions";

/** An extension the app can offer: its parsed manifest and its one script. */
export type Packaged = { manifest: Manifest; source: string };

/** The chat a call runs in, as the pane that started it sees it. `still` turns false once that pane leaves the chat. */
export type ChatContext = {
  connection: string;
  profile: string;
  chat: string;
  title: string;
  items(): readonly Item[];
  addToDraft(text: string): void;
  still(): boolean;
};

export type Runtime = { kind: "stopped"; why?: string } | { kind: "starting" } | { kind: "running" } | { kind: "failed"; reason: string; at: number };

export type ExtensionState = {
  manifest: Manifest;
  installed?: { grants: readonly Permission[]; status: InstallStatus };
  runtime: Runtime;
  /** The views its running worker has drawn, by view id, and the chat they are for. Empty when it isn't running. */
  views: Readonly<Record<string, readonly ViewNode[]>>;
  boundTo?: string;
};

export type Action = { kind: "command"; name: string; arg: string } | { kind: "render"; view: string };
export type RunResult = { note?: string; views: string[] };

type Record_ = { id: ExtensionId; version: Version; grants: Permission[]; disabled?: "owner" | "failures"; failures: number[]; activated?: Version };

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
type Live = {
  host: Host;
  scope: string;
  ctx: ChatContext;
  next: number;
  pending: Map<number, Pending>;
  rate: number[];
  views: Record<string, readonly ViewNode[]>;
  ready?: Promise<unknown>;
  ping?: ReturnType<typeof setInterval>;
  lastActive: number;
};
type Call = { id: string; ctx: ChatContext; label: string; updated: Set<string> };

const scopeOf = (c: ChatContext) => JSON.stringify([c.connection, c.profile, c.chat]);

function readRecords(storage: Storage | undefined): Record_[] {
  try {
    const v: unknown = JSON.parse(storage?.getItem(EXTENSIONS_KEY) ?? "null");
    if (typeof v !== "object" || v === null || !Array.isArray((v as { installed?: unknown }).installed)) return [];
    return ((v as { installed: unknown[] }).installed.filter((r) => typeof r === "object" && r !== null) as Partial<Record_>[]).flatMap((r) =>
      typeof r.id === "string" && typeof r.version === "string" && Array.isArray(r.grants)
        ? [{ id: r.id as ExtensionId, version: r.version as Version, grants: r.grants.filter((g) => typeof g === "string" && isPermission(g)), disabled: r.disabled === "owner" || r.disabled === "failures" ? r.disabled : undefined, failures: Array.isArray(r.failures) ? r.failures.filter((n) => typeof n === "number") : [], activated: typeof r.activated === "string" ? r.activated : undefined }]
        : [],
    ) as Record_[];
  } catch {
    return [];
  }
}

export class Extensions {
  private readonly catalogue: readonly Packaged[];
  private readonly startHost: StartHost;
  private readonly storage: Storage | undefined;
  private readonly log: (level: Level, text: string) => void;
  private records: Record_[];
  private readonly live = new Map<ExtensionId, Live>();
  private readonly calls = new Map<ExtensionId, Call>();
  private readonly runtimes = new Map<ExtensionId, Runtime>();
  private readonly shown = new Map<ExtensionId, number>();
  private readonly listeners = new Set<() => void>();
  private snap: readonly ExtensionState[] = [];

  constructor(o: { catalogue: readonly Packaged[]; startHost: StartHost; storage?: Storage; log?: (level: Level, text: string) => void }) {
    this.catalogue = o.catalogue;
    this.startHost = o.startHost;
    this.storage = o.storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
    this.log = o.log ?? ((level, text) => appNote(level, text));
    // A record for an extension the app no longer offers is kept, so its grants come back if it does again.
    this.records = readRecords(this.storage);
    this.build();
  }

  subscribe = (cb: () => void) => {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  };
  getSnapshot = () => this.snap;

  /** Installs a bundled extension with every permission its manifest asks for: the owner's one decision (section 3). */
  install(id: ExtensionId) {
    const p = this.packaged(id);
    if (!p || this.record(id)) return;
    this.records.push({ id, version: p.manifest.version, grants: [...p.manifest.permissions], failures: [] });
    this.log("INFO", `Extension ${id}: installed ${p.manifest.version} with ${p.manifest.permissions.join(", ") || "no permissions"}`);
    this.save();
  }

  uninstall(id: ExtensionId) {
    if (!this.record(id)) return;
    this.halt(id, { kind: "stopped", why: "uninstalled" });
    this.records = this.records.filter((r) => r.id !== id);
    this.log("INFO", `Extension ${id}: uninstalled`);
    this.save();
  }

  setEnabled(id: ExtensionId, on: boolean) {
    const r = this.record(id);
    if (!r) return;
    if (on) {
      r.disabled = undefined;
      r.failures = [];
      this.runtimes.set(id, { kind: "stopped" });
    } else {
      r.disabled = "owner";
      this.halt(id, { kind: "stopped", why: "disabled" });
    }
    this.log("INFO", `Extension ${id}: ${on ? "enabled" : "disabled"} by the owner`);
    this.save();
  }

  /** Grants or withdraws one permission the manifest asks for. Either way the extension restarts (section 3). */
  setGrant(id: ExtensionId, permission: Permission, on: boolean) {
    const r = this.record(id);
    const p = this.packaged(id);
    if (!r || !p || !p.manifest.permissions.includes(permission) || r.grants.includes(permission) === on) return;
    r.grants = on ? [...r.grants, permission] : r.grants.filter((g) => g !== permission);
    this.halt(id, { kind: "stopped", why: "its permissions changed" });
    this.log("INFO", `Extension ${id}: ${permission} ${on ? "granted" : "withdrawn"}`);
    this.save();
  }

  /** Whether a Preview shows one of this extension's views; a view on screen keeps it from stopping when idle. */
  setShown(id: ExtensionId, shown: boolean) {
    const n = (this.shown.get(id) ?? 0) + (shown ? 1 : -1);
    if (n > 0) this.shown.set(id, n);
    else this.shown.delete(id);
    const live = this.live.get(id);
    if (live && !shown) live.lastActive = Date.now();
  }

  /**
   * Runs one of the extension's commands, or renders a view, as the owner's action in `ctx`'s chat. Resolves with the
   * note to show and the views it drew; resolves with nothing once `ctx` has left the chat. Rejects saying why it
   * didn't run, or why the extension stopped.
   */
  async run(id: ExtensionId, action: Action, ctx: ChatContext): Promise<RunResult> {
    const p = this.packaged(id);
    const r = this.record(id);
    if (!p || !r) throw new Error("It isn't installed.");
    const status = installStatus(p.manifest, r.disabled);
    if (status.kind === "incompatible") throw new Error(`${p.manifest.name} needs extension API ${status.needsApi}, and this app runs ${status.runsApi}.`);
    if (status.kind === "disabled") throw new Error(`${p.manifest.name} is disabled${status.why === "failures" ? " after failing three times" : ""}. Enable it in Settings → Extensions.`);
    if (action.kind === "command" && !p.manifest.commands.some((c) => c.name === action.name)) throw new Error(`${p.manifest.name} has no command /${action.name}.`);
    if (action.kind === "render" && !p.manifest.views.some((v) => v.id === action.view)) throw new Error(`${p.manifest.name} has no view ${action.view}.`);
    const label = action.kind === "command" ? `/${action.name}` : `its ${action.view} view`;
    const open = this.calls.get(id);
    if (open && open.ctx.still()) throw new Error(`${p.manifest.name} is still answering ${open.label}.`);
    const call: Call = { id: crypto.randomUUID(), ctx, label, updated: new Set() };
    this.calls.set(id, call);
    try {
      const live = await this.ensure(id, ctx);
      const result = await this.ask(id, live, action.kind === "command" ? "command.run" : "view.render", action.kind === "command" ? { call: call.id, name: action.name, arg: action.arg } : { call: call.id, id: action.view }, TIMING.call, label);
      if (!ctx.still()) return { views: [] };
      const text = typeof result === "object" && result !== null ? (result as { text?: unknown }).text : undefined;
      return { note: typeof text === "string" && text ? text.slice(0, RPC_LIMITS.note) : undefined, views: [...call.updated] };
    } finally {
      if (this.calls.get(id) === call) this.calls.delete(id);
      const live = this.live.get(id);
      if (live) live.lastActive = Date.now();
    }
  }

  /** Runs `action` in the chat the extension's view was drawn for, as a click in that view does. */
  runInView(id: ExtensionId, action: Action): Promise<RunResult> {
    const live = this.live.get(id);
    if (!live || !live.ctx.still()) return Promise.reject(new Error(`Open the chat this view is for, then run its command again there.`));
    return this.run(id, action, live.ctx);
  }

  private packaged = (id: ExtensionId) => this.catalogue.find((p) => p.manifest.id === id);
  private record = (id: ExtensionId) => this.records.find((r) => r.id === id);

  private async ensure(id: ExtensionId, ctx: ChatContext): Promise<Live> {
    let live = this.live.get(id);
    // A running extension belongs to one chat (section 2): another chat gets a fresh worker and an empty view.
    if (live && live.scope !== scopeOf(ctx)) {
      this.halt(id, { kind: "stopped", why: "it was run in another chat" });
      live = undefined;
    }
    if (live) {
      live.ctx = ctx;
      await live.ready;
      return live;
    }
    const p = this.packaged(id)!;
    const r = this.record(id)!;
    const host = this.startHost(p.source);
    const fresh: Live = { host, scope: scopeOf(ctx), ctx, next: 0, pending: new Map(), rate: [], views: {}, lastActive: Date.now() };
    this.live.set(id, fresh);
    this.runtimes.set(id, { kind: "starting" });
    this.emit();
    host.onMessage((d) => this.receive(id, fresh, d));
    host.onCrash((why) => this.live.get(id) === fresh && this.fail(id, `threw an uncaught error: ${why}`));
    this.log("INFO", `Extension ${id}: starting ${p.manifest.version} for a call`);
    fresh.ready = this.ask(id, fresh, "activate", { api: EXTENSION_API, previousVersion: r.activated && r.activated !== p.manifest.version ? r.activated : null }, TIMING.activate, "activate").then(() => {
      if (this.live.get(id) !== fresh) return;
      r.activated = p.manifest.version;
      this.runtimes.set(id, { kind: "running" });
      fresh.ping = setInterval(() => this.tick(id, fresh), TIMING.pingEvery);
      this.save();
    });
    await fresh.ready;
    return fresh;
  }

  /** Every 10 s while running: stop after 5 idle minutes, else check it still answers (section 4). */
  private tick(id: ExtensionId, live: Live) {
    if (this.live.get(id) !== live) return clearInterval(live.ping);
    if (this.calls.has(id)) return;
    if (!this.shown.has(id) && Date.now() - live.lastActive >= TIMING.idle) return this.halt(id, { kind: "stopped", why: "idle for 5 minutes" });
    this.ask(id, live, "ping", {}, TIMING.ping, "ping").catch(() => {});
  }

  private ask(id: ExtensionId, live: Live, method: string, params: object, ms: number, label: string): Promise<unknown> {
    const n = ++live.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(id, `didn't answer ${label} within ${ms / 1000} s`), ms);
      live.pending.set(n, { resolve, reject, timer });
      live.host.send(request(n, method, params));
    });
  }

  private receive(id: ExtensionId, live: Live, data: unknown) {
    if (this.live.get(id) !== live) return;
    const now = Date.now();
    live.rate = live.rate.filter((t) => now - t < 1000);
    live.rate.push(now);
    if (live.rate.length > RPC_LIMITS.perSecond) return this.fail(id, `sent more than ${RPC_LIMITS.perSecond} messages in a second`);
    const m = parseIncoming(data);
    if (m.kind === "broken") return this.fail(id, m.why);
    if (m.kind !== "request") {
      const waiting = typeof m.id === "number" ? live.pending.get(m.id) : undefined;
      if (!waiting) return;
      live.pending.delete(m.id as number);
      clearTimeout(waiting.timer);
      if (m.kind === "result") waiting.resolve(m.result);
      else waiting.reject(new Error(m.message));
      return;
    }
    const call = this.calls.get(id);
    const openCall = call && call.ctx.still() && scopeOf(call.ctx) === live.scope ? call : undefined;
    const r = this.record(id)!;
    const auth = authorize(m.method, m.params, new Set(r.grants), openCall?.id);
    const reply = (text: string) => m.id !== undefined && live.host.send(text);
    if (!auth.ok) {
      if (auth.error === "permission_denied" || auth.error === "no_open_call") this.log("WARNING", `Extension ${id}: refused ${m.method}: ${auth.why}`);
      return reply(refusal(m.id ?? 0, auth.error, auth.why));
    }
    let result: unknown = null;
    switch (auth.method) {
      case "chat.read":
        result = openCall!.ctx
          .items()
          .flatMap((i) => ((i.kind === "user" && !i.outgoing) || i.kind === "assistant" ? [{ role: i.kind, text: i.text, at: i.at ?? null }] : []));
        break;
      case "chat.draft":
        openCall!.ctx.addToDraft((auth.params as Params<"chat.draft">).text);
        break;
      case "view.update": {
        const { id: view, nodes } = auth.params as Params<"view.update">;
        if (!this.packaged(id)!.manifest.views.some((v) => v.id === view)) return reply(refusal(m.id ?? 0, "invalid_params", `view.update names ${view}, which its manifest doesn't declare`));
        live.views = { ...live.views, [view]: nodes };
        openCall?.updated.add(view);
        this.emit();
        break;
      }
      case "log": {
        const { level, text } = auth.params as Params<"log">;
        this.log(level, `Extension ${id}: ${text}`);
        break;
      }
    }
    reply(answer(m.id ?? 0, result));
  }

  /** Stops the extension for a fault: a missed deadline, a crash or a broken message. Three in 10 minutes disable it. */
  private fail(id: ExtensionId, reason: string) {
    const r = this.record(id);
    const now = Date.now();
    this.halt(id, { kind: "failed", reason, at: now }, reason);
    this.log("WARNING", `Extension ${id}: stopped, it ${reason}`);
    if (!r) return;
    r.failures = [...r.failures.filter((t) => now - t < TIMING.failureWindow), now];
    if (r.failures.length >= TIMING.failures && !r.disabled) {
      r.disabled = "failures";
      this.log("WARNING", `Extension ${id}: disabled after ${TIMING.failures} failures in 10 minutes`);
    }
    this.save();
  }

  /** Removes the frame, which stops the worker, ends any open call and clears its views. */
  private halt(id: ExtensionId, next: Runtime, reason?: string) {
    const live = this.live.get(id);
    this.runtimes.set(id, next);
    this.calls.delete(id);
    if (live) {
      this.live.delete(id);
      clearInterval(live.ping);
      try {
        live.host.send(request(undefined, "deactivate", {}));
      } catch {
        // The port may be closed already.
      }
      live.host.remove();
      const name = this.packaged(id)?.manifest.name ?? id;
      const why = reason ? `${name} stopped: it ${reason}.` : `${name} stopped${next.kind === "stopped" && next.why ? `: ${next.why}` : ""}.`;
      for (const p of live.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(why));
      }
      if (next.kind === "stopped") this.log("INFO", `Extension ${id}: stopped${next.why ? `, ${next.why}` : ""}`);
    }
    this.emit();
  }

  private save() {
    try {
      this.storage?.setItem(EXTENSIONS_KEY, JSON.stringify({ v: 1, installed: this.records }));
    } catch {
      // A full or blocked storage keeps the records for this run only.
    }
    this.emit();
  }

  private build() {
    this.snap = this.catalogue.map(({ manifest }): ExtensionState => {
      const r = this.record(manifest.id);
      const live = this.live.get(manifest.id);
      return {
        manifest,
        installed: r && { grants: r.grants, status: installStatus(manifest, r.disabled) },
        runtime: this.runtimes.get(manifest.id) ?? { kind: "stopped" },
        views: live?.views ?? {},
        boundTo: live?.ctx.title,
      };
    });
  }

  private emit() {
    this.build();
    for (const l of this.listeners) l();
  }
}

/** An extension's command as the "/" menu offers it. */
export type OfferedCommand = { id: ExtensionId; extension: string; name: string; description: string; needs: Manifest["needs"] };

/**
 * The commands of the usable extensions, in the order they are listed, and the ones not offered because the name is
 * taken (section 5). `taken` says why a name belongs to the app or a skill; an extension listed earlier keeps a name
 * a later one also uses.
 */
export function offeredCommands(states: readonly ExtensionState[], taken: (name: string) => string | undefined) {
  const offered: OfferedCommand[] = [];
  const refused: { id: ExtensionId; name: string; why: string }[] = [];
  for (const s of states) {
    if (s.installed?.status.kind !== "usable") continue;
    for (const c of s.manifest.commands) {
      const earlier = offered.find((o) => o.name === c.name);
      const why = taken(c.name) ?? (earlier && `${earlier.extension} already has /${c.name}.`);
      if (why) refused.push({ id: s.manifest.id, name: c.name, why });
      else offered.push({ id: s.manifest.id, extension: s.manifest.name, name: c.name, description: c.description, needs: s.manifest.needs });
    }
  }
  return { offered, refused };
}
