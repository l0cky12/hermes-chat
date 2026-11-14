// The Work page (issue #595, ADR 0171): the dashboard's kanban board of bot work, laid out and featured as the official
// Hermes desktop app's Kanban view. It reads the current board, and changes it only on an explicit move, edit, new
// task or comment. The move rules come from the plugin's own workflow (kanban.ts `canMove`).
import { useEffect, useId, useRef, useState, type DragEvent, type ReactNode } from "react";
import { ArrowLeft, CircleAlert, Pencil, Plus, RefreshCw, SquareKanban, TriangleAlert, User, X } from "lucide-react";
import {
  NoKanbanPlugin,
  canMove,
  moveNeeds,
  moveSettled,
  refused,
  taskEdits,
  type Board,
  type BoardTask,
  type KanbanApi,
  type PendingMove,
  type TaskComment,
  type TaskFields,
  type Workflow,
} from "../hermes/kanban";
import { errorText, plural } from "../hermes/values";
import { Spinner } from "./bits";
import { useModal } from "./modal";

export type WorkApi = Pick<KanbanApi, "loadBoard" | "loadWorkflow" | "loadTask" | "createTask" | "editTask" | "addComment" | "moveTask">;

/** A move waiting on its summary or reason. */
type Ask = { task: BoardTask; to: string; need: "summary" | "reason" };
/**
 * The New task form. `key`: its idempotency key, fresh per form and reused by its retries. `unanswered`: a create got no
 * answer and may have landed, so the fields stay locked and Create resends exactly what was sent.
 */
type Draft = { fields: TaskFields; key: string; creating: boolean; unanswered: boolean; error?: string };

const blank = (): TaskFields => ({ title: "", body: "", priority: 0, assignee: "" });
const validFields = (f: TaskFields) => !!f.title.trim() && Number.isInteger(f.priority);

export function Work({ api, connected, onClose, pollMs = 10_000 }: { api: WorkApi; connected: boolean; onClose: () => void; pollMs?: number }) {
  const [board, setBoard] = useState<Board>();
  const [workflow, setWorkflow] = useState<Workflow>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>();
  const [saving, setSaving] = useState(false);
  // A move that went through, or whose answer was lost, until the board shows it: the task's actions stay off so it
  // can't be sent twice. Refresh clears it, in case a lost write never landed.
  const [pending, setPending] = useState<PendingMove>();
  const [moveErr, setMoveErr] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [dragging, setDragging] = useState<BoardTask>();
  const [over, setOver] = useState<string>();
  const [openId, setOpenId] = useState<string>();
  const [ask, setAsk] = useState<Ask>();
  const [draft, setDraft] = useState<Draft>();
  const locked = saving || !!pending;

  // What the poll and a read in flight check, as of now rather than as of the render that started them.
  const now = useRef({ loading, saving, pending, workflow, prompt: false });
  now.current = { loading, saving, pending, workflow, prompt: !!ask || !!draft };
  // Set in the drag handlers themselves: a read landing mid-drag would replace the dragged card's element.
  const draggingNow = useRef<BoardTask>(undefined);
  const live = useRef(true);
  const seq = useRef(0);
  const apiRef = useRef(api);
  apiRef.current = api;

  const load = async (force = false) => {
    const mine = ++seq.current;
    // Refresh clears only the lock it started under, and none mid-move.
    const clearing = force && !now.current.saving ? now.current.pending : undefined;
    setLoading(true);
    setError(undefined);
    try {
      const [b, wf] = await Promise.all([apiRef.current.loadBoard(), now.current.workflow ?? apiRef.current.loadWorkflow()]);
      if (!live.current || mine !== seq.current || draggingNow.current) return;
      setBoard(b);
      setWorkflow(wf);
      setPending((p) => (p && (p === clearing || moveSettled(b.columns, p)) ? undefined : p));
    } catch (e) {
      if (live.current && mine === seq.current) setError(e);
    } finally {
      if (live.current && mine === seq.current) setLoading(false);
    }
  };
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    live.current = true;
    return () => void (live.current = false);
  }, []);
  useEffect(() => {
    if (connected) void loadRef.current();
  }, [connected]);
  // The dispatcher moves cards too: read again, but never under a drag, a move or an open prompt.
  useEffect(() => {
    if (!connected) return;
    const every = setInterval(() => {
      const n = now.current;
      if (!n.loading && !n.saving && !n.prompt && !draggingNow.current) void loadRef.current();
    }, pollMs);
    return () => clearInterval(every);
  }, [connected, pollMs]);

  const tasks = board?.columns.flatMap((c) => c.tasks) ?? [];
  const open = openId ? tasks.find((t) => t.id === openId) : undefined;
  // Archived or deleted elsewhere: its sheet closes.
  useEffect(() => {
    if (openId && board && !open) setOpenId(undefined);
  }, [openId, board, open]);

  const allowed = (t: BoardTask, to: string) => !!workflow && canMove(workflow, t.status, to);

  const move = async (task: BoardTask, to: string, note = "") => {
    setSaving(true);
    now.current.saving = true;
    setMoveErr(undefined);
    // Reads started before this move can't update the board or clear its lock.
    seq.current++;
    setPending({ id: task.id, from: task.status });
    try {
      setMoveErr(await apiRef.current.moveTask(task.id, to, note));
      setAsk(undefined);
    } catch (e) {
      const said = `Couldn't move ${task.id} to ${to}: ${errorText(e)}`;
      if (refused(e)) {
        setPending(undefined);
        setMoveErr(said);
      } else {
        setMoveErr(`${said}. Refresh to see whether it went through.`);
        setAsk(undefined);
      }
    }
    await loadRef.current();
    if (!live.current) return;
    setSaving(false);
  };
  const requestMove = (task: BoardTask, to: string) => {
    setMoveErr(undefined);
    const need = moveNeeds(task.status, to);
    if (need) setAsk({ task, to, need });
    else void move(task, to);
  };

  const create = async (d: Draft) => {
    setDraft({ ...d, creating: true, error: undefined });
    try {
      setNotice((await apiRef.current.createTask(d.fields, d.key)).warning);
      if (live.current) setDraft(undefined);
    } catch (e) {
      const lost = !refused(e);
      if (live.current)
        setDraft({
          ...d,
          creating: false,
          unanswered: d.unanswered || lost,
          error: lost ? `${errorText(e)}. It may have been created: Create again sends the same task, and won't add a second one.` : errorText(e),
        });
    }
    await loadRef.current();
  };

  const endDrag = () => {
    draggingNow.current = undefined;
    setDragging(undefined);
    setOver(undefined);
  };
  const drop = (e: DragEvent, to: string) => {
    e.preventDefault();
    const t = draggingNow.current;
    endDrag();
    if (t && allowed(t, to)) requestMove(t, to);
  };

  const missing = error instanceof NoKanbanPlugin;
  const total = tasks.length;

  return (
    <div className="settings work-screen">
      <div className="work-inner">
        <button className="back" onClick={onClose}>
          <ArrowLeft size={15} /> Back to chat
        </button>
        <header className="work-head">
          <h1 className="project-title">
            <SquareKanban size={20} /> <span>Work</span>
          </h1>
          {board && <span className="muted">{plural(total, "task")} on the current board</span>}
          <span className="work-spacer" />
          <button className="btn primary" disabled={!connected || !board} onClick={() => setDraft({ fields: blank(), key: crypto.randomUUID(), creating: false, unanswered: false })}>
            <Plus size={14} /> New task
          </button>
          <button className="btn" disabled={!connected || loading} onClick={() => void load(true)}>
            <RefreshCw size={14} /> Refresh
          </button>
        </header>
        {!connected && (
          <p className="job-banner" role="status">
            <CircleAlert size={14} /> Not connected to Hermes. Bots keep working on the server; reconnect to see or change the board.
            {board && " What's below is as it was last read."}
          </p>
        )}
        {missing ? (
          <p className="job-banner" role="note">
            <CircleAlert size={14} /> {errorText(error)}
          </p>
        ) : (
          error !== undefined && (
            <div className="job-error" role="alert">
              <p>{errorText(error)}</p>
              {connected && (
                <button className="btn" onClick={() => void load(true)}>
                  Try again
                </button>
              )}
            </div>
          )
        )}
        {moveErr && !ask && (
          <div className="job-error" role="alert">
            <p>{moveErr}</p>
          </div>
        )}
        {notice && (
          <p className="job-banner" role="status">
            <TriangleAlert size={14} /> {notice}
          </p>
        )}
        {loading && !board && !error && (
          <div className="empty-hint" role="status">
            <Spinner /> Loading the board…
          </div>
        )}
        {board && (
          <div className="work-board">
            {board.columns.map((col) => (
              <section
                key={col.name}
                className={`work-column${over === col.name ? " over" : ""}${dragging && dragging.status !== col.name && !allowed(dragging, col.name) ? " nodrop" : ""}`}
                aria-label={col.name}
                onDragOver={(e) => {
                  const t = draggingNow.current;
                  if (t && allowed(t, col.name)) {
                    e.preventDefault();
                    setOver(col.name);
                  }
                }}
                onDragLeave={(e) => {
                  if (over === col.name && !e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(undefined);
                }}
                onDrop={(e) => drop(e, col.name)}
              >
                <h2 className="work-column-head">
                  <span>{col.name}</span>
                  <span className="work-count">{col.tasks.length}</span>
                </h2>
                {col.tasks.map((t) => (
                  <div
                    key={t.id}
                    className={`work-card${dragging?.id === t.id ? " dragging" : ""}`}
                    role="button"
                    tabIndex={0}
                    title={t.body || t.title}
                    draggable={!!workflow && !locked}
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/plain", t.id);
                      draggingNow.current = t;
                      setDragging(t);
                    }}
                    onDragEnd={endDrag}
                    onClick={() => setOpenId(t.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setOpenId(t.id);
                      }
                    }}
                  >
                    <div className="work-meta">
                      <code>{t.id}</code>
                      {t.priority !== 0 && <span>P{t.priority}</span>}
                      {t.tenant && <span>{t.tenant}</span>}
                    </div>
                    <b className="work-title">{t.title}</b>
                    {t.status === "blocked" && t.summary ? (
                      <p className="work-why">
                        <TriangleAlert size={13} /> {t.summary}
                      </p>
                    ) : (
                      t.body && <p className="work-body">{t.body}</p>
                    )}
                    {t.assignee && (
                      <small className="work-assignee">
                        <User size={13} /> {t.assignee}
                      </small>
                    )}
                  </div>
                ))}
                {!col.tasks.length && <p className="work-empty">Empty</p>}
              </section>
            ))}
          </div>
        )}
      </div>

      {open && workflow && (
        <TaskSheet
          task={open}
          workflow={workflow}
          api={api}
          busy={locked}
          err={ask ? undefined : moveErr || (error !== undefined ? errorText(error) : undefined)}
          assignees={board?.assignees ?? []}
          onRefresh={() => void load(true)}
          onSaved={() => void load()}
          onMove={(to) => requestMove(open, to)}
          onClose={() => setOpenId(undefined)}
        />
      )}
      {ask && <MovePrompt ask={ask} busy={locked} error={moveErr} onSubmit={(text) => void move(ask.task, ask.to, text)} onClose={() => setAsk(undefined)} />}
      {draft && (
        <NewTask
          draft={draft}
          assignees={board?.assignees ?? []}
          onChange={(fields) => setDraft({ ...draft, fields })}
          onSubmit={() => void create(draft)}
          onClose={() => !draft.creating && setDraft(undefined)}
        />
      )}
    </div>
  );
}

/** A dialog over the board: Tab stays inside, and Escape closes it. */
function Dialog({ wide, onClose, children }: { wide?: boolean; onClose: () => void; children: (titleId: string) => ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const keys = useModal(box);
  const titleId = useId();
  return (
    <div className="leave-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={box}
        className={`leave-dialog work-dialog${wide ? " wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(e) => {
          keys(e);
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      >
        {children(titleId)}
      </div>
    </div>
  );
}

function MovePrompt({ ask, busy, error, onSubmit, onClose }: { ask: Ask; busy: boolean; error?: string; onSubmit: (text: string) => void; onClose: () => void }) {
  const [text, setText] = useState("");
  const verb = ask.need === "summary" ? "Complete" : "Block";
  return (
    <Dialog onClose={onClose}>
      {(titleId) => (
        <form
          className="work-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim() && !busy) onSubmit(text);
          }}
        >
          <h2 id={titleId} className="leave-title">
            {verb} {ask.task.title}
          </h2>
          <input
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={ask.need === "summary" ? "What got done?" : "Why is it blocked?"}
            aria-label={ask.need === "summary" ? "Summary" : "Reason"}
          />
          {error && <p className="work-err">{error}</p>}
          <div className="confirm-actions">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" disabled={busy || !text.trim()}>
              {verb}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

/** A task's editable fields, for New task and the task sheet's Edit. `disabled` locks them while they save. */
function FieldsForm({ fields, people, disabled, onChange }: { fields: TaskFields; people: string[]; disabled: boolean; onChange: (f: TaskFields) => void }) {
  return (
    <fieldset className="work-fields" disabled={disabled}>
      <label>
        Title
        <input autoFocus value={fields.title} onChange={(e) => onChange({ ...fields, title: e.target.value })} />
      </label>
      <label>
        Description
        <textarea rows={5} value={fields.body} onChange={(e) => onChange({ ...fields, body: e.target.value })} />
      </label>
      <div className="work-fields-row">
        <label>
          Priority
          <input
            type="number"
            step={1}
            value={Number.isNaN(fields.priority) ? "" : fields.priority}
            onChange={(e) => onChange({ ...fields, priority: e.target.value === "" ? NaN : Number(e.target.value) })}
          />
        </label>
        <label>
          Assignee
          <select value={fields.assignee} onChange={(e) => onChange({ ...fields, assignee: e.target.value })}>
            <option value="">Unassigned</option>
            {people.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
      </div>
    </fieldset>
  );
}

function NewTask({ draft, assignees, onChange, onSubmit, onClose }: { draft: Draft; assignees: string[]; onChange: (f: TaskFields) => void; onSubmit: () => void; onClose: () => void }) {
  return (
    <Dialog wide onClose={onClose}>
      {(titleId) => (
        <form
          className="work-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (validFields(draft.fields) && !draft.creating) onSubmit();
          }}
        >
          <h2 id={titleId} className="leave-title">
            New task
          </h2>
          <FieldsForm fields={draft.fields} people={assignees} disabled={draft.creating || draft.unanswered} onChange={onChange} />
          {draft.error && <p className="work-err">{draft.error}</p>}
          <div className="confirm-actions">
            <button type="button" className="btn" disabled={draft.creating} onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" disabled={draft.creating || !validFields(draft.fields)}>
              Create
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

/** Only the app's own comments count: it posts as `dashboard`, so an agent writing the same words doesn't confirm one. */
const ours = (cs: TaskComment[], body: string) => cs.filter((c) => c.author === "dashboard" && c.body === body).length;

/**
 * One task: its full text and comments, read from Hermes, with Edit, Comment and the moves its workflow allows. The
 * board's own copy of the task decides its status; the sheet's read decides the rest while the board hasn't changed it.
 */
function TaskSheet({
  task,
  workflow,
  api,
  busy,
  err,
  assignees,
  onRefresh,
  onSaved,
  onMove,
  onClose,
}: {
  task: BoardTask;
  workflow: Workflow;
  api: WorkApi;
  busy: boolean;
  /** Why the last move or board read failed. */
  err?: string;
  assignees: string[];
  onRefresh: () => void;
  onSaved: () => void;
  onMove: (to: string) => void;
  onClose: () => void;
}) {
  // The board's values for the task, by value: every board read hands over a new object. A read of the task taken
  // under other values is stale, and the board's copy shows until the next read lands.
  const seen = JSON.stringify([task.title, task.body, task.priority, task.assignee, task.summary]);
  const [read, setRead] = useState<{ task: BoardTask; seen: string }>();
  const [comments, setComments] = useState<TaskComment[]>();
  const [readErr, setReadErr] = useState<string>();
  const [rev, setRev] = useState(0);
  const gen = useRef(0);
  const [form, setForm] = useState<TaskFields>();
  const base = useRef<BoardTask>(undefined);
  const [note, setNote] = useState("");
  const [working, setWorking] = useState(false);
  const [writeErr, setWriteErr] = useState<string>();
  // A comment that got no answer may have been saved, and comments have no idempotency key: its box stays locked until
  // a read shows one more of ours with its text, or the owner picks Post again or Discard.
  const [unsure, setUnsure] = useState<{ body: string; had: number }>();
  const unsureNow = useRef(unsure);
  unsureNow.current = unsure;
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => void (live.current = false);
  }, []);

  useEffect(() => {
    const mine = ++gen.current;
    api.loadTask(task.id).then(
      (d) => {
        if (!live.current || mine !== gen.current) return;
        setRead({ task: d.task, seen });
        setComments(d.comments);
        setReadErr(undefined);
        const u = unsureNow.current;
        if (u && ours(d.comments, u.body) > u.had) {
          setUnsure(undefined);
          setNote("");
          setWriteErr(undefined);
        }
      },
      (e) => live.current && mine === gen.current && setReadErr(errorText(e)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read again when the task, the board's values for it, its comment count or `rev` change; `api` is the same Hermes throughout
  }, [task.id, seen, task.comments, rev]);

  const current = read && read.seen === seen ? read.task : task;
  const targets = workflow.columns.filter((c) => canMove(workflow, task.status, c.key));
  const can = (to: string) => targets.some((c) => c.key === to);
  const changes = form && base.current ? taskEdits(base.current, form) : {};
  const canSave = !!form && validFields(form) && Object.keys(changes).length > 0;
  const people = current.assignee && !assignees.includes(current.assignee) ? [current.assignee, ...assignees] : assignees;

  const write = async (send: () => Promise<unknown>, done: () => void, maybeSaved?: (why: string) => void) => {
    setWorking(true);
    setWriteErr(undefined);
    try {
      await send();
      if (!live.current) return;
      done();
      onSaved();
    } catch (e) {
      if (!live.current) return;
      if (refused(e) || !maybeSaved) setWriteErr(errorText(e));
      else maybeSaved(errorText(e));
      if (!refused(e)) setRev((r) => r + 1);
    } finally {
      if (live.current) setWorking(false);
    }
  };
  // The PATCH answers with the task as saved: show that, and drop reads from before it. Its summary is the run's, so
  // keep the one read.
  const save = () =>
    write(
      async () => {
        const saved = await api.editTask(task.id, changes);
        gen.current++;
        if (saved && live.current) setRead({ task: { ...saved, summary: current.summary }, seen });
      },
      () => setForm(undefined),
    );
  const comment = () => {
    const body = note.trim();
    const had = ours(comments ?? [], body);
    setUnsure(undefined);
    void write(
      () => api.addComment(task.id, body),
      () => {
        setNote("");
        setRev((r) => r + 1);
      },
      (why) => {
        setUnsure({ body, had });
        setWriteErr(`${why}. It may have been saved: check the comments, then Post again or Discard.`);
      },
    );
  };

  return (
    <Dialog wide onClose={onClose}>
      {(titleId) => (
        <div className="work-sheet">
          <header className="work-sheet-head">
            <h2 id={titleId} className="leave-title">
              {current.title}
            </h2>
            <span className="work-sheet-tools">
              {!form && (
                <button
                  className="icon-btn"
                  title="Edit"
                  aria-label="Edit"
                  onClick={() => {
                    setWriteErr(undefined);
                    base.current = current;
                    setForm({ title: current.title, body: current.body, priority: current.priority, assignee: current.assignee });
                  }}
                >
                  <Pencil size={15} />
                </button>
              )}
              <button
                className="icon-btn"
                title="Refresh"
                aria-label="Refresh"
                onClick={() => {
                  setRev((r) => r + 1);
                  onRefresh();
                }}
              >
                <RefreshCw size={15} />
              </button>
              <button className="icon-btn" title="Close" aria-label="Close" onClick={onClose}>
                <X size={15} />
              </button>
            </span>
          </header>
          <div className="work-sheet-body">
            {form ? (
              <form
                id="work-edit-task"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (canSave && !working) void save();
                }}
              >
                <FieldsForm fields={form} people={people} disabled={working} onChange={setForm} />
              </form>
            ) : (
              <>
                <div className="work-meta">
                  <code>{task.id}</code>
                  <span className="work-status">{task.status}</span>
                  {current.priority !== 0 && <span>P{current.priority}</span>}
                  {current.assignee && (
                    <span>
                      <User size={13} /> {current.assignee}
                    </span>
                  )}
                  {current.tenant && <span>{current.tenant}</span>}
                </div>
                {current.body && <p className="work-text">{current.body}</p>}
                {current.summary && (
                  <>
                    <h3 className="work-sub">Latest summary</h3>
                    <p className="work-text">{current.summary}</p>
                  </>
                )}
              </>
            )}
            <h3 className="work-sub">Comments</h3>
            {comments?.map((c) => (
              <div key={c.id} className="work-comment">
                <small>
                  <b>{c.author}</b> · {c.at ? new Date(c.at).toLocaleString() : ""}
                </small>
                <p className="work-text">{c.body}</p>
              </div>
            ))}
            {!comments?.length && (comments || !readErr) && <p className="muted">{comments ? "No comments yet" : "Loading…"}</p>}
            {readErr && <p className="work-err">Couldn't load the task: {readErr}</p>}
            <form
              className="work-add"
              onSubmit={(e) => {
                e.preventDefault();
                if (note.trim() && comments && !working) comment();
              }}
            >
              <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} disabled={working || !!unsure} placeholder="Add a comment" aria-label="Comment" />
              {unsure ? (
                <>
                  <button
                    type="button"
                    className="btn"
                    disabled={working}
                    onClick={() => {
                      setNote("");
                      setWriteErr(undefined);
                      setUnsure(undefined);
                    }}
                  >
                    Discard
                  </button>
                  <button className="btn" disabled={working || !comments}>
                    Post again
                  </button>
                </>
              ) : (
                <button className="btn" disabled={working || !comments || !note.trim()}>
                  Comment
                </button>
              )}
            </form>
          </div>
          {(writeErr || err) && <p className="work-err">{writeErr || err}</p>}
          <footer className="work-sheet-foot">
            {form ? (
              <>
                <span className="work-spacer" />
                <button
                  className="btn"
                  disabled={working}
                  onClick={() => {
                    setForm(undefined);
                    setWriteErr(undefined);
                  }}
                >
                  Cancel
                </button>
                <button className="btn primary" form="work-edit-task" disabled={working || !canSave}>
                  Save
                </button>
              </>
            ) : (
              <>
                <select
                  aria-label="Move to"
                  disabled={busy || !targets.length}
                  value=""
                  onChange={(e) => {
                    const to = e.target.value;
                    if (to) onMove(to);
                  }}
                >
                  <option value="">Move to…</option>
                  {targets.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.label}
                    </option>
                  ))}
                </select>
                <span className="work-spacer" />
                {task.status === "blocked" && can("ready") && (
                  <button className="btn" disabled={busy} onClick={() => onMove("ready")}>
                    Unblock
                  </button>
                )}
                {can("blocked") && (
                  <button className="btn" disabled={busy} onClick={() => onMove("blocked")}>
                    Block…
                  </button>
                )}
                {can("done") && (
                  <button className="btn primary" disabled={busy} onClick={() => onMove("done")}>
                    Complete
                  </button>
                )}
              </>
            )}
          </footer>
        </div>
      )}
    </Dialog>
  );
}
