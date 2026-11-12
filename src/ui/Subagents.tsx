// The Subagents a chat's reply started (ADR 0072), above the composer: a tree of who started whom, and one subagent's
// own activity and output apart from the chat. Steer and Stop act on one subagent, named in full before they go.
import { useEffect, useId, useRef, useState } from "react";
import { ArrowLeft, ChevronDown, ChevronRight, RefreshCw, Workflow } from "lucide-react";
import {
  childrenOf,
  descendantsOf,
  isFailure,
  isSteerable,
  tally,
  type Subagent,
  type SubagentId,
  type SubagentOutput,
  type SubagentState,
  type SubagentTree,
} from "../hermes/subagents";
import { composing } from "./bits";
import type { QuestionKind } from "../hermes/model";
import { clockTimeWithSeconds } from "../hermes/values";

/**
 * What the panel can ask Hermes about its chat's subagents. `refresh` reads the roster again. `blocked`: why Steer and
 * Stop can't be used now.
 */
export type SubagentsApi = {
  refresh: () => Promise<void>;
  output: (id: SubagentId) => Promise<SubagentOutput>;
  steer: (id: SubagentId, text: string) => Promise<"queued" | "rejected">;
  stop: (id: SubagentId) => Promise<boolean>;
  blocked?: string;
};

const STATE_LABEL: Record<SubagentState, string> = {
  queued: "Queued",
  running: "Running",
  completed: "Finished",
  failed: "Failed",
  error: "Failed",
  timeout: "Timed out",
  interrupted: "Stopped",
  ended: "Ended",
  unknown: "Unknown",
};

const UNDESCRIBED = "A subagent Hermes hasn't described yet";
const nameOf = (s: Subagent) => s.goal || UNDESCRIBED;
const shortId = (id: SubagentId) => (id.length > 12 ? `${id.slice(0, 12)}…` : id);
const isLive = (state: SubagentState) => state === "running" || state === "queued";
const live = (s: Subagent) => isLive(s.state);

function summaryOf(tree: SubagentTree): string {
  const { running, failed, total } = tally(tree);
  const parts = [running && `${running} running`, failed && `${failed} failed`, `${total} in all`].filter(Boolean);
  return parts.join(" · ");
}

function SyncNote({ tree }: { tree: SubagentTree }) {
  const s = tree.sync;
  if (s.kind === "live") return null;
  return (
    <div className="subagents-note" role="status">
      {s.kind === "lost"
        ? `Disconnected since ${clockTimeWithSeconds(s.since)}: these are the states last heard. Hermes is asked again once the chat is open on Hermes.`
        : `These are the states last heard. ${s.why}`}
    </div>
  );
}

export function SubagentsPanel({
  tree,
  api,
  approvalWaiting,
  onGoToApproval,
  show,
}: {
  tree?: SubagentTree;
  api?: SubagentsApi;
  /** What the chat's reply waits for the owner's answer to, if anything: an Approval or another Question. */
  approvalWaiting?: QuestionKind;
  onGoToApproval: () => void;
  /** A subagent to open, from the agent office; `at` tells one request from the next. */
  show?: { id: SubagentId; at: number };
}) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<SubagentId>();
  const rootRef = useRef<HTMLElement>(null);
  const backTo = useRef<SubagentId | undefined>(undefined);
  const shown = picked && tree?.subagents.find((s) => s.id === picked);

  // Each request from the office focuses the subagent's name, even the one already open.
  const [asked, setAsked] = useState(0);
  useEffect(() => {
    if (!show) return;
    setOpen(true);
    setPicked(show.id);
    setAsked(show.at);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show?.at]);

  // Back from a subagent, focus goes to its row.
  useEffect(() => {
    if (picked || !backTo.current) return;
    rootRef.current?.querySelector<HTMLElement>(`[data-subagent="${CSS.escape(backTo.current)}"]`)?.focus();
    backTo.current = undefined;
  }, [picked]);

  if (!tree?.subagents.length) return null;
  const back = () => {
    backTo.current = picked;
    setPicked(undefined);
  };

  return (
    <section ref={rootRef} className="subagents" aria-label="Subagents">
      <button className="subagents-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
        <Workflow size={13} aria-hidden />
        <span className="subagents-title">Subagents</span>
        <span className="subagents-count">{summaryOf(tree)}</span>
      </button>
      {open && <SyncNote tree={tree} />}
      {open &&
        (shown ? (
          <SubagentView tree={tree} s={shown} api={api} asked={asked} onBack={back} onOpen={setPicked} />
        ) : (
          <div className="subagents-body">
            {approvalWaiting && (
              <div className="subagents-approval" role="status">
                <span>{approvalWaiting === "approval" ? "The chat's reply is waiting for your approval." : "The chat's reply is waiting for your answer to Hermes's question."}</span>
                <button className="btn" onClick={onGoToApproval}>
                  Go to it
                </button>
              </div>
            )}
            <Branch tree={tree} onOpen={setPicked} />
          </div>
        ))}
    </section>
  );
}

function Branch({ tree, parent, onOpen }: { tree: SubagentTree; parent?: SubagentId; onOpen: (id: SubagentId) => void }) {
  const kids = childrenOf(tree, parent);
  if (!kids.length) return null;
  return (
    <ul className="subagents-tree" aria-label={parent ? `Started by ${nameOf(tree.subagents.find((s) => s.id === parent)!)}` : "Started by the chat's reply"}>
      {kids.map((s) => (
        <li key={s.id}>
          <button className="subagent-row" data-subagent={s.id} onClick={() => onOpen(s.id)}>
            <StateBadge state={s.state} />
            <span className="subagent-goal">{nameOf(s)}</span>
            <span className="subagent-meta">
              {[s.model, s.lastActivity && `${s.lastActivity.text} · ${clockTimeWithSeconds(s.lastActivity.at)}`].filter(Boolean).join(" · ")}
            </span>
          </button>
          <Branch tree={tree} parent={s.id} onOpen={onOpen} />
        </li>
      ))}
    </ul>
  );
}

function StateBadge({ state }: { state: SubagentState }) {
  const tone = isLive(state) ? "live" : isFailure(state) ? "bad" : state === "unknown" || state === "ended" || state === "interrupted" ? "dim" : "ok";
  return <span className={`subagent-state ${tone}`}>{STATE_LABEL[state]}</span>;
}

function SubagentView({
  tree,
  s,
  api,
  asked,
  onBack,
  onOpen,
}: {
  tree: SubagentTree;
  s: Subagent;
  api?: SubagentsApi;
  /** When the office last asked for a subagent to be shown. */
  asked: number;
  onBack: () => void;
  onOpen: (id: SubagentId) => void;
}) {
  const headRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headRef.current?.focus(), [s.id, asked]);
  // Steer and Stop go once it ends; focus that was on them goes to its name rather than nowhere.
  const running = live(s);
  useEffect(() => {
    if (!running && (!document.activeElement || document.activeElement === document.body)) headRef.current?.focus();
  }, [running]);
  const parent = s.parent && tree.subagents.find((p) => p.id === s.parent);
  const under = descendantsOf(tree, s.id);
  const kids = childrenOf(tree, s.id);

  return (
    <div
      className="subagent-view"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !composing(e)) {
          e.stopPropagation();
          onBack();
        }
      }}
    >
      <button className="btn subagent-back" onClick={onBack}>
        <ArrowLeft size={13} aria-hidden /> All subagents
      </button>
      <h3 ref={headRef} tabIndex={-1} className="subagent-title">
        {nameOf(s)}
      </h3>
      <dl className="subagent-facts">
        <dt>State</dt>
        <dd>
          <StateBadge state={s.state} />
          {s.state === "ended" && <span className="subagent-why"> Hermes didn't say how it ended.</span>}
          {s.state === "unknown" && <span className="subagent-why"> The app knows it only as the parent of a subagent it heard from.</span>}
        </dd>
        <dt>Started by</dt>
        <dd>
          {parent ? (
            <button className="link-btn" onClick={() => onOpen(parent.id)}>
              {nameOf(parent)}
            </button>
          ) : (
            "The chat's reply"
          )}
        </dd>
        {s.model && (
          <>
            <dt>Model</dt>
            <dd>{s.model}</dd>
          </>
        )}
        {s.startedAt !== undefined && (
          <>
            <dt>Started</dt>
            <dd>{clockTimeWithSeconds(s.startedAt)}</dd>
          </>
        )}
        {s.toolCount !== undefined && (
          <>
            <dt>Tool calls</dt>
            <dd>{s.toolCount}</dd>
          </>
        )}
        <dt>Id</dt>
        <dd className="mono">{s.id}</dd>
      </dl>
      {s.summary && (
        <div className="subagent-summary">
          <b>{isFailure(s.state) ? "Why it failed" : "How it ended"}</b>
          <p>{s.summary}</p>
        </div>
      )}
      {kids.length > 0 && (
        <div className="subagent-kids">
          <b>Its subagents</b>
          <Branch tree={tree} parent={s.id} onOpen={onOpen} />
        </div>
      )}
      <Activity s={s} />
      {!s.stored && api && <Output id={s.id} api={api} />}
      {s.stored && <p className="subagent-why">Hermes keeps only how this background task failed, so there's no output to show.</p>}
      {api && live(s) && isSteerable(s) && <Controls key={s.id} s={s} under={under.filter(live).length} api={api} />}
      <p className="subagent-foot">
        A subagent never asks you for approval: Hermes refuses its risky commands, or allows them if the profile's
        delegation settings say so.
      </p>
    </div>
  );
}

function Activity({ s }: { s: Subagent }) {
  return (
    <div className="subagent-activity">
      <b>Activity</b>
      {s.partial && <p className="subagent-why">The app heard of it only part way through, so what it did before isn't shown.</p>}
      {s.activity.length ? (
        <ol>
          {s.activity.map((a, i) => (
            <li key={i}>
              <span className="subagent-at">{clockTimeWithSeconds(a.at)}</span>
              {a.kind === "tool" ? (
                <span>
                  <span className="mono">{a.tool}</span>
                  {a.preview && <span className="subagent-preview"> {a.preview}</span>}
                </span>
              ) : (
                <span>{a.text}</span>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <p className="subagent-why">Nothing heard yet.</p>
      )}
    </div>
  );
}

type Read = { state: "loading" } | { state: "done"; output: SubagentOutput; at: number } | { state: "failed"; why: string };

function Output({ id, api }: { id: SubagentId; api: SubagentsApi }) {
  const [read, setRead] = useState<Read>({ state: "loading" });
  const asked = useRef(0);
  // The roster too: it is how Hermes tells of a nested subagent's tools, which its events leave out.
  const load = () => {
    const n = ++asked.current;
    setRead({ state: "loading" });
    void api.refresh();
    api.output(id).then(
      (output) => n === asked.current && setRead({ state: "done", output, at: Date.now() }),
      (e) => n === asked.current && setRead({ state: "failed", why: (e as Error).message }),
    );
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `asked` is a counter, not a DOM node: the cleanup bumps its live value so a late answer for the old subagent is dropped
    return () => void asked.current++;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  return (
    <div className="subagent-output">
      <div className="subagent-output-head">
        <b>Output</b>
        <button className="icon-btn" title="Read its output again" aria-label="Read its output again" disabled={read.state === "loading"} onClick={load}>
          <RefreshCw size={13} />
        </button>
      </div>
      {read.state === "loading" ? (
        <p className="subagent-why">Reading…</p>
      ) : read.state === "failed" ? (
        <p className="subagent-why" role="alert">
          Couldn't read it: {read.why}
        </p>
      ) : read.output.available ? (
        <>
          {read.output.truncated && <p className="subagent-why">The last 16 KB, as Hermes keeps it, read at {clockTimeWithSeconds(read.at)}.</p>}
          <pre className="subagent-tail">{read.output.text || "(nothing yet)"}</pre>
        </>
      ) : (
        <p className="subagent-why">Hermes shares a subagent's output only while it runs, and only with the chat session that started it.</p>
      )}
    </div>
  );
}

type Sent = { state: "idle" } | { state: "busy" } | { state: "said"; text: string; ok: boolean };

function Controls({ s, under, api }: { s: Subagent; under: number; api: SubagentsApi }) {
  const [text, setText] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [sent, setSent] = useState<Sent>({ state: "idle" });
  const steerId = useId();
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const stopRef = useRef<HTMLButtonElement>(null);
  const saidRef = useRef<HTMLParagraphElement>(null);
  // Where focus goes once the controls it was on are gone or disabled, as soon as that place is there to take it.
  const [focusNext, setFocusNext] = useState<"box" | "stop" | "said">();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- runs after every render on purpose: focus waits until its target is rendered and enabled, which a later render brings
  useEffect(() => {
    const el = focusNext && { box: boxRef, stop: stopRef, said: saidRef }[focusNext].current;
    if (!el || ("disabled" in el && el.disabled)) return;
    setFocusNext(undefined);
    el.focus();
  });
  const target = `“${nameOf(s)}” (${shortId(s.id)})`;
  const busy = sent.state === "busy";
  const run = async (what: () => Promise<{ text: string; ok: boolean }>) => {
    setSent({ state: "busy" });
    try {
      setSent({ state: "said", ...(await what()) });
    } catch (e) {
      setSent({ state: "said", text: (e as Error).message, ok: false });
    }
  };
  const steer = () =>
    run(async () => {
      const words = text.trim();
      setFocusNext("box");
      if ((await api.steer(s.id, words)) !== "queued")
        return { ok: false, text: "Hermes didn't take it: this subagent isn't taking steers now, or an earlier session of this chat started it." };
      setText("");
      return { ok: true, text: `Steered ${target}. It reads your words after its current tool call.` };
    });
  const stop = () =>
    run(async () => {
      setConfirming(false);
      setFocusNext("said");
      return (await api.stop(s.id))
        ? { ok: true, text: `Asked Hermes to stop ${target}. It shows as Stopped once Hermes ends it.` }
        : { ok: false, text: "Hermes didn't find it to stop: it may have ended, or an earlier session of this chat started it." };
    });

  if (api.blocked)
    return (
      <p className="subagent-why" role="note">
        Steer and Stop: {api.blocked}
      </p>
    );
  return (
    <div className="subagent-controls">
      <label htmlFor={steerId}>
        <b>Steer</b> {target}
      </label>
      <textarea
        ref={boxRef}
        id={steerId}
        rows={2}
        value={text}
        placeholder="What it should do differently"
        disabled={busy}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !composing(e) && text.trim()) {
            e.preventDefault();
            void steer();
          }
        }}
      />
      <div className="subagent-hint">
        Only this subagent gets it, after its current tool call. The chat's reply, the subagents it started and the other
        subagents don't.
        {s.acceptingSteer === false && " Hermes said it isn't taking steers now."}
      </div>
      <div className="subagent-actions">
        <button className="btn" disabled={busy || !text.trim()} onClick={() => void steer()}>
          Steer it
        </button>
        <button ref={stopRef} className="btn danger" disabled={busy || confirming} aria-expanded={confirming} onClick={() => setConfirming(true)}>
          Stop it…
        </button>
      </div>
      {confirming && (
        <div className="subagent-confirm" role="group" aria-label="Stop this subagent?">
          <p>
            Stop {target}?{" "}
            {under === 1
              ? "The subagent it started that is still running stops with it."
              : under
                ? `The ${under} subagents it started that are still running stop with it.`
                : "It has no running subagents of its own."}{" "}
            The chat's reply and the other subagents keep going.
          </p>
          <div className="subagent-actions">
            <button className="btn danger" autoFocus onClick={() => void stop()}>
              Stop it
            </button>
            <button
              className="btn"
              onClick={() => {
                setConfirming(false);
                setFocusNext("stop");
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {sent.state === "said" && (
        <p ref={saidRef} tabIndex={-1} className={`subagent-said ${sent.ok ? "ok" : "bad"}`} role="status">
          {sent.text}
        </p>
      )}
    </div>
  );
}
