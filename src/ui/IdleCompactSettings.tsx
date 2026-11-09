// Settings → Model → Idle compaction (idleCompact.ts, ADR 0119): whether this app has Hermes compact a chat that has sat
// idle with its context window past a mark, the mark, and how long idle means. Kept on this computer and saved as it
// is changed; nothing here is written to Hermes.
import { useState, useSyncExternalStore } from "react";
import { IDLE_COMPACT_MINUTES, IDLE_COMPACT_PERCENTS, getUIPrefs, setUIPrefs, subscribe, type IdleCompactPrefs } from "../hermes/uiPrefs";
import { SettingNote, SettingRow, SettingsSection } from "./SettingRows";

const minutes = (m: number) => (m < 60 ? `${m} minutes` : m === 60 ? "1 hour" : `${m / 60} hours`);

/** The choices offered, with the current value added where a newer app or a hand edit set another. */
const withCurrent = <T extends number>(choices: readonly T[], current: number) => (choices.includes(current as T) ? [...choices] : [...choices, current].sort((a, b) => a - b));

export function IdleCompactSettings() {
  const prefs = useSyncExternalStore(subscribe, getUIPrefs).idleCompact;
  const [unsaved, setUnsaved] = useState(false);
  const change = (patch: Partial<IdleCompactPrefs>) => setUnsaved(!setUIPrefs({ idleCompact: { ...prefs, ...patch } }));
  const on = prefs.enabled;
  return (
    <SettingsSection title="Idle compaction" intro="Kept on this computer, for every connection and profile; nothing here is written to Hermes.">
      <SettingRow
        name="Compact idle chats"
        nameId="idle-compact-label"
        hint="Hermes compacts a chat left idle with its context window past the mark below, as Compact now does."
        hintId="idle-compact-help"
        more={
          <>
            <p>
              Older messages are swapped for a summary the model reads in their place. By then the provider's prompt cache has gone cold, so your next
              message would pay for the whole context anyway. Each idle chat is compacted once, until a new reply measures it again.
            </p>
            <p>
              It runs only while Hermes Chat is open and connected. Only chats opened in this app since it connected are measured, so only they are
              compacted. Each compaction is a call to the profile's Compression model (Auxiliary models, on this page). Hermes's own compaction when
              the window fills during a reply works as before.
            </p>
          </>
        }
        control={
          <button
            className="switch"
            role="switch"
            aria-checked={on}
            aria-labelledby="idle-compact-label"
            aria-describedby="idle-compact-help"
            onClick={() => change({ enabled: !on })}
          >
            <span className="switch-knob" />
          </button>
        }
      />
      <SettingRow
        name="When the context window is at least"
        hint="As Hermes last measured it, shown in the status bar's meter."
        control={
          <select
            className="select"
            aria-label="Idle compaction context fullness"
            value={prefs.percent}
            disabled={!on}
            onChange={(e) => change({ percent: Number(e.target.value) })}
          >
            {withCurrent(IDLE_COMPACT_PERCENTS, prefs.percent).map((p) => (
              <option key={p} value={p}>
                {p}% full
              </option>
            ))}
          </select>
        }
      />
      <SettingRow
        name="And the chat has been idle for"
        hint="No reply, no message sent, nothing waiting on you."
        control={
          <select
            className="select"
            aria-label="Idle compaction idle time"
            value={prefs.idleMinutes}
            disabled={!on}
            onChange={(e) => change({ idleMinutes: Number(e.target.value) })}
          >
            {withCurrent(IDLE_COMPACT_MINUTES, prefs.idleMinutes).map((m) => (
              <option key={m} value={m}>
                {minutes(m)}
              </option>
            ))}
          </select>
        }
      />
      {unsaved && (
        <SettingNote tone="bad" role="alert">
          Couldn't save this on this computer; it applies only until Hermes Chat closes.
        </SettingNote>
      )}
    </SettingsSection>
  );
}
