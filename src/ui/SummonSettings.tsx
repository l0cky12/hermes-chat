// Settings for what `hermes-chat --show` and `--toggle` do when they bring the window forward from another app (ADR
// 0172). Kept in the display preferences (uiPrefs.ts), on this computer only.
import { useSyncExternalStore } from "react";
import { getUIPrefs, setUIPrefs, subscribe } from "../hermes/uiPrefs";
import { SettingRow, SettingsSection } from "./SettingRows";

export function SummonSettings() {
  const { summonSelection } = useSyncExternalStore(subscribe, getUIPrefs);
  return (
    <SettingsSection title="Brought forward">
      <SettingRow
        name="Start a message with the selected text"
        nameId="summon-selection-label"
        hint={
          <>
            When <code>hermes-chat --toggle</code> or <code>--show</code> brings the window forward from another app, text you selected or copied there
            is quoted in the composer. Nothing is sent until you send it.
          </>
        }
        more={
          <p>
            Only text that changed since you last left Hermes Chat is used, the selection first and then the clipboard, after anything already in the
            composer. Text a password manager marks as a password is never used. This works on Linux; on Windows the window only comes forward.
          </p>
        }
        control={
          <button
            className="switch"
            role="switch"
            aria-checked={summonSelection}
            aria-labelledby="summon-selection-label"
            onClick={() => setUIPrefs({ summonSelection: !summonSelection })}
          >
            <span className="switch-knob" />
          </button>
        }
      />
    </SettingsSection>
  );
}
