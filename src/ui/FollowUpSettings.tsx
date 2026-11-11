// What sending does while a chat's reply runs (ADR 0057). Kept in the display preferences (uiPrefs.ts), on this
// computer only. Drawn as a card of rows (ADR 0059).
import { useSyncExternalStore } from "react";
import { getUIPrefs, setUIPrefs, subscribe, type FollowUp } from "../hermes/uiPrefs";
import { SettingRow, SettingsSection } from "./SettingRows";
import { useChordLabel } from "./keybindings";

const CHOICES: { value: FollowUp; label: string }[] = [
  { value: "queue", label: "Queue" },
  { value: "steer", label: "Steer" },
];

export function FollowUpSettings() {
  const { followUp } = useSyncExternalStore(subscribe, getUIPrefs);
  const sendKey = useChordLabel("send");
  const otherKey = useChordLabel("sendOther");
  return (
    <SettingsSection title="Sending while Hermes replies">
      <SettingRow
        name="Follow-up behavior"
        nameId="follow-up-label"
        hint={`What ${sendKey} does with a message you send while a reply is running. ${otherKey} does the other one.`}
        more={
          <p>
            <b>Queue</b> waits for the reply to end and sends it as the next message. <b>Steer</b> adds it to the running reply after its next tool
            call, as <span className="mono">/steer</span> does, without stopping it. {otherKey} does the other one for that message. A message with
            files, or one sent to a Hermes without <span className="mono">/steer</span>, is queued. With no reply running, {sendKey} sends as usual.
          </p>
        }
        control={
          <div className="segmented" role="group" aria-labelledby="follow-up-label">
            {CHOICES.map((c) => (
              <button key={c.value} type="button" aria-pressed={followUp === c.value} onClick={() => setUIPrefs({ followUp: c.value })}>
                {c.label}
              </button>
            ))}
          </div>
        }
      />
    </SettingsSection>
  );
}
