// Settings → Skills: the skills Hermes offers the model in the profile shown, listed with where each comes from and
// whether it's on, switched on or off, and their SKILL.md edited (skills.ts, GLOSSARY.md "Skill", ADR 0030). Nothing is
// written until the owner presses Save, every save is checked against the file as opened and read back, and an edit
// Hermes didn't take stays on screen. Skill text is instructions for the agent, shown as plain text only, never run or
// rendered. Installing skills from elsewhere isn't done here.
//
// Any profile's skills can be shown (the picker Settings passes in), and in Select mode several can be copied or moved to
// another profile, or archived, one at a time, each read back from Hermes (ADR 0118).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, ArrowLeft, ArrowRightLeft, Check, CheckSquare, Copy, GitMerge, History, Info, RefreshCw, Search, Trash2 } from "lucide-react";
import type { ConnectionStatus } from "../hermes/model";
import { merge3 } from "../hermes/textEdit";
import {
  ESSENTIAL_SKILLS,
  SkillsError,
  archivable,
  declaredName,
  skillProblems,
  type ReferenceCheck,
  type SkillFile,
  type SkillRow,
  type SkillsApi,
  type SkillsView,
  type TransferOutcome,
} from "../hermes/skills";
import { SettingNote, SettingRow, SettingsSection } from "./SettingRows";

/** The skill open in the editor: its row, SKILL.md as last read from Hermes, and the owner's text. */
type Editing = { row: SkillRow; base: SkillFile; draft: string };
type Notice = { kind: "ok" | "error" | "conflict" | "unsure"; text: string };
type LoadProblem = { kind: "unsupported" | "permission" | "error"; text: string };
type RowNote = { name: string; kind: "ok" | "failed"; text: string };
/** What Select mode does with the skills picked: copy or move them to another profile, or archive them here. */
type Bulk = "copy" | "move" | "archive";
/** A question before a bulk change: which, and the profile a copy or move goes to. */
type BulkAsk = { op: Bulk; to?: string };
/** The latest bulk change: what it was, where to, and what became of each skill. */
type BulkDone = { op: Bulk; to?: string; outcomes: TransferOutcome[] };

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const SOURCE: Record<string, string> = { hub: "Skills Hub", bundled: "Built in", external: "External folder", agent: "Local" };
const sourceLabel = (s: string) => SOURCE[s] ?? s;
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
/** An element id for a skill's row: one per name, without spaces (ids go in `aria-labelledby` lists). */
const domId = (name: string) => `skill-${encodeURIComponent(name)}`;

/** What happens after an edit is saved, for the notice and the screen's note. */
const EDIT_EFFECT =
  "The agent reads SKILL.md each time it loads the skill, so its next load, in any chat, gets this text. The name and description in the skills list the agent sees reach chats started from now on.";
const skillsText = (n: number) => `${n} ${n === 1 ? "skill" : "skills"}`;
const BULK_VERB: Record<Bulk, { doing: string; done: string }> = {
  copy: { doing: "Copying", done: "Copied" },
  move: { doing: "Moving", done: "Moved" },
  archive: { doing: "Archiving", done: "Archived" },
};

/** What became of one skill, in words. */
function outcomeText(op: Bulk, o: TransferOutcome, from: string, to?: string): string {
  if (o.kind === "failed") return o.problem;
  if (o.kind === "copied-only") return `Copied to ${to}, but the original couldn't be archived, so it's in both profiles now. ${o.problem}`;
  if (op === "copy") return `Copied to ${to}, and read back from Hermes there.`;
  if (op === "move") return `Moved to ${to}: the copy reads back from Hermes there, and the original is archived in ${from}.`;
  return "Archived, and gone from the list read back from Hermes.";
}

const switchEffect = (on: boolean) =>
  on
    ? "New chats list it among their skills. A chat already going doesn't list it, but can still load it by name."
    : "New chats leave it out, and from now on Hermes refuses to load it in any chat, even one already going.";

export function SkillSettings({
  api,
  profile,
  status,
  server,
  onDirtyChange,
  discardSignal = 0,
  picker,
  profiles,
}: {
  api: SkillsApi;
  profile: string;
  status: ConnectionStatus;
  /** Picks the profile shown, in place of its name (Settings' `ProfilePicker`). */
  picker?: ReactNode;
  /** Every profile Hermes lists, once read: where a copy or move can go. */
  profiles?: readonly string[];
  /** The server, as Settings names the connection (`routeLabel`). */
  server: string;
  /** Called with whether an unsaved edit is open, and with false once this goes. */
  onDirtyChange: (dirty: boolean) => void;
  /** Changes when the owner chose to discard the unsaved edit from outside (App's question), which drops it here too. */
  discardSignal?: number;
}) {
  const connected = status === "connected";
  const [view, setView] = useState<SkillsView>();
  const [problem, setProblem] = useState<LoadProblem>();
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [toggling, setToggling] = useState<string>();
  const [rowNote, setRowNote] = useState<RowNote>();
  const [opening, setOpening] = useState<string>();
  const [editing, setEditing] = useState<Editing>();
  // The server's version when it changed under the edit: kept beside the owner's edit until they merge or pick one.
  const [conflict, setConflict] = useState<SkillFile>();
  // The referenced files a Save found missing, for the text it checked; another edit makes it lapse.
  const [refs, setRefs] = useState<ReferenceCheck & { draft: string }>();
  const [busy, setBusy] = useState<"save" | "reload">();
  const [notice, setNotice] = useState<Notice>();
  // A question before the open edit is dropped or replaced: what it says, and what it would do.
  const [leaving, setLeaving] = useState<{ text: string; go: () => void }>();
  // Select mode: the skills picked, by name, the question before a change to them, the change under way, and its result.
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulkAsk, setBulkAsk] = useState<BulkAsk>();
  const [bulkRunning, setBulkRunning] = useState<{ op: Bulk; at: number; of: number }>();
  const [bulkDone, setBulkDone] = useState<BulkDone>();
  // Answers for this profile only: a late answer after the screen went away, or after a newer request, is dropped.
  const alive = useRef(true);
  const reads = useRef(0);
  const opens = useRef(0);
  const focusAfter = useRef<string | undefined>(undefined);

  const dirty = !!editing && editing.draft !== editing.base.content;
  useEffect(() => onDirtyChange(dirty), [dirty]);
  const discards = useRef(discardSignal);
  useEffect(() => {
    if (discardSignal === discards.current) return;
    discards.current = discardSignal;
    close();
  }, [discardSignal]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      onDirtyChange(false);
    };
  }, []);
  // Back in the list, focus returns to the skill's Edit button.
  useEffect(() => {
    if (editing || !focusAfter.current) return;
    document.getElementById(`${domId(focusAfter.current)}-edit`)?.focus();
    focusAfter.current = undefined;
  }, [editing]);

  const names = view?.skills.map((s) => s.name) ?? [];

  const load = async () => {
    const n = ++reads.current;
    setLoading(true);
    try {
      const next = await api.list(profile);
      if (!alive.current || n !== reads.current) return;
      setView(next);
      setProblem(undefined);
    } catch (e) {
      if (!alive.current || n !== reads.current) return;
      const kind = e instanceof SkillsError && (e.kind === "unsupported" || e.kind === "permission") ? e.kind : "error";
      // A read that fails while a list is on screen leaves it there, said to be as last read.
      if (view && kind === "error") setRowNote({ name: "", kind: "failed", text: `Couldn't read skills from Hermes again: ${messageOf(e)}` });
      else setProblem({ kind, text: kind === "error" ? `Couldn't read skills from Hermes: ${messageOf(e)}` : messageOf(e) });
    } finally {
      if (alive.current && n === reads.current) setLoading(false);
    }
  };

  // Read once connected; after a drop, the screen keeps what it read, and the owner's edit, until Reload.
  useEffect(() => {
    if (connected && !view && !problem && !loading) void load();
  }, [connected]);

  function close() {
    if (editing) focusAfter.current = editing.row.name;
    setEditing(undefined);
    setConflict(undefined);
    setRefs(undefined);
    setNotice(undefined);
    setLeaving(undefined);
  }

  /** Runs `go` now, or once the owner agrees to drop the open edit. */
  const unlessDirty = (text: string, go: () => void) => (dirty ? setLeaving({ text, go: () => (setLeaving(undefined), go()) }) : go());

  const open = async (row: SkillRow) => {
    if (busy || opening) return;
    const n = ++opens.current;
    setOpening(row.name);
    setRowNote(undefined);
    try {
      const file = await api.read(profile, row.name, names);
      if (!alive.current || n !== opens.current) return;
      setEditing({ row, base: file, draft: file.content });
      setConflict(undefined);
      setRefs(undefined);
      setNotice(undefined);
    } catch (e) {
      if (alive.current && n === opens.current) setRowNote({ name: row.name, kind: "failed", text: `Couldn't open ${row.name}: ${messageOf(e)}` });
    } finally {
      if (alive.current && n === opens.current) setOpening(undefined);
    }
  };

  const toggle = async (row: SkillRow) => {
    if (toggling || !connected) return;
    const want = !row.enabled;
    setToggling(row.name);
    setRowNote(undefined);
    try {
      const r = await api.setEnabled(profile, row.name, want);
      if (!alive.current) return;
      reads.current++; // A list read still under way is older than this one.
      setView(r.view);
      setLoading(false);
      const now = r.view.skills.find((s) => s.name === row.name);
      const state = now ? (now.enabled ? "on" : "off") : "gone from the list";
      setRowNote(
        r.confirmed
          ? { name: row.name, kind: "ok", text: `Turned ${want ? "on" : "off"}, and read back from Hermes. ${switchEffect(want)}` }
          : {
              name: row.name,
              kind: "failed",
              text: r.lost
                ? `Hermes didn't answer (${r.lost.message}), and reading back shows ${row.name} ${state}.`
                : `Hermes answered, but reading back shows ${row.name} ${state}, so the change didn't take.`,
            },
      );
    } catch (e) {
      if (alive.current) setRowNote({ name: row.name, kind: "failed", text: messageOf(e) });
    } finally {
      if (alive.current) setToggling(undefined);
    }
  };

  const save = async (allowMissing: boolean) => {
    if (!editing || busy || skillProblems(editing.draft, declaredName(editing.base)).length) return;
    const at = editing;
    setBusy("save");
    setNotice(undefined);
    setLeaving(undefined);
    try {
      const check = await api.checkReferences(at.base, at.draft);
      if (!alive.current) return;
      setRefs({ ...check, draft: at.draft });
      if (check.outside.length || (check.missing.length && !allowMissing)) return;
      const r = await api.save(profile, at.base, at.draft, names);
      if (!alive.current) return;
      if (r.kind === "saved") {
        setEditing({ ...at, base: r.file, draft: r.file.content });
        setConflict(undefined);
        setRefs(undefined);
        setNotice({ kind: "ok", text: `Saved, and read back from Hermes. ${EDIT_EFFECT}` });
        void load();
      } else if (r.kind === "conflict") {
        setConflict(r.server);
        setNotice({
          kind: "conflict",
          text: "SKILL.md changed on the server since you opened it, so nothing was saved. Your edit is still here, and the server's version is below: merge them, or use the server's.",
        });
      } else if (r.kind === "changed") {
        setConflict(r.server);
        setNotice({ kind: "conflict", text: "Hermes saved your edit, but reading it back found other text: another client wrote SKILL.md too. Your edit and the server's version are both kept." });
      } else setNotice({ kind: "unsure", text: `Hermes may have saved it, but reading it back failed: ${r.problem.message} Your edit is still here; Save again once connected, and it's checked first.` });
    } catch (e) {
      if (alive.current) setNotice({ kind: "error", text: `${messageOf(e)} Your edit is still here.` });
    } finally {
      if (alive.current) setBusy(undefined);
    }
  };

  const reload = async () => {
    if (!editing || busy) return;
    const at = editing;
    setBusy("reload");
    setNotice(undefined);
    setLeaving(undefined);
    try {
      const file = await api.read(profile, at.base.name, names);
      if (!alive.current) return;
      if (file.path === at.base.path && file.content === at.base.content)
        setNotice({ kind: "ok", text: at.draft === at.base.content ? "Hermes still has this version." : "Hermes still has the version you opened, so your edit is kept." });
      else if (at.draft === at.base.content) {
        setEditing({ ...at, base: file, draft: file.content });
        setNotice({ kind: "ok", text: "Reloaded the newer version Hermes has." });
      } else {
        setConflict(file);
        setNotice({ kind: "conflict", text: "SKILL.md changed on the server since you opened it. Your edit is kept, and the server's version is below." });
      }
      void load();
    } catch (e) {
      if (alive.current) setNotice({ kind: "error", text: `Couldn't read ${at.base.name} again: ${messageOf(e)} Your edit is still here.` });
    } finally {
      if (alive.current) setBusy(undefined);
    }
  };

  const mergeIn = () => {
    // While a save or reload runs, its answer is for the text it started with: nothing may change that text meanwhile.
    if (!editing || !conflict || busy) return;
    const m = merge3(editing.base.content, editing.draft, conflict.content);
    setEditing({ ...editing, base: conflict, draft: m.text });
    setConflict(undefined);
    setNotice({
      kind: m.conflicts ? "unsure" : "ok",
      text: m.conflicts
        ? `Merged. In ${m.conflicts === 1 ? "one place" : `${m.conflicts} places`} both versions changed the same lines; both are kept between markers. Settle ${m.conflicts === 1 ? "it" : "each"}, then Save.`
        : "Merged the server's changes into your edit. Check it, then Save.",
    });
  };

  /**
   * Copies, moves or archives `rows` one at a time. A move archives a skill only once its copy reads back from the other
   * profile, so a skill is never left in neither. The list is read again afterwards.
   */
  const runBulk = async (op: Bulk, rows: SkillRow[], to?: string) => {
    if (bulkRunning || !connected || !rows.length || (op !== "archive" && !to)) return;
    setBulkAsk(undefined);
    setBulkDone(undefined);
    setRowNote(undefined);
    const outcomes: TransferOutcome[] = [];
    for (const [i, row] of rows.entries()) {
      if (!alive.current) return;
      setBulkRunning({ op, at: i + 1, of: rows.length });
      try {
        if (op === "archive") {
          await api.archive(profile, row.name);
          outcomes.push({ name: row.name, kind: "done" });
          continue;
        }
        const file = await api.copy(profile, to!, row, names);
        if (op === "copy") {
          outcomes.push({ name: row.name, kind: "done", file });
          continue;
        }
        try {
          await api.archive(profile, row.name);
          outcomes.push({ name: row.name, kind: "done", file });
        } catch (e) {
          outcomes.push({ name: row.name, kind: "copied-only", problem: messageOf(e) });
        }
      } catch (e) {
        outcomes.push({ name: row.name, kind: "failed", problem: messageOf(e) });
      }
    }
    if (!alive.current) return;
    setBulkRunning(undefined);
    setBulkDone({ op, to, outcomes });
    // What went is no longer picked; what failed stays picked, to try again.
    const gone = new Set(outcomes.filter((o) => o.kind === "done" && op !== "copy").map((o) => o.name));
    setSelected((cur) => new Set([...cur].filter((n) => !gone.has(n))));
    void load();
  };

  const pick = (name: string, on: boolean) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });

  const endSelect = () => {
    setSelecting(false);
    setSelected(new Set());
    setBulkAsk(undefined);
  };

  const filtered = (() => {
    const q = query.trim().toLowerCase();
    const rows = view?.skills ?? [];
    return q ? rows.filter((s) => `${s.name}\n${s.description}\n${s.category ?? ""}`.toLowerCase().includes(q)) : rows;
  })();
  const off = view?.skills.filter((s) => !s.enabled).length ?? 0;
  // The picked skills still listed, in the list's order, and those Hermes won't archive (so can't move or delete).
  const picked = view?.skills.filter((s) => selected.has(s.name)) ?? [];
  const kept = picked.filter((s) => !archivable(s));
  const targets = (profiles ?? []).filter((p) => p !== profile);
  const busyBulk = !!bulkRunning;

  /** A skill's name line: its name, where it comes from, and whether something keeps it off; in Select mode, its checkbox. */
  const skillName = (s: SkillRow, pickable: boolean) => {
    const id = domId(s.name);
    const offFor = view && Object.hasOwn(view.offFor, s.name) ? view.offFor[s.name] : undefined;
    return (
      <span className="skill-name">
        {pickable && (
          <input
            type="checkbox"
            className="skill-pick"
            aria-labelledby={`${id}-label`}
            checked={selected.has(s.name)}
            disabled={busyBulk}
            onChange={(e) => pick(s.name, e.target.checked)}
          />
        )}
        <span id={`${id}-label`} className="mono">
          {s.name}
        </span>
        <span className="badge off">{sourceLabel(s.source)}</span>
        {s.scope === "shared" && <span className="badge">Shared folder</span>}
        {offFor && s.enabled && <span className="badge warn">Off in this app's chats</span>}
        {s.category && <span className="muted small skill-category">{s.category}</span>}
      </span>
    );
  };
  /** One line; the pointer resting on it shows the whole text (ADR 0113). The tip repeats the text, so it's hidden from readers. */
  const skillDesc = (s: SkillRow) => (
    <div className="skill-desc">
      <div id={`${domId(s.name)}-desc`} className="skill-desc-line">
        {s.description || "No description."}
      </div>
      {s.description && (
        <div className="skill-desc-tip" aria-hidden>
          {s.description}
        </div>
      )}
    </div>
  );

  return (
    <>
      <SettingsSection
        title="Skills"
        titleId="skills-heading"
        intro="Instructions Hermes can load for a task. Turning a skill off or editing it here changes it on the server, for every Hermes client using this profile."
        more={<p>Each skill is a SKILL.md file in a folder on the server. The agent sees each skill's name and description, and loads the rest when it needs it.</p>}
      >
        <SettingRow name="Server" control={<span className="set-value mono skills-where">{server}</span>} />
        <SettingRow name="Profile" control={picker ?? <span className="set-value mono skills-where">{profile}</span>} />

        {problem ? (
          <SettingNote className="skills-state" tone={problem.kind === "unsupported" ? "muted" : "bad"} role="alert">
            {problem.kind === "unsupported" ? <Info size={14} /> : <AlertTriangle size={14} />}
            <div>
              <div className="memory-state-title">
                {problem.kind === "unsupported" ? "This Hermes server can't manage skills" : problem.kind === "permission" ? "Hermes refused" : "Couldn't read skills"}
              </div>
              <div>{problem.text}</div>
            </div>
            {problem.kind !== "unsupported" && (
              <button className="btn" disabled={!connected || loading} onClick={() => void load()}>
                <RefreshCw size={14} /> {loading ? "Trying…" : "Try again"}
              </button>
            )}
          </SettingNote>
        ) : !view ? (
          <SettingNote role="status">{connected ? "Reading skills from Hermes…" : "Not connected to Hermes. Skills show once it's connected."}</SettingNote>
        ) : (
          <>
            {!connected && (
              <SettingNote tone="warn" role="status">
                <AlertTriangle size={14} />
                <span>Not connected to Hermes. These are the skills as read at {clock(view.readAt)}; reconnect to change or save them.</span>
              </SettingNote>
            )}
            {editing ? (
              <>
                {/* The skill's own row, with its editor under it. */}
                <SettingRow name={<span className="mono">{editing.row.name}</span>} nameAs="h3" about={editing.row.name} hint={skillDesc(editing.row)} />
                <div className="set-block memory-editor skills-editor" role="group" aria-label={`Edit ${editing.row.name}`}>
                  <button className="back" autoFocus disabled={!!busy} onClick={() => unlessDirty("Discard your unsaved edit to this skill? Nothing of it has been saved to Hermes.", close)}>
                    <ArrowLeft size={15} /> All skills
                  </button>
                  <dl className="memory-identity">
                    <div>
                      <dt>File</dt>
                      <dd className="mono">{editing.base.path}</dd>
                    </div>
                    <div>
                      <dt>Scope</dt>
                      <dd>{editing.row.scope === "shared" ? "Shared folder" : "This profile"}</dd>
                    </div>
                    <div>
                      <dt>Source</dt>
                      <dd>{sourceLabel(editing.row.source)}</dd>
                    </div>
                    <div>
                      <dt>State</dt>
                      <dd>{editing.row.enabled ? "On" : "Off"}</dd>
                    </div>
                  </dl>
                  {editing.row.scope === "shared" && (
                    <p className="muted small skills-note">
                      <Info size={12} /> This skill is in a folder the profile's <span className="mono">skills.external_dirs</span> names, outside its own skills
                      folder. Other profiles that list that folder get the edit too.
                    </p>
                  )}
                  {(editing.row.source === "bundled" || editing.row.source === "hub") && (
                    <p className="muted small skills-note">
                      <Info size={12} />{" "}
                      {editing.row.source === "bundled"
                        ? "This skill came with Hermes. Once edited, Hermes's updates keep your copy and stop updating it."
                        : "This skill came from the Skills Hub. Once edited, hub updates skip it and keep your copy."}
                    </p>
                  )}
                  <label className="field">
                    <span className="field-label">
                      SKILL.md {dirty && <span className="badge warn">Unsaved</span>}
                    </span>
                    <textarea
                      className="memory-text skills-text"
                      value={editing.draft}
                      spellCheck={false}
                      rows={Math.min(24, Math.max(10, editing.draft.split("\n").length + 1))}
                      disabled={!!busy}
                      onChange={(e) => {
                        setEditing({ ...editing, draft: e.target.value });
                        // A success said about the text before this change no longer holds.
                        if (notice?.kind === "ok") setNotice(undefined);
                      }}
                    />
                  </label>
                  <SkillProblems editing={editing} refs={refs?.draft === editing.draft ? refs : undefined} busy={!!busy} connected={connected} onSaveAnyway={() => void save(true)} />
                  {conflict && (
                    <div className="memory-recovered" role="group" aria-label="The version on the server now">
                      <div className="field-label">
                        On the server now <span className="muted small">(your edit is above; nothing is lost until you choose)</span>
                      </div>
                      <textarea className="memory-text" readOnly value={conflict.content} rows={Math.min(14, Math.max(4, conflict.content.split("\n").length + 1))} aria-label="The version on the server now" />
                      <div className="confirm-actions">
                        <button className="btn" onClick={() => void navigator.clipboard?.writeText(conflict.content).catch(() => {})}>
                          <Copy size={14} /> Copy
                        </button>
                        <button
                          className="btn"
                          disabled={!!busy}
                          onClick={() =>
                            setLeaving({
                              text: "Use the server's version and drop your edit? Nothing of your edit has been saved to Hermes.",
                              go: () => {
                                setLeaving(undefined);
                                setEditing({ ...editing, base: conflict, draft: conflict.content });
                                setConflict(undefined);
                                setNotice(undefined);
                              },
                            })
                          }
                        >
                          Use the server's version
                        </button>
                        <button className="btn primary" disabled={!!busy} onClick={mergeIn}>
                          <GitMerge size={14} /> Merge into my edit
                        </button>
                      </div>
                    </div>
                  )}
                  {leaving && (
                    <div className="confirm memory-leave" role="alertdialog" aria-label="Discard your edit?">
                      <span className="confirm-msg">{leaving.text}</span>
                      <div className="confirm-actions">
                        <button className="btn" autoFocus onClick={() => setLeaving(undefined)}>
                          Keep editing
                        </button>
                        <button className="btn danger" onClick={leaving.go}>
                          Discard edit
                        </button>
                      </div>
                    </div>
                  )}
                  <div className="memory-actions">
                    <div className="confirm-actions">
                      <RestoreButton api={api} profile={profile} editing={editing} disabled={!!busy} onRestore={(content, when) =>
                          unlessDirty("Replace your unsaved edit with the earlier version? Nothing of your edit has been saved to Hermes.", () => {
                            setEditing({ ...editing, draft: content });
                            setNotice({ kind: "ok", text: `The version your save at ${clock(when)} replaced is in the editor. Save to put it back on Hermes; nothing has changed there yet.` });
                          })
                        }
                      />
                      <button className="btn" disabled={!connected || !!busy} onClick={() => void reload()} title="Read SKILL.md from Hermes again. An edit you're making is kept.">
                        <RefreshCw size={14} /> {busy === "reload" ? "Reloading…" : "Reload"}
                      </button>
                    </div>
                    <div className="confirm-actions">
                      <button className="btn" disabled={!!busy} onClick={() => unlessDirty("Discard your unsaved edit to this skill? Nothing of it has been saved to Hermes.", close)}>
                        Cancel
                      </button>
                      <button
                        className="btn primary"
                        disabled={!connected || !dirty || !!busy || skillProblems(editing.draft, declaredName(editing.base)).length > 0}
                        onClick={() => void save(false)}
                      >
                        {busy === "save" ? "Saving…" : "Save"}
                      </button>
                    </div>
                  </div>
                  {notice && (
                    <div className={`memory-notice ${notice.kind}`} role={notice.kind === "ok" ? "status" : "alert"}>
                      {notice.kind === "ok" ? <Check size={14} /> : <AlertTriangle size={14} />}
                      <span>{notice.text}</span>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="set-block skills-toolbar">
                  <label className="skills-search">
                    <Search size={14} />
                    <input type="search" className="profile-filter" aria-label="Search skills" placeholder="Search names, descriptions and categories" value={query} onChange={(e) => setQuery(e.target.value)} />
                  </label>
                  <span className="muted small" aria-live="polite">
                    {query.trim() ? `${filtered.length} of ${view.skills.length}` : `${view.skills.length}`} {view.skills.length === 1 ? "skill" : "skills"}
                    {off > 0 && `, ${off} off`}
                  </span>
                  <button className="btn" disabled={!connected || loading || !!toggling || busyBulk} onClick={() => void load()} title="Read the skills from Hermes again.">
                    <RefreshCw size={14} /> {loading ? "Reloading…" : "Reload"}
                  </button>
                  {selecting ? (
                    <button className="btn" disabled={busyBulk} onClick={endSelect}>
                      Done
                    </button>
                  ) : (
                    <button
                      className="btn"
                      disabled={!view.skills.length || !!toggling || !!opening}
                      onClick={() => (setSelecting(true), setBulkDone(undefined), setRowNote(undefined))}
                      title="Pick skills to copy or move to another profile, or to delete."
                    >
                      <CheckSquare size={14} /> Select
                    </button>
                  )}
                </div>
                {selecting && (
                  <div className="set-block skills-bulk">
                    <SelectBar
                      profile={profile}
                      shown={filtered}
                      picked={picked}
                      kept={kept}
                      targets={targets}
                      profilesRead={!!profiles}
                      connected={connected}
                      ask={bulkAsk}
                      running={bulkRunning}
                      onPickAll={() => setSelected((cur) => new Set([...cur, ...filtered.map((r) => r.name)]))}
                      onClear={() => setSelected(new Set())}
                      onAsk={(ask) => (setBulkAsk(ask), ask && setBulkDone(undefined))}
                      onRun={(op, to) => void runBulk(op, op === "copy" ? picked : picked.filter(archivable), to)}
                    />
                  </div>
                )}
                {bulkDone && (
                  <div className="set-block skills-bulk">
                    <div className={`skills-bulk-result ${bulkDone.outcomes.some((o) => o.kind !== "done") ? "warn" : ""}`} role={bulkDone.outcomes.some((o) => o.kind !== "done") ? "alert" : "status"}>
                      <div className="skills-bulk-head">
                        {(() => {
                          const ok = bulkDone.outcomes.filter((o) => o.kind === "done").length;
                          const where = bulkDone.to ? ` to ${bulkDone.to}` : "";
                          return `${BULK_VERB[bulkDone.op].done} ${ok} of ${skillsText(bulkDone.outcomes.length)}${where}.`;
                        })()}
                        <button className="link-btn" onClick={() => setBulkDone(undefined)}>
                          Dismiss
                        </button>
                      </div>
                      <ul>
                        {bulkDone.outcomes.map((o) => (
                          <li key={o.name} className={o.kind === "done" ? "ok" : "failed"}>
                            {o.kind === "done" ? <Check size={12} /> : <AlertTriangle size={12} />} <span className="mono">{o.name}</span>: {outcomeText(bulkDone.op, o, profile, bulkDone.to)}
                          </li>
                        ))}
                      </ul>
                      {bulkDone.op !== "copy" && bulkDone.outcomes.some((o) => o.kind === "done") && (
                        <p className="muted small">
                          Hermes keeps archived skills in the {profile} profile's <span className="mono">skills/.archive</span> folder. To bring one back, run{" "}
                          <span className="mono">hermes -p {profile} curator restore &lt;name&gt;</span> on the server.
                        </p>
                      )}
                    </div>
                  </div>
                )}
                {!view.platformsRead && (
                  <SettingNote tone="warn">
                    <AlertTriangle size={14} />
                    <span>Couldn't read the profile's per-platform skill lists, or which skills they name, so a skill shown on may still be off in this app's chats.</span>
                  </SettingNote>
                )}
                {rowNote?.name === "" && (
                  <SettingNote tone="warn" role="alert">
                    {rowNote.text}
                  </SettingNote>
                )}
                {!view.skills.length ? (
                  <SettingNote>This profile has no skills yet. The agent can write one during a chat. Installing skills from elsewhere isn't done from Hermes Chat.</SettingNote>
                ) : !filtered.length ? (
                  <SettingNote>No skills match “{query.trim()}”.</SettingNote>
                ) : (
                  <ul className="set-block skills-list" aria-label="Skills">
                    {filtered.map((s) => {
                      const id = domId(s.name);
                      const offFor = Object.hasOwn(view.offFor, s.name) ? view.offFor[s.name] : undefined;
                      return (
                        <li key={s.name} className={`skill-row ${selected.has(s.name) ? "picked" : ""}`}>
                          <SettingRow
                            name={skillName(s, selecting)}
                            about={s.name}
                            hint={skillDesc(s)}
                            control={
                              !selecting && (
                                <>
                                  <button className="btn" id={`${id}-edit`} disabled={!!opening || !!toggling || busyBulk} aria-describedby={`${id}-label`} onClick={() => void open(s)}>
                                    {opening === s.name ? "Opening…" : "Edit"}
                                  </button>
                                  {ESSENTIAL_SKILLS.has(s.name) ? (
                                    <span className="badge" title="Hermes keeps this skill on.">
                                      Always on
                                    </span>
                                  ) : (
                                    <button
                                      className="switch"
                                      role="switch"
                                      aria-checked={s.enabled}
                                      aria-labelledby={`${id}-label`}
                                      aria-describedby={`${id}-desc`}
                                      disabled={!connected || !!toggling || !!opening || busyBulk}
                                      onClick={() => void toggle(s)}
                                    >
                                      <span className="switch-knob" />
                                    </button>
                                  )}
                                </>
                              )
                            }
                          >
                            {offFor && s.enabled && (
                              <div className="muted">
                                The profile's <span className="mono">skills.platform_disabled.{offFor.join("/")}</span> list keeps it off in the chats Hermes Chat
                                starts. This switch doesn't change that list.
                              </div>
                            )}
                            {toggling === s.name && (
                              <div className="switch-status" role="status">
                                Turning {s.enabled ? "off" : "on"}…
                              </div>
                            )}
                            {rowNote?.name === s.name && (
                              <div className={`switch-status ${rowNote.kind === "failed" ? "failed" : ""}`} role={rowNote.kind === "failed" ? "alert" : "status"}>
                                {rowNote.text}
                              </div>
                            )}
                          </SettingRow>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </>
            )}
          </>
        )}
      </SettingsSection>

      <SettingsSection title="When changes take effect" intro="Nothing needs restarting or reloading.">
        <SettingRow name="Saving an edit" hint="The skill's next load, in any chat, gets the saved text." more={<p>{EDIT_EFFECT}</p>} />
        <SettingRow
          name="Turning a skill off"
          hint="Chats started from now on leave it out, and Hermes then refuses to load it in any chat, even one already going."
          more={
            <p>
              The switch is the profile's <span className="mono">skills.disabled</span> list, which every platform follows.
            </p>
          }
        />
        <SettingRow name="Turning a skill on" hint="New chats list it; one already going can still load it by name." />
        <SettingRow
          name="Undoing a saved edit"
          hint="Restore previous version, until you sign out or close Hermes Chat; earlier versions aren't kept on the server or on this computer."
        />
      </SettingsSection>
    </>
  );
}

/**
 * Select mode's bar: how many skills are picked, picking all shown or none, and Copy to, Move to and Delete, each asked
 * first in place, with what it does. Hermes archives only a profile's own (Local) skills, so the others can be copied but
 * not moved or deleted, and the bar says which.
 */
function SelectBar({
  profile,
  shown,
  picked,
  kept,
  targets,
  profilesRead,
  connected,
  ask,
  running,
  onPickAll,
  onClear,
  onAsk,
  onRun,
}: {
  profile: string;
  shown: SkillRow[];
  picked: SkillRow[];
  /** The picked skills Hermes won't archive. */
  kept: SkillRow[];
  /** The other profiles a copy or move can go to. */
  targets: string[];
  profilesRead: boolean;
  connected: boolean;
  ask?: BulkAsk;
  running?: { op: Bulk; at: number; of: number };
  onPickAll: () => void;
  onClear: () => void;
  onAsk: (ask: BulkAsk | undefined) => void;
  onRun: (op: Bulk, to?: string) => void;
}) {
  const n = picked.length;
  const movable = n - kept.length;
  const allShown = shown.length > 0 && shown.every((r) => picked.some((p) => p.name === r.name));
  const off = !connected || !!running;
  const noTarget = !profilesRead ? "Reading the server's profiles…" : !targets.length ? "This server has no other profile to copy to." : undefined;
  const keptNames = kept.map((r) => r.name).join(", ");
  return (
    <div className="skills-select" role="group" aria-label="Selected skills">
      <div className="skills-select-bar">
        <span className="skills-select-count" aria-live="polite">
          {n ? `${skillsText(n)} selected` : "No skills selected"}
        </span>
        <button className="link-btn" disabled={!!running || allShown || !shown.length} onClick={onPickAll}>
          Select all shown
        </button>
        <button className="link-btn" disabled={!!running || !n} onClick={onClear}>
          Clear
        </button>
        <span className="skills-select-actions">
          <button className="btn" disabled={off || !n || !!noTarget} title={noTarget} onClick={() => onAsk({ op: "copy", to: targets[0] })}>
            <Copy size={14} /> Copy to…
          </button>
          <button
            className="btn"
            disabled={off || !movable || !!noTarget}
            title={noTarget ?? (n && !movable ? "Hermes archives only Local skills listed by their own name, so none of these can be moved." : undefined)}
            onClick={() => onAsk({ op: "move", to: targets[0] })}
          >
            <ArrowRightLeft size={14} /> Move to…
          </button>
          <button
            className="btn danger"
            disabled={off || !movable}
            title={n && !movable ? "Hermes archives only Local skills listed by their own name, so none of these can be deleted." : undefined}
            onClick={() => onAsk({ op: "archive" })}
          >
            <Trash2 size={14} /> Delete…
          </button>
        </span>
      </div>
      {kept.length > 0 && !running && (
        <p className="muted small skills-note">
          <Info size={12} /> Hermes won't archive {keptNames}, so Move and Delete leave {kept.length === 1 ? "it" : "them"} out; Copy still works.
          It archives only Local skills, and finds one by the name it declares, so a skill listed by its folder path (two skills declare the same
          name) can't be archived either.
        </p>
      )}
      {running && (
        <div className="switch-status" role="status">
          {BULK_VERB[running.op].doing} {running.at} of {running.of}… Each one is read back from Hermes before the next.
        </div>
      )}
      {ask && !running && (
        <div className="confirm skills-bulk-ask" role="alertdialog" aria-label={ask.op === "archive" ? "Delete the selected skills?" : `${ask.op === "copy" ? "Copy" : "Move"} the selected skills?`}>
          {ask.op !== "archive" && (
            <label className="field">
              <span className="field-label">To profile</span>
              <select className="mono" value={ask.to} onChange={(e) => onAsk({ ...ask, to: e.target.value })} autoFocus>
                {targets.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
          )}
          <span className="confirm-msg">
            {ask.op === "copy" &&
              `Copy ${skillsText(n)} from ${profile} to ${ask.to}? Each becomes a new Local skill there, with the same name and category, and is read back from Hermes. Only SKILL.md is copied: files under references/, templates/, scripts/ or assets/ stay in ${profile}. Hermes refuses a name ${ask.to} already has.`}
            {ask.op === "move" &&
              `Move ${skillsText(movable)} from ${profile} to ${ask.to}? Each is copied as a new Local skill there and read back, then archived in ${profile}. Only SKILL.md is copied: files under references/, templates/, scripts/ or assets/ stay in ${profile}'s archive. Hermes refuses a name ${ask.to} already has, and then leaves the original where it is.`}
            {ask.op === "archive" &&
              `Delete ${skillsText(movable)} from ${profile}? Hermes archives each one: it moves the skill's folder into ${profile}'s skills/.archive, so new chats no longer see it, and Hermes refuses to load it in chats already going. Hermes Chat can't bring one back; running hermes -p ${profile} curator restore <name> on the server does.`}
          </span>
          <div className="confirm-actions">
            <button className="btn" autoFocus={ask.op === "archive"} onClick={() => onAsk(undefined)}>
              Cancel
            </button>
            <button className={`btn ${ask.op === "copy" ? "primary" : "danger"}`} disabled={off || (ask.op !== "archive" && !ask.to)} onClick={() => onRun(ask.op, ask.to)}>
              {ask.op === "copy" ? `Copy ${skillsText(n)}` : ask.op === "move" ? `Move ${skillsText(movable)}` : `Delete ${skillsText(movable)}`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Why the edit can't be saved yet: Hermes's own front matter rules, and the files the body names that aren't there. */
function SkillProblems({
  editing,
  refs,
  busy,
  connected,
  onSaveAnyway,
}: {
  editing: Editing;
  refs?: ReferenceCheck;
  busy: boolean;
  connected: boolean;
  onSaveAnyway: () => void;
}) {
  const problems = editing.draft !== editing.base.content ? skillProblems(editing.draft, declaredName(editing.base)) : [];
  if (!problems.length && !refs?.missing.length && !refs?.outside.length && !refs?.unchecked) return null;
  return (
    <div className="skills-problems" role="alert" aria-label="Fix before saving">
      {problems.length > 0 && (
        <>
          <div className="field-label">Fix before saving</div>
          <ul>
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </>
      )}
      {!!refs?.outside.length && (
        <>
          <div className="field-label">Paths outside the skill's folder</div>
          <ul>
            {refs.outside.map((p) => (
              <li key={p}>
                <span className="mono">{p}</span> leads out of the skill's folder. A skill's files have to be inside it; remove the <span className="mono">..</span>{" "}
                from the path.
              </li>
            ))}
          </ul>
        </>
      )}
      {!!refs?.missing.length && (
        <>
          <div className="field-label">Files the skill names that aren't on the server</div>
          <ul>
            {refs.missing.map((p) => (
              <li key={p}>
                <span className="mono">{p}</span>
              </li>
            ))}
          </ul>
          <p className="muted small">
            The agent would find nothing there. Fix the path, or add the file in <span className="mono">{editing.base.path.replace(/\/SKILL\.md$/, "/")}</span> on
            the server (Server files can upload it), then Save again.
          </p>
          {!refs.outside.length && !problems.length && (
            <button className="btn" disabled={busy || !connected} onClick={onSaveAnyway}>
              Save with missing files
            </button>
          )}
        </>
      )}
      {refs?.unchecked && <p className="muted small">{refs.unchecked}</p>}
    </div>
  );
}

/** Puts back the text a save from here replaced, for the owner to check and save. Only while this sign-in lasts. */
function RestoreButton({
  api,
  profile,
  editing,
  disabled,
  onRestore,
}: {
  api: SkillsApi;
  profile: string;
  editing: Editing;
  disabled: boolean;
  onRestore: (content: string, when: number) => void;
}) {
  const version = api.versionsOf(profile, editing.base.path).find((v) => v.content !== editing.draft);
  if (!version) return null;
  return (
    <button className="btn" disabled={disabled} onClick={() => onRestore(version.content, version.replacedAt)} title={`The text your save at ${clock(version.replacedAt)} replaced.`}>
      <History size={14} /> Restore previous version
    </button>
  );
}
