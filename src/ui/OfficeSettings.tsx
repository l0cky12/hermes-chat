// How the agent office shows (ADR 0077, ADR 0122): as a 3D building, as a list, or not at all. Kept in the display preferences
// (uiPrefs.ts), on this computer only. Drawn as a card of rows (ADR 0059).
import { useSyncExternalStore } from "react";
import { getUIPrefs, setUIPrefs, subscribe, type OfficeQuality, type OfficeView } from "../hermes/uiPrefs";
import { SettingRow, SettingsSection } from "./SettingRows";

const CHOICES: { value: OfficeView; label: string }[] = [
  { value: "building", label: "Building" },
  { value: "list", label: "List" },
  { value: "off", label: "Off" },
];

const QUALITIES: { value: OfficeQuality; label: string }[] = [
  { value: "normal", label: "Normal" },
  { value: "low", label: "Low" },
];

/** Normal or Low, in Settings and in the office's tools: Settings takes the office's place, so only the office's applies while it is seen. */
export function OfficeQualitySwitch(name: { "aria-labelledby": string } | { "aria-label": string }) {
  const { officeQuality } = useSyncExternalStore(subscribe, getUIPrefs);
  return (
    <div className="segmented office-quality" role="group" {...name}>
      {QUALITIES.map((q) => (
        <button key={q.value} type="button" aria-pressed={officeQuality === q.value} onClick={() => setUIPrefs({ officeQuality: q.value })}>
          {q.label}
        </button>
      ))}
    </div>
  );
}

export function OfficeSettings() {
  const { agentOffice } = useSyncExternalStore(subscribe, getUIPrefs);
  return (
    <SettingsSection title="Agent office">
      <SettingRow
        name="Office"
        nameId="agent-office-label"
        hint="Every reply and subagent at work, opened from the rail in place of the chats. Off hides the rail button."
        more={
          <p>
            <b>Building</b> draws a low-poly office with a room for each kind of state: the Workroom for agents at work,
            the Waiting room for those waiting for you, the Trouble room for failures and the Lounge for the rest. Each
            chat's agents wear its team color. Click an agent for its card; drag to turn, scroll to zoom. <b>List</b> shows
            the same agents as rows, and is what the office shows on a computer without WebGL. The office only shows what
            the Inbox and each chat's Subagents panel already know, and it never approves or starts anything. It draws
            nothing while nothing moves, while it is closed, or while the window is hidden or not focused.
          </p>
        }
        control={
          <div className="segmented" role="group" aria-labelledby="agent-office-label">
            {CHOICES.map((c) => (
              <button key={c.value} type="button" aria-pressed={agentOffice === c.value} onClick={() => setUIPrefs({ agentOffice: c.value })}>
                {c.label}
              </button>
            ))}
          </div>
        }
      />
      <SettingRow
        name="Office quality"
        nameId="office-quality-label"
        hint="Low draws at most 15 frames a second at a lower resolution, agents type at half the pace, and they appear in their new room instead of walking. It applies to Building, and the office has the same switch."
        control={<OfficeQualitySwitch aria-labelledby="office-quality-label" />}
      />
    </SettingsSection>
  );
}
