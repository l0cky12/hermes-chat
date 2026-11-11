// Settings → General → Import transcripts (ADR 0031): pick a format and a file, see what is in it and where it goes,
// then import it in one write Hermes makes all or nothing. Nothing is sent before Import is pressed, and Cancel or
// Escape before then leaves Hermes as it was.
import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { CircleAlert, FileInput } from "lucide-react";
import type { Project } from "../hermes/projects";
import {
  IMPORT_FORMATS,
  ImportFileError,
  importLedger,
  pickTranscript,
  planImport,
  type ImportFormat,
  type ImportLedger,
  type ImportOutcome,
  type ImportPlan,
  type ImportRecord,
  type PickedTranscript,
  type PlannedChat,
} from "../hermes/importTranscripts";
import { fmtSize } from "./bits";
import { useModal } from "./modal";
import { SettingRow, SettingsSection } from "./SettingRows";
import { plural } from "../hermes/values";

/** What the import needs from the app: Hermes, the profile shown, and where its chats can go. */
export type ImportWiring = {
  imports: {
    send(profile: string, chats: PlannedChat[]): Promise<ImportOutcome>;
    onServer(profile: string, ids: string[]): Promise<Map<string, string | null>>;
  };
  profile: string;
  /** Where this computer keeps the profile's imports (projectLinks.ts `projectScope`). */
  scope: string;
  projects: Project[];
  /** The project the chat list shows; imported chats go in it unless the owner picks otherwise. */
  shownProject?: string;
  /** Called once Hermes has the chats, for the profile they went to, and the project picked for them. */
  onImported(profile: string, chats: PlannedChat[], projectId: string | undefined): void;
  onOpen(chatId: string): void;
  pick?: (format: ImportFormat) => Promise<PickedTranscript | null>;
  ledger?: ImportLedger;
};

const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

export function ImportSection({ wiring, connected }: { wiring: ImportWiring; connected: boolean }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <SettingsSection title="Import transcripts">
      <SettingRow
        name="Import a chat export"
        hint={
          <>
            Hermes Chat Markdown exports, and Hermes session exports (JSONL), into the <span className="mono">{wiring.profile}</span> profile.
          </>
        }
        more="Imported chats are read-only here: they keep their words, not everything the original chat had."
        control={
          <button ref={button} className="btn" disabled={!connected} onClick={() => setOpen(true)}>
            <FileInput size={14} /> Import…
          </button>
        }
      />
      {open && <ImportDialog wiring={wiring} connected={connected} returnTo={button} onClose={() => setOpen(false)} />}
    </SettingsSection>
  );
}

type Step =
  | { at: "choose"; error?: string }
  | { at: "reading" }
  | { at: "preview"; plan: ImportPlan; path: string; profile: string; scope: string; before?: ImportRecord; onServer?: Map<string, string | null>; checkError?: string }
  | { at: "sending"; plan: ImportPlan; profile: string }
  | { at: "done"; plan: ImportPlan; profile: string; outcome: ImportOutcome; path: string; scope: string; projectId?: string }
  | { at: "refused"; plan: ImportPlan; message: string };

export function ImportDialog({
  wiring,
  connected,
  returnTo,
  onClose,
}: {
  wiring: ImportWiring;
  connected: boolean;
  returnTo?: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const { pick = pickTranscript, imports } = wiring;
  const ledger = useRef(wiring.ledger ?? importLedger()).current;
  const [format, setFormat] = useState<ImportFormat>("markdown");
  const [step, setStep] = useState<Step>({ at: "choose" });
  const [projectId, setProjectId] = useState<string | undefined>(wiring.shownProject);
  const box = useRef<HTMLDivElement>(null);
  const keys = useModal(box, returnTo);
  const titleId = useId();
  const live = useRef(true);
  // Set again on every mount: StrictMode mounts, unmounts and mounts again in development.
  useEffect(() => {
    live.current = true;
    return () => void (live.current = false);
  }, []);
  const sending = step.at === "sending";

  // A preview is for the profile it was made in. Switching profile drops it, so nothing goes to the wrong one.
  useEffect(() => {
    if (step.at === "preview" && step.profile !== wiring.profile) {
      setStep({ at: "choose", error: `The profile changed to ${wiring.profile}, so nothing was imported. Choose the file again to import it here.` });
      // The project picked was the other profile's.
      setProjectId(wiring.shownProject);
    }
  }, [wiring.profile, wiring.shownProject, step]);

  const choose = async () => {
    setStep({ at: "reading" });
    const { profile, scope } = wiring;
    try {
      const file = await pick(format);
      if (!live.current) return;
      if (!file) return setStep({ at: "choose" });
      const plan = await planImport(format, file.name, file.text);
      if (!live.current) return;
      const before = ledger.get(scope, plan.digest);
      setStep({ at: "preview", plan, path: file.path, profile, scope, before });
      imports.onServer(profile, plan.chats.map((c) => c.id)).then(
        (onServer) => live.current && setStep((s) => (s.at === "preview" && s.plan === plan ? { ...s, onServer } : s)),
        (e) => live.current && setStep((s) => (s.at === "preview" && s.plan === plan ? { ...s, checkError: (e as Error).message } : s)),
      );
    } catch (e) {
      if (!live.current) return;
      const why = e instanceof ImportFileError ? e.message : `Couldn't read the file: ${(e as Error).message}`;
      setStep({ at: "choose", error: `Nothing was imported. ${why}` });
    }
  };

  const send = async (plan: ImportPlan, profile: string, scope: string, path: string) => {
    setStep({ at: "sending", plan, profile });
    const earlier = ledger.get(scope, plan.digest);
    const record: ImportRecord = { fileName: plan.fileName, format: plan.format, at: Date.now(), state: "started", ids: plan.chats.map((c) => c.id) };
    ledger.put(scope, plan.digest, record);
    try {
      const outcome = await imports.send(profile, plan.chats);
      if (!outcome.interrupted) ledger.put(scope, plan.digest, { ...record, state: "done" });
      // Only chats this import made and read back: a skipped one is Hermes's own, with its own source and title.
      const made = new Set(outcome.imported);
      wiring.onImported(profile, plan.chats.filter((c) => made.has(c.id)), projectId);
      if (live.current) setStep({ at: "done", plan, profile, outcome, path, scope, projectId });
    } catch (e) {
      // Refused: Hermes wrote nothing, so nothing is remembered as imported either.
      ledger.put(scope, plan.digest, earlier ?? { ...record, state: "done", ids: [] });
      if (live.current) setStep({ at: "refused", plan, message: (e as Error).message });
    }
  };

  const close = () => !sending && onClose();

  return (
    <div className="leave-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={box}
        className="leave-dialog import-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={sending || step.at === "reading"}
        onKeyDown={(e) => {
          keys(e);
          if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
      >
        <h2 id={titleId} className="leave-title">
          <FileInput size={14} aria-hidden /> Import transcripts
        </h2>

        {(step.at === "choose" || step.at === "reading") && (
          <>
            <fieldset className="import-formats">
              <legend>Format</legend>
              {(Object.keys(IMPORT_FORMATS) as ImportFormat[]).map((f) => (
                <label key={f}>
                  <input type="radio" name="import-format" checked={format === f} disabled={step.at === "reading"} onChange={() => setFormat(f)} />
                  <span>
                    <b>{IMPORT_FORMATS[f].label}</b>
                    <span className="muted small">{IMPORT_FORMATS[f].hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            {step.at === "choose" && step.error && (
              <p role="alert" className="files-transfer-error">
                <CircleAlert size={13} aria-hidden /> {step.error}
              </p>
            )}
            <p className="muted small">The whole file is read and checked before anything is sent to Hermes. Files it names are never opened.</p>
            <div className="confirm-actions">
              <button className="btn" onClick={close}>
                Cancel
              </button>
              <button className="btn primary" autoFocus disabled={!connected || step.at === "reading"} onClick={() => void choose()}>
                {step.at === "reading" ? "Reading…" : "Choose file…"}
              </button>
            </div>
          </>
        )}

        {step.at === "preview" && (
          <Preview
            step={step}
            projects={wiring.projects}
            projectId={projectId}
            onProject={setProjectId}
            connected={connected}
            onBack={() => setStep({ at: "choose" })}
            onCancel={close}
            onImport={(fresh) => void send({ ...step.plan, chats: fresh }, step.profile, step.scope, step.path)}
          />
        )}

        {step.at === "sending" && (
          <p role="status">
            Importing {plural(step.plan.chats.length, "chat")} into <span className="mono">{step.profile}</span>… Hermes writes all of them or none.
          </p>
        )}

        {step.at === "done" && (
          <Summary
            step={step}
            projects={wiring.projects}
            onOpen={(id) => {
              onClose();
              wiring.onOpen(id);
            }}
            onRetry={() => void send(step.plan, step.profile, step.scope, step.path)}
            onClose={close}
            connected={connected && step.profile === wiring.profile}
            canOpen={step.profile === wiring.profile}
          />
        )}

        {step.at === "refused" && (
          <>
            <p role="alert" className="files-transfer-error">
              <CircleAlert size={13} aria-hidden /> {step.message}
            </p>
            <div className="confirm-actions">
              <button className="btn" autoFocus onClick={() => setStep({ at: "choose" })}>
                Back
              </button>
              <button className="btn" onClick={close}>
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Preview({
  step,
  projects,
  projectId,
  onProject,
  connected,
  onBack,
  onCancel,
  onImport,
}: {
  step: Extract<Step, { at: "preview" }>;
  projects: Project[];
  projectId?: string;
  onProject: (id: string | undefined) => void;
  connected: boolean;
  onBack: () => void;
  onCancel: () => void;
  onImport: (fresh: PlannedChat[]) => void;
}) {
  const { plan, before, onServer, checkError } = step;
  const there = plan.chats.filter((c) => onServer?.get(c.id) != null);
  const fresh = onServer ? plan.chats.filter((c) => onServer.get(c.id) == null) : plan.chats;
  const messages = plan.chats.reduce((n, c) => n + c.messages, 0);
  const attachments = plan.chats.reduce((n, c) => n + c.attachments, 0);
  const tools = plan.chats.reduce((n, c) => n + c.toolCalls, 0);
  const projectsShown = projects.filter((p) => !p.archived);
  const projectFieldId = useId();
  return (
    <>
      <dl className="files-meta">
        <dt>File</dt>
        <dd>
          <span className="mono">{step.path || plan.fileName}</span>, {fmtSize(plan.bytes)}
        </dd>
        <dt>Format</dt>
        <dd>{IMPORT_FORMATS[plan.format].label}</dd>
        <dt>In it</dt>
        <dd>
          {plural(plan.chats.length, "chat")}, {plural(messages, "message")}, {plural(tools, "tool call")}, {plural(attachments, "attachment")}
        </dd>
        <dt>Goes to</dt>
        <dd>
          the <span className="mono">{step.profile}</span> profile, Settled
        </dd>
        <dt>
          <label htmlFor={projectFieldId}>Project</label>
        </dt>
        <dd>
          <select id={projectFieldId} value={projectId ?? ""} onChange={(e) => onProject(e.target.value || undefined)}>
            <option value="">No project</option>
            {projectsShown.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </dd>
      </dl>

      {(before || there.length > 0) && (
        <div className="import-duplicate" role="alert">
          <CircleAlert size={13} aria-hidden />{" "}
          <span>
            {before?.state === "started"
              ? `An import of this file started ${day(before.at)} and its outcome wasn't known. `
              : before && before.ids.length
                ? `You imported this file ${day(before.at)}. `
                : ""}
            {onServer
              ? there.length === plan.chats.length
                ? `Hermes already has ${plan.chats.length === 1 ? "this chat" : `all ${plan.chats.length} chats`}, so there's nothing new to import.`
                : there.length
                  ? `Hermes already has ${plural(there.length, "chat")} of these; ${there.length === 1 ? "it's" : "they're"} skipped, not copied.`
                  : "Hermes doesn't have any of its chats now, so all of them come in."
              : checkError
                ? "Hermes skips any of these it already has."
                : "Checking what Hermes already has…"}
          </span>
        </div>
      )}
      {checkError && <p className="muted small">Couldn't check what Hermes already has ({checkError}). Hermes skips any chat it has when importing.</p>}

      <ul className="import-chats" aria-label="Chats in the file">
        {plan.chats.slice(0, 50).map((c) => {
          const had = onServer?.get(c.id);
          return (
            <li key={c.id}>
              <span className="import-chat-title">{c.title}</span>
              <span className="muted small">
                {plural(c.messages, "message")}
                {c.startedAt !== undefined && plan.format === "jsonl" && `, ${day(c.startedAt * 1000)}`}
                {c.model && `, ${c.model}`}
                {c.from && `, from ${c.from}`}
              </span>
              {had != null && <span className="badge">{had === "import" ? "Already imported" : "Already in Hermes"}</span>}
            </li>
          );
        })}
        {plan.chats.length > 50 && <li className="muted small">and {plural(plan.chats.length - 50, "more chat")}</li>}
      </ul>

      <div className="import-warnings">
        <b>What changes on the way in</b>
        <ul>
          {plan.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
          <li>Imported chats are read-only in Hermes Chat. To carry on with one, start a new chat.</li>
        </ul>
      </div>

      <div className="confirm-actions">
        <button className="btn" onClick={onBack}>
          Back
        </button>
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn primary" autoFocus disabled={!connected || (!onServer && !checkError) || !fresh.length} onClick={() => onImport(fresh)}>
          {!onServer && !checkError ? "Checking…" : fresh.length ? `Import ${plural(fresh.length, "chat")}` : "Nothing new to import"}
        </button>
      </div>
    </>
  );
}

function Summary({
  step,
  projects,
  onOpen,
  onRetry,
  onClose,
  connected,
  canOpen,
}: {
  step: Extract<Step, { at: "done" }>;
  projects: Project[];
  onOpen: (id: string) => void;
  onRetry: () => void;
  onClose: () => void;
  connected: boolean;
  /** The list shows the profile the chats went to; after a switch they can't be opened from here. */
  canOpen: boolean;
}) {
  const { outcome, plan } = step;
  const title = new Map(plan.chats.map((c) => [c.id, c.title]));
  const project = projects.find((p) => p.id === step.projectId);
  return (
    <>
      <p role="status">
        {outcome.interrupted
          ? "The import may not have finished."
          : outcome.imported.length
            ? `Imported ${plural(outcome.imported.length, "chat")} into ${step.profile}${project ? `, in ${project.name}` : ""}.`
            : "Nothing new was imported."}
        {outcome.skipped.length > 0 && ` Hermes already had ${plural(outcome.skipped.length, "chat")}, so ${outcome.skipped.length === 1 ? "it was" : "they were"} skipped.`}
      </p>
      {outcome.interrupted && (
        <p role="alert" className="files-transfer-error">
          <CircleAlert size={13} aria-hidden /> {outcome.interrupted}
        </p>
      )}
      {outcome.unconfirmed.length > 0 && (
        <p role="alert" className="files-transfer-error">
          <CircleAlert size={13} aria-hidden /> Hermes said it imported {plural(outcome.unconfirmed.length, "chat")}, but reading back didn't find{" "}
          {outcome.unconfirmed.length === 1 ? "it" : "them"}: {outcome.unconfirmed.map((id) => title.get(id) ?? id).join(", ")}.
        </p>
      )}
      {outcome.imported.length > 0 && (
        <ul className="import-chats" aria-label="Imported chats">
          {outcome.imported.slice(0, 50).map((id) => (
            <li key={id}>
              <span className="import-chat-title">{title.get(id) ?? id}</span>
              {canOpen && (
                <button className="btn small" onClick={() => onOpen(id)}>
                  Open
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="confirm-actions">
        {outcome.interrupted && (
          <button className="btn" disabled={!connected} onClick={onRetry}>
            Try again
          </button>
        )}
        <button className="btn primary" autoFocus onClick={onClose}>
          Done
        </button>
      </div>
    </>
  );
}
