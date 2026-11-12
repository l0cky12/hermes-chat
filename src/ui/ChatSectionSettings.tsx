// Which of the chat list's sections show (ADR 0063). Kept in the display preferences (uiPrefs.ts), on this computer
// only. Any mix of sections, but never none: the last one shown can't be turned off. A hidden section's chats are still
// found by Search. Drawn as a card of rows (ADR 0059).
import { useSyncExternalStore } from "react";
import { SECTION_KEYS, SECTION_LABEL, type SectionKey } from "../hermes/sectionKeys";
import { getUIPrefs, setUIPrefs, subscribe } from "../hermes/uiPrefs";
import { SettingRow, SettingsSection } from "./SettingRows";
import { useChordLabel } from "./keybindings";

const HINT: Readonly<Record<SectionKey, string>> = {
  pinned: "Chats you pinned, in the order you pinned them, whatever happens in them.",
  inbox: "Chats that need you or have finished: an Approval waiting, a failure, a reply done, something new.",
  working: "Chats with a reply running.",
  snoozed: "Chats you snoozed, until they wake.",
  archived: "Chats hidden in every Hermes client. Listing them asks Hermes for them on each refresh.",
  settled: "Chats you settled or cleared from the Inbox, in a drawer at the foot of the list.",
};

export function ChatSectionSettings() {
  const searchKey = useChordLabel("search");
  const { chatSectionsShown: shown } = useSyncExternalStore(subscribe, getUIPrefs);
  const toggle = (k: SectionKey, on: boolean) => setUIPrefs({ chatSectionsShown: on ? [...shown, k] : shown.filter((s) => s !== k) });
  return (
    <SettingsSection
      title="Chat list sections"
      intro={`The sections the chat list shows. Search (${searchKey}) still finds the chats in a hidden section.`}
    >
      {SECTION_KEYS.map((k) => {
        const on = shown.includes(k);
        const last = on && shown.length === 1;
        return (
          <SettingRow
            key={k}
            name={SECTION_LABEL[k]}
            nameId={`chat-section-${k}`}
            hint={last ? `${HINT[k]} At least one section stays on.` : HINT[k]}
            hintId={`chat-section-${k}-hint`}
            control={
              <button
                type="button"
                className="switch"
                role="switch"
                aria-checked={on}
                aria-disabled={last || undefined}
                aria-labelledby={`chat-section-${k}`}
                aria-describedby={`chat-section-${k}-hint`}
                onClick={() => !last && toggle(k, !on)}
              >
                <span className="switch-knob" />
              </button>
            }
          />
        );
      })}
    </SettingsSection>
  );
}
