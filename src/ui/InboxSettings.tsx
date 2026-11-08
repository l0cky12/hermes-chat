import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getUIPrefs, setUIPrefs, subscribe } from "../hermes/uiPrefs";
import { SettingRow, SettingsSection } from "./SettingRows";

const MAX_DAYS = 365;

const parseDays = (text: string): number | null | "invalid" => {
  const t = text.trim();
  if (t === "") return null;
  if (!/^\d+$/.test(t)) return "invalid";
  const n = Number(t);
  return n === 0 ? null : n <= MAX_DAYS ? n : "invalid";
};

export function InboxSettings() {
  const { inboxAutoDismissDays: saved } = useSyncExternalStore(subscribe, getUIPrefs);
  const [draft, setDraft] = useState<string>();
  const [rejected, setRejected] = useState(false);
  const text = draft ?? (saved === null ? "" : String(saved));

  const saveOnLeave = () => {
    if (draft === undefined) return;
    const days = parseDays(draft);
    if (days === "invalid") return setRejected(true);
    setUIPrefs({ inboxAutoDismissDays: days });
    setDraft(undefined);
    setRejected(false);
  };
  const latest = useRef(saveOnLeave);
  latest.current = saveOnLeave;
  // Settings can close with the field still focused, and no blur follows an unmount.
  useEffect(() => () => latest.current(), []);

  return (
    <SettingsSection title="Rail inbox">
      <SettingRow
        name="Days of inactivity before auto-dismiss"
        nameId="inbox-auto-dismiss-label"
        hint="Finished chats leave the inbox after this many days. Empty is off."
        hintId="inbox-auto-dismiss-hint"
        more="The inbox opens from Open Inbox in the tray menu. Only Completed entries are dismissed, as if by hand. Approvals, failures and running work never are. Whole days from 1 to 365."
        control={
          <input
            className="model-num days"
            type="text"
            inputMode="numeric"
            placeholder="Off"
            value={text}
            aria-labelledby="inbox-auto-dismiss-label"
            aria-describedby={`inbox-auto-dismiss-hint${rejected ? " inbox-auto-dismiss-error" : ""}`}
            aria-invalid={rejected || undefined}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={saveOnLeave}
            onKeyDown={(e) => e.key === "Enter" && saveOnLeave()}
          />
        }
      >
        {rejected && (
          <div id="inbox-auto-dismiss-error" className="set-hint bad" role="alert">
            Not saved: enter whole days from 1 to {MAX_DAYS}, or leave it empty for Off. {saved === null ? "Still off." : `Still ${saved} ${saved === 1 ? "day" : "days"}.`}
          </div>
        )}
      </SettingRow>
    </SettingsSection>
  );
}
