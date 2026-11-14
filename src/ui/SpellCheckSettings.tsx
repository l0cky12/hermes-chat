// Whether the boxes a message to Hermes is written in check spelling (#578). Kept in the display preferences
// (uiPrefs.ts), on this computer only.
import { useSyncExternalStore } from "react";
import { getUIPrefs, setUIPrefs, subscribe } from "../hermes/uiPrefs";
import { SettingRow, SettingsSection } from "./SettingRows";

/** The `spellCheck` for a box a message to Hermes is written in: the composer, a queued message, a steer, a replay. */
export const useSpellCheck = (): boolean => useSyncExternalStore(subscribe, () => getUIPrefs().spellCheck);

export function SpellCheckSettings() {
  const on = useSpellCheck();
  return (
    <SettingsSection title="Writing messages">
      <SettingRow
        name="Check spelling"
        nameId="spell-check-label"
        hint="Underline misspelled words as you write a message. Right-click one for corrections."
        more={
          <p>
            Uses this computer's own dictionaries, in its language, or English when it has none for that language. On Linux, install a hunspell
            dictionary (such as <span className="mono">hunspell-en_us</span>) if no words are ever underlined. Fields for code, addresses, paths,
            branches and model names are never checked.
          </p>
        }
        control={
          <button className="switch" role="switch" aria-checked={on} aria-labelledby="spell-check-label" onClick={() => setUIPrefs({ spellCheck: !on })}>
            <span className="switch-knob" />
          </button>
        }
      />
    </SettingsSection>
  );
}
