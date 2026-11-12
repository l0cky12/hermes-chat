// Clone profile (ADR 0074), opened from the profile switcher: a new Hermes profile made from another one. It shows what
// each category would do before anything is written, makes the profile through Hermes, reads it back, and only then
// offers to open it. API keys go only when the owner turns on the full copy, which says so first.
import { useEffect, useId, useRef, useState, type ReactElement, type RefObject } from "react";
import { Check, CircleAlert, Minus, TriangleAlert } from "lucide-react";
import {
  CATEGORIES,
  CATEGORY_LABELS,
  preview,
  type FailedSkill,
  type Outcome,
  type Part,
  type Plan,
  type ProfileCloneApi,
  type Result,
  type Source,
  type Stage,
  type StageState,
} from "../hermes/profileClone";
import { nameProblem, type ProfileRow } from "../hermes/profiles";
import { Spinner, composing } from "./bits";
import { useModal } from "./modal";
import { errorText } from "../hermes/values";

const PARTS: Part[] = ["persona", "model", "description", "skills"];
const STAGES: Stage[] = ["name", "create", "skills", "check"];
type Stages = Record<Stage, { state: StageState; note?: string }>;
const fresh = (): Stages => ({ name: { state: "pending" }, create: { state: "pending" }, skills: { state: "pending" }, check: { state: "pending" } });

/** The first free `<source>-copy`, `<source>-copy-2`, … Hermes's ids are at most 64 characters. */
function suggestName(source: string, profiles: readonly ProfileRow[]): string {
  const base = `${source}-copy`.slice(0, 57);
  for (let i = 1; ; i++) {
    const name = i === 1 ? base : `${base}-${i}`;
    if (!nameProblem(name, profiles)) return name;
  }
}

const listProblem = (e: unknown) => `Couldn't list profiles: ${errorText(e)}`;

const STATE_ICON: Record<Result["state"], ReactElement> = {
  copied: <Check size={13} aria-label="Copied" className="clone-ok" />,
  failed: <CircleAlert size={13} aria-label="Didn't copy" className="clone-bad" />,
  unchecked: <TriangleAlert size={13} aria-label="Copied, not read back" className="clone-warn" />,
  left: <Minus size={13} aria-label="Not copied" className="clone-left" />,
};

/**
 * The dialog. `current`: the profile in use, the first source offered. `onOpen`: switch the app to the new profile.
 * Focus goes back to `returnTo` when it closes.
 */
export function CloneProfileDialog({
  api,
  current,
  returnTo,
  onOpen,
  onMade,
  onClose,
}: {
  api: ProfileCloneApi;
  current: string;
  returnTo?: RefObject<HTMLElement | null>;
  onOpen: (name: string) => void;
  /** Called with the new profile's name once Hermes has it (Settings → Profiles selects it). */
  onMade?: (name: string) => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const keys = useModal(box, returnTo);
  const titleId = useId();
  const nameId = useId();
  const noteId = useId();

  const [profiles, setProfiles] = useState<ProfileRow[]>();
  const [listError, setListError] = useState<string>();
  const [sourceName, setSourceName] = useState(current);
  const [source, setSource] = useState<Source>();
  const [sourceError, setSourceError] = useState<string>();
  const [name, setName] = useState("");
  const [named, setNamed] = useState(false);
  const [full, setFull] = useState(false);
  const [parts, setParts] = useState<ReadonlySet<Part>>(new Set(PARTS));
  const [stages, setStages] = useState<Stages>(fresh);
  const [running, setRunning] = useState(false);
  const [plan, setPlan] = useState<Plan>();
  const [outcome, setOutcome] = useState<Outcome>();
  const [askDelete, setAskDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();
  const [deleted, setDeleted] = useState(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => void (live.current = false);
  }, []);

  // The list and the source are read together, and again when another source is picked or the list is asked for
  // again (`readAgain`); an answer for a read since replaced is dropped.
  const [reads, setReads] = useState(0);
  const readAgain = () => setReads((n) => n + 1);
  useEffect(() => {
    let current = true;
    setListError(undefined);
    setSource(undefined);
    setSourceError(undefined);
    const list = api.profiles();
    list.then(
      (rows) => current && setProfiles(rows),
      (e: unknown) => current && setListError(listProblem(e)),
    );
    api.source(sourceName, list).then(
      (s) => current && setSource(s),
      (e: unknown) => current && setSourceError(`Couldn't read ${sourceName}: ${errorText(e)}`),
    );
    return () => void (current = false);
  }, [api, sourceName, reads]);
  useEffect(() => {
    if (profiles && !named) setName(suggestName(sourceName, profiles));
  }, [profiles, sourceName, named]);

  const onStage = (stage: Stage, state: StageState, note?: string) => live.current && setStages((s) => ({ ...s, [stage]: { state, note } }));
  const run = async (work: () => Promise<Outcome>) => {
    setRunning(true);
    setOutcome(undefined);
    setDeleteError(undefined);
    let out: Outcome;
    try {
      out = await work();
    } catch (e) {
      out = { kind: "unsure", problem: errorText(e) };
    }
    if (!live.current) return;
    setRunning(false);
    setOutcome(out);
    if (out.kind === "made") onMade?.(out.name);
    // A name taken meanwhile shows against the list as it is now. The source read at open still stands.
    if (out.kind === "refused")
      api.profiles().then(
        (rows) => live.current && setProfiles(rows),
        (e: unknown) => live.current && setListError(listProblem(e)),
      );
  };
  const start = () => {
    if (running || !source || problem) return;
    const p: Plan = full ? { kind: "full", source: sourceName, name } : { kind: "fresh", source: sourceName, name, parts };
    setPlan(p);
    setStages(fresh());
    void run(() => api.clone(p, source, onStage));
  };
  const checkAgain = () => plan && source && void run(() => api.settle(plan, source, onStage));
  const retrySkills = (failed: FailedSkill[], answered: boolean) => plan && source && void run(() => api.retrySkills(plan, source, failed, answered, onStage));
  const remove = async (target: string) => {
    setRunning(true);
    setDeleteError(undefined);
    try {
      await api.remove(target);
      if (live.current) setDeleted(true);
    } catch (e) {
      if (live.current) setDeleteError(errorText(e));
    }
    if (!live.current) return;
    setRunning(false);
    setAskDelete(false);
  };

  const problem = profiles ? nameProblem(name, profiles) : undefined;
  const plans = source && preview(full ? { kind: "full" } : { kind: "fresh", parts }, source);
  const made = outcome?.kind === "made" ? outcome : undefined;
  const form = !plan || outcome?.kind === "refused";
  const close = () => !running && onClose();
  const toggle = (p: Part) => setParts((s) => (s.has(p) ? new Set([...s].filter((x) => x !== p)) : new Set([...s, p])));

  return (
    <div className="leave-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={box}
        className="leave-dialog clone-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={noteId}
        onKeyDown={(e) => {
          keys(e);
          if (e.key === "Escape" && !composing(e)) {
            e.preventDefault();
            close();
          }
        }}
      >
        <h2 id={titleId} className="leave-title">
          Clone a profile
        </h2>
        <p id={noteId} className="muted">
          Makes a new profile on the server from another one. Hermes builds it whole or not at all, and never replaces a profile that exists.
        </p>

        {form && (
          <>
            <div className="clone-fields">
              <label>
                <span>From</span>
                <select value={sourceName} disabled={!profiles || running} onChange={(e) => setSourceName(e.target.value)}>
                  {(profiles ?? [{ name: current }]).map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.name}
                      {p.name === current ? " (in use)" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label htmlFor={nameId}>
                <span>New profile's name</span>
                <input
                  id={nameId}
                  autoFocus
                  spellCheck={false}
                  value={name}
                  disabled={running}
                  aria-invalid={!!(name && problem)}
                  aria-describedby={problem ? `${nameId}-problem` : undefined}
                  onChange={(e) => {
                    setNamed(true);
                    setName(e.target.value);
                  }}
                  onKeyDown={(e) => e.key === "Enter" && !composing(e) && start()}
                />
              </label>
            </div>
            {profiles && name && problem && (
              <p id={`${nameId}-problem`} className="clone-problem" role="alert">
                {problem}
              </p>
            )}
            {listError && (
              <p className="clone-problem" role="alert">
                {listError}{" "}
                <button className="link-btn" onClick={readAgain}>
                  Try again
                </button>
              </p>
            )}
            {sourceError && !listError && (
              <p className="clone-problem" role="alert">
                {sourceError}
              </p>
            )}
            {!source && !sourceError && !listError && (
              <p className="muted clone-loading">
                <Spinner /> Reading {sourceName}…
              </p>
            )}
            {plans && (
              <table className="clone-table" aria-label="What the clone copies">
                <thead>
                  <tr>
                    <th scope="col">Copy</th>
                    <th scope="col">What</th>
                    <th scope="col">From {sourceName}</th>
                  </tr>
                </thead>
                <tbody>
                  {CATEGORIES.map((c) => {
                    const pickable = !full && (PARTS as string[]).includes(c);
                    const plan = plans[c];
                    return (
                      <tr key={c} className={plan.copied ? "" : "clone-off"}>
                        <td>
                          {pickable ? (
                            <input
                              type="checkbox"
                              aria-label={`Copy ${CATEGORY_LABELS[c]}`}
                              checked={plan.copied}
                              disabled={running || !plan.available}
                              onChange={() => toggle(c as Part)}
                            />
                          ) : plan.copied ? (
                            <Check size={13} aria-label="Copied" className="clone-ok" />
                          ) : (
                            <Minus size={13} aria-label="Not copied" className="clone-left" />
                          )}
                        </td>
                        <td>{CATEGORY_LABELS[c]}</td>
                        <td>{plan.note}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            <label className="clone-full">
              <input type="checkbox" checked={full} disabled={running} onChange={(e) => setFull(e.target.checked)} />
              <span>Also copy API keys, memory and every setting (Hermes's full copy)</span>
            </label>
            {full && (
              <p className="clone-warning" role="note">
                <TriangleAlert size={13} aria-hidden /> The new profile gets the same API keys as {sourceName}, in its own .env on the server. Anyone or anything that
                can use the new profile can spend on those accounts, and revoking a key later means changing it in both profiles.
              </p>
            )}
            {outcome?.kind === "refused" && (
              <p className="clone-problem" role="alert">
                {outcome.problem} Nothing was created; you can try again.
              </p>
            )}
          </>
        )}

        {plan && !form && (
          <ol className="clone-stages" aria-label="Progress" aria-live="polite">
            {STAGES.map((s) => (
              <li key={s} className={`clone-stage ${stages[s].state}`}>
                {stages[s].state === "running" ? <Spinner /> : stages[s].state === "done" ? <Check size={13} aria-hidden /> : stages[s].state === "failed" ? <CircleAlert size={13} aria-hidden /> : <Minus size={13} aria-hidden />}
                <span>
                  {{ name: `Check ${plan.name} is free`, create: `Create ${plan.name}`, skills: "Copy its own skills", check: `Read ${plan.name} back` }[s]}
                  <span className="muted"> · {{ pending: "waiting", running: "under way", done: "done", failed: "didn't finish", skipped: "not needed" }[stages[s].state]}</span>
                  {stages[s].note && <span className="muted">. {stages[s].note}</span>}
                </span>
              </li>
            ))}
          </ol>
        )}

        {outcome?.kind === "unsure" && (
          <p className="clone-problem" role="alert">
            {outcome.problem} Check again before making it a second time.
          </p>
        )}

        {made && !deleted && (
          <>
            <table className="clone-table" aria-label={`What ${made.name} has`}>
              <tbody>
                {made.results.map((r) => (
                  <tr key={r.category} className={`clone-result ${r.state}`}>
                    <td>{STATE_ICON[r.state]}</td>
                    <td>{CATEGORY_LABELS[r.category]}</td>
                    <td>{r.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted">
              {made.results.some((r) => r.state === "failed")
                ? `${made.name} is on the server, but not everything above copied. It's not a full clone.`
                : `${made.name} is on the server and read back as listed above.`}
            </p>
          </>
        )}
        {deleted && made && <p role="status">{made.name} was deleted from the server.</p>}
        {deleteError && (
          <p className="clone-problem" role="alert">
            {deleteError}
          </p>
        )}
        {askDelete && made && (
          <div className="confirm" role="alertdialog" aria-label={`Delete ${made.name}?`}>
            <span>Delete {made.name} from the server? Its folder goes, with anything added to it since.</span>
            <div className="confirm-actions">
              <button className="btn" autoFocus disabled={running} onClick={() => setAskDelete(false)}>
                Keep it
              </button>
              <button className="btn danger" disabled={running} onClick={() => void remove(made.name)}>
                Delete {made.name}
              </button>
            </div>
          </div>
        )}

        <div className="confirm-actions">
          {form && (
            <>
              <button className="btn" onClick={close} disabled={running}>
                Cancel
              </button>
              <button className="btn primary" disabled={running || !source || !!problem} onClick={start}>
                {running ? "Cloning…" : full ? "Clone with API keys" : "Clone"}
              </button>
            </>
          )}
          {outcome?.kind === "unsure" && (
            <>
              <button className="btn" onClick={close} disabled={running}>
                Close
              </button>
              <button className="btn primary" disabled={running} onClick={checkAgain}>
                Check again
              </button>
            </>
          )}
          {made && !deleted && (
            <>
              {made.answered && !askDelete && (
                <button className="btn danger" disabled={running} onClick={() => setAskDelete(true)}>
                  Delete {made.name}
                </button>
              )}
              {made.failedSkills.length > 0 && (
                <button className="btn" disabled={running} onClick={() => retrySkills(made.failedSkills, made.answered)}>
                  Try the skills again
                </button>
              )}
              <button className="btn" onClick={close} disabled={running}>
                Close
              </button>
              <button className="btn primary" autoFocus disabled={running} onClick={() => onOpen(made.name)}>
                Open {made.name}
              </button>
            </>
          )}
          {made && deleted && (
            <button className="btn" autoFocus onClick={close}>
              Close
            </button>
          )}
          {plan && !form && !outcome && (
            <button className="btn" disabled>
              Cloning…
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
