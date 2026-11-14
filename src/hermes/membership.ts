import { isObj, nonEmptyText } from "./values";
import type { AppMethod } from "./canonicalVerbs";
// Which chats are in which project, kept by Hermes so every computer shows the same (ADR 0109, #84).
//
// Hermes at the deployed `bf0203a`, and upstream at `9302ba9e` (2026-11-03), has no record linking a project to its
// chats: `projects.db` holds projects and folders only, and the official desktop groups chats by their working folder.
// So this module speaks a proposed contract, `projects.membership.list` and `projects.membership.apply`, written down in
// ADR 0109. A Hermes without it answers JSON-RPC "method not found", and the app then keeps membership on this computer
// as before (projectLinks.ts). Nothing here guesses at a store Hermes doesn't have.
//
// Changes are operations, not copies of the whole list. Each says what the owner wants (`member`) and the membership
// revision this computer had last read (`base`). Hermes applies it unless another client changed the same link after
// that revision to something else; then the operation is a conflict, and Hermes's state stands until the owner picks.

/** One chat in one project. */
export type Link = { projectId: string; chatId: string };

/**
 * A membership change not yet confirmed by Hermes. `member`: what the owner wants. `base`: the membership revision this
 * computer had read when the owner made it. `sent`: it went to Hermes at least once, and may have been applied though
 * no answer came back, so it is never cancelled, only retried under its id or followed. `conflict`: another client
 * changed the link after `base`, to `serverMember`, at revision `rev`.
 */
export type MembershipOp = {
  opId: string;
  projectId: string;
  chatId: string;
  member: boolean;
  base: number;
  at: number;
  sent?: true;
  conflict?: { serverMember: boolean; rev: number };
};

/** One link, as a key. */
export const linkKey = (l: Link) => `${l.projectId}\n${l.chatId}`;

/** What Hermes answers for one operation (ADR 0109). `rev`: the revision of the link's last change, 0 for never. */
export type OpStatus = "applied" | "unchanged" | "conflict" | "no_project" | "no_session";
export type OpResult = { opId: string; status: OpStatus; member: boolean; rev: number };

/** Hermes's membership store for one profile. */
export type MembershipApi = {
  /** Every link Hermes has in the profile. Rejects with `MembershipUnsupportedError` on a Hermes without the store. */
  list(profile: string): Promise<{ revision: number; links: Link[] }>;
  /** Applies `ops` in order, in one transaction. Retrying an op id answers its first result again. */
  apply(profile: string, ops: MembershipOp[]): Promise<{ revision: number; results: OpResult[] }>;
};

/** The version of the move of this computer's membership to Hermes. Bump it to offer the move again. */
export const MEMBERSHIP_MIGRATION = 1;

/** The most operations sent in one `apply`; the contract caps it at this too. */
export const APPLY_BATCH = 200;

/** Hermes has no membership store: it answered "method not found". */
export class MembershipUnsupportedError extends Error {
  constructor() {
    super("This Hermes doesn't keep which chats are in a project, so they're kept on this computer.");
  }
}

const STATUSES: readonly OpStatus[] = ["applied", "unchanged", "conflict", "no_project", "no_session"];

function toLink(v: unknown): Link | undefined {
  if (!isObj(v)) return undefined;
  const projectId = nonEmptyText(v.project_id, 400);
  const chatId = nonEmptyText(v.session_id, 400);
  return projectId && chatId ? { projectId, chatId } : undefined;
}

function toResult(v: unknown): OpResult | undefined {
  if (!isObj(v)) return undefined;
  const opId = nonEmptyText(v.op_id, 400);
  const status = STATUSES.find((s) => s === v.status);
  return opId && status ? { opId, status, member: v.member === true, rev: Number(v.rev) || 0 } : undefined;
}

/** The membership calls over the dashboard's legacy JSON-RPC. */
export function membershipApi(rpc: (method: AppMethod, params: Record<string, unknown>) => Promise<unknown>): MembershipApi {
  const call = async (method: AppMethod, params: Record<string, unknown>) => {
    try {
      return await rpc(method, params);
    } catch (e) {
      if (isObj(e) && e.code === -32601) throw new MembershipUnsupportedError();
      throw e;
    }
  };
  return {
    list: async (profile) => {
      const res = await call("projects.membership.list", { profile });
      if (!isObj(res) || !Array.isArray(res.links)) throw new Error("Hermes answered without a list of project chats.");
      return { revision: Number(res.revision) || 0, links: res.links.map(toLink).filter((l): l is Link => !!l) };
    },
    apply: async (profile, ops) => {
      const res = await call("projects.membership.apply", {
        profile,
        ops: ops.map((o) => ({ op_id: o.opId, project_id: o.projectId, session_id: o.chatId, member: o.member, base_revision: o.base })),
      });
      if (!isObj(res) || !Array.isArray(res.results)) throw new Error("Hermes answered without the results of the changes.");
      return { revision: Number(res.revision) || 0, results: res.results.map(toResult).filter((r): r is OpResult => !!r) };
    },
  };
}

/** Links as a project → chats map, each list newest first as given. */
export function toChats(links: Iterable<Link>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const { projectId, chatId } of links) (out[projectId] ??= []).includes(chatId) || out[projectId].push(chatId);
  return out;
}

/** Both groupings' links, each once. */
export function mergeChats(a: Readonly<Record<string, readonly string[]>>, b: Readonly<Record<string, readonly string[]>>): Record<string, string[]> {
  return toChats([...toLinks(a), ...toLinks(b)]);
}

export function toLinks(chats: Readonly<Record<string, readonly string[]>>): Link[] {
  return Object.entries(chats).flatMap(([projectId, ids]) => ids.map((chatId) => ({ projectId, chatId })));
}

const has = (chats: Readonly<Record<string, readonly string[]>>, l: Link) => !!chats[l.projectId]?.includes(l.chatId);

/**
 * What the list shows: Hermes's links as last read, with the changes not yet confirmed laid over them in order. A
 * conflict isn't laid over: Hermes's state stands until the owner chooses.
 */
export function effectiveChats(server: Readonly<Record<string, readonly string[]>>, pending: readonly MembershipOp[]): Record<string, string[]> {
  const out: Record<string, string[]> = Object.fromEntries(Object.entries(server).map(([p, ids]) => [p, [...ids]]));
  for (const op of pending) {
    if (op.conflict) continue;
    const ids = (out[op.projectId] ?? []).filter((c) => c !== op.chatId);
    out[op.projectId] = op.member ? [op.chatId, ...ids] : ids;
    if (!out[op.projectId].length) delete out[op.projectId];
  }
  return out;
}

/**
 * Adds the owner's change of one link to the pending operations. `hermes`: whether Hermes had the chat in the project
 * when last read; `base`: the revision that state is known at.
 * - A change not sent yet is replaced, keeping its base; one that puts the link back as it was before it (the change
 *   sent before it, or Hermes's state) cancels it.
 * - A change that was sent may already be applied, so the new one follows it, and is rebased on its answer.
 * - Choosing again on a conflict settles it: the owner has seen what Hermes has, so the choice is based on the
 *   conflict's revision.
 */
export function addOp(
  pending: readonly MembershipOp[],
  next: Omit<MembershipOp, "base" | "conflict" | "sent">,
  hermes: boolean,
  base: number,
): MembershipOp[] {
  const mine = pending.filter((o) => linkKey(o) === linkKey(next));
  const last = mine[mine.length - 1];
  if (last?.conflict) {
    const rest = pending.filter((o) => o !== last);
    return next.member === last.conflict.serverMember ? rest : [...rest, { ...next, base: last.conflict.rev }];
  }
  if (last && !last.sent) {
    const prev = mine[mine.length - 2];
    const before = prev ? prev.member : hermes;
    const rest = pending.filter((o) => o !== last);
    return next.member === before ? rest : [...rest, { ...next, base: last.base }];
  }
  if (last) return next.member === last.member ? [...pending] : [...pending, { ...next, base: last.base }];
  return next.member === hermes ? [...pending] : [...pending, { ...next, base }];
}

/**
 * The operations to send now: for each link, its first pending operation, unless that is a conflict. A later change of
 * the same link waits for the answer to the one before it, and is rebased on it, so it is never taken for another
 * client's change.
 */
export function nextBatch(pending: readonly MembershipOp[], skip: ReadonlySet<string>): MembershipOp[] {
  const seen = new Set<string>();
  const out: MembershipOp[] = [];
  for (const o of pending) {
    const k = linkKey(o);
    if (seen.has(k)) continue;
    seen.add(k);
    if (!o.conflict && !skip.has(o.opId)) out.push(o);
  }
  return out.slice(0, APPLY_BATCH);
}

/** The migration of this computer's membership to Hermes, as the owner is shown it before it runs. */
export type MigrationPreview = {
  /** Links this computer has that Hermes doesn't: sent to Hermes. */
  add: Link[];
  /** Links both have: nothing is sent, so Hermes keeps one record of each. */
  already: Link[];
  /** Links only Hermes has, put there by another computer: kept, and shown here from now on. */
  serverOnly: Link[];
  /** Links to a project Hermes no longer has: not sent; kept in the recovery copy. */
  noProject: Link[];
};

/** Compares this computer's links with Hermes's, for the preview. `projects`: the ids Hermes listed. */
export function planMigration(
  local: Readonly<Record<string, readonly string[]>>,
  server: readonly Link[],
  projects: ReadonlySet<string>,
): MigrationPreview {
  const onServer = toChats(server);
  const plan: MigrationPreview = { add: [], already: [], serverOnly: [], noProject: [] };
  for (const l of toLinks(local)) {
    if (!projects.has(l.projectId)) plan.noProject.push(l);
    else if (has(onServer, l)) plan.already.push(l);
    else plan.add.push(l);
  }
  plan.serverOnly = server.filter((l) => !has(local, l));
  return plan;
}

let opSeq = 0;
/** A fresh operation id: unique across computers, so Hermes can answer a retried op from its first result. */
export function newOpId(): string {
  const rand = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${rand}-${(++opSeq).toString(36)}`;
}
