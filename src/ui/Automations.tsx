// Automations (GLOSSARY.md "Automation", ADR 0108): Hermes webhook routes that start a task on the server when GitHub
// sends an event. Hermes verifies, filters and runs them in its gateway, also while Hermes Chat is closed; this screen
// sets them up, previews what an event would do, and shows what became of the events that arrived.
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, CircleAlert, Copy, History, Pause, Pencil, Play, Plus, RefreshCw, RotateCcw, Trash2, Webhook, X } from "lucide-react";
import {
  type Automation,
  AutomationError,
  type AutomationFields,
  type AutomationList,
  type AutomationsApi,
  type Coalesce,
  type Delivery,
  type DeliveryTarget,
  FILTER_OPS,
  type FilterOp,
  type FilterSpec,
  GITHUB_EVENTS,
  type History as DeliveryHistory,
  NAME_RE,
  REJECTION_LABELS,
  type Rejections,
  SAMPLE_EVENTS,
  SECRET_ENV_RE,
  fieldPaths,
  filterRow,
  parseFilterValue,
  preview,
  reasonText,
  sanitizeEvent,
  stateLabel,
  stockGaps,
  typedFilterValue,
} from "../hermes/automations";
import { Spinner } from "./bits";

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const when = (at: number) => new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });

type View = { kind: "list" } | { kind: "detail"; name: string } | { kind: "edit"; name?: string };
/** A secret Hermes just made, shown once. It lives in this screen's memory only, until the owner dismisses it. */
type OneTime = { name: string; secret: string };

function deliverLabel(id: string, targets: DeliveryTarget[]): string {
  if (id === "log") return "Saved in the gateway's log only";
  return targets.find((t) => t.id === id)?.name ?? id;
}

function rejectionLine(r: Rejections): string | undefined {
  const parts = (Object.keys(r) as (keyof Rejections)[]).filter((k) => r[k]!.count > 0).map((k) => `${r[k]!.count} ${REJECTION_LABELS[k]}`);
  return parts.length ? parts.join(", ") : undefined;
}

function lastRejected(r: Rejections): number | undefined {
  const times = Object.values(r).map((x) => x?.lastAt ?? 0).filter(Boolean);
  return times.length ? Math.max(...times) * 1000 : undefined;
}

/**
 * The profile's automations. `api` reaches Hermes; nothing here receives or runs events. App keys the screen on the
 * profile, so a late answer for another profile never lands here.
 */
export function Automations({
  api,
  profile,
  connected,
  onClose,
  onOpenChat,
}: {
  api: AutomationsApi;
  profile: string;
  connected: boolean;
  onClose: () => void;
  onOpenChat: (sessionId: string) => void;
}) {
  const [loaded, setLoaded] = useState<AutomationList>();
  const [targets, setTargets] = useState<DeliveryTarget[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error>();
  const [view, setView] = useState<View>({ kind: "list" });
  const [notice, setNotice] = useState<string>();
  const [oneTime, setOneTime] = useState<OneTime>();
  /** Bumped by an editor's Reload, so it starts again from the automation as Hermes has it now. */
  const [editGen, setEditGen] = useState(0);
  const live = useRef(true);
  const heading = useRef<HTMLHeadingElement>(null);
  const returnTo = useRef<string | undefined>(undefined);
  useEffect(() => {
    live.current = true;
    return () => void (live.current = false);
  }, []);

  const load = async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [list, t] = await Promise.all([api.list(profile), api.targets(profile).catch(() => [] as DeliveryTarget[])]);
      if (!live.current) return;
      setLoaded(list);
      setTargets(t);
    } catch (e) {
      if (live.current) setError(e as Error);
    } finally {
      if (live.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (connected) void load();
    else setLoading(false);
  }, [connected]);

  // Each view starts at its heading; back on the list, at the row it came from.
  useEffect(() => {
    if (view.kind === "list" && returnTo.current) {
      document.querySelector<HTMLButtonElement>(`[data-automation="${CSS.escape(returnTo.current)}"]`)?.focus();
      returnTo.current = undefined;
    } else if (view.kind !== "list") heading.current?.focus();
  }, [view]);

  const go = (v: View) => {
    if (view.kind !== "list" && v.kind === "list" && "name" in view) returnTo.current = view.name;
    setView(v);
  };

  const apply = (name: string, a: Automation | null) =>
    setLoaded((l) => l && { ...l, automations: a ? (l.automations.some((x) => x.name === name) ? l.automations.map((x) => (x.name === name ? a : x)) : [...l.automations, a]) : l.automations.filter((x) => x.name !== name) });

  const unsupported = error instanceof AutomationError && (error.kind === "unsupported" || error.kind === "forbidden");
  const shown = view.kind !== "list" && view.name ? loaded?.automations.find((a) => a.name === view.name) : undefined;

  return (
    <div className="settings jobs-screen automations-screen">
      <div className="settings-inner">
        <button className="back" onClick={view.kind === "list" ? onClose : () => go(view.kind === "edit" && view.name ? { kind: "detail", name: view.name } : { kind: "list" })}>
          <ArrowLeft size={15} /> {view.kind === "list" ? "Back to chat" : view.kind === "edit" && view.name ? "Back to the automation" : "Back to automations"}
        </button>
        {!connected && (
          <p className="job-banner" role="status">
            <CircleAlert size={14} /> Not connected to Hermes. Automations keep running on the server; reconnect to see or change them.
            {loaded && " What's below is as it was last read."}
          </p>
        )}
        {oneTime && (
          <div className="secret-once" role="alert" aria-label="The new secret, shown once">
            <p>
              <strong>Copy the secret for “{oneTime.name}” into GitHub now.</strong> Hermes keeps it on the server and won't show it again; Hermes Chat
              doesn't keep it either. It goes in the webhook's <em>Secret</em> field, never in the prompt.
            </p>
            <code className="secret-value">{oneTime.secret}</code>
            <div className="confirm-actions">
              <button className="btn" onClick={() => void navigator.clipboard?.writeText(oneTime.secret).catch(() => {})}>
                <Copy size={14} /> Copy secret
              </button>
              <button className="btn primary" onClick={() => setOneTime(undefined)}>
                <Check size={14} /> I've put it in GitHub
              </button>
            </div>
          </div>
        )}

        {view.kind === "list" && (
          <>
            <h1 className="project-title" ref={heading} tabIndex={-1}>
              <Webhook size={20} /> <span>Automations</span>
            </h1>
            <p className="muted">
              Tasks Hermes starts on the server, in the <span className="mono">{profile}</span> profile, when GitHub sends an event. Hermes checks each event's
              signature and runs the task there, also while Hermes Chat is closed.
            </p>
            {loaded && !loaded.platformEnabled && (
              <p className="job-banner" role="note">
                <CircleAlert size={14} /> Webhooks are turned off for this profile in Hermes, so no automation receives events. Turn them on in Hermes (its
                dashboard's Webhooks page, or <span className="mono">hermes gateway setup</span>); that restarts the gateway.
              </p>
            )}
            {loaded && !loaded.contract && (
              <p className="job-banner" role="note">
                <CircleAlert size={14} /> This Hermes server keeps no record of deliveries and can't filter, coalesce or edit an automation in place. History
                shows the tasks each automation started. Hermes with <span className="mono">webhooks/1</span> adds the rest.
              </p>
            )}
            {!unsupported && (
              <div className="jobs-actions">
                <button className="btn primary" disabled={!connected || !loaded} onClick={() => go({ kind: "edit" })}>
                  <Plus size={14} /> New automation
                </button>
                <button className="btn" disabled={!connected || loading} onClick={() => void load()}>
                  <RefreshCw size={14} /> Refresh
                </button>
              </div>
            )}
            {notice && (
              <p className="job-notice" role="status">
                {notice}
              </p>
            )}
            {loading && !loaded && (
              <div className="empty-hint" role="status">
                <Spinner /> Loading the automations…
              </div>
            )}
            {error && (
              <div className="job-error" role="alert">
                <p>{messageOf(error)}</p>
                {!unsupported && connected && (
                  <button className="btn" onClick={() => void load()}>
                    Try again
                  </button>
                )}
              </div>
            )}
            {loaded && !loaded.automations.length && !error && (
              <div className="empty-hint jobs-empty">No automations in this profile yet. An automation turns an event GitHub sends, such as a new issue, into a task for Hermes.</div>
            )}
            {loaded && loaded.automations.length > 0 && (
              <ul className="job-list">
                {loaded.automations.map((a) => {
                  const refused = rejectionLine(a.rejections);
                  return (
                    <li key={a.name}>
                      <button className="job-row" data-automation={a.name} onClick={() => go({ kind: "detail", name: a.name })}>
                        <div className="job-row-head">
                          <span className="job-name">{a.name}</span>
                          {!a.enabled && <span className="badge">Paused</span>}
                          {a.kind !== "agent" && <span className="badge off">{a.kind === "cron_job" ? "Runs a job" : "Sends a message"}</span>}
                        </div>
                        <div className="job-row-line">
                          {a.provider === "github" ? "GitHub" : "Any signed sender"}: {a.events.length ? a.events.join(", ") : "every event"}
                          {a.filters.length > 0 && <span className="faint"> · {a.filters.length} {a.filters.length === 1 ? "filter" : "filters"}</span>}
                          {a.coalesce && <span className="faint"> · coalesced</span>}
                        </div>
                        <div className="job-row-line small">
                          {a.lastReceivedAt ? <>Last event: {when(a.lastReceivedAt)}</> : <span className="faint">{loaded.contract ? "No events yet" : "Hermes doesn't record events here"}</span>}
                          <span className="faint"> · {deliverLabel(a.deliver, targets)}</span>
                        </div>
                        {refused && <div className="job-row-line small warn-note">Refused: {refused}</div>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}

        {view.kind === "detail" && loaded && shown && (
          <Detail
            key={shown.name}
            api={api}
            profile={profile}
            connected={connected}
            automation={shown}
            list={loaded}
            targets={targets}
            heading={heading}
            onChanged={apply}
            onEdit={() => go({ kind: "edit", name: shown.name })}
            onSecret={(secret) => setOneTime({ name: shown.name, secret })}
            onDeleted={(name) => {
              setNotice(`Deleted “${name}”. Hermes no longer accepts its events${loaded.contract ? ", and its delivery history went with it" : ""}.`);
              go({ kind: "list" });
            }}
            onOpenChat={onOpenChat}
          />
        )}
        {view.kind === "detail" && loaded && !shown && <p className="muted">This automation isn't in the list any more: it was deleted in another Hermes client.</p>}
        {view.kind === "edit" && loaded && (view.name === undefined || shown) && (
          <Editor
            key={`${view.name ?? "new"}:${editGen}`}
            api={api}
            profile={profile}
            connected={connected}
            base={shown}
            list={loaded}
            targets={targets}
            heading={heading}
            onSaved={(saved) => {
              apply(saved.automation.name, saved.automation);
              if (saved.secret) setOneTime({ name: saved.automation.name, secret: saved.secret });
              setNotice(saved.note);
              go({ kind: "detail", name: saved.automation.name });
            }}
            onSeen={(a) => apply(a.name, a)}
            onSecret={(name, secret) => setOneTime({ name, secret })}
            onReload={() => setEditGen((g) => g + 1)}
            onCancel={() => go(view.name ? { kind: "detail", name: view.name } : { kind: "list" })}
          />
        )}
        {view.kind !== "list" && notice && (
          <p className="job-notice" role="status">
            {notice}
          </p>
        )}
      </div>
    </div>
  );
}

function describeFilter(spec: FilterSpec): string {
  const row = filterRow(spec);
  if (!row) return JSON.stringify(spec);
  const op = FILTER_OPS.find((o) => o.op === row.op)!;
  return op.takes === "none" ? `${row.field} ${op.label}` : `${row.field} ${op.label} ${typedFilterValue(row.op, row.value)}`;
}

function Detail({
  api,
  profile,
  connected,
  automation: a,
  list,
  targets,
  heading,
  onChanged,
  onEdit,
  onSecret,
  onDeleted,
  onOpenChat,
}: {
  api: AutomationsApi;
  profile: string;
  connected: boolean;
  automation: Automation;
  list: AutomationList;
  targets: DeliveryTarget[];
  heading: RefObject<HTMLHeadingElement | null>;
  onChanged: (name: string, a: Automation | null) => void;
  onEdit: () => void;
  onSecret: (secret: string) => void;
  onDeleted: (name: string) => void;
  onOpenChat: (sessionId: string) => void;
}) {
  const [busy, setBusy] = useState<"pause" | "resume" | "delete" | "rotate">();
  const [confirm, setConfirm] = useState<"delete" | "rotate">();
  const [error, setError] = useState<string>();
  const offline = connected ? undefined : "Connect to Hermes to change this automation.";
  const envName = a.secretRef.startsWith("env:") ? a.secretRef.slice(4) : undefined;

  const act = async (what: NonNullable<typeof busy>, fn: () => Promise<void>) => {
    setBusy(what);
    setError(undefined);
    setConfirm(undefined);
    try {
      await fn();
    } catch (e) {
      setError(messageOf(e));
      if (e instanceof AutomationError && e.secret) onSecret(e.secret);
      if (e instanceof AutomationError && e.kind === "gone") onChanged(a.name, null);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <>
      <h1 className="project-title" ref={heading} tabIndex={-1}>
        <Webhook size={20} /> <span>{a.name}</span> {!a.enabled && <span className="badge">Paused</span>}
      </h1>
      <div className="jobs-actions">
        <button className="btn" disabled={!connected || !!busy || a.kind !== "agent"} title={a.kind !== "agent" ? "Set up in another Hermes client: Hermes Chat edits task automations only." : offline} onClick={onEdit}>
          <Pencil size={14} /> Edit
        </button>
        <button className="btn" disabled={!connected || !!busy} title={offline} onClick={() => void act(a.enabled ? "pause" : "resume", async () => onChanged(a.name, await api.setPaused(profile, a, a.enabled)))}>
          {a.enabled ? <Pause size={14} /> : <Play size={14} />} {busy === "pause" ? "Pausing…" : busy === "resume" ? "Resuming…" : a.enabled ? "Pause" : "Resume"}
        </button>
        <button className="btn danger" disabled={!connected || !!busy} title={offline} onClick={() => setConfirm("delete")}>
          <Trash2 size={14} /> {busy === "delete" ? "Deleting…" : "Delete"}
        </button>
      </div>
      {!a.enabled && (
        <p className="muted small">
          Paused: Hermes refuses its events (GitHub sees a 403 and lists them as failed under Recent Deliveries, where they can be redelivered after you resume).
          Tasks already queued or running carry on.
        </p>
      )}
      {confirm === "delete" && (
        <div className="confirm" role="alertdialog" aria-label="Delete this automation?" onKeyDown={(e) => e.key === "Escape" && setConfirm(undefined)}>
          <span>
            Delete “{a.name}”? Hermes stops accepting its events in every Hermes client{list.contract ? " and deletes its delivery history" : ""}. Chats it
            already started stay. This can't be undone; remove the webhook in GitHub too.
          </span>
          <div className="confirm-actions">
            <button className="btn" autoFocus onClick={() => setConfirm(undefined)}>
              Cancel
            </button>
            <button
              className="btn danger"
              onClick={() =>
                void act("delete", async () => {
                  await api.remove(profile, a);
                  onChanged(a.name, null);
                  onDeleted(a.name);
                })
              }
            >
              Delete automation
            </button>
          </div>
        </div>
      )}
      {confirm === "rotate" && (
        <div className="confirm" role="alertdialog" aria-label="Make a new secret?" onKeyDown={(e) => e.key === "Escape" && setConfirm(undefined)}>
          <span>Make a new secret for “{a.name}”? Events GitHub signs with the old one are refused from now on, until you put the new one in GitHub.</span>
          <div className="confirm-actions">
            <button className="btn" autoFocus onClick={() => setConfirm(undefined)}>
              Cancel
            </button>
            <button
              className="btn primary"
              onClick={() =>
                void act("rotate", async () => {
                  const saved = await api.rotateSecret(profile, a);
                  onChanged(a.name, saved.automation);
                  if (saved.secret) onSecret(saved.secret);
                })
              }
            >
              Make a new secret
            </button>
          </div>
        </div>
      )}
      {error && (
        <p className="sign-in-error small" role="alert">
          {error}
        </p>
      )}

      <section>
        <h2>Set it up in GitHub</h2>
        <p className="muted small">In the repository: Settings → Webhooks → Add webhook.</p>
        <dl className="job-kept automation-setup">
          <div>
            <dt>Payload URL</dt>
            <dd>
              {a.url}{" "}
              <button className="icon-btn inline" title="Copy the URL" aria-label="Copy the payload URL" onClick={() => void navigator.clipboard?.writeText(a.url).catch(() => {})}>
                <Copy size={13} />
              </button>
            </dd>
          </div>
          <div>
            <dt>Content type</dt>
            <dd>application/json</dd>
          </div>
          <div>
            <dt>Secret</dt>
            <dd>
              {envName ? (
                <>
                  Read on the server from <span className="mono">{envName}</span>
                  {a.secretEnvSet === false && <span className="warn-note"> · not set where the dashboard can see it</span>}
                </>
              ) : a.secretSet ? (
                "Hermes keeps it; it was shown once, when it was made."
              ) : (
                <span className="bad">None: Hermes refuses every event.</span>
              )}
            </dd>
          </div>
          <div>
            <dt>Events</dt>
            <dd>{a.events.length ? a.events.join(", ") : "Send me everything"}</dd>
          </div>
        </dl>
        {list.contract && !envName && (
          <button className="btn" disabled={!connected || !!busy} title={offline} onClick={() => setConfirm("rotate")}>
            <RotateCcw size={14} /> {busy === "rotate" ? "Making a new secret…" : "Make a new secret"}
          </button>
        )}
        <p className="muted small">
          The URL is as this profile's gateway names its listener ({list.baseUrl || "unknown"}). GitHub must be able to reach it: a server on a private network
          needs a public address or a tunnel in front of port {(() => {
            try {
              const u = new URL(list.baseUrl);
              return u.port || (u.protocol === "https:" ? "443" : "80");
            } catch {
              return "?";
            }
          })()}.
        </p>
      </section>

      <section>
        <h2>What it does</h2>
        {a.kind !== "agent" && <p className="muted small">{a.kind === "cron_job" ? "Each event starts one of the profile's scheduled jobs." : "Each event is sent as a message, with no task."} It was set up in another Hermes client.</p>}
        <p className="field-label">Prompt template</p>
        {a.prompt ? <pre className="job-prompt">{a.prompt}</pre> : <p className="muted small">None: Hermes puts the whole event in the prompt.</p>}
        <dl className="job-kept">
          <div>
            <dt>Filters</dt>
            <dd>{a.filters.length ? a.filters.map(describeFilter).join("; and ") : "None"}</dd>
          </div>
          <div>
            <dt>Coalescing</dt>
            <dd>{a.coalesce ? `By ${a.coalesce.key}: waits ${a.coalesce.windowSeconds} s for more, at most ${a.coalesce.maxWaitSeconds} s` : "Off: each event runs"}</dd>
          </div>
          <div>
            <dt>Runs in</dt>
            <dd>
              the <span className="mono">{a.profile}</span> profile
            </dd>
          </div>
          <div>
            <dt>Reply goes to</dt>
            <dd>{deliverLabel(a.deliver, targets)}</dd>
          </div>
          {a.skills.length > 0 && (
            <div>
              <dt>Skills</dt>
              <dd>{a.skills.join(", ")}</dd>
            </div>
          )}
          {a.script && (
            <div>
              <dt>Script</dt>
              <dd>{a.script}</dd>
            </div>
          )}
        </dl>
      </section>

      <Deliveries api={api} profile={profile} connected={connected} automation={a} contract={list.contract} onOpenChat={onOpenChat} onChanged={onChanged} />
    </>
  );
}

function Deliveries({
  api,
  profile,
  connected,
  automation: a,
  contract,
  onOpenChat,
}: {
  api: AutomationsApi;
  profile: string;
  connected: boolean;
  automation: Automation;
  contract: boolean;
  onOpenChat: (sessionId: string) => void;
  onChanged: (name: string, a: Automation | null) => void;
}) {
  const [history, setHistory] = useState<DeliveryHistory | string>();
  const [older, setOlder] = useState<Delivery[]>([]);
  const [retrying, setRetrying] = useState<string>();
  const [asking, setAsking] = useState<Delivery>();
  const [said, setSaid] = useState<{ id: string; text: string; bad?: boolean }>();
  const seq = useRef(0);

  const read = () => {
    const mine = ++seq.current;
    void api.history(profile, a, contract).then(
      (h) => mine === seq.current && (setHistory(h), setOlder([])),
      (e) => mine === seq.current && setHistory(messageOf(e)),
    );
  };
  useEffect(() => {
    if (connected) read();
  }, [connected, a.name, a.revision, a.enabled]);

  const retry = async (d: Delivery, confirmed: boolean) => {
    setAsking(undefined);
    setRetrying(d.deliveryId);
    setSaid(undefined);
    try {
      const r = await api.retry(profile, a, d, confirmed);
      setSaid({
        id: d.deliveryId,
        text:
          r.status === "already_sent"
            ? "Hermes already took this retry; it isn't sent twice."
            : r.status === "duplicate"
              ? "Hermes already has this retry; it isn't sent twice."
              : r.status === "ignored"
                ? "Hermes took the retry, but it doesn't pass the automation's filters now, so nothing ran."
                : "Hermes took the retry. It's listed above as a new delivery.",
      });
      read();
    } catch (e) {
      if (e instanceof AutomationError && e.kind === "confirm") setAsking(d);
      else setSaid({ id: d.deliveryId, text: messageOf(e), bad: true });
    } finally {
      setRetrying(undefined);
    }
  };

  const rows = history && typeof history !== "string" && history.source === "ledger" ? [...history.deliveries, ...older] : [];
  const refused = history && typeof history !== "string" && history.source === "ledger" ? rejectionLine(history.rejections) : rejectionLine(a.rejections);
  const refusedAt = history && typeof history !== "string" && history.source === "ledger" ? lastRejected(history.rejections) : undefined;
  const limits = history && typeof history !== "string" && history.source === "ledger" ? history.limits : undefined;

  return (
    <section>
      <h2>
        <History size={14} /> Deliveries
      </h2>
      {history === undefined ? (
        connected && (
          <div className="empty-hint" role="status">
            <Spinner /> Reading what arrived…
          </div>
        )
      ) : typeof history === "string" ? (
        <p className="sign-in-error small" role="alert">
          {history}
        </p>
      ) : history.source === "ledger" ? (
        <>
          {refused && (
            <p className="job-banner" role="note">
              <CircleAlert size={14} /> Refused before they were trusted, so not listed: {refused}
              {refusedAt && <> (last {when(refusedAt)})</>}. Hermes keeps nothing else from those requests.
            </p>
          )}
          {rows.length ? (
            <ul className="job-history delivery-list">
              {rows.map((d) => {
                const label = stateLabel(d);
                const why = reasonText(d);
                const subject = d.excerpt["pull_request.title"] ?? d.excerpt["issue.title"] ?? d.excerpt["release.tag_name"] ?? d.excerpt["workflow_run.name"] ?? d.excerpt.ref;
                const number = d.excerpt["pull_request.number"] ?? d.excerpt["issue.number"] ?? d.excerpt.number;
                return (
                  <li key={d.deliveryId} className={`delivery tone-${label.tone}`}>
                    <div className="delivery-head">
                      <span>{when(d.receivedAt)}</span>
                      <span className={`badge delivery-state ${label.tone}`}>{label.text}</span>
                      <span className="mono faint">
                        {d.event}
                        {d.action ? `.${d.action}` : ""}
                      </span>
                      {d.retryOf && <span className="badge off">Retry</span>}
                    </div>
                    {subject !== undefined && (
                      <div className="job-history-title">
                        {d.excerpt["repository.full_name"] ? `${d.excerpt["repository.full_name"]}` : ""}
                        {number !== undefined ? ` #${number}` : ""} {String(subject)}
                      </div>
                    )}
                    {why && <div className="muted small">{why}</div>}
                    {d.duplicates > 0 && (
                      <div className="faint small">
                        {d.duplicates} more {d.duplicates === 1 ? "copy" : "copies"} of it arrived and {d.duplicates === 1 ? "was" : "were"} refused as duplicates.
                      </div>
                    )}
                    <div className="delivery-actions">
                      <span className="mono faint small" title="GitHub's delivery id">
                        {d.deliveryId}
                      </span>
                      {d.sessionId && (
                        <button className="btn small-btn" onClick={() => onOpenChat(d.sessionId!)}>
                          Open its chat
                        </button>
                      )}
                      {d.retryable && (
                        <button className="btn small-btn" disabled={!connected || !!retrying} onClick={() => (d.retryNeedsConfirmation ? setAsking(d) : void retry(d, false))}>
                          <RotateCcw size={13} /> {retrying === d.deliveryId ? "Retrying…" : "Retry"}
                        </button>
                      )}
                    </div>
                    {asking?.deliveryId === d.deliveryId && (
                      <div className="confirm" role="alertdialog" aria-label="Run this event again?" onKeyDown={(e) => e.key === "Escape" && setAsking(undefined)}>
                        <span>
                          The failed attempt had started, so it may already have done some of its work (comments, messages, changes its tools made). Retrying runs
                          the whole task again, as a new chat, and doesn't undo any of that.
                        </span>
                        <div className="confirm-actions">
                          <button className="btn" autoFocus onClick={() => setAsking(undefined)}>
                            Cancel
                          </button>
                          <button className="btn primary" onClick={() => void retry(d, true)}>
                            Run it again
                          </button>
                        </div>
                      </div>
                    )}
                    {said?.id === d.deliveryId && (
                      <p className={said.bad ? "sign-in-error small" : "job-notice small"} role={said.bad ? "alert" : "status"}>
                        {said.text}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="muted small">No events have arrived yet. GitHub sends a “ping” event when the webhook is added; it shows here once it passes the signature check.</p>
          )}
          {!!history.nextBefore && rows.length > 0 && (
            <button
              className="btn"
              onClick={() =>
                void api.history(profile, a, true, (older.at(-1) ?? history.deliveries.at(-1))!.receivedAt).then(
                  (h) => h.source === "ledger" && setOlder((o) => [...o, ...h.deliveries]),
                  () => {},
                )
              }
            >
              Show older deliveries
            </button>
          )}
          <p className="muted small">
            Listed in the order Hermes received them, which isn't always the order GitHub sent them; GitHub doesn't promise an order. A copy of an event that
            already arrived, or the same signed event sent again under a new delivery id, is refused and counted, never run again.
            {limits && ` Hermes keeps ${Math.round(limits.retentionSeconds / 86400)} days of history, at most ${limits.maxRowsPerRoute} per automation; a replay older than that would no longer be recognised.`}{" "}
            While the gateway is down, GitHub can't deliver: it marks those deliveries failed, and they can be redelivered from GitHub.
          </p>
        </>
      ) : (
        <>
          <p className="muted small">
            This Hermes server records no deliveries, so this lists only the tasks the automation started. Events it filtered, refused or recognised as copies,
            and why a task failed, aren't recorded; GitHub's Recent Deliveries shows what it sent and how Hermes answered.
          </p>
          {refused && <p className="job-banner">{refused}</p>}
          {history.runs.length ? (
            <ul className="job-history delivery-list">
              {history.runs.map((r) => (
                <li key={r.sessionId} className="delivery">
                  <div className="delivery-head">
                    <span>{when(r.startedAt)}</span>
                    <span className={`badge delivery-state ${r.endedAt ? "muted" : "busy"}`}>{r.endedAt ? (r.messageCount > 1 ? "Ended" : "Ended without a reply") : r.active ? "Running" : "Queued or stopped"}</span>
                  </div>
                  <div className="delivery-actions">
                    {r.deliveryId && <span className="mono faint small">{r.deliveryId}</span>}
                    <button className="btn small-btn" onClick={() => onOpenChat(r.sessionId)}>
                      Open its chat
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">No tasks from this automation are on record.</p>
          )}
          {history.capped && <p className="muted small">Only the latest 100 webhook tasks of the profile were looked at.</p>}
        </>
      )}
      {connected && history !== undefined && (
        <button className="btn" onClick={read}>
          <RefreshCw size={14} /> Refresh deliveries
        </button>
      )}
    </section>
  );
}

function fieldsOf(a: Automation): AutomationFields {
  return {
    name: a.name,
    provider: "github",
    events: a.events,
    prompt: a.prompt,
    filters: a.filters,
    coalesce: a.coalesce,
    secretEnv: a.secretRef.startsWith("env:") ? a.secretRef.slice(4) : "",
    deliver: a.deliver,
    deliverChatId: a.deliverChatId ?? "",
  };
}

type Row = { key: number; field: string; op: FilterOp; typed: string };
let rowKey = 0;

const STARTER = "New GitHub {event_type} on {repository.full_name}: #{issue.number} {issue.title}\n\nOpened by {sender.login}: {issue.html_url}\n\nRead the issue and suggest labels and a first reply.";

function Editor({
  api,
  profile,
  connected,
  base: initialBase,
  list,
  targets,
  heading,
  onSaved,
  onSeen,
  onSecret,
  onReload,
  onCancel,
}: {
  api: AutomationsApi;
  profile: string;
  connected: boolean;
  base?: Automation;
  list: AutomationList;
  targets: DeliveryTarget[];
  heading: RefObject<HTMLHeadingElement | null>;
  onSaved: (saved: { automation: Automation; secret?: string; note?: string }) => void;
  onSeen: (a: Automation) => void;
  /** A new secret Hermes handed over before a later step failed. */
  onSecret: (name: string, secret: string) => void;
  onReload: () => void;
  onCancel: () => void;
}) {
  // The automation as the edits started from; a conflict's Reload starts the editor again.
  const [base] = useState(initialBase);
  const start = base ? fieldsOf(base) : undefined;
  const [name, setName] = useState(base?.name ?? "");
  const [events, setEvents] = useState<string[]>(start ? start.events.filter((e) => GITHUB_EVENTS.some((g) => g.name === e)) : ["issues"]);
  const [otherEvents, setOtherEvents] = useState((start?.events ?? []).filter((e) => !GITHUB_EVENTS.some((g) => g.name === e)).join(", "));
  const [prompt, setPrompt] = useState(start?.prompt ?? STARTER);
  const rowsOf = (specs: FilterSpec[]): Row[] =>
    specs.flatMap((spec) => {
      const r = filterRow(spec);
      return r ? [{ key: ++rowKey, field: r.field, op: r.op, typed: typedFilterValue(r.op, r.value) }] : [];
    });
  const [rows, setRows] = useState<Row[]>(() => rowsOf(start?.filters ?? []));
  /** Filters the editor can't show as rows (all/any/not groups): kept as they are. */
  const kept = useMemo(() => (start?.filters ?? []).filter((s) => !filterRow(s)), [base]);
  const [coalesceOn, setCoalesceOn] = useState(!!start?.coalesce);
  const [coalesce, setCoalesce] = useState<Coalesce>(start?.coalesce ?? { key: "{repository.full_name}#{issue.number}", windowSeconds: 30, maxWaitSeconds: 300 });
  const [secretMode, setSecretMode] = useState<"stored" | "env">(start?.secretEnv ? "env" : "stored");
  const [secretEnv, setSecretEnv] = useState(start?.secretEnv ?? "GITHUB_WEBHOOK_SECRET");
  const [deliver, setDeliver] = useState(start?.deliver ?? "log");
  const [paused, setPaused] = useState(true);
  const [newSecretOk, setNewSecretOk] = useState(false);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<AutomationError | Error>();

  // The example event.
  const sampleTypes = Object.keys(SAMPLE_EVENTS);
  const [sample, setSample] = useState<string>(() => (start?.events ?? ["issues"]).find((e) => e in SAMPLE_EVENTS) ?? "issues");
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState("");
  const [pastedEvent, setPastedEvent] = useState("issues");
  const pastedParse = useMemo(() => {
    if (!pasting || !pasted.trim()) return undefined;
    try {
      return sanitizeEvent(JSON.parse(pasted));
    } catch (e) {
      return new Error(`That isn't JSON: ${messageOf(e)}`);
    }
  }, [pasting, pasted]);
  const example = pasting ? (pastedParse && !(pastedParse instanceof Error) ? { event: pastedEvent.trim() || "unknown", payload: pastedParse.payload, notes: pastedParse.notes } : undefined) : { event: sample, payload: SAMPLE_EVENTS[sample].payload, notes: [] as string[] };

  const allEvents = [...events, ...otherEvents.split(",").map((s) => s.trim()).filter(Boolean)];
  const filters: FilterSpec[] = [...rows.filter((r) => r.field.trim()).map((r) => ({ field: r.field.trim(), [r.op]: parseFilterValue(r.op, r.typed) })), ...kept];
  const fields: AutomationFields = {
    name: name.trim(),
    provider: "github",
    events: [...new Set(allEvents)],
    prompt,
    filters,
    coalesce: coalesceOn ? coalesce : undefined,
    secretEnv: secretMode === "env" ? secretEnv.trim() : "",
    deliver,
    deliverChatId: base?.deliverChatId ?? "",
  };
  const shownPreview = useMemo(() => (example ? preview(fields, example.payload, example.event) : undefined), [JSON.stringify(fields), example?.event, example?.payload]);
  const paths = useMemo(() => (example ? fieldPaths(example.payload) : []), [example?.payload]);

  const nameProblem = !base && !NAME_RE.test(fields.name) ? "Up to 64 lowercase letters, digits, - and _, starting with a letter or digit." : !base && list.automations.some((a) => a.name === fields.name) ? "There's already an automation with this name." : undefined;
  const envProblem = secretMode === "env" && !SECRET_ENV_RE.test(fields.secretEnv) ? "An environment variable name, like GITHUB_WEBHOOK_SECRET." : undefined;
  const coalesceProblem = coalesceOn && (!coalesce.key.trim() ? "Name the field that identifies the item." : !(coalesce.windowSeconds > 0) || !(coalesce.maxWaitSeconds > 0) ? "Times are seconds, above 0." : coalesce.maxWaitSeconds > 86400 || coalesce.windowSeconds > 86400 ? "At most 86400 seconds." : undefined);
  const rowProblem = rows.some((r) => r.field.trim() && r.op === "regex" && (() => {
    try {
      new RegExp(r.typed);
      return false;
    } catch {
      return true;
    }
  })()) ? "A pattern doesn't compile." : undefined;
  const gaps = list.contract ? [] : stockGaps(fields);
  const stockEdit = !!base && !list.contract;
  const problems = [nameProblem, envProblem, coalesceProblem, rowProblem, gaps.length ? `This server can't keep ${gaps.join(" or ")}.` : undefined, stockEdit && !newSecretOk ? "Confirm the new secret below." : undefined].filter(Boolean);

  const save = async () => {
    setTouched(true);
    if (problems.length || saving) return;
    setSaving(true);
    setError(undefined);
    try {
      onSaved(base ? await api.update(profile, base, fields) : await api.create(profile, fields, paused));
    } catch (e) {
      setError(e as Error);
      if (e instanceof AutomationError && e.secret) onSecret(fields.name, e.secret);
      if (e instanceof AutomationError && e.current) onSeen(e.current);
    } finally {
      setSaving(false);
    }
  };

  const insert = (path: string) => setPrompt((p) => `${p}${p && !p.endsWith(" ") && !p.endsWith("\n") ? " " : ""}{${path}}`);

  return (
    <>
      <h1 className="project-title" ref={heading} tabIndex={-1}>
        <Webhook size={20} /> <span>{base ? `Edit ${base.name}` : "New automation"}</span>
      </h1>
      <p className="muted">
        In the <span className="mono">{profile}</span> profile. Hermes keeps the automation on the server, checks each event's signature there and runs the task
        in this profile. To run tasks in another profile, switch to it first.
      </p>
      <form
        className="job-form automation-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {!base && (
          <label className="field">
            <span className="field-label">Name</span>
            <input value={name} spellCheck={false} placeholder="triage-issues" maxLength={64} aria-invalid={touched && !!nameProblem} onChange={(e) => setName(e.target.value.toLowerCase())} />
            <span className="field-hint">Part of the URL GitHub sends to.</span>
            {touched && nameProblem && <span className="field-hint err">{nameProblem}</span>}
          </label>
        )}
        <fieldset className="field automation-fieldset">
          <legend className="field-label">Sent by</legend>
          <label className="job-check">
            <input type="radio" checked readOnly /> GitHub (signed with <span className="mono">X-Hub-Signature-256</span>)
          </label>
          {!list.contract && <span className="field-hint">This server checks any signature scheme it knows on any route; with webhooks/1 a GitHub automation takes only GitHub's.</span>}
        </fieldset>
        <fieldset className="field automation-fieldset">
          <legend className="field-label">Events</legend>
          <div className="automation-events">
            {GITHUB_EVENTS.map((g) => (
              <label key={g.name} className="job-check">
                <input type="checkbox" checked={events.includes(g.name)} onChange={(e) => setEvents((ev) => (e.target.checked ? [...ev, g.name] : ev.filter((x) => x !== g.name)))} />
                <span className="mono">{g.name}</span> <span className="faint small">{g.label}</span>
              </label>
            ))}
          </div>
          <label className="field">
            <span className="field-hint">Other GitHub event names, separated by commas</span>
            <input value={otherEvents} spellCheck={false} placeholder="discussion, check_suite" onChange={(e) => setOtherEvents(e.target.value)} />
          </label>
          {!fields.events.length && <span className="field-hint block warn-note">With no event picked, every event GitHub sends starts a task.</span>}
        </fieldset>

        <fieldset className="field automation-fieldset">
          <legend className="field-label">Filters: every one must match</legend>
          {!list.contract && <span className="field-hint block">This Hermes server can't keep filters (it doesn't have webhooks/1). The preview still shows what they'd do.</span>}
          {rows.map((r, i) => {
            const takes = FILTER_OPS.find((o) => o.op === r.op)!.takes;
            return (
              <div className="automation-filter" key={r.key}>
                <input aria-label={`Filter ${i + 1} field`} value={r.field} list="automation-paths" spellCheck={false} placeholder="issue.labels" onChange={(e) => setRows((rs) => rs.map((x) => (x.key === r.key ? { ...x, field: e.target.value } : x)))} />
                <select aria-label={`Filter ${i + 1} test`} value={r.op} onChange={(e) => setRows((rs) => rs.map((x) => (x.key === r.key ? { ...x, op: e.target.value as FilterOp } : x)))}>
                  {FILTER_OPS.map((o) => (
                    <option key={o.op} value={o.op}>
                      {o.label}
                    </option>
                  ))}
                </select>
                {takes !== "none" && (
                  <input aria-label={`Filter ${i + 1} value`} value={r.typed} spellCheck={false} placeholder={takes === "list" ? "bug, urgent" : r.op === "contains" ? "text" : "value"} onChange={(e) => setRows((rs) => rs.map((x) => (x.key === r.key ? { ...x, typed: e.target.value } : x)))} />
                )}
                <button type="button" className="icon-btn" aria-label={`Remove filter ${i + 1}`} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>
                  <X size={14} />
                </button>
              </div>
            );
          })}
          {kept.length > 0 && <p className="field-hint block">Also kept as set elsewhere: {kept.map((k) => JSON.stringify(k)).join(" ")}</p>}
          <div>
            <button type="button" className="btn" onClick={() => setRows((rs) => [...rs, { key: ++rowKey, field: "", op: "equals", typed: "" }])}>
              <Plus size={14} /> Add a filter
            </button>
          </div>
          <span className="field-hint block">
            A field is a dot path into the event, such as <code>issue.user.login</code>, or <code>event</code> for the event name. Numbers, true, false and null are
            compared as such; put quotes around them to mean text. Hermes compares the way Python does, and runs patterns as Python patterns.
          </span>
          {rowProblem && <span className="field-hint err">{rowProblem}</span>}
        </fieldset>

        <fieldset className="field automation-fieldset">
          <legend className="field-label">Coalescing</legend>
          <label className="job-check">
            <input type="checkbox" checked={coalesceOn} onChange={(e) => setCoalesceOn(e.target.checked)} /> Several events about the same item in quick succession start one task, with the latest event
          </label>
          {coalesceOn && (
            <div className="automation-coalesce">
              <label className="field">
                <span className="field-label">The item is</span>
                <input value={coalesce.key} list="automation-paths" spellCheck={false} onChange={(e) => setCoalesce((c) => ({ ...c, key: e.target.value }))} />
              </label>
              <label className="field">
                <span className="field-label">Wait for quiet (seconds)</span>
                <input inputMode="numeric" value={String(coalesce.windowSeconds)} onChange={(e) => setCoalesce((c) => ({ ...c, windowSeconds: Number(e.target.value) }))} />
              </label>
              <label className="field">
                <span className="field-label">But no longer than (seconds)</span>
                <input inputMode="numeric" value={String(coalesce.maxWaitSeconds)} onChange={(e) => setCoalesce((c) => ({ ...c, maxWaitSeconds: Number(e.target.value) }))} />
              </label>
            </div>
          )}
          {coalesceOn && (
            <span className="field-hint block">
              Waiting events live in the gateway's memory: they run early if the gateway stops cleanly, and are lost if it's killed. An event whose item can't be
              worked out runs at once. The latest event to arrive wins, which may not be the latest GitHub sent.
            </span>
          )}
          {coalesceProblem && <span className="field-hint err">{coalesceProblem}</span>}
        </fieldset>

        <fieldset className="field automation-fieldset">
          <legend className="field-label">Signature secret</legend>
          <label className="job-check">
            <input type="radio" name="secret" checked={secretMode === "stored"} onChange={() => setSecretMode("stored")} />{" "}
            {base && !base.secretRef.startsWith("env:") ? "Keep the secret Hermes has" : "Hermes makes one and shows it once"}
          </label>
          <label className="job-check">
            <input type="radio" name="secret" checked={secretMode === "env"} disabled={!list.contract} onChange={() => setSecretMode("env")} /> Hermes reads it from a variable in the
            server's environment
          </label>
          {secretMode === "env" && (
            <label className="field">
              <input value={secretEnv} spellCheck={false} aria-label="Environment variable name" aria-invalid={!!envProblem} onChange={(e) => setSecretEnv(e.target.value.toUpperCase())} />
              {envProblem && <span className="field-hint err">{envProblem}</span>}
            </label>
          )}
          <span className="field-hint block">
            The secret never passes through the prompt.{" "}
            {list.contract
              ? "With a variable, it never passes through Hermes Chat either: set it in the profile's .env on the server."
              : "Reading it from a variable needs Hermes with webhooks/1."}
          </span>
        </fieldset>

        <label className="field">
          <span className="field-label">Reply goes to</span>
          <select value={deliver} onChange={(e) => setDeliver(e.target.value)}>
            <option value="log">Saved in the gateway's log only</option>
            {targets.map((t) => (
              <option key={t.id} value={t.id} disabled={!t.ready && t.id !== deliver}>
                {t.name}
                {!t.ready ? " (no home channel set on the server)" : ""}
              </option>
            ))}
          </select>
          <span className="field-hint">The task's chat stays on the server either way.</span>
        </label>

        <label className="field">
          <span className="field-label">Prompt template</span>
          <textarea rows={6} value={prompt} spellCheck={false} onChange={(e) => setPrompt(e.target.value)} />
          <span className="field-hint">
            <code>{"{issue.title}"}</code> puts that field of the event in; <code>{"{event_type}"}</code> the event's name; <code>{"{__raw__}"}</code> the whole event. Left empty,
            Hermes puts in the whole event.
          </span>
          {paths.length > 0 && (
            <span className="field-hint automation-insert">
              Insert:{" "}
              {paths.slice(0, 14).map((p) => (
                <button key={p} type="button" className="job-example" onClick={() => insert(p)}>
                  {p}
                </button>
              ))}
            </span>
          )}
        </label>
        <datalist id="automation-paths">
          {paths.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>

        <div className="job-preview automation-preview" aria-live="polite" aria-label="Preview with an example event">
          <div className="automation-preview-head">
            <strong>Example event</strong>
            {!pasting ? (
              <select aria-label="Example event" value={sample} onChange={(e) => setSample(e.target.value)}>
                {sampleTypes.map((t) => (
                  <option key={t} value={t}>
                    {t}
                    {SAMPLE_EVENTS[t].action ? ` (${SAMPLE_EVENTS[t].action})` : ""}
                  </option>
                ))}
              </select>
            ) : (
              <input aria-label="Pasted event's name" className="automation-event-name" value={pastedEvent} spellCheck={false} onChange={(e) => setPastedEvent(e.target.value)} />
            )}
            <button type="button" className="btn small-btn" onClick={() => setPasting((p) => !p)}>
              {pasting ? "Use an example" : "Paste a real one"}
            </button>
          </div>
          {pasting && (
            <>
              <textarea className="automation-paste" rows={5} aria-label="The event's JSON" placeholder="Paste the payload from GitHub's Recent Deliveries" spellCheck={false} value={pasted} onChange={(e) => setPasted(e.target.value)} />
              <p className="muted small">It stays on this computer. Secret-looking values, e-mail addresses and passwords in links are replaced before it's shown.</p>
              {pastedParse instanceof Error && <p className="field-hint err">{pastedParse.message}</p>}
            </>
          )}
          {!pasting && <p className="muted small">Made-up, in GitHub's shape and trimmed; real events have more fields. Its text includes an injection attempt, as a real issue can.</p>}
          {example && (
            <details>
              <summary className="small">The event{example.notes.length ? ` (${example.notes.join(" ")})` : ""}</summary>
              <pre className="job-prompt automation-event">{JSON.stringify(example.payload, null, 2)}</pre>
            </details>
          )}
          {shownPreview && example && (
            <>
              <ul className="automation-checks">
                <li className={shownPreview.eventTaken ? "pass" : "fail"}>
                  {shownPreview.eventTaken ? <Check size={13} /> : <X size={13} />} A <span className="mono">{example.event}</span> event {shownPreview.eventTaken ? "is one it takes" : "isn't one it takes"}
                </li>
                {shownPreview.filters.map((f, i) => (
                  <li key={i} className={f.matches ? "pass" : "fail"}>
                    {f.matches ? <Check size={13} /> : <X size={13} />} {describeFilter(f.spec)}
                  </li>
                ))}
                {coalesceOn && (
                  <li className="pass">
                    {shownPreview.ungrouped ? (
                      <>
                        <CircleAlert size={13} /> The item doesn't resolve for this event, so it would run at once
                      </>
                    ) : (
                      <>
                        <Check size={13} /> Grouped as <span className="mono">{shownPreview.group}</span>
                      </>
                    )}
                  </li>
                )}
              </ul>
              <p className={shownPreview.starts ? "automation-verdict good" : "automation-verdict muted"}>
                {shownPreview.starts
                  ? coalesceOn && !shownPreview.ungrouped
                    ? `Hermes would wait ${coalesce.windowSeconds} s for more events about it, then start one task with this prompt:`
                    : "Hermes would start a task with this prompt:"
                  : "Hermes would record it as filtered out and start nothing."}
              </p>
              {shownPreview.starts && <pre className="job-prompt automation-rendered">{shownPreview.prompt}</pre>}
              {shownPreview.starts && shownPreview.missing.length > 0 && (
                <p className="field-hint block warn-note">
                  <CircleAlert size={13} />
                  This event has no {shownPreview.missing.map((m) => `{${m}}`).join(", ")}: Hermes leaves {shownPreview.missing.length === 1 ? "it" : "them"} in the prompt as typed.
                </p>
              )}
              {shownPreview.starts && (
                <p className="field-hint block">
                  <CircleAlert size={13} />
                  Text from the event (titles, bodies, comments) is written by whoever opened the issue, and goes into the prompt as it is. Hermes runs webhook
                  tasks with a small set of tools by default; keep it that way for events from people you don't know.
                  {prompt.includes("{__raw__}") || !prompt.trim() ? " This prompt includes the whole event." : ""}
                </p>
              )}
            </>
          )}
        </div>

        {!base && (
          <label className="job-check">
            <input type="checkbox" checked={paused} onChange={(e) => setPaused(e.target.checked)} /> Create it paused, and resume it once GitHub is set up and the preview looks right
          </label>
        )}
        {stockEdit && (
          <label className="job-check warn-note">
            <input type="checkbox" checked={newSecretOk} onChange={(e) => setNewSecretOk(e.target.checked)} /> This Hermes server can only replace an automation, which makes a new
            secret: GitHub's events are refused until I give it the new one
          </label>
        )}
        {error && (
          <div className="job-error" role="alert">
            <p>{messageOf(error)}</p>
            {error instanceof AutomationError && error.kind === "conflict" && error.current && (
              <button type="button" className="btn" onClick={onReload}>
                Reload
              </button>
            )}
          </div>
        )}
        {touched && problems.length > 0 && (
          <p className="field-hint err" role="alert">
            {problems.join(" ")}
          </p>
        )}
        <div className="confirm-actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!connected || saving || !list.platformEnabled} title={!connected ? "Connect to Hermes to save." : !list.platformEnabled ? "Webhooks are off for this profile in Hermes." : undefined}>
            {saving ? "Saving…" : base ? "Save" : paused ? "Create paused" : "Create and start"}
          </button>
        </div>
      </form>
    </>
  );
}
