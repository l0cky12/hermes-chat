// The Subagents a chat's reply started (ADR 0072), above the composer: a tree of who started whom, and one subagent's
// own activity and output apart from the chat. Steer and Stop act on one subagent, named in full before they go.
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  CircleStop,
  Clock,
  CircleX,
  Code,
  Copy,
  CornerDownRight,
  FilePen,
  FileText,
  Globe,
  History,
  Info,
  RefreshCw,
  Search,
  SendHorizontal,
  Square,
  Terminal,
  Workflow,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  childrenOf,
  descendantsOf,
  hasEnded,
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
import { clockTimeWithSeconds, plural } from "../hermes/values";

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

  // While one subagent's details are open the drawer never shrinks, up to its cap: switching tabs or stepping to a
  // shorter subagent moves nothing under the pointer. It opens fitted to what it shows, and the list resets it.
  // Its size is watched, since a tab, a read or an opened line changes it without the drawer itself rendering.
  const details = open && !!shown;
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    el.style.minHeight = "";
    if (!details) return;
    let floor = 0;
    const hold = () => {
      floor = Math.max(floor, el.offsetHeight);
      el.style.minHeight = `min(${floor}px, 45vh)`;
    };
    hold();
    const watch = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(hold);
    watch?.observe(el);
    return () => watch?.disconnect();
  }, [details]);

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
          <SubagentView key={shown.id} tree={tree} s={shown} api={api} asked={asked} onBack={back} onOpen={setPicked} />
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

type Tone = "live" | "ok" | "bad" | "dim";
const toneOf = (state: SubagentState): Tone =>
  isLive(state) ? "live" : isFailure(state) ? "bad" : state === "unknown" || state === "ended" || state === "interrupted" ? "dim" : "ok";

function StateBadge({ state }: { state: SubagentState }) {
  return <span className={`subagent-state ${toneOf(state)}`}>{STATE_LABEL[state]}</span>;
}

/** Its state in the details view: a dot while it runs, how it ended once it has. */
function StatePill({ state }: { state: SubagentState }) {
  // Queued is alive but not yet doing anything, so it isn't drawn as running.
  const tone = state === "queued" ? "dim" : toneOf(state);
  const Icon = state === "completed" ? Check : state === "interrupted" ? Square : state === "queued" ? Clock : tone === "bad" ? X : undefined;
  return (
    <span className={`subagent-pill ${tone}`}>
      {tone === "live" ? <span className="subagent-dot" aria-hidden /> : Icon && <Icon size={state === "interrupted" ? 9 : 11} aria-hidden />}
      {STATE_LABEL[state]}
    </span>
  );
}

const pad = (n: number) => String(Math.floor(n)).padStart(2, "0");
/** A length of time: "3.4s", "41s", "1m 35s", "1h 02m". */
export function spanText(seconds: number): string {
  const s = Math.max(0, seconds);
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${pad((s % 3600) / 60)}m`;
}
/** How long after its start something happened: "+0:03", "+1:02", "+1:02:03". */
export function offsetText(seconds: number): string {
  const s = Math.max(0, seconds);
  return s < 3600 ? `+${Math.floor(s / 60)}:${pad(s % 60)}` : `+${Math.floor(s / 3600)}:${pad((s % 3600) / 60)}:${pad(s % 60)}`;
}

/** How long it has run, counting up each second while it runs; none when the app can't tell. */
function useRunTime(s: Subagent): string | undefined {
  const running = s.state === "running" && s.startedAt !== undefined;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  if (running) return `${spanText((now - s.startedAt!) / 1000)} so far`;
  if (!hasEnded(s.state)) return undefined;
  const end = s.activity.find((a) => a.kind === "ended")?.at;
  const ran = s.durationS ?? (s.startedAt !== undefined && end !== undefined ? (end - s.startedAt) / 1000 : undefined);
  return ran === undefined ? undefined : `ran ${spanText(ran)}`;
}

/** The icon for how it ended, in its result and the end of its activity. */
function EndIcon({ state, size }: { state: SubagentState; size: number }) {
  if (state === "completed") return <CircleCheck size={size} aria-hidden />;
  if (state === "interrupted") return <CircleStop size={size} aria-hidden />;
  return isFailure(state) ? <CircleX size={size} aria-hidden /> : <Info size={size} aria-hidden />;
}

const TOOL_ICON: Record<string, LucideIcon> = {
  terminal: Terminal,
  process: Terminal,
  read_file: FileText,
  write_file: FilePen,
  patch: FilePen,
  search_files: Search,
  execute_code: Code,
  web_search: Globe,
  web_extract: Globe,
};

type Tab = "activity" | "output" | "subagents";
const TAB_LABEL: Record<Tab, string> = { activity: "Activity", output: "Output", subagents: "Subagents" };

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
  // Opening one reads Hermes's roster again: it is how Hermes tells of a nested subagent's tools, which its events leave out.
  useEffect(() => void api?.refresh(), [s.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const parent = s.parent && tree.subagents.find((p) => p.id === s.parent);
  const kids = childrenOf(tree, s.id);
  const siblings = childrenOf(tree, parent ? parent.id : undefined);
  const at = siblings.findIndex((x) => x.id === s.id);
  const step = (by: number) => siblings.length > 1 && onOpen(siblings[(at + by + siblings.length) % siblings.length].id);

  const tabs: Tab[] = ["activity", ...(running && api && !s.stored ? (["output"] as const) : []), ...(kids.length ? (["subagents"] as const) : [])];
  const [picked, setPicked] = useState<Tab>("activity");
  const tab = tabs.includes(picked) ? picked : "activity";
  const reload = useRef<() => void>(undefined);
  const [about, setAbout] = useState(false);
  const ids = useId();
  const ran = useRunTime(s);
  const under = descendantsOf(tree, s.id).filter(live);
  // When one the owner was following (at the bottom of its log or output) ends, how it ended comes into view at the top.
  // One they had scrolled up to read stays where they are.
  const bodyRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  // The body shrinks when the foot grows (Stop's question, Steer's hint, a longer steer): one being followed stays at
  // its newest line.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || !running || typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(() => {
      if (following.current) body.scrollTop = body.scrollHeight;
    });
    watch.observe(body);
    return () => watch.disconnect();
  }, [running]);
  const ranBefore = useRef(running);
  useEffect(() => {
    // Reading its output is no place to stay: that tab goes when it ends.
    if (ranBefore.current && !running && (following.current || picked === "output") && bodyRef.current) bodyRef.current.scrollTop = 0;
    ranBefore.current = running;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `picked` is read when it ends, not watched
  }, [running]);

  return (
    <div
      className={`subagent-view${tabs.length > 1 ? " tabbed" : ""}`}
      onKeyDown={(e) => {
        if (composing(e)) return;
        const typing = e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement;
        if (e.key === "Escape" && !e.defaultPrevented && e.target instanceof HTMLTextAreaElement && e.target.value.trim()) {
          // A Steer draft isn't thrown away by going back: the first Esc leaves the box, the next goes back.
          e.stopPropagation();
          e.target.blur();
          headRef.current?.focus();
        } else if (e.key === "Escape" && !e.defaultPrevented) {
          e.stopPropagation();
          onBack();
        } else if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight") && !typing) {
          e.preventDefault();
          step(e.key === "ArrowLeft" ? -1 : 1);
        } else if (tab === "output" && (e.key === "r" || e.key === "R") && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          reload.current?.();
        }
      }}
    >
      <div className="subagent-top">
        <button className="icon-btn subagent-back" title="All subagents (Esc)" aria-label="All subagents" onClick={onBack}>
          <ArrowLeft size={15} aria-hidden />
        </button>
        <div className="subagent-titles">
          <h3 ref={headRef} tabIndex={-1} className="subagent-title" title={nameOf(s)}>
            {nameOf(s)}
          </h3>
          <div className="subagent-line">
            <StatePill state={s.state} />
            {s.partial && (
              <span className="subagent-pill partial" title="The app heard of it only part way through">
                Partial
              </span>
            )}
            {/* Each part carries the dot before it, which is clipped off when the part starts a line. */}
            <span className="subagent-parts">
              {[
                s.model,
                ran && (
                  <span key="ran" className="subagent-num">
                    {ran}
                  </span>
                ),
                s.toolCount !== undefined && (
                  <span key="tools" className="subagent-num">
                    {plural(s.toolCount, "tool call")}
                  </span>
                ),
                parent ? (
                  <span key="by" className="subagent-by">
                    started by{" "}
                    <button className="link-btn subagent-parent" title={nameOf(parent)} onClick={() => onOpen(parent.id)}>
                      <span>{nameOf(parent)}</span>
                    </button>
                  </span>
                ) : (
                  "started by the chat's reply"
                ),
              ]
                .filter(Boolean)
                .map((part, i) => (
                  <span key={i} className="subagent-part">
                    {part}
                  </span>
                ))}
            </span>
          </div>
        </div>
        {siblings.length > 1 && (
          <div className="subagent-sibs" role="group" aria-label="The subagents beside it">
            <button className="icon-btn" title="Previous subagent (Alt+←)" aria-label="Previous subagent" onClick={() => step(-1)}>
              <ChevronLeft size={14} aria-hidden />
            </button>
            <span className="subagent-num">
              {at + 1} / {siblings.length}
            </span>
            <button className="icon-btn" title="Next subagent (Alt+→)" aria-label="Next subagent" onClick={() => step(1)}>
              <ChevronRight size={14} aria-hidden />
            </button>
          </div>
        )}
        <button
          className={`icon-btn subagent-info${about ? " on" : ""}`}
          title="More about it"
          aria-label="More about it"
          aria-expanded={about}
          aria-controls={`${ids}about`}
          onClick={() => setAbout((a) => !a)}
        >
          <Info size={14} aria-hidden />
        </button>
      </div>
      {about && (
        <div id={`${ids}about`} className="subagent-about">
          <div>
            Id <span className="mono">{s.id}</span> <CopyButton text={s.id} />
            {s.startedAt !== undefined && <> · started {clockTimeWithSeconds(s.startedAt)}</>}
          </div>
          <div>
            A subagent never asks you for approval: Hermes refuses its risky commands, or allows them if the profile's
            delegation settings say so.
          </div>
        </div>
      )}
      {/* One part scrolls: how it ended first, then its tabs, which stay in view while it scrolls. */}
      <div
        ref={bodyRef}
        className="subagent-body"
        onScroll={(e) => {
          const b = e.currentTarget;
          following.current = b.scrollHeight - b.scrollTop - b.clientHeight < 48;
        }}
      >
      {s.state === "ended" && <p className="subagent-why subagent-note">Hermes didn't say how it ended.</p>}
      {s.state === "unknown" && <p className="subagent-why subagent-note">The app knows it only as the parent of a subagent it heard from, and Hermes hasn't described it yet.</p>}
      {s.summary && <Result s={s} />}
      {tabs.length > 1 ? (
        <div
          className="subagent-tabs"
          role="tablist"
          aria-label={nameOf(s)}
          onKeyDown={(e) => {
            const i = tabs.indexOf(tab);
            const next = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: tabs.length - 1 }[e.key];
            if (next === undefined) return;
            e.preventDefault();
            const t = tabs[(next + tabs.length) % tabs.length];
            setPicked(t);
            e.currentTarget.querySelector<HTMLElement>(`[data-tab="${t}"]`)?.focus();
          }}
        >
          {tabs.map((t) => (
            <button
              key={t}
              role="tab"
              id={`${ids}tab-${t}`}
              data-tab={t}
              className="subagent-tab"
              aria-selected={t === tab}
              aria-controls={`${ids}panel`}
              tabIndex={t === tab ? 0 : -1}
              onClick={() => setPicked(t)}
            >
              {TAB_LABEL[t]}
              {t !== "output" && <span className="subagent-count">{t === "activity" ? s.activity.length : kids.length}</span>}
            </button>
          ))}
        </div>
      ) : (
        <h4 className="subagent-section">Activity</h4>
      )}
      <div
        id={`${ids}panel`}
        className="subagent-panel"
        {...(tabs.length > 1 && { role: "tabpanel", "aria-labelledby": `${ids}tab-${tab}` })}
      >
        {tab === "activity" && <Activity s={s} following={following} />}
        {tab === "output" && api && <Output id={s.id} api={api} reload={reload} />}
        {tab === "subagents" && <Branch tree={tree} parent={s.id} onOpen={onOpen} />}
      </div>
      </div>
      {api && running && isSteerable(s) ? (
        <Controls key={s.id} s={s} under={under} api={api} />
      ) : (
        (api || !running) && (
          <p className="subagent-ended">
            <Info size={13} aria-hidden />
            {s.state === "unknown"
              ? "Hermes hasn't described it, so it can't be steered or stopped here."
              : running
                ? "Hermes gave it no id, so it can't be steered or stopped."
                : "It has ended, so it can't be steered or stopped."}
          </p>
        )
      )}
    </div>
  );
}

/** How it ended, in Hermes's words; a long one shows its first lines until asked for the rest. */
function Result({ s }: { s: Subagent }) {
  const [all, setAll] = useState(false);
  const long = s.summary!.length > 240 || s.summary!.split("\n").length > 3;
  const tone = toneOf(s.state);
  return (
    <div className={`subagent-result ${tone}${long && !all ? " clamped" : ""}`}>
      <b>
        <EndIcon state={s.state} size={14} />
        {isFailure(s.state) ? "Why it failed" : s.state === "interrupted" ? "Where it stopped" : "How it ended"}
      </b>
      <p>{s.summary}</p>
      {long && (
        <button className="link-btn subagent-more" aria-expanded={all} onClick={() => setAll((a) => !a)}>
          {all ? "Show less" : "Show all"}
        </button>
      )}
    </div>
  );
}

/** `following`: the view's body is at its bottom, which the view tracks as it scrolls. */
function Activity({ s, following }: { s: Subagent; following: { readonly current: boolean } }) {
  const listRef = useRef<HTMLOListElement>(null);
  const running = live(s);
  // While it runs, it opens at its newest line and follows new ones, unless the owner has scrolled up to read. Once it
  // has ended it opens at the top, where how it ended is.
  const box = () => listRef.current?.closest<HTMLElement>(".subagent-body");
  useEffect(() => {
    const b = box();
    if (running && b) b.scrollTop = b.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const b = box();
    if (running && b && following.current) b.scrollTop = b.scrollHeight;
  }, [s.activity.length, running, following]);
  const [open, setOpen] = useState<number>();
  // Which previews the line cuts short: only those open in full, so a line that fits isn't a button that does nothing.
  const [cut, setCut] = useState<ReadonlySet<number>>(new Set());
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    // An open line wraps, so it no longer overflows: it stays cut short, and its button stays, until it is closed.
    const measure = () =>
      setCut((was) => {
        const now = new Set<number>();
        list.querySelectorAll<HTMLElement>(".tool-preview[data-i]").forEach((p) => {
          const i = Number(p.dataset.i);
          if (p.scrollWidth > p.clientWidth + 1 || (was.has(i) && p.closest(".whole"))) now.add(i);
        });
        return was.size === now.size && [...now].every((i) => was.has(i)) ? was : now;
      });
    measure();
    const watch = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    watch?.observe(list);
    return () => watch?.disconnect();
  }, [s.activity.length]);
  // Heard of only part way, its start is known from when it ended and how long it ran.
  const end = s.activity.find((a) => a.kind === "ended")?.at;
  const start = s.startedAt ?? (end !== undefined && s.durationS !== undefined ? end - s.durationS * 1000 : undefined);
  const when = (at: number) => (start !== undefined ? offsetText((at - start) / 1000) : clockTimeWithSeconds(at));
  const newest = running ? s.activity.map((a) => a.kind).lastIndexOf("tool") : -1;
  return (
    <>
      {s.partial && (
        <p className="subagent-why subagent-partial-note">
          <History size={12} aria-hidden /> The app heard of it only part way through, so what it did before isn't shown.
        </p>
      )}
      {s.activity.length ? (
        <ol ref={listRef} className="subagent-acts" aria-label="What it did">
          {s.activity.map((a, i) => {
            const Tool = a.kind === "tool" ? (TOOL_ICON[a.tool] ?? Wrench) : undefined;
            return (
              <li key={i} className={`subagent-act${a.kind === "ended" ? ` end ${toneOf(s.state)}` : ""}${i === newest ? " newest" : ""}${open === i ? " whole" : ""}`}>
                <span className="subagent-act-icon">
                  {i === newest ? <span className="subagent-dot" aria-hidden /> : Tool ? <Tool size={13} aria-hidden /> : <EndIcon state={s.state} size={13} />}
                </span>
                {a.kind === "tool" ? (
                  // A preview the line cuts short opens in full; one that fits is plain text.
                  cut.has(i) ? (
                    <button
                      className="subagent-act-call"
                      aria-expanded={open === i}
                      onClick={(e) => {
                        // A drag that selected part of the command copies it; it doesn't open or close the line. Enter and
                        // Space (a click with no pointer, `detail` 0) always do.
                        const picked = getSelection();
                        if (e.detail > 0 && picked && !picked.isCollapsed && e.currentTarget.contains(picked.anchorNode)) return;
                        setOpen(open === i ? undefined : i);
                      }}
                    >
                      <span className="tool-name">{a.tool}</span>
                      <span className="tool-preview" data-i={i}>
                        {a.preview}
                      </span>
                    </button>
                  ) : (
                    <span className="subagent-act-call">
                      <span className="tool-name">{a.tool}</span>
                      {a.preview && (
                        <span className="tool-preview" data-i={i}>
                          {a.preview}
                        </span>
                      )}
                    </span>
                  )
                ) : (
                  <span className="subagent-act-text">{a.text}</span>
                )}
                <span className="subagent-at" title={`Heard at ${clockTimeWithSeconds(a.at)}`}>
                  {when(a.at)}
                </span>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="subagent-why">{s.stored ? "Hermes keeps only how this background task failed." : "Nothing heard yet."}</p>
      )}
    </>
  );
}

type Read = { state: "loading" } | { state: "done"; output: SubagentOutput; at: number } | { state: "failed"; why: string };

function Output({ id, api, reload }: { id: SubagentId; api: SubagentsApi; reload: { current?: () => void } }) {
  const [read, setRead] = useState<Read>({ state: "loading" });
  const asked = useRef(0);
  const preRef = useRef<HTMLPreElement>(null);
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
  reload.current = load;
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `asked` is a counter, not a DOM node: the cleanup bumps its live value so a late answer for the old subagent is dropped
    return () => void asked.current++;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  // It is the end of a transcript: it opens at its newest line, in the view's one scroll.
  useEffect(() => {
    const body = preRef.current?.closest<HTMLElement>(".subagent-body");
    if (body) body.scrollTop = body.scrollHeight;
  }, [read]);

  return (
    <div className="subagent-output">
      <div className="subagent-output-head">
        <span>
          {read.state === "done" && read.output.available
            ? `${read.output.truncated ? "The last 16 KB of its transcript" : "Its transcript so far"}, read ${clockTimeWithSeconds(read.at)}`
            : "Its transcript so far"}
        </span>
        <button className="icon-btn" title="Read its output again (R)" aria-label="Read its output again" disabled={read.state === "loading"} onClick={load}>
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
        <pre ref={preRef} className="subagent-tail">
          {read.output.text || "(nothing yet)"}
        </pre>
      ) : (
        <p className="subagent-why">Hermes shares a subagent's output only while it runs, and only with the chat session that started it.</p>
      )}
    </div>
  );
}

type Sent = { state: "idle" } | { state: "busy" } | { state: "said"; text: string; ok: boolean };

/** "“a”", "“a” and “b”", "“a”, “b” and 2 more". */
function namesOf(list: Subagent[]): string {
  const names = list.slice(0, list.length > 3 ? 2 : 3).map((x) => `“${nameOf(x)}”`);
  if (list.length > 3) names.push(`${list.length - 2} more`);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
}

function Controls({ s, under, api }: { s: Subagent; under: Subagent[]; api: SubagentsApi }) {
  const [text, setText] = useState("");
  const [typing, setTyping] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [sent, setSent] = useState<Sent>({ state: "idle" });
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const stopRef = useRef<HTMLButtonElement>(null);
  const saidRef = useRef<HTMLParagraphElement>(null);
  // Where focus goes once the controls it was on are gone or disabled, as soon as that place is there to take it.
  const [focusNext, setFocusNext] = useState<"box" | "stop" | "said" | "cancel">();
  const cancelRef = useRef<HTMLButtonElement>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- runs after every render on purpose: focus waits until its target is rendered and enabled, which a later render brings
  useEffect(() => {
    const el = focusNext && { box: boxRef, stop: stopRef, said: saidRef, cancel: cancelRef }[focusNext].current;
    if (!el || ("disabled" in el && el.disabled)) return;
    setFocusNext(undefined);
    el.focus();
  });
  const target = `“${nameOf(s)}” (${shortId(s.id)})`;
  const hintId = useId();
  // The box grows with what is typed, wrapped lines too, up to its CSS max-height.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    box.style.height = "auto";
    box.style.height = `${box.scrollHeight}px`;
  }, [text]);
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
      <p className="subagent-ended" role="note">
        <Info size={13} aria-hidden /> Steer and Stop: {api.blocked}
      </p>
    );
  const cancel = () => {
    setConfirming(false);
    setFocusNext("stop");
  };
  return (
    <div className="subagent-controls">
      {sent.state === "said" && (
        <p ref={saidRef} tabIndex={-1} className={`subagent-said ${sent.ok ? "ok" : "bad"}`} role="status">
          {sent.text}
        </p>
      )}
      {s.acceptingSteer === false && sent.state !== "said" && <p className="subagent-said">Hermes said it isn't taking steers now.</p>}
      <div className="subagent-steer" hidden={confirming}>
        <div className="subagent-steer-box">
          <span className="subagent-steer-tag" aria-hidden>
            <CornerDownRight size={12} />
            Steer
          </span>
          <textarea
            ref={boxRef}
            rows={1}
            value={text}
            aria-label={`Steer ${target}`}
            aria-describedby={`${hintId}`}
            placeholder="What it should do differently"
            disabled={busy}
            onFocus={() => setTyping(true)}
            onBlur={() => setTyping(false)}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !composing(e) && text.trim()) {
                e.preventDefault();
                void steer();
              }
            }}
          />
          <button className="subagent-send" title="Steer it (Enter)" aria-label="Steer it" disabled={busy || !text.trim()} onClick={() => void steer()}>
            <SendHorizontal size={14} aria-hidden />
          </button>
        </div>
        <button ref={stopRef} className="btn subagent-stop" disabled={busy} aria-expanded={confirming} onClick={() => (setConfirming(true), setFocusNext("cancel"))}>
          <Square size={11} aria-hidden /> Stop
        </button>
      </div>
      <p id={hintId} className="subagent-hint" hidden={confirming || !(typing || text)}>
        Only this subagent reads it, after its current tool call. Enter sends it; Shift+Enter starts a new line.
      </p>
      {confirming && (
        <div
          className="subagent-confirm"
          role="group"
          aria-label="Stop this subagent?"
          onKeyDown={(e) => {
            if (e.key !== "Escape" || composing(e)) return;
            e.preventDefault();
            cancel();
          }}
        >
          <p>
            Stop “{nameOf(s)}” <span className="subagent-id">({shortId(s.id)})</span>?{" "}
            {under.length === 1
              ? `${namesOf(under)}, which it started, stops with it.`
              : under.length
                ? `The ${under.length} subagents it started that are still running stop with it: ${namesOf(under)}.`
                : "It has no running subagents of its own."}{" "}
            The chat's reply and the other subagents keep going.
          </p>
          <button className="btn danger" onClick={() => void stop()}>
            Stop it
          </button>
          <button ref={cancelRef} className="btn" onClick={cancel}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      className="icon-btn small"
      title="Copy its id"
      aria-label="Copy its id"
      onClick={() => void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => {})}
    >
      {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
    </button>
  );
}
