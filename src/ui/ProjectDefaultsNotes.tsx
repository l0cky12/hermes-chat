// What a project's defaults (ADR 0017) mean on the chat pane: in the New chat pane, what the next chat starts with and
// where each value comes from; in a started chat, Apply to this chat, which asks first and changes only what Hermes
// can change in a chat that has started.
import { useState } from "react";
import { EFFORT_LABEL, shortName, type ModelPick } from "../hermes/models";
import type { NewChatSettings, Origin, ProjectDefaults } from "../hermes/projectDefaults";
import { composing, useReturnFocus } from "./bits";
import { errorText } from "../hermes/values";

function originLabel(from: Origin, project?: string) {
  if (from === "chat") return "chosen for this chat";
  if (from === "project") return `project default${project ? ` (${project})` : ""}`;
  if (from === "pick") return "your model pick";
  return "profile default";
}

const modelText = (m?: ModelPick) => (m ? `${shortName(m.model)} (${m.provider})` : "The profile's model");

/**
 * What the next chat in this pane starts with. `where`: the connection, shown beside a folder's path. `problem`: why it
 * can't start on these, if it can't.
 */
export function NewChatSettingsView({
  settings,
  where,
  profile,
  problem,
  worktree,
}: {
  settings: NewChatSettings;
  where?: string;
  profile: string;
  problem?: string;
  /** The worktree the chat starts in (ADR 0043), and how to start it elsewhere instead. */
  worktree?: { branch: string; path: string; onDrop: () => void };
}) {
  const { model, effort, instructions, folder, project } = settings;
  const row = (label: string, value: React.ReactNode, from: Origin) => (
    <div className="start-row">
      <dt>{label}</dt>
      <dd>
        <span className="start-value">{value}</span> <span className="start-from">{originLabel(from, project)}</span>
      </dd>
    </div>
  );
  return (
    <section className="start-settings" aria-label="What this chat starts with">
      <h2>This chat starts with</h2>
      <dl>
        {row("Model", modelText(model.value), model.from)}
        {row("Reasoning", effort.value ? EFFORT_LABEL[effort.value] : "As the model has it", effort.from)}
        {row(
          "Folder",
          folder.value ? (
            <>
              <span className="mono">{folder.value}</span> on <span className="mono">{where ?? "no connection"}</span>
            </>
          ) : (
            <>Hermes's default folder for the {profile} profile</>
          ),
          folder.from,
        )}
        {worktree && (
          <div className="start-row">
            <dt>Worktree</dt>
            <dd>
              <span className="start-value">
                <span className="mono">{worktree.branch}</span>, a worktree made in the Repository screen
              </span>{" "}
              <button type="button" className="btn small" onClick={worktree.onDrop}>
                Don't start it there
              </button>
            </dd>
          </div>
        )}
        {row(
          "Instructions",
          instructions.value ? <span title={instructions.value}>{firstLine(instructions.value)}</span> : "None from Hermes Chat",
          instructions.from,
        )}
      </dl>
      {problem && (
        <p className="field-hint err" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}

const firstLine = (t: string) => {
  const line = t.split("\n").find((l) => l.trim())?.trim() ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
};

/**
 * Asks before applying the project's defaults to a started chat, saying what changes. The model and the folder can
 * change; the instructions a chat started with can't be replaced, so they are left as they are.
 */
export function ApplyDefaults({
  project,
  defaults,
  current,
  where,
  running,
  onApply,
  onClose,
}: {
  project: string;
  defaults: ProjectDefaults;
  current?: ModelPick;
  where?: string;
  running: boolean;
  onApply: (what: { model?: ModelPick; folder?: string }) => Promise<void>;
  onClose: (applied?: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // Closing it, however, puts focus back on the button that opened it.
  useReturnFocus();
  const d = defaults.model;
  const already = !!d && current?.provider === d.provider && current.model === d.model && (!d.effort || current.effort === d.effort);
  const model = d && !already ? d : undefined;
  const folder = defaults.folder;
  const changes = !!model || !!folder;

  const apply = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await onApply({ model, folder });
      onClose(`Applied ${project}'s defaults to this chat.`);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <section
      className="confirm apply-defaults"
      role="dialog"
      aria-label={`Apply ${project}'s defaults to this chat`}
      onKeyDown={(e) => e.key === "Escape" && !composing(e) && onClose()}
    >
      <span className="confirm-msg">Apply {project}'s defaults to this chat?</span>
      <ul>
        {defaults.model && (
          <li>
            Model:{" "}
            {model ? (
              <>
                {modelText(current)}
                {current?.effort ? `, ${EFFORT_LABEL[current.effort]}` : ""} → {modelText(model)}
                {model.effort ? `, ${EFFORT_LABEL[model.effort]}` : ""}. Hermes switches it from the next reply.
              </>
            ) : (
              <>already {modelText(current)}.</>
            )}
          </li>
        )}
        {folder && (
          <li>
            Folder: moves its work to <span className="mono">{folder}</span> on <span className="mono">{where ?? "no connection"}</span>. Hermes
            changes it only between replies, and only to a folder that's there.
          </li>
        )}
        {defaults.instructions && (
          <li>
            Instructions: not changed. Hermes can't replace or take back the instructions a chat started with. Start a new chat in this
            project to use these.
          </li>
        )}
        {!defaults.model && !folder && !defaults.instructions && <li>The project has no defaults; this chat uses the profile's.</li>}
      </ul>
      {running && folder && <span className="field-hint">A reply is running. Wait for it to finish to change the folder.</span>}
      {error && (
        <span className="field-hint err" role="alert">
          {error}
        </span>
      )}
      <div className="confirm-actions">
        <button className="btn" autoFocus onClick={() => onClose()}>
          {changes ? "Cancel" : "Close"}
        </button>
        {changes && (
          <button className="btn primary" disabled={busy || (running && !!folder)} onClick={() => void apply()}>
            {busy ? "Applying…" : "Apply to this chat"}
          </button>
        )}
      </div>
    </section>
  );
}
