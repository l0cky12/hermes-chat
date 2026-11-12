// Settings → General → Backup (backup.ts, ADR 0038). Export shows what a backup holds, what personal data is in it
// and what never is, then saves it where the owner picks. Restore reads a backup whole and checks it, shows what it
// holds and where each part goes, lets the owner choose merge or replace for each category, and writes only on
// Restore, after a recovery backup. The report says what was restored, skipped or failed; once anything was written,
// the app reloads so every store reads what was restored. Nothing restored is ever sent.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Archive, ArchiveRestore, CircleAlert, ShieldCheck } from "lucide-react";
import {
  BackupError,
  CATEGORIES,
  CATEGORY_IDS,
  LEFT_OUT,
  applyRestore,
  backupFileName,
  defaultMapping,
  loadCurrent,
  makeBackup,
  planRestore,
  readBackup,
  restoreWrote,
  summarize,
  tauriBackup,
  type Backup,
  type BackupEnv,
  type CategoryId,
  type CategoryPlan,
  type Conn,
  type Target,
  type Current,
  type Entry,
  type ExportSummary,
  type Mapping,
  type PickedBackup,
  type Place,
  type Policy,
  type RestoreReport,
} from "../hermes/backup";
import { useModal } from "./modal";
import { SettingRow, SettingsSection } from "./SettingRows";
import { errorText, formatBytes, plural } from "../hermes/values";

/** What Backup needs from the app. */
export type BackupWiring = {
  env: BackupEnv;
  /** This computer's connection: where restored data goes. */
  connection: Target;
  /** The server's profiles, to map a backup's onto. */
  profiles: () => Promise<string[]>;
  /** The profile shown, offered when the server's list can't be read. */
  profile: string;
  /** Why a restore can't run now (a reply running, an Approval waiting, a message being sent), if it can't. */
  busy?: () => string | undefined;
  /** Starts the app again on what was restored. */
  reload: () => void;
  archive?: {
    save(entries: Entry[], fileName: string): Promise<string | null>;
    pick(): Promise<PickedBackup | null>;
    saveRecovery(entries: Entry[]): Promise<string>;
  };
};

const placeLabel = (p: Conn) => `${p.mode === "ssh" ? `ssh ${p.target}` : p.target} as ${p.username}`;

export function BackupSection({ wiring }: { wiring: BackupWiring }) {
  const [open, setOpen] = useState<"export" | "restore">();
  const exportButton = useRef<HTMLButtonElement>(null);
  const restoreButton = useRef<HTMLButtonElement>(null);
  return (
    <SettingsSection title="Backup">
      <SettingRow
        name="Back up this computer's data"
        hint="Drafts, queued messages, templates, tags and settings, in one zip file."
        more="Keep your drafts, queued messages, templates, tags, project membership and settings when you reinstall or move to another computer. The zip file is saved where you choose. A backup holds only what Hermes Chat keeps on this computer: your chats and the rest stay on your Hermes server, and no password is ever in it."
        control={
          <>
            <button ref={exportButton} className="btn" onClick={() => setOpen("export")}>
              <Archive size={14} /> Export backup…
            </button>
            <button ref={restoreButton} className="btn" onClick={() => setOpen("restore")}>
              <ArchiveRestore size={14} /> Restore…
            </button>
          </>
        }
      />
      {open === "export" && <ExportDialog wiring={wiring} returnTo={exportButton} onClose={() => setOpen(undefined)} />}
      {open === "restore" && <RestoreDialog wiring={wiring} returnTo={restoreButton} onClose={() => setOpen(undefined)} />}
    </SettingsSection>
  );
}

/** A modal dialog shell, as Import transcripts has: Tab stays inside, Escape closes unless `busy`. */
function Dialog({ title, icon, busy, view, returnTo, onClose, children }: { title: string; icon: React.ReactNode; busy?: boolean; view: string; returnTo?: RefObject<HTMLElement | null>; onClose: () => void; children: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const keys = useModal(box, returnTo);
  // Each step starts at its top, though its default button, at the bottom, has focus.
  useLayoutEffect(() => void box.current?.scrollTo?.(0, 0), [view]);
  const titleId = useId();
  const close = () => !busy && onClose();
  return (
    <div className="leave-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={box}
        className="leave-dialog import-dialog backup-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy}
        onKeyDown={(e) => {
          keys(e);
          if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
      >
        <h2 id={titleId} className="leave-title">
          {icon} {title}
        </h2>
        {children}
      </div>
    </div>
  );
}

function useLive() {
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => void (live.current = false);
  }, []);
  return live;
}

function LeftOut() {
  return (
    <div className="import-warnings">
      <b>
        <ShieldCheck size={13} aria-hidden /> Never in a backup
      </b>
      <ul>
        {LEFT_OUT.map((w) => (
          <li key={w}>{w}</li>
        ))}
      </ul>
    </div>
  );
}

type ExportStep = { at: "reading" } | { at: "unreadable"; error: string } | { at: "choose"; summary: ExportSummary; error?: string } | { at: "saving"; summary: ExportSummary } | { at: "saved"; path: string };

export function ExportDialog({ wiring, returnTo, onClose }: { wiring: BackupWiring; returnTo?: RefObject<HTMLElement | null>; onClose: () => void }) {
  const archive = wiring.archive ?? tauriBackup;
  const [step, setStep] = useState<ExportStep>({ at: "reading" });
  const [chosen, setChosen] = useState<Set<CategoryId>>(new Set(CATEGORY_IDS));
  const live = useLive();
  useEffect(() => {
    summarize(wiring.env).then(
      (summary) => live.current && setStep({ at: "choose", summary }),
      (e) => live.current && setStep({ at: "unreadable", error: `Couldn't read what this computer keeps: ${errorText(e)}` }),
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps -- summarize once when the dialog opens; a new `wiring` from the parent must not reset the step the owner is on
  }, []);

  const save = async (summary: ExportSummary) => {
    setStep({ at: "saving", summary });
    try {
      const entries = await makeBackup(wiring.env, CATEGORY_IDS.filter((id) => chosen.has(id)));
      const path = await archive.save(entries, backupFileName());
      if (!live.current) return;
      setStep(path ? { at: "saved", path } : { at: "choose", summary });
    } catch (e) {
      if (live.current) setStep({ at: "choose", summary, error: `Nothing was saved. ${errorText(e)}` });
    }
  };

  return (
    <Dialog title="Export backup" icon={<Archive size={14} aria-hidden />} busy={step.at === "saving"} view={step.at} returnTo={returnTo} onClose={onClose}>
      {step.at === "reading" && <p role="status">Reading what this computer keeps…</p>}
      {step.at === "unreadable" && (
        <>
          <p role="alert" className="files-transfer-error">
            <CircleAlert size={13} aria-hidden /> {step.error}
          </p>
          <div className="confirm-actions">
            <button className="btn primary" autoFocus onClick={onClose}>
              Close
            </button>
          </div>
        </>
      )}
      {(step.at === "choose" || step.at === "saving") && (
        <>
          <p>
            Hermes Chat keeps these on this computer. Hermes keeps your chats, projects, memory and the rest on the server, where a backup doesn't reach:
            they're there whichever computer you sign in from.
          </p>
          <fieldset className="backup-categories" disabled={step.at === "saving"}>
            <legend>In the backup</legend>
            {CATEGORY_IDS.map((id) => (
              <label key={id}>
                <input
                  type="checkbox"
                  checked={chosen.has(id)}
                  onChange={(e) => setChosen((s) => new Set(e.target.checked ? [...s, id] : [...s].filter((x) => x !== id)))}
                />
                <span>
                  <span>
                    <b>{CATEGORIES[id].label}</b> <span className="muted small">({step.summary.counts[id]})</span>
                  </span>
                  <span className="muted small">{CATEGORIES[id].holds}.</span>
                </span>
              </label>
            ))}
          </fieldset>
          <div className="import-duplicate" role="note">
            <CircleAlert size={13} aria-hidden />
            <span>
              It holds personal and chat data: the text of your drafts, queued messages and templates, project instructions, tag and project names, chat
              ids, and short excerpts of the messages branches came from. It also names each connection and profile it is for
              {step.summary.places.length ? ": " : "."}
              {step.summary.places.map((p, i) => (
                <span key={i}>
                  {i > 0 && "; "}
                  <span className="mono">{placeLabel(p)}</span>, <span className="mono">{p.profile}</span>
                </span>
              ))}
              {step.summary.places.length ? "." : ""} Keep the file somewhere private.
            </span>
          </div>
          {step.summary.queueFilesLeftOut > 0 && (
            <p className="muted small">
              {plural(step.summary.queueFilesLeftOut, "file")} attached to queued messages {step.summary.queueFilesLeftOut === 1 ? "isn't" : "aren't"} included: only
              their text is.
            </p>
          )}
          <LeftOut />
          {step.at === "choose" && step.error && (
            <p role="alert" className="files-transfer-error">
              <CircleAlert size={13} aria-hidden /> {step.error}
            </p>
          )}
          <div className="confirm-actions">
            <button className="btn" onClick={onClose} disabled={step.at === "saving"}>
              Cancel
            </button>
            <button className="btn primary" autoFocus disabled={step.at === "saving" || !chosen.size} onClick={() => void save(step.summary)}>
              {step.at === "saving" ? "Saving…" : "Choose where to save…"}
            </button>
          </div>
        </>
      )}
      {step.at === "saved" && (
        <>
          <p role="status">
            Saved the backup to <span className="mono">{step.path}</span>.
          </p>
          <p className="muted small">To restore it, sign in to Hermes Chat on the other computer first, then open Settings → General → Backup → Restore.</p>
          <div className="confirm-actions">
            <button className="btn primary" autoFocus onClick={onClose}>
              Done
            </button>
          </div>
        </>
      )}
    </Dialog>
  );
}

type RestoreStep =
  | { at: "choose"; error?: string }
  | { at: "reading" }
  | { at: "preview"; picked: PickedBackup; backup: Backup; current: Current; busyNow?: string }
  | { at: "applying" }
  | { at: "done"; report: RestoreReport };

export function RestoreDialog({ wiring, returnTo, onClose }: { wiring: BackupWiring; returnTo?: RefObject<HTMLElement | null>; onClose: () => void }) {
  const archive = wiring.archive ?? tauriBackup;
  const [step, setStep] = useState<RestoreStep>({ at: "choose" });
  // The server's profiles, read once; offline, only the profile shown is offered.
  const [profiles, setProfiles] = useState<string[]>([wiring.profile]);
  const listed = useRef<Promise<string[]>>(null);
  listed.current ??= wiring.profiles().then(
    (list) => (list.length ? list : [wiring.profile]),
    () => [wiring.profile],
  );
  const [mapping, setMapping] = useState<Mapping>({});
  const [policies, setPolicies] = useState<Partial<Record<CategoryId, Policy>>>({});
  const live = useLive();
  useEffect(() => void listed.current!.then((list) => live.current && setProfiles(list)), [live]);

  const choose = async () => {
    setStep({ at: "reading" });
    try {
      const picked = await archive.pick();
      if (!live.current) return;
      if (!picked) return setStep({ at: "choose" });
      const backup = await readBackup(picked.entries);
      const current = await loadCurrent(wiring.env);
      const list = await listed.current!;
      if (!live.current) return;
      setMapping(defaultMapping(backup, wiring.connection, list));
      setPolicies({});
      setStep({ at: "preview", picked, backup, current });
    } catch (e) {
      if (!live.current) return;
      setStep({ at: "choose", error: `Nothing was restored. ${e instanceof BackupError ? e.message : errorText(e)}` });
    }
  };

  const plan = useMemo(
    () => (step.at === "preview" ? planRestore(step.backup, step.current, wiring.connection, mapping, policies) : undefined),
    [step, mapping, policies, wiring.connection],
  );

  const restore = async () => {
    if (!plan) return;
    // Asked again here: a send can start while the preview is open without the dialog rendering again.
    const busy = wiring.busy?.();
    if (busy) return setStep((s) => (s.at === "preview" ? { ...s, busyNow: busy } : s));
    setStep({ at: "applying" });
    let report: RestoreReport;
    try {
      report = await applyRestore(wiring.env, plan, archive.saveRecovery);
    } catch (e) {
      report = { recoveryError: errorText(e), outcomes: [] };
    }
    if (live.current) setStep({ at: "done", report });
  };

  const wrote = step.at === "done" && restoreWrote(step.report);
  return (
    <Dialog title="Restore a backup" icon={<ArchiveRestore size={14} aria-hidden />} busy={step.at === "applying" || wrote} view={step.at} returnTo={returnTo} onClose={onClose}>
      {(step.at === "choose" || step.at === "reading") && (
        <>
          <p>
            Pick a backup Hermes Chat made. It's read and checked whole, and you see what it holds and where each part goes before anything is written.
          </p>
          {step.at === "choose" && step.error && (
            <p role="alert" className="files-transfer-error">
              <CircleAlert size={13} aria-hidden /> {step.error}
            </p>
          )}
          <div className="confirm-actions">
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" autoFocus disabled={step.at === "reading"} onClick={() => void choose()}>
              {step.at === "reading" ? "Reading…" : "Choose backup…"}
            </button>
          </div>
        </>
      )}
      {step.at === "preview" && plan && (
        <Preview
          step={step}
          plan={plan.categories}
          problem={plan.problem}
          busy={wiring.busy?.() ?? step.busyNow}
          connection={wiring.connection}
          profiles={profiles}
          mapping={mapping}
          onMap={(id, to) => setMapping((m) => ({ ...m, [id]: to }))}
          onPolicy={(id, p) => setPolicies((ps) => ({ ...ps, [id]: p }))}
          onBack={() => setStep({ at: "choose" })}
          onCancel={onClose}
          onRestore={() => void restore()}
        />
      )}
      {step.at === "applying" && <p role="status">Saving a recovery backup, then restoring… Each part is written whole or not at all.</p>}
      {step.at === "done" && <Report report={step.report} wrote={wrote} onReload={wiring.reload} onClose={onClose} />}
    </Dialog>
  );
}

const POLICY_LABEL: Record<Policy, string> = { merge: "Merge: add what's missing", replace: "Replace with the backup's", skip: "Don't restore" };

function whatHappens(p: CategoryPlan): string {
  if (p.policy === "skip") return "Not restored.";
  const parts = [
    p.add && `${p.add} added`,
    p.merged && `${p.merged} combined with this computer's`,
    p.replaced && `${p.replaced} replacing this computer's`,
    p.removed && `${p.removed} of this computer's removed`,
    p.same && `${p.same} already here`,
    p.kept && `${p.kept} conflicting, this computer's kept`,
  ].filter(Boolean);
  const skipped = p.skipped.map((s) => `${s.n} skipped: ${s.reason.toLowerCase()}`);
  const all = [...parts, ...skipped];
  return all.length ? `${all.join("; ")}.` : "Nothing to restore.";
}

function Preview({
  step,
  plan,
  problem,
  busy,
  connection,
  profiles,
  mapping,
  onMap,
  onPolicy,
  onBack,
  onCancel,
  onRestore,
}: {
  step: Extract<RestoreStep, { at: "preview" }>;
  plan: CategoryPlan[];
  problem?: string;
  busy?: string;
  connection: Target;
  profiles: string[];
  mapping: Mapping;
  onMap: (place: string, to: string | null | undefined) => void;
  onPolicy: (id: CategoryId, p: Policy) => void;
  onBack: () => void;
  onCancel: () => void;
  onRestore: () => void;
}) {
  const { picked, backup } = step;
  const places = Object.entries(backup.manifest.places) as [string, Place][];
  const changes = plan.some((p) => p.changes);
  const conflicts = plan.reduce((n, p) => n + (p.policy === "merge" ? p.kept : p.policy === "replace" ? p.replaced + p.removed : 0), 0);
  const made = backup.manifest.createdAt ? new Date(backup.manifest.createdAt) : undefined;
  return (
    <>
      <dl className="files-meta">
        <dt>File</dt>
        <dd>
          <span className="mono">{picked.path || picked.name}</span>, {formatBytes(picked.bytes)}
        </dd>
        <dt>Made</dt>
        <dd>{made && !Number.isNaN(made.getTime()) ? made.toLocaleString() : "not known"}</dd>
        <dt>Schema</dt>
        <dd>version {backup.manifest.schema}, checked: every file matches its checksum</dd>
        <dt>Goes to</dt>
        <dd>
          this computer's connection, <span className="mono">{placeLabel(connection)}</span>
        </dd>
      </dl>

      {places.length > 0 && (
        <table className="backup-table" aria-label="Where each connection and profile goes">
          <thead>
            <tr>
              <th scope="col">In the backup</th>
              <th scope="col">Restore into profile</th>
            </tr>
          </thead>
          <tbody>
            {places.map(([id, p]) => (
              <tr key={id}>
                <td>
                  <span className="mono">{placeLabel(p)}</span>, profile <span className="mono">{p.profile}</span>
                </td>
                <td>
                  <select
                    aria-label={`Restore ${placeLabel(p)}, profile ${p.profile}, into`}
                    value={mapping[id] === undefined ? "?" : mapping[id] === null ? "" : mapping[id]!}
                    onChange={(e) => onMap(id, e.target.value === "?" ? undefined : e.target.value || null)}
                  >
                    {mapping[id] === undefined && <option value="?">Choose…</option>}
                    <option value="">Don't restore</option>
                    {[...new Set([...profiles, ...(mapping[id] ? [mapping[id]!] : [])])].map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <table className="backup-table" aria-label="What is restored">
        <thead>
          <tr>
            <th scope="col">Category</th>
            <th scope="col">What happens</th>
            <th scope="col">Policy</th>
          </tr>
        </thead>
        <tbody>
          {plan.map((p) => (
            <tr key={p.id}>
              <td>
                <b>{CATEGORIES[p.id].label}</b>
                <div className="muted small">{plural(p.inBackup, "item")}</div>
              </td>
              <td className="small">{p.inBackup || p.removed ? whatHappens(p) : "None in the backup."}</td>
              <td>
                <select aria-label={`${CATEGORIES[p.id].label}: policy`} value={p.policy} onChange={(e) => onPolicy(p.id, e.target.value as Policy)}>
                  {(["merge", "replace", "skip"] as const).map((o) => (
                    <option key={o} value={o}>
                      {POLICY_LABEL[o]}
                    </option>
                  ))}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {backup.unsupported.length > 0 && (
        <p className="muted small">This version of Hermes Chat doesn't know, and skips: {backup.unsupported.join(", ")}.</p>
      )}

      {conflicts > 0 && (
        <div className="import-duplicate" role="note">
          <CircleAlert size={13} aria-hidden />
          <span>
            {plural(conflicts, "item")} on this computer {conflicts === 1 ? "differs" : "differ"} from the backup or {conflicts === 1 ? "isn't" : "aren't"} in it.
            Merge keeps this computer's; Replace takes the backup's and removes what it doesn't have, for the profiles restored.
          </span>
        </div>
      )}
      <div className="import-warnings">
        <b>Before and after</b>
        <ul>
          <li>A recovery backup of everything this computer keeps is saved first, in Hermes Chat's data folder. Nothing is written without it.</li>
          <li>Restored drafts and queued messages are never sent. Queues come back paused until you resume them.</li>
          <li>Hermes Chat reloads afterwards, and signs in again, to use what was restored.</li>
        </ul>
      </div>
      {(problem || busy) && (
        <p role="alert" className="files-transfer-error">
          <CircleAlert size={13} aria-hidden /> {problem ?? busy}
        </p>
      )}
      <div className="confirm-actions">
        <button className="btn" onClick={onBack}>
          Back
        </button>
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn primary" autoFocus disabled={!!problem || !!busy || !changes} onClick={onRestore}>
          {changes || problem ? "Restore" : "Nothing to restore"}
        </button>
      </div>
    </>
  );
}

function Report({ report, wrote, onReload, onClose }: { report: RestoreReport; wrote: boolean; onReload: () => void; onClose: () => void }) {
  const failed = report.outcomes.filter((o) => o.state === "failed");
  const broken = failed.filter((o) => o.state === "failed" && o.changed);
  const restored = report.outcomes.some((o) => o.state === "restored");
  return (
    <>
      {report.recoveryError ? (
        <p role="alert" className="files-transfer-error">
          <CircleAlert size={13} aria-hidden /> {report.recoveryError}
        </p>
      ) : (
        <p role="status">
          {failed.length ? (restored ? "Restored part of the backup." : "Nothing was restored.") : restored ? "Restored the backup." : "Nothing needed restoring."} The
          recovery backup is <span className="mono">{report.recovery}</span>.
        </p>
      )}
      {report.outcomes.length > 0 && (
        <table className="backup-table" aria-label="What was restored">
          <tbody>
            {report.outcomes.map((o) => (
              <tr key={o.id}>
                <td>
                  <b>{CATEGORIES[o.id].label}</b>
                </td>
                <td>
                  <span className={`badge ${o.state === "failed" ? "warn" : ""}`}>
                    {{ restored: "Restored", unchanged: "Unchanged", skipped: "Skipped", failed: "Failed" }[o.state]}
                  </span>
                </td>
                <td className="small">{o.state === "failed" ? o.reason : o.state === "skipped" && report.recoveryError ? "Not written." : whatHappens(o.plan)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {broken.length > 0 ? (
        <p role="alert" className="files-transfer-error">
          <CircleAlert size={13} aria-hidden /> {broken.map((o) => CATEGORIES[o.id].label).join(", ")} couldn't be put back fully after the write failed. Restore
          the recovery backup above to get {broken.length === 1 ? "it" : "them"} back as {broken.length === 1 ? "it was" : "they were"}.
        </p>
      ) : (
        failed.length > 0 && <p className="muted small">A part that failed was left exactly as it was. You can open the backup and restore it again.</p>
      )}
      <div className="confirm-actions">
        {wrote ? (
          <button className="btn primary" autoFocus onClick={onReload}>
            Reload Hermes Chat
          </button>
        ) : (
          <button className="btn primary" autoFocus onClick={onClose}>
            Done
          </button>
        )}
      </div>
    </>
  );
}
