// How the agent office shows (ADR 0077, ADR 0122, ADR 0161): in one of the designs the office's Design menu offers, or
// not at all. Kept in the display preferences (uiPrefs.ts), on this computer only. Drawn as a card of rows (ADR 0059).
import { useSyncExternalStore } from "react";
import { getUIPrefs, setUIPrefs, subscribe, type OfficeQuality, type OfficeView } from "../hermes/uiPrefs";
import { SettingRow, SettingsSection } from "./SettingRows";
import { DESIGNS } from "./OfficeMenus";

const CHOICES: { value: OfficeView; label: string }[] = [...DESIGNS.map((d) => ({ value: d.value, label: d.label })), { value: "off", label: "Off" }];

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
        name="Office design"
        nameId="agent-office-label"
        hint="Every reply and subagent at work, opened from the rail in place of the chats. The office's Design menu picks the same. Off hides the rail button."
        more={
          <p>
            <b>Floor plan</b> draws four rooms, one for each kind of state: Needs you, Working, Trouble and At rest, with each chat's agents at one desk. <b>Board</b> gives each
            chat a row and each kind of state a column. <b>List</b> shows the same agents as rows. <b>3D building</b> is the low-poly office, and the list stands in on a computer
            without WebGL. Click an agent for its card. The office only shows what the Inbox and each chat's Subagents panel already know, and it never approves or starts anything.
          </p>
        }
        control={
          <select className="select" aria-labelledby="agent-office-label" value={agentOffice} onChange={(e) => setUIPrefs({ agentOffice: e.target.value as OfficeView })}>
            {CHOICES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        }
      />
      <SettingRow
        name="Office quality"
        nameId="office-quality-label"
        hint="For the 3D building only. Low draws at most 15 frames a second at a lower resolution, agents type at half the pace, and they appear in their new room instead of walking. The building has the same switch."
        control={<OfficeQualitySwitch aria-labelledby="office-quality-label" />}
      />
    </SettingsSection>
  );
}
