// Settings, the Keyboard Shortcuts tab: every command of the app (keybindings.ts, ADR 0143) under its group, with the
// condition its keys work under, its chords as key chips, and a way to change it: click the chips, press the new keys,
// Save. A changed command shows Custom and a Reset; two commands on one chord show a warning naming the other. Keys
// that stay as they are (undo, the screenshot shortcut, Escape in a dialog) are listed so they can be found. Changes
// are kept in the display preferences (uiPrefs.ts), on this computer only, and apply at once.
import { type KeyboardEvent, useState, useSyncExternalStore } from "react";
import { CircleAlert, RotateCcw } from "lucide-react";
import { getUIPrefs, subscribe } from "../hermes/uiPrefs";
import { composing } from "./bits";
import { SettingNote, SettingRow, SettingsSection } from "./SettingRows";
import { onlyModifiers, shortcutLabel } from "./shortcut";
import {
  COMMANDS,
  COMMAND_IDS,
  FIXED,
  GROUPS,
  checkChord,
  chordLabel,
  chordOf,
  chordParts,
  conflicts,
  isCustom,
  parseChord,
  rebind,
  resetAll,
  resetBinding,
  useBindings,
  type Chord,
  type CommandId,
  type Group,
} from "./keybindings";

type Capture = { id: CommandId; chord?: Chord; problem?: string };

const ESCAPE = parseChord("Escape")!;

function KeyChips({ parts }: { parts: readonly string[] }) {
  return (
    <span className="key-chips">
      {parts.map((p, i) => (
        <kbd key={i}>{p}</kbd>
      ))}
    </span>
  );
}

export function KeyboardSettings() {
  const bindings = useBindings();
  const { screenshotShortcut } = useSyncExternalStore(subscribe, getUIPrefs);
  const clashes = conflicts(bindings, screenshotShortcut);
  const [capture, setCapture] = useState<Capture>();
  const anyCustom = COMMAND_IDS.some((id) => isCustom(bindings, id));

  const record = (id: CommandId) => (e: KeyboardEvent) => {
    if (composing(e)) return;
    if (e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey) return;
    e.preventDefault();
    e.stopPropagation();
    if (onlyModifiers(e)) return;
    if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) return setCapture(undefined);
    const chord = chordOf(e);
    if (chord) setCapture({ id, chord, problem: checkChord(id, chord, screenshotShortcut) });
  };

  const row = (id: CommandId) => {
    const { title, when } = COMMANDS[id];
    const chords = bindings[id];
    const custom = isCustom(bindings, id);
    const others = clashes.get(id);
    const capturing = capture?.id === id;
    const pressed = capturing ? capture.chord : undefined;
    return (
      <SettingRow
        key={id}
        name={
          <>
            {title}
            {custom && <span className="badge">Custom</span>}
          </>
        }
        about={title}
        hint={<code className="key-when">{when}</code>}
        control={
          capturing ? (
            <div className="shortcut-controls">
              <button className="btn shortcut-key recording" aria-label={`New shortcut for ${title}`} autoFocus onKeyDown={record(id)}>
                {pressed ? <KeyChips parts={chordParts(pressed)} /> : "Press the shortcut…"}
              </button>
              <button className="btn" onClick={() => setCapture({ id, chord: ESCAPE, problem: checkChord(id, ESCAPE, screenshotShortcut) })}>
                Use Esc
              </button>
              <button className="btn" disabled={!pressed || !!capture.problem} onClick={() => (rebind(id, pressed!), setCapture(undefined))}>
                Save
              </button>
              <button className="btn" onClick={() => setCapture(undefined)}>
                Cancel
              </button>
            </div>
          ) : (
            <div className="shortcut-controls">
              {others && (
                <span className="key-clash" role="img" aria-label={`Also ${others.join(" and ")}`} title={`These keys also run: ${others.join(", ")}`}>
                  <CircleAlert size={15} />
                </span>
              )}
              <button className="btn shortcut-key" aria-label={`Change ${title} (${chords.map(chordLabel).join(" or ")})`} onClick={() => setCapture({ id })}>
                {chords.map((c) => (
                  <KeyChips key={c} parts={chordParts(c)} />
                ))}
              </button>
              {custom && (
                <button className="icon-btn" aria-label={`Reset ${title}`} title="Back to the default" onClick={() => resetBinding(id)}>
                  <RotateCcw size={15} />
                </button>
              )}
            </div>
          )
        }
      >
        {capturing && capture.problem && (
          <div className="sign-in-error" role="alert">
            {capture.problem}
          </div>
        )}
      </SettingRow>
    );
  };

  const fixedRow = (title: string, when: string, keys: readonly string[][], hint?: string) => (
    <SettingRow
      key={title}
      name={
        <>
          {title}
          <span className="badge">Fixed</span>
        </>
      }
      about={title}
      hint={
        <>
          <code className="key-when">{when}</code>
          {hint && <> · {hint}</>}
        </>
      }
      control={
        <span className="shortcut-fixed">
          {keys.map((parts, i) => (
            <KeyChips key={i} parts={parts} />
          ))}
        </span>
      }
    />
  );

  const section = (group: Group) => {
    const { title } = GROUPS.find((g) => g.id === group)!;
    const ids = COMMAND_IDS.filter((id) => COMMANDS[id].group === group);
    const fixed = FIXED.filter((f) => f.group === group);
    return (
      <SettingsSection
        key={group}
        title={title}
        intro={group === "chat" ? "Click a shortcut to change it, then press the new keys and Save. Ctrl stands for Ctrl or Cmd." : undefined}
        action={
          group === "chat" && (
            <button className="btn" disabled={!anyCustom} onClick={resetAll}>
              Reset all
            </button>
          )
        }
      >
        {ids.map(row)}
        {fixed.map((f) => fixedRow(f.title, f.when, f.keys.map(chordParts)))}
        {group === "chat" &&
          fixedRow(
            "Take a screenshot for the composer",
            "Always",
            [screenshotShortcut ? shortcutLabel(screenshotShortcut).split("+") : ["Off"]],
            "Changed under Settings → General → Screenshots.",
          )}
        {group === "approvals" && (
          <SettingNote>
            No key answers an Approval or stops a reply, on purpose: Tab to the card's buttons, then Enter or Space. So nothing typed with the
            cursor outside a text field can answer one by accident.
          </SettingNote>
        )}
      </SettingsSection>
    );
  };

  return <>{GROUPS.map((g) => section(g.id))}</>;
}
